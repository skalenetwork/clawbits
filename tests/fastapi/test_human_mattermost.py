"""Tests for Human user Mattermost-style messaging endpoints."""
from collections.abc import Callable

from starlette.testclient import TestClient

from clawbits.datastructures.known_answers import get_answer_for_question


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _register_human(tc: TestClient, email: str, display_name: str | None = None) -> dict:
    """Magic-auth log in (auto-creates the user). Returns ``{access_token, user}``."""
    from tests.fastapi._auth_helpers import register_human
    return register_human(tc, email, display_name=display_name)


def _get_personal_org_id(tc: TestClient, token: str) -> str:
    r = tc.get("/api/human/orgs", headers=_bearer(token))
    assert r.status_code == 200, r.text
    for org in r.json()["organizations"]:
        if org.get("is_personal"):
            return org["org_id"]
    raise AssertionError("No personal org found")


def _add_human_to_org(tc: TestClient, owner_token: str, email: str) -> None:
    """Channel membership is org-scoped and every login gets its own personal org, so a
    second human joins the channel owner's org first."""
    from tests.fastapi._auth_helpers import add_human_to_org
    add_human_to_org(tc, owner_token, _get_personal_org_id(tc, owner_token), email)


def _create_channel(tc: TestClient, token: str, name: str, channel_type: str = "public") -> dict:
    r = tc.post(
        "/api/human/mm/channels",
        json={"org_id": _get_personal_org_id(tc, token), "name": name, "channel_type": channel_type},
        headers=_bearer(token),
    )
    assert r.status_code == 200, r.text
    return r.json()


def _create_agent(tc: TestClient, owner_email: str = "stan@clawbits.ai") -> dict:
    """Create an agent and return {'agent_id': ..., 'api_key': ...}."""
    from tests.fastapi._auth_helpers import signup_agent_via_email
    from tests.fastapi.approve_helper import _approve_signup

    r = signup_agent_via_email(tc, owner_email)
    assert r.status_code == 200, r.text
    challenge = r.json()
    r = tc.post("/api/agentic/signup-commit", json={
        "session_token": challenge["session_token"],
        "challenge_response": get_answer_for_question(challenge["challenge"]),
    })
    assert r.status_code == 200, r.text
    data = r.json()
    _approve_signup(tc, data, owner_email=owner_email)

    r = tc.get("/api/agentic/auth/challenge", headers=_bearer(data["api_key"]))
    assert r.status_code == 200, r.text
    mint = r.json()
    r = tc.post(
        "/api/agentic/auth/challenge_response",
        headers=_bearer(data["api_key"]),
        json={
            "session_token": mint["session_token"],
            "challenge_response": get_answer_for_question(mint["challenge"]),
        },
    )
    assert r.status_code == 200, r.text
    return data


def _add_member(
    tc: TestClient, token: str, channel_id: str, member_id: str | int, member_type: str = "human"
) -> dict:
    r = tc.post(
        f"/api/human/mm/channels/{channel_id}/members",
        json={"member_id": str(member_id), "member_type": member_type},
        headers=_bearer(token),
    )
    assert r.status_code == 200, r.text
    return r.json()


def _remove_human(tc: TestClient, token: str, channel_id: str, human_id: int) -> dict:
    r = tc.delete(
        f"/api/human/mm/channels/{channel_id}/members/{human_id}?member_type=human",
        headers=_bearer(token),
    )
    assert r.status_code == 200, r.text
    return r.json()


def _open_dm(
    tc: TestClient, token: str, org_id: str, target_id: str | int, target_type: str
) -> dict:
    r = tc.post(
        "/api/human/mm/direct",
        json={"org_id": org_id, "target_id": str(target_id), "target_type": target_type},
        headers=_bearer(token),
    )
    assert r.status_code == 200, r.text
    return r.json()


def _post(tc: TestClient, token: str, channel_id: str, message: str, **fields) -> dict:
    r = tc.post(
        f"/api/human/mm/channels/{channel_id}/posts",
        json={"message": message, **fields},
        headers=_bearer(token),
    )
    assert r.status_code == 200, r.text
    return r.json()


def _agent_post(tc: TestClient, api_key: str, channel_id: str, message: str, **fields) -> dict:
    r = tc.post(
        f"/api/agentic/mm/channels/{channel_id}/posts",
        json={"message": message, **fields},
        headers=_bearer(api_key),
    )
    assert r.status_code == 200, r.text
    return r.json()


def _posts(tc: TestClient, token: str, channel_id: str) -> list[dict]:
    r = tc.get(f"/api/human/mm/channels/{channel_id}/posts", headers=_bearer(token))
    assert r.status_code == 200, r.text
    return r.json()["posts"]


def _delete_post(tc: TestClient, token: str, post_id: int) -> None:
    r = tc.delete(f"/api/human/mm/posts/{post_id}", headers=_bearer(token))
    assert r.status_code == 204, r.text


def _react(tc: TestClient, token: str, post_id: int, emoji: str = "👍") -> dict:
    r = tc.post(f"/api/human/mm/posts/{post_id}/reactions", json={"emoji": emoji}, headers=_bearer(token))
    assert r.status_code == 200, r.text
    return r.json()


def _channel_row(tc: TestClient, token: str, channel_id: str) -> dict:
    r = tc.get("/api/human/mm/channels", headers=_bearer(token))
    assert r.status_code == 200, r.text
    return next(c for c in r.json()["channels"] if c["channel_id"] == channel_id)


def _read_pointer(tc: TestClient, channel_id: str, human_id: int) -> int | None:
    """``human_channel_state.last_read_post_id``, which no channel-list payload carries."""
    from sqlmodel import Session, select

    from clawbits.db.models import HumanChannelState

    with Session(tc.app._engine) as db:
        row = db.exec(
            select(HumanChannelState)
            .where(HumanChannelState.channel_id == channel_id)
            .where(HumanChannelState.human_id == human_id)
        ).first()
    return row.last_read_post_id if row else None


def _count_statements[T](tc: TestClient, read: Callable[..., T]) -> tuple[int, T]:
    from sqlalchemy import event
    from sqlmodel import Session

    seen: list[str] = []
    with Session(tc.app._engine) as db:
        event.listen(db.connection(), "before_cursor_execute", lambda *a: seen.append(a[2]))
        result = read(db)
    return len(seen), result


def test_human_create_and_list_channel(test_client):
    """Human can create a channel and see it in listing."""
    reg = _register_human(test_client, "bob@test.com", display_name="Bob")
    ch = _create_channel(test_client, reg["access_token"], "general", "public")
    assert ch["name"] == "general"
    assert ch["channel_type"] == "public"

    r = test_client.get("/api/human/mm/channels", headers=_bearer(reg["access_token"]))
    assert r.status_code == 200
    data = r.json()
    assert data["total"] >= 1
    assert any(c["channel_id"] == ch["channel_id"] for c in data["channels"])


def test_human_get_channel_info(test_client):
    """Members can get channel info; non-members cannot."""
    h1 = _register_human(test_client, "h1@test.com")
    h2 = _register_human(test_client, "h2@test.com")
    ch_id = _create_channel(test_client, h1["access_token"], "secret", "private")["channel_id"]

    r = test_client.get(f"/api/human/mm/channels/{ch_id}", headers=_bearer(h1["access_token"]))
    assert r.status_code == 200
    r = test_client.get(f"/api/human/mm/channels/{ch_id}", headers=_bearer(h2["access_token"]))
    assert r.status_code == 403


def test_human_adds_agent_member(test_client):
    """Human can add an agent they operate as a member of a channel."""
    h1 = _register_human(test_client, "owner@test.com", display_name="Owner")
    agent = _create_agent(test_client, owner_email="owner@test.com")
    ch_id = _create_channel(test_client, h1["access_token"], "mixed", "public")["channel_id"]

    members = _add_member(test_client, h1["access_token"], ch_id, agent["agent_id"], "agent")
    assert members["total"] == 2
    assert agent["agent_id"] in [m["agent_id"] for m in members["members"] if m.get("agent_id")]
    assert h1["user"]["id"] in [m["human_id"] for m in members["members"] if m.get("human_id")]


def test_trace_id_round_trips_human_to_agent_and_back(test_client):
    """A human send's ``trace_id`` is persisted, surfaced to the agent on the agentic GET,
    re-stamped by the agent onto its reply, and comes back on the human read. Untraced
    sends stay ``None``."""
    h1 = _register_human(test_client, "tracer@test.com", display_name="Tracer")
    token = h1["access_token"]
    agent = _create_agent(test_client, owner_email="tracer@test.com")
    ch_id = _create_channel(test_client, token, "trace-room", "public")["channel_id"]
    _add_member(test_client, token, ch_id, agent["agent_id"], "agent")
    trace_id = "tr_test_roundtrip_0001"

    assert _post(test_client, token, ch_id, "hello there", trace_id=trace_id)["trace_id"] == trace_id

    r = test_client.get(f"/api/agentic/mm/channels/{ch_id}/posts", headers=_bearer(agent["api_key"]))
    assert r.status_code == 200, r.text
    inbound = r.json()["posts"]
    assert any(p.get("trace_id") == trace_id for p in inbound), inbound

    reply = _agent_post(test_client, agent["api_key"], ch_id, "hi back", trace_id=trace_id)
    assert reply["trace_id"] == trace_id
    reply = next(p for p in _posts(test_client, token, ch_id) if p["message"] == "hi back")
    assert reply["trace_id"] == trace_id

    assert _post(test_client, token, ch_id, "no trace here")["trace_id"] is None


def test_human_adds_human_member(test_client):
    """Human can add another human as a member."""
    h1 = _register_human(test_client, "admin@test.com")
    h2 = _register_human(test_client, "user@test.com")
    _add_human_to_org(test_client, h1["access_token"], "user@test.com")
    ch_id = _create_channel(test_client, h1["access_token"], "team-chat", "public")["channel_id"]

    assert _add_member(test_client, h1["access_token"], ch_id, h2["user"]["id"])["total"] == 2
    r = test_client.get(f"/api/human/mm/channels/{ch_id}", headers=_bearer(h2["access_token"]))
    assert r.status_code == 200


def test_human_remove_member(test_client):
    """A human member can remove another member."""
    h1 = _register_human(test_client, "rem1@test.com")
    h2 = _register_human(test_client, "rem2@test.com")
    _add_human_to_org(test_client, h1["access_token"], "rem2@test.com")
    ch_id = _create_channel(test_client, h1["access_token"], "temp", "public")["channel_id"]
    _add_member(test_client, h1["access_token"], ch_id, h2["user"]["id"])

    assert _remove_human(test_client, h1["access_token"], ch_id, h2["user"]["id"])["total"] == 1
    r = test_client.get(f"/api/human/mm/channels/{ch_id}", headers=_bearer(h2["access_token"]))
    assert r.status_code == 403


def test_unread_mention_count_tracks_handle_and_here(test_client):
    """``unread_mention_count`` counts unread posts addressing the viewer by handle or
    ``@here``: a subset of ``unread_count``, never the viewer's own posts, bounded at the
    token (``@herring`` is not ``@here``), and cleared on read."""
    h1 = _register_human(test_client, "stanmention@test.com", display_name="Stan Lee")
    h2 = _register_human(test_client, "peermention@test.com")
    _add_human_to_org(test_client, h1["access_token"], "peermention@test.com")
    ch_id = _create_channel(test_client, h1["access_token"], "mentions", "public")["channel_id"]
    _add_member(test_client, h1["access_token"], ch_id, h2["user"]["id"])
    for msg in (
        "hey @Stan-Lee can you review",
        "@here standup in 5",
        "just a normal update, nothing tagged",
        "ping @herring (not me)",
    ):
        _post(test_client, h2["access_token"], ch_id, msg)

    ch = _channel_row(test_client, h1["access_token"], ch_id)
    assert ch["unread_count"] == 4
    assert ch["unread_mention_count"] == 2
    ch2 = _channel_row(test_client, h2["access_token"], ch_id)
    assert ch2["unread_count"] == 0
    assert ch2["unread_mention_count"] == 0

    r = test_client.post(
        f"/api/human/mm/channels/{ch_id}/read",
        json={"post_id": 10_000_000},
        headers=_bearer(h1["access_token"]),
    )
    assert r.status_code == 200, r.text
    ch = _channel_row(test_client, h1["access_token"], ch_id)
    assert ch["unread_count"] == 0
    assert ch["unread_mention_count"] == 0


def test_human_usage_command_replies_with_agent_balance_in_dm(test_client):
    """A human typing `/cb-usage` in a DM with an agent gets its CB_TOKENS as a reply."""
    agent = _create_agent(test_client)
    h1 = _register_human(test_client, "stan@clawbits.ai", display_name="Stan")
    token = h1["access_token"]
    dm = _open_dm(test_client, token, _get_personal_org_id(test_client, token), agent["agent_id"], "agent")
    assert dm["channel_type"] == "direct"

    post = _post(test_client, token, dm["channel_id"], "/cb-usage")
    assert post["message"] == "/cb-usage"
    assert post["human_id"] == h1["user"]["id"]

    posts = _posts(test_client, token, dm["channel_id"])
    by_msg = {p["message"]: p for p in posts}
    assert "/cb-usage" in by_msg
    reply = next(p for p in posts if p["message"].startswith("CB_TOKENS remaining:"))
    assert reply["agent_id"] == agent["agent_id"]
    assert reply["human_id"] is None
    assert reply["parent_post_id"] == by_msg["/cb-usage"]["post_id"]


def test_human_usage_command_is_plain_message_outside_dm(test_client):
    """`/cb-usage` is DM-only: in a non-direct channel it's stored as a normal message."""
    h1 = _register_human(test_client, "usage-room@test.com", display_name="Asker")
    token = h1["access_token"]
    agent = _create_agent(test_client, owner_email="usage-room@test.com")
    ch_id = _create_channel(test_client, token, "usage-room", "public")["channel_id"]
    _add_member(test_client, token, ch_id, agent["agent_id"], "agent")
    _post(test_client, token, ch_id, "/cb-usage")

    msgs = [p["message"] for p in _posts(test_client, token, ch_id)]
    assert msgs == ["/cb-usage"]
    assert not any(m.startswith("CB_TOKENS remaining:") for m in msgs)


def test_human_post_and_list_messages(test_client):
    """Human can post messages and read them back."""
    h1 = _register_human(test_client, "poster1@test.com", display_name="Poster1")
    h2 = _register_human(test_client, "poster2@test.com", display_name="Poster2")
    _add_human_to_org(test_client, h1["access_token"], "poster2@test.com")
    ch_id = _create_channel(test_client, h1["access_token"], "chat", "public")["channel_id"]
    _add_member(test_client, h1["access_token"], ch_id, h2["user"]["id"])

    post = _post(test_client, h1["access_token"], ch_id, "Hello from h1!")
    assert post["message"] == "Hello from h1!"
    assert post["human_id"] == h1["user"]["id"]
    _post(test_client, h2["access_token"], ch_id, "Hello from h2!")

    r = test_client.get(f"/api/human/mm/channels/{ch_id}/posts", headers=_bearer(h1["access_token"]))
    assert r.status_code == 200
    data = r.json()
    assert data["total"] == 2
    assert {"Hello from h1!", "Hello from h2!"} <= {p["message"] for p in data["posts"]}


def test_human_reply_to_own_post(test_client):
    """Replying to a post populates parent_post_id and parent_preview."""
    h1 = _register_human(test_client, "replier@test.com", display_name="Replier")
    token = h1["access_token"]
    ch_id = _create_channel(test_client, token, "reply-chat")["channel_id"]
    parent = _post(test_client, token, ch_id, "the original")

    reply = _post(test_client, token, ch_id, "first reply", parent_post_id=parent["post_id"])
    assert reply["parent_post_id"] == parent["post_id"]
    preview = reply["parent_preview"]
    assert preview["post_id"] == parent["post_id"]
    assert preview["message_excerpt"] == "the original"
    assert preview["status"] == "published"
    assert preview["human_id"] == h1["user"]["id"]
    assert preview["poster_display_name"] == "Replier"

    reply_row = next(p for p in _posts(test_client, token, ch_id) if p["post_id"] == reply["post_id"])
    assert reply_row["parent_post_id"] == parent["post_id"]
    assert reply_row["parent_preview"]["message_excerpt"] == "the original"


def test_human_reply_to_missing_parent_rejected(test_client):
    """Replying to a non-existent post_id returns 400."""
    h1 = _register_human(test_client, "missing@test.com")
    ch_id = _create_channel(test_client, h1["access_token"], "missing-chat")["channel_id"]
    r = test_client.post(
        f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "ghost reply", "parent_post_id": 9_999_999},
        headers=_bearer(h1["access_token"]),
    )
    assert r.status_code == 400, r.text


def test_human_reply_across_channels_rejected(test_client):
    """Parent must live in the same channel as the reply."""
    h1 = _register_human(test_client, "cross@test.com")
    ch_a = _create_channel(test_client, h1["access_token"], "ch-a")["channel_id"]
    ch_b = _create_channel(test_client, h1["access_token"], "ch-b")["channel_id"]
    parent = _post(test_client, h1["access_token"], ch_a, "in A")
    r = test_client.post(
        f"/api/human/mm/channels/{ch_b}/posts",
        json={"message": "from B replying to A", "parent_post_id": parent["post_id"]},
        headers=_bearer(h1["access_token"]),
    )
    assert r.status_code == 400, r.text


def test_human_reply_excerpt_truncated_for_long_parent(test_client):
    """parent_preview.message_excerpt is truncated server-side so SSE/REST stays bounded."""
    h1 = _register_human(test_client, "long@test.com")
    token = h1["access_token"]
    ch_id = _create_channel(test_client, token, "long-chat")["channel_id"]
    parent = _post(test_client, token, ch_id, "x" * 500)
    excerpt = _post(test_client, token, ch_id, "short", parent_post_id=parent["post_id"])[
        "parent_preview"
    ]["message_excerpt"]
    assert len(excerpt) <= 140
    assert excerpt.endswith("…")


def test_human_edit_own_post_stamps_edited_at(test_client):
    """Editing own post replaces the text and stamps a permanent ``edited_at``."""
    h1 = _register_human(test_client, "editor@test.com", display_name="Editor")
    token = h1["access_token"]
    ch_id = _create_channel(test_client, token, "edit-chat")["channel_id"]
    post = _post(test_client, token, ch_id, "first draft")
    assert post["edited_at"] is None
    assert post["published_at"] == post["created_at"]

    r = test_client.patch(
        f"/api/human/mm/posts/{post['post_id']}",
        json={"message": "the polished version"},
        headers=_bearer(token),
    )
    assert r.status_code == 200, r.text
    edited = r.json()
    assert edited["message"] == "the polished version"
    assert edited["edited_at"] is not None

    row = next(p for p in _posts(test_client, token, ch_id) if p["post_id"] == post["post_id"])
    assert row["message"] == "the polished version"
    assert row["edited_at"] == edited["edited_at"]
    assert row["published_at"] == post["published_at"]


def test_human_edit_missing_post_404(test_client):
    h1 = _register_human(test_client, "edit-missing@test.com")
    r = test_client.patch(
        "/api/human/mm/posts/9999999",
        json={"message": "ghost"},
        headers=_bearer(h1["access_token"]),
    )
    assert r.status_code == 404


def test_human_edit_empty_message_rejected(test_client):
    """Empty edits are rejected by the schema's min_length=1."""
    h1 = _register_human(test_client, "edit-empty@test.com")
    ch_id = _create_channel(test_client, h1["access_token"], "edit-empty")["channel_id"]
    post = _post(test_client, h1["access_token"], ch_id, "real content")
    r = test_client.patch(
        f"/api/human/mm/posts/{post['post_id']}",
        json={"message": ""},
        headers=_bearer(h1["access_token"]),
    )
    assert r.status_code == 422


def test_human_delete_own_post_round_trip(test_client):
    """Author can delete their own post; it disappears from the channel."""
    h1 = _register_human(test_client, "del-author@test.com", display_name="Author")
    token = h1["access_token"]
    ch_id = _create_channel(test_client, token, "del-chat")["channel_id"]
    post = _post(test_client, token, ch_id, "to be deleted")

    _delete_post(test_client, token, post["post_id"])
    assert all(p["post_id"] != post["post_id"] for p in _posts(test_client, token, ch_id))


def test_human_delete_refreshes_channel_preview(test_client):
    """Regression: deleting the newest post rebuilds the denormalised sidebar preview, and
    deleting the last remaining post clears it, instead of leaving the deleted text."""
    h1 = _register_human(test_client, "del-preview@test.com", display_name="Prue")
    token = h1["access_token"]
    ch_id = _create_channel(test_client, token, "del-preview")["channel_id"]
    first = _post(test_client, token, ch_id, "the older one")
    second = _post(test_client, token, ch_id, "the newest one")
    assert _channel_row(test_client, token, ch_id)["last_message_text"] == "the newest one"

    _delete_post(test_client, token, second["post_id"])
    ch = _channel_row(test_client, token, ch_id)
    assert ch["last_message_text"] == "the older one"
    assert ch["last_message_author_human_id"] == h1["user"]["id"]

    _delete_post(test_client, token, first["post_id"])
    ch = _channel_row(test_client, token, ch_id)
    assert ch["last_message_text"] is None
    assert ch["last_message_author_human_id"] is None
    assert ch["last_message_author_display_name"] is None


def test_human_delete_preserves_read_pointer(test_client):
    """Regression: deleting the post a caught-up reader points at must slide the pointer to
    the newest survivor, not null it and relight the whole history as unread."""
    author = _register_human(test_client, "del-unread-a@test.com", display_name="Ann")
    reader = _register_human(test_client, "del-unread-b@test.com", display_name="Bea")
    _add_human_to_org(test_client, author["access_token"], "del-unread-b@test.com")
    ch_id = _create_channel(test_client, author["access_token"], "del-unread")["channel_id"]
    _add_member(test_client, author["access_token"], ch_id, reader["user"]["id"])
    posts = [_post(test_client, author["access_token"], ch_id, f"message {i}") for i in range(4)]
    assert _channel_row(test_client, reader["access_token"], ch_id)["unread_count"] == 4

    r = test_client.post(
        f"/api/human/mm/channels/{ch_id}/read",
        json={"post_id": posts[-1]["post_id"]},
        headers=_bearer(reader["access_token"]),
    )
    assert r.status_code == 200, r.text
    assert _channel_row(test_client, reader["access_token"], ch_id)["unread_count"] == 0

    _delete_post(test_client, author["access_token"], posts[-1]["post_id"])
    assert _channel_row(test_client, reader["access_token"], ch_id)["unread_count"] == 0, (
        "deleting a read post must not resurrect unreads"
    )
    assert _read_pointer(test_client, ch_id, reader["user"]["id"]) == posts[-2]["post_id"]

    _post(test_client, author["access_token"], ch_id, "after the delete")
    assert _channel_row(test_client, reader["access_token"], ch_id)["unread_count"] == 1


def test_human_delete_only_post_clears_read_pointer(test_client):
    """With nothing older to point at, the pointer goes back to NULL and the channel reads
    as empty rather than unread."""
    author = _register_human(test_client, "del-only-a@test.com", display_name="Cal")
    reader = _register_human(test_client, "del-only-b@test.com", display_name="Dee")
    _add_human_to_org(test_client, author["access_token"], "del-only-b@test.com")
    ch_id = _create_channel(test_client, author["access_token"], "del-only")["channel_id"]
    _add_member(test_client, author["access_token"], ch_id, reader["user"]["id"])
    post = _post(test_client, author["access_token"], ch_id, "the only one")
    test_client.post(
        f"/api/human/mm/channels/{ch_id}/read",
        json={"post_id": post["post_id"]},
        headers=_bearer(reader["access_token"]),
    )

    _delete_post(test_client, author["access_token"], post["post_id"])
    assert _channel_row(test_client, reader["access_token"], ch_id)["unread_count"] == 0
    assert _read_pointer(test_client, ch_id, reader["user"]["id"]) is None


def test_human_edit_refreshes_channel_preview(test_client):
    """Editing the newest post rewrites the sidebar preview too."""
    h1 = _register_human(test_client, "edit-preview@test.com", display_name="Ed")
    token = h1["access_token"]
    ch_id = _create_channel(test_client, token, "edit-preview")["channel_id"]
    post = _post(test_client, token, ch_id, "typo verison")
    r = test_client.patch(
        f"/api/human/mm/posts/{post['post_id']}",
        json={"message": "typo version"},
        headers=_bearer(token),
    )
    assert r.status_code == 200, r.text
    assert _channel_row(test_client, token, ch_id)["last_message_text"] == "typo version"


def test_human_delete_other_user_post_forbidden(test_client):
    """A non-author, non-creator member cannot delete someone else's post."""
    h1 = _register_human(test_client, "del-owner@test.com")
    h2 = _register_human(test_client, "del-intruder@test.com")
    _add_human_to_org(test_client, h1["access_token"], "del-intruder@test.com")
    ch_id = _create_channel(test_client, h1["access_token"], "del-locked")["channel_id"]
    _add_member(test_client, h1["access_token"], ch_id, h2["user"]["id"])
    post = _post(test_client, h2["access_token"], ch_id, "h2 can't touch this")

    h3 = _register_human(test_client, "del-bystander@test.com")
    _add_human_to_org(test_client, h1["access_token"], "del-bystander@test.com")
    _add_member(test_client, h1["access_token"], ch_id, h3["user"]["id"])
    r = test_client.delete(f"/api/human/mm/posts/{post['post_id']}", headers=_bearer(h3["access_token"]))
    assert r.status_code == 403, r.text


def test_human_channel_creator_can_delete_anyone(test_client):
    """The channel creator may delete a member's post for moderation."""
    creator = _register_human(test_client, "del-creator@test.com")
    member = _register_human(test_client, "del-member@test.com")
    _add_human_to_org(test_client, creator["access_token"], "del-member@test.com")
    ch_id = _create_channel(test_client, creator["access_token"], "del-mod")["channel_id"]
    _add_member(test_client, creator["access_token"], ch_id, member["user"]["id"])
    post = _post(test_client, member["access_token"], ch_id, "moderate me")
    _delete_post(test_client, creator["access_token"], post["post_id"])


def test_human_delete_missing_post_404(test_client):
    h1 = _register_human(test_client, "del-missing@test.com")
    r = test_client.delete("/api/human/mm/posts/9999999", headers=_bearer(h1["access_token"]))
    assert r.status_code == 404


def test_human_delete_detaches_replies(test_client):
    """Deleting a post detaches its replies (parent_post_id -> NULL); the replies survive."""
    h1 = _register_human(test_client, "del-thread@test.com")
    token = h1["access_token"]
    ch_id = _create_channel(test_client, token, "del-thread")["channel_id"]
    parent = _post(test_client, token, ch_id, "parent")
    reply = _post(test_client, token, ch_id, "reply", parent_post_id=parent["post_id"])
    assert reply["parent_post_id"] == parent["post_id"]

    _delete_post(test_client, token, parent["post_id"])
    survivors = {p["post_id"]: p for p in _posts(test_client, token, ch_id)}
    assert parent["post_id"] not in survivors
    assert reply["post_id"] in survivors
    assert survivors[reply["post_id"]]["parent_post_id"] is None


def test_human_reaction_toggle_round_trip(test_client):
    """Toggle adds on first call, removes on second; counts aggregate correctly."""
    h1 = _register_human(test_client, "reactor@test.com", display_name="Reactor")
    token = h1["access_token"]
    ch_id = _create_channel(test_client, token, "react-chat")["channel_id"]
    post = _post(test_client, token, ch_id, "react to me")

    assert _react(test_client, token, post["post_id"])["reactions"] == [
        {"emoji": "👍", "count": 1, "human_ids": [h1["user"]["id"]], "agent_ids": []},
    ]
    assert _react(test_client, token, post["post_id"])["reactions"] == []


def test_human_reaction_on_missing_post_404(test_client):
    """Reacting to a non-existent post returns 404."""
    h1 = _register_human(test_client, "ghost@test.com")
    r = test_client.post(
        "/api/human/mm/posts/9999999/reactions",
        json={"emoji": "👍"},
        headers=_bearer(h1["access_token"]),
    )
    assert r.status_code == 404


def test_human_non_member_cannot_post(test_client):
    """Non-members cannot post to a channel."""
    h1 = _register_human(test_client, "priv1@test.com")
    h2 = _register_human(test_client, "priv2@test.com")
    ch_id = _create_channel(test_client, h1["access_token"], "private-chat", "private")["channel_id"]
    r = test_client.post(
        f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "sneaky!"},
        headers=_bearer(h2["access_token"]),
    )
    assert r.status_code == 403


def test_mixed_channel_human_and_agent_posts(test_client):
    """Humans and agents can post to the same channel and see each other's messages."""
    h1 = _register_human(test_client, "mixer@test.com", display_name="Mixer")
    token = h1["access_token"]
    agent = _create_agent(test_client, owner_email="mixer@test.com")
    ch_id = _create_channel(test_client, token, "mixed-chat", "public")["channel_id"]
    _add_member(test_client, token, ch_id, agent["agent_id"], "agent")
    _post(test_client, token, ch_id, "Hello from human!")
    _agent_post(test_client, agent["api_key"], ch_id, "Hello from agent!")

    assert {"Hello from human!", "Hello from agent!"} <= {
        p["message"] for p in _posts(test_client, token, ch_id)
    }
    r = test_client.get(f"/api/agentic/mm/channels/{ch_id}/posts", headers=_bearer(agent["api_key"]))
    assert r.status_code == 200
    assert {"Hello from human!", "Hello from agent!"} <= {p["message"] for p in r.json()["posts"]}


def test_human_dm_with_agent(test_client):
    """Human can create a DM with an agent and exchange messages."""
    agent = _create_agent(test_client)
    h1 = _register_human(test_client, "stan@clawbits.ai", display_name="Stan")
    token = h1["access_token"]
    org_id = _get_personal_org_id(test_client, token)

    dm = _open_dm(test_client, token, org_id, agent["agent_id"], "agent")
    assert dm["channel_type"] == "direct"
    assert dm["org_id"] == org_id
    _post(test_client, token, dm["channel_id"], "Hi agent!")
    _agent_post(test_client, agent["api_key"], dm["channel_id"], "Hi human!")

    assert {"Hi agent!", "Hi human!"} <= {p["message"] for p in _posts(test_client, token, dm["channel_id"])}


def test_human_dm_with_human(test_client):
    """Two humans can create a DM and exchange messages."""
    h1 = _register_human(test_client, "dm1@test.com", display_name="DmOne")
    h2 = _register_human(test_client, "dm2@test.com", display_name="DmTwo")
    org_id = _get_personal_org_id(test_client, h1["access_token"])
    _add_human_to_org(test_client, h1["access_token"], "dm2@test.com")

    dm = _open_dm(test_client, h1["access_token"], org_id, h2["user"]["id"], "human")
    assert dm["channel_type"] == "direct"
    assert dm["org_id"] == org_id
    _post(test_client, h1["access_token"], dm["channel_id"], "Hello DM!")
    _post(test_client, h2["access_token"], dm["channel_id"], "Hey back!")

    assert {"Hello DM!", "Hey back!"} <= {
        p["message"] for p in _posts(test_client, h2["access_token"], dm["channel_id"])
    }


def test_human_dm_deduplication(test_client):
    """Opening a DM twice between the same humans, from either side, returns one channel."""
    h1 = _register_human(test_client, "dedup1@test.com")
    h2 = _register_human(test_client, "dedup2@test.com")
    org_id = _get_personal_org_id(test_client, h1["access_token"])
    _add_human_to_org(test_client, h1["access_token"], "dedup2@test.com")

    dm1 = _open_dm(test_client, h1["access_token"], org_id, h2["user"]["id"], "human")
    dm2 = _open_dm(test_client, h2["access_token"], org_id, h1["user"]["id"], "human")
    assert dm1["channel_id"] == dm2["channel_id"]


def test_human_dm_with_self_rejected(test_client):
    """Cannot create a DM with yourself."""
    h1 = _register_human(test_client, "selfie@test.com")
    org_id = _get_personal_org_id(test_client, h1["access_token"])
    r = test_client.post(
        "/api/human/mm/direct",
        json={"org_id": org_id, "target_id": str(h1["user"]["id"]), "target_type": "human"},
        headers=_bearer(h1["access_token"]),
    )
    assert r.status_code == 400


def test_human_dm_agent_deduplication(test_client):
    """Opening the same human↔agent DM twice returns the same channel."""
    agent = _create_agent(test_client)
    h1 = _register_human(test_client, "stan@clawbits.ai", display_name="Stan")
    org_id = _get_personal_org_id(test_client, h1["access_token"])
    dm1 = _open_dm(test_client, h1["access_token"], org_id, agent["agent_id"], "agent")
    dm2 = _open_dm(test_client, h1["access_token"], org_id, agent["agent_id"], "agent")
    assert dm1["channel_id"] == dm2["channel_id"]


def test_unauthenticated_human_rejected(test_client):
    """Requests without a valid JWT are rejected."""
    r = test_client.get("/api/human/mm/channels")
    assert r.status_code in (401, 403)

    r = test_client.get("/api/human/mm/channels", headers={"Authorization": "Bearer invalid"})
    assert r.status_code == 401


def test_delete_channel_purges_channel_events(test_client):
    """Regression: ``delete_mm_channel`` must purge ``mm_channel_events``, whose FK has no
    ON DELETE CASCADE, or deleting such a channel raises a ForeignKeyViolation."""
    from datetime import UTC, datetime

    from sqlmodel import Session, select

    from clawbits.db.models import MmChannel, MmChannelEvent
    from clawbits.db.table_write import TableWrite

    human_id = _register_human(test_client, "delevents@test.com")["user"]["id"]
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
            select(MmChannelEvent).where(MmChannelEvent.channel_id == "del_ev_ch")
        ).all()
        assert leftover == [], "channel events were not purged on delete"


def test_last_human_leaving_deletes_channel(test_client):
    """When the only human leaves a channel, the channel is hard-deleted rather than left
    as an agent-only husk."""
    from sqlmodel import Session

    from clawbits.db.models import MmChannel

    h1 = _register_human(test_client, "lastleave@test.com")
    agent = _create_agent(test_client, owner_email="lastleave@test.com")
    ch_id = _create_channel(test_client, h1["access_token"], "soloch", "public")["channel_id"]
    _add_member(test_client, h1["access_token"], ch_id, agent["agent_id"], "agent")

    body = _remove_human(test_client, h1["access_token"], ch_id, h1["user"]["id"])
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
    ch_id = _open_dm(test_client, h1["access_token"], org_id, agent["agent_id"], "agent")["channel_id"]

    assert _remove_human(test_client, h1["access_token"], ch_id, h1["user"]["id"])["channel_deleted"] is True
    with Session(test_client.app._engine) as db:
        assert db.get(MmChannel, ch_id) is None


def test_leaving_channel_with_other_humans_keeps_it(test_client):
    """Leaving is non-destructive while another human remains a member."""
    h1 = _register_human(test_client, "keep1@test.com")
    h2 = _register_human(test_client, "keep2@test.com")
    _add_human_to_org(test_client, h1["access_token"], "keep2@test.com")
    ch_id = _create_channel(test_client, h1["access_token"], "keepch", "public")["channel_id"]
    _add_member(test_client, h1["access_token"], ch_id, h2["user"]["id"])

    body = _remove_human(test_client, h1["access_token"], ch_id, h1["user"]["id"])
    assert body["channel_deleted"] is False
    assert body["total"] == 1
    r = test_client.get(f"/api/human/mm/channels/{ch_id}", headers=_bearer(h2["access_token"]))
    assert r.status_code == 200


def test_creator_deletes_channel_with_other_humans(test_client):
    """The creator can delete a channel outright even while other humans remain."""
    h1 = _register_human(test_client, "owner1@test.com")
    h2 = _register_human(test_client, "owner2@test.com")
    _add_human_to_org(test_client, h1["access_token"], "owner2@test.com")
    ch_id = _create_channel(test_client, h1["access_token"], "ownerch", "public")["channel_id"]
    _add_member(test_client, h1["access_token"], ch_id, h2["user"]["id"])

    r = test_client.delete(f"/api/human/mm/channels/{ch_id}", headers=_bearer(h1["access_token"]))
    assert r.status_code == 204, r.text
    for h in (h1, h2):
        r = test_client.get(f"/api/human/mm/channels/{ch_id}", headers=_bearer(h["access_token"]))
        assert r.status_code in (403, 404)


def test_non_creator_cannot_delete_channel(test_client):
    """A member who didn't create the channel gets 403 from the delete endpoint."""
    h1 = _register_human(test_client, "ncreate1@test.com")
    h2 = _register_human(test_client, "ncreate2@test.com")
    _add_human_to_org(test_client, h1["access_token"], "ncreate2@test.com")
    ch_id = _create_channel(test_client, h1["access_token"], "ncch", "public")["channel_id"]
    _add_member(test_client, h1["access_token"], ch_id, h2["user"]["id"])

    r = test_client.delete(f"/api/human/mm/channels/{ch_id}", headers=_bearer(h2["access_token"]))
    assert r.status_code == 403, r.text
    r = test_client.get(f"/api/human/mm/channels/{ch_id}", headers=_bearer(h1["access_token"]))
    assert r.status_code == 200


def test_outsider_cannot_delete_channel(test_client):
    """Someone who is neither the creator nor an org owner gets 403."""
    h1 = _register_human(test_client, "nmem1@test.com")
    h2 = _register_human(test_client, "nmem2@test.com")
    ch_id = _create_channel(test_client, h1["access_token"], "nmemch", "public")["channel_id"]
    r = test_client.delete(f"/api/human/mm/channels/{ch_id}", headers=_bearer(h2["access_token"]))
    assert r.status_code == 403, r.text


def test_org_owner_deletes_channel_created_by_another(test_client):
    """An org owner can delete a channel they did not create: the owner role authorises it."""
    from datetime import UTC, datetime

    from sqlmodel import Session

    from clawbits.db.models import MmChannel, MmChannelMember

    owner = _register_human(test_client, "chowner@test.com")
    creator = _register_human(test_client, "chcreator@test.com")
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

    r = test_client.delete("/api/human/mm/channels/owner_del_ch", headers=_bearer(owner["access_token"]))
    assert r.status_code == 204, r.text
    r = test_client.get("/api/human/mm/channels/owner_del_ch", headers=_bearer(owner["access_token"]))
    assert r.status_code in (403, 404)


def test_deleting_channel_notifies_agent_members(test_client, monkeypatch):
    """Deleting a channel fans out ``channel.removed`` to agent members so their plugins
    drop it."""
    from datetime import UTC, datetime

    from sqlmodel import Session

    import clawbits.fastapi.human_mm_endpoints as mm_endpoints
    from clawbits.db.models import MmChannel, MmChannelMember

    calls: list[tuple[str, str]] = []

    async def _record(_bus, agent_id, channel_id):
        calls.append((agent_id, channel_id))

    monkeypatch.setattr(mm_endpoints, "publish_agent_channel_removed", _record)

    h1 = _register_human(test_client, "agfanout@test.com")
    agent_id = _create_agent(test_client, owner_email="agfanoutop@clawbits.ai")["agent_id"]
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

    r = test_client.delete("/api/human/mm/channels/ag_fanout_ch", headers=_bearer(h1["access_token"]))
    assert r.status_code == 204, r.text
    assert (agent_id, "ag_fanout_ch") in calls


def test_delete_agent_rebuilds_stale_channel_preview(test_client):
    """Deleting an agent that authored a channel's last message rebuilds the sidebar
    preview from the surviving posts; the channel survives because a human remains."""
    from datetime import UTC, datetime

    from sqlmodel import Session

    from clawbits.db.models import MmChannel, MmChannelMember, MmPost
    from clawbits.db.table_write import TableWrite

    human_id = _register_human(test_client, "previewfix@test.com", display_name="Pam")["user"]["id"]
    agent_id = _create_agent(test_client, owner_email="previewagent@clawbits.ai")["agent_id"]
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


def test_unread_counts_are_capped(test_client):
    """``unread_count`` and ``unread_mention_count`` stop at ``UNREAD_COUNT_CAP`` (a value at
    the cap means "at least"), and are exact again below it."""
    from datetime import UTC, datetime

    from sqlmodel import Session, select

    from clawbits.db.models import MmChannel, MmChannelMember, MmPost
    from clawbits.db.table_read import UNREAD_COUNT_CAP, TableRead

    h1 = _register_human(test_client, "capviewer@test.com", display_name="Cap Viewer")
    h2 = _register_human(test_client, "cappeer@test.com")
    token, viewer_id, peer_id = h1["access_token"], h1["user"]["id"], h2["user"]["id"]
    now = datetime.now(UTC)
    with Session(test_client.app._engine) as db:
        db.add(MmChannel(
            channel_id="cap_ch", name="cap", channel_type="public", created_at=now,
        ))
        db.add(MmChannelMember(channel_id="cap_ch", human_id=viewer_id, joined_at=now))
        db.add(MmChannelMember(channel_id="cap_ch", human_id=peer_id, joined_at=now))
        for i in range(UNREAD_COUNT_CAP + 25):
            db.add(MmPost(
                channel_id="cap_ch", human_id=peer_id,
                message=f"@here message {i}", status="published", created_at=now,
            ))
        db.commit()

    ch = _channel_row(test_client, token, "cap_ch")
    assert ch["unread_count"] == UNREAD_COUNT_CAP
    assert ch["unread_mention_count"] == UNREAD_COUNT_CAP

    # latest_post_id and last_message_at must come from the same post; the id is internal
    # to the read path, so assert on the accessor.
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

    r = test_client.post(
        "/api/human/mm/channels/cap_ch/read",
        json={"post_id": newest.post_id - 25},
        headers=_bearer(token),
    )
    assert r.status_code == 200, r.text
    ch = _channel_row(test_client, token, "cap_ch")
    assert ch["unread_count"] == 25
    assert ch["unread_mention_count"] == 25


def test_a_posts_page_costs_the_same_statements_at_any_size(test_client):
    """Hydration loads each relation of a page in one query, so a page of many
    reacted replies runs exactly as many statements as a page of two."""
    from clawbits.db.table_read import TableRead

    h1 = _register_human(test_client, "batch@test.com")
    token, human_id = h1["access_token"], h1["user"]["id"]
    ch_id = _create_channel(test_client, token, "batch-chat")["channel_id"]

    def send(parent_post_id: int | None = None) -> int:
        post_id = _post(test_client, token, ch_id, "hello", parent_post_id=parent_post_id)["post_id"]
        _react(test_client, token, post_id)
        return post_id

    def page(db) -> list[dict]:
        return TableRead.get_mm_posts_for_human(db, ch_id, human_id)

    root = send()
    send(root)
    few, _ = _count_statements(test_client, page)
    for _ in range(15):
        send(root)
    many, posts = _count_statements(test_client, page)
    assert (many, len(posts)) == (few, 17)
    reaction = {"emoji": "👍", "count": 1, "human_ids": [human_id], "agent_ids": []}
    assert all(p["reactions"] == [reaction] for p in posts)
    assert {p["parent_preview"]["post_id"] for p in posts if p["post_id"] != root} == {root}


def test_send_returns_before_the_link_preview_lands(test_client, monkeypatch):
    """A cold unfurl must not hold the send: the post publishes bare, and the
    preview follows as a ``post.updated`` once it resolves."""
    import asyncio
    import threading
    import time

    import clawbits.fastapi.human_mm_endpoints as mm_endpoints
    from clawbits.link_preview.service import LinkPreview
    from clawbits.realtime import bus as bus_module

    h1 = _register_human(test_client, "unfurl@test.com")
    token = h1["access_token"]
    ch_id = _create_channel(test_client, token, "unfurl-chat")["channel_id"]

    class Bus:
        def __init__(self) -> None:
            self.published: list[dict] = []

        async def redis_client(self) -> None:
            return None

        async def publish(self, _topic: str, event: dict) -> None:
            self.published.append(event)

        async def presence_clear(self, *_args) -> None:
            return None

    released = threading.Event()

    async def unfurl(_redis, url: str) -> LinkPreview:
        while not released.is_set():
            await asyncio.sleep(0.01)
        return LinkPreview(
            url=url, canonical_url=None, title="Example", description=None,
            image_url=None, site_name=None, fetched_at=0.0,
        )

    bus = Bus()
    monkeypatch.setattr(bus_module, "_bus", bus)
    monkeypatch.setattr(mm_endpoints, "get_link_preview", unfurl)

    post = _post(test_client, token, ch_id, "see https://example.com")
    assert post["link_preview"] is None
    released.set()

    deadline = time.monotonic() + 5
    while not (updates := [e for e in bus.published if e["type"] == "post.updated"]):
        assert time.monotonic() < deadline, "the link preview never landed"
        time.sleep(0.01)
    assert updates[0]["data"]["post_id"] == post["post_id"]
    assert updates[0]["data"]["link_preview"]["title"] == "Example"
    assert _posts(test_client, token, ch_id)[0]["link_preview"]["title"] == "Example"


def test_a_late_link_preview_skips_an_edited_post(test_client):
    """The unfurl can finish after an edit; it only lands on the message it
    was fetched for."""
    from sqlmodel import Session

    from clawbits.db.models import MmPost
    from clawbits.db.table_write import TableWrite

    h1 = _register_human(test_client, "late-unfurl@test.com")
    ch_id = _create_channel(test_client, h1["access_token"], "late-unfurl-chat")["channel_id"]
    post_id = _post(test_client, h1["access_token"], ch_id, "old")["post_id"]
    preview = {"url": "https://example.com", "title": "Example"}

    with Session(test_client.app._engine) as db:
        assert not TableWrite.set_mm_post_link_preview(db, post_id, "new", preview)
        assert TableWrite.set_mm_post_link_preview(db, post_id, "old", preview)
        db.commit()
        assert db.get(MmPost, post_id).link_preview == preview


def test_the_channel_list_embeds_each_dm_peer_at_a_fixed_cost(test_client, monkeypatch):
    """Each DM row carries its peer exactly as the members endpoint shows it to
    the viewer, privacy and read receipts applied, for the same statements and
    one presence MGET however many DMs the list holds."""
    from clawbits.db.table_read import TableRead
    from clawbits.realtime import get_bus

    viewer = _register_human(test_client, "dm-peers@test.com", display_name="Viewer")
    token, viewer_id = viewer["access_token"], viewer["user"]["id"]
    org_id = _get_personal_org_id(test_client, token)

    def human_dm(i: int) -> tuple[str, dict]:
        email = f"dm-peer-{i}@test.com"
        peer = _register_human(test_client, email, display_name=f"Peer {i}")
        _add_human_to_org(test_client, token, email)
        channel_id = _open_dm(test_client, token, org_id, peer["user"]["id"], "human")["channel_id"]
        _post(test_client, peer["access_token"], channel_id, "hi")
        if i % 2:
            r = test_client.patch(
                "/api/human/privacy-settings",
                json={
                    "online_status_visible": False,
                    "last_seen_visible": False,
                    "read_receipts_enabled": False,
                },
                headers=_bearer(peer["access_token"]),
            )
            assert r.status_code == 200, r.text
        return channel_id, peer

    def statements() -> int:
        return _count_statements(
            test_client,
            lambda db: TableRead.get_mm_channels_for_human(db, viewer_id, org_id=org_id),
        )[0]

    left, gone = human_dm(0)
    _remove_human(test_client, gone["access_token"], left, gone["user"]["id"])
    human_dm(1)
    _create_agent(test_client, owner_email="dm-peers@test.com")
    few = statements()
    human_dm(2)
    human_dm(3)
    _create_agent(test_client, owner_email="dm-peers@test.com")
    assert statements() == few

    group = _create_channel(test_client, token, "dm-peers-group")["channel_id"]
    presence_reads: list[list[int]] = []
    bus = get_bus()
    read_many = bus.user_presence_get_many

    async def spy(human_ids: list[int]) -> dict:
        presence_reads.append(human_ids)
        return await read_many(human_ids)

    monkeypatch.setattr(bus, "user_presence_get_many", spy)
    r = test_client.get(f"/api/human/mm/channels?org_id={org_id}", headers=_bearer(token))
    assert r.status_code == 200, r.text
    assert len(presence_reads) == 1
    channels = {c["channel_id"]: c for c in r.json()["channels"]}
    assert channels[group]["dm_peer"] is None
    dms = [c for c in channels.values() if c["channel_type"] == "direct"]
    assert len(dms) == 6
    for c in dms:
        members = test_client.get(
            f"/api/human/mm/channels/{c['channel_id']}/members", headers=_bearer(token)
        ).json()["members"]
        assert c["dm_peer"] == next((m for m in members if m["human_id"] != viewer_id), None)


def test_the_timeline_never_splits_rows_that_share_a_timestamp(test_client):
    """A page ends before a tie group that straddles it, so the timestamp cursor skips nothing."""
    from sqlmodel import Session

    from clawbits.db.models import MmPost

    token = _register_human(test_client, "timeline-ties@test.com")["access_token"]
    ch_id = _create_channel(test_client, token, "timeline-ties")["channel_id"]
    for i in range(4):
        _post(test_client, token, ch_id, f"p{i}")
    ids = sorted(p["post_id"] for p in _posts(test_client, token, ch_id))
    with Session(test_client.app._engine) as db:
        tied = db.get(MmPost, ids[2])
        tied.created_at = db.get(MmPost, ids[1]).created_at
        db.add(tied)
        db.commit()

    seen: list[int] = []
    cursor = None
    for _ in ids:
        r = test_client.get(
            f"/api/human/mm/channels/{ch_id}/timeline",
            params={"limit": 2, "before_created_at": cursor},
            headers=_bearer(token),
        )
        assert r.status_code == 200, r.text
        page = r.json()
        seen += [row["post"]["post_id"] for row in page["rows"] if row["kind"] == "post"]
        if (cursor := page["next_cursor"]) is None:
            break
    assert sorted(seen) == ids


def test_the_timeline_pages_every_post_and_event_exactly_once(test_client):
    """``next_cursor`` walks the merged timeline back: each post and inline event lands on
    exactly one page."""
    owner = _register_human(test_client, "timeline@test.com")
    token = owner["access_token"]
    ch_id = _create_channel(test_client, token, "timeline-chat")["channel_id"]
    for i in range(3):
        email = f"timeline-{i}@test.com"
        joiner = _register_human(test_client, email)
        _add_human_to_org(test_client, token, email)
        _post(test_client, token, ch_id, f"before {i}")
        _add_member(test_client, token, ch_id, joiner["user"]["id"])
        _post(test_client, token, ch_id, f"after {i}")

    r = test_client.get(f"/api/human/mm/channels/{ch_id}/inline-events", headers=_bearer(token))
    assert r.status_code == 200, r.text
    expected = [("post", p["post_id"]) for p in _posts(test_client, token, ch_id)]
    expected += [("event", e["event_id"]) for e in r.json()["events"]]
    assert len(expected) >= 9

    seen: list[tuple[str, int]] = []
    cursor = None
    for _ in expected:
        r = test_client.get(
            f"/api/human/mm/channels/{ch_id}/timeline",
            params={"limit": 2, "before_created_at": cursor},
            headers=_bearer(token),
        )
        assert r.status_code == 200, r.text
        page = r.json()
        seen += [
            ("post", row["post"]["post_id"]) if row["kind"] == "post"
            else ("event", row["event"]["event_id"])
            for row in page["rows"]
        ]
        if (cursor := page["next_cursor"]) is None:
            break
    assert sorted(seen) == sorted(expected)


def test_the_export_names_the_file_for_any_channel_name(test_client):
    """The attachment header stays ASCII: a ``filename`` fallback, and ``filename*`` carrying
    a non-latin channel name. An ASCII name keeps its file name."""
    from datetime import UTC, datetime
    from urllib.parse import quote

    token = _register_human(test_client, "export-names@test.com")["access_token"]
    today = datetime.now(UTC).date().isoformat()

    def export(name: str) -> tuple[str, str]:
        ch_id = _create_channel(test_client, token, name)["channel_id"]
        r = test_client.get(f"/api/human/mm/channels/{ch_id}/export", headers=_bearer(token))
        assert r.status_code == 200, r.text
        return ch_id, r.headers["content-disposition"]

    _, header = export("Release notes!")
    assert header.startswith(f'attachment; filename="clawbits-Release-notes-{today}.json"')
    ch_id, header = export("日本語 чат")
    assert header == (
        f'attachment; filename="clawbits-{ch_id}-{today}.json"; '
        f"filename*=UTF-8''{quote(f'clawbits-日本語-чат-{today}.json', safe='')}"
    )


def test_members_flag_each_agent_the_caller_may_tag_in_one_grant_read(test_client):
    """``can_tag`` per agent member: the caller's own agent and one granted ``can_tag`` are
    taggable, one granted only ``can_dm`` is not. One grants read however many agents."""
    from sqlalchemy import event
    from sqlmodel import Session

    from clawbits.db.table_write import TableWrite

    caller = _register_human(test_client, "tag-flags@test.com")
    token, caller_id = caller["access_token"], caller["user"]["id"]
    _register_human(test_client, "tag-flags-operator@test.com")
    mine = _create_agent(test_client, owner_email="tag-flags@test.com")["agent_id"]
    granted, dm_only = (
        _create_agent(test_client, owner_email="tag-flags-operator@test.com")["agent_id"]
        for _ in range(2)
    )
    ch_id = _create_channel(test_client, token, "tag-flags-chat")["channel_id"]
    with Session(test_client.app._engine) as db:
        for agent_id in (mine, granted, dm_only):
            TableWrite.add_mm_channel_member(db, ch_id, agent_id)
        TableWrite.upsert_agent_contact_permission(
            db, granted, human_id=caller_id, can_dm=False, can_tag=True
        )
        TableWrite.upsert_agent_contact_permission(
            db, dm_only, human_id=caller_id, can_dm=True, can_tag=False
        )
        db.commit()

    statements: list[str] = []

    def record(*args) -> None:
        statements.append(args[2])

    event.listen(test_client.app._engine, "before_cursor_execute", record)
    try:
        r = test_client.get(f"/api/human/mm/channels/{ch_id}/members", headers=_bearer(token))
    finally:
        event.remove(test_client.app._engine, "before_cursor_execute", record)
    assert r.status_code == 200, r.text
    flags = {m["agent_id"] or m["human_id"]: m["can_tag"] for m in r.json()["members"]}
    assert flags == {caller_id: None, mine: True, granted: True, dm_only: False}
    assert sum("agent_contact_permissions" in s for s in statements) == 1
