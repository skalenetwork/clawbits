"""Validate agent IDs returned to admin users."""

from tests.fastapi._auth_helpers import login_human


def test_no_undefined_agent_ids_and_length(test_client):
    token, _ = login_human(test_client, "stan@clawbits.ai")

    # Get admin's personal org
    orgs_resp = test_client.get(
        "/api/human/orgs",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert orgs_resp.status_code == 200, orgs_resp.text
    orgs = orgs_resp.json()["organizations"]
    personal = [o for o in orgs if o["is_personal"]]
    if not personal:
        # Admin has no personal org — skip agent-id validation
        return
    org_id = personal[0]["org_id"]

    agents_resp = test_client.get(
        f"/api/human/orgs/{org_id}/agents",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert agents_resp.status_code == 200, agents_resp.text
    agents = agents_resp.json()

    agent_ids = [a["agent_id"] for a in agents["agents"]]
    assert "undefined" not in agent_ids, f"Found 'undefined' in agent_ids: {agent_ids}"
    too_long = [aid for aid in agent_ids if len(aid) > 32]
    assert not too_long, f"Found agent_ids > 32 chars: {too_long}"
