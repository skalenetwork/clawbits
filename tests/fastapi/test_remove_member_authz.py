"""Removing *others* from a channel is an admin action, and a DM is not a group.

Audit findings T0-02 / T0-08 / T0-09 (and T1-03).

``remove_member`` authorised with ``_require_human_member`` alone -- plain
membership. Three consequences, all reachable by any member:

1. Evict the channel creator. They cannot get back in: ``join_channel``
   refuses non-public channels and ``add_member`` requires the caller already
   be a member, so the owner is locked out of their own channel.
2. Destroy the channel. Removing every other human one at a time never trips
   the "last human left" teardown (the remover is still there), so afterwards
   they remove themselves and the branch fires: posts, files, events and the
   channel row are all hard-deleted, for everyone. That routes around the
   creator/owner gate on ``DELETE /channels/{id}`` entirely.
3. Brick a DM. DM names are deterministic per (org, pair) and ``mm_channels``
   is unique on ``(org_id, name)``, so a DM that drops to one member is found
   by neither the by-members lookup nor recreatable -- the insert collides and
   500s. The org-scope guard added to ``add_member`` removed the last repair
   path, making it permanent.

The model these tests pin, which ``admin_delete_channel``'s docstring already
described: *leaving* (removing yourself) needs membership; *removing someone
else* needs the creator or an org owner; a DM's membership is fixed, and an
orphaned DM heals on reopen rather than colliding.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from tests.fastapi._auth_helpers import add_human_to_org, personal_org_id
from tests.fastapi._auth_helpers import auth_headers as _auth
from tests.fastapi._auth_helpers import register_human as _register


def _channel(tc: TestClient, token: str, org_id: str, name: str) -> str:
    r = tc.post(
        "/api/human/mm/channels",
        json={"org_id": org_id, "name": name, "channel_type": "private"},
        headers=_auth(token),
    )
    assert r.status_code == 200, r.text
    return r.json()["channel_id"]


def _remove(tc: TestClient, token: str, channel_id: str, member_id, member_type="human"):
    return tc.delete(
        f"/api/human/mm/channels/{channel_id}/members/{member_id}"
        f"?member_type={member_type}",
        headers=_auth(token),
    )


def _owner_and_member(tc: TestClient, slug: str):
    """A private channel with its creator plus two ordinary members."""
    owner = _register(tc, f"{slug}-owner@test.com")
    org_id = personal_org_id(tc, owner["access_token"])
    mallory = _register(tc, f"{slug}-mallory@test.com")
    victim = _register(tc, f"{slug}-victim@test.com")
    for u in (mallory, victim):
        add_human_to_org(tc, owner["access_token"], org_id, u["user"]["email"])
    channel_id = _channel(tc, owner["access_token"], org_id, f"{slug}-room")
    for u in (mallory, victim):
        r = tc.post(
            f"/api/human/mm/channels/{channel_id}/members",
            json={"member_id": str(u["user"]["id"]), "member_type": "human"},
            headers=_auth(owner["access_token"]),
        )
        assert r.status_code == 200, r.text
    return owner, mallory, victim, channel_id, org_id


# ---------------------------------------------------------------------------
# Removing other people
# ---------------------------------------------------------------------------


def test_member_cannot_evict_another_member(test_client, _test_engine):
    owner, mallory, victim, channel_id, _org = _owner_and_member(test_client, "evict")
    r = _remove(test_client, mallory["access_token"], channel_id, victim["user"]["id"])
    assert r.status_code == 403, r.text


def test_member_cannot_evict_the_creator(test_client, _test_engine):
    """The lock-out: there is no way back into a private channel."""
    owner, mallory, _victim, channel_id, _org = _owner_and_member(test_client, "creator")
    r = _remove(test_client, mallory["access_token"], channel_id, owner["user"]["id"])
    assert r.status_code == 403, r.text


def test_member_cannot_destroy_the_channel_by_draining_it(test_client, _test_engine):
    """The full exploit chain, end to end."""
    owner, mallory, victim, channel_id, _org = _owner_and_member(test_client, "drain")
    for target in (victim["user"]["id"], owner["user"]["id"]):
        assert _remove(
            test_client, mallory["access_token"], channel_id, target
        ).status_code == 403

    # The channel and its members are intact.
    r = test_client.get(
        f"/api/human/mm/channels/{channel_id}/members",
        headers=_auth(owner["access_token"]),
    )
    assert r.status_code == 200, r.text
    assert len(r.json()["members"]) == 3


def test_creator_can_remove_a_member(test_client, _test_engine):
    owner, _mallory, victim, channel_id, _org = _owner_and_member(test_client, "bycreator")
    r = _remove(test_client, owner["access_token"], channel_id, victim["user"]["id"])
    assert r.status_code == 200, r.text
    assert victim["user"]["id"] not in [
        m.get("human_id") for m in r.json()["members"]
    ]


def test_member_can_still_leave(test_client, _test_engine):
    """Leaving must stay open to everyone -- it is not an admin action."""
    _owner, mallory, _victim, channel_id, _org = _owner_and_member(test_client, "leave")
    r = _remove(test_client, mallory["access_token"], channel_id, mallory["user"]["id"])
    assert r.status_code == 200, r.text


# ---------------------------------------------------------------------------
# Direct channels
# ---------------------------------------------------------------------------


def _human_dm(tc: TestClient, a: dict, b: dict, org_id: str) -> str:
    r = tc.post(
        "/api/human/mm/direct",
        json={"org_id": org_id, "target_type": "human", "target_id": str(b["user"]["id"])},
        headers=_auth(a["access_token"]),
    )
    assert r.status_code == 200, r.text
    return r.json()["channel_id"]


def test_cannot_remove_the_other_party_from_a_dm(test_client, _test_engine):
    alice = _register(test_client, "dmauthz-alice@test.com")
    org_id = personal_org_id(test_client, alice["access_token"])
    bob = _register(test_client, "dmauthz-bob@test.com")
    add_human_to_org(test_client, alice["access_token"], org_id, bob["user"]["email"])
    channel_id = _human_dm(test_client, alice, bob, org_id)

    r = _remove(test_client, alice["access_token"], channel_id, bob["user"]["id"])
    assert r.status_code == 400, r.text


def test_reopening_an_orphaned_dm_heals_it(test_client, _test_engine):
    """A DM that lost a member used to 500 forever on reopen.

    The row is found by name but not by membership, and the deterministic name
    collides with the unique ``(org_id, name)``.
    """
    alice = _register(test_client, "dmheal-alice@test.com")
    org_id = personal_org_id(test_client, alice["access_token"])
    bob = _register(test_client, "dmheal-bob@test.com")
    add_human_to_org(test_client, alice["access_token"], org_id, bob["user"]["email"])
    channel_id = _human_dm(test_client, alice, bob, org_id)

    # Alice closes her side.
    r = _remove(test_client, alice["access_token"], channel_id, alice["user"]["id"])
    assert r.status_code == 200, r.text

    # Reopening returns the same conversation rather than colliding.
    reopened = _human_dm(test_client, alice, bob, org_id)
    assert reopened == channel_id

    r = test_client.get(
        f"/api/human/mm/channels/{channel_id}/members",
        headers=_auth(alice["access_token"]),
    )
    assert r.status_code == 200, r.text
    human_ids = {m.get("human_id") for m in r.json()["members"]}
    assert {alice["user"]["id"], bob["user"]["id"]} <= human_ids
