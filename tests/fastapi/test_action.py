"""Tests for Agent Action Registry endpoints."""
from sqlmodel import Session
from starlette.testclient import TestClient

from clawbits.datastructures.known_answers import get_answer_for_question
from clawbits.db.models import Agent

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

    mint_resp = tc.post(
        "/api/agentic/auth/challenge_response",
        headers={
            "Authorization": f"Bearer {data['api_key']}",
        },
        json={
            "session_token": mint_payload["session_token"],
            "challenge_response": mint_answer,
        },
    )
    assert mint_resp.status_code == 200, mint_resp.text

    return data


def _auth(api_key: str) -> dict:
    return {"Authorization": f"Bearer {api_key}"}


def _write_headers(tc: TestClient, api_key: str) -> dict:
    r = tc.get("/api/agentic/auth/challenge", headers=_auth(api_key))
    assert r.status_code == 200, r.text
    ch = r.json()
    answer = get_answer_for_question(ch["challenge"])
    return _auth(api_key)


def _register_human(tc: TestClient, email: str) -> dict:
    from tests.fastapi._auth_helpers import register_human
    return register_human(tc, email, display_name=email.split("@")[0])


def _get_personal_org_id(tc: TestClient, token: str) -> str:
    r = tc.get("/api/human/orgs", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200, r.text
    orgs = r.json()["organizations"]
    personal = [o for o in orgs if o["is_personal"]]
    assert personal, "No personal org found"
    return personal[0]["org_id"]


def _assign_agent_to_org(tc: TestClient, agent_id: str, org_id: str):
    """Bind an agent to an org directly via the server DB. Test fixture only."""
    server = tc.app
    with Session(server._engine) as s:
        agent = s.get(Agent, agent_id)
        if agent is not None:
            agent.org_id = org_id
            s.commit()


# ---------------------------------------------------------------------------
# Tests: PUT action
# ---------------------------------------------------------------------------

def test_put_action(test_client):
    """Agent can set its action document."""
    agent = _create_agent(test_client)
    md = "# My Agent\n\nI am a helpful coding bot."

    r = test_client.put(
        f"/api/agentic/agents/{agent['agent_id']}/actions",
        json={"action_id": "default", "action_md": md},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["agent_id"] == agent["agent_id"]
    assert data["action_id"] == "default"
    assert data["action_md"] == md
    assert "updated_at" in data


def test_put_action_overwrites(test_client):
    """Setting action again overwrites the previous one."""
    agent = _create_agent(test_client)

    test_client.put(
        f"/api/agentic/agents/{agent['agent_id']}/actions",
        json={"action_id": "default", "action_md": "# Version 1"},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    r = test_client.put(
        f"/api/agentic/agents/{agent['agent_id']}/actions",
        json={"action_id": "default", "action_md": "# Version 2"},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200
    assert r.json()["action_md"] == "# Version 2"


def test_put_action_requires_auth(test_client):
    """PUT without Authorization header fails."""
    r = test_client.put(
        "/api/agentic/agents/SomeAgent/actions",
        json={"action_id": "default", "action_md": "# Test"},
    )
    assert r.status_code in (401, 403)


def test_put_action_wrong_agent(test_client):
    """Agent cannot set action for another agent."""
    a1 = _create_agent(test_client)
    a2 = _create_agent(test_client)

    r = test_client.put(
        f"/api/agentic/agents/{a1['agent_id']}/actions",
        json={"action_id": "default", "action_md": "# Hacked"},
        headers=_write_headers(test_client, a2["api_key"]),
    )
    assert r.status_code in (401, 403)


# ---------------------------------------------------------------------------
# Tests: GET action
# ---------------------------------------------------------------------------

def test_get_action(test_client):
    """Agent can read its own action."""
    agent = _create_agent(test_client)
    md = "# Hello World"

    test_client.put(
        f"/api/agentic/agents/{agent['agent_id']}/actions",
        json={"action_id": "default", "action_md": md},
        headers=_write_headers(test_client, agent["api_key"]),
    )

    r = test_client.get(
        f"/api/agentic/agents/{agent['agent_id']}/actions/default",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 200
    assert r.json()["action_md"] == md


def test_get_action_not_found(test_client):
    """Reading action for agent with no action returns 404."""
    agent = _create_agent(test_client)
    r = test_client.get(
        f"/api/agentic/agents/{agent['agent_id']}/actions/default",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 404


def test_get_action_no_auth(test_client):
    """GET without auth fails."""
    agent = _create_agent(test_client)
    r = test_client.get(f"/api/agentic/agents/{agent['agent_id']}/actions/default")
    assert r.status_code == 401


# ---------------------------------------------------------------------------
# Tests: DELETE action
# ---------------------------------------------------------------------------

def test_delete_action(test_client):
    """Agent can delete its action."""
    agent = _create_agent(test_client)
    test_client.put(
        f"/api/agentic/agents/{agent['agent_id']}/actions",
        json={"action_id": "default", "action_md": "# Temp"},
        headers=_write_headers(test_client, agent["api_key"]),
    )

    r = test_client.delete(
        f"/api/agentic/agents/{agent['agent_id']}/actions/default",
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200

    # Confirm it's gone
    r = test_client.get(
        f"/api/agentic/agents/{agent['agent_id']}/actions/default",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 404


def test_delete_action_not_found(test_client):
    """Deleting non-existent action returns 404."""
    agent = _create_agent(test_client)
    r = test_client.delete(
        f"/api/agentic/agents/{agent['agent_id']}/actions/nonexistent",
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Tests: List actions
# ---------------------------------------------------------------------------

def test_list_actions(test_client):
    """List shows all agents with action documents."""
    a1 = _create_agent(test_client)
    a2 = _create_agent(test_client)

    test_client.put(
        f"/api/agentic/agents/{a1['agent_id']}/actions",
        json={"action_id": "default", "action_md": "# Agent 1"},
        headers=_write_headers(test_client, a1["api_key"]),
    )
    test_client.put(
        f"/api/agentic/agents/{a2['agent_id']}/actions",
        json={"action_id": "default", "action_md": "# Agent 2"},
        headers=_write_headers(test_client, a2["api_key"]),
    )

    r = test_client.get(
        "/api/agentic/actions",
        headers=_auth(a1["api_key"]),
    )
    assert r.status_code == 200
    data = r.json()
    assert data["total"] == 2
    ids = [p["agent_id"] for p in data["actions"]]
    assert a1["agent_id"] in ids
    assert a2["agent_id"] in ids


def test_list_actions_empty(test_client):
    """List returns empty when no actions exist."""
    agent = _create_agent(test_client)
    r = test_client.get(
        "/api/agentic/actions",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 200
    assert r.json()["total"] == 0


# ---------------------------------------------------------------------------
# Tests: Human endpoints
# ---------------------------------------------------------------------------

def test_human_get_action(test_client):
    """Human can read an agent's action via org-scoped endpoint."""
    human = _register_human(test_client, "persona@test.com")
    agent = _create_agent(test_client)
    org_id = _get_personal_org_id(test_client, human["access_token"])
    _assign_agent_to_org(test_client, agent["agent_id"], org_id)

    test_client.put(
        f"/api/agentic/agents/{agent['agent_id']}/actions",
        json={"action_id": "default", "action_md": "# My Bot"},
        headers=_write_headers(test_client, agent["api_key"]),
    )

    r = test_client.get(
        f"/api/human/orgs/{org_id}/agents/{agent['agent_id']}/actions/default",
        headers={"Authorization": f"Bearer {human['access_token']}"},
    )
    assert r.status_code == 200
    assert r.json()["action_md"] == "# My Bot"


def test_human_list_actions(test_client):
    """Human can list all action documents."""
    human = _register_human(test_client, "lister@test.com")
    agent = _create_agent(test_client)

    test_client.put(
        f"/api/agentic/agents/{agent['agent_id']}/actions",
        json={"action_id": "default", "action_md": "# Listed"},
        headers=_write_headers(test_client, agent["api_key"]),
    )

    r = test_client.get(
        "/api/human/actions",
        headers={"Authorization": f"Bearer {human['access_token']}"},
    )
    assert r.status_code == 200
    assert r.json()["total"] >= 1


def test_put_action_requires_cb_tokens(test_client):
    """Agentic write calls should fail when the caller has no CB_TOKENS."""
    agent = _create_agent(test_client)

    app = test_client.app
    with Session(app._engine) as s:
        row = s.get(Agent, agent["agent_id"])
        row.cb_tokens = 0
        s.commit()

    r = test_client.put(
        f"/api/agentic/agents/{agent['agent_id']}/actions",
        json={"action_id": "default", "action_md": "# billed"},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 402, r.text
    assert "Insufficient CB_TOKENS" in r.text


