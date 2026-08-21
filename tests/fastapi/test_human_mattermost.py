"""Tests for Human user Mattermost-style messaging endpoints."""
from starlette.testclient import TestClient

from clawbits.datastructures.known_answers import get_answer_for_question

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _register_human(tc: TestClient, email: str, display_name: str | None = None) -> dict:
    """Magic-auth log in (auto-creates the user). Returns ``{access_token, user}``."""
    from tests.fastapi._auth_helpers import register_human
    return register_human(tc, email, display_name=display_name)


def _get_personal_org_id(tc: TestClient, token: str) -> str:
    """Get the personal org_id for the authenticated human."""
    r = tc.get("/api/human/orgs", headers=_human_auth(token))
    assert r.status_code == 200, r.text
    orgs = r.json()["organizations"]
    for org in orgs:
        if org.get("is_personal"):
            return org["org_id"]
    raise AssertionError("No personal org found")


def _add_human_to_org(tc: TestClient, owner_token: str, email: str) -> None:
    """Put an already-registered human into the owner's personal org.

    Channel membership is org-scoped — ``add_member`` refuses a target who
    isn't in the channel's org — and every login gets its *own* personal org,
    so a second human has to join the channel owner's org first."""
    from tests.fastapi._auth_helpers import add_human_to_org
    add_human_to_org(tc, owner_token, _get_personal_org_id(tc, owner_token), email)


def _create_channel(tc: TestClient, token: str, name: str, channel_type: str = "public") -> dict:
    """Create a channel in the user's personal org."""
    org_id = _get_personal_org_id(tc, token)
    r = tc.post("/api/human/mm/channels",
        json={"org_id": org_id, "name": name, "channel_type": channel_type},
        headers=_human_auth(token),
    )
    assert r.status_code == 200, r.text
    return r.json()


def _human_auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _create_agent(tc: TestClient, owner_email: str = "stan@clawbits.ai") -> dict:
    """Create an agent and return {'agent_id': ..., 'api_key': ...}."""
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

    return data


def _read_pointer(tc: TestClient, channel_id: str, human_id: int) -> int | None:
    """Read ``human_channel_state.last_read_post_id`` straight from the DB.

    The pointer isn't on the channels-list payload (it's exposed per member
    on the members endpoint), so read-state assertions go to the source."""
    from sqlmodel import Session, select

    from clawbits.db.models import HumanChannelState

    with Session(tc.app._engine) as db:
        row = db.exec(
            select(HumanChannelState)
            .where(HumanChannelState.channel_id == channel_id)
            .where(HumanChannelState.human_id == human_id)
        ).first()
    return row.last_read_post_id if row else None


def _agent_auth(api_key: str) -> dict:
    return {"Authorization": f"Bearer {api_key}"}


def _agent_write_headers(tc: TestClient, api_key: str) -> dict:
    r = tc.get("/api/agentic/auth/challenge", headers=_agent_auth(api_key))
    assert r.status_code == 200, r.text
    ch = r.json()
    answer = get_answer_for_question(ch["challenge"])
    return _agent_auth(api_key)



# ---------------------------------------------------------------------------
# Tests: Human Channel CRUD
# ---------------------------------------------------------------------------

def test_human_create_and_list_channel(test_client):
    """Human can create a channel and see it in listing."""
    reg = _register_human(test_client, "bob@test.com", display_name="Bob")
    headers = _human_auth(reg["access_token"])

    # Create channel
    ch = _create_channel(test_client, reg["access_token"], "general", "public")
    assert ch["name"] == "general"
    assert ch["channel_type"] == "public"
    channel_id = ch["channel_id"]

    # List channels
    r = test_client.get("/api/human/mm/channels", headers=headers)
    assert r.status_code == 200
    data = r.json()
    assert data["total"] >= 1
    assert any(c["channel_id"] == channel_id for c in data["channels"])


def test_human_get_channel_info(test_client):
    """Members can get channel info; non-members cannot."""
    h1 = _register_human(test_client, "h1@test.com")
    h2 = _register_human(test_client, "h2@test.com")

    ch_id = _create_channel(test_client, h1["access_token"], "secret", "private")["channel_id"]

    # h1 is a member → ok
    r = test_client.get(f"/api/human/mm/channels/{ch_id}", headers=_human_auth(h1["access_token"]))
    assert r.status_code == 200

    # h2 is NOT a member → 403
    r = test_client.get(f"/api/human/mm/channels/{ch_id}", headers=_human_auth(h2["access_token"]))
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# Tests: Human adds agent and human members
# ---------------------------------------------------------------------------

def test_human_adds_agent_member(test_client):
    """Human can add an agent as a member of a channel."""
    h1 = _register_human(test_client, "owner@test.com", display_name="Owner")
    # h1 operates the agent, so it may add it (contact is closed by default).
    agent = _create_agent(test_client, owner_email="owner@test.com")

    # Create channel
    ch_id = _create_channel(test_client, h1["access_token"], "mixed", "public")["channel_id"]

    # Add agent
    r = test_client.post(f"/api/human/mm/channels/{ch_id}/members",
        json={"member_id": agent["agent_id"], "member_type": "agent"},
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 200
    members = r.json()
    assert members["total"] == 2
    agent_ids = [m["agent_id"] for m in members["members"] if m.get("agent_id")]
    human_ids = [m["human_id"] for m in members["members"] if m.get("human_id")]
    assert agent["agent_id"] in agent_ids
    assert h1["user"]["id"] in human_ids


def test_trace_id_round_trips_human_to_agent_and_back(test_client):
    """End-to-end trace backbone.

    A human send's ``trace_id`` is persisted, surfaced to the agent on the
    agentic GET (the server→plugin hop the poller reads), and re-stamped by the
    agent onto its reply so the same id comes back on the human read. This is
    the correlation key the cross-subsystem latency tracer stitches every span
    on — without it the plugin ``agent_turn`` / ``pickup_lag`` spans can't be
    tied back to the originating message. Also asserts the field is optional
    (untraced sends stay ``None``) so non-tracing clients are unaffected.
    """
    h1 = _register_human(test_client, "tracer@test.com", display_name="Tracer")
    # h1 operates the agent so it can add it and the agent can reply.
    agent = _create_agent(test_client, owner_email="tracer@test.com")
    ch_id = _create_channel(test_client, h1["access_token"], "trace-room", "public")["channel_id"]

    # Agent joins so it can read the channel and reply.
    r = test_client.post(
        f"/api/human/mm/channels/{ch_id}/members",
        json={"member_id": agent["agent_id"], "member_type": "agent"},
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 200, r.text

    trace_id = "tr_test_roundtrip_0001"

    # 1) Human send carries the trace id; the create response echoes it.
    r = test_client.post(
        f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "hello there", "trace_id": trace_id},
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 200, r.text
    assert r.json()["trace_id"] == trace_id

    # 2) Server→agent hop: the agentic GET surfaces the *persisted* trace id,
    #    so the plugin poller can read it off the inbound post.
    r = test_client.get(
        f"/api/agentic/mm/channels/{ch_id}/posts",
        headers=_agent_auth(agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    inbound = r.json()["posts"]
    assert any(p.get("trace_id") == trace_id for p in inbound), inbound

    # 3) Agent re-stamps the same id onto its reply.
    r = test_client.post(
        f"/api/agentic/mm/channels/{ch_id}/posts",
        json={"message": "hi back", "trace_id": trace_id},
        headers=_agent_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    assert r.json()["trace_id"] == trace_id

    # 4) Close the loop: the human read sees the reply under the same id.
    r = test_client.get(
        f"/api/human/mm/channels/{ch_id}/posts",
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 200, r.text
    reply = next(p for p in r.json()["posts"] if p["message"] == "hi back")
    assert reply["trace_id"] == trace_id

    # 5) Untraced sends stay null — the field is optional end to end.
    r = test_client.post(
        f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "no trace here"},
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 200, r.text
    assert r.json()["trace_id"] is None


def test_human_adds_human_member(test_client):
    """Human can add another human as a member."""
    h1 = _register_human(test_client, "admin@test.com")
    h2 = _register_human(test_client, "user@test.com")
    _add_human_to_org(test_client, h1["access_token"], "user@test.com")

    ch_id = _create_channel(test_client, h1["access_token"], "team-chat", "public")["channel_id"]

    # Add h2
    r = test_client.post(f"/api/human/mm/channels/{ch_id}/members",
        json={"member_id": str(h2["user"]["id"]), "member_type": "human"},
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 200
    assert r.json()["total"] == 2

    # h2 can now see the channel
    r = test_client.get(f"/api/human/mm/channels/{ch_id}", headers=_human_auth(h2["access_token"]))
    assert r.status_code == 200


def test_human_remove_member(test_client):
    """A human member can remove another member."""
    h1 = _register_human(test_client, "rem1@test.com")
    h2 = _register_human(test_client, "rem2@test.com")
    _add_human_to_org(test_client, h1["access_token"], "rem2@test.com")

    ch_id = _create_channel(test_client, h1["access_token"], "temp", "public")["channel_id"]

    # Add h2
    test_client.post(f"/api/human/mm/channels/{ch_id}/members",
        json={"member_id": str(h2["user"]["id"]), "member_type": "human"},
        headers=_human_auth(h1["access_token"]),
    )

    # Remove h2
    r = test_client.delete(
        f"/api/human/mm/channels/{ch_id}/members/{h2['user']['id']}?member_type=human",
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 200
    assert r.json()["total"] == 1

    # h2 can no longer see the channel
    r = test_client.get(f"/api/human/mm/channels/{ch_id}", headers=_human_auth(h2["access_token"]))
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# Tests: "mentioned" indicator (unread_mention_count)
# ---------------------------------------------------------------------------

def test_unread_mention_count_tracks_handle_and_here(test_client):
    """The channel-list endpoint reports ``unread_mention_count`` for unread
    posts that address the viewer — directly (``@<handle>``) or channel-wide
    (``@here``). It is a subset of ``unread_count`` (which drives the sidebar
    "mentioned" badge), excludes the viewer's own posts, respects a token
    boundary (``@herring`` is not ``@here``), and clears on read."""
    h1 = _register_human(test_client, "stanmention@test.com", display_name="Stan Lee")
    h2 = _register_human(test_client, "peermention@test.com")
    _add_human_to_org(test_client, h1["access_token"], "peermention@test.com")
    ch_id = _create_channel(test_client, h1["access_token"], "mentions", "public")["channel_id"]

    # Add h2 so they can post into the channel.
    r = test_client.post(
        f"/api/human/mm/channels/{ch_id}/members",
        json={"member_id": str(h2["user"]["id"]), "member_type": "human"},
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 200, r.text

    # h2 posts: two that address h1 (canonical handle + channel-wide @here),
    # one untagged, and a boundary case that must NOT count as @here.
    for msg in (
        "hey @Stan-Lee can you review",   # handle -> mentions h1
        "@here standup in 5",             # channel-wide -> mentions h1
        "just a normal update, nothing tagged",
        "ping @herring (not me)",         # boundary: @here must not match
    ):
        r = test_client.post(
            f"/api/human/mm/channels/{ch_id}/posts",
            json={"message": msg},
            headers=_human_auth(h2["access_token"]),
        )
        assert r.status_code == 200, r.text

    def _channel_for(token: str) -> dict:
        resp = test_client.get("/api/human/mm/channels", headers=_human_auth(token))
        assert resp.status_code == 200, resp.text
        return next(c for c in resp.json()["channels"] if c["channel_id"] == ch_id)

    # h1: all four of h2's posts are unread; two of them are mentions.
    ch = _channel_for(h1["access_token"])
    assert ch["unread_count"] == 4
    assert ch["unread_mention_count"] == 2

    # h2 is never mentioned by their own posts.
    ch2 = _channel_for(h2["access_token"])
    assert ch2["unread_count"] == 0
    assert ch2["unread_mention_count"] == 0

    # Reading the channel clears both counters.
    r = test_client.post(
        f"/api/human/mm/channels/{ch_id}/read",
        json={"post_id": 10_000_000},
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 200, r.text
    ch = _channel_for(h1["access_token"])
    assert ch["unread_count"] == 0
    assert ch["unread_mention_count"] == 0


# ---------------------------------------------------------------------------
# Tests: Human posts messages
# ---------------------------------------------------------------------------

def test_human_usage_command_replies_with_agent_balance_in_dm(test_client):
    """A human typing `/cb-usage` in a DM with an agent gets its CB_TOKENS as a reply."""
    agent = _create_agent(test_client)
    # The agent's owner shares an org with the agent — DMs are scoped to that org.
    h1 = _register_human(test_client, "stan@clawbits.ai", display_name="Stan")
    org_id = _get_personal_org_id(test_client, h1["access_token"])
    dm = test_client.post("/api/human/mm/direct",
        json={"org_id": org_id, "target_id": agent["agent_id"], "target_type": "agent"},
        headers=_human_auth(h1["access_token"]),
    ).json()
    assert dm["channel_type"] == "direct"
    ch_id = dm["channel_id"]

    # The human's `/cb-usage` post comes back as their own post (normal contract).
    r = test_client.post(f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "/cb-usage"},
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 200, r.text
    assert r.json()["message"] == "/cb-usage"
    assert r.json()["human_id"] == h1["user"]["id"]

    # The agent's balance reply is stored, threaded under the `/cb-usage` post.
    r = test_client.get(f"/api/human/mm/channels/{ch_id}/posts", headers=_human_auth(h1["access_token"]))
    assert r.status_code == 200
    posts = r.json()["posts"]
    by_msg = {p["message"]: p for p in posts}
    assert "/cb-usage" in by_msg
    reply = next(p for p in posts if p["message"].startswith("CB_TOKENS remaining:"))
    assert reply["agent_id"] == agent["agent_id"]
    assert reply["human_id"] is None
    assert reply["parent_post_id"] == by_msg["/cb-usage"]["post_id"]


def test_human_usage_command_is_plain_message_outside_dm(test_client):
    """`/cb-usage` is DM-only: in a non-direct channel it's stored as a normal message."""
    h1 = _register_human(test_client, "usage-room@test.com", display_name="Asker")
    agent = _create_agent(test_client, owner_email="usage-room@test.com")
    # Public channel with the agent present — still must NOT trigger a balance reply.
    ch_id = _create_channel(test_client, h1["access_token"], "usage-room", "public")["channel_id"]
    r = test_client.post(f"/api/human/mm/channels/{ch_id}/members",
        json={"member_id": agent["agent_id"], "member_type": "agent"},
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 200, r.text

    r = test_client.post(f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "/cb-usage"},
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 200, r.text

    r = test_client.get(f"/api/human/mm/channels/{ch_id}/posts", headers=_human_auth(h1["access_token"]))
    assert r.status_code == 200
    msgs = [p["message"] for p in r.json()["posts"]]
    assert msgs == ["/cb-usage"]
    assert not any(m.startswith("CB_TOKENS remaining:") for m in msgs)


def test_human_post_and_list_messages(test_client):
    """Human can post messages and read them back."""
    h1 = _register_human(test_client, "poster1@test.com", display_name="Poster1")
    h2 = _register_human(test_client, "poster2@test.com", display_name="Poster2")
    _add_human_to_org(test_client, h1["access_token"], "poster2@test.com")

    # Create channel & add h2
    ch_id = _create_channel(test_client, h1["access_token"], "chat", "public")["channel_id"]
    test_client.post(f"/api/human/mm/channels/{ch_id}/members",
        json={"member_id": str(h2["user"]["id"]), "member_type": "human"},
        headers=_human_auth(h1["access_token"]),
    )

    # h1 posts
    r = test_client.post(f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "Hello from h1!"},
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 200
    post = r.json()
    assert post["message"] == "Hello from h1!"
    assert post["human_id"] == h1["user"]["id"]

    # h2 posts
    r = test_client.post(f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "Hello from h2!"},
        headers=_human_auth(h2["access_token"]),
    )
    assert r.status_code == 200

    # Both can read
    r = test_client.get(f"/api/human/mm/channels/{ch_id}/posts", headers=_human_auth(h1["access_token"]))
    assert r.status_code == 200
    data = r.json()
    assert data["total"] == 2
    msgs = [p["message"] for p in data["posts"]]
    assert "Hello from h1!" in msgs
    assert "Hello from h2!" in msgs


def test_human_reply_to_own_post(test_client):
    """Replying to a post populates parent_post_id and parent_preview."""
    h1 = _register_human(test_client, "replier@test.com", display_name="Replier")
    ch_id = _create_channel(test_client, h1["access_token"], "reply-chat")["channel_id"]

    parent = test_client.post(
        f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "the original"},
        headers=_human_auth(h1["access_token"]),
    ).json()

    r = test_client.post(
        f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "first reply", "parent_post_id": parent["post_id"]},
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 200, r.text
    reply = r.json()
    assert reply["parent_post_id"] == parent["post_id"]
    preview = reply["parent_preview"]
    assert preview["post_id"] == parent["post_id"]
    assert preview["message_excerpt"] == "the original"
    assert preview["status"] == "published"
    assert preview["human_id"] == h1["user"]["id"]
    assert preview["poster_display_name"] == "Replier"

    listed = test_client.get(
        f"/api/human/mm/channels/{ch_id}/posts",
        headers=_human_auth(h1["access_token"]),
    ).json()
    reply_row = next(p for p in listed["posts"] if p["post_id"] == reply["post_id"])
    assert reply_row["parent_post_id"] == parent["post_id"]
    assert reply_row["parent_preview"]["message_excerpt"] == "the original"


def test_human_reply_to_missing_parent_rejected(test_client):
    """Replying to a non-existent post_id returns 400."""
    h1 = _register_human(test_client, "missing@test.com")
    ch_id = _create_channel(test_client, h1["access_token"], "missing-chat")["channel_id"]

    r = test_client.post(
        f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "ghost reply", "parent_post_id": 9_999_999},
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 400, r.text


def test_human_reply_across_channels_rejected(test_client):
    """Parent must live in the same channel as the reply."""
    h1 = _register_human(test_client, "cross@test.com")
    ch_a = _create_channel(test_client, h1["access_token"], "ch-a")["channel_id"]
    ch_b = _create_channel(test_client, h1["access_token"], "ch-b")["channel_id"]

    parent = test_client.post(
        f"/api/human/mm/channels/{ch_a}/posts",
        json={"message": "in A"},
        headers=_human_auth(h1["access_token"]),
    ).json()

    r = test_client.post(
        f"/api/human/mm/channels/{ch_b}/posts",
        json={"message": "from B replying to A", "parent_post_id": parent["post_id"]},
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 400, r.text


def test_human_reply_excerpt_truncated_for_long_parent(test_client):
    """parent_preview.message_excerpt is truncated server-side so SSE/REST stays bounded."""
    h1 = _register_human(test_client, "long@test.com")
    ch_id = _create_channel(test_client, h1["access_token"], "long-chat")["channel_id"]

    parent = test_client.post(
        f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "x" * 500},
        headers=_human_auth(h1["access_token"]),
    ).json()

    reply = test_client.post(
        f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "short", "parent_post_id": parent["post_id"]},
        headers=_human_auth(h1["access_token"]),
    ).json()
    excerpt = reply["parent_preview"]["message_excerpt"]
    assert len(excerpt) <= 140
    assert excerpt.endswith("…")


def test_human_edit_own_post_stamps_edited_at(test_client):
    """Editing own post replaces the text and stamps a permanent ``edited_at``."""
    h1 = _register_human(test_client, "editor@test.com", display_name="Editor")
    ch_id = _create_channel(test_client, h1["access_token"], "edit-chat")["channel_id"]
    post = test_client.post(
        f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "first draft"},
        headers=_human_auth(h1["access_token"]),
    ).json()
    assert post["edited_at"] is None

    r = test_client.patch(
        f"/api/human/mm/posts/{post['post_id']}",
        json={"message": "the polished version"},
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 200, r.text
    edited = r.json()
    assert edited["message"] == "the polished version"
    assert edited["edited_at"] is not None

    # Listing carries the marker too.
    listed = test_client.get(
        f"/api/human/mm/channels/{ch_id}/posts",
        headers=_human_auth(h1["access_token"]),
    ).json()
    row = next(p for p in listed["posts"] if p["post_id"] == post["post_id"])
    assert row["message"] == "the polished version"
    assert row["edited_at"] == edited["edited_at"]


def test_human_edit_missing_post_404(test_client):
    h1 = _register_human(test_client, "edit-missing@test.com")
    r = test_client.patch(
        "/api/human/mm/posts/9999999",
        json={"message": "ghost"},
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 404


def test_human_edit_empty_message_rejected(test_client):
    """Empty/whitespace-only edits are rejected by Pydantic min_length=1."""
    h1 = _register_human(test_client, "edit-empty@test.com")
    ch_id = _create_channel(test_client, h1["access_token"], "edit-empty")["channel_id"]
    post = test_client.post(
        f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "real content"},
        headers=_human_auth(h1["access_token"]),
    ).json()

    r = test_client.patch(
        f"/api/human/mm/posts/{post['post_id']}",
        json={"message": ""},
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 422  # Pydantic schema rejection


def test_human_delete_own_post_round_trip(test_client):
    """Author can delete their own post; it disappears from the channel."""
    h1 = _register_human(test_client, "del-author@test.com", display_name="Author")
    ch_id = _create_channel(test_client, h1["access_token"], "del-chat")["channel_id"]
    post = test_client.post(
        f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "to be deleted"},
        headers=_human_auth(h1["access_token"]),
    ).json()

    r = test_client.delete(
        f"/api/human/mm/posts/{post['post_id']}",
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 204, r.text

    listed = test_client.get(
        f"/api/human/mm/channels/{ch_id}/posts",
        headers=_human_auth(h1["access_token"]),
    ).json()
    assert all(p["post_id"] != post["post_id"] for p in listed["posts"])


def test_human_delete_refreshes_channel_preview(test_client):
    """Regression: deleting the newest post must rebuild the channel's
    denormalised sidebar preview.

    ``mm_channels.last_message_*`` is a snapshot written on publish, and the
    channels-list endpoint serves it verbatim — so a delete that skipped the
    recompute left the deleted message visible in the sidebar forever, even
    across a full refetch. Deleting the last remaining post must clear the
    preview outright."""
    h1 = _register_human(test_client, "del-preview@test.com", display_name="Prue")
    ch_id = _create_channel(test_client, h1["access_token"], "del-preview")["channel_id"]

    def _preview() -> dict:
        resp = test_client.get(
            "/api/human/mm/channels", headers=_human_auth(h1["access_token"])
        )
        assert resp.status_code == 200, resp.text
        return next(c for c in resp.json()["channels"] if c["channel_id"] == ch_id)

    first = test_client.post(
        f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "the older one"},
        headers=_human_auth(h1["access_token"]),
    ).json()
    second = test_client.post(
        f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "the newest one"},
        headers=_human_auth(h1["access_token"]),
    ).json()
    assert _preview()["last_message_text"] == "the newest one"

    r = test_client.delete(
        f"/api/human/mm/posts/{second['post_id']}",
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 204, r.text

    ch = _preview()
    assert ch["last_message_text"] == "the older one"
    assert ch["last_message_author_human_id"] == h1["user"]["id"]

    # Deleting the last survivor empties the preview rather than stranding it.
    r = test_client.delete(
        f"/api/human/mm/posts/{first['post_id']}",
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 204, r.text

    ch = _preview()
    assert ch["last_message_text"] is None
    assert ch["last_message_author_human_id"] is None
    assert ch["last_message_author_display_name"] is None


def test_human_delete_preserves_read_pointer(test_client):
    """Regression: deleting a post must not re-mark the channel unread.

    ``human_channel_state.last_read_post_id`` has no ON DELETE cascade, so
    the delete has to move any pointer sitting on the doomed post. Nulling
    it reads as "nothing read in this channel" — and since the post a
    caught-up reader points at is precisely the newest one, deleting the
    newest message used to relight the whole history (and the app badge)
    for every member. The pointer must land on the newest survivor
    instead."""
    author = _register_human(test_client, "del-unread-a@test.com", display_name="Ann")
    reader = _register_human(test_client, "del-unread-b@test.com", display_name="Bea")
    _add_human_to_org(test_client, author["access_token"], "del-unread-b@test.com")
    ch_id = _create_channel(test_client, author["access_token"], "del-unread")["channel_id"]
    test_client.post(
        f"/api/human/mm/channels/{ch_id}/members",
        json={"member_id": str(reader["user"]["id"]), "member_type": "human"},
        headers=_human_auth(author["access_token"]),
    )

    posts = [
        test_client.post(
            f"/api/human/mm/channels/{ch_id}/posts",
            json={"message": f"message {i}"},
            headers=_human_auth(author["access_token"]),
        ).json()
        for i in range(4)
    ]

    def _reader_channel() -> dict:
        resp = test_client.get(
            "/api/human/mm/channels", headers=_human_auth(reader["access_token"])
        )
        assert resp.status_code == 200, resp.text
        return next(c for c in resp.json()["channels"] if c["channel_id"] == ch_id)

    assert _reader_channel()["unread_count"] == 4

    # The reader catches up — their pointer now sits on the newest post,
    # which is the one about to be deleted.
    r = test_client.post(
        f"/api/human/mm/channels/{ch_id}/read",
        json={"post_id": posts[-1]["post_id"]},
        headers=_human_auth(reader["access_token"]),
    )
    assert r.status_code == 200, r.text
    assert _reader_channel()["unread_count"] == 0

    r = test_client.delete(
        f"/api/human/mm/posts/{posts[-1]['post_id']}",
        headers=_human_auth(author["access_token"]),
    )
    assert r.status_code == 204, r.text

    assert _reader_channel()["unread_count"] == 0, (
        "deleting a read post must not resurrect unreads"
    )
    # The pointer itself isn't on the channel payload (it rides the members
    # response), so assert it at the source: it should have slid back exactly
    # one post rather than gone null.
    assert _read_pointer(test_client, ch_id, reader["user"]["id"]) == posts[-2]["post_id"]

    # A post arriving after the delete still counts as exactly one unread —
    # the repointed cursor is a working cursor, not just a cosmetic zero.
    test_client.post(
        f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "after the delete"},
        headers=_human_auth(author["access_token"]),
    )
    assert _reader_channel()["unread_count"] == 1


def test_human_delete_only_post_clears_read_pointer(test_client):
    """With nothing older to point at, the pointer honestly goes back to
    NULL — and the channel reads as empty rather than unread."""
    author = _register_human(test_client, "del-only-a@test.com", display_name="Cal")
    reader = _register_human(test_client, "del-only-b@test.com", display_name="Dee")
    _add_human_to_org(test_client, author["access_token"], "del-only-b@test.com")
    ch_id = _create_channel(test_client, author["access_token"], "del-only")["channel_id"]
    test_client.post(
        f"/api/human/mm/channels/{ch_id}/members",
        json={"member_id": str(reader["user"]["id"]), "member_type": "human"},
        headers=_human_auth(author["access_token"]),
    )
    post = test_client.post(
        f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "the only one"},
        headers=_human_auth(author["access_token"]),
    ).json()
    test_client.post(
        f"/api/human/mm/channels/{ch_id}/read",
        json={"post_id": post["post_id"]},
        headers=_human_auth(reader["access_token"]),
    )

    r = test_client.delete(
        f"/api/human/mm/posts/{post['post_id']}",
        headers=_human_auth(author["access_token"]),
    )
    assert r.status_code == 204, r.text

    resp = test_client.get(
        "/api/human/mm/channels", headers=_human_auth(reader["access_token"])
    ).json()
    ch = next(c for c in resp["channels"] if c["channel_id"] == ch_id)
    assert ch["unread_count"] == 0
    assert _read_pointer(test_client, ch_id, reader["user"]["id"]) is None


def test_human_edit_refreshes_channel_preview(test_client):
    """Editing the newest post must rewrite the sidebar preview too —
    same denormalised snapshot as the delete path above."""
    h1 = _register_human(test_client, "edit-preview@test.com", display_name="Ed")
    ch_id = _create_channel(test_client, h1["access_token"], "edit-preview")["channel_id"]
    post = test_client.post(
        f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "typo verison"},
        headers=_human_auth(h1["access_token"]),
    ).json()

    r = test_client.patch(
        f"/api/human/mm/posts/{post['post_id']}",
        json={"message": "typo version"},
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 200, r.text

    resp = test_client.get(
        "/api/human/mm/channels", headers=_human_auth(h1["access_token"])
    ).json()
    ch = next(c for c in resp["channels"] if c["channel_id"] == ch_id)
    assert ch["last_message_text"] == "typo version"


def test_human_delete_other_user_post_forbidden(test_client):
    """A non-author, non-creator member cannot delete someone else's post."""
    h1 = _register_human(test_client, "del-owner@test.com")
    h2 = _register_human(test_client, "del-intruder@test.com")
    _add_human_to_org(test_client, h1["access_token"], "del-intruder@test.com")
    ch_id = _create_channel(test_client, h1["access_token"], "del-locked")["channel_id"]
    # h2 joins so they can see the post but isn't the creator.
    test_client.post(
        f"/api/human/mm/channels/{ch_id}/members",
        json={"member_id": str(h2["user"]["id"]), "member_type": "human"},
        headers=_human_auth(h1["access_token"]),
    )
    post = test_client.post(
        f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "h2 can't touch this"},
        headers=_human_auth(h2["access_token"]),
    ).json()

    # Different non-creator member tries to delete h2's post.
    h3 = _register_human(test_client, "del-bystander@test.com")
    _add_human_to_org(test_client, h1["access_token"], "del-bystander@test.com")
    test_client.post(
        f"/api/human/mm/channels/{ch_id}/members",
        json={"member_id": str(h3["user"]["id"]), "member_type": "human"},
        headers=_human_auth(h1["access_token"]),
    )
    r = test_client.delete(
        f"/api/human/mm/posts/{post['post_id']}",
        headers=_human_auth(h3["access_token"]),
    )
    assert r.status_code == 403, r.text


def test_human_channel_creator_can_delete_anyone(test_client):
    """The channel creator may delete a member's post for moderation."""
    creator = _register_human(test_client, "del-creator@test.com")
    member = _register_human(test_client, "del-member@test.com")
    _add_human_to_org(test_client, creator["access_token"], "del-member@test.com")
    ch_id = _create_channel(test_client, creator["access_token"], "del-mod")["channel_id"]
    test_client.post(
        f"/api/human/mm/channels/{ch_id}/members",
        json={"member_id": str(member["user"]["id"]), "member_type": "human"},
        headers=_human_auth(creator["access_token"]),
    )
    post = test_client.post(
        f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "moderate me"},
        headers=_human_auth(member["access_token"]),
    ).json()

    r = test_client.delete(
        f"/api/human/mm/posts/{post['post_id']}",
        headers=_human_auth(creator["access_token"]),
    )
    assert r.status_code == 204, r.text


def test_human_delete_missing_post_404(test_client):
    h1 = _register_human(test_client, "del-missing@test.com")
    r = test_client.delete(
        "/api/human/mm/posts/9999999",
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 404


def test_human_delete_detaches_replies(test_client):
    """Deleting a post detaches its replies (parent_post_id -> NULL); the
    replies survive and are listed normally."""
    h1 = _register_human(test_client, "del-thread@test.com")
    ch_id = _create_channel(test_client, h1["access_token"], "del-thread")["channel_id"]
    parent = test_client.post(
        f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "parent"},
        headers=_human_auth(h1["access_token"]),
    ).json()
    reply = test_client.post(
        f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "reply", "parent_post_id": parent["post_id"]},
        headers=_human_auth(h1["access_token"]),
    ).json()
    assert reply["parent_post_id"] == parent["post_id"]

    r = test_client.delete(
        f"/api/human/mm/posts/{parent['post_id']}",
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 204, r.text

    listed = test_client.get(
        f"/api/human/mm/channels/{ch_id}/posts",
        headers=_human_auth(h1["access_token"]),
    ).json()
    survivors = {p["post_id"]: p for p in listed["posts"]}
    assert parent["post_id"] not in survivors
    assert reply["post_id"] in survivors
    assert survivors[reply["post_id"]]["parent_post_id"] is None


def test_human_reaction_toggle_round_trip(test_client):
    """Toggle adds on first call, removes on second; counts aggregate correctly."""
    h1 = _register_human(test_client, "reactor@test.com", display_name="Reactor")
    ch_id = _create_channel(test_client, h1["access_token"], "react-chat")["channel_id"]
    post = test_client.post(
        f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "react to me"},
        headers=_human_auth(h1["access_token"]),
    ).json()

    # First call: adds the reaction.
    r1 = test_client.post(
        f"/api/human/mm/posts/{post['post_id']}/reactions",
        json={"emoji": "👍"},
        headers=_human_auth(h1["access_token"]),
    )
    assert r1.status_code == 200, r1.text
    body = r1.json()
    assert body["reactions"] == [
        {"emoji": "👍", "count": 1, "human_ids": [h1["user"]["id"]], "agent_ids": []},
    ]

    # Second call with the same emoji: removes it. Bucket collapses entirely.
    r2 = test_client.post(
        f"/api/human/mm/posts/{post['post_id']}/reactions",
        json={"emoji": "👍"},
        headers=_human_auth(h1["access_token"]),
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["reactions"] == []


def test_human_reaction_on_missing_post_404(test_client):
    """Reacting to a non-existent post returns 404."""
    h1 = _register_human(test_client, "ghost@test.com")
    r = test_client.post(
        "/api/human/mm/posts/9999999/reactions",
        json={"emoji": "👍"},
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 404


def test_human_non_member_cannot_post(test_client):
    """Non-members cannot post to a channel."""
    h1 = _register_human(test_client, "priv1@test.com")
    h2 = _register_human(test_client, "priv2@test.com")

    ch_id = _create_channel(test_client, h1["access_token"], "private-chat", "private")["channel_id"]

    # h2 tries to post without being a member
    r = test_client.post(f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "sneaky!"},
        headers=_human_auth(h2["access_token"]),
    )
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# Tests: Mixed channel (human + agent posts)
# ---------------------------------------------------------------------------

def test_mixed_channel_human_and_agent_posts(test_client):
    """Humans and agents can post to the same channel and see each other's messages."""
    h1 = _register_human(test_client, "mixer@test.com", display_name="Mixer")
    agent = _create_agent(test_client, owner_email="mixer@test.com")

    # Human creates channel
    ch_id = _create_channel(test_client, h1["access_token"], "mixed-chat", "public")["channel_id"]

    # Human adds agent
    test_client.post(f"/api/human/mm/channels/{ch_id}/members",
        json={"member_id": agent["agent_id"], "member_type": "agent"},
        headers=_human_auth(h1["access_token"]),
    )

    # Human posts
    test_client.post(f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "Hello from human!"},
        headers=_human_auth(h1["access_token"]),
    )

    # Agent posts
    r = test_client.post(f"/api/agentic/mm/channels/{ch_id}/posts",
        json={"message": "Hello from agent!"},
        headers=_agent_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200

    # Human reads all posts
    r = test_client.get(f"/api/human/mm/channels/{ch_id}/posts",
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 200
    msgs = [p["message"] for p in r.json()["posts"]]
    assert "Hello from human!" in msgs
    assert "Hello from agent!" in msgs

    # Agent also reads all posts
    r = test_client.get(f"/api/agentic/mm/channels/{ch_id}/posts",
        headers=_agent_auth(agent["api_key"]),
    )
    assert r.status_code == 200
    msgs = [p["message"] for p in r.json()["posts"]]
    assert "Hello from human!" in msgs
    assert "Hello from agent!" in msgs


# ---------------------------------------------------------------------------
# Tests: Human DMs
# ---------------------------------------------------------------------------

def test_human_dm_with_agent(test_client):
    """Human can create a DM with an agent and exchange messages."""
    agent = _create_agent(test_client)
    # The agent's owner shares an org with the agent — DMs are scoped to that org.
    h1 = _register_human(test_client, "stan@clawbits.ai", display_name="Stan")
    org_id = _get_personal_org_id(test_client, h1["access_token"])

    # Open DM
    r = test_client.post("/api/human/mm/direct",
        json={"org_id": org_id, "target_id": agent["agent_id"], "target_type": "agent"},
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 200
    dm = r.json()
    assert dm["channel_type"] == "direct"
    assert dm["org_id"] == org_id
    dm_id = dm["channel_id"]

    # Human sends
    test_client.post(f"/api/human/mm/channels/{dm_id}/posts",
        json={"message": "Hi agent!"},
        headers=_human_auth(h1["access_token"]),
    )

    # Agent sends
    test_client.post(f"/api/agentic/mm/channels/{dm_id}/posts",
        json={"message": "Hi human!"},
        headers=_agent_write_headers(test_client, agent["api_key"]),
    )

    # Human reads
    r = test_client.get(f"/api/human/mm/channels/{dm_id}/posts",
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 200
    msgs = [p["message"] for p in r.json()["posts"]]
    assert "Hi agent!" in msgs
    assert "Hi human!" in msgs


def test_human_dm_with_human(test_client):
    """Two humans can create a DM and exchange messages."""
    h1 = _register_human(test_client, "dm1@test.com", display_name="DmOne")
    h2 = _register_human(test_client, "dm2@test.com", display_name="DmTwo")
    org_id = _get_personal_org_id(test_client, h1["access_token"])
    r = test_client.post(
        f"/api/human/orgs/{org_id}/members",
        json={"email": "dm2@test.com", "role": "member"},
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 200, r.text

    # Open DM
    r = test_client.post("/api/human/mm/direct",
        json={"org_id": org_id, "target_id": str(h2["user"]["id"]), "target_type": "human"},
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 200
    dm = r.json()
    assert dm["channel_type"] == "direct"
    assert dm["org_id"] == org_id
    dm_id = dm["channel_id"]

    # h1 sends
    test_client.post(f"/api/human/mm/channels/{dm_id}/posts",
        json={"message": "Hello DM!"},
        headers=_human_auth(h1["access_token"]),
    )

    # h2 sends
    test_client.post(f"/api/human/mm/channels/{dm_id}/posts",
        json={"message": "Hey back!"},
        headers=_human_auth(h2["access_token"]),
    )

    # h2 reads
    r = test_client.get(f"/api/human/mm/channels/{dm_id}/posts",
        headers=_human_auth(h2["access_token"]),
    )
    assert r.status_code == 200
    msgs = [p["message"] for p in r.json()["posts"]]
    assert "Hello DM!" in msgs
    assert "Hey back!" in msgs


def test_human_dm_deduplication(test_client):
    """Opening a DM twice between the same humans returns the same channel."""
    h1 = _register_human(test_client, "dedup1@test.com")
    h2 = _register_human(test_client, "dedup2@test.com")
    org_id = _get_personal_org_id(test_client, h1["access_token"])
    test_client.post(
        f"/api/human/orgs/{org_id}/members",
        json={"email": "dedup2@test.com", "role": "member"},
        headers=_human_auth(h1["access_token"]),
    )

    r1 = test_client.post("/api/human/mm/direct",
        json={"org_id": org_id, "target_id": str(h2["user"]["id"]), "target_type": "human"},
        headers=_human_auth(h1["access_token"]),
    )
    dm1 = r1.json()["channel_id"]

    # h2 opens DM with h1 → same channel
    r2 = test_client.post("/api/human/mm/direct",
        json={"org_id": org_id, "target_id": str(h1["user"]["id"]), "target_type": "human"},
        headers=_human_auth(h2["access_token"]),
    )
    dm2 = r2.json()["channel_id"]

    assert dm1 == dm2


def test_human_dm_with_self_rejected(test_client):
    """Cannot create a DM with yourself."""
    h1 = _register_human(test_client, "selfie@test.com")
    org_id = _get_personal_org_id(test_client, h1["access_token"])
    r = test_client.post("/api/human/mm/direct",
        json={"org_id": org_id, "target_id": str(h1["user"]["id"]), "target_type": "human"},
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 400


def test_human_dm_agent_deduplication(test_client):
    """Opening the same human↔agent DM twice returns the same channel."""
    agent = _create_agent(test_client)
    h1 = _register_human(test_client, "stan@clawbits.ai", display_name="Stan")
    org_id = _get_personal_org_id(test_client, h1["access_token"])

    r1 = test_client.post("/api/human/mm/direct",
        json={"org_id": org_id, "target_id": agent["agent_id"], "target_type": "agent"},
        headers=_human_auth(h1["access_token"]),
    )
    dm1 = r1.json()["channel_id"]

    # Same request again
    r2 = test_client.post("/api/human/mm/direct",
        json={"org_id": org_id, "target_id": agent["agent_id"], "target_type": "agent"},
        headers=_human_auth(h1["access_token"]),
    )
    dm2 = r2.json()["channel_id"]

    assert dm1 == dm2


# ---------------------------------------------------------------------------
# Tests: Auth required
# ---------------------------------------------------------------------------

def test_unauthenticated_human_rejected(test_client):
    """Requests without a valid JWT are rejected."""
    r = test_client.get("/api/human/mm/channels")
    assert r.status_code in (401, 403)

    r = test_client.get("/api/human/mm/channels", headers={"Authorization": "Bearer invalid"})
    assert r.status_code == 401


def test_delete_channel_purges_channel_events(test_client):
    """Regression: ``delete_mm_channel`` must purge ``mm_channel_events``.

    Older agent channels accumulated ``member.added``/``removed`` timeline
    events. That table's FK to ``mm_channels`` has no ``ON DELETE CASCADE``,
    so deleting such a channel raised a ForeignKeyViolation (500) on prod
    until the events are cleared first.
    """
    from datetime import UTC, datetime

    from sqlmodel import Session, select

    from clawbits.db.models import MmChannel, MmChannelEvent
    from clawbits.db.table_write import TableWrite

    reg = _register_human(test_client, "delevents@test.com")
    human_id = reg["user"]["id"]
    now = datetime.now(UTC)

    with Session(test_client.app._engine) as db:
        db.add(MmChannel(
            channel_id="del_ev_ch", name="del-ev",
            channel_type="private", created_at=now,
        ))
        db.add(MmChannelEvent(
            channel_id="del_ev_ch", event_type="member.added",
            actor_human_id=human_id, created_at=now,
        ))
        db.commit()

        result = TableWrite.delete_mm_channel(db, "del_ev_ch")
        db.commit()

    assert result is not None, "channel should have existed and been deleted"
    with Session(test_client.app._engine) as db:
        assert db.get(MmChannel, "del_ev_ch") is None
        leftover = db.exec(
            select(MmChannelEvent).where(
                MmChannelEvent.channel_id == "del_ev_ch"
            )
        ).all()
        assert leftover == [], "channel events were not purged on delete"


# ---------------------------------------------------------------------------
# Tests: leaving as the last human deletes the channel
# ---------------------------------------------------------------------------

def test_last_human_leaving_deletes_channel(test_client):
    """When the only human leaves a channel, the channel is hard-deleted
    rather than left as an agent-only husk."""
    from sqlmodel import Session

    from clawbits.db.models import MmChannel

    h1 = _register_human(test_client, "lastleave@test.com")
    agent = _create_agent(test_client, owner_email="lastleave@test.com")
    ch_id = _create_channel(test_client, h1["access_token"], "soloch", "public")["channel_id"]

    # Park an agent in the channel so it isn't trivially empty.
    r = test_client.post(f"/api/human/mm/channels/{ch_id}/members",
        json={"member_id": agent["agent_id"], "member_type": "agent"},
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 200, r.text

    # The only human leaves -> the channel is deleted.
    r = test_client.delete(
        f"/api/human/mm/channels/{ch_id}/members/{h1['user']['id']}?member_type=human",
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["channel_deleted"] is True
    assert body["total"] == 0

    with Session(test_client.app._engine) as db:
        assert db.get(MmChannel, ch_id) is None


def test_leaving_dm_with_agent_deletes_channel(test_client):
    """Leaving a human↔agent DM (no other human) removes the conversation."""
    from sqlmodel import Session

    from clawbits.db.models import MmChannel

    agent = _create_agent(test_client)
    h1 = _register_human(test_client, "stan@clawbits.ai", display_name="Stan")
    org_id = _get_personal_org_id(test_client, h1["access_token"])
    dm = test_client.post("/api/human/mm/direct",
        json={"org_id": org_id, "target_id": agent["agent_id"], "target_type": "agent"},
        headers=_human_auth(h1["access_token"]),
    ).json()
    ch_id = dm["channel_id"]

    r = test_client.delete(
        f"/api/human/mm/channels/{ch_id}/members/{h1['user']['id']}?member_type=human",
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 200, r.text
    assert r.json()["channel_deleted"] is True

    with Session(test_client.app._engine) as db:
        assert db.get(MmChannel, ch_id) is None


def test_leaving_channel_with_other_humans_keeps_it(test_client):
    """Leaving is non-destructive while another human remains a member."""
    h1 = _register_human(test_client, "keep1@test.com")
    h2 = _register_human(test_client, "keep2@test.com")
    _add_human_to_org(test_client, h1["access_token"], "keep2@test.com")
    ch_id = _create_channel(test_client, h1["access_token"], "keepch", "public")["channel_id"]
    test_client.post(f"/api/human/mm/channels/{ch_id}/members",
        json={"member_id": str(h2["user"]["id"]), "member_type": "human"},
        headers=_human_auth(h1["access_token"]),
    )

    r = test_client.delete(
        f"/api/human/mm/channels/{ch_id}/members/{h1['user']['id']}?member_type=human",
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["channel_deleted"] is False
    assert body["total"] == 1

    # The channel survives and the remaining human can still see it.
    r = test_client.get(f"/api/human/mm/channels/{ch_id}", headers=_human_auth(h2["access_token"]))
    assert r.status_code == 200


def test_creator_deletes_channel_with_other_humans(test_client):
    """The creator can delete a channel outright even while other humans remain."""
    h1 = _register_human(test_client, "owner1@test.com")
    h2 = _register_human(test_client, "owner2@test.com")
    _add_human_to_org(test_client, h1["access_token"], "owner2@test.com")
    ch_id = _create_channel(test_client, h1["access_token"], "ownerch", "public")["channel_id"]
    test_client.post(f"/api/human/mm/channels/{ch_id}/members",
        json={"member_id": str(h2["user"]["id"]), "member_type": "human"},
        headers=_human_auth(h1["access_token"]),
    )

    # Creator deletes the whole channel.
    r = test_client.delete(
        f"/api/human/mm/channels/{ch_id}",
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 204, r.text

    # It's gone for both members.
    for h in (h1, h2):
        r = test_client.get(f"/api/human/mm/channels/{ch_id}", headers=_human_auth(h["access_token"]))
        assert r.status_code in (403, 404)


def test_non_creator_cannot_delete_channel(test_client):
    """A member who didn't create the channel gets 403 from the delete endpoint."""
    h1 = _register_human(test_client, "ncreate1@test.com")
    h2 = _register_human(test_client, "ncreate2@test.com")
    _add_human_to_org(test_client, h1["access_token"], "ncreate2@test.com")
    ch_id = _create_channel(test_client, h1["access_token"], "ncch", "public")["channel_id"]
    test_client.post(f"/api/human/mm/channels/{ch_id}/members",
        json={"member_id": str(h2["user"]["id"]), "member_type": "human"},
        headers=_human_auth(h1["access_token"]),
    )

    # h2 (not the creator) cannot delete it.
    r = test_client.delete(
        f"/api/human/mm/channels/{ch_id}",
        headers=_human_auth(h2["access_token"]),
    )
    assert r.status_code == 403, r.text

    # Channel still exists for the creator.
    r = test_client.get(f"/api/human/mm/channels/{ch_id}", headers=_human_auth(h1["access_token"]))
    assert r.status_code == 200


def test_outsider_cannot_delete_channel(test_client):
    """Someone who is neither the creator nor an org owner gets 403."""
    h1 = _register_human(test_client, "nmem1@test.com")
    h2 = _register_human(test_client, "nmem2@test.com")
    ch_id = _create_channel(test_client, h1["access_token"], "nmemch", "public")["channel_id"]

    r = test_client.delete(
        f"/api/human/mm/channels/{ch_id}",
        headers=_human_auth(h2["access_token"]),
    )
    assert r.status_code == 403, r.text


def test_org_owner_deletes_channel_created_by_another(test_client):
    """An org owner can delete a channel they did not create (admin path)."""
    from datetime import UTC, datetime

    from sqlmodel import Session

    from clawbits.db.models import MmChannel, MmChannelMember

    owner = _register_human(test_client, "chowner@test.com")
    creator = _register_human(test_client, "chcreator@test.com")
    # ``owner`` is the owner of their own personal org; the channel lives in
    # that org but was created by a different human, so the delete must
    # authorise via the owner role, not creator.
    org_id = _get_personal_org_id(test_client, owner["access_token"])
    owner_id = owner["user"]["id"]
    creator_id = creator["user"]["id"]
    now = datetime.now(UTC)

    with Session(test_client.app._engine) as db:
        db.add(MmChannel(
            channel_id="owner_del_ch", name="ownerdel", channel_type="public",
            org_id=org_id, created_by_human=creator_id, created_at=now,
        ))
        db.add(MmChannelMember(channel_id="owner_del_ch", human_id=owner_id, joined_at=now))
        db.add(MmChannelMember(channel_id="owner_del_ch", human_id=creator_id, joined_at=now))
        db.commit()

    r = test_client.delete(
        "/api/human/mm/channels/owner_del_ch",
        headers=_human_auth(owner["access_token"]),
    )
    assert r.status_code == 204, r.text

    r = test_client.get(
        "/api/human/mm/channels/owner_del_ch",
        headers=_human_auth(owner["access_token"]),
    )
    assert r.status_code in (403, 404)


def test_deleting_channel_notifies_agent_members(test_client, monkeypatch):
    """Deleting a channel fans out ``channel.removed`` to agent members so
    their plugins drop it — the agent-side counterpart of the human fanout."""
    from datetime import UTC, datetime

    from sqlmodel import Session

    import clawbits.fastapi.human_mm_endpoints as mm_endpoints
    from clawbits.db.models import MmChannel, MmChannelMember

    calls: list[tuple[str, str]] = []

    async def _record(_bus, agent_id, channel_id):
        calls.append((agent_id, channel_id))

    monkeypatch.setattr(mm_endpoints, "publish_agent_channel_removed", _record)

    h1 = _register_human(test_client, "agfanout@test.com")
    agent = _create_agent(test_client, owner_email="agfanoutop@clawbits.ai")
    agent_id = agent["agent_id"]
    org_id = _get_personal_org_id(test_client, h1["access_token"])
    human_id = h1["user"]["id"]
    now = datetime.now(UTC)

    with Session(test_client.app._engine) as db:
        db.add(MmChannel(
            channel_id="ag_fanout_ch", name="agfan", channel_type="public",
            org_id=org_id, created_by_human=human_id, created_at=now,
        ))
        db.add(MmChannelMember(channel_id="ag_fanout_ch", human_id=human_id, joined_at=now))
        db.add(MmChannelMember(channel_id="ag_fanout_ch", agent_id=agent_id, joined_at=now))
        db.commit()

    r = test_client.delete(
        "/api/human/mm/channels/ag_fanout_ch",
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 204, r.text
    assert (agent_id, "ag_fanout_ch") in calls


def test_delete_agent_rebuilds_stale_channel_preview(test_client):
    """Deleting an agent that authored a channel's last message rebuilds the
    sidebar preview from the surviving posts instead of leaving a dangling
    reference — the channel itself survives because a human remains."""
    from datetime import UTC, datetime

    from sqlmodel import Session

    from clawbits.db.models import MmChannel, MmChannelMember, MmPost
    from clawbits.db.table_write import TableWrite

    h1 = _register_human(test_client, "previewfix@test.com", display_name="Pam")
    human_id = h1["user"]["id"]
    agent = _create_agent(test_client, owner_email="previewagent@clawbits.ai")
    agent_id = agent["agent_id"]
    now = datetime.now(UTC)

    with Session(test_client.app._engine) as db:
        db.add(MmChannel(
            channel_id="prev_ch", name="prev", channel_type="public",
            created_at=now,
            last_message_text="agent says hi",
            last_message_author_agent_id=agent_id,
            last_message_author_display_name="Agent",
        ))
        db.add(MmChannelMember(channel_id="prev_ch", human_id=human_id, joined_at=now))
        db.add(MmChannelMember(channel_id="prev_ch", agent_id=agent_id, joined_at=now))
        db.add(MmPost(
            channel_id="prev_ch", human_id=human_id,
            message="human earlier", status="published", created_at=now,
        ))
        db.add(MmPost(
            channel_id="prev_ch", agent_id=agent_id,
            message="agent says hi", status="published", created_at=now,
        ))
        db.commit()

        TableWrite.delete_agent(db, agent_id)
        db.commit()

    with Session(test_client.app._engine) as db:
        ch = db.get(MmChannel, "prev_ch")
        assert ch is not None, "channel with a human member must survive"
        assert ch.last_message_author_agent_id is None
        assert ch.last_message_author_human_id == human_id
        assert ch.last_message_text == "human earlier"



# ---------------------------------------------------------------------------
# Tests: unread counting is capped (sidebar read-path performance)
# ---------------------------------------------------------------------------

def test_unread_counts_are_capped(test_client):
    """``unread_count`` and ``unread_mention_count`` stop counting at
    ``UNREAD_COUNT_CAP``.

    Every client renders anything past 99 as "99+", so the read path stops
    counting at 100 rather than walking an unbounded backlog — the pathological
    case being a busy channel the viewer has never opened, where there is no
    read pointer and "count the unread" means "count the channel". A returned
    value equal to the cap means "at least this many", never "exactly".

    Below the cap the counts must still be exact, which is what makes this a
    cap and not an approximation.
    """
    from datetime import UTC, datetime

    from sqlmodel import Session, select

    from clawbits.db.models import MmChannel, MmChannelMember, MmPost
    from clawbits.db.table_read import UNREAD_COUNT_CAP, TableRead

    over = UNREAD_COUNT_CAP + 25
    h1 = _register_human(test_client, "capviewer@test.com", display_name="Cap Viewer")
    h2 = _register_human(test_client, "cappeer@test.com")
    viewer_id = h1["user"]["id"]
    peer_id = h2["user"]["id"]
    now = datetime.now(UTC)

    # Bulk-insert straight to the DB: posting `over` messages through the API
    # would drag the whole fan-out plane (events, previews, attention) into a
    # test about arithmetic.
    with Session(test_client.app._engine) as db:
        db.add(MmChannel(
            channel_id="cap_ch", name="cap", channel_type="public", created_at=now,
        ))
        db.add(MmChannelMember(channel_id="cap_ch", human_id=viewer_id, joined_at=now))
        db.add(MmChannelMember(channel_id="cap_ch", human_id=peer_id, joined_at=now))
        # Every post both unread AND a mention, so one loop exercises both
        # counters against the same cap.
        for i in range(over):
            db.add(MmPost(
                channel_id="cap_ch", human_id=peer_id,
                message=f"@here message {i}", status="published", created_at=now,
            ))
        db.commit()

    resp = test_client.get(
        "/api/human/mm/channels", headers=_human_auth(h1["access_token"])
    )
    assert resp.status_code == 200, resp.text
    ch = next(c for c in resp.json()["channels"] if c["channel_id"] == "cap_ch")

    assert ch["unread_count"] == UNREAD_COUNT_CAP
    assert ch["unread_mention_count"] == UNREAD_COUNT_CAP

    # ``latest_post_id`` and ``last_message_at`` must describe the SAME post.
    # They come from one row via LATERAL rather than being max()'d
    # independently, which is what stops two posts sharing a timestamp from
    # handing back the id of one and the time of the other. ``latest_post_id``
    # is internal to the read path (the response model does not carry it), so
    # this asserts against the accessor directly.
    with Session(test_client.app._engine) as db:
        newest = db.exec(
            select(MmPost).where(MmPost.channel_id == "cap_ch")
            .order_by(MmPost.post_id.desc())
        ).first()
        row = next(
            c for c in TableRead.get_mm_channels_for_human(db, viewer_id)
            if c["channel_id"] == "cap_ch"
        )
        assert row["latest_post_id"] == newest.post_id
        assert row["last_message_at"] == ch["last_message_at"]

    # Read up to 25 short of the end: the remainder is under the cap, so the
    # count must be exact again.
    r = test_client.post(
        "/api/human/mm/channels/cap_ch/read",
        json={"post_id": newest.post_id - 25},
        headers=_human_auth(h1["access_token"]),
    )
    assert r.status_code == 200, r.text
    resp = test_client.get(
        "/api/human/mm/channels", headers=_human_auth(h1["access_token"])
    )
    ch = next(c for c in resp.json()["channels"] if c["channel_id"] == "cap_ch")
    assert ch["unread_count"] == 25
    assert ch["unread_mention_count"] == 25
