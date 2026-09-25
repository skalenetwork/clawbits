"""Hosted MCP sign-in: which links count, who may start and finish one, what the agent says back."""
from __future__ import annotations

import threading
import uuid
from urllib.parse import parse_qs, urlencode, urlsplit

import pytest
from starlette.testclient import TestClient

from clawbits.fastapi import mcp_oauth_endpoints
from clawbits.fastapi.mcp_oauth_endpoints import mcp_oauth_redirect_url
from clawbits.realtime import agent_topic, get_bus
from tests.fastapi._auth_helpers import add_human_to_org, login_human, personal_org_id
from tests.fastapi.conftest import _create_agent
from tests.fastapi.test_human_mattermost import _add_member, _bearer, _create_channel

LINKS = "/api/agentic/mcp-oauth/links"
CLAIM = "/api/human/mcp-oauth/claim"
CALLBACK = "/api/human/mcp-oauth/callback"
RESULT = "/api/agentic/mcp-oauth/result"


def _link(agent_id: str, state: str, host: str = "auth.example.com", redirect: str | None = None) -> str:
    query = urlencode(
        {
            "response_type": "code",
            "client_id": "client_1",
            "code_challenge": "challenge",
            "redirect_uri": redirect or f"{mcp_oauth_redirect_url(agent_id)}/agentpit",
            "state": state,
            "resource": "https://api.agentpit.dev/mcp",
        }
    )
    return f"https://{host}/oauth2/authorize?{query}"


def _post(tc: TestClient, author_key: str, room: str, url: str) -> int:
    r = tc.post(f"/api/agentic/mm/channels/{room}/posts", json={"message": f"[Sign in]({url})"}, headers=_bearer(author_key))
    assert r.status_code == 200, r.text
    return r.json()["post_id"]


def _setup(tc: TestClient, email: str) -> tuple[dict, str, str, str, int]:
    """An agent that registered and posted its sign-in link; returns agent, operator token, room, state, post."""
    agent = _create_agent(tc, owner_email=email)
    token, _ = login_human(tc, email)
    room = _create_channel(tc, token, email.split("@")[0])["channel_id"]
    _add_member(tc, token, room, agent["agent_id"], "agent")
    state = str(uuid.uuid4())
    url = _link(agent["agent_id"], state)
    assert tc.post(LINKS, json={"url": url}, headers=_bearer(agent["api_key"])).status_code == 204
    return agent, token, room, state, _post(tc, agent["api_key"], room, url)


def _claim(tc: TestClient, token: str, url: str, post: int):
    return tc.post(CLAIM, json={"url": url, "post_id": post}, headers=_bearer(token))


def _started(tc: TestClient, token: str, agent_id: str, state: str, post: int) -> str:
    """Click the posted link; returns the state only this click holds."""
    r = _claim(tc, token, _link(agent_id, state), post)
    assert r.status_code == 200, r.text
    return parse_qs(urlsplit(r.json()["url"]).query)["state"][0]


def _sign_in(tc: TestClient, token: str, agent_id: str, state: str, server: str = "agentpit"):
    body = {"agent_id": agent_id, "server": server, "state": state, "code": "code_123"}
    return tc.post(CALLBACK, json=body, headers=_bearer(token))


def _agent_answers(
    tc: TestClient, monkeypatch, api_key: str | None, connected: bool = True, listeners: int = 1
) -> list[tuple[str, dict]]:
    """Stand in for the agent's plugin: capture the code event and post its verdict back."""
    events: list[tuple[str, dict]] = []
    bus = get_bus()
    publish = bus.publish

    def answer(state: str) -> None:
        tc.post(RESULT, json={"state": state, "connected": connected}, headers=_bearer(api_key))

    async def capture(topic: str, event: dict) -> int | None:
        if event.get("type") != "mcp.oauth.code":
            return await publish(topic, event)
        events.append((topic, event))
        if api_key and listeners:
            threading.Thread(target=answer, args=(event["data"]["state"],)).start()
        return listeners

    monkeypatch.setattr(bus, "publish", capture)
    return events


def test_a_click_gets_the_registered_link_and_the_code_reaches_the_agent(
    test_client: TestClient, monkeypatch
):
    agent, token, room, state, post = _setup(test_client, "mcp-ok@clawbits.ai")
    events = _agent_answers(test_client, monkeypatch, agent["api_key"])
    r = _claim(test_client, token, _link(agent["agent_id"], state), post)
    assert r.status_code == 200, r.text
    fresh = parse_qs(urlsplit(r.json()["url"]).query)["state"][0]
    assert fresh != state
    assert r.json()["url"] == _link(agent["agent_id"], fresh)
    r = _sign_in(test_client, token, agent["agent_id"], fresh)
    assert r.status_code == 200, r.text
    assert r.json()["channel_id"] == room
    [(topic, event)] = events
    assert topic == agent_topic(agent["agent_id"])
    assert event["data"]["human_id"] > 0
    assert {k: v for k, v in event["data"].items() if k != "human_id"} == {
        "server": "agentpit",
        "code": "code_123",
        "state": fresh,
        "channel_id": room,
    }


def test_a_crafted_link_leads_to_the_registered_one_and_the_public_state_completes_nothing(
    test_client: TestClient, monkeypatch
):
    agent, token, _, state, post = _setup(test_client, "mcp-crafted@clawbits.ai")
    events = _agent_answers(test_client, monkeypatch, agent["api_key"])
    redirect = f"{mcp_oauth_redirect_url(agent['agent_id'])}/linear"
    r = _claim(test_client, token, _link(agent["agent_id"], state, host="evil.example", redirect=redirect), post)
    assert urlsplit(r.json()["url"]).netloc == "auth.example.com"
    assert _sign_in(test_client, token, agent["agent_id"], state).status_code == 409
    assert events == []
    fresh = parse_qs(urlsplit(r.json()["url"]).query)["state"][0]
    assert _sign_in(test_client, token, agent["agent_id"], fresh).status_code == 200


def test_a_link_counts_only_in_the_agents_own_message(test_client: TestClient):
    agent, token, room, state, _ = _setup(test_client, "mcp-own-message@clawbits.ai")
    url = _link(agent["agent_id"], state)
    other = _create_agent(test_client, owner_email="mcp-own-message@clawbits.ai")
    _add_member(test_client, token, room, other["agent_id"], "agent")
    human = test_client.post(
        f"/api/human/mm/channels/{room}/posts", json={"message": f"[Sign in]({url})"}, headers=_bearer(token)
    ).json()["post_id"]
    for post in (_post(test_client, other["api_key"], room, url), human):
        assert _claim(test_client, token, url, post).status_code == 404


def test_only_registered_links_can_be_started(test_client: TestClient):
    agent, token, room, _, _ = _setup(test_client, "mcp-unregistered@clawbits.ai")
    url = _link(agent["agent_id"], str(uuid.uuid4()))
    assert _claim(test_client, token, url, _post(test_client, agent["api_key"], room, url)).status_code == 404


def test_an_agent_registers_only_links_back_to_itself(test_client: TestClient):
    agent, _, _, _, _ = _setup(test_client, "mcp-register@clawbits.ai")
    other = _create_agent(test_client, owner_email="mcp-register-other@clawbits.ai")
    url = _link(other["agent_id"], str(uuid.uuid4()))
    assert test_client.post(LINKS, json={"url": url}, headers=_bearer(agent["api_key"])).status_code == 403


@pytest.mark.parametrize(
    "redirect",
    ["http://127.0.0.1:8989/oauth/callback", "https://evil.example/oauth/mcp/callback/a/agentpit"],
)
def test_only_links_back_to_our_callback_count(test_client: TestClient, redirect: str):
    agent, token, _, state, post = _setup(test_client, "mcp-foreign@clawbits.ai")
    url = _link(agent["agent_id"], state, redirect=redirect)
    assert _claim(test_client, token, url, post).status_code == 400
    assert test_client.post(LINKS, json={"url": url}, headers=_bearer(agent["api_key"])).status_code == 400


def test_a_failed_exchange_is_reported(test_client: TestClient, monkeypatch):
    agent, token, _, state, post = _setup(test_client, "mcp-err@clawbits.ai")
    _agent_answers(test_client, monkeypatch, agent["api_key"], connected=False)
    fresh = _started(test_client, token, agent["agent_id"], state, post)
    assert _sign_in(test_client, token, agent["agent_id"], fresh).status_code == 502


def test_a_sign_in_completes_once(test_client: TestClient, monkeypatch):
    agent, token, _, state, post = _setup(test_client, "mcp-once@clawbits.ai")
    _agent_answers(test_client, monkeypatch, agent["api_key"])
    fresh = _started(test_client, token, agent["agent_id"], state, post)
    assert _sign_in(test_client, token, agent["agent_id"], fresh).status_code == 200
    assert _sign_in(test_client, token, agent["agent_id"], fresh).status_code == 409


def test_an_offline_agent_keeps_the_claim(test_client: TestClient, monkeypatch):
    agent, token, _, state, post = _setup(test_client, "mcp-offline@clawbits.ai")
    fresh = _started(test_client, token, agent["agent_id"], state, post)
    _agent_answers(test_client, monkeypatch, None, listeners=0)
    assert _sign_in(test_client, token, agent["agent_id"], fresh).status_code == 409
    _agent_answers(test_client, monkeypatch, agent["api_key"])
    assert _sign_in(test_client, token, agent["agent_id"], fresh).status_code == 200


def test_a_silent_agent_times_out(test_client: TestClient, monkeypatch):
    agent, token, _, state, post = _setup(test_client, "mcp-silent@clawbits.ai")
    _agent_answers(test_client, monkeypatch, None)
    monkeypatch.setattr(mcp_oauth_endpoints, "RESULT_TIMEOUT_SECONDS", 1)
    fresh = _started(test_client, token, agent["agent_id"], state, post)
    assert _sign_in(test_client, token, agent["agent_id"], fresh).status_code == 504


@pytest.mark.parametrize(("role", "status"), [("member", 403), ("owner", 200)])
def test_only_the_operator_or_an_org_admin_may_start(
    test_client: TestClient, role: str, status: int
):
    agent, owner_token, _, state, post = _setup(test_client, f"mcp-operator-{role}@clawbits.ai")
    other_email = f"mcp-{role}@clawbits.ai"
    other_token, _ = login_human(test_client, other_email)
    add_human_to_org(test_client, owner_token, personal_org_id(test_client, owner_token), other_email, role)
    assert _claim(test_client, other_token, _link(agent["agent_id"], state), post).status_code == status


def test_only_the_human_who_clicked_may_finish_for_the_server_they_clicked(
    test_client: TestClient, monkeypatch
):
    agent, owner_token, _, state, post = _setup(test_client, "mcp-starter@clawbits.ai")
    admin_email = "mcp-other-admin@clawbits.ai"
    admin_token, _ = login_human(test_client, admin_email)
    add_human_to_org(test_client, owner_token, personal_org_id(test_client, owner_token), admin_email, "owner")
    events = _agent_answers(test_client, monkeypatch, agent["api_key"])
    fresh, other = (_started(test_client, owner_token, agent["agent_id"], state, post) for _ in range(2))
    assert _sign_in(test_client, admin_token, agent["agent_id"], fresh).status_code == 409
    assert _sign_in(test_client, owner_token, agent["agent_id"], other, server="linear").status_code == 409
    assert events == []


def test_a_verdict_from_another_agent_is_ignored(test_client: TestClient, monkeypatch):
    agent, token, _, state, post = _setup(test_client, "mcp-answer@clawbits.ai")
    stranger = _create_agent(test_client, owner_email="mcp-stranger@clawbits.ai")
    _agent_answers(test_client, monkeypatch, stranger["api_key"])
    monkeypatch.setattr(mcp_oauth_endpoints, "RESULT_TIMEOUT_SECONDS", 1)
    fresh = _started(test_client, token, agent["agent_id"], state, post)
    assert _sign_in(test_client, token, agent["agent_id"], fresh).status_code == 504
