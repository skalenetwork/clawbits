"""Regression tests for the duplicate-personal-org / OrganizationSelectionRequired bug.

Background: when a user logs in via WorkOS but the local DB has no row for
them, ``_provision_new_user`` creates a personal org. Pre-fix, this happened
unconditionally — so any DB wipe on staging stranded the user with multiple
duplicate personal orgs in WorkOS, and the next login failed with
``OrganizationSelectionRequiredError`` because WorkOS refused to pick one.

These tests cover both halves of the fix:

1. **Adoption** — when WorkOS already has memberships for the user,
   ``_provision_new_user`` reuses the most recent org instead of creating
   another.
2. **Resolution** — if a multi-org user does hit the legacy path (or any
   genuine multi-tenant case), the callback handlers catch
   ``OrganizationSelectionRequiredError`` and finish the flow via
   ``authenticate_with_organization_selection`` instead of 500'ing.
"""
from __future__ import annotations

import secrets
from urllib.parse import parse_qs, urlparse

from sqlmodel import Session

from clawbits.db.models import HumanUser, Organization
from tests.fastapi._fakes import DEV_MAGIC_CODE, _FakeMembership, _FakeOrg


def _attach_org_to_workos_user(test_client, *, email: str, name: str) -> str:
    """Pre-populate a WorkOS-side org + membership for ``email``.

    Mirrors the state staging ended up in after the DB wipes: WorkOS
    knows about the user and orgs, the local DB doesn't.
    """
    adapter = test_client.app.state.workos
    user = adapter.users_by_email.get(email) or adapter._make_user(email)
    org_id = f"org_{secrets.token_hex(8)}"
    adapter.orgs[org_id] = _FakeOrg(id=org_id, name=name)
    adapter.memberships.append(
        _FakeMembership(
            id=f"om_{secrets.token_hex(8)}",
            user_id=user.id,
            organization_id=org_id,
            role="admin",
        )
    )
    return org_id


# ---------------------------------------------------------------------------
# (1) Adoption: existing WorkOS membership is reused, not duplicated.
# ---------------------------------------------------------------------------


def test_provision_adopts_existing_workos_org(test_client):
    """First-time login for a user whose WorkOS account already has an
    org membership reuses that org instead of minting a new one."""
    email = "returning@test.com"
    adapter = test_client.app.state.workos

    # Pre-existing WorkOS state: user belongs to an org we created earlier.
    pre_org_id = _attach_org_to_workos_user(
        test_client, email=email, name="returning-existing"
    )
    orgs_before = len(adapter.orgs)

    # Drive a fresh social-callback login.
    start = test_client.get("/api/auth/social/google/start", follow_redirects=False)
    state = parse_qs(urlparse(start.headers["location"]).query)["state"][0]
    code = adapter.inject_social_code(email=email)

    cb = test_client.get(
        "/api/auth/social/callback",
        params={"code": code, "state": state},
        follow_redirects=False,
    )
    assert cb.status_code == 302, cb.text
    assert "/home" in cb.headers["location"]

    # No new WorkOS org was minted.
    assert len(adapter.orgs) == orgs_before, "should not have created a duplicate org"

    # Local row points at the adopted WorkOS org.
    with Session(test_client.app._engine) as db:
        from sqlmodel import select

        local_user = db.exec(
            select(HumanUser).where(HumanUser.email == email)
        ).one()
        local_org = db.exec(
            select(Organization).where(Organization.created_by == local_user.id)
        ).one()
        assert local_org.workos_org_id == pre_org_id


# ---------------------------------------------------------------------------
# (2) Resolution: multi-org user no longer 500's.
# ---------------------------------------------------------------------------


def test_social_callback_resolves_org_selection_required(test_client):
    """A user with 2+ WorkOS memberships triggers OrganizationSelectionRequiredError;
    the callback resolves it via authenticate_with_organization_selection."""
    email = "multi-org@test.com"
    adapter = test_client.app.state.workos

    # Stage two memberships → next authenticate_with_code will raise.
    org_a = _attach_org_to_workos_user(test_client, email=email, name="multi-a")
    org_b = _attach_org_to_workos_user(test_client, email=email, name="multi-b")
    assert org_a != org_b

    start = test_client.get("/api/auth/social/google/start", follow_redirects=False)
    state = parse_qs(urlparse(start.headers["location"]).query)["state"][0]
    code = adapter.inject_social_code(email=email)

    cb = test_client.get(
        "/api/auth/social/callback",
        params={"code": code, "state": state},
        follow_redirects=False,
    )
    assert cb.status_code == 302, cb.text
    assert "/home" in cb.headers["location"]
    # The fake records each successful org-selection resolution; we
    # expect exactly one for this email.
    resolved_emails = [e for e, _ in adapter.org_selection_resolved]
    assert resolved_emails.count(email) == 1


def test_magic_verify_resolves_org_selection_required(test_client):
    """Same as above but for the magic-auth path."""
    email = "magic-multi@test.com"
    adapter = test_client.app.state.workos

    _attach_org_to_workos_user(test_client, email=email, name="magic-a")
    _attach_org_to_workos_user(test_client, email=email, name="magic-b")

    test_client.post("/api/auth/magic/send", json={"email": email})
    resp = test_client.post(
        "/api/auth/magic/verify",
        json={"email": email, "code": DEV_MAGIC_CODE},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["email"] == email
    assert any(e == email for e, _ in adapter.org_selection_resolved)
