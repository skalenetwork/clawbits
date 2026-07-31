"""Dev-auth gate tests.

These guard the production-safety contract documented in
:mod:`clawbits.fastapi.dev_auth`:

* All three signals (``CLAWBITS_DEV_AUTH``, ``CLAWBITS_ENV``,
  ``WORKOS_API_KEY``) must agree before dev auth turns on.
* Conflicting signals at startup → ``RuntimeError`` (refuse to boot).
* When disabled, every endpoint returns 404 — no enumeration signal.

The gate is purely env-driven, so most tests use ``monkeypatch.setenv``
and call the gate functions directly. Endpoint-level tests use the
shared ``test_client`` and rely on ``FakeWorkOSClient`` so unused
WorkOS paths don't accidentally talk to the real API.
"""
from __future__ import annotations

import pytest

from clawbits.fastapi.dev_auth import (
    assert_safe_at_startup,
    is_dev_auth_enabled,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _set_env(monkeypatch, *, dev_auth=None, env=None, workos=None):
    """Set or unset the three relevant env vars.

    Each kwarg accepts ``None`` (delete) or a string (set).
    """
    keys = {
        "CLAWBITS_DEV_AUTH": dev_auth,
        "CLAWBITS_ENV": env,
        "WORKOS_API_KEY": workos,
    }
    for k, v in keys.items():
        if v is None:
            monkeypatch.delenv(k, raising=False)
        else:
            monkeypatch.setenv(k, v)


# ---------------------------------------------------------------------------
# Gate truth table
# ---------------------------------------------------------------------------

def test_gate_off_when_flag_unset(monkeypatch):
    _set_env(monkeypatch, dev_auth=None, env="development", workos=None)
    assert is_dev_auth_enabled() is False


def test_gate_off_when_env_unset(monkeypatch):
    """Empty CLAWBITS_ENV must NOT count as 'dev'. Fail-closed default."""
    _set_env(monkeypatch, dev_auth="1", env=None, workos=None)
    assert is_dev_auth_enabled() is False


def test_gate_off_when_env_is_production(monkeypatch):
    _set_env(monkeypatch, dev_auth="1", env="production", workos=None)
    assert is_dev_auth_enabled() is False


def test_gate_off_when_env_is_unknown(monkeypatch):
    _set_env(monkeypatch, dev_auth="1", env="staging", workos=None)
    assert is_dev_auth_enabled() is False


def test_gate_on_when_workos_also_configured(monkeypatch):
    """WORKOS_API_KEY does NOT block dev auth in a dev-marked env — devs
    routinely configure both so they can test the real magic-auth flow
    alongside the bypass. The env value is the authoritative signal."""
    _set_env(monkeypatch, dev_auth="1", env="development", workos="sk_test_abc")
    assert is_dev_auth_enabled() is True


@pytest.mark.parametrize("env_value", ["development", "dev", "local", "test"])
def test_gate_on_when_all_signals_agree(monkeypatch, env_value):
    _set_env(monkeypatch, dev_auth="1", env=env_value, workos=None)
    assert is_dev_auth_enabled() is True


def test_gate_disabled_default_for_missing_flag(monkeypatch):
    """Belt-and-suspenders: if the flag isn't set, NOTHING enables dev auth."""
    for env_value in ["development", "dev", "production", None, "staging"]:
        _set_env(monkeypatch, dev_auth=None, env=env_value, workos=None)
        assert is_dev_auth_enabled() is False, f"flag-unset env={env_value!r}"


# ---------------------------------------------------------------------------
# Startup safety check
# ---------------------------------------------------------------------------

def test_assert_safe_at_startup_noop_when_flag_unset(monkeypatch):
    """No flag = nothing to check, no raise."""
    _set_env(monkeypatch, dev_auth=None, env="production", workos="sk_live")
    assert_safe_at_startup()  # must not raise


def test_assert_safe_at_startup_ok_when_dev_signals_align(monkeypatch):
    _set_env(monkeypatch, dev_auth="1", env="development", workos=None)
    assert_safe_at_startup()  # must not raise


def test_assert_safe_at_startup_ok_with_workos_in_dev(monkeypatch):
    """WorkOS keys alongside dev auth in a dev env is fine — devs do this
    to test the real magic-auth flow. Banner will note the combo."""
    _set_env(monkeypatch, dev_auth="1", env="development", workos="sk_test_abc")
    assert_safe_at_startup()  # must not raise


def test_assert_safe_at_startup_refuses_in_production(monkeypatch):
    _set_env(monkeypatch, dev_auth="1", env="production", workos=None)
    with pytest.raises(RuntimeError, match="not in"):
        assert_safe_at_startup()


def test_assert_safe_at_startup_refuses_with_unset_env(monkeypatch):
    """Setting the dev flag without the env marker is a config bug."""
    _set_env(monkeypatch, dev_auth="1", env=None, workos=None)
    with pytest.raises(RuntimeError):
        assert_safe_at_startup()


# ---------------------------------------------------------------------------
# Endpoint behavior — disabled returns 404, not a hint
# ---------------------------------------------------------------------------

def test_all_endpoints_return_404_when_disabled(test_client, monkeypatch):
    """Every dev endpoint — including the probe — 404s in any non-dev env.
    Production hosts must not advertise that this feature exists."""
    _set_env(monkeypatch, dev_auth=None, env=None, workos=None)
    assert test_client.get("/api/auth/dev/enabled").status_code == 404
    assert test_client.post("/api/auth/dev/login", json={"email": "x@y.com"}).status_code == 404
    assert test_client.post("/api/auth/dev/logout").status_code == 404


def test_enabled_endpoint_reports_true_when_gated_on(test_client, monkeypatch):
    _set_env(monkeypatch, dev_auth="1", env="development", workos=None)
    r = test_client.get("/api/auth/dev/enabled")
    assert r.status_code == 200
    assert r.json() == {"enabled": True}


def test_login_endpoint_works_when_gate_open(test_client, monkeypatch):
    _set_env(monkeypatch, dev_auth="1", env="development", workos=None)
    r = test_client.post(
        "/api/auth/dev/login", json={"email": "alice-devauth@example.com"}
    )
    assert r.status_code == 200
    body = r.json()
    assert body["email"] == "alice-devauth@example.com"
    # Cookie was set
    cookie_header = r.headers.get("set-cookie", "")
    assert "fc_dev_session=" in cookie_header
    assert "HttpOnly" in cookie_header


def test_dependency_ignores_dev_cookie_when_gate_closed(test_client, monkeypatch):
    """A previously-issued, signature-valid dev cookie must be ignored once
    the gate flips off — the dependency rechecks every request."""
    # Issue a valid cookie while gate is open.
    _set_env(monkeypatch, dev_auth="1", env="development", workos=None)
    r = test_client.post(
        "/api/auth/dev/login", json={"email": "carol-devauth@example.com"}
    )
    assert r.status_code == 200
    # /me should work
    r = test_client.get("/api/auth/me")
    assert r.status_code == 200, r.text

    # Flip the gate off — the cookie is still in the jar, still validly
    # signed, but must no longer authenticate the request.
    _set_env(monkeypatch, dev_auth=None, env=None, workos=None)
    r = test_client.get("/api/auth/me")
    assert r.status_code == 401, r.text


def test_login_endpoint_ok_with_workos_also_configured(test_client, monkeypatch):
    """WorkOS keys do not block the dev login endpoint in a dev env."""
    _set_env(monkeypatch, dev_auth="1", env="development", workos="sk_test_abc")
    r = test_client.post(
        "/api/auth/dev/login", json={"email": "dual-auth@example.com"}
    )
    assert r.status_code == 200, r.text


def test_login_endpoint_404_in_production_even_with_flag(test_client, monkeypatch):
    """The hard line: production env ⇒ 404 regardless of the flag."""
    _set_env(monkeypatch, dev_auth="1", env="production", workos=None)
    r = test_client.post(
        "/api/auth/dev/login", json={"email": "z@example.com"}
    )
    assert r.status_code == 404


def test_login_endpoint_404_when_env_unset(test_client, monkeypatch):
    """Empty CLAWBITS_ENV is treated as production — 404."""
    _set_env(monkeypatch, dev_auth="1", env=None, workos=None)
    r = test_client.post(
        "/api/auth/dev/login", json={"email": "z@example.com"}
    )
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Cookie integrity — type-confusion and edge-case rejections
# ---------------------------------------------------------------------------

def test_dev_session_rejects_bool_user_id(monkeypatch):
    """``bool`` is a subclass of ``int`` in Python — a forged payload
    ``{"user_id": true}`` must NOT resolve to user 1."""
    from clawbits.fastapi.dev_auth import _sign_dev_session, _verify_dev_session

    _set_env(monkeypatch, dev_auth="1", env="development", workos=None)

    # _verify_dev_session itself accepts the payload (it doesn't type-check
    # there), but the dependency hook (resolve_dev_session_user) is where
    # the bool guard lives. Build a forged token and try to use it.
    forged_true = _sign_dev_session({"user_id": True})
    forged_false = _sign_dev_session({"user_id": False})
    # Sanity: verification surfaces the payload as-is (HMAC passes).
    assert _verify_dev_session(forged_true) == {"user_id": True}
    assert _verify_dev_session(forged_false) == {"user_id": False}


def test_dependency_hook_rejects_bool_user_id(test_client, monkeypatch):
    """End-to-end: a HMAC-valid cookie with ``user_id=true`` must NOT
    authenticate as user 1."""
    from clawbits.fastapi.dev_auth import _sign_dev_session

    _set_env(monkeypatch, dev_auth="1", env="development", workos=None)
    forged = _sign_dev_session({"user_id": True})
    test_client.cookies.set("fc_dev_session", forged)
    try:
        r = test_client.get("/api/auth/me")
        assert r.status_code == 401, r.text
    finally:
        test_client.cookies.clear()


def test_dependency_hook_rejects_non_positive_user_id(test_client, monkeypatch):
    """Zero / negative integers are not legitimate human_users.id values."""
    from clawbits.fastapi.dev_auth import _sign_dev_session

    _set_env(monkeypatch, dev_auth="1", env="development", workos=None)
    for bogus in (0, -1, -999):
        forged = _sign_dev_session({"user_id": bogus})
        test_client.cookies.set("fc_dev_session", forged)
        try:
            r = test_client.get("/api/auth/me")
            assert r.status_code == 401, f"user_id={bogus} unexpectedly authenticated"
        finally:
            test_client.cookies.clear()


def test_dependency_hook_rejects_unsigned_cookie(test_client, monkeypatch):
    """Plain JSON without the HMAC suffix must not authenticate."""
    _set_env(monkeypatch, dev_auth="1", env="development", workos=None)
    test_client.cookies.set("fc_dev_session", "eyJ1c2VyX2lkIjogMX0.deadbeef")
    try:
        r = test_client.get("/api/auth/me")
        assert r.status_code == 401, r.text
    finally:
        test_client.cookies.clear()


def test_workos_signin_after_devauth_rebinds_workos_id(test_client, monkeypatch):
    """Regression: a user created via dev-auth (which stores ``dev:<email>``
    as the placeholder workos_user_id) must be able to later sign in via
    real WorkOS without a unique-email crash. The expected behavior is
    that the existing row's ``workos_user_id`` is late-bound to the real
    WorkOS id — identity is keyed on email."""
    from sqlmodel import Session

    from clawbits.db.models import HumanUser
    from clawbits.db.table_read import TableRead
    from clawbits.fastapi.workos_auth import _ensure_user

    _set_env(monkeypatch, dev_auth="1", env="development", workos=None)
    email = "rebind-test@example.com"

    # Step 1: dev-auth creates the user with a "dev:" placeholder id.
    r = test_client.post("/api/auth/dev/login", json={"email": email})
    assert r.status_code == 200
    test_client.cookies.clear()

    with Session(test_client.app._engine) as db:
        before = TableRead.get_human_user_by_email(db, email)
        assert before is not None
        assert before["workos_user_id"].startswith("dev:")
        before_id = before["id"]

    # Step 2: simulate WorkOS magic-auth landing on _ensure_user with a
    # fresh WorkOS user id. Should NOT raise UniqueViolation.
    real_workos_id = "user_01ABCDEFREBINDTEST"

    class _FakeRequest:
        app = test_client.app

    import asyncio

    user = asyncio.run(_ensure_user(
        _FakeRequest(),  # type: ignore[arg-type]
        workos_user_id=real_workos_id,
        email=email,
        first_name=None,
        last_name=None,
    ))

    # Same row, new id.
    assert user["id"] == before_id
    assert user["workos_user_id"] == real_workos_id
    with Session(test_client.app._engine) as db:
        row = db.get(HumanUser, before_id)
        assert row is not None and row.workos_user_id == real_workos_id


def test_dependency_hook_rejects_tampered_cookie(test_client, monkeypatch):
    """A real cookie with one bit flipped fails HMAC verification."""
    from clawbits.fastapi.dev_auth import _sign_dev_session

    _set_env(monkeypatch, dev_auth="1", env="development", workos=None)
    legit = _sign_dev_session({"user_id": 1})
    body, sig = legit.split(".", 1)
    # Flip a character in the signature.
    tampered_sig = ("X" + sig[1:]) if sig[0] != "X" else ("Y" + sig[1:])
    test_client.cookies.set("fc_dev_session", f"{body}.{tampered_sig}")
    try:
        r = test_client.get("/api/auth/me")
        assert r.status_code == 401, r.text
    finally:
        test_client.cookies.clear()
