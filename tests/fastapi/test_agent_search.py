"""Tests for the agent-facing context-scoped message search.

The scope an agent may search is decided by ``context_channel_id`` — the
channel it is responding in: the operator DM unlocks everything the agent
is a member of (``all_channels``); a public context restricts to its public
channels (``public_channels``); a private channel or non-operator DM gets
the current channel plus public ones (``context_and_public``).
"""
from starlette.testclient import TestClient

from tests.fastapi.test_mattermost import (
    _auth,
    _create_owned_agent,
    _grant_agent_contact,
    _write_headers,
)

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _agent_search(
    tc: TestClient,
    api_key: str,
    context_channel_id: str,
    q: str = "",
    **params,
):
    """GET /api/agentic/mm/search without asserting the status — several
    tests expect a 403."""
    return tc.get(
        "/api/agentic/mm/search",
        params={"context_channel_id": context_channel_id, "q": q, **params},
        headers=_auth(api_key),
    )


def _make_channel(tc: TestClient, api_key: str, name: str, channel_type: str) -> str:
    r = tc.post(
        "/api/agentic/mm/channels",
        json={"name": name, "channel_type": channel_type},
        headers=_write_headers(tc, api_key),
    )
    assert r.status_code == 200, r.text
    return r.json()["channel_id"]


def _post(tc: TestClient, api_key: str, channel_id: str, message: str, **extra) -> dict:
    r = tc.post(
        f"/api/agentic/mm/channels/{channel_id}/posts",
        json={"message": message, **extra},
        headers=_write_headers(tc, api_key),
    )
    assert r.status_code == 200, r.text
    return r.json()


def _operator_dm(tc: TestClient, agent: dict) -> str:
    r = tc.get(
        f"/api/agentic/mm/teams/{agent['agent_id']}/operator-channel",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    return r.json()["channel_id"]


def _seed(tc: TestClient) -> dict:
    """One owned agent with a marker post in each visibility tier.

    Returns {agent, opdm, pub, priv} — the operator DM, a public channel, and
    a private channel, each holding one published post containing ``zebra``
    plus a tier-specific token (``opdm`` / ``pub`` / ``priv``).
    """
    agent = _create_owned_agent(tc)
    opdm = _operator_dm(tc, agent)
    pub = _make_channel(tc, agent["api_key"], "search-pub", "public")
    priv = _make_channel(tc, agent["api_key"], "search-priv", "private")
    _post(tc, agent["api_key"], opdm, "opdm zebra marker")
    _post(tc, agent["api_key"], pub, "pub zebra marker")
    _post(tc, agent["api_key"], priv, "priv zebra marker")
    return {"agent": agent, "opdm": opdm, "pub": pub, "priv": priv}


def _hit_channels(body: dict) -> set[str]:
    return {r["channel_id"] for r in body["results"]}


# ---------------------------------------------------------------------------
# scoping tiers
# ---------------------------------------------------------------------------


def test_operator_dm_context_searches_all_channels(test_client):
    s = _seed(test_client)
    r = _agent_search(test_client, s["agent"]["api_key"], s["opdm"], "zebra")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["scope"] == "all_channels"
    assert _hit_channels(body) == {s["opdm"], s["pub"], s["priv"]}


def test_public_context_excludes_private_and_dm(test_client):
    s = _seed(test_client)
    r = _agent_search(test_client, s["agent"]["api_key"], s["pub"], "zebra")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["scope"] == "public_channels"
    assert _hit_channels(body) == {s["pub"]}


def test_private_context_is_context_plus_public(test_client):
    s = _seed(test_client)
    # A second private channel with a matching post must stay excluded.
    priv2 = _make_channel(test_client, s["agent"]["api_key"], "search-priv2", "private")
    _post(test_client, s["agent"]["api_key"], priv2, "priv2 zebra marker")

    r = _agent_search(test_client, s["agent"]["api_key"], s["priv"], "zebra")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["scope"] == "context_and_public"
    assert _hit_channels(body) == {s["priv"], s["pub"]}


def test_agent_agent_dm_context_is_middle_tier(test_client):
    s = _seed(test_client)
    other = _create_owned_agent(test_client)
    _grant_agent_contact(test_client, other, s["agent"], can_dm=True)
    r = test_client.post(
        "/api/agentic/mm/direct",
        json={"target_agent_id": other["agent_id"]},
        headers=_write_headers(test_client, s["agent"]["api_key"]),
    )
    assert r.status_code == 200, r.text
    dm_id = r.json()["channel_id"]
    _post(test_client, s["agent"]["api_key"], dm_id, "peerdm zebra marker")

    r = _agent_search(test_client, s["agent"]["api_key"], dm_id, "zebra")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["scope"] == "context_and_public"
    # The DM itself + the agent's public channel; never the operator DM or
    # the private channel.
    assert _hit_channels(body) == {dm_id, s["pub"]}


# ---------------------------------------------------------------------------
# guards
# ---------------------------------------------------------------------------


def test_non_member_context_is_403(test_client):
    s = _seed(test_client)
    stranger = _create_owned_agent(test_client)
    r = _agent_search(test_client, stranger["api_key"], s["pub"], "zebra")
    assert r.status_code == 403, r.text


def test_narrowing_scope(test_client):
    s = _seed(test_client)
    # From a public context, narrowing to the private channel (which the
    # agent IS a member of) is outside scope -> 403 naming the scope.
    r = _agent_search(
        test_client, s["agent"]["api_key"], s["pub"], "zebra", channel_id=s["priv"]
    )
    assert r.status_code == 403, r.text
    assert "public_channels" in r.json()["detail"]

    # In-scope narrowing restricts results to that channel.
    r = _agent_search(
        test_client, s["agent"]["api_key"], s["opdm"], "zebra", channel_id=s["priv"]
    )
    assert r.status_code == 200, r.text
    assert _hit_channels(r.json()) == {s["priv"]}


# ---------------------------------------------------------------------------
# search behavior within scope
# ---------------------------------------------------------------------------


def test_snippet_highlights(test_client):
    s = _seed(test_client)
    r = _agent_search(test_client, s["agent"]["api_key"], s["pub"], "zebra")
    assert r.status_code == 200, r.text
    (hit,) = r.json()["results"]
    assert "<mark>zebra</mark>" in hit["snippet"]
    assert hit["channel_id"] == s["pub"]
    assert hit["author"]["kind"] == "agent"


def test_blank_query_is_noop(test_client):
    s = _seed(test_client)
    r = _agent_search(test_client, s["agent"]["api_key"], s["pub"], "")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["results"] == []
    assert body["next_cursor"] is None


def test_recent_pagination_complete_and_unique(test_client):
    s = _seed(test_client)
    expected = set()
    for i in range(7):
        p = _post(test_client, s["agent"]["api_key"], s["pub"], f"pagetok item {i}")
        expected.add(p["post_id"])

    seen: list[int] = []
    cursor = None
    for _ in range(10):  # bounded walk
        params = {"limit": 3}
        if cursor:
            params["cursor"] = cursor
        r = _agent_search(
            test_client, s["agent"]["api_key"], s["pub"], "pagetok", **params
        )
        assert r.status_code == 200, r.text
        body = r.json()
        seen.extend(hit["post_id"] for hit in body["results"])
        cursor = body["next_cursor"]
        if not cursor:
            break
    assert len(seen) == len(set(seen)), "duplicate hits across pages"
    assert set(seen) == expected
    assert seen == sorted(seen, reverse=True), "recent sort must be newest-first"


def test_streaming_posts_never_returned(test_client):
    """Only ``published`` posts are searchable. ``streaming`` placeholders
    stay hidden until finalized. (A ``draft`` request is not testable here:
    ``create_mm_post`` deliberately coerces agent drafts to ``published`` —
    an agent reply is never held.)"""
    s = _seed(test_client)
    _post(
        test_client, s["agent"]["api_key"], s["pub"], "hidden zebra", status="streaming"
    )
    r = _agent_search(test_client, s["agent"]["api_key"], s["opdm"], "hidden")
    assert r.status_code == 200, r.text
    assert r.json()["results"] == []


def test_cross_org_isolation(test_client):
    s1 = _seed(test_client)
    s2 = _seed(test_client)  # separate human/org — same marker text
    r = _agent_search(test_client, s1["agent"]["api_key"], s1["opdm"], "zebra")
    assert r.status_code == 200, r.text
    hits = _hit_channels(r.json())
    assert hits == {s1["opdm"], s1["pub"], s1["priv"]}
    assert not hits & {s2["opdm"], s2["pub"], s2["priv"]}


def test_trigram_fallback_respects_scope(test_client):
    s = _seed(test_client)
    _post(test_client, s["agent"]["api_key"], s["priv"], "the kubernetes rollout")

    # Misspelled single-term query: FTS misses, trigram fallback catches it —
    # but only where the scope allows.
    r = _agent_search(test_client, s["agent"]["api_key"], s["opdm"], "kubernates")
    assert r.status_code == 200, r.text
    assert _hit_channels(r.json()) == {s["priv"]}

    r = _agent_search(test_client, s["agent"]["api_key"], s["pub"], "kubernates")
    assert r.status_code == 200, r.text
    assert r.json()["results"] == []


def test_operator_filters_smoke(test_client):
    s = _seed(test_client)
    r = _agent_search(
        test_client,
        s["agent"]["api_key"],
        s["opdm"],
        "zebra",
        from_agent_id=s["agent"]["agent_id"],
    )
    assert r.status_code == 200, r.text
    assert len(r.json()["results"]) == 3

    r = _agent_search(
        test_client,
        s["agent"]["api_key"],
        s["opdm"],
        "zebra",
        before="1970-01-01",
    )
    assert r.status_code == 200, r.text
    assert r.json()["results"] == []


# ---------------------------------------------------------------------------
# around window (search deep-links)
# ---------------------------------------------------------------------------


def test_agent_posts_around_window(test_client):
    s = _seed(test_client)
    ids = [
        _post(test_client, s["agent"]["api_key"], s["pub"], f"around {i}")["post_id"]
        for i in range(5)
    ]
    target = ids[2]
    r = test_client.get(
        f"/api/agentic/mm/channels/{s['pub']}/posts/around/{target}",
        params={"radius": 1},
        headers=_auth(s["agent"]["api_key"]),
    )
    assert r.status_code == 200, r.text
    posts = r.json()["posts"]
    got = [p["post_id"] for p in posts]
    assert got == [ids[3], ids[2], ids[1]], "newest-first window around the target"


def test_agent_posts_around_requires_membership(test_client):
    s = _seed(test_client)
    stranger = _create_owned_agent(test_client)
    r = test_client.get(
        f"/api/agentic/mm/channels/{s['pub']}/posts/around/1",
        headers=_auth(stranger["api_key"]),
    )
    assert r.status_code == 403, r.text
