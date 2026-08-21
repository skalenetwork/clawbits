"""Global human presence (online / idle / offline).

These tests stub the Redis-backed event bus with an in-memory fake so
they don't depend on a running Redis. Covers:

* ``POST /api/human/presence`` writes and round-trips through Redis.
* Same-status heartbeats are silent on the bus and DB.
* Status transitions persist ``last_seen_at`` and publish ``user.status``.
* The members list seeds ``status`` from Redis.
* ``GET /api/human/users/{id}/presence`` reads from the bus + DB.

Redis-throttled persistence (every 5 min while online) is verified by
making the fake bus' ``last_seen_persist_try_acquire`` deterministic.
"""
from __future__ import annotations

from typing import Any

import pytest
from starlette.testclient import TestClient

from tests.fastapi._auth_helpers import (
    add_human_to_org,
    personal_org_id,
    register_human,
)


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


class FakeEventBus:
    """In-memory stand-in for the realtime bus.

    Stores a single status per human and a separate persisted-recently
    flag so tests can force or skip the DB write throttle. Captures
    every ``publish`` call so we can assert fan-out behavior."""

    def __init__(self) -> None:
        self._statuses: dict[int, str] = {}
        self._allow_persist: bool = True
        self.published: list[tuple[str, dict[str, Any]]] = []

    # -- presence ops the endpoint uses --

    async def user_presence_get(self, human_id: int) -> str:
        return self._statuses.get(human_id, "offline")

    async def user_presence_set(self, human_id: int, status: str) -> None:
        self._statuses[human_id] = status

    async def user_presence_clear(self, human_id: int) -> None:
        self._statuses.pop(human_id, None)

    async def user_presence_get_many(self, human_ids: list[int]) -> dict[int, str]:
        return {hid: self._statuses.get(hid, "offline") for hid in human_ids}

    async def last_seen_persist_try_acquire(self, human_id: int) -> bool:
        return self._allow_persist

    async def publish(self, topic: str, event: dict[str, Any]) -> None:
        self.published.append((topic, event))

    # -- per-channel ops the post endpoint touches --

    async def presence_set(self, *_args, **_kwargs) -> None:
        return None

    async def presence_clear(self, *_args, **_kwargs) -> None:
        return None

    async def presence_snapshot(self, _channel_id: str):
        return []


@pytest.fixture
def fake_bus(monkeypatch: pytest.MonkeyPatch) -> FakeEventBus:
    """Replace the process-wide bus with our in-memory fake."""
    from clawbits.realtime import bus as bus_module

    fake = FakeEventBus()
    # Both ``get_bus()`` and downstream re-exports point through the
    # module-level singleton — overwrite that directly.
    monkeypatch.setattr(bus_module, "_bus", fake)
    return fake


# ---------------------------------------------------------------------------
# /api/human/presence
# ---------------------------------------------------------------------------


def test_presence_initial_online_transition_persists_and_publishes(
    test_client: TestClient, fake_bus: FakeEventBus
) -> None:
    u = register_human(test_client, "pres-a@example.com")
    r = test_client.post(
        "/api/human/presence",
        json={"status": "online"},
        headers=_auth(u["access_token"]),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "online"
    # last_seen_at populated by the transition path.
    assert body["last_seen_at"] is not None
    # Bus state reflects the new status.
    assert fake_bus._statuses[u["user"]["id"]] == "online"
    # ``user.status`` event was published on the user's own topic.
    topics = [t for t, _ in fake_bus.published]
    assert any(t == f"human:{u['user']['id']}" for t in topics)
    event_types = {evt["type"] for _t, evt in fake_bus.published}
    assert "user.status" in event_types


def test_presence_same_status_heartbeat_silent_when_throttled(
    test_client: TestClient, fake_bus: FakeEventBus
) -> None:
    u = register_human(test_client, "pres-b@example.com")
    # First call: transition offline -> online (persists + publishes).
    test_client.post(
        "/api/human/presence",
        json={"status": "online"},
        headers=_auth(u["access_token"]),
    )
    fake_bus.published.clear()
    # Force the throttle to be cold (DB write not due yet).
    fake_bus._allow_persist = False
    # Second call: same status — should NOT publish, throttle blocks DB write.
    r = test_client.post(
        "/api/human/presence",
        json={"status": "online"},
        headers=_auth(u["access_token"]),
    )
    assert r.status_code == 200
    assert fake_bus.published == [], "same-status heartbeat must not publish"


def test_presence_offline_transition_clears_redis(
    test_client: TestClient, fake_bus: FakeEventBus
) -> None:
    u = register_human(test_client, "pres-c@example.com")
    test_client.post(
        "/api/human/presence",
        json={"status": "online"},
        headers=_auth(u["access_token"]),
    )
    assert u["user"]["id"] in fake_bus._statuses
    r = test_client.post(
        "/api/human/presence",
        json={"status": "offline"},
        headers=_auth(u["access_token"]),
    )
    assert r.status_code == 200
    assert u["user"]["id"] not in fake_bus._statuses
    # Last published event is the offline transition.
    last_evt = fake_bus.published[-1][1]
    assert last_evt["type"] == "user.status"
    assert last_evt["data"]["status"] == "offline"


def test_presence_transition_fans_out_to_member_channels(
    test_client: TestClient, fake_bus: FakeEventBus
) -> None:
    """user.status should be published on every channel the user is in,
    so other members viewing those channels can refresh their dots."""
    u = register_human(test_client, "pres-d@example.com")
    # Create a channel — the creator is auto-added as a member.
    from tests.fastapi.test_human_mattermost import _create_channel

    ch = _create_channel(test_client, u["access_token"], "general-pres")
    cid = ch["channel_id"]

    r = test_client.post(
        "/api/human/presence",
        json={"status": "online"},
        headers=_auth(u["access_token"]),
    )
    assert r.status_code == 200
    topics = {t for t, _ in fake_bus.published}
    assert f"human:{u['user']['id']}" in topics
    assert f"channel:{cid}" in topics


def test_presence_transition_fans_out_to_fellow_per_user_topics(
    test_client: TestClient, fake_bus: FakeEventBus
) -> None:
    """A peer sitting on the home page (only subscribed to their own
    per-user topic) must still receive the dot update — the backend
    fans the event out to every fellow human's per-user topic too,
    not just the shared channel topic."""
    from tests.fastapi.test_human_mattermost import _create_channel

    # Two users in the same org, sharing one channel.
    alice = register_human(test_client, "fan-alice@example.com")
    bob = register_human(test_client, "fan-bob@example.com")
    add_human_to_org(
        test_client,
        alice["access_token"],
        personal_org_id(test_client, alice["access_token"]),
        "fan-bob@example.com",
    )
    ch = _create_channel(test_client, alice["access_token"], "shared-pres")
    # Add Bob as a member of Alice's channel.
    r = test_client.post(
        f"/api/human/mm/channels/{ch['channel_id']}/members",
        json={"member_id": str(bob["user"]["id"]), "member_type": "human"},
        headers=_auth(alice["access_token"]),
    )
    assert r.status_code == 200, r.text
    fake_bus.published.clear()

    # Bob comes online — Alice (on the home page, subscribed only to her
    # per-user topic) must receive a user.status event on `human:<alice_id>`.
    r = test_client.post(
        "/api/human/presence",
        json={"status": "online"},
        headers=_auth(bob["access_token"]),
    )
    assert r.status_code == 200
    topics = {t for t, _ in fake_bus.published}
    assert f"human:{alice['user']['id']}" in topics, (
        "Alice's per-user topic should receive Bob's status change"
    )


# ---------------------------------------------------------------------------
# member list seeds status from Redis
# ---------------------------------------------------------------------------


def test_member_list_includes_status_from_redis(
    test_client: TestClient, fake_bus: FakeEventBus
) -> None:
    u = register_human(test_client, "pres-e@example.com")
    from tests.fastapi.test_human_mattermost import _create_channel

    ch = _create_channel(test_client, u["access_token"], "members-pres")
    # Pre-seed the bus with an online status.
    fake_bus._statuses[u["user"]["id"]] = "online"

    r = test_client.get(
        f"/api/human/mm/channels/{ch['channel_id']}/members",
        headers=_auth(u["access_token"]),
    )
    assert r.status_code == 200, r.text
    members = r.json()["members"]
    human_row = next(m for m in members if m.get("human_id") == u["user"]["id"])
    assert human_row["status"] == "online"


# ---------------------------------------------------------------------------
# GET /api/human/users/{id}/presence
# ---------------------------------------------------------------------------


def test_get_user_presence_returns_bus_state(
    test_client: TestClient, fake_bus: FakeEventBus
) -> None:
    u = register_human(test_client, "pres-f@example.com")
    # User has never heartbeated → offline.
    r = test_client.get(
        f"/api/human/users/{u['user']['id']}/presence",
        headers=_auth(u["access_token"]),
    )
    assert r.status_code == 200
    assert r.json()["status"] == "offline"
    # After heartbeat → online.
    test_client.post(
        "/api/human/presence",
        json={"status": "online"},
        headers=_auth(u["access_token"]),
    )
    r = test_client.get(
        f"/api/human/users/{u['user']['id']}/presence",
        headers=_auth(u["access_token"]),
    )
    assert r.json()["status"] == "online"
    assert r.json()["last_seen_at"] is not None


def test_get_user_presence_unknown_id_returns_404(
    test_client: TestClient, fake_bus: FakeEventBus
) -> None:
    u = register_human(test_client, "pres-g@example.com")
    r = test_client.get(
        "/api/human/users/99999/presence",
        headers=_auth(u["access_token"]),
    )
    assert r.status_code == 404
