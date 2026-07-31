"""Human auth API tests — use the shared Postgres test DB.

Seeds a fixed TestAgent + a share_record + an agent_post via SQLModel, then
exercises ``/api/human/*`` endpoints. The seed runs inside an autouse
function-scoped fixture so it survives the per-test truncate performed by
``conftest.py`` between tests.
"""
from __future__ import annotations

import hashlib

import pytest
from sqlmodel import Session

from clawbits.datastructures.api_key import ApiKey
from clawbits.db.models import Agent, AgentPost, ShareRecord
from tests.fastapi._auth_helpers import login_human

_TEST_AGENT_ID = "TestAgent123"


@pytest.fixture(autouse=True)
def _seed_test_agent(test_client):
    """Seed the TestAgent + one share_record + one agent_post for each test."""
    from eth_account import Account
    from eth_utils import to_hex

    server = test_client.app
    acct = Account.create()
    api_key = ApiKey.generate().value
    key_hash = hashlib.sha256(api_key.encode()).hexdigest()

    with Session(server._engine) as s:
        s.add(
            Agent(
                agent_id=_TEST_AGENT_ID,
                api_key_hash=key_hash,
                eth_private_key=to_hex(acct.key),
                nickname="Testy",
                long_name="TestAgentLongName",
            )
        )
        s.add(
            ShareRecord(
                agent_id=_TEST_AGENT_ID,
                filename="test_file.txt",
                object_key=f"{_TEST_AGENT_ID}/test_file.txt",
                url="https://example.com/test_file.txt",
                content_type="text/plain",
                size=1024,
            )
        )
        s.add(
            AgentPost(
                agent_id=_TEST_AGENT_ID,
                message_type="say",
                message="Hello World!",
            )
        )
        s.commit()
    yield


def get_token(client, email="stan@clawbits.ai"):
    token, _ = login_human(client, email)
    return token


def _get_personal_org_id(client, token: str) -> str:
    """Fetch the personal org_id for the logged-in user."""
    resp = client.get("/api/human/orgs", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200, resp.text
    orgs = resp.json()["organizations"]
    personal = [o for o in orgs if o["is_personal"]]
    assert personal, "No personal org found"
    return personal[0]["org_id"]


def _assign_agent_to_org(client, agent_id: str, org_id: str, token: str):
    """Bind an agent to an org directly via the server DB. Test fixture only."""
    server = client.app
    with Session(server._engine) as s:
        agent = s.get(Agent, agent_id)
        if agent is not None:
            agent.org_id = org_id
            s.commit()


def test_magic_auth_creates_and_logs_in(test_client):
    """First magic-auth verify auto-creates the user and sets the session cookie."""
    send_resp = test_client.post(
        "/api/auth/magic/send", json={"email": "user1@test.com"}
    )
    assert send_resp.status_code == 204

    verify_resp = test_client.post(
        "/api/auth/magic/verify",
        json={"email": "user1@test.com", "code": "123456"},
    )
    assert verify_resp.status_code == 200, verify_resp.text
    assert verify_resp.json()["email"] == "user1@test.com"
    assert test_client.cookies.get("fc_session"), "session cookie should be set"


def test_magic_auth_invalid_code_rejected(test_client):
    """Wrong code is rejected without creating a session."""
    test_client.post("/api/auth/magic/send", json={"email": "user-x@test.com"})
    resp = test_client.post(
        "/api/auth/magic/verify",
        json={"email": "user-x@test.com", "code": "000000"},
    )
    # Pydantic accepts the 6-digit shape; the fake then rejects the value.
    assert resp.status_code == 401


def test_me(test_client):
    token = get_token(test_client)
    resp = test_client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["email"] == "stan@clawbits.ai"


def test_list_agents(test_client):
    token = get_token(test_client)
    org_id = _get_personal_org_id(test_client, token)
    _assign_agent_to_org(test_client, _TEST_AGENT_ID, org_id, token)
    resp = test_client.get(f"/api/human/orgs/{org_id}/agents", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    data = resp.json()
    assert "agents" in data
    assert any(a["agent_id"] == _TEST_AGENT_ID for a in data["agents"])


def test_get_agent_profile(test_client):
    token = get_token(test_client)
    org_id = _get_personal_org_id(test_client, token)
    _assign_agent_to_org(test_client, _TEST_AGENT_ID, org_id, token)
    # Existing agent
    resp = test_client.get(f"/api/human/orgs/{org_id}/agents/{_TEST_AGENT_ID}", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["agent_id"] == _TEST_AGENT_ID
    assert len(data["files"]) >= 1
    assert data["files"][0]["filename"] == "test_file.txt"
    assert len(data["posts"]) >= 1
    assert data["posts"][0]["message"] == "Hello World!"

    # Non-existent agent
    resp = test_client.get(f"/api/human/orgs/{org_id}/agents/NonExistentAgent", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 404


def test_list_shared_content(test_client):
    token = get_token(test_client)
    resp = test_client.get("/api/human/shared_content", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    data = resp.json()
    assert "files" in data
    assert any(f["agent_id"] == _TEST_AGENT_ID and f["filename"] == "test_file.txt" for f in data["files"])
    assert "total" in data


def test_list_all_agent_posts(test_client):
    token = get_token(test_client)
    resp = test_client.get("/api/human/posts", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    data = resp.json()
    assert "posts" in data
    assert any(c["agent_id"] == _TEST_AGENT_ID and c["message"] == "Hello World!" for c in data["posts"])
    assert "total" in data


def test_get_agent_posts_for_human(test_client):
    token = get_token(test_client)
    org_id = _get_personal_org_id(test_client, token)
    _assign_agent_to_org(test_client, _TEST_AGENT_ID, org_id, token)
    # Existing agent
    resp = test_client.get(f"/api/human/orgs/{org_id}/agents/{_TEST_AGENT_ID}/posts", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    data = resp.json()
    assert "posts" in data
    assert len(data["posts"]) >= 1
    assert data["posts"][0]["message"] == "Hello World!"

    # Non-existent agent
    resp = test_client.get(f"/api/human/orgs/{org_id}/agents/NonExistentAgent/posts", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 404


def test_unauthorized_access(test_client):
    # Try to access protected endpoint without token — use the orgs endpoint
    resp = test_client.get("/api/human/orgs")
    assert resp.status_code == 401  # FastAPI returns 401 if missing credentials


def test_catch_all_logs_404(test_client, caplog):
    with caplog.at_level("WARNING"):
        resp = test_client.get("/api/this_should_not_exist")
        assert resp.status_code == 404
        assert any(
            "404 Not Found: /api/this_should_not_exist" in record.message
            for record in caplog.records
        )

