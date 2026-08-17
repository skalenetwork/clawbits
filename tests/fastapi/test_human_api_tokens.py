"""Personal access token (PAT) tests.

Guards the plane-separation contract in
:mod:`clawbits.fastapi.human_token_endpoints`:

* Humans mint ``cbp_…`` tokens at ``POST /api/human/tokens`` from an
  interactive session; the plaintext is returned exactly once.
* A PAT authenticates human routes exactly like a session bearer.
* A PAT never authenticates ``/api/agentic/*``, and an agent ``fc_…``
  key never authenticates a human route — different tables, different
  sign-in paths.
* A PAT cannot mint further PATs (no self-renewing foothold).
* Expiry and revocation both surface as the same 401.
"""
from __future__ import annotations

import datetime as dt

from sqlmodel import Session

from clawbits.db.table_write import TableWrite
from tests.fastapi._auth_helpers import auth_headers, login_human

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _mint(tc, session_token: str, label: str = "cli", **body) -> dict:
    resp = tc.post(
        "/api/human/tokens",
        json={"label": label, **body},
        headers=auth_headers(session_token),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# Minting
# ---------------------------------------------------------------------------


def test_mint_returns_plaintext_once_and_never_again(test_client):
    session, _user = login_human(test_client, "pat-mint@example.com")
    created = _mint(test_client, session, label="laptop")

    assert created["token"].startswith("cbp_")
    assert created["label"] == "laptop"
    assert created["expires_at"] is None

    # The list shows a hint and metadata, never the plaintext or a hash.
    listing = test_client.get(
        "/api/human/tokens", headers=auth_headers(session)
    ).json()
    assert listing["total"] == 1
    entry = listing["tokens"][0]
    assert entry["token_id"] == created["token_id"]
    assert entry["token_hint"] == created["token"][:8]
    assert "token" not in entry
    assert "token_hash" not in entry


def test_mint_requires_auth(test_client):
    resp = test_client.post("/api/human/tokens", json={"label": "x"})
    assert resp.status_code == 401


def test_mint_with_expiry_reports_it(test_client):
    session, _user = login_human(test_client, "pat-expiring@example.com")
    created = _mint(test_client, session, label="short", expires_in_days=7)
    assert created["expires_at"] is not None


# ---------------------------------------------------------------------------
# Authenticating with a PAT
# ---------------------------------------------------------------------------


def test_pat_authenticates_human_routes(test_client):
    session, user = login_human(test_client, "pat-auth@example.com")
    token = _mint(test_client, session)["token"]

    me = test_client.get("/api/auth/me", headers=auth_headers(token))
    assert me.status_code == 200, me.text
    assert me.json()["id"] == user["id"]

    orgs = test_client.get("/api/human/orgs", headers=auth_headers(token))
    assert orgs.status_code == 200, orgs.text
    assert any(o["is_personal"] for o in orgs.json()["organizations"])


def test_unknown_pat_is_401_not_workos_fallthrough(test_client):
    resp = test_client.get(
        "/api/auth/me", headers=auth_headers("cbp_definitely-not-a-real-token")
    )
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Invalid or expired token"


def test_pat_rejected_on_agentic_routes(test_client):
    """The human credential never crosses onto the agent plane."""
    session, _user = login_human(test_client, "pat-cross@example.com")
    token = _mint(test_client, session)["token"]

    resp = test_client.get(
        "/api/agentic/mm/channels", headers=auth_headers(token)
    )
    assert resp.status_code in (401, 403), resp.text


def test_agent_key_rejected_on_human_routes(test_client, api_key):
    """And the agent credential never crosses onto the human plane."""
    resp = test_client.get("/api/human/orgs", headers=auth_headers(api_key))
    assert resp.status_code == 401, resp.text


def test_expired_pat_is_401(test_client, _test_engine):
    session, user = login_human(test_client, "pat-expired@example.com")
    # The endpoint can't mint an already-expired token (ge=1 day), so write
    # one directly — same code path the resolver reads.
    with Session(_test_engine) as db:
        _token_id, plaintext = TableWrite.create_human_api_token(
            db,
            human_id=user["id"],
            label="stale",
            expires_at=dt.datetime.now(dt.UTC) - dt.timedelta(minutes=1),
        )
        db.commit()

    resp = test_client.get("/api/auth/me", headers=auth_headers(plaintext))
    assert resp.status_code == 401
    # Still visible in the list so the owner can see and delete it.
    listing = test_client.get(
        "/api/human/tokens", headers=auth_headers(session)
    ).json()
    assert listing["total"] == 1


# ---------------------------------------------------------------------------
# The no-self-mint rule
# ---------------------------------------------------------------------------


def test_pat_cannot_mint_another_pat(test_client):
    session, _user = login_human(test_client, "pat-escalate@example.com")
    token = _mint(test_client, session)["token"]

    resp = test_client.post(
        "/api/human/tokens",
        json={"label": "spawn"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 403, resp.text
    # …but reading and revoking with a PAT is fine.
    assert (
        test_client.get("/api/human/tokens", headers=auth_headers(token)).status_code
        == 200
    )


# ---------------------------------------------------------------------------
# Revocation
# ---------------------------------------------------------------------------


def test_revoked_pat_stops_working_immediately(test_client):
    session, _user = login_human(test_client, "pat-revoke@example.com")
    created = _mint(test_client, session)

    ok = test_client.delete(
        f"/api/human/tokens/{created['token_id']}", headers=auth_headers(session)
    )
    assert ok.status_code == 204

    resp = test_client.get("/api/auth/me", headers=auth_headers(created["token"]))
    assert resp.status_code == 401


def test_cannot_revoke_someone_elses_token(test_client):
    session_a, _a = login_human(test_client, "pat-owner@example.com")
    created = _mint(test_client, session_a)

    session_b, _b = login_human(test_client, "pat-intruder@example.com")
    resp = test_client.delete(
        f"/api/human/tokens/{created['token_id']}", headers=auth_headers(session_b)
    )
    # 404, not 403 — ids must not be probeable across accounts.
    assert resp.status_code == 404

    # Untouched: still works for its owner.
    assert (
        test_client.get(
            "/api/auth/me", headers=auth_headers(created["token"])
        ).status_code
        == 200
    )


def test_revoking_the_authenticating_token_is_allowed(test_client):
    """Killing the credential you just leaked must not require a browser."""
    session, _user = login_human(test_client, "pat-self-revoke@example.com")
    created = _mint(test_client, session)

    resp = test_client.delete(
        f"/api/human/tokens/{created['token_id']}",
        headers=auth_headers(created["token"]),
    )
    assert resp.status_code == 204
    assert (
        test_client.get(
            "/api/auth/me", headers=auth_headers(created["token"])
        ).status_code
        == 401
    )


# ---------------------------------------------------------------------------
# Limits and account teardown
# ---------------------------------------------------------------------------


def test_token_cap_is_enforced(test_client):
    session, _user = login_human(test_client, "pat-cap@example.com")
    for i in range(TableWrite.HUMAN_API_TOKEN_CAP):
        _mint(test_client, session, label=f"t{i}")

    resp = test_client.post(
        "/api/human/tokens",
        json={"label": "one-too-many"},
        headers=auth_headers(session),
    )
    assert resp.status_code == 400
    assert "limit" in resp.json()["detail"].lower()


def test_account_deletion_removes_tokens(test_client):
    session, _user = login_human(test_client, "pat-deleted@example.com")
    token = _mint(test_client, session)["token"]

    resp = test_client.delete("/api/human/account", headers=auth_headers(session))
    assert resp.status_code == 204, resp.text

    assert (
        test_client.get("/api/auth/me", headers=auth_headers(token)).status_code
        == 401
    )
