"""Tests for the agent description feature.

Covers the full agent-side lifecycle (creation default → agent self-update)
and the owner→agent regenerate handshake, plus the human-facing surfaces
(list + single agent) that feed the card and profile page.
"""
from tests.fastapi._auth_helpers import auth_headers, login_human
from tests.fastapi.test_agent_profile import (
    _auth,
    _create_agent,
    _write_headers,
)


def _org_id_for(tc, data: dict) -> str:
    r = tc.get(f"/api/agentic/agents/signup-requests/{data['signup_request_id']}")
    assert r.status_code == 200, r.text
    return r.json()["org_id"]


def test_new_agent_has_default_description(test_client):
    """A brand-new agent ships with a non-empty 'default' placeholder."""
    agent = _create_agent(test_client)

    r = test_client.get(
        f"/api/agentic/agents/{agent['agent_id']}/info", headers=_auth(agent["api_key"])
    )
    assert r.status_code == 200, r.text
    info = r.json()
    assert info["description"], "expected a default description"
    assert info["description_regen_requested"] is False

    r = test_client.get(
        f"/api/agentic/agents/{agent['agent_id']}/profile",
        headers=_auth(agent["api_key"]),
    )
    assert r.json()["description_source"] == "default"


def test_agent_updates_its_description(test_client):
    """Agent self-updates via the dedicated endpoint; stamped as 'auto'."""
    agent = _create_agent(test_client)
    text = "I help teams triage incidents and summarize logs."

    r = test_client.put(
        f"/api/agentic/agents/{agent['agent_id']}/description",
        json={"description": text},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["description"] == text
    assert data["description_source"] == "auto"
    assert data["description_generated_at"]

    # Round-trips through the profile GET, and does NOT clobber the bio.
    test_client.put(
        f"/api/agentic/agents/{agent['agent_id']}/profile",
        json={"bio": "manual bio"},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    test_client.put(
        f"/api/agentic/agents/{agent['agent_id']}/description",
        json={"description": text},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    r = test_client.get(
        f"/api/agentic/agents/{agent['agent_id']}/profile",
        headers=_auth(agent["api_key"]),
    )
    assert r.json()["description"] == text
    assert r.json()["bio"] == "manual bio"  # description update left bio intact


def test_description_over_cap_rejected(test_client):
    """Over-long descriptions are rejected by the 280-char request cap."""
    agent = _create_agent(test_client)
    r = test_client.put(
        f"/api/agentic/agents/{agent['agent_id']}/description",
        json={"description": "x" * 500},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 422


def test_description_update_wrong_agent(test_client):
    """An agent cannot rewrite another agent's description."""
    a1 = _create_agent(test_client)
    a2 = _create_agent(test_client)
    r = test_client.put(
        f"/api/agentic/agents/{a2['agent_id']}/description",
        json={"description": "hijack"},
        headers=_write_headers(test_client, a1["api_key"]),
    )
    assert r.status_code in (401, 403)


def test_owner_regenerate_handshake(test_client):
    """Owner sets the flag; the agent sees it and clears it on next push."""
    agent = _create_agent(test_client)
    org_id = _org_id_for(test_client, agent)
    token, _ = login_human(test_client, "stan@clawbits.ai")

    r = test_client.post(
        f"/api/human/orgs/{org_id}/agents/{agent['agent_id']}/description/regenerate",
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text
    assert r.json()["description_regen_pending"] is True

    # Agent sees the request via /info.
    r = test_client.get(
        f"/api/agentic/agents/{agent['agent_id']}/info", headers=_auth(agent["api_key"])
    )
    assert r.json()["description_regen_requested"] is True

    # Owner's detail view reflects pending + operator.
    r = test_client.get(
        f"/api/human/orgs/{org_id}/agents/{agent['agent_id']}", headers=auth_headers(token)
    )
    assert r.status_code == 200, r.text
    assert r.json()["description_regen_pending"] is True
    assert r.json()["is_operator"] is True

    # Agent pushes a fresh description → flag clears.
    r = test_client.put(
        f"/api/agentic/agents/{agent['agent_id']}/description",
        json={"description": "Now I mostly help with code review."},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    r = test_client.get(
        f"/api/agentic/agents/{agent['agent_id']}/info", headers=_auth(agent["api_key"])
    )
    assert r.json()["description_regen_requested"] is False


def test_list_agents_includes_description(test_client):
    """The owner-facing agents list carries description + pending flag."""
    agent = _create_agent(test_client)
    org_id = _org_id_for(test_client, agent)
    token, _ = login_human(test_client, "stan@clawbits.ai")

    r = test_client.get(
        f"/api/human/orgs/{org_id}/agents", headers=auth_headers(token)
    )
    assert r.status_code == 200, r.text
    mine = [a for a in r.json()["agents"] if a["agent_id"] == agent["agent_id"]]
    assert mine, "agent missing from list"
    assert mine[0]["description"]
    assert mine[0]["description_regen_pending"] is False
