"""GitHub connector adapter — identity only, no tokens stored.

Two paths to a :class:`ConnectorProfile`:

1. **WorkOS sync** — ``get_user_identities`` for the current WorkOS user;
   if a ``GitHubOAuth`` identity exists, resolve ``login`` via the public
   GitHub API (``GET /user/{id}``) and upsert. Zero-click for users who
   already signed in with GitHub.
2. **Dedicated OAuth App link** — Clawbits-owned GitHub OAuth App with
   ``read:user``. Proves control of a GitHub account **without** requiring
   the GitHub email to match the Clawbits login email. Access token is
   used once to fetch ``/user`` and then discarded — never persisted.

Capability credentials (repo tokens) are explicitly out of scope — see
``docs/protocol/GITHUB_INTEGRATION_SPEC.md``.
"""
from __future__ import annotations

import logging
import os
import urllib.parse
from typing import Any

import httpx

from clawbits.connectors.types import ConnectorProfile

log = logging.getLogger("clawbits.connectors.github")

WORKOS_GITHUB_PROVIDER = "GitHubOAuth"
_GITHUB_USER_AGENT = "clawbits-connectors"
_OAUTH_SCOPES = "read:user"
_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
_TOKEN_URL = "https://github.com/login/oauth/access_token"
_USER_URL = "https://api.github.com/user"


class GitHubConnectorNotConfigured(RuntimeError):
    """Raised when ``GITHUB_CONNECTOR_CLIENT_*`` env vars are missing."""


def github_connector_configured() -> bool:
    return bool(
        (os.environ.get("GITHUB_CONNECTOR_CLIENT_ID") or "").strip()
        and (os.environ.get("GITHUB_CONNECTOR_CLIENT_SECRET") or "").strip()
    )


def _oauth_credentials() -> tuple[str, str]:
    client_id = (os.environ.get("GITHUB_CONNECTOR_CLIENT_ID") or "").strip()
    client_secret = (os.environ.get("GITHUB_CONNECTOR_CLIENT_SECRET") or "").strip()
    if not client_id or not client_secret:
        raise GitHubConnectorNotConfigured(
            "GITHUB_CONNECTOR_CLIENT_ID / GITHUB_CONNECTOR_CLIENT_SECRET not set"
        )
    return client_id, client_secret


def connector_oauth_redirect_uri() -> str:
    """Callback registered on the Clawbits GitHub OAuth App."""
    base = os.environ.get("CLAWBITS_BASE_URL", "http://localhost:8000").rstrip("/")
    return f"{base}/api/auth/connectors/github/callback"


def build_github_authorize_url(*, state: str, redirect_uri: str | None = None) -> str:
    client_id, _ = _oauth_credentials()
    params = urllib.parse.urlencode(
        {
            "client_id": client_id,
            "redirect_uri": redirect_uri or connector_oauth_redirect_uri(),
            "scope": _OAUTH_SCOPES,
            "state": state,
            # Force account picker so users can choose a non-default GitHub.
            "allow_signup": "false",
        }
    )
    return f"{_AUTHORIZE_URL}?{params}"


def profile_from_github_user_payload(data: dict[str, Any]) -> ConnectorProfile:
    """Map a GitHub ``GET /user`` JSON body to a connector profile."""
    external_id = str(data["id"])
    handle = data.get("login") or f"user:{external_id}"
    metadata: dict[str, Any] = {"idp_id": external_id, "source": "oauth_app"}
    if data.get("html_url"):
        metadata["html_url"] = data["html_url"]
    if data.get("email"):
        # Public email only — never a secret; useful for display/debug.
        metadata["public_email"] = data["email"]
    return ConnectorProfile(
        provider="github",
        external_id=external_id,
        handle=handle,
        display_name=data.get("name") or handle,
        avatar_url=data.get("avatar_url"),
        metadata=metadata,
    )


async def exchange_code_for_profile(
    *,
    code: str,
    redirect_uri: str | None = None,
) -> ConnectorProfile:
    """Exchange an OAuth code for a profile, then discard the access token.

    The token never leaves this function's stack — it is not returned and
    not written anywhere.
    """
    client_id, client_secret = _oauth_credentials()
    redirect = redirect_uri or connector_oauth_redirect_uri()

    async with httpx.AsyncClient(timeout=15.0) as client:
        token_resp = await client.post(
            _TOKEN_URL,
            headers={
                "Accept": "application/json",
                "User-Agent": _GITHUB_USER_AGENT,
            },
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "code": code,
                "redirect_uri": redirect,
            },
        )
        token_resp.raise_for_status()
        token_body = token_resp.json()
        access_token = token_body.get("access_token")
        if not access_token:
            err = token_body.get("error_description") or token_body.get("error") or "no_token"
            raise ValueError(f"github_oauth_token_failed:{err}")

        try:
            user_resp = await client.get(
                _USER_URL,
                headers={
                    "Accept": "application/vnd.github+json",
                    "Authorization": f"Bearer {access_token}",
                    "User-Agent": _GITHUB_USER_AGENT,
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            )
            user_resp.raise_for_status()
            data = user_resp.json()
        finally:
            # Best-effort: drop local reference promptly. GitHub tokens from
            # this App are short-lived for our purposes; we never persist them.
            access_token = None  # noqa: F841
            del token_body

    if not isinstance(data, dict) or data.get("id") is None:
        raise ValueError("github_oauth_user_invalid")
    return profile_from_github_user_payload(data)


def find_github_identity(identities: list[Any]) -> Any | None:
    """Return the WorkOS identity object for GitHub, if any."""
    for identity in identities:
        provider = getattr(identity, "provider", None)
        if provider is None and isinstance(identity, dict):
            provider = identity.get("provider")
        if provider == WORKOS_GITHUB_PROVIDER:
            return identity
    return None


def identity_idp_id(identity: Any) -> str | None:
    raw = getattr(identity, "idp_id", None)
    if raw is None and isinstance(identity, dict):
        raw = identity.get("idp_id")
    if raw is None:
        return None
    return str(raw)


async def resolve_github_profile(idp_id: str) -> ConnectorProfile:
    """Resolve a GitHub public profile from a numeric (or string) user id.

    Uses the unauthenticated ``GET /user/{id}`` endpoint — no token needed,
    and therefore nothing to store. Falls back to a handle derived from the
    id if GitHub is unreachable (still useful for uniqueness / routing).
    """
    external_id = str(idp_id).strip()
    if not external_id:
        raise ValueError("empty github idp_id")

    handle: str | None = None
    display_name: str | None = None
    avatar_url: str | None = None
    metadata: dict[str, Any] = {"idp_id": external_id, "source": "workos_sync"}

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"https://api.github.com/user/{external_id}",
                headers={
                    "Accept": "application/vnd.github+json",
                    "User-Agent": _GITHUB_USER_AGENT,
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            )
            if resp.status_code == 200:
                data = resp.json()
                if data.get("id") is not None:
                    external_id = str(data["id"])
                handle = data.get("login")
                display_name = data.get("name") or handle
                avatar_url = data.get("avatar_url")
                if data.get("html_url"):
                    metadata["html_url"] = data["html_url"]
            else:
                log.warning(
                    "connectors.github.resolve_failed id=%s status=%s",
                    external_id, resp.status_code,
                )
    except httpx.HTTPError as exc:
        log.warning(
            "connectors.github.resolve_error id=%s reason=%s",
            external_id, type(exc).__name__,
        )

    if not handle:
        handle = f"user:{external_id}"

    return ConnectorProfile(
        provider="github",
        external_id=external_id,
        handle=handle,
        display_name=display_name,
        avatar_url=avatar_url,
        metadata=metadata,
    )


async def profile_from_workos_identities(
    identities: list[Any],
) -> ConnectorProfile | None:
    """Build a GitHub :class:`ConnectorProfile` from WorkOS identities, or None."""
    identity = find_github_identity(identities)
    if identity is None:
        return None
    idp_id = identity_idp_id(identity)
    if not idp_id:
        return None
    return await resolve_github_profile(idp_id)
