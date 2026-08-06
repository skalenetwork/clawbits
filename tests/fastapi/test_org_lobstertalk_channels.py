"""Tests for the per-channel LobsterTalk allowlist
(PUT /api/human/orgs/{org_id}/lobstertalk/channels/{channel_id}) and its
surface in the org-admin channels list. Closed by default: a fresh channel is
unapproved, and only public channels can be approved at all. Runtime
enforcement in the attention pass is covered in test_lobstertalk_attention."""
from sqlmodel import Session
from starlette.testclient import TestClient

from clawbits.db.models import MmChannel
from tests.fastapi._auth_helpers import auth_headers as _auth
from tests.fastapi._auth_helpers import register_human
from tests.fastapi.test_org_lobstertalk_settings import _make_org

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _make_channel(
    tc: TestClient, token: str, org_id: str, name: str, channel_type: str = "public"
) -> str:
    r = tc.post(
        "/api/human/mm/channels",
        json={"org_id": org_id, "name": name, "channel_type": channel_type},
        headers=_auth(token),
    )
    assert r.status_code == 200, r.text
    return r.json()["channel_id"]


def _put_approval(tc: TestClient, org_id: str, channel_id: str, token: str, body: dict):
    return tc.put(
        f"/api/human/orgs/{org_id}/lobstertalk/channels/{channel_id}",
        json=body,
        headers=_auth(token),
    )


def _admin_list(tc: TestClient, org_id: str, token: str) -> dict:
    r = tc.get(f"/api/human/mm/orgs/{org_id}/channels", headers=_auth(token))
    assert r.status_code == 200, r.text
    return {c["channel_id"]: c for c in r.json()["channels"]}


def _stored_flag(tc: TestClient, channel_id: str) -> bool:
    with Session(tc.app._engine) as db:
        return db.get(MmChannel, channel_id).lobstertalk_approved


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_admin_channel_list_defaults_unapproved(test_client):
    """A fresh public channel is off the allowlist — the post-migration state
    of every channel (closed by default, no backfill)."""
    owner = register_human(test_client, "ltc-default-owner@test.com")
    org_id = _make_org(test_client, owner["access_token"], "ltc-default-org")
    ch_id = _make_channel(test_client, owner["access_token"], org_id, "ltc-default")

    rows = _admin_list(test_client, org_id, owner["access_token"])
    assert rows[ch_id]["lobstertalk_approved"] is False
    assert _stored_flag(test_client, ch_id) is False


def test_owner_approves_and_revokes_channel(test_client):
    owner = register_human(test_client, "ltc-rt-owner@test.com")
    org_id = _make_org(test_client, owner["access_token"], "ltc-rt-org")
    token = owner["access_token"]
    ch_id = _make_channel(test_client, token, org_id, "ltc-rt")

    r = _put_approval(test_client, org_id, ch_id, token, {"approved": True})
    assert r.status_code == 200, r.text
    assert r.json() == {"channel_id": ch_id, "lobstertalk_approved": True}
    assert _admin_list(test_client, org_id, token)[ch_id]["lobstertalk_approved"] is True
    assert _stored_flag(test_client, ch_id) is True

    r = _put_approval(test_client, org_id, ch_id, token, {"approved": False})
    assert r.status_code == 200, r.text
    assert r.json() == {"channel_id": ch_id, "lobstertalk_approved": False}
    assert _stored_flag(test_client, ch_id) is False


def test_member_cannot_set_channel_approval(test_client):
    owner = register_human(test_client, "ltc-acl-owner@test.com")
    member = register_human(test_client, "ltc-acl-member@test.com")
    org_id = _make_org(test_client, owner["access_token"], "ltc-acl-org")
    test_client.post(
        f"/api/human/orgs/{org_id}/members",
        json={"email": "ltc-acl-member@test.com", "role": "member"},
        headers=_auth(owner["access_token"]),
    )
    ch_id = _make_channel(test_client, owner["access_token"], org_id, "ltc-acl")

    r = _put_approval(test_client, org_id, ch_id, member["access_token"], {"approved": True})
    assert r.status_code == 403
    assert _stored_flag(test_client, ch_id) is False


def test_foreign_or_unknown_channel_is_404(test_client):
    """Another org's channel and a bogus id are the same 404 — the endpoint
    must not be a cross-org channel-id oracle (a 403 would confirm the id
    exists)."""
    owner_a = register_human(test_client, "ltc-404-owner-a@test.com")
    owner_b = register_human(test_client, "ltc-404-owner-b@test.com")
    org_a = _make_org(test_client, owner_a["access_token"], "ltc-404-org-a")
    org_b = _make_org(test_client, owner_b["access_token"], "ltc-404-org-b")
    foreign_ch = _make_channel(test_client, owner_a["access_token"], org_a, "ltc-404")

    r = _put_approval(
        test_client, org_b, foreign_ch, owner_b["access_token"], {"approved": True}
    )
    assert r.status_code == 404, r.text
    assert _stored_flag(test_client, foreign_ch) is False

    r = _put_approval(
        test_client, org_b, "no-such-channel", owner_b["access_token"], {"approved": True}
    )
    assert r.status_code == 404, r.text


def test_non_public_channel_is_422(test_client):
    """Non-public channels can't be approved *or* revoked — the attention gate
    hard-requires public first, so the flag would be dead either way."""
    owner = register_human(test_client, "ltc-priv-owner@test.com")
    org_id = _make_org(test_client, owner["access_token"], "ltc-priv-org")
    token = owner["access_token"]
    ch_id = _make_channel(test_client, token, org_id, "ltc-priv", channel_type="private")

    for approved in (True, False):
        r = _put_approval(test_client, org_id, ch_id, token, {"approved": approved})
        assert r.status_code == 422, r.text
    assert _stored_flag(test_client, ch_id) is False


def test_extra_fields_rejected(test_client):
    """The request model pins extra="forbid"."""
    owner = register_human(test_client, "ltc-extra-owner@test.com")
    org_id = _make_org(test_client, owner["access_token"], "ltc-extra-org")
    token = owner["access_token"]
    ch_id = _make_channel(test_client, token, org_id, "ltc-extra")

    r = _put_approval(test_client, org_id, ch_id, token, {"approved": True, "x": 1})
    assert r.status_code == 422
    assert _stored_flag(test_client, ch_id) is False
