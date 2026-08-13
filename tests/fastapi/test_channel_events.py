"""Tests for inline channel events (membership changes today).

Events live in ``mm_channel_events`` and surface through the
``/timeline`` endpoint merged into the post stream. These tests cover
the emit-side rules at the endpoint layer (which kind of action emits
what), the renderer-friendly identity normalisation (self-action →
NULL subject), the DM suppression, and the read-side merge."""
from starlette.testclient import TestClient

from clawbits.datastructures.known_answers import get_answer_for_question
from tests.fastapi._auth_helpers import auth_headers as _auth
from tests.fastapi._auth_helpers import register_human as _register
from tests.fastapi._auth_helpers import signup_agent_via_email
from tests.fastapi.approve_helper import _approve_signup


def _create_agent(tc: TestClient, owner_email: str = "stan@clawbits.ai") -> dict:
    """Spin up an agent owned by ``owner_email``. Mirrors the helper in
    ``test_human_mattermost.py`` — duplicated rather than imported to
    keep the events test file self-contained."""
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


def _create_public_channel(tc: TestClient, token: str, name: str) -> str:
    r = tc.post(
        "/api/human/mm/channels",
        json={"org_id": _personal_org(tc, token), "name": name, "channel_type": "public"},
        headers=_auth(token),
    )
    assert r.status_code == 200, r.text
    return r.json()["channel_id"]


def _timeline(tc: TestClient, token: str, channel_id: str, **params) -> dict:
    r = tc.get(
        f"/api/human/mm/channels/{channel_id}/timeline",
        headers=_auth(token),
        params=params,
    )
    assert r.status_code == 200, r.text
    return r.json()


def _events_in(timeline: dict) -> list[dict]:
    return [row["event"] for row in timeline["rows"] if row["kind"] == "event"]


def _posts_in(timeline: dict) -> list[dict]:
    return [row["post"] for row in timeline["rows"] if row["kind"] == "post"]


# ---------------------------------------------------------------------------
# Emit side
# ---------------------------------------------------------------------------


def test_add_human_member_emits_added_event(test_client):
    """Adding another human emits ``member.added`` with subject set."""
    owner = _register(test_client, "owner@test.com", display_name="Owner")
    target = _register(test_client, "newbie@test.com", display_name="Newbie")
    ch_id = _create_public_channel(test_client, owner["access_token"], "team")

    test_client.post(
        f"/api/human/mm/channels/{ch_id}/members",
        json={"member_id": str(target["user"]["id"]), "member_type": "human"},
        headers=_auth(owner["access_token"]),
    )

    events = _events_in(_timeline(test_client, owner["access_token"], ch_id))
    # Two events, newest-first: the explicit add of the target, then the
    # creator's own implicit join emitted at channel creation.
    assert len(events) == 2
    ev = events[0]
    assert ev["event_type"] == "member.added"
    assert ev["actor_human_id"] == owner["user"]["id"]
    assert ev["subject_human_id"] == target["user"]["id"]
    assert ev["actor_display_name"] == "Owner"
    assert ev["subject_display_name"] == "Newbie"
    # The creator's self-join normalises actor == subject to a NULL subject.
    creator_join = events[1]
    assert creator_join["event_type"] == "member.added"
    assert creator_join["actor_human_id"] == owner["user"]["id"]
    assert creator_join["subject_human_id"] is None


def test_add_agent_member_emits_event_with_subject_agent_id(test_client):
    """Adding an agent records the subject on the agent side of the
    actor/subject pair so the renderer can distinguish 'X added @Bot'
    from 'X added @Bob'."""
    h1 = _register(test_client, "stan@clawbits.ai", display_name="Stan")
    agent = _create_agent(test_client)
    ch_id = _create_public_channel(test_client, h1["access_token"], "ops")

    test_client.post(
        f"/api/human/mm/channels/{ch_id}/members",
        json={"member_id": agent["agent_id"], "member_type": "agent"},
        headers=_auth(h1["access_token"]),
    )

    events = _events_in(_timeline(test_client, h1["access_token"], ch_id))
    # Newest-first: the agent add, then the creator's implicit join.
    assert len(events) == 2
    ev = events[0]
    assert ev["event_type"] == "member.added"
    assert ev["actor_human_id"] == h1["user"]["id"]
    assert ev["subject_human_id"] is None
    assert ev["subject_agent_id"] == agent["agent_id"]
    # Creator join: actor on the human side, no subject on either axis.
    creator_join = events[1]
    assert creator_join["actor_human_id"] == h1["user"]["id"]
    assert creator_join["subject_human_id"] is None
    assert creator_join["subject_agent_id"] is None


def test_remove_other_emits_removed_event_with_subject(test_client):
    """Owner removing someone else emits ``member.removed`` with subject set."""
    owner = _register(test_client, "owner@test.com", display_name="Owner")
    target = _register(test_client, "leaving@test.com", display_name="Leaving")
    ch_id = _create_public_channel(test_client, owner["access_token"], "team")

    test_client.post(
        f"/api/human/mm/channels/{ch_id}/members",
        json={"member_id": str(target["user"]["id"]), "member_type": "human"},
        headers=_auth(owner["access_token"]),
    )
    test_client.delete(
        f"/api/human/mm/channels/{ch_id}/members/{target['user']['id']}?member_type=human",
        headers=_auth(owner["access_token"]),
    )

    events = _events_in(_timeline(test_client, owner["access_token"], ch_id))
    # Sorted newest-first: removal, then the target's add, then the
    # creator's implicit join from channel creation.
    assert [e["event_type"] for e in events] == [
        "member.removed", "member.added", "member.added",
    ]
    rem = events[0]
    assert rem["actor_human_id"] == owner["user"]["id"]
    assert rem["subject_human_id"] == target["user"]["id"]


def test_self_leave_emits_with_null_subject(test_client):
    """Self-removal normalises to NULL subject so the renderer picks "left"."""
    owner = _register(test_client, "owner@test.com")
    leaver = _register(test_client, "leaver@test.com", display_name="Leaver")
    ch_id = _create_public_channel(test_client, owner["access_token"], "team")
    test_client.post(
        f"/api/human/mm/channels/{ch_id}/members",
        json={"member_id": str(leaver["user"]["id"]), "member_type": "human"},
        headers=_auth(owner["access_token"]),
    )

    # Leaver removes themselves
    test_client.delete(
        f"/api/human/mm/channels/{ch_id}/members/{leaver['user']['id']}?member_type=human",
        headers=_auth(leaver["access_token"]),
    )

    events = _events_in(_timeline(test_client, owner["access_token"], ch_id))
    leave_event = next(e for e in events if e["event_type"] == "member.removed")
    assert leave_event["actor_human_id"] == leaver["user"]["id"]
    assert leave_event["subject_human_id"] is None
    assert leave_event["actor_display_name"] == "Leaver"


def test_dm_channel_suppresses_events(test_client):
    """DM channels never accumulate events — the helper short-circuits."""
    agent = _create_agent(test_client)
    h1 = _register(test_client, "stan@clawbits.ai", display_name="Stan")
    org_id = _personal_org(test_client, h1["access_token"])

    r = test_client.post(
        "/api/human/mm/direct",
        json={"org_id": org_id, "target_id": agent["agent_id"], "target_type": "agent"},
        headers=_auth(h1["access_token"]),
    )
    assert r.status_code == 200, r.text
    dm = r.json()
    assert dm["channel_type"] == "direct"
    dm_id = dm["channel_id"]

    events = _events_in(_timeline(test_client, h1["access_token"], dm_id))
    assert events == []


def test_deleting_an_agent_leaves_a_left_the_channel_event(test_client):
    """Deleting an agent must not make it silently evaporate from the
    channels it belonged to — each one gets a ``member.removed`` line.

    The agent row is gone by the time anyone reads the event, so it can't be
    named through ``subject_agent_id`` (the FK would have taken the event
    down with it): the id and display name ride in ``payload`` instead, which
    is what the renderer keys off to say "<name> left the channel".
    """
    h1 = _register(test_client, "stan@clawbits.ai", display_name="Stan")
    agent = _create_agent(test_client)
    org_id = _personal_org(test_client, h1["access_token"])
    ch_id = _create_public_channel(test_client, h1["access_token"], "ops")
    test_client.post(
        f"/api/human/mm/channels/{ch_id}/members",
        json={"member_id": agent["agent_id"], "member_type": "agent"},
        headers=_auth(h1["access_token"]),
    )

    r = test_client.delete(
        f"/api/human/orgs/{org_id}/agents/{agent['agent_id']}",
        headers=_auth(h1["access_token"]),
    )
    assert r.status_code == 200, r.text

    events = _events_in(_timeline(test_client, h1["access_token"], ch_id))
    departure = events[0]
    assert departure["event_type"] == "member.removed"
    # Actor is the human who triggered the delete — the row's actor check
    # needs one, and the agent side can't be used.
    assert departure["actor_human_id"] == h1["user"]["id"]
    assert departure["subject_agent_id"] is None
    assert departure["payload"] == {
        "subject_kind": "agent",
        "subject_agent_id": agent["agent_id"],
        "subject_display_name": agent["agent_id"],
        "reason": "agent_deleted",
    }
    # The agent's own ``member.added`` line went with it (its FK pointed at
    # the deleted row), so the departure is the only trace left.
    assert not any(e["subject_agent_id"] == agent["agent_id"] for e in events)


def test_deleting_an_agent_emits_no_event_in_dms(test_client):
    """DM teardown carries no membership chrome — the 1:1 either vanishes
    (default delete) or lives on as "Deleted agent" (keep_content)."""
    h1 = _register(test_client, "stan@clawbits.ai", display_name="Stan")
    agent = _create_agent(test_client)
    org_id = _personal_org(test_client, h1["access_token"])

    r = test_client.post(
        "/api/human/mm/direct",
        json={"org_id": org_id, "target_id": agent["agent_id"], "target_type": "agent"},
        headers=_auth(h1["access_token"]),
    )
    dm_id = r.json()["channel_id"]

    r = test_client.delete(
        f"/api/human/orgs/{org_id}/agents/{agent['agent_id']}?keep_content=true",
        headers=_auth(h1["access_token"]),
    )
    assert r.status_code == 200, r.text

    # The DM survives under the placeholder and stays event-free.
    assert _events_in(_timeline(test_client, h1["access_token"], dm_id)) == []


# ---------------------------------------------------------------------------
# Timeline merge + pagination
# ---------------------------------------------------------------------------


def test_timeline_merges_posts_and_events_newest_first(test_client):
    """A post followed by a member.added (or vice versa) returns from
    /timeline in the right chronological order."""
    owner = _register(test_client, "owner@test.com", display_name="Owner")
    target = _register(test_client, "newbie@test.com", display_name="Newbie")
    ch_id = _create_public_channel(test_client, owner["access_token"], "team")

    test_client.post(
        f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "hello"},
        headers=_auth(owner["access_token"]),
    )
    test_client.post(
        f"/api/human/mm/channels/{ch_id}/members",
        json={"member_id": str(target["user"]["id"]), "member_type": "human"},
        headers=_auth(owner["access_token"]),
    )
    test_client.post(
        f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "welcome"},
        headers=_auth(owner["access_token"]),
    )

    tl = _timeline(test_client, owner["access_token"], ch_id)
    kinds = [row["kind"] for row in tl["rows"]]
    # Newest-first: welcome post, member.added, hello post, and the
    # creator's implicit join event at the bottom (oldest).
    assert kinds == ["post", "event", "post", "event"]
    assert tl["rows"][0]["post"]["message"] == "welcome"
    assert tl["rows"][1]["event"]["event_type"] == "member.added"
    assert tl["rows"][2]["post"]["message"] == "hello"
    assert tl["rows"][3]["event"]["event_type"] == "member.added"


def test_timeline_pagination_via_cursor(test_client):
    """Paging with ``before_created_at`` returns strictly older rows."""
    owner = _register(test_client, "owner@test.com")
    ch_id = _create_public_channel(test_client, owner["access_token"], "team")
    # Post 5 messages so we can page through them.
    for i in range(5):
        test_client.post(
            f"/api/human/mm/channels/{ch_id}/posts",
            json={"message": f"msg-{i}"},
            headers=_auth(owner["access_token"]),
        )

    first = _timeline(test_client, owner["access_token"], ch_id, limit=3)
    assert len(first["rows"]) == 3
    assert first["has_more"] is True
    assert first["next_cursor"] is not None
    first_messages = [r["post"]["message"] for r in first["rows"]]
    assert first_messages == ["msg-4", "msg-3", "msg-2"]

    second = _timeline(
        test_client, owner["access_token"], ch_id,
        limit=3, before_created_at=first["next_cursor"],
    )
    # Two remaining posts plus the creator's implicit join event (oldest).
    second_messages = [
        r["post"]["message"] for r in second["rows"] if r["kind"] == "post"
    ]
    assert second_messages == ["msg-1", "msg-0"]
    assert second["rows"][-1]["kind"] == "event"
    assert second["rows"][-1]["event"]["event_type"] == "member.added"
    assert second["has_more"] is False
    assert second["next_cursor"] is None


def test_timeline_non_member_forbidden(test_client):
    """Non-channel-members cannot read the timeline (same gate as /posts)."""
    owner = _register(test_client, "owner@test.com")
    outsider = _register(test_client, "outsider@test.com")
    ch_id = _create_public_channel(test_client, owner["access_token"], "team")

    r = test_client.get(
        f"/api/human/mm/channels/{ch_id}/timeline",
        headers=_auth(outsider["access_token"]),
    )
    assert r.status_code == 403
