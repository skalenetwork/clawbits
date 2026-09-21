"""Named 1:1 agent chats (`agent_chat`), beside the unique inbox DM."""

from clawbits.datastructures.mm_models import heuristic_chat_title
from tests.fastapi.test_agent_contact_permissions import _add_org_member, _grant
from tests.fastapi.test_human_mattermost import (
    _bearer,
    _create_agent,
    _get_personal_org_id,
    _open_dm,
    _post,
    _register_human,
)


def _create_chat(tc, token, org_id, agent_id):
    r = tc.post(
        "/api/human/mm/agent-chats",
        json={"org_id": org_id, "agent_id": agent_id},
        headers=_bearer(token),
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_heuristic_chat_title():
    assert heuristic_chat_title("Fix the auth timeout") == "Fix the auth timeout"
    # The greeting and the ask-wrapper are scaffolding; the ask is the title.
    assert heuristic_chat_title("@atlas hey, can you check the deploy logs?") == "check the deploy logs"
    assert (
        heuristic_chat_title("please update the openclaw version on staging")
        == "update the openclaw version on staging"
    )
    # Cut on a word boundary, then drop the word left reaching for the next one.
    assert (
        heuristic_chat_title("update the deploy pipeline so that it stops responding")
        == "update the deploy pipeline so"
    )
    # Markdown scaffolding is not the message: bullets go, fences are stepped over.
    assert heuristic_chat_title("- fix the CI matrix") == "fix the CI matrix"
    assert heuristic_chat_title("```python\nprint(1)\n```") == "print(1)"
    # Only a word cut through keeps an ellipsis.
    assert heuristic_chat_title("a" * 60) == "a" * 40 + "…"
    assert heuristic_chat_title("  \n  ") is None


def test_named_chats_are_extra_rooms_beside_inbox(test_client):
    h = _register_human(test_client, "chats@clawbits.ai", display_name="Ada")
    agent = _create_agent(test_client, owner_email="chats@clawbits.ai")
    org_id = _get_personal_org_id(test_client, h["access_token"])
    inbox = _open_dm(test_client, h["access_token"], org_id, agent["agent_id"], "agent")
    a = _create_chat(test_client, h["access_token"], org_id, agent["agent_id"])
    b = _create_chat(test_client, h["access_token"], org_id, agent["agent_id"])
    again = _open_dm(test_client, h["access_token"], org_id, agent["agent_id"], "agent")
    assert inbox["channel_id"] == again["channel_id"]
    assert a["channel_id"] != b["channel_id"]
    assert inbox["channel_id"] not in {a["channel_id"], b["channel_id"]}
    assert a["channel_type"] == "agent_chat"
    assert a["display_name"] == "New chat"
    assert a["dm_peer_agent_id"] == agent["agent_id"]


def test_autotitle_then_user_rename_locks(test_client):
    h = _register_human(test_client, "title@clawbits.ai")
    agent = _create_agent(test_client, owner_email="title@clawbits.ai")
    token = h["access_token"]
    org_id = _get_personal_org_id(test_client, token)
    chat = _create_chat(test_client, token, org_id, agent["agent_id"])
    _post(test_client, token, chat["channel_id"], "Fix the auth timeout")
    titled = test_client.get(
        f"/api/human/mm/channels/{chat['channel_id']}", headers=_bearer(token)
    ).json()
    assert titled["display_name"] == "Fix the auth timeout"
    _post(test_client, token, chat["channel_id"], "and also logs")
    still = test_client.get(
        f"/api/human/mm/channels/{chat['channel_id']}", headers=_bearer(token)
    ).json()
    assert still["display_name"] == "Fix the auth timeout"
    renamed = test_client.patch(
        f"/api/human/mm/channels/{chat['channel_id']}",
        json={"display_name": "Auth"},
        headers=_bearer(token),
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["display_name"] == "Auth"
    _post(test_client, token, chat["channel_id"], "third")
    locked = test_client.get(
        f"/api/human/mm/channels/{chat['channel_id']}", headers=_bearer(token)
    ).json()
    assert locked["display_name"] == "Auth"


def test_can_dm_required_and_hides_named_chat(test_client):
    owner = _register_human(test_client, "own-chat@test.com")
    agent = _create_agent(test_client, owner_email="own-chat@test.com")
    other = _register_human(test_client, "other-chat@test.com")
    org_id = _get_personal_org_id(test_client, owner["access_token"])
    _add_org_member(test_client, owner["access_token"], org_id, "other-chat@test.com")
    denied = test_client.post(
        "/api/human/mm/agent-chats",
        json={"org_id": org_id, "agent_id": agent["agent_id"]},
        headers=_bearer(other["access_token"]),
    )
    assert denied.status_code == 403
    _grant(
        test_client,
        owner["access_token"],
        agent["agent_id"],
        "human",
        other["user"]["id"],
        can_dm=True,
    )
    chat = _create_chat(test_client, other["access_token"], org_id, agent["agent_id"])
    listed = test_client.get(
        f"/api/human/mm/channels?org_id={org_id}", headers=_bearer(other["access_token"])
    ).json()["channels"]
    assert any(c["channel_id"] == chat["channel_id"] for c in listed)
    _grant(
        test_client,
        owner["access_token"],
        agent["agent_id"],
        "human",
        other["user"]["id"],
        can_dm=False,
    )
    hidden = test_client.get(
        f"/api/human/mm/channels?org_id={org_id}", headers=_bearer(other["access_token"])
    ).json()["channels"]
    assert all(c["channel_id"] != chat["channel_id"] for c in hidden)


def test_cannot_add_members_or_rename_inbox(test_client):
    h = _register_human(test_client, "lock@clawbits.ai")
    agent = _create_agent(test_client, owner_email="lock@clawbits.ai")
    token = h["access_token"]
    org_id = _get_personal_org_id(test_client, token)
    inbox = _open_dm(test_client, token, org_id, agent["agent_id"], "agent")
    chat = _create_chat(test_client, token, org_id, agent["agent_id"])
    add = test_client.post(
        f"/api/human/mm/channels/{chat['channel_id']}/members",
        json={"member_id": "nope", "member_type": "human"},
        headers=_bearer(token),
    )
    assert add.status_code == 400
    inbox_rename = test_client.patch(
        f"/api/human/mm/channels/{inbox['channel_id']}",
        json={"display_name": "Nope"},
        headers=_bearer(token),
    )
    assert inbox_rename.status_code == 400
