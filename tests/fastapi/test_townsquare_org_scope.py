"""The pre-organization "townsquare" list endpoints are org-scoped.

Audit finding T0-01/03/04/06. Five routes predate organizations and selected
their whole table with no org predicate at all, gated only by "is any valid
caller":

    GET /api/human/posts            -> every agent's post *text*, every org
    GET /api/human/shared_content   -> every shared filename + its public R2 URL
    GET /api/human/actions          -> every agent's action-registry ids
    GET /api/agentic/actions        -> same, for agents
    GET /api/agentic/posts          -> same as /api/human/posts, for agents

``limit``/``offset`` are caller-controlled, so each was a full-table dump on a
multi-tenant deployment. The scoped sibling route
(``GET /api/human/orgs/{org_id}/agents/{agent_id}/posts``) already did this
correctly with ``_verify_org_membership`` + ``_verify_agent_in_org``; these
five simply never got the gate.

The read-layer helpers now take ``org_ids`` as a *required* argument rather
than an optional filter, so a future call site cannot silently reintroduce the
leak by omitting it. That is not hypothetical: making it required is what
surfaced ``get_all_posts`` (``/api/agentic/posts``), the fifth route, which the
original report had only mentioned in passing.

Note the inner join to ``agents`` also excludes the shared ``deleted-agent``
placeholder, which inherits content across orgs and has ``org_id=None`` by
construction -- the same invariant ``is_agent_in_org`` documents.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from tests.fastapi._auth_helpers import auth_headers as _auth
from tests.fastapi._auth_helpers import login_human
from tests.fastapi.test_mattermost import _create_agent_with_owner, _write_headers

ALICE = "townsquare-alice@test.com"
BOB = "townsquare-bob@test.com"


def _post_as_agent(tc: TestClient, agent: dict, message: str) -> None:
    r = tc.post(
        "/api/agentic/posts",
        json={"message_type": "say", "message": message},
        headers=_write_headers(tc, agent["api_key"]),
    )
    assert r.status_code == 200, r.text


def _write_action(tc: TestClient, agent: dict, action_id: str) -> None:
    r = tc.put(
        f"/api/agentic/agents/{agent['agent_id']}/actions",
        json={"action_id": action_id, "action_md": f"# {action_id}"},
        headers=_write_headers(tc, agent["api_key"]),
    )
    assert r.status_code == 200, r.text


def _two_orgs(tc: TestClient) -> tuple[dict, dict, str, str]:
    """An agent in Alice's personal org and an agent in Bob's, plus both
    humans' session tokens. Every ``login_human`` gets its own personal org,
    so these are genuinely separate tenants."""
    agent_a = _create_agent_with_owner(tc, ALICE)
    agent_b = _create_agent_with_owner(tc, BOB)
    alice_token, _ = login_human(tc, ALICE)
    bob_token, _ = login_human(tc, BOB)
    return agent_a, agent_b, alice_token, bob_token


# ---------------------------------------------------------------------------
# Human-facing routes
# ---------------------------------------------------------------------------


def test_human_posts_exclude_other_orgs(test_client, _test_engine):
    """The headline leak: post *bodies* from every tenant, to any logged-in user."""
    agent_a, agent_b, alice_token, bob_token = _two_orgs(test_client)
    _post_as_agent(test_client, agent_a, "alice-org-secret")
    _post_as_agent(test_client, agent_b, "bob-org-secret")

    r = test_client.get("/api/human/posts", headers=_auth(alice_token))
    assert r.status_code == 200, r.text
    bodies = [p["message"] for p in r.json()["posts"]]
    assert "alice-org-secret" in bodies
    assert "bob-org-secret" not in bodies

    r = test_client.get("/api/human/posts", headers=_auth(bob_token))
    assert r.status_code == 200, r.text
    bodies = [p["message"] for p in r.json()["posts"]]
    assert "bob-org-secret" in bodies
    assert "alice-org-secret" not in bodies


def test_human_actions_exclude_other_orgs(test_client, _test_engine):
    """``total`` must be scoped too: an unscoped count leaks the deployment's
    size and makes pagination promise rows the caller cannot read."""
    agent_a, agent_b, alice_token, _ = _two_orgs(test_client)
    _write_action(test_client, agent_a, "alice-action")
    _write_action(test_client, agent_b, "bob-action")

    r = test_client.get("/api/human/actions", headers=_auth(alice_token))
    assert r.status_code == 200, r.text
    data = r.json()
    agent_ids = {a["agent_id"] for a in data["actions"]}
    assert agent_a["agent_id"] in agent_ids
    assert agent_b["agent_id"] not in agent_ids
    assert data["total"] == len(data["actions"])


def test_human_shared_content_excludes_other_orgs(test_client, _test_engine):
    """Each row carries a directly-fetchable public URL, so this one leaked
    the bytes, not just their names."""
    agent_a, agent_b, alice_token, _ = _two_orgs(test_client)
    for agent, name in ((agent_a, "alice.txt"), (agent_b, "bob.txt")):
        r = test_client.put(
            f"/api/agentic/shared_content/{name}",
            content=b"x",
            headers={**_write_headers(test_client, agent["api_key"]),
                     "Content-Type": "text/plain"},
        )
        assert r.status_code in (200, 201), r.text

    r = test_client.get("/api/human/shared_content", headers=_auth(alice_token))
    assert r.status_code == 200, r.text
    names = {f["filename"] for f in r.json()["files"]}
    assert "bob.txt" not in names


def test_human_with_no_org_sees_nothing(test_client, _test_engine):
    """Empty scope must mean "nothing", never "everything" -- the failure mode
    an ``IN ()`` written as an optional filter would produce."""
    agent_a, _agent_b, _alice, _bob = _two_orgs(test_client)
    _post_as_agent(test_client, agent_a, "alice-org-secret")

    # A freshly-registered human, in no org but their own empty personal one.
    stranger_token, _ = login_human(test_client, "townsquare-stranger@test.com")
    r = test_client.get("/api/human/posts", headers=_auth(stranger_token))
    assert r.status_code == 200, r.text
    bodies = [p["message"] for p in r.json()["posts"]]
    assert "alice-org-secret" not in bodies


# ---------------------------------------------------------------------------
# Agent-facing mirrors
# ---------------------------------------------------------------------------


def test_agentic_posts_exclude_other_orgs(test_client, _test_engine):
    """``/api/agentic/posts`` is the same query behind an API key. An agent
    minted in any org could read every other tenant's posts."""
    agent_a, agent_b, _alice, _bob = _two_orgs(test_client)
    _post_as_agent(test_client, agent_a, "alice-org-secret")
    _post_as_agent(test_client, agent_b, "bob-org-secret")

    r = test_client.get("/api/agentic/posts", headers=_auth(agent_a["api_key"]))
    assert r.status_code == 200, r.text
    bodies = [p["message"] for p in r.json()["posts"]]
    assert "alice-org-secret" in bodies
    assert "bob-org-secret" not in bodies


def test_agentic_actions_exclude_other_orgs(test_client, _test_engine):
    agent_a, agent_b, _alice, _bob = _two_orgs(test_client)
    _write_action(test_client, agent_a, "alice-action")
    _write_action(test_client, agent_b, "bob-action")

    r = test_client.get("/api/agentic/actions", headers=_auth(agent_a["api_key"]))
    assert r.status_code == 200, r.text
    data = r.json()
    agent_ids = {a["agent_id"] for a in data["actions"]}
    assert agent_a["agent_id"] in agent_ids
    assert agent_b["agent_id"] not in agent_ids
    assert data["total"] == len(data["actions"])


def test_own_org_rows_are_still_returned(test_client, _test_engine):
    """Guard against the lazy fix: scoping must not simply return nothing."""
    agent_a, _agent_b, alice_token, _bob = _two_orgs(test_client)
    _post_as_agent(test_client, agent_a, "alice-org-secret")
    _write_action(test_client, agent_a, "alice-action")

    posts = test_client.get("/api/human/posts", headers=_auth(alice_token)).json()
    assert any(p["message"] == "alice-org-secret" for p in posts["posts"])

    actions = test_client.get("/api/human/actions", headers=_auth(alice_token)).json()
    assert actions["total"] >= 1


# ---------------------------------------------------------------------------
# Post like / comment routes (audit finding T0-05)
# ---------------------------------------------------------------------------
#
# These four are keyed on ``agent_posts.post_id`` -- a bare serial -- and used
# to check only that the row existed. Any logged-in human could therefore walk
# ids to read another tenant's comment threads (which carry each commenter's
# display name AND email) and to inject likes and comments into a foreign org's
# feed. ``unlike_post`` had no existence check at all.
#
# They answer 404, not 403, for a post outside the caller's orgs: a 403 would
# confirm the id exists somewhere in the deployment.


def _a_post_id(tc: TestClient, agent: dict, token: str, message: str) -> int:
    """Create a post as ``agent`` and return its id, read back as its owner."""
    _post_as_agent(tc, agent, message)
    r = tc.get("/api/human/posts", headers=_auth(token))
    assert r.status_code == 200, r.text
    match = [p for p in r.json()["posts"] if p["message"] == message]
    assert match, f"{message} not visible to its own org"
    return match[0]["post_id"]


def test_cannot_like_a_post_in_another_org(test_client, _test_engine):
    agent_a, _agent_b, alice_token, bob_token = _two_orgs(test_client)
    post_id = _a_post_id(test_client, agent_a, alice_token, "alice-likeable")

    r = test_client.post(f"/api/human/posts/{post_id}/like", headers=_auth(bob_token))
    assert r.status_code == 404, r.text

    # ...and the owner still can.
    r = test_client.post(f"/api/human/posts/{post_id}/like", headers=_auth(alice_token))
    assert r.status_code == 200, r.text


def test_cannot_unlike_a_post_in_another_org(test_client, _test_engine):
    """``unlike_post`` previously had no guard whatsoever."""
    agent_a, _agent_b, alice_token, bob_token = _two_orgs(test_client)
    post_id = _a_post_id(test_client, agent_a, alice_token, "alice-unlikeable")

    r = test_client.delete(f"/api/human/posts/{post_id}/like", headers=_auth(bob_token))
    assert r.status_code == 404, r.text


def test_cannot_read_comments_on_a_post_in_another_org(test_client, _test_engine):
    """The leak here is personal data: commenter display names and emails."""
    agent_a, _agent_b, alice_token, bob_token = _two_orgs(test_client)
    post_id = _a_post_id(test_client, agent_a, alice_token, "alice-commentable")

    r = test_client.post(
        f"/api/human/posts/{post_id}/comments",
        json={"message": "alice-private-comment"},
        headers=_auth(alice_token),
    )
    assert r.status_code == 200, r.text

    r = test_client.get(f"/api/human/posts/{post_id}/comments", headers=_auth(bob_token))
    assert r.status_code == 404, r.text

    r = test_client.get(f"/api/human/posts/{post_id}/comments", headers=_auth(alice_token))
    assert r.status_code == 200, r.text
    assert [c["message"] for c in r.json()["comments"]] == ["alice-private-comment"]


def test_cannot_comment_on_a_post_in_another_org(test_client, _test_engine):
    agent_a, _agent_b, alice_token, bob_token = _two_orgs(test_client)
    post_id = _a_post_id(test_client, agent_a, alice_token, "alice-injectable")

    r = test_client.post(
        f"/api/human/posts/{post_id}/comments",
        json={"message": "bob-was-here"},
        headers=_auth(bob_token),
    )
    assert r.status_code == 404, r.text

    r = test_client.get(f"/api/human/posts/{post_id}/comments", headers=_auth(alice_token))
    assert [c["message"] for c in r.json()["comments"]] == []


def test_missing_post_is_404_not_500(test_client, _test_engine):
    _agent_a, _agent_b, alice_token, _bob = _two_orgs(test_client)
    for method, path in (
        ("post", "like"), ("delete", "like"), ("get", "comments"),
    ):
        r = getattr(test_client, method)(
            f"/api/human/posts/999999/{path}", headers=_auth(alice_token)
        )
        assert r.status_code == 404, f"{method} {path}: {r.text}"
