"""Channel membership is org-scoped, and a 1:1 DM is not a mutable group.

Audit finding 06. ``add_member`` used to check only that the target *existed*
before inserting the membership row — no channel-type guard and no org check.
Any member of a channel could therefore POST an arbitrary (trivially
enumerable) user id and hand a complete stranger, from any organization, the
channel's entire backlog and every attachment. On a 1:1 DM it was worse: a
human<->human DM has no secondary gate at all, because
``_require_agent_dm_contact`` only engages when ``dm_agent_peer`` finds an
agent member, so the membership row alone granted read.

The invariant these tests pin — *every member of a channel belongs to that
channel's org, and DM membership is fixed at creation* — was already enforced
everywhere else (``join_channel``, ``create_or_get_direct``, ``create_channel``,
and the frontend member picker, which only ever lists org members).
``add_member`` was the one hole.

Both the human and the agent-facing endpoints are covered: the agent mirror had
the same gap, and its ``can_tag`` grant is a *contact* permission, not an org
boundary — an operator could otherwise pull their own agent across orgs.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from tests.fastapi._auth_helpers import add_human_to_org, personal_org_id
from tests.fastapi._auth_helpers import auth_headers as _auth
from tests.fastapi._auth_helpers import register_human as _register
from tests.fastapi.test_mattermost import (
    _create_agent_with_owner,
    _grant_agent_contact,
    _write_headers,
)


def _channel(tc: TestClient, token: str, org_id: str, name: str) -> str:
    r = tc.post(
        "/api/human/mm/channels",
        json={"org_id": org_id, "name": name, "channel_type": "private"},
        headers=_auth(token),
    )
    assert r.status_code == 200, r.text
    return r.json()["channel_id"]


def _add(tc: TestClient, token: str, channel_id: str, member_id: str, member_type: str):
    return tc.post(
        f"/api/human/mm/channels/{channel_id}/members",
        json={"member_id": member_id, "member_type": member_type},
        headers=_auth(token),
    )


# ---------------------------------------------------------------------------
# Direct channels are not mutable
# ---------------------------------------------------------------------------


def test_cannot_add_human_to_a_dm(test_client, _test_engine):
    """The headline exploit: Alice injects Eve into her 1:1 with an agent.

    A DM's membership is fixed when it is created. Widening one in place would
    silently expose the whole prior conversation to a third party; a group
    conversation has to be a new channel.
    """
    agent = _create_agent_with_owner(test_client, "dm-alice@test.com")
    alice = _register(test_client, "dm-alice@test.com")
    org_id = personal_org_id(test_client, alice["access_token"])

    r = test_client.post(
        "/api/human/mm/direct",
        json={"org_id": org_id, "target_id": agent["agent_id"], "target_type": "agent"},
        headers=_auth(alice["access_token"]),
    )
    assert r.status_code == 200, r.text
    dm = r.json()["channel_id"]

    eve = _register(test_client, "dm-eve@test.com")
    add_human_to_org(test_client, alice["access_token"], org_id, "dm-eve@test.com")

    # Even same-org, and even for a member of the DM: a DM is not widenable.
    resp = _add(test_client, alice["access_token"], dm, str(eve["user"]["id"]), "human")
    assert resp.status_code == 400, resp.text
    assert "direct message channel" in resp.json()["detail"]

    # ...and Eve gained nothing.
    assert (
        test_client.get(
            f"/api/human/mm/channels/{dm}/posts", headers=_auth(eve["access_token"])
        ).status_code
        == 403
    )


def test_cannot_add_agent_to_a_dm(test_client):
    """Same rule for the other member kind."""
    peer = _create_agent_with_owner(test_client, "dm2-alice@test.com")
    other = _create_agent_with_owner(test_client, "dm2-alice@test.com")
    alice = _register(test_client, "dm2-alice@test.com")
    org_id = personal_org_id(test_client, alice["access_token"])

    r = test_client.post(
        "/api/human/mm/direct",
        json={"org_id": org_id, "target_id": peer["agent_id"], "target_type": "agent"},
        headers=_auth(alice["access_token"]),
    )
    assert r.status_code == 200, r.text
    dm = r.json()["channel_id"]

    resp = _add(test_client, alice["access_token"], dm, other["agent_id"], "agent")
    assert resp.status_code == 400, resp.text


def test_agent_endpoint_cannot_add_agent_to_a_dm(test_client):
    """The agent-facing mirror must not widen an existing 1:1 either."""
    caller = _create_agent_with_owner(test_client, "dm3-owner@test.com")
    peer = _create_agent_with_owner(test_client, "dm3-owner@test.com")
    other = _create_agent_with_owner(test_client, "dm3-owner@test.com")
    _grant_agent_contact(test_client, peer, caller, can_dm=True)

    r = test_client.post(
        "/api/agentic/mm/direct",
        json={"target_agent_id": peer["agent_id"]},
        headers=_write_headers(test_client, caller["api_key"]),
    )
    assert r.status_code == 200, r.text

    resp = test_client.post(
        f"/api/agentic/mm/channels/{r.json()['channel_id']}/members",
        json={"agent_id": other["agent_id"]},
        headers=_write_headers(test_client, caller["api_key"]),
    )
    assert resp.status_code == 400, resp.text


# ---------------------------------------------------------------------------
# Cross-org additions
# ---------------------------------------------------------------------------


def test_cross_org_human_add_is_refused(test_client, _test_engine):
    """Existence used to be the only gate — so any user id, from any org, was
    addable to a private channel."""
    owner = _register(test_client, "xo-owner@test.com")
    outsider = _register(test_client, "xo-outsider@test.com")
    org_id = personal_org_id(test_client, owner["access_token"])
    ch = _channel(test_client, owner["access_token"], org_id, "private-room")

    test_client.post(
        f"/api/human/mm/channels/{ch}/posts",
        json={"message": "internal only"},
        headers=_auth(owner["access_token"]),
    )

    resp = _add(
        test_client, owner["access_token"], ch, str(outsider["user"]["id"]), "human"
    )
    assert resp.status_code == 403, resp.text
    assert "not a member of this organization" in resp.json()["detail"].lower()

    # The backlog stayed private.
    posts = test_client.get(
        f"/api/human/mm/channels/{ch}/posts", headers=_auth(outsider["access_token"])
    )
    assert posts.status_code == 403, posts.text


def test_same_org_human_add_still_works(test_client):
    """The guard must not break the legitimate flow it is scoping."""
    owner = _register(test_client, "so-owner@test.com")
    colleague = _register(test_client, "so-colleague@test.com")
    org_id = personal_org_id(test_client, owner["access_token"])
    ch = _channel(test_client, owner["access_token"], org_id, "team-room")

    add_human_to_org(test_client, owner["access_token"], org_id, "so-colleague@test.com")
    resp = _add(
        test_client, owner["access_token"], ch, str(colleague["user"]["id"]), "human"
    )
    assert resp.status_code == 200, resp.text
    assert colleague["user"]["id"] in [
        m.get("human_id") for m in resp.json()["members"]
    ]
    assert (
        test_client.get(
            f"/api/human/mm/channels/{ch}/posts", headers=_auth(colleague["access_token"])
        ).status_code
        == 200
    )


def test_cross_org_agent_add_is_refused(test_client):
    """``can_tag`` is a contact grant, not an org boundary.

    The operator of a foreign agent is free to grant themselves tag rights, so
    without an explicit org check they could pull that agent into any channel
    they belong to — and it would then receive everything posted there.
    """
    foreign_agent = _create_agent_with_owner(test_client, "ao-foreign@test.com")
    owner = _register(test_client, "ao-owner@test.com")
    org_id = personal_org_id(test_client, owner["access_token"])
    ch = _channel(test_client, owner["access_token"], org_id, "org-room")

    resp = _add(test_client, owner["access_token"], ch, foreign_agent["agent_id"], "agent")
    assert resp.status_code == 403, resp.text
    assert "does not belong to this organization" in resp.json()["detail"]


def test_same_org_agent_add_still_works(test_client):
    own_agent = _create_agent_with_owner(test_client, "ao2-owner@test.com")
    owner = _register(test_client, "ao2-owner@test.com")
    org_id = personal_org_id(test_client, owner["access_token"])
    ch = _channel(test_client, owner["access_token"], org_id, "org-room")

    resp = _add(test_client, owner["access_token"], ch, own_agent["agent_id"], "agent")
    assert resp.status_code == 200, resp.text
    assert own_agent["agent_id"] in [m.get("agent_id") for m in resp.json()["members"]]


# ---------------------------------------------------------------------------
# The agent-facing mirror carries the same rules
# ---------------------------------------------------------------------------


def test_agent_endpoint_refuses_cross_org_agent(test_client):
    a1 = _create_agent_with_owner(test_client, "ae-one@test.com")
    a2 = _create_agent_with_owner(test_client, "ae-two@test.com")   # different org
    _grant_agent_contact(test_client, a2, a1, can_tag=True)

    r = test_client.post(
        "/api/agentic/mm/channels",
        json={"name": "collab", "channel_type": "public"},
        headers=_write_headers(test_client, a1["api_key"]),
    )
    assert r.status_code == 200, r.text
    ch_id = r.json()["channel_id"]

    resp = test_client.post(
        f"/api/agentic/mm/channels/{ch_id}/members",
        json={"agent_id": a2["agent_id"]},
        headers=_write_headers(test_client, a1["api_key"]),
    )
    assert resp.status_code == 403, resp.text
    assert "does not belong to this organization" in resp.json()["detail"]


def test_agent_endpoint_allows_same_org_agent(test_client):
    a1 = _create_agent_with_owner(test_client, "ae-same@test.com")
    a2 = _create_agent_with_owner(test_client, "ae-same@test.com")  # same org
    _grant_agent_contact(test_client, a2, a1, can_tag=True)

    r = test_client.post(
        "/api/agentic/mm/channels",
        json={"name": "collab", "channel_type": "public"},
        headers=_write_headers(test_client, a1["api_key"]),
    )
    ch_id = r.json()["channel_id"]

    resp = test_client.post(
        f"/api/agentic/mm/channels/{ch_id}/members",
        json={"agent_id": a2["agent_id"]},
        headers=_write_headers(test_client, a1["api_key"]),
    )
    assert resp.status_code == 200, resp.text
    assert a2["agent_id"] in [m.get("agent_id") for m in resp.json()["members"]]
