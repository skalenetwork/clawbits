"""Dev-only auth — bypass WorkOS magic links in local development.

Fails closed. Enabled only when ``CLAWBITS_DEV_AUTH=1`` AND
``CLAWBITS_ENV`` ∈ ``{development, dev, local, test}``. Conflicting
signals (e.g. dev-auth on with ``CLAWBITS_ENV=production``) refuse boot.
When disabled, every endpoint here returns 404 (not 403) so dev-auth
leaves no detectable surface in prod.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field
from sqlmodel import Session

from clawbits.db.models import DISPLAY_NAME_MAX_LENGTH
from clawbits.db.table_read import TableRead
from clawbits.db.table_write import TableWrite
from clawbits.domain import DEV_ENVS, is_dev_env
from clawbits.fastapi.session_cookie import (
    auth_log,
    stage_dev_session_set,
    stage_session_clear,
)

log = logging.getLogger(__name__)

# Namespace prefixes for dev-only users — keeps real and dev IDs unambiguous.
DEV_WORKOS_ID_PREFIX = "dev:"
DEV_WORKOS_ORG_ID_PREFIX = "dev-org:"


def _gate_signals() -> tuple[bool, str | None]:
    """Returns ``(enabled, reason_if_disabled_or_conflict)``."""
    flag = os.environ.get("CLAWBITS_DEV_AUTH") == "1"
    # ``env_raw`` is kept only for the operator-facing reason string below;
    # the gate itself defers to the shared fail-closed predicate.
    env_raw = (os.environ.get("CLAWBITS_ENV") or "").strip().lower()
    env_is_dev = is_dev_env()

    if not flag:
        return False, "CLAWBITS_DEV_AUTH not set"

    if not env_is_dev:
        return False, (
            f"CLAWBITS_DEV_AUTH=1 but CLAWBITS_ENV={env_raw or '(unset)'!r} "
            f"is not in {sorted(DEV_ENVS)}. Refusing to enable dev auth."
        )
    return True, None


def is_dev_auth_enabled() -> bool:
    """Whether dev auth is currently enabled. Fails closed.

    Requires ``CLAWBITS_DEV_AUTH=1`` AND ``CLAWBITS_ENV`` in the dev allow-list.
    """
    enabled, _ = _gate_signals()
    return enabled


def assert_safe_at_startup() -> None:
    """Refuse boot if dev-auth signals look misconfigured. When dev-auth is
    genuinely enabled, emit a loud WARNING banner."""
    flag = os.environ.get("CLAWBITS_DEV_AUTH") == "1"
    if not flag:
        return

    enabled, reason = _gate_signals()
    if enabled:
        log.warning("=" * 72)
        log.warning("DEV AUTH IS ENABLED")
        log.warning("  CLAWBITS_DEV_AUTH=1")
        log.warning("  CLAWBITS_ENV=%s", os.environ.get("CLAWBITS_ENV"))
        log.warning("  Anyone who can reach this host can sign in as any email.")
        if os.environ.get("WORKOS_API_KEY"):
            log.warning("  ⚠️ WORKOS_API_KEY is also configured — make sure "
                        "this host isn't accidentally a real environment.")
        log.warning("  Disable by unsetting CLAWBITS_DEV_AUTH (or restarting).")
        log.warning("=" * 72)
        return

    raise RuntimeError(
        f"Refusing to start: dev-auth signals are misconfigured. {reason} "
        f"Set CLAWBITS_ENV to one of {sorted(DEV_ENVS)}, or unset CLAWBITS_DEV_AUTH.",
    )


def _signing_key() -> bytes:
    """HMAC key for the dev cookie. Uses ``CLAWBITS_DEV_AUTH_SECRET`` if set,
    else derives a stable key from ``WORKOS_COOKIE_PASSWORD``."""
    explicit = os.environ.get("CLAWBITS_DEV_AUTH_SECRET")
    if explicit:
        return explicit.encode()
    fallback = os.environ.get("WORKOS_COOKIE_PASSWORD") or "clawbits-dev-auth"
    return hashlib.sha256(fallback.encode()).digest()


def _b64u_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64u_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _sign_dev_session(payload: dict[str, Any]) -> str:
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    sig = hmac.new(_signing_key(), body, hashlib.sha256).digest()
    return f"{_b64u_encode(body)}.{_b64u_encode(sig)}"


def _verify_dev_session(token: str) -> dict[str, Any] | None:
    """Verify HMAC and return the payload dict, or ``None`` on any failure."""
    try:
        body_b64, sig_b64 = token.split(".", 1)
        body, sig = _b64u_decode(body_b64), _b64u_decode(sig_b64)
        expected = hmac.new(_signing_key(), body, hashlib.sha256).digest()
        if not hmac.compare_digest(sig, expected):
            return None
        payload = json.loads(body.decode())
    except (ValueError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) and "user_id" in payload else None


def resolve_dev_session_user(request: Request, cookie_value: str | None) -> dict | None:
    """Return the local user for a valid dev session, or ``None``.

    Accepts the token from either the cookie (browser) or the
    ``Authorization: Bearer`` header (desktop/Tauri). Bearer wins when both
    are present. Returns ``None`` silently when the token isn't a valid dev
    HMAC — the caller falls through to WorkOS validation, so a WorkOS
    Bearer token passed in here is harmless.
    Safe to call unconditionally — returns ``None`` when dev-auth is off."""
    if not is_dev_auth_enabled():
        return None
    bearer: str | None = None
    auth = request.headers.get("authorization")
    if auth and auth.lower().startswith("bearer "):
        bearer = auth.split(" ", 1)[1].strip() or None
    token = bearer or cookie_value
    if not token:
        return None
    payload = _verify_dev_session(token)
    if payload is None:
        # Silent: a WorkOS Bearer token will land here too. Only log when
        # the value came from the dev cookie alias, since that's a real
        # failure (forged or stale cookie).
        if bearer is None:
            auth_log.info("auth.dev.reject reason=hmac_invalid")
        return None
    user_id = payload.get("user_id")
    # ``bool`` is an ``int`` subclass — reject explicitly so a forged
    # ``{"user_id": true}`` doesn't resolve to user 1.
    if not isinstance(user_id, int) or isinstance(user_id, bool) or user_id <= 0:
        auth_log.info("auth.dev.reject reason=bad_user_id value=%r", user_id)
        return None
    with Session(request.app._engine) as db:
        user = TableRead.get_human_user_by_id(db, user_id)
        if user is None:
            auth_log.info("auth.dev.reject reason=local_user_not_found user_id=%s", user_id)
        return user


dev_auth_router = APIRouter(tags=["Dev Auth"])


class DevLoginRequest(BaseModel):
    email: EmailStr = Field(description="Email to sign in as (created on first use)")
    display_name: str | None = Field(default=None, max_length=DISPLAY_NAME_MAX_LENGTH)


class DevLoginResponse(BaseModel):
    id: int
    email: str
    display_name: str | None = None
    # Same signed session value that's also set as the fc_dev_session cookie.
    # Desktop (Tauri) clients store this and send it as
    # ``Authorization: Bearer <token>`` because third-party cookies don't
    # survive cross-origin from the tauri:// scheme. Web clients can ignore.
    token: str


class DevEnabledResponse(BaseModel):
    enabled: bool


@dev_auth_router.get("/api/auth/dev/enabled", response_model=DevEnabledResponse)
def dev_auth_enabled() -> DevEnabledResponse:
    """The frontend hits this to decide whether to render the dev-login UI."""
    if not is_dev_auth_enabled():
        raise HTTPException(status_code=404, detail="Not Found")
    return DevEnabledResponse(enabled=True)


@dev_auth_router.post("/api/auth/dev/login", response_model=DevLoginResponse)
async def dev_login(body: DevLoginRequest, request: Request) -> DevLoginResponse:
    """Sign in as ``email`` without WorkOS. Creates the local user + personal
    org on first use."""
    if not is_dev_auth_enabled():
        raise HTTPException(status_code=404, detail="Not Found")

    email = body.email.lower()
    display_name = body.display_name or email.split("@")[0]
    workos_user_id = f"{DEV_WORKOS_ID_PREFIX}{email}"
    workos_org_id = f"{DEV_WORKOS_ORG_ID_PREFIX}{email}"
    new_user_id: int | None = None

    with Session(request.app._engine) as db:
        existing = TableRead.get_human_user_by_email(db, email)
        if existing is None:
            new_id = TableWrite.create_human_user(
                db, email=email, workos_user_id=workos_user_id, display_name=display_name,
            )
            TableWrite.create_personal_org(
                db, human_id=new_id, email=email, workos_org_id=workos_org_id,
            )
            db.commit()
            user = TableRead.get_human_user_by_id(db, new_id)
            new_user_id = new_id
        else:
            user = existing

    if user is None:
        raise HTTPException(status_code=500, detail="Failed to provision dev user")

    if new_user_id is not None:
        # Glass-style avatar for the fresh user — awaited after commit
        # so the URL in subsequent /api/human/me reads points at bytes
        # that exist by the time the browser fetches them. fire-and-
        # forget would silently skip in this sync-route context.
        from clawbits.fastapi.avatar_hooks import await_user_avatar
        await await_user_avatar(user_id=new_user_id)

    token = _sign_dev_session({"user_id": user["id"], "issued_at": int(time.time())})
    stage_dev_session_set(request, token)
    auth_log.info("auth.login.dev user_id=%s email=%s", user["id"], email)
    return DevLoginResponse(
        id=user["id"], email=user["email"], display_name=user.get("display_name"),
        token=token,
    )


@dev_auth_router.post("/api/auth/dev/logout", status_code=204)
def dev_logout(request: Request) -> None:
    if not is_dev_auth_enabled():
        raise HTTPException(status_code=404, detail="Not Found")
    stage_session_clear(request)
