"""Tests for Agent Profile endpoints."""
from starlette.testclient import TestClient

from clawbits.datastructures.known_answers import get_answer_for_question

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _create_agent(tc: TestClient) -> dict:
    from tests.fastapi._auth_helpers import signup_agent_via_email
    from tests.fastapi.approve_helper import _approve_signup

    r = signup_agent_via_email(tc, "stan@clawbits.ai")
    assert r.status_code == 200, r.text
    challenge = r.json()
    answer = get_answer_for_question(challenge["challenge"])
    r = tc.post("/api/agentic/signup-commit", json={
        "session_token": challenge["session_token"],
        "challenge_response": answer,
    })
    assert r.status_code == 200, r.text
    data = r.json()
    _approve_signup(tc, data)

    mint_challenge = tc.get(
        "/api/agentic/auth/challenge",
        headers={"Authorization": f"Bearer {data['api_key']}"},
    )
    assert mint_challenge.status_code == 200, mint_challenge.text
    mint_payload = mint_challenge.json()
    mint_answer = get_answer_for_question(mint_payload["challenge"])

    tc.post(
        "/api/agentic/auth/challenge_response",
        headers={
            "Authorization": f"Bearer {data['api_key']}",
        },
        json={
            "session_token": mint_payload["session_token"],
            "challenge_response": mint_answer,
        },
    )
    return data


def _auth(api_key: str) -> dict:
    return {"Authorization": f"Bearer {api_key}"}


def _write_headers(tc: TestClient, api_key: str) -> dict:
    r = tc.get("/api/agentic/auth/challenge", headers=_auth(api_key))
    assert r.status_code == 200, r.text
    ch = r.json()
    answer = get_answer_for_question(ch["challenge"])
    return _auth(api_key)


# ---------------------------------------------------------------------------
# Tests: PUT profile
# ---------------------------------------------------------------------------

def test_put_profile(test_client):
    """Agent can set its public profile."""
    agent = _create_agent(test_client)

    r = test_client.put(
        f"/api/agentic/agents/{agent['agent_id']}/profile",
        json={
            "display_name": "Silver Pigeon",
            "bio": "I automate code reviews.",
            "location": "San Francisco, CA",
            "website": "https://silverpigeon.dev",
        },
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["agent_id"] == agent["agent_id"]
    assert data["display_name"] == "Silver Pigeon"
    assert data["bio"] == "I automate code reviews."
    assert data["location"] == "San Francisco, CA"
    assert data["website"] == "https://silverpigeon.dev"
    assert data["avatar_url"] is None
    assert data["header_url"] is None
    assert "updated_at" in data


def test_put_profile_overwrites(test_client):
    """Setting profile again overwrites the previous one."""
    agent = _create_agent(test_client)

    test_client.put(
        f"/api/agentic/agents/{agent['agent_id']}/profile",
        json={"display_name": "Version 1", "bio": "Old bio"},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    r = test_client.put(
        f"/api/agentic/agents/{agent['agent_id']}/profile",
        json={"display_name": "Version 2", "bio": "New bio"},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200
    assert r.json()["display_name"] == "Version 2"
    assert r.json()["bio"] == "New bio"


def test_put_profile_requires_auth(test_client):
    """PUT without Authorization header fails."""
    r = test_client.put(
        "/api/agentic/agents/SomeAgent/profile",
        json={"display_name": "No auth"},
    )
    assert r.status_code in (401, 403)


def test_put_profile_wrong_agent(test_client):
    """Cannot set another agent's profile."""
    a1 = _create_agent(test_client)
    a2 = _create_agent(test_client)
    r = test_client.put(
        f"/api/agentic/agents/{a2['agent_id']}/profile",
        json={"display_name": "Hijacked"},
        headers=_write_headers(test_client, a1["api_key"]),
    )
    assert r.status_code in (401, 403)


# ---------------------------------------------------------------------------
# Tests: GET profile
# ---------------------------------------------------------------------------

def test_get_profile(test_client):
    """Agent can read back its profile."""
    agent = _create_agent(test_client)

    test_client.put(
        f"/api/agentic/agents/{agent['agent_id']}/profile",
        json={"display_name": "My Bot", "bio": "Hello!"},
        headers=_write_headers(test_client, agent["api_key"]),
    )

    r = test_client.get(
        f"/api/agentic/agents/{agent['agent_id']}/profile",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 200
    data = r.json()
    assert data["display_name"] == "My Bot"
    assert data["bio"] == "Hello!"


def test_get_profile_empty(test_client):
    """GET on an agent with no profile returns empty profile."""
    agent = _create_agent(test_client)

    r = test_client.get(
        f"/api/agentic/agents/{agent['agent_id']}/profile",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 200
    data = r.json()
    assert data["agent_id"] == agent["agent_id"]
    assert data["display_name"] is None
    assert data["bio"] is None


def test_get_profile_no_auth(test_client):
    """GET without auth fails."""
    r = test_client.get("/api/agentic/agents/SomeAgent/profile")
    assert r.status_code in (401, 403)


def test_put_profile_all_fields(test_client):
    """All profile fields can be set and read back."""
    agent = _create_agent(test_client)

    payload = {
        "display_name": "Full Profile Bot",
        "bio": "Testing all fields.",
        "location": "Tokyo, Japan",
        "website": "https://example.com",
        "avatar_url": "https://share.clawbits.io/avatar.png",
        "header_url": "https://share.clawbits.io/header.png",
    }
    r = test_client.put(
        f"/api/agentic/agents/{agent['agent_id']}/profile",
        json=payload,
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200
    data = r.json()
    for key, val in payload.items():
        assert data[key] == val, f"{key}: expected {val!r}, got {data[key]!r}"



def test_rename_clears_agent_display_name(test_client):
    """Operator rename wins over the agent's self-set display_name.

    Display resolution prefers profile.display_name over nickname, so the
    rename endpoint clears it — otherwise the rename would be invisible.
    """
    from tests.fastapi._auth_helpers import auth_headers, login_human

    agent = _create_agent(test_client)
    agent_id = agent["agent_id"]

    r = test_client.put(
        f"/api/agentic/agents/{agent_id}/profile",
        json={"display_name": "SelfBrand"},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200, r.text

    info = test_client.get(
        f"/api/agentic/agents/{agent_id}/info",
        headers=_auth(agent["api_key"]),
    ).json()
    org_id = info["org_id"]

    token, _ = login_human(test_client, "stan@clawbits.ai")
    resp = test_client.patch(
        f"/api/human/orgs/{org_id}/agents/{agent_id}/name",
        json={"nickname": "BossName"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 200, resp.text

    agents = test_client.get(
        f"/api/human/orgs/{org_id}/agents", headers=auth_headers(token)
    ).json()["agents"]
    me = next(a for a in agents if a["agent_id"] == agent_id)
    assert me["nickname"] == "BossName"
    assert me["display_name"] in (None, "")
