"""Backend enablers for live agent activity (LIVE_AGENT_ACTIVITY_PLAN.md).

Covers the billing shape of the streaming lane (appends + status free;
create + finalize charged; a finalize 402 leaves the draft open and
unbilled; cancel free), the activity payload on the status endpoint
(presence + ``member.status`` fan-out, server-side clamping, offline
drop, unknown-field tolerance), and the per-post streaming publish
throttle that bounds ``post.updated`` fan-out.
"""
from __future__ import annotations

import asyncio
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from clawbits.db.models import Agent
from clawbits.fastapi.clawbits_server import ClawBitsServer
from tests.fastapi.test_mattermost import _auth, _create_owned_agent, _write_headers

WRITE_COST = ClawBitsServer.AGENTIC_WRITE_CB_TOKENS_COST


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _make_channel(tc: TestClient, agent: dict) -> str:
    r = tc.post(
        "/api/agentic/mm/channels",
        json={"name": "activity-lab", "channel_type": "public"},
        headers=_write_headers(tc, agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    return r.json()["channel_id"]


def _make_streaming_post(tc: TestClient, agent: dict, channel_id: str) -> int:
    r = tc.post(
        f"/api/agentic/mm/channels/{channel_id}/posts",
        json={"status": "streaming"},
        headers=_write_headers(tc, agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "streaming"
    return r.json()["post_id"]


def _set_tokens(engine, agent_id: str, amount: int) -> None:
    with Session(engine) as db:
        agent = db.get(Agent, agent_id)
        agent.cb_tokens = amount
        db.add(agent)
        db.commit()


def _tokens(engine, agent_id: str) -> int:
    with Session(engine) as db:
        return db.get(Agent, agent_id).cb_tokens


class FakeBus:
    """Captures presence writes + published envelopes for assertions."""

    def __init__(self) -> None:
        self.published: list[tuple[str, dict[str, Any]]] = []
        self.presence: list[tuple[str, str, str, str, dict[str, Any] | None]] = []
        self.cleared: list[tuple[str, str, str]] = []

    async def publish(self, topic: str, event: dict[str, Any]) -> None:
        self.published.append((topic, event))

    async def presence_set(
        self, channel_id, member_kind, member_id, status, activity=None
    ) -> None:
        self.presence.append(
            (channel_id, member_kind, str(member_id), status, activity)
        )

    async def presence_clear(self, channel_id, member_kind, member_id) -> None:
        self.cleared.append((channel_id, member_kind, str(member_id)))

    async def presence_snapshot(self, _channel_id: str):
        return []


@pytest.fixture
def fake_bus(monkeypatch: pytest.MonkeyPatch) -> FakeBus:
    from clawbits.realtime import bus as bus_module

    fake = FakeBus()
    monkeypatch.setattr(bus_module, "_bus", fake)
    return fake


# ---------------------------------------------------------------------------
# billing: the streaming lane is free, create + finalize are charged
# ---------------------------------------------------------------------------


def test_streaming_lane_billing(test_client: TestClient, _test_engine):
    agent = _create_owned_agent(test_client)
    agent_id = agent["agent_id"]
    channel_id = _make_channel(test_client, agent)

    _set_tokens(_test_engine, agent_id, 10 * WRITE_COST)

    # Draft create is a normal billed agentic write (middleware).
    post_id = _make_streaming_post(test_client, agent, channel_id)
    assert _tokens(_test_engine, agent_id) == 9 * WRITE_COST

    # Append PATCHes are exempt: N appends cost nothing.
    for chunk in ("Hello", " world", "!"):
        r = test_client.patch(
            f"/api/agentic/mm/channels/{channel_id}/posts/{post_id}",
            json={"append": chunk},
            headers=_auth(agent["api_key"]),
        )
        assert r.status_code == 200, r.text
    assert _tokens(_test_engine, agent_id) == 9 * WRITE_COST

    # Status updates (incl. activity) are exempt.
    r = test_client.post(
        f"/api/agentic/mm/channels/{channel_id}/status",
        json={
            "status": "generating",
            "activity": {"kind": "tool", "label": "web_search: 'x'", "tool": "web_search"},
        },
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 204, r.text
    assert _tokens(_test_engine, agent_id) == 9 * WRITE_COST

    # Finalize charges once, in-handler.
    r = test_client.patch(
        f"/api/agentic/mm/channels/{channel_id}/posts/{post_id}",
        json={"done": True},
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "published"
    assert r.json()["message"] == "Hello world!"
    assert _tokens(_test_engine, agent_id) == 8 * WRITE_COST

    # Patching a published post 409s AND rolls the charge back.
    r = test_client.patch(
        f"/api/agentic/mm/channels/{channel_id}/posts/{post_id}",
        json={"done": True},
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 409, r.text
    assert _tokens(_test_engine, agent_id) == 8 * WRITE_COST

    # Cancel (silent reply) is free: only the create was charged.
    post_id2 = _make_streaming_post(test_client, agent, channel_id)
    assert _tokens(_test_engine, agent_id) == 7 * WRITE_COST
    r = test_client.patch(
        f"/api/agentic/mm/channels/{channel_id}/posts/{post_id2}",
        json={"cancel": True},
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 204, r.text
    assert _tokens(_test_engine, agent_id) == 7 * WRITE_COST


def test_finalize_402_leaves_draft_open(test_client: TestClient, _test_engine):
    agent = _create_owned_agent(test_client)
    agent_id = agent["agent_id"]
    channel_id = _make_channel(test_client, agent)

    _set_tokens(_test_engine, agent_id, 2 * WRITE_COST)
    post_id = _make_streaming_post(test_client, agent, channel_id)
    r = test_client.patch(
        f"/api/agentic/mm/channels/{channel_id}/posts/{post_id}",
        json={"append": "partial"},
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 200, r.text

    # Drain, then finalize: 402 and the draft must STAY streaming so a
    # retry after a refill can still land the reply.
    _set_tokens(_test_engine, agent_id, 0)
    r = test_client.patch(
        f"/api/agentic/mm/channels/{channel_id}/posts/{post_id}",
        json={"done": True},
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 402, r.text

    _set_tokens(_test_engine, agent_id, WRITE_COST)
    r = test_client.patch(
        f"/api/agentic/mm/channels/{channel_id}/posts/{post_id}",
        json={"done": True},
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "published"
    assert r.json()["message"] == "partial"
    assert _tokens(_test_engine, agent_id) == 0


# ---------------------------------------------------------------------------
# status endpoint: activity fan-out, clamping, offline drop
# ---------------------------------------------------------------------------


def _member_status_events(fake: FakeBus) -> list[dict[str, Any]]:
    return [e for _, e in fake.published if e.get("type") == "member.status"]


def test_status_activity_fanout(test_client: TestClient, fake_bus: FakeBus):
    agent = _create_owned_agent(test_client)
    channel_id = _make_channel(test_client, agent)
    fake_bus.published.clear()
    fake_bus.presence.clear()

    long_label = "x" * 500
    r = test_client.post(
        f"/api/agentic/mm/channels/{channel_id}/status",
        json={
            "status": "generating",
            "activity": {
                "kind": "tool",
                "label": long_label,
                "tool": "web_search",
                "some_future_field": {"ignored": True},
            },
        },
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 204, r.text

    # Presence carries the clamped activity payload.
    (_cid, kind, mid, status, activity) = fake_bus.presence[-1]
    assert (kind, mid, status) == ("agent", agent["agent_id"], "generating")
    assert activity is not None
    assert activity["kind"] == "tool"
    assert activity["tool"] == "web_search"
    assert activity["label"] == "x" * 160  # server-side clamp
    assert "some_future_field" not in activity  # extra=ignore

    # member.status event includes the same activity object.
    evt = _member_status_events(fake_bus)[-1]
    assert evt["data"]["status"] == "generating"
    assert evt["data"]["activity"]["label"] == "x" * 160

    # Plain status (no activity): payload has NO activity key (byte-stable
    # for old clients) and presence took the legacy plain-string form.
    r = test_client.post(
        f"/api/agentic/mm/channels/{channel_id}/status",
        json={"status": "typing"},
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 204, r.text
    evt = _member_status_events(fake_bus)[-1]
    assert "activity" not in evt["data"]
    assert fake_bus.presence[-1][4] is None

    # Offline tombstone: activity dropped, presence cleared.
    r = test_client.post(
        f"/api/agentic/mm/channels/{channel_id}/status",
        json={"status": "offline", "activity": {"kind": "thinking", "label": "hm"}},
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 204, r.text
    assert fake_bus.cleared[-1][2] == agent["agent_id"]
    evt = _member_status_events(fake_bus)[-1]
    assert evt["data"]["status"] == "offline"
    assert "activity" not in evt["data"]


def test_presence_snapshot_roundtrips_activity():
    """presence_set stores the JSON form only when activity is present and
    presence_snapshot parses both forms back (bus-level, fake redis)."""
    from clawbits.realtime.bus import EventBus, PresenceEntry

    class FakeRedis:
        def __init__(self) -> None:
            self.hashes: dict[str, dict[str, str]] = {}

        async def hset(self, key, field, value):
            self.hashes.setdefault(key, {})[field] = value

        async def execute_command(self, *args):
            return None

        async def hgetall(self, key):
            return dict(self.hashes.get(key, {}))

    bus = EventBus("redis://unused:6379/0")
    fake_redis = FakeRedis()

    # presence_set/_snapshot reach redis through bus._client(); stub it.
    async def _client():
        return fake_redis

    bus._client = _client  # type: ignore[method-assign]

    async def run() -> list[PresenceEntry]:
        # Legacy plain-string entry (a human typing, or an old plugin)...
        await bus.presence_set("ch", "agent", "a1", "typing")
        # ...and a JSON entry carrying activity.
        await bus.presence_set(
            "ch", "agent", "a2", "generating",
            activity={"kind": "thinking", "label": "hmm"},
        )
        assert fake_redis.hashes["presence:ch"]["agent:a1"] == "typing"
        assert fake_redis.hashes["presence:ch"]["agent:a2"].startswith("{")
        return await bus.presence_snapshot("ch")

    entries = asyncio.run(run())
    by_id = {e.member_id: e for e in entries}
    assert by_id["a1"].status == "typing" and by_id["a1"].activity is None
    assert by_id["a2"].status == "generating"
    assert by_id["a2"].activity == {"kind": "thinking", "label": "hmm"}


# ---------------------------------------------------------------------------
# streaming publish throttle
# ---------------------------------------------------------------------------


def test_streaming_publish_throttle():
    from clawbits.realtime.sse import (
        _reset_streaming_throttle_for_tests,
        publish_post_updated_streaming,
    )

    _reset_streaming_throttle_for_tests()
    fake = FakeBus()

    def _post(pid: int, status: str, message: str) -> dict[str, Any]:
        return {"post_id": pid, "status": status, "message": message}

    async def run() -> None:
        await publish_post_updated_streaming(fake, "ch", _post(1, "streaming", "a"))
        # Within the window: superseded intermediate is dropped.
        await publish_post_updated_streaming(fake, "ch", _post(1, "streaming", "ab"))
        # Independent post is unaffected.
        await publish_post_updated_streaming(fake, "ch", _post(2, "streaming", "x"))
        # Terminal payload publishes immediately (and clears the entry).
        await publish_post_updated_streaming(fake, "ch", _post(1, "published", "abc"))
        # Post 1 streams again (hypothetical reuse): passes because the
        # throttle entry was popped on the terminal publish.
        await publish_post_updated_streaming(fake, "ch", _post(1, "streaming", "z"))
        # After the window elapses, the next streaming update passes.
        await asyncio.sleep(0.06)
        await publish_post_updated_streaming(fake, "ch", _post(1, "streaming", "zz"))

    asyncio.run(run())
    got = [(e["type"], e["data"]["message"]) for _, e in fake.published]
    assert got == [
        ("post.updated", "a"),
        ("post.updated", "x"),
        ("post.updated", "abc"),
        ("post.updated", "z"),
        ("post.updated", "zz"),
    ]
