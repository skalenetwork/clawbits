"""Tests for Mattermost-style messaging between bots."""
from starlette.testclient import TestClient

from clawbits.datastructures.known_answers import get_answer_for_question

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _create_agent(tc: TestClient) -> dict:
    """Create an agent and return {'agent_id': ..., 'api_key': ...}."""
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

    data["owner_email"] = "stan@clawbits.ai"
    return data


def _grant_agent_contact(
    tc: TestClient,
    target_agent: dict,
    principal_agent: dict,
    *,
    can_dm: bool = False,
    can_tag: bool = False,
) -> None:
    """The target agent's operator grants the principal agent contact.

    Contact is closed by default — without this, the principal can't DM, tag,
    or be added to a channel alongside the target.
    """
    from tests.fastapi._auth_helpers import auth_headers, login_human

    token, _ = login_human(tc, target_agent["owner_email"])
    r = tc.put(
        f"/api/human/agents/{target_agent['agent_id']}/contact-permissions",
        json={
            "principal_type": "agent",
            "principal_id": principal_agent["agent_id"],
            "can_dm": can_dm,
            "can_tag": can_tag,
        },
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text


def _solve(tc: TestClient, api_key: str) -> dict:
    """Get a challenge and return the solved headers."""
    r = tc.get("/api/agentic/auth/challenge", headers={"Authorization": f"Bearer {api_key}"})
    assert r.status_code == 200, r.text
    ch = r.json()
    answer = get_answer_for_question(ch["challenge"])
    return {
    }


def _auth(api_key: str) -> dict:
    return {"Authorization": f"Bearer {api_key}"}


def _write_headers(tc: TestClient, api_key: str) -> dict:
    return {**_auth(api_key), **_solve(tc, api_key)}


def _register_human(tc: TestClient, email: str) -> dict:
    from tests.fastapi._auth_helpers import register_human
    return register_human(tc, email, display_name=email.split("@")[0])


def _create_agent_with_owner(tc: TestClient, owner_email: str) -> dict:
    """Create an agent owned by the given human's personal org."""
    from tests.fastapi._auth_helpers import signup_agent_via_email
    from tests.fastapi.approve_helper import _approve_signup

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

    data["owner_email"] = owner_email
    return data


_human_counter = 0


def _create_owned_agent(tc: TestClient) -> dict:
    """Register a unique human and create an agent owned by that human's org."""
    global _human_counter
    _human_counter += 1
    email = f"mmtest{_human_counter}@test.com"
    _register_human(tc, email)
    return _create_agent_with_owner(tc, email)


# ---------------------------------------------------------------------------
# Tests: Default Channel
# ---------------------------------------------------------------------------

def test_agent_default_channel_exists_on_creation(test_client):
    """A new owned agent gets a default 'agent-{id}' channel with the agent as a member."""
    agent = _create_owned_agent(test_client)

    r = test_client.get(
        f"/api/agentic/mm/teams/{agent['agent_id']}/default-channel",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 200
    channel = r.json()
    assert channel["name"] == f"agent-{agent['agent_id']}"
    assert channel["channel_type"] == "public"
    assert "org_id" in channel

    r = test_client.get(
        f"/api/agentic/mm/channels/{channel['channel_id']}/members",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 200
    members = r.json()["members"]
    assert any(m.get("agent_id") == agent["agent_id"] for m in members)


# ---------------------------------------------------------------------------
# Tests: Channels
# ---------------------------------------------------------------------------

def test_create_and_list_channel(test_client):
    """Agent can create a channel and see it in the listing."""
    agent = _create_owned_agent(test_client)

    # Create channel
    r = test_client.post("/api/agentic/mm/channels",
        json={"name": "project-room", "channel_type": "public"},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200
    ch = r.json()
    assert ch["name"] == "project-room"
    assert ch["channel_type"] == "public"
    channel_id = ch["channel_id"]

    # List channels
    r = test_client.get("/api/agentic/mm/channels", headers=_auth(agent["api_key"]))
    assert r.status_code == 200
    data = r.json()
    assert data["total"] >= 1
    assert any(c["channel_id"] == channel_id for c in data["channels"])
    # Agent-level settings are surfaced on the listing envelope so the polling
    # client can adapt without a separate /info fetch.
    assert data["inter_agent_mode_enabled"] is False


def test_get_channel_info(test_client):
    """Members can get channel info; non-members cannot."""
    a1 = _create_owned_agent(test_client)
    a2 = _create_agent(test_client)

    r = test_client.post("/api/agentic/mm/channels",
        json={"name": "secret", "channel_type": "private"},
        headers=_write_headers(test_client, a1["api_key"]),
    )
    ch_id = r.json()["channel_id"]

    # a1 is a member → ok
    r = test_client.get(f"/api/agentic/mm/channels/{ch_id}", headers=_auth(a1["api_key"]))
    assert r.status_code == 200

    # a2 is NOT a member → 403
    r = test_client.get(f"/api/agentic/mm/channels/{ch_id}", headers=_auth(a2["api_key"]))
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# Tests: Members
# ---------------------------------------------------------------------------

def test_add_and_list_members(test_client):
    """A channel creator can add another agent as a member."""
    a1 = _create_owned_agent(test_client)
    a2 = _create_agent(test_client)
    _grant_agent_contact(test_client, a2, a1, can_tag=True)

    # a1 creates channel
    r = test_client.post("/api/agentic/mm/channels",
        json={"name": "collab", "channel_type": "public"},
        headers=_write_headers(test_client, a1["api_key"]),
    )
    ch_id = r.json()["channel_id"]

    # a1 adds a2
    r = test_client.post(f"/api/agentic/mm/channels/{ch_id}/members",
        json={"agent_id": a2["agent_id"]},
        headers=_write_headers(test_client, a1["api_key"]),
    )
    assert r.status_code == 200
    members = r.json()
    assert members["total"] == 2
    ids = [m["agent_id"] for m in members["members"]]
    assert a1["agent_id"] in ids
    assert a2["agent_id"] in ids

    # a2 can now see the channel
    r = test_client.get(f"/api/agentic/mm/channels/{ch_id}", headers=_auth(a2["api_key"]))
    assert r.status_code == 200


def test_remove_member(test_client):
    """A member can remove another member from a channel."""
    a1 = _create_owned_agent(test_client)
    a2 = _create_agent(test_client)
    _grant_agent_contact(test_client, a2, a1, can_tag=True)

    r = test_client.post("/api/agentic/mm/channels",
        json={"name": "temp", "channel_type": "public"},
        headers=_write_headers(test_client, a1["api_key"]),
    )
    ch_id = r.json()["channel_id"]

    # Add a2
    r = test_client.post(f"/api/agentic/mm/channels/{ch_id}/members",
        json={"agent_id": a2["agent_id"]},
        headers=_write_headers(test_client, a1["api_key"]),
    )
    assert r.status_code == 200, r.text

    # Remove a2
    r = test_client.delete(f"/api/agentic/mm/channels/{ch_id}/members/{a2['agent_id']}",
        headers=_write_headers(test_client, a1["api_key"]),
    )
    assert r.status_code == 200
    assert r.json()["total"] == 1

    # a2 can no longer see the channel
    r = test_client.get(f"/api/agentic/mm/channels/{ch_id}", headers=_auth(a2["api_key"]))
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# Tests: Posts
# ---------------------------------------------------------------------------

def test_post_and_list_messages(test_client):
    """Members can post messages and read them back."""
    a1 = _create_owned_agent(test_client)
    a2 = _create_agent(test_client)
    _grant_agent_contact(test_client, a2, a1, can_tag=True)

    # Create channel & add a2
    r = test_client.post("/api/agentic/mm/channels",
        json={"name": "chat", "channel_type": "public"},
        headers=_write_headers(test_client, a1["api_key"]),
    )
    ch_id = r.json()["channel_id"]
    test_client.post(f"/api/agentic/mm/channels/{ch_id}/members",
        json={"agent_id": a2["agent_id"]},
        headers=_write_headers(test_client, a1["api_key"]),
    )

    # a1 posts
    r = test_client.post(f"/api/agentic/mm/channels/{ch_id}/posts",
        json={"message": "Hello from a1!"},
        headers=_write_headers(test_client, a1["api_key"]),
    )
    assert r.status_code == 200
    post = r.json()
    assert post["message"] == "Hello from a1!"
    assert post["agent_id"] == a1["agent_id"]

    # a2 posts
    r = test_client.post(f"/api/agentic/mm/channels/{ch_id}/posts",
        json={"message": "Hello from a2!"},
        headers=_write_headers(test_client, a2["api_key"]),
    )
    assert r.status_code == 200

    # Both can read
    r = test_client.get(f"/api/agentic/mm/channels/{ch_id}/posts", headers=_auth(a1["api_key"]))
    assert r.status_code == 200
    data = r.json()
    assert data["total"] == 2
    msgs = [p["message"] for p in data["posts"]]
    assert "Hello from a1!" in msgs
    assert "Hello from a2!" in msgs


def test_agent_reply_carries_parent_preview(test_client):
    """Agent reply populates parent_post_id and parent_preview in the response."""
    a1 = _create_owned_agent(test_client)
    a2 = _create_agent(test_client)
    _grant_agent_contact(test_client, a2, a1, can_tag=True)
    r = test_client.post("/api/agentic/mm/channels",
        json={"name": "agent-reply-chat", "channel_type": "public"},
        headers=_write_headers(test_client, a1["api_key"]),
    )
    ch_id = r.json()["channel_id"]
    test_client.post(f"/api/agentic/mm/channels/{ch_id}/members",
        json={"agent_id": a2["agent_id"]},
        headers=_write_headers(test_client, a1["api_key"]),
    )

    parent = test_client.post(
        f"/api/agentic/mm/channels/{ch_id}/posts",
        json={"message": "the original"},
        headers=_write_headers(test_client, a1["api_key"]),
    ).json()

    r = test_client.post(
        f"/api/agentic/mm/channels/{ch_id}/posts",
        json={"message": "agent reply", "parent_post_id": parent["post_id"]},
        headers=_write_headers(test_client, a2["api_key"]),
    )
    assert r.status_code == 200, r.text
    reply = r.json()
    assert reply["parent_post_id"] == parent["post_id"]
    assert reply["parent_preview"]["post_id"] == parent["post_id"]
    assert reply["parent_preview"]["message_excerpt"] == "the original"
    assert reply["parent_preview"]["agent_id"] == a1["agent_id"]


def test_agent_reply_to_missing_parent_rejected(test_client):
    """Replying to a non-existent post_id returns 400 on the agent endpoint."""
    a1 = _create_owned_agent(test_client)
    r = test_client.post("/api/agentic/mm/channels",
        json={"name": "agent-missing-parent", "channel_type": "public"},
        headers=_write_headers(test_client, a1["api_key"]),
    )
    ch_id = r.json()["channel_id"]

    r = test_client.post(
        f"/api/agentic/mm/channels/{ch_id}/posts",
        json={"message": "ghost reply", "parent_post_id": 9_999_999},
        headers=_write_headers(test_client, a1["api_key"]),
    )
    assert r.status_code == 400, r.text


def test_agent_reaction_toggle(test_client):
    """Agent endpoint toggles reactions with identical semantics to humans."""
    a1 = _create_owned_agent(test_client)
    a2 = _create_agent(test_client)
    _grant_agent_contact(test_client, a2, a1, can_tag=True)
    ch_id = test_client.post(
        "/api/agentic/mm/channels",
        json={"name": "agent-reactions", "channel_type": "public"},
        headers=_write_headers(test_client, a1["api_key"]),
    ).json()["channel_id"]
    test_client.post(
        f"/api/agentic/mm/channels/{ch_id}/members",
        json={"agent_id": a2["agent_id"]},
        headers=_write_headers(test_client, a1["api_key"]),
    )

    post = test_client.post(
        f"/api/agentic/mm/channels/{ch_id}/posts",
        json={"message": "react if you agree"},
        headers=_write_headers(test_client, a1["api_key"]),
    ).json()

    # Both agents react with the same emoji.
    for key in (a1["api_key"], a2["api_key"]):
        r = test_client.post(
            f"/api/agentic/mm/posts/{post['post_id']}/reactions",
            json={"emoji": "🎉"},
            headers=_write_headers(test_client, key),
        )
        assert r.status_code == 200, r.text
    final = r.json()
    bucket = next(b for b in final["reactions"] if b["emoji"] == "🎉")
    assert bucket["count"] == 2
    assert sorted(bucket["agent_ids"]) == sorted([a1["agent_id"], a2["agent_id"]])
    assert bucket["human_ids"] == []

    # a2 toggles it off again.
    r2 = test_client.post(
        f"/api/agentic/mm/posts/{post['post_id']}/reactions",
        json={"emoji": "🎉"},
        headers=_write_headers(test_client, a2["api_key"]),
    )
    bucket2 = next(b for b in r2.json()["reactions"] if b["emoji"] == "🎉")
    assert bucket2["count"] == 1
    assert bucket2["agent_ids"] == [a1["agent_id"]]


def test_non_member_cannot_post(test_client):
    """Non-members cannot post to a channel."""
    a1 = _create_owned_agent(test_client)
    a2 = _create_agent(test_client)

    r = test_client.post("/api/agentic/mm/channels",
        json={"name": "private-chat", "channel_type": "private"},
        headers=_write_headers(test_client, a1["api_key"]),
    )
    ch_id = r.json()["channel_id"]

    # a2 tries to post without being a member
    r = test_client.post(f"/api/agentic/mm/channels/{ch_id}/posts",
        json={"message": "sneaky!"},
        headers=_write_headers(test_client, a2["api_key"]),
    )
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# Tests: Direct Messages
# ---------------------------------------------------------------------------

def test_create_dm_channel(test_client):
    """Two agents can open a DM channel."""
    a1 = _create_owned_agent(test_client)
    a2 = _create_agent(test_client)
    _grant_agent_contact(test_client, a2, a1, can_dm=True)

    r = test_client.post("/api/agentic/mm/direct",
        json={"target_agent_id": a2["agent_id"]},
        headers=_write_headers(test_client, a1["api_key"]),
    )
    assert r.status_code == 200
    dm = r.json()
    assert dm["channel_type"] == "direct"
    dm_id = dm["channel_id"]

    # Both are members
    r = test_client.get(f"/api/agentic/mm/channels/{dm_id}/members", headers=_auth(a1["api_key"]))
    assert r.status_code == 200
    ids = [m["agent_id"] for m in r.json()["members"]]
    assert a1["agent_id"] in ids
    assert a2["agent_id"] in ids


def test_dm_deduplication(test_client):
    """Opening a DM twice between the same agents returns the same channel."""
    a1 = _create_owned_agent(test_client)
    a2 = _create_owned_agent(test_client)
    # a1 may open the DM; a2 re-opening the existing one is allowed by the
    # bidirectional access rule even without its own grant.
    _grant_agent_contact(test_client, a2, a1, can_dm=True)

    r1 = test_client.post("/api/agentic/mm/direct",
        json={"target_agent_id": a2["agent_id"]},
        headers=_write_headers(test_client, a1["api_key"]),
    )
    dm1 = r1.json()["channel_id"]

    # a2 opens DM with a1 → should find the same channel
    r2 = test_client.post("/api/agentic/mm/direct",
        json={"target_agent_id": a1["agent_id"]},
        headers=_write_headers(test_client, a2["api_key"]),
    )
    dm2 = r2.json()["channel_id"]

    assert dm1 == dm2


def test_dm_with_self_rejected(test_client):
    """Cannot create a DM with yourself."""
    agent = _create_agent(test_client)
    r = test_client.post("/api/agentic/mm/direct",
        json={"target_agent_id": agent["agent_id"]},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 400


def test_dm_messaging(test_client):
    """Agents can exchange messages over a DM channel."""
    a1 = _create_owned_agent(test_client)
    a2 = _create_agent(test_client)
    _grant_agent_contact(test_client, a2, a1, can_dm=True)

    # Open DM
    r = test_client.post("/api/agentic/mm/direct",
        json={"target_agent_id": a2["agent_id"]},
        headers=_write_headers(test_client, a1["api_key"]),
    )
    dm_id = r.json()["channel_id"]

    # a1 sends
    test_client.post(f"/api/agentic/mm/channels/{dm_id}/posts",
        json={"message": "Hey there!"},
        headers=_write_headers(test_client, a1["api_key"]),
    )

    # a2 sends
    test_client.post(f"/api/agentic/mm/channels/{dm_id}/posts",
        json={"message": "Hello back!"},
        headers=_write_headers(test_client, a2["api_key"]),
    )

    # a2 reads
    r = test_client.get(f"/api/agentic/mm/channels/{dm_id}/posts", headers=_auth(a2["api_key"]))
    assert r.status_code == 200
    msgs = [p["message"] for p in r.json()["posts"]]
    assert "Hey there!" in msgs
    assert "Hello back!" in msgs


