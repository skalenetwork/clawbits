"""Tests for the LobsterTalk agent-mode settings: the operator PATCH surface
and the agent-facing config snapshot on GET /api/agentic/agents/{id}/info."""

from sqlmodel import Session
from starlette.testclient import TestClient

from clawbits.db.models import Agent
from tests.fastapi._auth_helpers import auth_headers, login_human, register_human
from tests.fastapi.conftest import _create_agent


def _unique_email(prefix: str) -> str:
    import time

    return f"{prefix}-{int(time.time() * 1000)}@test.com"


def _get_info(test_client: TestClient, agent_id: str, api_key: str) -> dict:
    resp = test_client.get(
        f"/api/agentic/agents/{agent_id}/info",
        headers={"Authorization": f"Bearer {api_key}"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _setup(test_client: TestClient):
    data = _create_agent(test_client)
    info = _get_info(test_client, data["agent_id"], data["api_key"])
    operator_token, _ = login_human(test_client, "stan@clawbits.ai")
    return data["agent_id"], data["api_key"], operator_token, info["org_id"]


def test_info_returns_lobstertalk_defaults(test_client):
    """A fresh agent reports LobsterTalk off with x=60, y=100."""
    data = _create_agent(test_client)
    info = _get_info(test_client, data["agent_id"], data["api_key"])

    assert info["lobstertalk_enabled"] is False
    assert info["lobstertalk_ollama_host"] is None
    assert info["lobstertalk_ollama_model"] is None
    assert info["lobstertalk_interval_seconds"] == 60
    assert info["lobstertalk_message_limit"] == 100


def test_operator_can_toggle_lobstertalk(test_client):
    """Operator enables LobsterTalk with host/model/x/y; /info reflects it.

    The GET must stay billing-free so a drained sidecar can still read its
    config.
    """
    agent_id, api_key, operator_token, org_id = _setup(test_client)

    resp = test_client.patch(
        f"/api/human/orgs/{org_id}/agents/{agent_id}/settings",
        json={
            "lobstertalk_enabled": True,
            "lobstertalk_ollama_host": "gpu-box",
            "lobstertalk_ollama_model": "qwen3:4b",
            "lobstertalk_interval_seconds": 30,
            "lobstertalk_message_limit": 50,
        },
        headers=auth_headers(operator_token),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["lobstertalk_enabled"] is True
    # bare host is canonicalized to scheme://host:port
    assert body["lobstertalk_ollama_host"] == "http://gpu-box:11434"
    assert body["lobstertalk_ollama_model"] == "qwen3:4b"
    assert body["lobstertalk_interval_seconds"] == 30
    assert body["lobstertalk_message_limit"] == 50

    info = _get_info(test_client, agent_id, api_key)
    assert info["lobstertalk_enabled"] is True
    assert info["lobstertalk_ollama_host"] == "http://gpu-box:11434"
    assert info["lobstertalk_ollama_model"] == "qwen3:4b"
    assert info["lobstertalk_interval_seconds"] == 30
    assert info["lobstertalk_message_limit"] == 50


def test_info_read_is_billing_free(test_client, _test_engine):
    """/info stays 200 with zero CB_TOKENS (reads are never billed)."""
    agent_id, api_key, _, _ = _setup(test_client)
    with Session(_test_engine) as db:
        agent = db.get(Agent, agent_id)
        agent.cb_tokens = 0
        db.add(agent)
        db.commit()
    _get_info(test_client, agent_id, api_key)


def test_lobstertalk_host_normalization_and_rejection(test_client):
    """Host forms canonicalize; URLs with paths are rejected."""
    agent_id, _, operator_token, org_id = _setup(test_client)
    url = f"/api/human/orgs/{org_id}/agents/{agent_id}/settings"

    resp = test_client.patch(
        url,
        json={"lobstertalk_ollama_host": "https://ollama.internal:8080/"},
        headers=auth_headers(operator_token),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["lobstertalk_ollama_host"] == "https://ollama.internal:8080"

    resp = test_client.patch(
        url,
        json={"lobstertalk_ollama_host": "http://gpu-box/api/chat"},
        headers=auth_headers(operator_token),
    )
    assert resp.status_code == 422


def test_lobstertalk_host_unparseable_is_422_not_500(test_client):
    """Inputs that make urlsplit/.port raise ValueError (non-numeric or
    out-of-range port, unclosed IPv6 bracket) must surface as the same 422
    validation error, not an unhandled 500."""
    agent_id, _, operator_token, org_id = _setup(test_client)
    url = f"/api/human/orgs/{org_id}/agents/{agent_id}/settings"

    for bad in (
        "http://gpu-box:not-a-port",
        "gpu-box:99999",
        "http://[::1",
    ):
        resp = test_client.patch(
            url,
            json={"lobstertalk_ollama_host": bad},
            headers=auth_headers(operator_token),
        )
        assert resp.status_code == 422, (bad, resp.status_code, resp.text)


def test_lobstertalk_host_and_model_can_be_cleared(test_client):
    """Explicit null (or empty string) clears host/model back to None."""
    agent_id, api_key, operator_token, org_id = _setup(test_client)
    url = f"/api/human/orgs/{org_id}/agents/{agent_id}/settings"

    resp = test_client.patch(
        url,
        json={"lobstertalk_ollama_host": "gpu-box", "lobstertalk_ollama_model": "qwen3:4b"},
        headers=auth_headers(operator_token),
    )
    assert resp.status_code == 200, resp.text

    resp = test_client.patch(
        url,
        json={"lobstertalk_ollama_host": None, "lobstertalk_ollama_model": ""},
        headers=auth_headers(operator_token),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["lobstertalk_ollama_host"] is None
    assert resp.json()["lobstertalk_ollama_model"] is None

    info = _get_info(test_client, agent_id, api_key)
    assert info["lobstertalk_ollama_host"] is None
    assert info["lobstertalk_ollama_model"] is None


def test_lobstertalk_bounds_rejected(test_client):
    """Interval below 15s / limit above 200 are rejected; empty body is 400."""
    agent_id, _, operator_token, org_id = _setup(test_client)
    url = f"/api/human/orgs/{org_id}/agents/{agent_id}/settings"

    for bad in (
        {"lobstertalk_interval_seconds": 5},
        {"lobstertalk_interval_seconds": 4000},
        {"lobstertalk_message_limit": 5},
        {"lobstertalk_message_limit": 500},
    ):
        resp = test_client.patch(url, json=bad, headers=auth_headers(operator_token))
        assert resp.status_code == 422, (bad, resp.text)

    resp = test_client.patch(url, json={}, headers=auth_headers(operator_token))
    assert resp.status_code == 400


def test_non_operator_cannot_toggle_lobstertalk(test_client):
    """A non-operator org member gets 403 on the LobsterTalk settings."""
    other_email = _unique_email("non-op-mut")
    register_human(test_client, other_email)

    agent_id, _, operator_token, org_id = _setup(test_client)
    add_resp = test_client.post(
        f"/api/human/orgs/{org_id}/members",
        json={"email": other_email, "role": "member"},
        headers=auth_headers(operator_token),
    )
    assert add_resp.status_code == 200, add_resp.text

    other_token, _ = login_human(test_client, other_email)
    resp = test_client.patch(
        f"/api/human/orgs/{org_id}/agents/{agent_id}/settings",
        json={"lobstertalk_enabled": True},
        headers=auth_headers(other_token),
    )
    assert resp.status_code == 403


def test_agent_detail_exposes_lobstertalk_settings(test_client):
    """The Manage-page read path (GET agent detail) hydrates LobsterTalk state."""
    agent_id, _, operator_token, org_id = _setup(test_client)
    url = f"/api/human/orgs/{org_id}/agents/{agent_id}"

    detail = test_client.get(url, headers=auth_headers(operator_token))
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body["lobstertalk_enabled"] is False
    assert body["lobstertalk_ollama_host"] is None
    assert body["lobstertalk_ollama_model"] is None
    assert body["lobstertalk_interval_seconds"] == 60
    assert body["lobstertalk_message_limit"] == 100

    # After the operator enables it, the same read path reflects the change so
    # the Manage form settles to the server's truth.
    patch = test_client.patch(
        f"{url}/settings",
        json={"lobstertalk_enabled": True, "lobstertalk_ollama_model": "qwen3:4b"},
        headers=auth_headers(operator_token),
    )
    assert patch.status_code == 200, patch.text
    body = test_client.get(url, headers=auth_headers(operator_token)).json()
    assert body["lobstertalk_enabled"] is True
    assert body["lobstertalk_ollama_model"] == "qwen3:4b"
