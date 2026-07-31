"""Tests for agent global liveness:

* the ``agent_liveness_status`` threshold helper (setup / available / offline),
* the ``POST /api/agentic/alive`` heartbeat endpoint, and
* ``agent_status`` / ``last_alive_at`` surfacing on channel member lists.
"""
from datetime import UTC, datetime, timedelta

from sqlmodel import Session, select
from starlette.testclient import TestClient

from clawbits.datastructures.mm_models import (
    AGENT_OFFLINE_AFTER,
    agent_liveness_status,
)
from clawbits.db.models import Agent, MmChannel
from clawbits.db.table_read import TableRead
from clawbits.db.table_write import TableWrite
from tests.fastapi.conftest import _create_agent

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _alive(test_client: TestClient, api_key: str):
    return test_client.post(
        "/api/agentic/alive", headers={"Authorization": f"Bearer {api_key}"}
    )


def _alive_reporting(
    test_client: TestClient,
    api_key: str,
    *,
    agent_type: str | None = None,
    plugin_version: str | None = None,
):
    """An alive ping the way a modern plugin sends it: a small metadata body and
    the ``X-Clawbits-Plugin-Version`` header that rides every request."""
    headers = {"Authorization": f"Bearer {api_key}"}
    if plugin_version is not None:
        headers["X-Clawbits-Plugin-Version"] = plugin_version
    body: dict = {}
    if agent_type is not None:
        body["agent_type"] = agent_type
    return test_client.post("/api/agentic/alive", headers=headers, json=body)


def _operator_dm_channel_id(server, agent_id: str) -> str:
    """The operator↔agent DM channel provisioned at signup approval — the
    agent is a member, so it's a convenient place to read its member row."""
    with Session(server._engine) as s:
        channel = s.exec(
            select(MmChannel).where(MmChannel.created_by_agent == agent_id)
        ).first()
        assert channel is not None, "expected the operator DM channel"
        return channel.channel_id


def _agent_member(members: list[dict], agent_id: str) -> dict:
    return next(m for m in members if m["agent_id"] == agent_id)


def _list_members(test_client: TestClient, channel_id: str, api_key: str) -> list[dict]:
    resp = test_client.get(
        f"/api/agentic/mm/channels/{channel_id}/members",
        headers={"Authorization": f"Bearer {api_key}"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["members"]


# ---------------------------------------------------------------------------
# threshold helper (pure unit)
# ---------------------------------------------------------------------------


def test_liveness_status_thresholds():
    now = datetime(2026, 6, 4, 12, 0, 0, tzinfo=UTC)
    assert agent_liveness_status(None, now=now) == "setup"
    assert agent_liveness_status(now, now=now) == "available"
    assert agent_liveness_status(now - timedelta(minutes=25), now=now) == "available"
    # Inclusive at the boundary — the user spec is "40 minutes -> still Available".
    assert agent_liveness_status(now - AGENT_OFFLINE_AFTER, now=now) == "available"
    assert (
        agent_liveness_status(
            now - AGENT_OFFLINE_AFTER - timedelta(seconds=1), now=now
        )
        == "offline"
    )


def test_liveness_status_assumes_utc_for_naive_timestamps():
    now = datetime(2026, 6, 4, 12, 0, 0, tzinfo=UTC)
    naive = (now - timedelta(minutes=5)).replace(tzinfo=None)
    assert agent_liveness_status(naive, now=now) == "available"


# ---------------------------------------------------------------------------
# POST /api/agentic/alive
# ---------------------------------------------------------------------------


def test_alive_requires_auth(test_client):
    assert test_client.post("/api/agentic/alive").status_code == 401
    assert _alive(test_client, "not-a-real-key").status_code == 401


def test_alive_marks_available_and_persists(test_client):
    data = _create_agent(test_client)
    agent_id = data["agent_id"]
    server = test_client.app

    # A fresh agent has never pinged -> setup.
    with Session(server._engine) as s:
        assert s.get(Agent, agent_id).last_alive_at is None

    resp = _alive(test_client, data["api_key"])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "available"
    assert body["last_alive_at"]
    assert body["offline_after_seconds"] == int(AGENT_OFFLINE_AFTER.total_seconds())

    # The column is now set and reads available.
    with Session(server._engine) as s:
        row = s.get(Agent, agent_id)
        assert row.last_alive_at is not None
        assert agent_liveness_status(row.last_alive_at) == "available"


def test_alive_persists_self_reported_metadata(test_client):
    """A modern ping folds the plugin's self-reported runtime kind (body) and
    plugin version (header) onto the agent row."""
    data = _create_agent(test_client)
    agent_id = data["agent_id"]
    server = test_client.app

    resp = _alive_reporting(
        test_client, data["api_key"], agent_type="openclaw", plugin_version="0.9.2"
    )
    assert resp.status_code == 200, resp.text

    with Session(server._engine) as s:
        row = s.get(Agent, agent_id)
        assert row.agent_type == "openclaw"
        assert row.plugin_version == "0.9.2"


def test_alive_empty_body_does_not_wipe_metadata(test_client):
    """A legacy plugin pings with no body / no version header; that must not
    clear metadata a modern ping previously reported (write-only-when-present)."""
    data = _create_agent(test_client)
    agent_id, api_key = data["agent_id"], data["api_key"]
    server = test_client.app

    assert _alive_reporting(
        test_client, api_key, agent_type="openclaw", plugin_version="0.9.2"
    ).status_code == 200
    # A bare ping (old plugin): still succeeds, leaves the metadata intact.
    assert _alive(test_client, api_key).status_code == 200

    with Session(server._engine) as s:
        row = s.get(Agent, agent_id)
        assert row.agent_type == "openclaw"
        assert row.plugin_version == "0.9.2"


def test_alive_surfaces_on_member_list(test_client):
    data = _create_agent(test_client)
    agent_id, api_key = data["agent_id"], data["api_key"]
    server = test_client.app
    channel_id = _operator_dm_channel_id(server, agent_id)

    # Before any ping: setup, no timestamp.
    m = _agent_member(_list_members(test_client, channel_id, api_key), agent_id)
    assert m["agent_status"] == "setup"
    assert m["last_alive_at"] is None

    # After a ping: available, with a timestamp the client can derive from.
    assert _alive(test_client, api_key).status_code == 200
    m = _agent_member(_list_members(test_client, channel_id, api_key), agent_id)
    assert m["agent_status"] == "available"
    assert m["last_alive_at"] is not None


def test_human_members_have_no_agent_status(test_client):
    """Human member rows leave the agent fields null (the dot only renders for
    agents)."""
    data = _create_agent(test_client)
    agent_id, api_key = data["agent_id"], data["api_key"]
    server = test_client.app
    channel_id = _operator_dm_channel_id(server, agent_id)

    members = _list_members(test_client, channel_id, api_key)
    humans = [m for m in members if m["human_id"] is not None]
    assert humans, "operator DM should have a human member"
    for h in humans:
        assert h["agent_status"] is None
        assert h["last_alive_at"] is None


def test_offline_after_window(test_client):
    """A last ping older than the window reads offline on the member list — the
    time-based transition, computed on read with no server event."""
    data = _create_agent(test_client)
    agent_id, api_key = data["agent_id"], data["api_key"]
    server = test_client.app
    channel_id = _operator_dm_channel_id(server, agent_id)

    stale = datetime.now(UTC) - AGENT_OFFLINE_AFTER - timedelta(minutes=1)
    with Session(server._engine) as s:
        TableWrite.touch_agent_last_alive(s, agent_id, when=stale)
        s.commit()

    m = _agent_member(_list_members(test_client, channel_id, api_key), agent_id)
    assert m["agent_status"] == "offline"


# ---------------------------------------------------------------------------
# fan-out helpers (drive the agent.status SSE broadcast)
# ---------------------------------------------------------------------------


def test_fanout_helpers_find_channels_and_humans(test_client):
    data = _create_agent(test_client)
    agent_id = data["agent_id"]
    server = test_client.app
    channel_id = _operator_dm_channel_id(server, agent_id)

    with Session(server._engine) as s:
        channel_ids = TableRead.get_mm_channel_ids_for_agent(s, agent_id)
        human_ids = TableRead.get_human_ids_sharing_channel_with_agent(s, agent_id)

    assert channel_id in channel_ids
    # The operator shares the DM channel with the agent, so they receive the
    # agent.status fan-out on their per-user topic.
    assert len(human_ids) >= 1
