"""Smoke test for the WorkOS-managed social-OAuth flow.

The in-memory adapter exposes :meth:`inject_social_code` so we can simulate
a Google / GitHub callback without making any HTTP calls.
"""
from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import pytest

from clawbits.fastapi.workos_auth import safe_return_path


def test_social_start_redirects_to_workos(test_client):
    """``GET /api/auth/social/google/start`` 302's to the adapter's auth URL
    and stores a state cookie for CSRF defense on callback."""
    resp = test_client.get("/api/auth/social/google/start", follow_redirects=False)
    assert resp.status_code == 302
    assert "workos" in resp.headers["location"]
    assert "fc_oauth_state=" in resp.headers.get("set-cookie", "")


def test_social_callback_creates_session(test_client):
    """A valid state + code pair from the adapter logs the user in and sets
    the session cookie."""
    # Step 1: drive the start endpoint to capture the state cookie.
    start = test_client.get("/api/auth/social/google/start", follow_redirects=False)
    state = parse_qs(urlparse(start.headers["location"]).query)["state"][0]

    # Step 2: ask the in-memory adapter for a code resolving to a fixed email.
    adapter = test_client.app.state.workos
    code = adapter.inject_social_code(email="googler@test.com")

    cb = test_client.get(
        "/api/auth/social/callback",
        params={"code": code, "state": state},
        follow_redirects=False,
    )
    assert cb.status_code == 302
    assert "/home" in cb.headers["location"]
    # Cookie should be set on the redirect response.
    assert "fc_session=" in cb.headers.get("set-cookie", "")


def test_social_callback_state_mismatch_rejects(test_client):
    """A bogus state value is treated as CSRF and redirected to /login?error=..."""
    test_client.get("/api/auth/social/google/start", follow_redirects=False)
    cb = test_client.get(
        "/api/auth/social/callback",
        params={"code": "anything", "state": "wrong"},
        follow_redirects=False,
    )
    assert cb.status_code == 302
    assert "error=" in cb.headers["location"]


def test_social_start_bridge_deeplink_marks_state_as_mobile(test_client):
    """``?bridge=deeplink`` prefixes the state with ``mobile.`` so the
    callback knows to emit the fixed ``clawbits://`` deep link instead
    of either a web 302 or the env-suffixed desktop scheme."""
    resp = test_client.get(
        "/api/auth/social/google/start",
        params={"bridge": "deeplink"},
        follow_redirects=False,
    )
    assert resp.status_code == 302
    state = parse_qs(urlparse(resp.headers["location"]).query)["state"][0]
    assert state.startswith("mobile."), state


def test_social_callback_mobile_bridge_emits_clawbits_deeplink(test_client):
    """A callback whose state was minted with ``?bridge=deeplink`` returns
    an HTML bridge page that fires ``clawbits://oauth-callback?token=…``
    regardless of ``CLAWBITS_ENV``."""
    start = test_client.get(
        "/api/auth/social/google/start",
        params={"bridge": "deeplink"},
        follow_redirects=False,
    )
    state = parse_qs(urlparse(start.headers["location"]).query)["state"][0]
    adapter = test_client.app.state.workos
    code = adapter.inject_social_code(email="mobile@test.com")

    cb = test_client.get(
        "/api/auth/social/callback",
        params={"code": code, "state": state},
        follow_redirects=False,
    )
    assert cb.status_code == 200
    assert "text/html" in cb.headers["content-type"]
    body = cb.text
    assert "clawbits://oauth-callback?token=" in body
    # Mobile path uses the bare scheme, never the env-suffixed one.
    assert "clawbits-dev://" not in body
    assert "clawbits-staging://" not in body


# --------------------------------------------------------------------------
# Email verification gate (WorkOS raises EmailVerificationRequiredError when
# linking a new IdP to an email it doesn't yet trust).
# --------------------------------------------------------------------------


def _drive_callback_into_verify_email(test_client, *, email: str, code: str = "654321"):
    """Walk a social sign-in up to the point where WorkOS demands email
    verification. Returns the callback response so callers can inspect the
    redirect + pending-auth cookie.
    """
    adapter = test_client.app.state.workos
    adapter.require_email_verification(email=email, code=code)

    start = test_client.get("/api/auth/social/google/start", follow_redirects=False)
    state = parse_qs(urlparse(start.headers["location"]).query)["state"][0]
    auth_code = adapter.inject_social_code(email=email)

    return test_client.get(
        "/api/auth/social/callback",
        params={"code": auth_code, "state": state},
        follow_redirects=False,
    )


def test_social_callback_email_verification_redirects(test_client):
    """When WorkOS gates an email behind verification, the callback bounces
    the browser to ``/verify-email`` and stashes the pending-auth token in
    an httpOnly cookie. The session cookie is *not* set yet."""
    cb = _drive_callback_into_verify_email(test_client, email="newgh@test.com")
    assert cb.status_code == 302

    location = cb.headers["location"]
    assert "/verify-email" in location
    assert "email=newgh%40test.com" in location

    set_cookie = cb.headers.get("set-cookie", "")
    # Pending-auth token cookie set, real session cookie absent.
    assert "fc_oauth_pending=" in set_cookie
    assert "fc_session=" not in set_cookie


def test_social_verify_email_completes_login(test_client):
    """Submitting the right 6-digit code finishes the flow: session cookie
    is installed, the pending-auth cookie is cleared, and ``MeResponse`` is
    returned."""
    cb = _drive_callback_into_verify_email(
        test_client, email="newgh@test.com", code="654321",
    )
    assert cb.status_code == 302

    # The TestClient's cookie jar already carries the pending cookie that
    # ``_drive_callback_into_verify_email`` set; just POST the code.
    resp = test_client.post(
        "/api/auth/social/verify-email",
        json={"code": "654321"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["email"] == "newgh@test.com"
    assert body["id"]

    set_cookie = resp.headers.get("set-cookie", "")
    assert "fc_session=" in set_cookie
    # Pending-auth cookie cleared.
    assert "fc_oauth_pending=" in set_cookie  # delete_cookie still emits the header
    assert "Max-Age=0" in set_cookie or 'fc_oauth_pending=""' in set_cookie or "fc_oauth_pending=;" in set_cookie


def test_social_verify_email_rejects_wrong_code(test_client):
    """A wrong code returns 401 and leaves the pending-auth cookie intact so
    the user can retry without restarting the OAuth round trip."""
    _drive_callback_into_verify_email(
        test_client, email="newgh@test.com", code="654321",
    )

    bad = test_client.post(
        "/api/auth/social/verify-email",
        json={"code": "000000"},
    )
    assert bad.status_code == 401

    # Retry with the right code still works.
    good = test_client.post(
        "/api/auth/social/verify-email",
        json={"code": "654321"},
    )
    assert good.status_code == 200, good.text


def test_social_verify_email_without_pending_cookie_400(test_client):
    """Hitting the endpoint with no pending-auth cookie at all is a client
    error, not a server crash."""
    resp = test_client.post(
        "/api/auth/social/verify-email",
        json={"code": "123456"},
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Post-login return path (``?next=``)
#
# The validator is the security-relevant half of this feature: the parameter is
# attacker-supplied by definition, and it lands in a ``Location`` header on our
# own domain. These cases are the ones that turn a sign-in page into a phishing
# launch pad, so they are asserted individually rather than as a blob.
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "raw",
    [
        "//evil.com",                 # protocol-relative: another origin
        "/\\evil.com",                # browsers normalise the backslash
        "https://evil.com/",          # absolute
        "http://evil.com/",
        "javascript:alert(1)",        # scheme, not rooted
        "agents",                     # not rooted
        "",
        None,
        "/agents\nLocation: https://evil.com",  # header injection
        "/agents\r\nSet-Cookie: x=1",
        "/login",                     # would loop against GuestOnly
        "/verify-email",
        "/" + "a" * 600,              # absurd length
    ],
)
def test_safe_return_path_rejects_hostile_values(raw):
    assert safe_return_path(raw) is None


@pytest.mark.parametrize(
    "raw",
    [
        "/agents",
        "/agents/abc-123/manage",
        "/channels/general?highlight=42",
        "/agents?utm_source=clawbits.ai#top",
        "/logins",                    # NOT /login - prefix must not over-match
    ],
)
def test_safe_return_path_accepts_same_origin_paths(raw):
    assert safe_return_path(raw) == raw


def test_social_start_parks_safe_next_in_a_cookie(test_client):
    """A deep link survives the WorkOS round-trip in its own cookie, kept out
    of the OAuth ``state`` so the CSRF token stays a pure random token."""
    resp = test_client.get(
        "/api/auth/social/google/start",
        params={"next": "/agents/abc/manage"},
        follow_redirects=False,
    )
    assert resp.status_code == 302
    # Starlette quotes rather than percent-encodes a value containing "/".
    cookie = resp.headers.get("set-cookie", "")
    assert 'fc_oauth_return_to="/agents/abc/manage"' in cookie
    # And it must NOT have been folded into the state parameter.
    state = parse_qs(urlparse(resp.headers["location"]).query)["state"][0]
    assert "agents" not in state


def test_social_start_refuses_offsite_next(test_client):
    """An off-site value is dropped, and the cookie is actively cleared so a
    stale one from an earlier attempt cannot be inherited."""
    resp = test_client.get(
        "/api/auth/social/google/start",
        params={"next": "//evil.com"},
        follow_redirects=False,
    )
    cookie = resp.headers.get("set-cookie", "")
    assert "evil.com" not in cookie
    assert 'fc_oauth_return_to=""' in cookie or "fc_oauth_return_to=;" in cookie


def test_social_callback_returns_to_the_deep_link(test_client):
    """The whole point: sign in from a deep link, land back on it."""
    start = test_client.get(
        "/api/auth/social/google/start",
        params={"next": "/agents/abc/manage"},
        follow_redirects=False,
    )
    state = parse_qs(urlparse(start.headers["location"]).query)["state"][0]
    code = test_client.app.state.workos.inject_social_code(email="deep@test.com")

    cb = test_client.get(
        "/api/auth/social/callback",
        params={"code": code, "state": state},
        follow_redirects=False,
    )
    assert cb.status_code == 302
    assert cb.headers["location"].endswith("/agents/abc/manage")
    assert "fc_session=" in cb.headers.get("set-cookie", "")


def test_social_callback_ignores_a_tampered_return_cookie(test_client):
    """The cookie is re-validated at the redirect. We wrote it, but a cookie is
    not a trust boundary - and this value goes straight into ``Location``."""
    start = test_client.get("/api/auth/social/google/start", follow_redirects=False)
    state = parse_qs(urlparse(start.headers["location"]).query)["state"][0]
    code = test_client.app.state.workos.inject_social_code(email="tamper@test.com")
    test_client.cookies.set("fc_oauth_return_to", "https://evil.com/")

    cb = test_client.get(
        "/api/auth/social/callback",
        params={"code": code, "state": state},
        follow_redirects=False,
    )
    assert "evil.com" not in cb.headers["location"]
    assert cb.headers["location"].endswith("/home")
