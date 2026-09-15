"""Test the magic-auth login flow used by the web UI."""
from tests.fastapi._auth_helpers import login_human


def test_magic_auth_login(test_client):
    """Magic auth round-trip: send → verify → get back a session + user."""
    token, user = login_human(test_client, "stan@clawbits.ai")
    assert token
    assert user["email"] == "stan@clawbits.ai"


def test_me_returns_authenticated_user(test_client):
    """``GET /api/auth/me`` reflects the user we authenticated as."""
    token, _ = login_human(test_client, "stan@clawbits.ai")
    resp = test_client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    assert resp.json()["email"] == "stan@clawbits.ai"


def test_profile_update_returns_full_me(test_client):
    """``PATCH /api/human/me`` answers with the ``GET /api/auth/me`` shape, so the
    client can swap its user in place without dropping account meta."""
    token, _ = login_human(test_client, "stan@clawbits.ai")
    headers = {"Authorization": f"Bearer {token}"}
    patched = test_client.patch("/api/human/me", json={"display_name": "Stan"}, headers=headers)
    assert patched.status_code == 200
    me = test_client.get("/api/auth/me", headers=headers).json()
    assert patched.json().keys() == me.keys()
    assert patched.json()["display_name"] == "Stan"
    assert patched.json()["created_at"]
