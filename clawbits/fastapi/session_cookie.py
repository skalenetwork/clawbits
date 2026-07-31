"""Session-cookie staging API.

Auth code stages an op on ``request.state``; the middleware applies it to
whichever final response Starlette emits. There is exactly one place that
calls ``response.set_cookie`` for a session cookie: :func:`_apply_op`.
"""

from __future__ import annotations

import hashlib
import logging
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Literal

from fastapi import Request, Response

auth_log = logging.getLogger("clawbits.auth")
auth_log.setLevel(logging.INFO)


def session_fingerprint(sealed: str | None) -> str:
    """8-char SHA-256 prefix of a sealed cookie; ``-`` if absent."""
    if not sealed:
        return "-"
    return hashlib.sha256(sealed.encode()).hexdigest()[:8]


def _env_suffix() -> str:
    """Suffix cookie names by env so dev/staging/prod never collide."""
    env = (os.environ.get("CLAWBITS_ENV") or "").strip().lower()
    if env in ("", "production"):
        return ""
    if env == "staging":
        return "_staging"
    if env in ("development", "dev", "local", "test"):
        return "_dev"
    return f"_{env}"


SESSION_COOKIE = f"fc_session{_env_suffix()}"
DEV_SESSION_COOKIE = f"fc_dev_session{_env_suffix()}"
OAUTH_STATE_COOKIE = f"fc_oauth_state{_env_suffix()}"
# Connector link OAuth (GitHub App, etc.) — separate from WorkOS login state
# so a Connectors flow never collides with Sign in with GitHub.
CONNECTOR_OAUTH_STATE_COOKIE = f"fc_connector_oauth_state{_env_suffix()}"
# Holds the WorkOS ``pending_authentication_token`` while the user types the
# 6-digit email-verification code. Httponly so JS can't exfiltrate it; ~10 min
# TTL matches WorkOS's own verification window.
OAUTH_PENDING_COOKIE = f"fc_oauth_pending{_env_suffix()}"
OAUTH_PENDING_COOKIE_MAX_AGE = 60 * 10  # 10 minutes

_SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30  # 30 days


def cookie_kwargs() -> dict[str, Any]:
    """Shared cookie attributes. Set ``CLAWBITS_INSECURE_COOKIES=1`` for ``http://`` dev."""
    secure = os.environ.get("CLAWBITS_INSECURE_COOKIES") != "1"
    return {"httponly": True, "secure": secure, "samesite": "lax", "path": "/"}


_STATE_KEY = "_fc_session_op"


@dataclass(slots=True)
class _SessionOp:
    action: Literal["set_workos", "set_dev", "clear"]
    value: str | None = None


def stage_session_set(request: Request, sealed: str) -> None:
    setattr(request.state, _STATE_KEY, _SessionOp("set_workos", sealed))


def stage_dev_session_set(request: Request, signed_token: str) -> None:
    setattr(request.state, _STATE_KEY, _SessionOp("set_dev", signed_token))


def stage_session_clear(request: Request) -> None:
    """Clear both session cookies so a single logout works for either auth path."""
    setattr(request.state, _STATE_KEY, _SessionOp("clear"))


def _apply_op(request: Request, response: Response) -> None:
    op: _SessionOp | None = getattr(request.state, _STATE_KEY, None)
    if op is None:
        return
    if op.action == "set_workos":
        assert op.value is not None
        response.set_cookie(SESSION_COOKIE, op.value, max_age=_SESSION_COOKIE_MAX_AGE, **cookie_kwargs())
    elif op.action == "set_dev":
        assert op.value is not None
        response.set_cookie(DEV_SESSION_COOKIE, op.value, max_age=_SESSION_COOKIE_MAX_AGE, **cookie_kwargs())
    else:
        response.delete_cookie(SESSION_COOKIE, path="/")
        response.delete_cookie(DEV_SESSION_COOKIE, path="/")


async def session_cookie_middleware(
    request: Request,
    call_next: Callable[[Request], Awaitable[Response]],
) -> Response:
    response = await call_next(request)
    _apply_op(request, response)
    return response
