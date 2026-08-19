"""Tests for GitHub-style organization endpoints."""
from starlette.testclient import TestClient

from tests.fastapi._auth_helpers import auth_headers as _auth
from tests.fastapi._auth_helpers import login_human

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _register(tc: TestClient, email: str, display_name: str | None = None) -> dict:
    """Magic-auth log-in (auto-creates the user). Returns ``{user, access_token}``."""
    token, user = login_human(tc, email)
    if display_name is not None:
        tc.patch(
            "/api/human/me",
            json={"display_name": display_name},
            headers={"Authorization": f"Bearer {token}"},
        )
        user["display_name"] = display_name
    return {"access_token": token, "user": user}


def _login_admin(tc: TestClient) -> str:
    token, _ = login_human(tc, "stan@clawbits.ai")
    return token


# ---------------------------------------------------------------------------
# Tests: Auto-creation of personal org on registration
# ---------------------------------------------------------------------------

def test_registration_creates_personal_org(test_client):
    """When a user registers, a personal org is automatically created."""
    reg = _register(test_client, "alice@test.com", display_name="Alice")
    token = reg["access_token"]
    user_id = reg["user"]["id"]

    r = test_client.get("/api/human/orgs", headers=_auth(token))
    assert r.status_code == 200
    data = r.json()
    assert data["total"] >= 1
    personal_orgs = [o for o in data["organizations"] if o["is_personal"]]
    assert len(personal_orgs) == 1
    assert personal_orgs[0]["org_id"] == f"user-{user_id}"
    assert personal_orgs[0]["name"] == "alice"


def test_personal_org_name_from_email_prefix(test_client):
    """Personal org name is the lowercase email prefix."""
    reg = _register(test_client, "Bob.Smith@example.com")
    token = reg["access_token"]

    r = test_client.get("/api/human/orgs", headers=_auth(token))
    data = r.json()
    personal = [o for o in data["organizations"] if o["is_personal"]][0]
    assert personal["name"] == "bob.smith"


def test_admin_seed_has_personal_org(test_client):
    """The seeded admin user stan@clawbits.ai should have a personal org."""
    token = _login_admin(test_client)
    r = test_client.get("/api/human/orgs", headers=_auth(token))
    assert r.status_code == 200
    data = r.json()
    personal_orgs = [o for o in data["organizations"] if o["is_personal"]]
    assert len(personal_orgs) == 1
    assert personal_orgs[0]["name"] == "stan"


# ---------------------------------------------------------------------------
# Tests: Create additional organizations
# ---------------------------------------------------------------------------

def test_create_org(test_client):
    """User can create an additional (non-personal) organization."""
    reg = _register(test_client, "creator@test.com")
    token = reg["access_token"]

    r = test_client.post("/api/human/orgs",
        json={"name": "my-team", "display_name": "My Team"},
        headers=_auth(token),
    )
    assert r.status_code == 200
    org = r.json()
    assert org["name"] == "my-team"
    assert org["display_name"] == "My Team"
    assert org["is_personal"] is False
    assert org["created_by"] == reg["user"]["id"]

    # Listing should show both personal + new org
    r = test_client.get("/api/human/orgs", headers=_auth(token))
    assert r.json()["total"] == 2


def test_create_org_duplicate_name_rejected(test_client):
    """Cannot create two orgs with the same name."""
    reg = _register(test_client, "duper@test.com")
    token = reg["access_token"]

    test_client.post("/api/human/orgs", json={"name": "unique-name"}, headers=_auth(token))
    r = test_client.post("/api/human/orgs", json={"name": "unique-name"}, headers=_auth(token))
    assert r.status_code == 409


def test_create_org_name_validation(test_client):
    """Org names must be lowercase alphanumeric + hyphens."""
    reg = _register(test_client, "validator@test.com")
    token = reg["access_token"]

    # Invalid: uppercase
    r = test_client.post("/api/human/orgs", json={"name": "MyTeam"}, headers=_auth(token))
    assert r.status_code == 422

    # Invalid: spaces
    r = test_client.post("/api/human/orgs", json={"name": "my team"}, headers=_auth(token))
    assert r.status_code == 422

    # Valid
    r = test_client.post("/api/human/orgs", json={"name": "my-team-2"}, headers=_auth(token))
    assert r.status_code == 200


# ---------------------------------------------------------------------------
# Tests: Get org details
# ---------------------------------------------------------------------------

def test_get_org_info(test_client):
    """Members can get org info; non-members cannot."""
    h1 = _register(test_client, "org-owner@test.com")
    h2 = _register(test_client, "outsider@test.com")

    r = test_client.post("/api/human/orgs",
        json={"name": "secret-org"},
        headers=_auth(h1["access_token"]),
    )
    org_id = r.json()["org_id"]

    # Owner can see
    r = test_client.get(f"/api/human/orgs/{org_id}", headers=_auth(h1["access_token"]))
    assert r.status_code == 200
    assert r.json()["name"] == "secret-org"

    # Non-member cannot see
    r = test_client.get(f"/api/human/orgs/{org_id}", headers=_auth(h2["access_token"]))
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# Tests: Members
# ---------------------------------------------------------------------------

def test_add_and_list_members(test_client):
    """Owner can add a member and list members."""
    h1 = _register(test_client, "owner1@test.com")
    h2 = _register(test_client, "member1@test.com")

    r = test_client.post("/api/human/orgs",
        json={"name": "team-alpha"},
        headers=_auth(h1["access_token"]),
    )
    org_id = r.json()["org_id"]

    # Add h2
    r = test_client.post(f"/api/human/orgs/{org_id}/members",
        json={"email": "member1@test.com", "role": "member"},
        headers=_auth(h1["access_token"]),
    )
    assert r.status_code == 200
    assert r.json()["total"] == 2

    # h2 can now see the org
    r = test_client.get(f"/api/human/orgs/{org_id}", headers=_auth(h2["access_token"]))
    assert r.status_code == 200

    # List members
    r = test_client.get(f"/api/human/orgs/{org_id}/members", headers=_auth(h1["access_token"]))
    assert r.status_code == 200
    members = r.json()
    assert members["total"] == 2
    roles = {m["email"]: m["role"] for m in members["members"]}
    assert roles["owner1@test.com"] == "owner"
    assert roles["member1@test.com"] == "member"


def test_remove_member(test_client):
    """Owner can remove a member."""
    h1 = _register(test_client, "remover@test.com")
    h2 = _register(test_client, "removee@test.com")

    r = test_client.post("/api/human/orgs",
        json={"name": "temp-org"},
        headers=_auth(h1["access_token"]),
    )
    org_id = r.json()["org_id"]

    # Add h2
    test_client.post(f"/api/human/orgs/{org_id}/members",
        json={"email": "removee@test.com"},
        headers=_auth(h1["access_token"]),
    )

    # Remove h2
    r = test_client.delete(
        f"/api/human/orgs/{org_id}/members/{h2['user']['id']}",
        headers=_auth(h1["access_token"]),
    )
    assert r.status_code == 200
    assert r.json()["total"] == 1

    # h2 can no longer see the org
    r = test_client.get(f"/api/human/orgs/{org_id}", headers=_auth(h2["access_token"]))
    assert r.status_code == 403


def test_non_owner_cannot_add_member(test_client):
    """A regular member cannot add other members."""
    h1 = _register(test_client, "real-owner@test.com")
    h2 = _register(test_client, "just-member@test.com")
    h3 = _register(test_client, "wannabe@test.com")

    r = test_client.post("/api/human/orgs",
        json={"name": "strict-org"},
        headers=_auth(h1["access_token"]),
    )
    org_id = r.json()["org_id"]

    # Add h2 as member (not owner)
    test_client.post(f"/api/human/orgs/{org_id}/members",
        json={"email": "just-member@test.com", "role": "member"},
        headers=_auth(h1["access_token"]),
    )

    # h2 tries to add h3 → 403
    r = test_client.post(f"/api/human/orgs/{org_id}/members",
        json={"email": "wannabe@test.com"},
        headers=_auth(h2["access_token"]),
    )
    assert r.status_code == 403


def test_non_owner_can_list_members(test_client):
    """Any org member can list members — the endpoint powers the directory
    pickers (add-to-channel, new DM, new channel) used by regular members.
    Admin actions on members remain owner-only on their own endpoints."""
    owner = _register(test_client, "list-owner@test.com")
    member = _register(test_client, "list-member@test.com")
    outsider = _register(test_client, "outsider@test.com")

    r = test_client.post("/api/human/orgs",
        json={"name": "directory-org"},
        headers=_auth(owner["access_token"]),
    )
    org_id = r.json()["org_id"]

    test_client.post(f"/api/human/orgs/{org_id}/members",
        json={"email": "list-member@test.com", "role": "member"},
        headers=_auth(owner["access_token"]),
    )

    # Regular member can list
    r = test_client.get(f"/api/human/orgs/{org_id}/members",
        headers=_auth(member["access_token"]),
    )
    assert r.status_code == 200
    assert r.json()["total"] == 2

    # Non-member still gets 403
    r = test_client.get(f"/api/human/orgs/{org_id}/members",
        headers=_auth(outsider["access_token"]),
    )
    assert r.status_code == 403


def test_cannot_remove_last_owner(test_client):
    """Cannot remove the last owner of an organization."""
    h1 = _register(test_client, "solo-owner@test.com")

    r = test_client.post("/api/human/orgs",
        json={"name": "solo-org"},
        headers=_auth(h1["access_token"]),
    )
    org_id = r.json()["org_id"]

    # Try to remove self (the only owner)
    r = test_client.delete(
        f"/api/human/orgs/{org_id}/members/{h1['user']['id']}",
        headers=_auth(h1["access_token"]),
    )
    assert r.status_code == 400
    assert "last admin" in r.json()["detail"].lower()


def test_owner_can_promote_and_demote(test_client):
    """Owner promotes a member to owner, then the new owner demotes them back."""
    h1 = _register(test_client, "promoter@test.com")
    h2 = _register(test_client, "promotee@test.com")

    r = test_client.post("/api/human/orgs",
        json={"name": "role-org"},
        headers=_auth(h1["access_token"]),
    )
    org_id = r.json()["org_id"]

    test_client.post(f"/api/human/orgs/{org_id}/members",
        json={"email": "promotee@test.com", "role": "member"},
        headers=_auth(h1["access_token"]),
    )

    # Promote h2 → owner
    r = test_client.patch(
        f"/api/human/orgs/{org_id}/members/{h2['user']['id']}",
        json={"role": "owner"},
        headers=_auth(h1["access_token"]),
    )
    assert r.status_code == 200
    roles = {m["email"]: m["role"] for m in r.json()["members"]}
    assert roles["promotee@test.com"] == "owner"

    # h2's own view of the org now reports the new role
    r = test_client.get("/api/human/orgs", headers=_auth(h2["access_token"]))
    org = next(o for o in r.json()["organizations"] if o["org_id"] == org_id)
    assert org["my_role"] == "owner"

    # h2 (now an owner) demotes h1 back to member
    r = test_client.patch(
        f"/api/human/orgs/{org_id}/members/{h1['user']['id']}",
        json={"role": "member"},
        headers=_auth(h2["access_token"]),
    )
    assert r.status_code == 200
    roles = {m["email"]: m["role"] for m in r.json()["members"]}
    assert roles["promoter@test.com"] == "member"

    # ...and h1 has lost the owner-only power
    r = test_client.patch(
        f"/api/human/orgs/{org_id}/members/{h2['user']['id']}",
        json={"role": "member"},
        headers=_auth(h1["access_token"]),
    )
    assert r.status_code == 403


def test_non_owner_cannot_change_roles(test_client):
    """A regular member cannot promote themselves (or anyone else)."""
    owner = _register(test_client, "role-owner@test.com")
    member = _register(test_client, "role-member@test.com")

    r = test_client.post("/api/human/orgs",
        json={"name": "no-selfserve-org"},
        headers=_auth(owner["access_token"]),
    )
    org_id = r.json()["org_id"]

    test_client.post(f"/api/human/orgs/{org_id}/members",
        json={"email": "role-member@test.com", "role": "member"},
        headers=_auth(owner["access_token"]),
    )

    r = test_client.patch(
        f"/api/human/orgs/{org_id}/members/{member['user']['id']}",
        json={"role": "owner"},
        headers=_auth(member["access_token"]),
    )
    assert r.status_code == 403


def test_cannot_demote_last_owner(test_client):
    """The last owner can't demote themselves — that would strand the org."""
    h1 = _register(test_client, "lonely-owner@test.com")
    h2 = _register(test_client, "plain-member@test.com")

    r = test_client.post("/api/human/orgs",
        json={"name": "stranded-org"},
        headers=_auth(h1["access_token"]),
    )
    org_id = r.json()["org_id"]

    test_client.post(f"/api/human/orgs/{org_id}/members",
        json={"email": "plain-member@test.com", "role": "member"},
        headers=_auth(h1["access_token"]),
    )

    r = test_client.patch(
        f"/api/human/orgs/{org_id}/members/{h1['user']['id']}",
        json={"role": "member"},
        headers=_auth(h1["access_token"]),
    )
    assert r.status_code == 400
    assert "last admin" in r.json()["detail"].lower()


def test_role_change_rejects_unknown_member_and_bad_role(test_client):
    """404 for someone who isn't in the org; 422 for a role outside the enum."""
    owner = _register(test_client, "picky-owner@test.com")
    outsider = _register(test_client, "not-in-org@test.com")

    r = test_client.post("/api/human/orgs",
        json={"name": "picky-org"},
        headers=_auth(owner["access_token"]),
    )
    org_id = r.json()["org_id"]

    r = test_client.patch(
        f"/api/human/orgs/{org_id}/members/{outsider['user']['id']}",
        json={"role": "owner"},
        headers=_auth(owner["access_token"]),
    )
    assert r.status_code == 404

    r = test_client.patch(
        f"/api/human/orgs/{org_id}/members/{owner['user']['id']}",
        json={"role": "superuser"},
        headers=_auth(owner["access_token"]),
    )
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# Tests: Auth required
# ---------------------------------------------------------------------------

def test_orgs_require_auth(test_client):
    """Unauthenticated requests are rejected."""
    r = test_client.get("/api/human/orgs")
    assert r.status_code in (401, 403)

    r = test_client.get("/api/human/orgs", headers={"Authorization": "Bearer invalid"})
    assert r.status_code == 401


# ---------------------------------------------------------------------------
# Tests: Reef connection (store only the URL; owner-gated writes)
# ---------------------------------------------------------------------------

def test_reef_connection_lifecycle(test_client):
    """Owner sets the URL (normalized), members read it, owner clears it."""
    owner = _register(test_client, "reef-owner@test.com")
    member = _register(test_client, "reef-member@test.com")
    outsider = _register(test_client, "reef-outsider@test.com")

    org_id = test_client.post(
        "/api/human/orgs", json={"name": "reef-org"}, headers=_auth(owner["access_token"])
    ).json()["org_id"]
    test_client.post(
        f"/api/human/orgs/{org_id}/members",
        json={"email": "reef-member@test.com", "role": "member"},
        headers=_auth(owner["access_token"]),
    )

    # Initially unset.
    r = test_client.get(
        f"/api/human/orgs/{org_id}/reef-connection", headers=_auth(owner["access_token"])
    )
    assert r.status_code == 200
    assert r.json()["api_url"] is None

    # Owner sets it; the trailing slash is normalized away.
    r = test_client.put(
        f"/api/human/orgs/{org_id}/reef-connection",
        json={"api_url": "https://reef.example.com/"},
        headers=_auth(owner["access_token"]),
    )
    assert r.status_code == 200
    assert r.json()["api_url"] == "https://reef.example.com"

    # A member can read it.
    r = test_client.get(
        f"/api/human/orgs/{org_id}/reef-connection", headers=_auth(member["access_token"])
    )
    assert r.json()["api_url"] == "https://reef.example.com"

    # A non-member cannot.
    r = test_client.get(
        f"/api/human/orgs/{org_id}/reef-connection", headers=_auth(outsider["access_token"])
    )
    assert r.status_code == 403

    # Owner clears it.
    r = test_client.delete(
        f"/api/human/orgs/{org_id}/reef-connection", headers=_auth(owner["access_token"])
    )
    assert r.status_code == 204
    r = test_client.get(
        f"/api/human/orgs/{org_id}/reef-connection", headers=_auth(owner["access_token"])
    )
    assert r.json()["api_url"] is None


def test_reef_connection_member_cannot_write(test_client):
    """A non-owner member cannot set or clear the Reef connection."""
    owner = _register(test_client, "reef-owner2@test.com")
    member = _register(test_client, "reef-member2@test.com")
    org_id = test_client.post(
        "/api/human/orgs", json={"name": "reef-org2"}, headers=_auth(owner["access_token"])
    ).json()["org_id"]
    test_client.post(
        f"/api/human/orgs/{org_id}/members",
        json={"email": "reef-member2@test.com", "role": "member"},
        headers=_auth(owner["access_token"]),
    )

    r = test_client.put(
        f"/api/human/orgs/{org_id}/reef-connection",
        json={"api_url": "https://evil.example.com"},
        headers=_auth(member["access_token"]),
    )
    assert r.status_code == 403

    r = test_client.delete(
        f"/api/human/orgs/{org_id}/reef-connection", headers=_auth(member["access_token"])
    )
    assert r.status_code == 403


def test_reef_connection_rejects_bad_scheme(test_client):
    """A non-http(s) URL is rejected at validation."""
    owner = _register(test_client, "reef-owner3@test.com")
    org_id = test_client.post(
        "/api/human/orgs", json={"name": "reef-org3"}, headers=_auth(owner["access_token"])
    ).json()["org_id"]
    r = test_client.put(
        f"/api/human/orgs/{org_id}/reef-connection",
        json={"api_url": "ftp://reef.example.com"},
        headers=_auth(owner["access_token"]),
    )
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# Tests: LobsterTalk attention gate (org-level opt-in; owner-toggled)
# ---------------------------------------------------------------------------

def test_org_attention_lifecycle(test_client):
    """Off by default; owner arms it; a member can read; a non-member cannot."""
    owner = _register(test_client, "attn-owner@test.com")
    member = _register(test_client, "attn-member@test.com")
    outsider = _register(test_client, "attn-outsider@test.com")

    org_id = test_client.post(
        "/api/human/orgs", json={"name": "attn-org"}, headers=_auth(owner["access_token"])
    ).json()["org_id"]
    test_client.post(
        f"/api/human/orgs/{org_id}/members",
        json={"email": "attn-member@test.com", "role": "member"},
        headers=_auth(owner["access_token"]),
    )

    # Off by default.
    r = test_client.get(
        f"/api/human/orgs/{org_id}/attention", headers=_auth(owner["access_token"])
    )
    assert r.status_code == 200 and r.json()["enabled"] is False

    # Owner arms it.
    r = test_client.put(
        f"/api/human/orgs/{org_id}/attention",
        json={"enabled": True},
        headers=_auth(owner["access_token"]),
    )
    assert r.status_code == 200 and r.json()["enabled"] is True

    # Reflected in the org listing (so the UI can render current state).
    orgs = test_client.get("/api/human/orgs", headers=_auth(owner["access_token"])).json()
    this_org = next(o for o in orgs["organizations"] if o["org_id"] == org_id)
    assert this_org["attention_enabled"] is True

    # A member can read it.
    r = test_client.get(
        f"/api/human/orgs/{org_id}/attention", headers=_auth(member["access_token"])
    )
    assert r.json()["enabled"] is True

    # A non-member cannot read it.
    r = test_client.get(
        f"/api/human/orgs/{org_id}/attention", headers=_auth(outsider["access_token"])
    )
    assert r.status_code == 403

    # Owner disarms it.
    r = test_client.put(
        f"/api/human/orgs/{org_id}/attention",
        json={"enabled": False},
        headers=_auth(owner["access_token"]),
    )
    assert r.status_code == 200 and r.json()["enabled"] is False


def test_org_attention_member_cannot_write(test_client):
    """A non-owner member cannot toggle the org's attention gate."""
    owner = _register(test_client, "attn-owner2@test.com")
    member = _register(test_client, "attn-member2@test.com")
    org_id = test_client.post(
        "/api/human/orgs", json={"name": "attn-org2"}, headers=_auth(owner["access_token"])
    ).json()["org_id"]
    test_client.post(
        f"/api/human/orgs/{org_id}/members",
        json={"email": "attn-member2@test.com", "role": "member"},
        headers=_auth(owner["access_token"]),
    )

    r = test_client.put(
        f"/api/human/orgs/{org_id}/attention",
        json={"enabled": True},
        headers=_auth(member["access_token"]),
    )
    assert r.status_code == 403



# ---------------------------------------------------------------------------
# Tests: self-service account deletion (DELETE /api/human/account)
# ---------------------------------------------------------------------------

def test_delete_account_happy_path(test_client):
    """A user with only their (solo) personal org can delete their account;
    the user row and the personal org are both removed locally, and the
    WorkOS-side user + personal org are deleted too."""
    from sqlmodel import Session

    from clawbits.db.models import HumanUser, Organization

    reg = _register(test_client, "deleteme@test.com")
    uid = reg["user"]["id"]
    personal_org_id = f"user-{uid}"

    client = test_client.app.state.workos
    workos_user_id = client.users_by_email["deleteme@test.com"].id
    with Session(test_client.app._engine) as db:
        workos_org_id = db.get(Organization, personal_org_id).workos_org_id

    r = test_client.delete("/api/human/account", headers=_auth(reg["access_token"]))
    assert r.status_code == 204, r.text

    with Session(test_client.app._engine) as db:
        assert db.get(HumanUser, uid) is None
        assert db.get(Organization, personal_org_id) is None

    # WorkOS-side cleanup: the user and their solo personal org are gone.
    assert workos_user_id in client.deleted_user_ids
    assert "deleteme@test.com" not in client.users_by_email
    assert workos_org_id in client.deleted_org_ids
    assert workos_org_id not in client.orgs


def test_delete_account_blocked_while_operating_agent(test_client):
    """Deletion is refused (409) while the user still operates an agent."""
    import pytest
    from sqlmodel import Session

    from clawbits.db.models import Agent, HumanUser
    from clawbits.db.table_write import TableWrite, UserDeletionBlocked

    reg = _register(test_client, "agentop@test.com")
    uid = reg["user"]["id"]

    with Session(test_client.app._engine) as db:
        db.add(Agent(
            agent_id="op_agent", api_key_hash="op_h", eth_private_key="op_k",
            nickname="Op", operator_id=uid, require_response_approval=True,
        ))
        db.commit()

    # Endpoint surfaces it as a 409.
    r = test_client.delete("/api/human/account", headers=_auth(reg["access_token"]))
    assert r.status_code == 409, r.text
    assert "operate" in r.json()["detail"].lower()

    # And the function raises the typed error directly.
    with Session(test_client.app._engine) as db:
        with pytest.raises(UserDeletionBlocked):
            TableWrite.delete_human_user(db, uid)
        assert db.get(HumanUser, uid) is not None


def test_delete_account_blocked_as_sole_owner_with_members(test_client):
    """Deletion is refused while the user is the only owner of an org that
    still has other members."""
    from datetime import UTC, datetime

    import pytest
    from sqlmodel import Session

    from clawbits.db.models import HumanUser, Organization, OrgMember
    from clawbits.db.table_write import TableWrite, UserDeletionBlocked

    owner = _register(test_client, "soleowner@test.com")
    other = _register(test_client, "tagalong@test.com")
    now = datetime.now(UTC)

    with Session(test_client.app._engine) as db:
        db.add(Organization(
            org_id="shared_org", workos_org_id="wos_shared", name="shared-org",
            created_by=owner["user"]["id"], created_at=now,
        ))
        db.flush()
        db.add(OrgMember(org_id="shared_org", human_id=owner["user"]["id"], role="owner"))
        db.add(OrgMember(org_id="shared_org", human_id=other["user"]["id"], role="member"))
        db.commit()

        with pytest.raises(UserDeletionBlocked):
            TableWrite.delete_human_user(db, owner["user"]["id"])
        db.rollback()
        assert db.get(HumanUser, owner["user"]["id"]) is not None


def test_delete_human_user_wipes_content_and_cleans_channels(test_client):
    """End-to-end of the deletion cascade: the user's posts/reactions are
    removed, a shared channel survives with its preview rebuilt from a
    remaining member, and a channel left with no humans is torn down."""
    from datetime import UTC, datetime

    from sqlmodel import Session, select

    from clawbits.db.models import (
        HumanUser,
        MmChannel,
        MmChannelMember,
        MmPost,
        MmPostReaction,
        Organization,
        OrgMember,
    )
    from clawbits.db.table_write import TableWrite

    u = _register(test_client, "wipeme@test.com")
    v = _register(test_client, "survivor@test.com")
    uid = u["user"]["id"]
    vid = v["user"]["id"]
    now = datetime.now(UTC)

    with Session(test_client.app._engine) as db:
        # An org both share (so neither is sole owner -> not blocked).
        db.add(Organization(
            org_id="wipe_org", workos_org_id="wos_wipe", name="wipe-org",
            created_by=uid, created_at=now,
        ))
        db.flush()
        db.add(OrgMember(org_id="wipe_org", human_id=uid, role="owner"))
        db.add(OrgMember(org_id="wipe_org", human_id=vid, role="owner"))

        # Shared channel with both humans; u authors the last message.
        db.add(MmChannel(channel_id="shared_ch", name="shared", channel_type="public",
                         org_id="wipe_org", created_at=now,
                         last_message_text="u was here",
                         last_message_author_human_id=uid,
                         last_message_author_display_name="U"))
        db.add(MmChannelMember(channel_id="shared_ch", human_id=uid, joined_at=now))
        db.add(MmChannelMember(channel_id="shared_ch", human_id=vid, joined_at=now))
        db.add(MmPost(channel_id="shared_ch", human_id=vid, message="v earlier",
                      status="published", created_at=now))
        u_post = MmPost(channel_id="shared_ch", human_id=uid, message="u was here",
                        status="published", created_at=now)
        db.add(u_post)
        db.flush()
        db.add(MmPostReaction(post_id=u_post.post_id, emoji="A", human_id=uid))

        # Channel where u is the only human -> torn down on deletion.
        db.add(MmChannel(channel_id="solo_ch", name="solo", channel_type="public",
                         org_id="wipe_org", created_at=now))
        db.add(MmChannelMember(channel_id="solo_ch", human_id=uid, joined_at=now))
        db.commit()

        personal_workos = db.get(Organization, f"user-{uid}").workos_org_id
        deleted_workos_org_ids = TableWrite.delete_human_user(db, uid)
        db.commit()

    # Only the solo personal org is reported for WorkOS-side deletion; the
    # shared "wipe_org" (still owned by v) is kept and must not be torn down.
    assert personal_workos in deleted_workos_org_ids
    assert "wos_wipe" not in deleted_workos_org_ids

    with Session(test_client.app._engine) as db:
        assert db.get(Organization, "wipe_org") is not None

    with Session(test_client.app._engine) as db:
        # User and all their content gone.
        assert db.get(HumanUser, uid) is None
        assert db.exec(select(MmPost).where(MmPost.human_id == uid)).all() == []
        assert db.exec(select(MmPostReaction).where(MmPostReaction.human_id == uid)).all() == []

        # Solo channel torn down; shared channel survives with v still in it.
        assert db.get(MmChannel, "solo_ch") is None
        shared = db.get(MmChannel, "shared_ch")
        assert shared is not None
        # Preview rebuilt from v's surviving post, not u's deleted one.
        assert shared.last_message_author_human_id == vid
        assert shared.last_message_text == "v earlier"

        # Org survives (v is still an owner); created_by re-pointed off u.
        org = db.get(Organization, "wipe_org")
        assert org is not None
        assert org.created_by == vid


def _create_skill(tc: TestClient, token: str, org_id: str, slug: str) -> dict:
    r = tc.post(
        f"/api/human/orgs/{org_id}/skills",
        json={
            "slug": slug,
            "display_name": slug,
            "manifest": {"name": slug, "description": "A skill the account owns."},
            "body_md": f"# {slug}\n\nDo the thing.\n",
        },
        headers=_auth(token),
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_delete_account_with_org_skills(test_client):
    """A user who authored skills can still delete their account.

    ``skills.created_by`` / ``skill_versions.published_by`` FK ``human_users``
    with no cascade, and ``skills.org_id`` FKs the personal org that gets torn
    down with the account — so the library has to be cleared or the delete
    500s (the same regression class as the agent-delete skills bug).
    """
    from sqlmodel import Session, select

    from clawbits.db.models import HumanUser, Organization, Skill, SkillVersion

    reg = _register(test_client, "skill-author@test.com")
    uid = reg["user"]["id"]
    org_id = f"user-{uid}"

    skill = _create_skill(test_client, reg["access_token"], org_id, "owned-skill")
    # A second version, so the skill has more than the auto-published v1.
    r = test_client.post(
        f"/api/human/orgs/{org_id}/skills/{skill['skill_id']}/versions",
        json={
            "manifest": {"name": "owned-skill", "description": "Now sharper."},
            "body_md": "# v2\n\nSharper.\n",
        },
        headers=_auth(reg["access_token"]),
    )
    assert r.status_code == 200, r.text

    r = test_client.delete("/api/human/account", headers=_auth(reg["access_token"]))
    assert r.status_code == 204, r.text

    with Session(test_client.app._engine) as db:
        assert db.get(HumanUser, uid) is None
        assert db.get(Organization, org_id) is None
        assert db.exec(select(Skill).where(Skill.org_id == org_id)).all() == []
        assert db.exec(
            select(SkillVersion).where(SkillVersion.skill_id == skill["skill_id"])
        ).all() == []


def test_delete_account_keeps_skills_in_surviving_org(test_client):
    """A skill the user authored in an org that outlives them survives with
    its attribution cleared, rather than being deleted with the account."""
    from datetime import UTC, datetime

    from sqlmodel import Session

    from clawbits.db.models import HumanUser, Organization, OrgMember, Skill

    owner = _register(test_client, "lib-owner@test.com")
    author = _register(test_client, "lib-author@test.com")
    now = datetime.now(UTC)
    with Session(test_client.app._engine) as db:
        db.add(Organization(
            org_id="lib_org", workos_org_id="wos_lib", name="lib-org",
            created_by=owner["user"]["id"], created_at=now,
        ))
        db.flush()
        db.add(OrgMember(org_id="lib_org", human_id=owner["user"]["id"], role="owner"))
        db.add(OrgMember(org_id="lib_org", human_id=author["user"]["id"], role="member"))
        db.commit()

    skill = _create_skill(test_client, author["access_token"], "lib_org", "shared-skill")

    r = test_client.delete("/api/human/account", headers=_auth(author["access_token"]))
    assert r.status_code == 204, r.text

    with Session(test_client.app._engine) as db:
        assert db.get(HumanUser, author["user"]["id"]) is None
        row = db.get(Skill, skill["skill_id"])
        assert row is not None
        assert row.created_by is None


def test_delete_account_with_skill_installs_and_automations(test_client):
    """Rows that merely *name* the user — an install they triggered on someone
    else's agent, an automation they created — keep the agent's control-plane
    state intact and lose only the attribution."""
    from sqlmodel import Session

    from clawbits.db.models import (
        Agent,
        AgentSkillInstall,
        Automation,
        HumanUser,
    )

    operator = _register(test_client, "auto-operator@test.com")
    actor = _register(test_client, "auto-actor@test.com")
    actor_id = actor["user"]["id"]

    with Session(test_client.app._engine) as db:
        db.add(Agent(
            agent_id="shared_agent", api_key_hash="sa_h", eth_private_key="sa_k",
            nickname="Shared", operator_id=operator["user"]["id"],
            require_response_approval=True,
        ))
        db.flush()
        db.add(AgentSkillInstall(
            install_id="inst_1", agent_id="shared_agent", slug="triage",
            installed_by=actor_id,
        ))
        db.add(Automation(
            automation_id="auto_1", agent_id="shared_agent",
            desired_spec={"schedule": "0 9 * * *"}, created_by=actor_id,
        ))
        db.commit()

    r = test_client.delete("/api/human/account", headers=_auth(actor["access_token"]))
    assert r.status_code == 204, r.text

    with Session(test_client.app._engine) as db:
        assert db.get(HumanUser, actor_id) is None
        install = db.get(AgentSkillInstall, "inst_1")
        assert install is not None and install.installed_by is None
        automation = db.get(Automation, "auto_1")
        assert automation is not None and automation.created_by is None
