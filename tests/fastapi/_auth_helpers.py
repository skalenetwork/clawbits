"""Test login helpers that drive the in-memory WorkOS fake."""
from __future__ import annotations

from starlette.testclient import TestClient

from clawbits.fastapi.session_cookie import SESSION_COOKIE
from tests.fastapi._fakes import DEV_MAGIC_CODE


def login_human(tc: TestClient, email: str = "stan@clawbits.ai") -> tuple[str, dict]:
    """Magic-auth log in. Auto-creates the user on first call.

    Returns ``(sealed_session, user_dict)``. The session cookie is also set
    on ``tc`` automatically — most tests can just keep using ``tc`` and
    rely on the cookie. Tests that need the bearer form (multi-user
    scenarios in a single ``tc``) can use the returned token.
    """
    send_resp = tc.post("/api/auth/magic/send", json={"email": email})
    assert send_resp.status_code == 204, send_resp.text

    verify_resp = tc.post(
        "/api/auth/magic/verify",
        json={"email": email, "code": DEV_MAGIC_CODE},
    )
    assert verify_resp.status_code == 200, verify_resp.text
    user = verify_resp.json()
    # Never hardcode the cookie name: it is env-suffixed (``fc_session_dev`` and
    # friends), and a miss here doesn't fail — it returns "", whose bearer token
    # is ignored, so every later request silently authenticates as whoever the
    # client's cookie jar last held. Assert instead of defaulting.
    sealed = tc.cookies.get(SESSION_COOKIE, "")
    assert sealed, f"login set no {SESSION_COOKIE} cookie"
    return sealed, user


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def personal_org_id(tc: TestClient, token: str) -> str:
    """Return the personal org_id for the human authenticated by ``token``."""
    resp = tc.get("/api/human/orgs", headers=auth_headers(token))
    assert resp.status_code == 200, resp.text
    orgs = resp.json()["organizations"]
    return next(o["org_id"] for o in orgs if o["is_personal"])


def signup_agent_via_email(tc: TestClient, owner_email: str = "stan@clawbits.ai"):
    """Login as ``owner_email`` and POST a signup request scoped to their
    personal org. Returns the raw Response so callers can assert status."""
    token, _ = login_human(tc, owner_email)
    org_id = personal_org_id(tc, token)
    return tc.post("/api/agentic/agents/signup", json={"org_id": org_id})


def register_human(tc: TestClient, email: str, display_name: str | None = None) -> dict:
    """Convenience wrapper for tests that want a registered user.

    Returns ``{"access_token": <sealed>, "user": <dict>}`` — the legacy
    shape that several tests still pass through unchanged.
    """
    token, user = login_human(tc, email)
    if display_name is not None:
        tc.patch(
            "/api/human/me",
            json={"display_name": display_name},
            headers=auth_headers(token),
        )
        user["display_name"] = display_name
    return {"access_token": token, "user": user}


def add_human_to_org(
    tc: TestClient, owner_token: str, org_id: str, email: str, role: str = "member"
) -> None:
    """Put an existing human into ``org_id``. Caller must be an org owner.

    Channel membership is org-scoped (``add_member`` refuses a target who is
    not in the channel's org), and every ``login_human`` gets its *own*
    personal org — so a test that adds user B to user A's channel has to put B
    in A's org first, exactly as the product's invite flow would.
    """
    resp = tc.post(
        f"/api/human/orgs/{org_id}/members",
        json={"email": email, "role": role},
        headers=auth_headers(owner_token),
    )
    assert resp.status_code == 200, resp.text
