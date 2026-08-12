"""TEMP repro — what does a channel look like after its agent is deleted?"""
import json

from starlette.testclient import TestClient

from clawbits.datastructures.known_answers import get_answer_for_question
from tests.fastapi._auth_helpers import auth_headers as _auth
from tests.fastapi._auth_helpers import register_human as _register
from tests.fastapi._auth_helpers import signup_agent_via_email
from tests.fastapi.approve_helper import _approve_signup
from tests.fastapi.test_human_mattermost import _agent_write_headers


def _create_agent(tc: TestClient, owner_email: str = "stan@clawbits.ai") -> dict:
    r = signup_agent_via_email(tc, owner_email)
    assert r.status_code == 200, r.text
    challenge = r.json()
    answer = get_answer_for_question(challenge["challenge"])
    r = tc.post("/api/agentic/signup-commit", json={
        "session_token": challenge["session_token"],
        "challenge_response": answer,
    })
    assert r.status_code == 200, r.text
    data = r.json()
    _approve_signup(tc, data, owner_email=owner_email)
    return data


def _personal_org(tc: TestClient, token: str) -> str:
    r = tc.get("/api/human/orgs", headers=_auth(token))
    for org in r.json()["organizations"]:
        if org.get("is_personal"):
            return org["org_id"]
    raise AssertionError("no personal org")


def _dump(tc, token, ch_id, label):
    r = tc.get(f"/api/human/mm/channels/{ch_id}/timeline", headers=_auth(token))
    print(f"\n===== {label} timeline ({r.status_code}) =====")
    for row in r.json().get("rows", []):
        if row["kind"] == "event":
            e = row["event"]
            print("EVENT", json.dumps({
                k: e.get(k) for k in (
                    "event_type", "actor_human_id", "actor_agent_id",
                    "actor_display_name", "subject_human_id",
                    "subject_agent_id", "subject_display_name",
                )
            }))
        else:
            p = row["post"]
            print("POST ", json.dumps({
                k: p.get(k) for k in ("post_id", "agent_id", "human_id", "message", "author_display_name")
            }))
    r = tc.get(f"/api/human/mm/channels/{ch_id}/members", headers=_auth(token))
    print("MEMBERS:", r.status_code, [
        (m.get("human_id"), m.get("agent_id"), m.get("display_name"))
        for m in r.json().get("members", [])
    ] if r.status_code == 200 else r.text)


def test_repro_agent_delete(test_client):
    owner = _register(test_client, "stan@clawbits.ai", display_name="Stan")
    other = _register(test_client, "other@test.com", display_name="Other")
    agent = _create_agent(test_client, "stan@clawbits.ai")
    org_id = _personal_org(test_client, owner["access_token"])

    r = test_client.post(
        "/api/human/mm/channels",
        json={"org_id": org_id, "name": "ops", "channel_type": "public"},
        headers=_auth(owner["access_token"]),
    )
    ch_id = r.json()["channel_id"]
    test_client.post(
        f"/api/human/mm/channels/{ch_id}/members",
        json={"member_id": agent["agent_id"], "member_type": "agent"},
        headers=_auth(owner["access_token"]),
    )
    test_client.post(
        f"/api/human/mm/channels/{ch_id}/members",
        json={"member_id": str(other["user"]["id"]), "member_type": "human"},
        headers=_auth(owner["access_token"]),
    )
    test_client.post(
        f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "hello agent"},
        headers=_auth(owner["access_token"]),
    )
    r = test_client.post(
        f"/api/agentic/mm/channels/{ch_id}/posts",
        json={"message": "hi humans"},
        headers=_agent_write_headers(test_client, agent["api_key"]),
    )
    print("agent post:", r.status_code, r.text[:200])

    _dump(test_client, owner["access_token"], ch_id, "BEFORE delete")

    r = test_client.delete(
        f"/api/human/orgs/{org_id}/agents/{agent['agent_id']}",
        headers=_auth(owner["access_token"]),
    )
    print("\nDELETE agent:", r.status_code, r.text[:200])

    _dump(test_client, owner["access_token"], ch_id, "AFTER delete (default)")

    # sidebar view
    r = test_client.get("/api/human/mm/channels", headers=_auth(owner["access_token"]))
    print("\nSIDEBAR:", json.dumps([
        {k: c.get(k) for k in ("channel_id", "name", "last_message_text",
                               "last_message_author_display_name", "unread_count")}
        for c in r.json().get("channels", [])
    ], indent=1))
