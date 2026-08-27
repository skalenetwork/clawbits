"""Removing a human from an org revokes their access to that org's channels.

Audit finding T0-10.

``remove_org_member`` deleted the ``OrgMember`` row and nothing else. Every
``mm_channel_members`` row survived, and the gates that guard channel access
ask about *channel* membership, not org membership -- ``_require_human_member``
is the only check on reading history, posting, exporting, and on the SSE
stream's periodic re-authorisation. So an ex-member kept working access to
every channel they had been in: the removal was cosmetic, visible in the
members list and nowhere else.

The fix deletes the channel membership rows, which makes every existing gate
answer correctly instead of requiring a new org check bolted onto each route.

Two deliberate non-goals, asserted below so a later change has to be explicit
about reversing them:

* Channels are **not** torn down when this empties them of humans. The org
  still owns them and an owner can delete them from Settings; silently
  destroying history as a side effect of an HR action is the wrong default.
* Other people's rows are untouched -- in particular their read pointers,
  which a careless scoped delete would take with it.

This is one half of a two-part hole. The other half is credential
revalidation on the global ``/api/human/events`` stream, which has no
mid-stream authorisation at all; deleting these rows does not fix that, and
that stream is tracked separately.
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


def _add_to_channel(tc: TestClient, token: str, channel_id: str, human_id: int) -> None:
    r = tc.post(
        f"/api/human/mm/channels/{channel_id}/members",
        json={"member_id": str(human_id), "member_type": "human"},
        headers=_auth(token),
    )
    assert r.status_code == 200, r.text


def _org_with_member(tc: TestClient, slug: str):
    owner = _register(tc, f"{slug}-owner@test.com")
    org_id = personal_org_id(tc, owner["access_token"])
    leaver = _register(tc, f"{slug}-leaver@test.com")
    add_human_to_org(tc, owner["access_token"], org_id, leaver["user"]["email"])
    channel_id = _channel(tc, owner["access_token"], org_id, f"{slug}-room")
    _add_to_channel(tc, owner["access_token"], channel_id, leaver["user"]["id"])
    return owner, leaver, org_id, channel_id


def _remove_from_org(tc: TestClient, owner_token: str, org_id: str, human_id: int):
    return tc.delete(
        f"/api/human/orgs/{org_id}/members/{human_id}", headers=_auth(owner_token)
    )


def test_removed_member_loses_channel_read_access(test_client, _test_engine):
    """The headline: history stayed readable after removal."""
    owner, leaver, org_id, channel_id = _org_with_member(test_client, "revoke-read")

    r = test_client.get(
        f"/api/human/mm/channels/{channel_id}/posts", headers=_auth(leaver["access_token"])
    )
    assert r.status_code == 200, r.text

    assert _remove_from_org(
        test_client, owner["access_token"], org_id, leaver["user"]["id"]
    ).status_code == 200

    r = test_client.get(
        f"/api/human/mm/channels/{channel_id}/posts", headers=_auth(leaver["access_token"])
    )
    assert r.status_code == 403, r.text


def test_removed_member_loses_channel_write_access(test_client, _test_engine):
    owner, leaver, org_id, channel_id = _org_with_member(test_client, "revoke-write")
    assert _remove_from_org(
        test_client, owner["access_token"], org_id, leaver["user"]["id"]
    ).status_code == 200

    r = test_client.post(
        f"/api/human/mm/channels/{channel_id}/posts",
        json={"message": "still here"},
        headers=_auth(leaver["access_token"]),
    )
    assert r.status_code == 403, r.text


def test_removed_member_channel_list_drops_the_org_channel(test_client, _test_engine):
    owner, leaver, org_id, channel_id = _org_with_member(test_client, "revoke-list")
    assert _remove_from_org(
        test_client, owner["access_token"], org_id, leaver["user"]["id"]
    ).status_code == 200

    r = test_client.get("/api/human/mm/channels", headers=_auth(leaver["access_token"]))
    assert r.status_code == 200, r.text
    assert channel_id not in [c["channel_id"] for c in r.json()["channels"]]


def test_remaining_members_are_untouched(test_client, _test_engine):
    """Guard against an over-broad delete taking other people with it."""
    owner, leaver, org_id, channel_id = _org_with_member(test_client, "revoke-others")
    stayer = _register(test_client, "revoke-others-stayer@test.com")
    add_human_to_org(test_client, owner["access_token"], org_id, stayer["user"]["email"])
    _add_to_channel(test_client, owner["access_token"], channel_id, stayer["user"]["id"])

    assert _remove_from_org(
        test_client, owner["access_token"], org_id, leaver["user"]["id"]
    ).status_code == 200

    r = test_client.get(
        f"/api/human/mm/channels/{channel_id}/members", headers=_auth(owner["access_token"])
    )
    assert r.status_code == 200, r.text
    human_ids = {m.get("human_id") for m in r.json()["members"]}
    assert stayer["user"]["id"] in human_ids
    assert leaver["user"]["id"] not in human_ids

    # And the stayer can still read.
    r = test_client.get(
        f"/api/human/mm/channels/{channel_id}/posts", headers=_auth(stayer["access_token"])
    )
    assert r.status_code == 200, r.text


def test_channel_survives_losing_its_last_member(test_client, _test_engine):
    """Removal is an HR action, not a delete. The channel stays for the org."""
    owner, leaver, org_id, _c = _org_with_member(test_client, "revoke-survive")
    solo = _channel(test_client, owner["access_token"], org_id, "revoke-survive-solo")
    _add_to_channel(test_client, owner["access_token"], solo, leaver["user"]["id"])
    # Owner leaves it, so the leaver is the only human in it.
    r = test_client.delete(
        f"/api/human/mm/channels/{solo}/members/{owner['user']['id']}?member_type=human",
        headers=_auth(owner["access_token"]),
    )
    assert r.status_code == 200, r.text

    assert _remove_from_org(
        test_client, owner["access_token"], org_id, leaver["user"]["id"]
    ).status_code == 200

    # The channel row is still there for an org owner to administer.
    r = test_client.get(
        f"/api/human/mm/channels/{solo}", headers=_auth(owner["access_token"])
    )
    assert r.status_code in (200, 403), r.text
    assert r.status_code != 404, "channel was destroyed as a side effect of a removal"


def test_other_orgs_channels_are_unaffected(test_client, _test_engine):
    """The delete is scoped to the org being left, not to the human.

    Note the setup order: ``personal_org_id`` reads ``is_personal``, which is a
    property of the *organization*, not of the caller's relationship to it. Once
    the leaver has joined the owner's personal org they belong to two orgs that
    both report ``is_personal``, and the helper can return either. Their own org
    is therefore captured before the join, while it is unambiguous.
    """
    owner = _register(test_client, "revoke-scope-owner@test.com")
    org_id = personal_org_id(test_client, owner["access_token"])
    leaver = _register(test_client, "revoke-scope-leaver@test.com")

    own_org = personal_org_id(test_client, leaver["access_token"])
    own_channel = _channel(test_client, leaver["access_token"], own_org, "my-own-room")
    assert own_org != org_id

    add_human_to_org(
        test_client, owner["access_token"], org_id, leaver["user"]["email"]
    )
    shared = _channel(test_client, owner["access_token"], org_id, "revoke-scope-room")
    _add_to_channel(test_client, owner["access_token"], shared, leaver["user"]["id"])

    assert _remove_from_org(
        test_client, owner["access_token"], org_id, leaver["user"]["id"]
    ).status_code == 200

    # Revoked in the org they were removed from...
    r = test_client.get(
        f"/api/human/mm/channels/{shared}/posts", headers=_auth(leaver["access_token"])
    )
    assert r.status_code == 403, r.text

    # ...and untouched in their own.
    r = test_client.get(
        f"/api/human/mm/channels/{own_channel}/posts",
        headers=_auth(leaver["access_token"]),
    )
    assert r.status_code == 200, r.text
