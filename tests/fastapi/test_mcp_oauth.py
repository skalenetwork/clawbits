"""Hosted MCP sign-in: which links register, who may start and finish one, and what marks it connected."""

from __future__ import annotations

from urllib.parse import parse_qs, urlencode, urlsplit

import pytest
from starlette.testclient import TestClient

from clawbits.fastapi.mcp_oauth_endpoints import mcp_oauth_redirect_url
from clawbits.realtime import agent_topic, get_bus
from tests.fastapi._auth_helpers import add_human_to_org, login_human, personal_org_id
from tests.fastapi.conftest import _create_agent
from tests.fastapi.test_human_mattermost import _bearer

REDIRECT = "/api/agentic/mcp-oauth/redirect"
LINKS = "/api/agentic/mcp-oauth/links"
CALLBACK = "/api/human/mcp-oauth/callback"
RESULT = "/api/agentic/mcp-oauth/result"


def _authorize(redirect: str | None = None) -> str:
    query = urlencode(
        {
            "response_type": "code",
            "client_id": "client_1",
            "code_challenge": "challenge",
            "redirect_uri": redirect or mcp_oauth_redirect_url(),
            "state": "agent-minted-state-0001",
        }
    )
    return f"https://auth.example.com/oauth2/authorize?{query}"


def _register(tc: TestClient, api_key: str, url: str | None = None) -> str:
    body = {"server": "agentpit", "url": url or _authorize(), "channel_id": "room_1"}
    r = tc.post(LINKS, json=body, headers=_bearer(api_key))
    assert r.status_code == 200, r.text
    return r.json()["url"].rsplit("/", 1)[1]


def _setup(tc: TestClient, email: str) -> tuple[dict, str, str]:
    """An agent that registered a sign-in; returns the agent, its operator's token and the link id."""
    agent = _create_agent(tc, owner_email=email)
    token, _ = login_human(tc, email)
    return agent, token, _register(tc, agent["api_key"])


def _card(tc: TestClient, token: str, link: str):
    return tc.get(f"/api/human/mcp-oauth/links/{link}", headers=_bearer(token))


def _claim(tc: TestClient, token: str, link: str, client: str = "web"):
    return tc.post(
        f"/api/human/mcp-oauth/links/{link}/claim", json={"client": client}, headers=_bearer(token)
    )


def _started(tc: TestClient, token: str, link: str, client: str = "web") -> str:
    """Click Connect; returns the state only this click holds."""
    r = _claim(tc, token, link, client)
    assert r.status_code == 200, r.text
    return parse_qs(urlsplit(r.json()["url"]).query)["state"][0]


def _sign_in(tc: TestClient, token: str, state: str):
    return tc.post(CALLBACK, json={"state": state, "code": "code_123"}, headers=_bearer(token))


def _report(tc: TestClient, api_key: str, state: str, connected: bool = True) -> None:
    assert (
        tc.post(
            RESULT, json={"state": state, "connected": connected}, headers=_bearer(api_key)
        ).status_code
        == 204
    )


def _agent_listens(monkeypatch, listeners: int = 1) -> list[tuple[str, dict]]:
    """Stand in for the agent's WebSocket: capture the code events it would receive."""
    events: list[tuple[str, dict]] = []
    bus = get_bus()
    publish = bus.publish

    async def capture(topic: str, event: dict) -> int | None:
        if event.get("type") != "mcp.oauth.code":
            return await publish(topic, event)
        events.append((topic, event))
        return listeners

    monkeypatch.setattr(bus, "publish", capture)
    return events


def test_connect_relays_the_code_and_the_agents_report_marks_the_card(
    test_client: TestClient, monkeypatch
):
    agent, token, link = _setup(test_client, "mcp-ok@clawbits.ai")
    assert test_client.get(REDIRECT, headers=_bearer(agent["api_key"])).json() == {
        "url": mcp_oauth_redirect_url()
    }
    card = _card(test_client, token, link).json()
    assert card == {
        "agent_name": card["agent_name"],
        "server": "agentpit",
        "host": "auth.example.com",
        "status": "open",
    }
    events = _agent_listens(monkeypatch)
    state = _started(test_client, token, link)
    r = _sign_in(test_client, token, state)
    assert r.status_code == 200, r.text
    assert r.json() == {"channel_id": "room_1"}
    [(topic, event)] = events
    assert topic == agent_topic(agent["agent_id"])
    assert event["data"] == {
        "state": state,
        "code": "code_123",
        "server": "agentpit",
        "channel_id": "room_1",
        "human_id": event["data"]["human_id"],
    }
    assert _card(test_client, token, link).json()["status"] == "connecting"
    assert _claim(test_client, token, link).status_code == 409
    _report(test_client, agent["api_key"], state)
    assert _card(test_client, token, link).json()["status"] == "connected"


def test_a_failed_exchange_reopens_the_card(test_client: TestClient, monkeypatch):
    agent, token, link = _setup(test_client, "mcp-err@clawbits.ai")
    _agent_listens(monkeypatch)
    state = _started(test_client, token, link)
    assert _sign_in(test_client, token, state).status_code == 200
    _report(test_client, agent["api_key"], state, connected=False)
    assert _card(test_client, token, link).json()["status"] == "open"


def test_only_the_agent_the_code_went_to_can_report(test_client: TestClient, monkeypatch):
    agent, token, link = _setup(test_client, "mcp-answer@clawbits.ai")
    stranger = _create_agent(test_client, owner_email="mcp-stranger@clawbits.ai")
    _agent_listens(monkeypatch)
    state = _started(test_client, token, link)
    assert _sign_in(test_client, token, state).status_code == 200
    _report(test_client, stranger["api_key"], state)
    assert _card(test_client, token, link).json()["status"] == "connecting"


@pytest.mark.parametrize(
    "redirect",
    ["http://127.0.0.1:8989/oauth/callback", "https://evil.example/oauth/mcp/callback"],
)
def test_only_links_back_to_our_callback_register(test_client: TestClient, redirect: str):
    agent = _create_agent(test_client, owner_email="mcp-foreign@clawbits.ai")
    body = {"server": "agentpit", "url": _authorize(redirect), "channel_id": "room_1"}
    assert test_client.post(LINKS, json=body, headers=_bearer(agent["api_key"])).status_code == 400


@pytest.mark.parametrize(
    "prefix",
    [
        "javascript:alert(1)//",
        "https://evil.example\\@mcp.linear.app/authorize",
        "https://evil.example@mcp.linear.app/authorize",
        "https://l\u0456near.app/authorize",
    ],
)
def test_only_plain_https_links_register(test_client: TestClient, prefix: str):
    agent = _create_agent(test_client, owner_email="mcp-scheme@clawbits.ai")
    url = f"{prefix}?{urlencode({'redirect_uri': mcp_oauth_redirect_url()})}"
    body = {"server": "linear", "url": url, "channel_id": "room_1"}
    assert test_client.post(LINKS, json=body, headers=_bearer(agent["api_key"])).status_code == 400


def test_two_clicks_cannot_both_finish(test_client: TestClient, monkeypatch):
    _, token, link = _setup(test_client, "mcp-race@clawbits.ai")
    events = _agent_listens(monkeypatch)
    first, second = (_started(test_client, token, link) for _ in range(2))
    assert _sign_in(test_client, token, first).status_code == 200
    assert _sign_in(test_client, token, second).status_code == 409
    assert len(events) == 1


def test_a_new_link_for_the_same_server_retires_the_old_one(test_client: TestClient):
    agent, token, first = _setup(test_client, "mcp-latest@clawbits.ai")
    second = _register(test_client, agent["api_key"])
    assert _card(test_client, token, first).status_code == 404
    assert _claim(test_client, token, first).status_code == 404
    assert _card(test_client, token, second).json()["status"] == "open"


def test_each_click_gets_its_own_state_and_the_agents_state_completes_nothing(
    test_client: TestClient, monkeypatch
):
    _, token, link = _setup(test_client, "mcp-fresh@clawbits.ai")
    events = _agent_listens(monkeypatch)
    first, second = (_started(test_client, token, link) for _ in range(2))
    assert len({first, second, "agent-minted-state-0001"}) == 3
    assert _sign_in(test_client, token, "agent-minted-state-0001").status_code == 409
    assert events == []


def test_native_clients_get_their_scheme_in_the_state(test_client: TestClient):
    _, token, link = _setup(test_client, "mcp-native@clawbits.ai")
    assert _started(test_client, token, link, "mobile").startswith("clawbits.")
    assert _started(test_client, token, link, "desktop").startswith("clawbits-dev.")
    assert "." not in _started(test_client, token, link)


def test_an_unknown_link_is_inactive(test_client: TestClient):
    token, _ = login_human(test_client, "mcp-unknown@clawbits.ai")
    assert _card(test_client, token, "nope").status_code == 404
    assert _claim(test_client, token, "nope").status_code == 404


def test_a_sign_in_completes_once(test_client: TestClient, monkeypatch):
    _, token, link = _setup(test_client, "mcp-once@clawbits.ai")
    _agent_listens(monkeypatch)
    state = _started(test_client, token, link)
    assert _sign_in(test_client, token, state).status_code == 200
    assert _sign_in(test_client, token, state).status_code == 409


def test_an_offline_agent_leaves_the_card_open(test_client: TestClient, monkeypatch):
    _, token, link = _setup(test_client, "mcp-offline@clawbits.ai")
    _agent_listens(monkeypatch, listeners=0)
    assert _sign_in(test_client, token, _started(test_client, token, link)).status_code == 409
    assert _card(test_client, token, link).json()["status"] == "open"


@pytest.mark.parametrize(("role", "status"), [("member", 403), ("owner", 200)])
def test_only_the_operator_or_an_org_admin_may_connect(
    test_client: TestClient, role: str, status: int
):
    _, owner_token, link = _setup(test_client, f"mcp-operator-{role}@clawbits.ai")
    other_email = f"mcp-{role}@clawbits.ai"
    other_token, _ = login_human(test_client, other_email)
    add_human_to_org(
        test_client, owner_token, personal_org_id(test_client, owner_token), other_email, role
    )
    assert _claim(test_client, other_token, link).status_code == status


def test_only_the_human_who_clicked_may_finish_and_a_wrong_account_burns_nothing(
    test_client: TestClient, monkeypatch
):
    _, owner_token, link = _setup(test_client, "mcp-starter@clawbits.ai")
    admin_email = "mcp-other-admin@clawbits.ai"
    admin_token, _ = login_human(test_client, admin_email)
    add_human_to_org(
        test_client, owner_token, personal_org_id(test_client, owner_token), admin_email, "owner"
    )
    events = _agent_listens(monkeypatch)
    state = _started(test_client, owner_token, link)
    assert _sign_in(test_client, admin_token, state).status_code == 409
    assert events == []
    assert _sign_in(test_client, owner_token, state).status_code == 200
