"""The channel SSE stream must stay authorized for its whole lifetime.

It used to be checked exactly once, in the ``Depends`` that opened it: after
that the pump forwarded every envelope on ``channel:{id}`` until the *client*
chose to disconnect. A member removed from a private channel could therefore
keep reading every subsequent message body, edit and read receipt indefinitely
from any client that ignores ``channel.removed`` — i.e. anything that is not
the browser app — and the 20s keepalive actively stopped proxies reaping it.

Two mechanisms close that, and both are pinned here:

* an immediate ``member.removed`` control event on the *channel* topic, which
  is what makes revocation instant. It fires for every channel type — the
  ``channel.event`` timeline row cannot carry this because it is suppressed
  for DMs, which is exactly where the leak matters most.
* a TTL re-check, which is the backstop for revocations that publish nothing
  on the channel topic at all (contact-grant revocation). It runs from the
  keepalive path too, so an *idle* stream on a quiet channel still closes.
"""
from __future__ import annotations

import asyncio
import threading
from typing import Any

import pytest
from sqlmodel import Session, select

from clawbits.db.models import MmChannelMember
from clawbits.fastapi import human_mm_endpoints
from clawbits.realtime import sse as sse_module
from tests.fastapi._auth_helpers import auth_headers as _auth
from tests.fastapi._auth_helpers import register_human as _register


class ScriptedBus:
    """Bus whose channel topic replays a fixed script, then goes quiet.

    Going quiet rather than ending matters: it is what lets these tests prove
    the *server* closed the stream. If the generator simply ran out, the
    response would end no matter what the authorization code did.
    """

    def __init__(self, script: list[dict[str, Any]] | None = None) -> None:
        self.script = list(script or [])
        self.published: list[tuple[str, dict[str, Any]]] = []

    async def subscribe(self, _topic: str):
        for event in self.script:
            # A callable is an action, not an envelope: it runs *while the
            # stream is open*, which is the only way to revoke someone who is
            # already connected. Revoking before connecting would just 403 at
            # the door and prove nothing about the live stream.
            if callable(event):
                event()
                continue
            yield event
        while True:                      # quiet, but still open
            await asyncio.sleep(0.01)

    async def publish(self, topic: str, event: dict[str, Any]) -> None:
        self.published.append((topic, event))

    async def presence_set(self, *_a, **_k) -> None:
        return None

    async def presence_snapshot(self, _channel_id: str):
        return []


@pytest.fixture
def fast_stream(monkeypatch):
    """Shrink the keepalive so the idle path is testable in real time."""
    monkeypatch.setattr(sse_module, "_KEEPALIVE_SECONDS", 0.05)


def _bus(monkeypatch, script=None) -> ScriptedBus:
    bus = ScriptedBus(script)
    monkeypatch.setattr("clawbits.realtime.bus._bus", bus)
    return bus


def _personal_org(tc, token: str) -> str:
    r = tc.get("/api/human/orgs", headers=_auth(token))
    return next(o["org_id"] for o in r.json()["organizations"] if o.get("is_personal"))


def _channel(tc, token: str, name: str) -> str:
    r = tc.post(
        "/api/human/mm/channels",
        json={"org_id": _personal_org(tc, token), "name": name, "channel_type": "private"},
        headers=_auth(token),
    )
    assert r.status_code == 200, r.text
    return r.json()["channel_id"]


def _stream(tc, token: str, channel_id: str = "", deadline: float = 10.0, path: str | None = None) -> str:
    """Open the stream and return its body once the *server* closes it.

    Read on a worker thread against a hard deadline. The scripted bus never
    stops yielding, so a stream the server declines to close would otherwise
    block forever — and a regression that hangs CI is far worse to diagnose
    than one that fails. Missing the deadline *is* the failure.
    """
    box: dict[str, Any] = {}

    def read() -> None:
        try:
            with tc.stream(
                "GET",
                path or f"/api/human/mm/channels/{channel_id}/events",
                headers=_auth(token),
            ) as resp:
                box["status"] = resp.status_code
                box["body"] = "".join(resp.iter_text())
        except Exception as exc:                     # surfaced on the main thread
            box["error"] = exc

    worker = threading.Thread(target=read, daemon=True)
    worker.start()
    worker.join(deadline)
    assert not worker.is_alive(), (
        f"server did not close the stream within {deadline}s — "
        "revocation was not enforced for the life of the connection"
    )
    if "error" in box:
        raise box["error"]
    assert box.get("status") == 200, box
    return box["body"]


def _post_event(message: str) -> dict[str, Any]:
    return {
        "type": "post.created",
        "channel_id": "c",
        "data": {"post_id": 1, "message": message},
    }


def _removed_event(human_id: int | None = None, agent_id: str | None = None) -> dict[str, Any]:
    return {
        "type": "member.removed",
        "channel_id": "c",
        "data": {"human_id": human_id, "agent_id": agent_id},
    }


# ---------------------------------------------------------------------------
# Immediate revocation
# ---------------------------------------------------------------------------


def test_removal_closes_the_stream(test_client, monkeypatch, fast_stream):
    """The core fix: being removed ends the response, server-side."""
    owner = _register(test_client, "sse-owner@test.com")
    ch = _channel(test_client, owner["access_token"], "private-room")
    _bus(monkeypatch, [_removed_event(human_id=owner["user"]["id"])])

    body = _stream(test_client, owner["access_token"], ch)
    # Reaching here at all is the assertion: the bus never stops yielding, so
    # only a server-side close can complete the request.
    assert "presence.snapshot" in body


def test_no_traffic_is_delivered_after_removal(test_client, monkeypatch, fast_stream):
    """The leak itself: nothing published after the removal may reach them."""
    owner = _register(test_client, "sse-leak@test.com")
    ch = _channel(test_client, owner["access_token"], "private-room")
    _bus(
        monkeypatch,
        [
            _post_event("before removal"),
            _removed_event(human_id=owner["user"]["id"]),
            _post_event("SECRET after removal"),
        ],
    )

    body = _stream(test_client, owner["access_token"], ch)
    assert "before removal" in body
    assert "SECRET after removal" not in body


def test_someone_elses_removal_does_not_close_the_stream(test_client, monkeypatch, fast_stream):
    """Only the viewer's own revocation ends their stream."""
    owner = _register(test_client, "sse-stay@test.com")
    other = _register(test_client, "sse-other@test.com")
    ch = _channel(test_client, owner["access_token"], "private-room")
    _bus(
        monkeypatch,
        [
            _removed_event(human_id=other["user"]["id"]),
            _post_event("still visible"),
            _removed_event(human_id=owner["user"]["id"]),   # terminator
        ],
    )

    body = _stream(test_client, owner["access_token"], ch)
    assert "still visible" in body, "an unrelated removal must not cut the stream"


def test_dm_removal_closes_without_any_timeline_event(test_client, monkeypatch, fast_stream):
    """The gap this closed.

    Direct channels suppress the ``channel.event`` timeline row entirely, so a
    DM stream had no immediate signal and fell back to the TTL — leaking up to
    a full window of 1:1 traffic. The control event is not suppressed.
    """
    owner = _register(test_client, "sse-dm@test.com")
    ch = _channel(test_client, owner["access_token"], "dm-like")
    bus = _bus(
        monkeypatch,
        [
            _removed_event(human_id=owner["user"]["id"]),
            _post_event("SECRET dm traffic"),
        ],
    )

    body = _stream(test_client, owner["access_token"], ch)
    assert "SECRET dm traffic" not in body
    assert not any(
        e.get("type") == "channel.event" for _t, e in bus.published
    ), "no timeline row is required for the close to happen"


# ---------------------------------------------------------------------------
# TTL backstop — revocations with no channel-topic signal
# ---------------------------------------------------------------------------


def _drop_membership(engine, channel_id: str, human_id: int) -> None:
    """Revoke in the DB only, publishing nothing — the shape of a contact-grant
    revocation, and of any path that forgets to announce itself."""
    with Session(engine) as db:
        row = db.exec(
            select(MmChannelMember)
            .where(MmChannelMember.channel_id == channel_id)
            .where(MmChannelMember.human_id == human_id)
        ).first()
        db.delete(row)
        db.commit()


def test_ttl_closes_an_idle_stream(test_client, _test_engine, monkeypatch, fast_stream):
    """No events at all: the keepalive path has to notice.

    This is the case the event filter alone could never catch — it only runs
    when traffic flows, so on a quiet channel a revoked stream would sit open
    holding its HTTP connection and Redis subscription indefinitely.
    """
    owner = _register(test_client, "sse-idle@test.com")
    ch = _channel(test_client, owner["access_token"], "quiet-room")
    monkeypatch.setattr(human_mm_endpoints, "MEMBERSHIP_RECHECK_TTL_SECONDS", 0.0)
    # No envelopes at all — just a revocation, applied once we are connected.
    _bus(monkeypatch, [lambda: _drop_membership(_test_engine, ch, owner["user"]["id"])])

    body = _stream(test_client, owner["access_token"], ch)
    assert "post.created" not in body


def test_ttl_closes_an_active_stream_with_no_removal_event(
    test_client, _test_engine, monkeypatch, fast_stream
):
    """Traffic flowing, membership gone, nothing announced on the topic."""
    owner = _register(test_client, "sse-ttl@test.com")
    ch = _channel(test_client, owner["access_token"], "busy-room")
    monkeypatch.setattr(human_mm_endpoints, "MEMBERSHIP_RECHECK_TTL_SECONDS", 0.0)
    _bus(
        monkeypatch,
        [
            _post_event("delivered while a member"),
            lambda: _drop_membership(_test_engine, ch, owner["user"]["id"]),
            _post_event("SECRET after silent revoke"),
            _post_event("SECRET after silent revoke"),
        ],
    )

    body = _stream(test_client, owner["access_token"], ch)
    assert "delivered while a member" in body
    assert "SECRET after silent revoke" not in body


def test_still_a_member_keeps_receiving(test_client, monkeypatch, fast_stream):
    """The guard must not close streams for members in good standing."""
    owner = _register(test_client, "sse-ok@test.com")
    ch = _channel(test_client, owner["access_token"], "open-room")
    monkeypatch.setattr(human_mm_endpoints, "MEMBERSHIP_RECHECK_TTL_SECONDS", 0.0)
    _bus(
        monkeypatch,
        [
            _post_event("delivered one"),
            _post_event("delivered two"),
            _removed_event(human_id=owner["user"]["id"]),   # terminator
        ],
    )

    body = _stream(test_client, owner["access_token"], ch)
    assert "delivered one" in body and "delivered two" in body


def test_reconnect_after_removal_is_forbidden(test_client, _test_engine, monkeypatch):
    """The connect-time gate still stands — a closed stream cannot be reopened."""
    owner = _register(test_client, "sse-reconnect@test.com")
    ch = _channel(test_client, owner["access_token"], "private-room")
    _bus(monkeypatch, [])
    _drop_membership(_test_engine, ch, owner["user"]["id"])

    resp = test_client.get(
        f"/api/human/mm/channels/{ch}/events", headers=_auth(owner["access_token"])
    )
    assert resp.status_code == 403, resp.text


# ---------------------------------------------------------------------------
# Credential revocation — membership intact, the credential itself is gone
# ---------------------------------------------------------------------------


def test_revoked_pat_closes_the_stream(test_client, _test_engine, monkeypatch, fast_stream):
    """Membership says nothing about the credential.

    A PAT deleted after connect used to leave the stream reading forever,
    because the TTL re-check verified only the membership row. The re-check
    now re-resolves the credential itself, so the deleted token closes the
    stream at the next tick.
    """
    owner = _register(test_client, "sse-pat@test.com")
    ch = _channel(test_client, owner["access_token"], "pat-room")
    r = test_client.post(
        "/api/human/tokens",
        headers=_auth(owner["access_token"]),
        json={"label": "sse-test"},
    )
    assert r.status_code == 200, r.text
    pat = r.json()

    def revoke_pat() -> None:
        from clawbits.db.models import HumanApiToken

        with Session(_test_engine) as db:
            db.delete(db.get(HumanApiToken, pat["token_id"]))
            db.commit()

    monkeypatch.setattr(human_mm_endpoints, "MEMBERSHIP_RECHECK_TTL_SECONDS", 0.0)
    _bus(
        monkeypatch,
        [
            _post_event("while pat valid"),
            revoke_pat,
            _post_event("SECRET after credential revoke"),
        ],
    )

    body = _stream(test_client, pat["token"], ch)
    assert "while pat valid" in body
    assert "SECRET after credential revoke" not in body


def test_invalidated_session_closes_the_stream(test_client, monkeypatch, fast_stream):
    """Same property for the sealed-session path: once the session no longer
    validates, the stream closes instead of coasting on the connect-time
    resolution. (WorkOS-side revocation becomes visible locally when the
    access token expires; the sealed blob then fails ``_validate`` exactly
    like this.)"""
    from clawbits.fastapi import workos_auth

    owner = _register(test_client, "sse-session@test.com")
    ch = _channel(test_client, owner["access_token"], "session-room")
    monkeypatch.setattr(human_mm_endpoints, "MEMBERSHIP_RECHECK_TTL_SECONDS", 0.0)
    _bus(
        monkeypatch,
        [
            _post_event("while session valid"),
            lambda: monkeypatch.setattr(
                workos_auth, "_validate", lambda _s, _c: (None, "revoked")
            ),
            _post_event("SECRET after session revoke"),
        ],
    )

    body = _stream(test_client, owner["access_token"], ch)
    assert "while session valid" in body
    assert "SECRET after session revoke" not in body


def test_rotated_agent_key_closes_the_agent_stream(
    test_client, _test_engine, monkeypatch, fast_stream, api_key
):
    """The agent SSE stream has the same lifetime rule for its API key:
    rotation replaces ``agents.api_key_hash``, so the key the stream was
    opened with stops resolving and the stream closes."""
    from sqlalchemy import text

    from tests.fastapi._auth_helpers import login_human

    agent_id = test_client.agent_id
    owner_token, _ = login_human(test_client, "stan@clawbits.ai")
    ch = _channel(test_client, owner_token, "agent-room")
    r = test_client.post(
        f"/api/human/mm/channels/{ch}/members",
        headers=_auth(owner_token),
        json={"member_id": agent_id, "member_type": "agent"},
    )
    assert r.status_code == 200, r.text

    def rotate_key() -> None:
        with _test_engine.begin() as conn:
            conn.execute(
                text("UPDATE agents SET api_key_hash = 'rotated-away' WHERE agent_id = :a"),
                {"a": agent_id},
            )

    # The agent endpoint reads the TTL from the package at request time.
    monkeypatch.setattr("clawbits.realtime.MEMBERSHIP_RECHECK_TTL_SECONDS", 0.0)
    _bus(
        monkeypatch,
        [
            _post_event("while key valid"),
            rotate_key,
            _post_event("SECRET after key rotation"),
        ],
    )

    body = _stream(
        test_client, api_key, path=f"/api/agentic/mm/channels/{ch}/events"
    )
    assert "while key valid" in body
    assert "SECRET after key rotation" not in body
