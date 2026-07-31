"""On-login reconcile of WorkOS org memberships into the local DB.

WorkOS is the source of truth for who is *invited* to an org (admins add
users via the WorkOS dashboard), but the app's org switcher reads our
local ``org_members`` table. Without a webhook, dashboard-side additions
would never appear in the app. The reconcile inside ``_ensure_user``
closes that gap on every login — see :func:`_reconcile_workos_memberships`
in ``clawbits.fastapi.workos_auth``.
"""
from __future__ import annotations

import secrets

from sqlmodel import Session, select

from clawbits.db.models import Organization
from tests.fastapi._auth_helpers import auth_headers, login_human
from tests.fastapi._fakes import _FakeMembership, _FakeOrg


def _workos_org_id_for(test_client, *, org_id: str) -> str:
    """Look up the ``workos_org_id`` for a local org row."""
    with Session(test_client.app._engine) as db:
        row = db.exec(
            select(Organization).where(Organization.org_id == org_id)
        ).one()
        return row.workos_org_id


def _create_shared_org(test_client, *, owner_email: str, name: str) -> dict:
    """Owner logs in and creates a non-personal org via the app. Returns the
    ``OrgResponse`` dict plus the WorkOS-side id (not in the public schema)."""
    owner_token, _ = login_human(test_client, owner_email)
    resp = test_client.post(
        "/api/human/orgs", json={"name": name}, headers=auth_headers(owner_token),
    )
    assert resp.status_code == 200, resp.text
    org = resp.json()
    org["workos_org_id"] = _workos_org_id_for(test_client, org_id=org["org_id"])
    test_client.cookies.clear()
    return org


def _attach_workos_membership(
    test_client, *, workos_user_id: str, workos_org_id: str, role: str = "member",
) -> _FakeMembership:
    """Simulate an admin adding the user to the org via the WorkOS dashboard
    by appending the membership directly to the in-memory fake."""
    m = _FakeMembership(
        id=f"om_{secrets.token_hex(8)}",
        user_id=workos_user_id,
        organization_id=workos_org_id,
        role=role,
    )
    test_client.app.state.workos.memberships.append(m)
    return m


# ---------------------------------------------------------------------------
# Happy path: dashboard add → next-login pick-up
# ---------------------------------------------------------------------------


def test_dashboard_membership_appears_on_next_login(test_client):
    """An admin adds a user to an org via the WorkOS dashboard; on their
    next login the org shows up in ``GET /api/human/orgs``."""
    bob_email = "bob@reconcile.example.com"

    # Bob has logged in before — personal org row + WorkOS membership exist.
    _, _ = login_human(test_client, bob_email)
    test_client.cookies.clear()
    bob_workos_id = test_client.app.state.workos.users_by_email[bob_email].id

    # Owner creates a shared org via the app.
    shared = _create_shared_org(
        test_client, owner_email="owner@reconcile.example.com", name="reconcile-team",
    )

    # Admin uses the WorkOS dashboard to add Bob to the shared org.
    _attach_workos_membership(
        test_client,
        workos_user_id=bob_workos_id,
        workos_org_id=shared["workos_org_id"],
        role="member",
    )

    # Bob logs in again.
    bob_token, _ = login_human(test_client, bob_email)

    orgs = test_client.get(
        "/api/human/orgs", headers=auth_headers(bob_token),
    ).json()["organizations"]
    matching = [o for o in orgs if o["org_id"] == shared["org_id"]]
    assert len(matching) == 1, f"shared org missing from Bob's orgs: {orgs}"
    assert matching[0]["my_role"] == "member"


# ---------------------------------------------------------------------------
# Role propagation
# ---------------------------------------------------------------------------


def test_workos_role_change_syncs_on_next_login(test_client):
    """Promoting a user from ``member`` → ``admin`` in WorkOS reflects as
    ``owner`` locally on their next login."""
    bob_email = "bob@role.example.com"
    _, _ = login_human(test_client, bob_email)
    test_client.cookies.clear()
    adapter = test_client.app.state.workos
    bob_workos_id = adapter.users_by_email[bob_email].id

    # Owner creates org and adds Bob as member via the app — both local and
    # WorkOS sides now have a "member" row for Bob.
    owner_token, _ = login_human(test_client, "owner@role.example.com")
    create_resp = test_client.post(
        "/api/human/orgs", json={"name": "role-team"},
        headers=auth_headers(owner_token),
    )
    shared_org_id = create_resp.json()["org_id"]
    add_resp = test_client.post(
        f"/api/human/orgs/{shared_org_id}/members",
        json={"email": bob_email, "role": "member"},
        headers=auth_headers(owner_token),
    )
    assert add_resp.status_code == 200, add_resp.text
    test_client.cookies.clear()

    # WorkOS-side promotion: flip the role on Bob's membership.
    shared_workos_id = _workos_org_id_for(test_client, org_id=shared_org_id)
    for m in adapter.memberships:
        if m.user_id == bob_workos_id and m.organization_id == shared_workos_id:
            m.role = "admin"
            break
    else:  # pragma: no cover — wiring bug if we hit this
        raise AssertionError("test setup didn't mirror membership to WorkOS")

    # Bob logs in. Role on the shared org should now be "owner".
    bob_token, _ = login_human(test_client, bob_email)
    orgs = test_client.get(
        "/api/human/orgs", headers=auth_headers(bob_token),
    ).json()["organizations"]
    matching = [o for o in orgs if o["org_id"] == shared_org_id][0]
    assert matching["my_role"] == "owner"


# ---------------------------------------------------------------------------
# Safety: orgs that don't exist locally are skipped, not auto-imported
# ---------------------------------------------------------------------------


def test_workos_membership_for_unknown_org_is_skipped(test_client):
    """A WorkOS membership pointing at an org we don't know locally is
    ignored. Auto-import of dashboard-only orgs is a separate decision."""
    bob_email = "bob@unknown.example.com"
    _, _ = login_human(test_client, bob_email)
    test_client.cookies.clear()
    adapter = test_client.app.state.workos
    bob_workos_id = adapter.users_by_email[bob_email].id

    # Pre-existing personal org (1 membership).
    personal_workos_id = next(
        m.organization_id for m in adapter.memberships if m.user_id == bob_workos_id
    )

    # WorkOS-only org with no local counterpart.
    ghost_id = f"org_{secrets.token_hex(8)}"
    adapter.orgs[ghost_id] = _FakeOrg(id=ghost_id, name="ghost-org")
    _attach_workos_membership(
        test_client, workos_user_id=bob_workos_id, workos_org_id=ghost_id,
    )

    # Bob logs in. Personal org should still be the only one he sees.
    bob_token, _ = login_human(test_client, bob_email)
    orgs = test_client.get(
        "/api/human/orgs", headers=auth_headers(bob_token),
    ).json()["organizations"]
    workos_ids_seen = {
        _workos_org_id_for(test_client, org_id=o["org_id"]) for o in orgs
    }
    assert workos_ids_seen == {personal_workos_id}


# ---------------------------------------------------------------------------
# Resilience: a WorkOS API failure must never break login
# ---------------------------------------------------------------------------


def test_reconcile_failure_does_not_break_login(test_client, monkeypatch):
    """If ``list_organization_memberships`` throws, login still succeeds and
    the user can still list their (previously synced) orgs."""
    bob_email = "bob@flaky.example.com"

    def boom(*_a, **_kw):
        raise RuntimeError("simulated WorkOS outage")

    monkeypatch.setattr(
        test_client.app.state.workos.user_management,
        "list_organization_memberships",
        boom,
    )

    bob_token, bob_user = login_human(test_client, bob_email)
    assert bob_user["email"] == bob_email

    orgs_resp = test_client.get("/api/human/orgs", headers=auth_headers(bob_token))
    assert orgs_resp.status_code == 200


# ---------------------------------------------------------------------------
# Idempotency: re-running reconcile doesn't duplicate or flap state
# ---------------------------------------------------------------------------


def test_reconcile_is_idempotent_across_logins(test_client):
    """Logging in twice with the same WorkOS state produces a single member
    row per org and a stable role."""
    bob_email = "bob@idem.example.com"
    _, _ = login_human(test_client, bob_email)
    test_client.cookies.clear()
    bob_workos_id = test_client.app.state.workos.users_by_email[bob_email].id

    shared = _create_shared_org(
        test_client, owner_email="owner@idem.example.com", name="idem-team",
    )
    _attach_workos_membership(
        test_client,
        workos_user_id=bob_workos_id,
        workos_org_id=shared["workos_org_id"],
        role="member",
    )

    # Two consecutive logins.
    login_human(test_client, bob_email)
    test_client.cookies.clear()
    bob_token, _ = login_human(test_client, bob_email)

    orgs = test_client.get(
        "/api/human/orgs", headers=auth_headers(bob_token),
    ).json()["organizations"]
    matching = [o for o in orgs if o["org_id"] == shared["org_id"]]
    assert len(matching) == 1
    assert matching[0]["my_role"] == "member"
