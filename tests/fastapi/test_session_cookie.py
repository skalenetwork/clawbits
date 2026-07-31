"""Regression tests for the session-cookie staging pipeline.

Pins down the architectural fix: a cookie staged via
:func:`stage_session_set` MUST land on the ``Set-Cookie`` header
regardless of which response shape the endpoint emits — Pydantic,
StreamingResponse (SSE), RedirectResponse, or the JSONResponse the
custom ``http_exception_handler`` re-emits.

Before the fix, the auth dependency wrote ``Set-Cookie`` directly to a
``Response``-typed parameter. FastAPI only merges that into the final
response on the Pydantic-return path; for direct ``Response`` returns
(SSE, redirects) and exception-handler re-emits the cookie was silently
dropped. A successful WorkOS refresh would burn the old refresh token
on the server while the browser kept the now-stale sealed cookie —
guaranteeing logout on the next request. These tests would catch any
future regression to that broken pattern.
"""
from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse, StreamingResponse
from fastapi.testclient import TestClient

from clawbits.fastapi.session_cookie import (
    DEV_SESSION_COOKIE,
    SESSION_COOKIE,
    session_cookie_middleware,
    stage_dev_session_set,
    stage_session_clear,
    stage_session_set,
)


def _build_app() -> FastAPI:
    """Minimal app exercising every response shape the fix must cover."""
    app = FastAPI()
    # Mirror the production exception handler — it builds a fresh
    # JSONResponse from scratch, which historically dropped any cookies
    # the auth dependency had written.
    @app.exception_handler(HTTPException)
    async def _http_exc(request: Request, exc: HTTPException) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail, "path": str(request.url.path)},
        )

    app.middleware("http")(session_cookie_middleware)

    @app.get("/pydantic")
    def pydantic_endpoint(request: Request) -> dict[str, str]:
        stage_session_set(request, "sealed-pydantic")
        return {"ok": "yes"}

    @app.get("/stream")
    def stream_endpoint(request: Request) -> StreamingResponse:
        stage_session_set(request, "sealed-stream")

        async def body() -> AsyncIterator[bytes]:
            yield b"data: hi\n\n"

        return StreamingResponse(body(), media_type="text/event-stream")

    @app.get("/redirect")
    def redirect_endpoint(request: Request) -> RedirectResponse:
        stage_session_set(request, "sealed-redirect")
        return RedirectResponse("/elsewhere", status_code=302)

    @app.get("/raises")
    def raises_endpoint(request: Request) -> None:
        # The dependency-equivalent: stage a refreshed cookie, then have
        # the route raise. Historically the cookie was lost here because
        # the exception handler returns a brand-new JSONResponse.
        stage_session_set(request, "sealed-after-raise")
        raise HTTPException(status_code=404, detail="missing")

    @app.get("/dev-set")
    def dev_set_endpoint(request: Request) -> dict[str, str]:
        stage_dev_session_set(request, "dev-token")
        return {"ok": "yes"}

    @app.post("/clear")
    def clear_endpoint(request: Request) -> dict[str, str]:
        stage_session_clear(request)
        return {"ok": "yes"}

    @app.get("/no-staging")
    def no_staging_endpoint() -> dict[str, str]:
        return {"ok": "yes"}

    return app


@pytest.fixture
def client() -> TestClient:
    return TestClient(_build_app())


# ---------------------------------------------------------------------------
# The bug: cookie was dropped on every shape except Pydantic returns.
# ---------------------------------------------------------------------------


def test_pydantic_response_carries_staged_cookie(client: TestClient) -> None:
    """Control case: Pydantic / dict returns — always worked, must keep working."""
    resp = client.get("/pydantic")
    assert resp.status_code == 200
    assert client.cookies.get(SESSION_COOKIE) == "sealed-pydantic"


def test_streaming_response_carries_staged_cookie(client: TestClient) -> None:
    """The SSE-channel bug. ``StreamingResponse`` returns must carry the
    refreshed sealed cookie or the user is permanently stranded."""
    resp = client.get("/stream")
    assert resp.status_code == 200
    assert client.cookies.get(SESSION_COOKIE) == "sealed-stream"


def test_redirect_response_carries_staged_cookie(client: TestClient) -> None:
    """OAuth-callback shape. The redirect carries the post-login cookie."""
    resp = client.get("/redirect", follow_redirects=False)
    assert resp.status_code == 302
    assert client.cookies.get(SESSION_COOKIE) == "sealed-redirect"


def test_exception_handler_carries_staged_cookie(client: TestClient) -> None:
    """If the auth dep refreshes the cookie and the route then raises a
    handled HTTPException, the new cookie still has to land on the
    error response — otherwise the burnt RT stays in the browser."""
    resp = client.get("/raises")
    assert resp.status_code == 404
    assert client.cookies.get(SESSION_COOKIE) == "sealed-after-raise"


# ---------------------------------------------------------------------------
# The other staging actions — same architecture, different cookie name.
# ---------------------------------------------------------------------------


def test_dev_session_set_writes_dev_cookie(client: TestClient) -> None:
    resp = client.get("/dev-set")
    assert resp.status_code == 200
    assert client.cookies.get(DEV_SESSION_COOKIE) == "dev-token"
    assert client.cookies.get(SESSION_COOKIE) is None


def test_session_clear_removes_both_cookies(client: TestClient) -> None:
    """Logout must clear both WorkOS and dev cookies in one step — the
    user shouldn't have to know which login flow they used.

    Asserted against the raw ``Set-Cookie`` headers rather than the
    cookie jar: httpx's jar doesn't always honour ``Max-Age=0`` deletes
    for cookies that were seeded directly via ``client.cookies.set``,
    but a real browser will. The wire-level ``Set-Cookie`` is the
    contract that matters.
    """
    resp = client.post("/clear")
    assert resp.status_code == 200
    set_cookies = resp.headers.get_list("set-cookie")
    # Each clear emits a ``Set-Cookie: <name>=""; Max-Age=0; ...`` line.
    assert any(
        sc.startswith(f"{SESSION_COOKIE}=") and "Max-Age=0" in sc
        for sc in set_cookies
    ), set_cookies
    assert any(
        sc.startswith(f"{DEV_SESSION_COOKIE}=") and "Max-Age=0" in sc
        for sc in set_cookies
    ), set_cookies


def test_no_staging_emits_no_cookie(client: TestClient) -> None:
    """Endpoints that don't stage anything must not gain a session
    cookie. The middleware is opt-in via the staging API."""
    resp = client.get("/no-staging")
    assert resp.status_code == 200
    assert "set-cookie" not in {k.lower() for k in resp.headers.keys()}


# ---------------------------------------------------------------------------
# Cookie attributes — the parts a misconfiguration would silently break.
# ---------------------------------------------------------------------------


def test_session_cookie_has_security_attributes(client: TestClient) -> None:
    """``HttpOnly`` and ``SameSite=lax`` are the load-bearing attributes
    for browser delivery + XSS containment. ``Secure`` is environment-
    dependent (off when ``CLAWBITS_INSECURE_COOKIES=1``) so we don't
    pin it here — the conftest sets that flag for the test suite."""
    resp = client.get("/stream")
    set_cookie = resp.headers.get("set-cookie", "")
    assert f"{SESSION_COOKIE}=sealed-stream" in set_cookie
    assert "HttpOnly" in set_cookie
    assert "SameSite=lax" in set_cookie
    assert "Path=/" in set_cookie


# ---------------------------------------------------------------------------
# Env-scoped cookie names. Defends against the "I'm logged in on prod
# and dev simultaneously and DevTools just shows two ``fc_session`` rows"
# footgun if anyone ever introduces a shared ``domain=`` attribute or
# someone points a local dev frontend at staging.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("env_value", "expected_suffix"),
    [
        (None, ""),                  # unset → treated as prod
        ("production", ""),          # prod stays unsuffixed for migration safety
        ("staging", "_staging"),
        ("development", "_dev"),
        ("dev", "_dev"),
        ("local", "_dev"),
        ("test", "_dev"),
        ("DEVELOPMENT", "_dev"),     # case-insensitive
        ("preview", "_preview"),     # unrecognised → use it verbatim, not prod
    ],
)
def test_env_suffix_resolution(
    monkeypatch: pytest.MonkeyPatch,
    env_value: str | None,
    expected_suffix: str,
) -> None:
    """``_env_suffix`` derives the suffix from ``CLAWBITS_ENV`` strictly.

    Critical invariants:

    * Prod is unsuffixed — keeps existing prod sessions valid across deploys.
    * Unrecognised values get a suffix (not silently treated as prod) — a
      typo in the env var must not cause a dev cookie to land in the prod
      cookie name.
    """
    from clawbits.fastapi.session_cookie import _env_suffix

    if env_value is None:
        monkeypatch.delenv("CLAWBITS_ENV", raising=False)
    else:
        monkeypatch.setenv("CLAWBITS_ENV", env_value)

    assert _env_suffix() == expected_suffix


# ---------------------------------------------------------------------------
# Cookie-name resolution at the auth dependency. Pins the bug where
# ``Cookie(default=None)`` alone defaults to the parameter name as the
# cookie name — silently breaking auth when cookie names are env-suffixed
# (``fc_session_staging`` etc.) because the dependency was looking for
# the literal string ``fc_session``. Caught only at deploy time without
# this test.
# ---------------------------------------------------------------------------


def test_auth_dependency_reads_cookie_by_alias() -> None:
    """``get_current_human_user`` must use ``Cookie(alias=SESSION_COOKIE)``,
    not the bare parameter name. Without the alias, env-suffixed cookies
    (``fc_session_staging``) wouldn't be found and every request 401s.

    This is a *contract test* on the dependency signature — if anyone
    drops the ``alias=`` argument, this test catches it before deploy.
    """
    import inspect

    from fastapi.params import Cookie as CookieMarker

    from clawbits.fastapi.session_cookie import (
        DEV_SESSION_COOKIE,
        SESSION_COOKIE,
    )
    from clawbits.fastapi.workos_auth import get_current_human_user

    sig = inspect.signature(get_current_human_user)
    aliases = {
        name: param.default.alias
        for name, param in sig.parameters.items()
        if isinstance(param.default, CookieMarker)
    }
    assert SESSION_COOKIE in aliases.values(), (
        f"workos session cookie alias missing — found {aliases}. "
        f"Without ``alias=SESSION_COOKIE`` the dependency reads cookie "
        f"by parameter name, which won't match env-suffixed cookies."
    )
    assert DEV_SESSION_COOKIE in aliases.values(), (
        f"dev session cookie alias missing — found {aliases}."
    )


def test_oauth_callback_reads_state_cookie_by_alias() -> None:
    """Same contract as above for ``OAUTH_STATE_COOKIE``. The state cookie
    is set by ``/social/{provider}/start`` with the env-suffixed name and
    must be read back with the same name in ``/social/callback``.
    """
    import inspect

    from fastapi.params import Cookie as CookieMarker

    from clawbits.fastapi.session_cookie import OAUTH_STATE_COOKIE
    from clawbits.fastapi.workos_auth import social_callback

    sig = inspect.signature(social_callback)
    aliases = [
        param.default.alias
        for param in sig.parameters.values()
        if isinstance(param.default, CookieMarker)
    ]
    assert OAUTH_STATE_COOKIE in aliases, (
        f"oauth state cookie alias missing — found {aliases}. "
        f"Without ``alias=OAUTH_STATE_COOKIE`` the callback can't match "
        f"the env-suffixed cookie set by ``/social/.../start``."
    )
