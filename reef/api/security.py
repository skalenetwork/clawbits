"""Auth guard for the admin/fleet API.

Two doors, checked in order:

1. **Cloudflare Access** — human operators reach the dashboard through Cloudflare
   Access (SSO + MFA, WorkOS as the IdP). Cloudflare injects a signed
   ``Cf-Access-Jwt-Assertion``; we verify it (``reef.api.access``) and stash the
   operator's email on ``request.state.operator`` for audit. Enabled by the
   ``REEF_ACCESS_*`` env (see ``access``).
2. **Service token** — the clawbits→Reef machine path uses
   ``Authorization: Bearer <REEF_ADMIN_TOKEN>`` (mTLS is the planned hardening,
   docs/REEF.md §11).

When neither Access nor a token is configured the API is OPEN — fine for local
dev, never for a reachable deployment. Higher-stakes routes add
``require_configured_auth`` to refuse (503) in that configuration.
"""

import os
import secrets

from fastapi import Header, HTTPException, Request, status

from reef.api.access import AccessError, get_access_verifier


def admin_auth(
    request: Request,
    authorization: str | None = Header(default=None),
    cf_access_jwt: str | None = Header(default=None, alias="Cf-Access-Jwt-Assertion"),
) -> None:
    verifier = get_access_verifier()
    token = os.getenv("REEF_ADMIN_TOKEN")

    # 1) Human operator via Cloudflare Access.
    if verifier is not None and cf_access_jwt:
        try:
            claims = verifier.verify(cf_access_jwt)
        except AccessError:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="invalid Cloudflare Access assertion",
            )
        request.state.operator = claims.get("email") or claims.get("sub") or "access"
        return

    # 2) Machine path via the service token.
    if token:
        presented = ""
        if authorization and authorization.startswith("Bearer "):
            presented = authorization.removeprefix("Bearer ")
        if presented and secrets.compare_digest(presented, token):
            request.state.operator = "service-token"
            return

    # 3) Nothing valid presented: open only if nothing is configured (local dev).
    if verifier is None and not token:
        return
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="invalid or missing admin credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )


def require_configured_auth() -> None:
    """Refuse the route (503) when neither auth door is configured, instead of
    serving anonymously as ``admin_auth`` would. 503 and not 401 because there are
    no credentials the caller could present."""
    if get_access_verifier() is None and not os.getenv("REEF_ADMIN_TOKEN"):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "this reef has no admin auth configured, so the guest-env API is disabled; "
                "set REEF_ADMIN_TOKEN (or Cloudflare Access) and restart"
            ),
        )
