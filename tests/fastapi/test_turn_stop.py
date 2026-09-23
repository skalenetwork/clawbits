"""Stopping a running agent turn: who may, which runtimes can, and what reaches the agent."""
from __future__ import annotations

import pytest
from starlette.testclient import TestClient

from clawbits.realtime import agent_topic, get_bus
from tests.fastapi._auth_helpers import add_human_to_org, login_human, personal_org_id
from tests.fastapi.conftest import _create_agent
from tests.fastapi.test_agent_contact_permissions import _grant
from tests.fastapi.test_automations import _set_agent_type
from tests.fastapi.test_human_mattermost import _add_member, _bearer, _create_channel


def _setup(tc: TestClient, engine, email: str) -> tuple[str, str, str]:
    agent_id = _create_agent(tc, owner_email=email)["agent_id"]
    token, _ = login_human(tc, email)
    _set_agent_type(engine, agent_id, "openclaw", "0.19.0")
    room = _create_channel(tc, token, email.split("@")[0])["channel_id"]
    _add_member(tc, token, room, agent_id, "agent")
    return agent_id, token, room


def _stop(tc: TestClient, token: str, room: str, agent_id: str) -> int:
    url = f"/api/human/mm/channels/{room}/agents/{agent_id}/stop"
    return tc.post(url, headers=_bearer(token)).status_code


def _can_stop(tc: TestClient, token: str, room: str, agent_id: str) -> bool:
    r = tc.get(f"/api/human/mm/channels/{room}/members", headers=_bearer(token))
    assert r.status_code == 200, r.text
    return next(m for m in r.json()["members"] if m["agent_id"] == agent_id)["can_stop"]


def _capture_stops(monkeypatch, listeners: int = 1) -> list[tuple[str, dict]]:
    events: list[tuple[str, dict]] = []
    bus = get_bus()
    publish = bus.publish

    async def capture(topic: str, event: dict) -> int | None:
        if event.get("type") != "turn.stop":
            return await publish(topic, event)
        events.append((topic, event))
        return listeners

    monkeypatch.setattr(bus, "publish", capture)
    return events


@pytest.fixture
def published(test_client: TestClient, monkeypatch) -> list[tuple[str, dict]]:
    return _capture_stops(monkeypatch)


@pytest.mark.parametrize(("listeners", "status"), [(1, 204), (0, 409)])
def test_stop_reaches_a_live_agent_socket(
    test_client: TestClient, _test_engine, monkeypatch, listeners: int, status: int
):
    agent_id, token, room = _setup(test_client, _test_engine, f"stop-live-{listeners}@clawbits.ai")
    published = _capture_stops(monkeypatch, listeners)
    assert _can_stop(test_client, token, room, agent_id)
    assert _stop(test_client, token, room, agent_id) == status
    assert published == [(agent_topic(agent_id), {"type": "turn.stop", "channel_id": room})]


@pytest.mark.parametrize(
    ("agent_type", "plugin_version"),
    [("openclaw", "0.18.0"), ("hermes", "0.9.0"), ("ironclaw", "9.0.0"), ("openclaw", "dev")],
)
def test_runtimes_without_stop_support_are_refused(
    test_client: TestClient, _test_engine, published, agent_type: str, plugin_version: str
):
    agent_id, token, room = _setup(
        test_client, _test_engine, f"stop-{agent_type}-{plugin_version}@clawbits.ai"
    )
    _set_agent_type(_test_engine, agent_id, agent_type, plugin_version)
    assert not _can_stop(test_client, token, room, agent_id)
    assert _stop(test_client, token, room, agent_id) == 403
    assert published == []


def test_only_those_who_could_start_the_turn_or_admins_may_stop(
    test_client: TestClient, _test_engine, published
):
    agent_id, owner_token, room = _setup(test_client, _test_engine, "stop-perms@clawbits.ai")
    member_email = "stop-perms-member@clawbits.ai"
    member_token, member = login_human(test_client, member_email)
    add_human_to_org(test_client, owner_token, personal_org_id(test_client, owner_token), member_email)
    _add_member(test_client, owner_token, room, member["id"])
    assert not _can_stop(test_client, member_token, room, agent_id)
    assert _stop(test_client, member_token, room, agent_id) == 403

    grant = _grant(test_client, owner_token, agent_id, "human", member["id"], can_tag=True)
    assert grant.status_code == 200, grant.text
    assert _can_stop(test_client, member_token, room, agent_id)
    assert _stop(test_client, member_token, room, agent_id) == 204
    assert len(published) == 1


def test_stopping_an_agent_outside_the_channel_is_404(
    test_client: TestClient, _test_engine, published
):
    agent_id, token, _ = _setup(test_client, _test_engine, "stop-elsewhere@clawbits.ai")
    empty = _create_channel(test_client, token, "stop-elsewhere-empty")["channel_id"]
    assert _stop(test_client, token, empty, agent_id) == 404
    assert published == []
