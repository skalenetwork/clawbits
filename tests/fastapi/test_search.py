"""Tests for message-content search — GET /api/human/mm/search — and the
deep-link "posts around" read path. See docs/protocol/SEARCH_SPEC.md.

Coverage:
- a query finds matching published posts, with a highlighted snippet and
  channel/author context;
- ACL: a non-member cannot find posts in a channel they are not in;
- org scoping requires membership (cross-org search is 403);
- in-channel scope (``channel_id``) narrows results;
- keyset pagination for the default ``recent`` sort returns every match
  once with no duplicates;
- ``relevant`` sort echoes back and returns the matches;
- empty query is a no-op;
- a single-term typo falls back to trigram word-similarity;
- ``/posts/around/{post_id}`` returns a window centred on the target.
"""
from datetime import date, timedelta

from starlette.testclient import TestClient

from tests.fastapi._auth_helpers import add_human_to_org
from tests.fastapi._auth_helpers import auth_headers as _auth
from tests.fastapi._auth_helpers import register_human as _register


def _personal_org(tc: TestClient, token: str) -> str:
    r = tc.get("/api/human/orgs", headers=_auth(token))
    assert r.status_code == 200, r.text
    for org in r.json()["organizations"]:
        if org.get("is_personal"):
            return org["org_id"]
    raise AssertionError("no personal org")


def _create_channel(
    tc: TestClient, token: str, name: str, channel_type: str = "public"
) -> str:
    r = tc.post(
        "/api/human/mm/channels",
        json={
            "org_id": _personal_org(tc, token),
            "name": name,
            "channel_type": channel_type,
        },
        headers=_auth(token),
    )
    assert r.status_code == 200, r.text
    return r.json()["channel_id"]


def _post(tc: TestClient, token: str, channel_id: str, message: str) -> int:
    r = tc.post(
        f"/api/human/mm/channels/{channel_id}/posts",
        json={"message": message},
        headers=_auth(token),
    )
    assert r.status_code == 200, r.text
    return r.json()["post_id"]


def _add_human(
    tc: TestClient,
    owner_token: str,
    channel_id: str,
    user_id: int,
    user_email: str,
) -> None:
    add_human_to_org(
        tc, owner_token, _personal_org(tc, owner_token), user_email
    )
    r = tc.post(
        f"/api/human/mm/channels/{channel_id}/members",
        json={"member_id": str(user_id), "member_type": "human"},
        headers=_auth(owner_token),
    )
    assert r.status_code == 200, r.text


def _search(tc: TestClient, token: str, q: str, **params) -> dict:
    r = tc.get(
        "/api/human/mm/search",
        params={"q": q, **params},
        headers=_auth(token),
    )
    assert r.status_code == 200, r.text
    return r.json()


# ---------------------------------------------------------------------------
# Core behaviour
# ---------------------------------------------------------------------------


def test_search_finds_and_highlights(test_client):
    owner = _register(test_client, "owner@test.com", display_name="Owner")
    tok = owner["access_token"]
    ch = _create_channel(test_client, tok, "planning")
    pid = _post(test_client, tok, ch, "The quarterly budget review is on Monday")
    _post(test_client, tok, ch, "Lunch options for the offsite")

    body = _search(test_client, tok, "budget")
    assert body["query"] == "budget"
    assert body["sort"] == "recent"
    assert len(body["results"]) == 1
    hit = body["results"][0]
    assert hit["post_id"] == pid
    assert hit["channel_id"] == ch
    assert hit["channel_display_name"] == "planning"
    assert "<mark>" in hit["snippet"].lower()
    assert hit["author"]["kind"] == "human"
    assert hit["author"]["human_id"] == owner["user"]["id"]


def test_search_respects_membership_acl(test_client):
    """A user who is not a member of a private channel cannot find its
    posts, even though the content is plaintext on the server."""
    owner = _register(test_client, "owner@test.com", display_name="Owner")
    outsider = _register(test_client, "outsider@test.com", display_name="Outsider")
    ch = _create_channel(test_client, owner["access_token"], "secret", "private")
    _post(test_client, owner["access_token"], ch, "the falcon launches at dawn")

    owner_hits = _search(test_client, owner["access_token"], "falcon")["results"]
    assert len(owner_hits) == 1

    outsider_hits = _search(test_client, outsider["access_token"], "falcon")["results"]
    assert outsider_hits == []


def test_search_org_scope_requires_membership(test_client):
    """Passing an org_id the caller is not a member of is rejected."""
    owner = _register(test_client, "owner@test.com")
    other = _register(test_client, "other@test.com")
    other_org = _personal_org(test_client, other["access_token"])

    r = test_client.get(
        "/api/human/mm/search",
        params={"q": "anything", "org_id": other_org},
        headers=_auth(owner["access_token"]),
    )
    assert r.status_code == 403, r.text


def test_search_in_channel_scope(test_client):
    owner = _register(test_client, "owner@test.com")
    tok = owner["access_token"]
    ch_a = _create_channel(test_client, tok, "alpha")
    ch_b = _create_channel(test_client, tok, "bravo")
    _post(test_client, tok, ch_a, "deploy the widget service")
    pid_b = _post(test_client, tok, ch_b, "deploy the gadget service")

    # Global search sees both "deploy" posts.
    assert len(_search(test_client, tok, "deploy")["results"]) == 2
    # Scoped to channel B, only one.
    scoped = _search(test_client, tok, "deploy", channel_id=ch_b)["results"]
    assert len(scoped) == 1
    assert scoped[0]["post_id"] == pid_b


def test_search_recent_pagination_is_complete_and_unique(test_client):
    owner = _register(test_client, "owner@test.com")
    tok = owner["access_token"]
    ch = _create_channel(test_client, tok, "logs")
    expected = set()
    for i in range(7):
        expected.add(_post(test_client, tok, ch, f"alert number {i} fired"))

    seen: list[int] = []
    cursor = None
    for _ in range(10):  # safety bound
        params = {"limit": 3}
        if cursor:
            params["cursor"] = cursor
        body = _search(test_client, tok, "alert", **params)
        seen.extend(h["post_id"] for h in body["results"])
        cursor = body["next_cursor"]
        if not cursor:
            break

    assert cursor is None  # paged to the end
    assert len(seen) == len(set(seen)) == 7  # no dupes, all of them
    assert set(seen) == expected
    # recent => strictly descending post_id order
    assert seen == sorted(seen, reverse=True)


def test_search_relevant_sort_echoes_and_matches(test_client):
    owner = _register(test_client, "owner@test.com")
    tok = owner["access_token"]
    ch = _create_channel(test_client, tok, "kb")
    _post(test_client, tok, ch, "postgres indexing strategies")
    _post(test_client, tok, ch, "indexing the postgres write path for indexing speed")

    body = _search(test_client, tok, "indexing", sort="relevant")
    assert body["sort"] == "relevant"
    assert len(body["results"]) == 2


def test_search_empty_query_is_noop(test_client):
    owner = _register(test_client, "owner@test.com")
    tok = owner["access_token"]
    ch = _create_channel(test_client, tok, "misc")
    _post(test_client, tok, ch, "some content here")

    body = _search(test_client, tok, "   ")
    assert body["results"] == []
    assert body["next_cursor"] is None


def test_search_typo_falls_back_to_trigram(test_client):
    """A misspelled single term still finds the post via word-similarity."""
    owner = _register(test_client, "owner@test.com")
    tok = owner["access_token"]
    ch = _create_channel(test_client, tok, "infra")
    pid = _post(test_client, tok, ch, "the kubernetes deployment rolled out cleanly")

    # Exact tsquery would return nothing for the misspelling.
    hits = _search(test_client, tok, "kubernates")["results"]
    assert any(h["post_id"] == pid for h in hits)


# ---------------------------------------------------------------------------
# Deep-link: posts around a target
# ---------------------------------------------------------------------------


def test_posts_around_returns_centered_window(test_client):
    owner = _register(test_client, "owner@test.com")
    tok = owner["access_token"]
    ch = _create_channel(test_client, tok, "stream")
    ids = [_post(test_client, tok, ch, f"message {i}") for i in range(20)]
    target = ids[10]

    r = test_client.get(
        f"/api/human/mm/channels/{ch}/posts/around/{target}",
        params={"radius": 3},
        headers=_auth(tok),
    )
    assert r.status_code == 200, r.text
    returned = [p["post_id"] for p in r.json()["posts"]]
    # Newest-first, target included, up to radius on each side.
    assert target in returned
    assert returned == sorted(returned, reverse=True)
    # 3 newer + target + 3 older = 7 around the middle.
    assert returned == sorted(ids[7:14], reverse=True)


def test_posts_after_cursor_returns_newer_window(test_client):
    """``after_post_id`` powers scroll-down through an anchored history
    window (the jump-to-pinned path): it returns the posts immediately
    *newer* than the cursor, newest-first, never the live tail."""
    owner = _register(test_client, "owner@test.com")
    tok = owner["access_token"]
    ch = _create_channel(test_client, tok, "stream")
    ids = [_post(test_client, tok, ch, f"message {i}") for i in range(20)]
    cursor = ids[5]

    r = test_client.get(
        f"/api/human/mm/channels/{ch}/posts",
        params={"after_post_id": cursor, "limit": 4},
        headers=_auth(tok),
    )
    assert r.status_code == 200, r.text
    returned = [p["post_id"] for p in r.json()["posts"]]
    # The 4 posts immediately newer than the cursor (ids[6:10]), newest-first
    # — not the four newest in the channel.
    assert returned == sorted(ids[6:10], reverse=True)
    assert cursor not in returned


def test_posts_after_cursor_exhausts_at_tail(test_client):
    """A short final page (< limit) is how the client learns it has caught
    up to the live tail and can re-enter live mode."""
    owner = _register(test_client, "owner@test.com")
    tok = owner["access_token"]
    ch = _create_channel(test_client, tok, "stream")
    ids = [_post(test_client, tok, ch, f"message {i}") for i in range(8)]

    r = test_client.get(
        f"/api/human/mm/channels/{ch}/posts",
        params={"after_post_id": ids[5], "limit": 50},
        headers=_auth(tok),
    )
    assert r.status_code == 200, r.text
    returned = [p["post_id"] for p in r.json()["posts"]]
    assert returned == [ids[7], ids[6]]


def test_posts_around_requires_membership(test_client):
    owner = _register(test_client, "owner@test.com")
    outsider = _register(test_client, "outsider@test.com")
    ch = _create_channel(test_client, owner["access_token"], "private-stream", "private")
    pid = _post(test_client, owner["access_token"], ch, "members only")

    r = test_client.get(
        f"/api/human/mm/channels/{ch}/posts/around/{pid}",
        headers=_auth(outsider["access_token"]),
    )
    assert r.status_code == 403, r.text


# ---------------------------------------------------------------------------
# Operators (from: / before: / after: / has:) — resolved to ids client-side,
# applied as filters server-side.
# ---------------------------------------------------------------------------


def test_search_from_filter(test_client):
    """`from:` (author) narrows to one member's posts."""
    owner = _register(test_client, "owner@test.com", display_name="Owner")
    bob = _register(test_client, "bob@test.com", display_name="Bob")
    ch = _create_channel(test_client, owner["access_token"], "topic")
    _add_human(
        test_client,
        owner["access_token"],
        ch,
        bob["user"]["id"],
        "bob@test.com",
    )
    _post(test_client, owner["access_token"], ch, "shared roadmap notes")
    bob_pid = _post(test_client, bob["access_token"], ch, "shared roadmap update")

    # Unfiltered: both authors match "shared".
    assert len(_search(test_client, owner["access_token"], "shared")["results"]) == 2
    # from:bob → only Bob's post.
    body = _search(
        test_client, owner["access_token"], "shared", from_human_id=bob["user"]["id"]
    )
    assert len(body["results"]) == 1
    assert body["results"][0]["post_id"] == bob_pid
    assert body["results"][0]["author"]["human_id"] == bob["user"]["id"]


def test_search_filter_only_empty_query(test_client):
    """A blank query + an operator filter is a valid filter-only listing."""
    owner = _register(test_client, "owner@test.com")
    bob = _register(test_client, "bob@test.com", display_name="Bob")
    ch = _create_channel(test_client, owner["access_token"], "topic")
    _add_human(
        test_client,
        owner["access_token"],
        ch,
        bob["user"]["id"],
        "bob@test.com",
    )
    _post(test_client, owner["access_token"], ch, "anything one")
    _post(test_client, bob["access_token"], ch, "anything two")

    # Blank query + from:bob → Bob's posts only.
    body = _search(test_client, owner["access_token"], "", from_human_id=bob["user"]["id"])
    assert len(body["results"]) >= 1
    assert all(r["author"]["human_id"] == bob["user"]["id"] for r in body["results"])
    # Blank query + no filters → nothing.
    assert _search(test_client, owner["access_token"], "")["results"] == []


def test_search_date_filter(test_client):
    """`before:` / `after:` bound results by created_at."""
    owner = _register(test_client, "owner@test.com")
    tok = owner["access_token"]
    ch = _create_channel(test_client, tok, "log")
    _post(test_client, tok, ch, "alpha beacon fired")
    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    yesterday = (date.today() - timedelta(days=1)).isoformat()

    assert _search(test_client, tok, "beacon", after=tomorrow)["results"] == []
    assert len(_search(test_client, tok, "beacon", after=yesterday)["results"]) == 1
    assert len(_search(test_client, tok, "beacon", before=tomorrow)["results"]) == 1
    assert _search(test_client, tok, "beacon", before=yesterday)["results"] == []


def test_search_has_filters_exclude_plain(test_client):
    """`has:link` / `has:file` exclude a plain text post (no link, no file)."""
    owner = _register(test_client, "owner@test.com")
    tok = owner["access_token"]
    ch = _create_channel(test_client, tok, "plain")
    _post(test_client, tok, ch, "just plain words here")

    assert len(_search(test_client, tok, "plain")["results"]) == 1
    # Sent as strings, mirroring how the frontend serializes the flags.
    assert _search(test_client, tok, "plain", has_link="true")["results"] == []
    assert _search(test_client, tok, "plain", has_file="true")["results"] == []
