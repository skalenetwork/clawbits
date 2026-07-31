"""Human connectors API — universal third-party identity links.

Stores profile metadata only (handle, external id). Never tokens.
GitHub is the first provider; Notion / Gmail light up via the registry.

GitHub connect:
  1. WorkOS identity sync when the user already signed in with GitHub.
  2. Else dedicated Clawbits GitHub OAuth App (``read:user``) — emails need
     not match; access token is discarded after fetching the profile.
"""
from __future__ import annotations

import logging
import secrets
import urllib.parse
from typing import Literal

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlmodel import Session

from clawbits.connectors.github import (
    GitHubConnectorNotConfigured,
    build_github_authorize_url,
    connector_oauth_redirect_uri,
    exchange_code_for_profile,
    github_connector_configured,
    profile_from_workos_identities,
)
from clawbits.connectors.registry import get_provider, list_providers
from clawbits.connectors.types import ConnectorProfile
from clawbits.db.table_read import TableRead
from clawbits.db.table_write import TableWrite
from clawbits.fastapi.session_cookie import (
    CONNECTOR_OAUTH_STATE_COOKIE,
    DEV_SESSION_COOKIE,
    SESSION_COOKIE,
    cookie_kwargs,
)
from clawbits.fastapi.workos_auth import (
    _client,
    _frontend_root,
    get_current_human_user,
)

log = logging.getLogger("clawbits.connectors")

connectors_router = APIRouter(tags=["Connectors"])

ConnectorStatus = Literal["connected", "available", "coming_soon"]


def _db(request: Request) -> Session:
    return Session(request.app._engine)


class ConnectorOut(BaseModel):
    provider: str
    label: str
    status: ConnectorStatus
    capabilities: list[str] = Field(default_factory=list)
    external_id: str | None = None
    handle: str | None = None
    display_name: str | None = None
    avatar_url: str | None = None
    connected_at: str | None = None


class ConnectorsListResponse(BaseModel):
    connectors: list[ConnectorOut]


class ConnectResponse(BaseModel):
    """Either already linked, or the client should navigate to ``url``."""

    status: Literal["connected", "redirect"]
    connector: ConnectorOut | None = None
    url: str | None = None


def _row_to_out(provider_id: str, row: dict | None) -> ConnectorOut:
    spec = get_provider(provider_id)
    label = spec.label if spec else provider_id
    capabilities = list(spec.capabilities) if spec else []
    if row is None:
        status: ConnectorStatus = (
            "coming_soon" if (spec and not spec.enabled) else "available"
        )
        return ConnectorOut(
            provider=provider_id,
            label=label,
            status=status,
            capabilities=capabilities,
        )
    return ConnectorOut(
        provider=provider_id,
        label=label,
        status="connected",
        capabilities=capabilities,
        external_id=row.get("external_id"),
        handle=row.get("handle"),
        display_name=row.get("display_name"),
        avatar_url=row.get("avatar_url"),
        connected_at=row.get("connected_at"),
    )


def _upsert_profile(
    db: Session, *, human_id: int, profile: ConnectorProfile,
) -> dict:
    try:
        TableWrite.upsert_human_connector(
            db,
            human_id=human_id,
            provider=profile.provider,
            external_id=profile.external_id,
            handle=profile.handle,
            display_name=profile.display_name,
            avatar_url=profile.avatar_url,
            provider_metadata=profile.metadata or None,
        )
    except ValueError as exc:
        msg = str(exc)
        if msg.startswith("connector_external_id_taken:"):
            raise HTTPException(
                status_code=409,
                detail="This account is already linked to another Clawbits user.",
            ) from exc
        raise
    db.commit()
    row = TableRead.get_human_connector(db, human_id, profile.provider)
    assert row is not None
    return row


def _workos_identities_list(raw: object) -> list:
    if hasattr(raw, "data"):
        return list(raw.data or [])
    if isinstance(raw, list):
        return raw
    return list(raw or [])  # type: ignore[arg-type]


async def sync_github_from_workos(
    request: Request, *, human_id: int, workos_user_id: str,
) -> dict | None:
    """Best-effort: if WorkOS has a GitHub identity, upsert the connector.

    Returns the connector row dict, or None when no GitHub identity exists.
    Swallows WorkOS / network errors so login is never blocked (unless the
    conflict is a hard 409 — that still raises).
    """
    try:
        identities = _workos_identities_list(
            _client(request).user_management.get_user_identities(
                workos_user_id,
            )
        )
        profile = await profile_from_workos_identities(identities)
        if profile is None:
            return None
        with _db(request) as db:
            return _upsert_profile(db, human_id=human_id, profile=profile)
    except HTTPException:
        raise
    except Exception:  # noqa: BLE001 — never break login
        log.warning(
            "connectors.github.sync_failed human_id=%s",
            human_id,
            exc_info=True,
        )
        return None


def _connectors_error_redirect(code: str) -> RedirectResponse:
    frontend = _frontend_root()
    return RedirectResponse(
        f"{frontend}/settings/connectors?error={urllib.parse.quote(code)}",
        status_code=302,
    )


@connectors_router.get(
    "/api/human/connectors", response_model=ConnectorsListResponse,
)
def list_connectors(
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> ConnectorsListResponse:
    """List every registered provider with connection status for the caller."""
    with _db(request) as db:
        rows = {
            r["provider"]: r
            for r in TableRead.get_human_connectors(db, int(user["id"]))
        }
    return ConnectorsListResponse(
        connectors=[
            _row_to_out(spec.id, rows.get(spec.id))
            for spec in list_providers()
        ],
    )


@connectors_router.post(
    "/api/human/connectors/{provider}/connect",
    response_model=ConnectResponse,
)
async def connect_provider(
    provider: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> ConnectResponse:
    """Connect a provider.

    Tries WorkOS identity sync first (no redirect). If missing, returns a
    redirect to the dedicated GitHub OAuth App link start (emails need not
    match the Clawbits login).
    """
    spec = get_provider(provider)
    if spec is None:
        raise HTTPException(status_code=404, detail="Unknown connector")
    if not spec.enabled:
        raise HTTPException(status_code=400, detail="Connector not available yet")

    human_id = int(user["id"])
    workos_user_id = str(user["workos_user_id"])

    if provider == "github":
        row = await sync_github_from_workos(
            request, human_id=human_id, workos_user_id=workos_user_id,
        )
        if row is not None:
            return ConnectResponse(
                status="connected",
                connector=_row_to_out("github", row),
            )
        if not github_connector_configured():
            raise HTTPException(
                status_code=503,
                detail="GitHub connector is not configured on this server.",
            )
        return ConnectResponse(
            status="redirect",
            url="/api/auth/connectors/github/link/start",
        )

    raise HTTPException(status_code=400, detail="Connect not implemented for provider")


@connectors_router.get("/api/auth/connectors/github/link/start")
def github_link_start(
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> RedirectResponse:
    """Start dedicated GitHub OAuth App link (not WorkOS login).

    State: ``ghlink.{human_id}.{csrf}``. Callback proves control of a GitHub
    account; Clawbits session is unchanged. Emails need not match.
    """
    try:
        if not github_connector_configured():
            raise GitHubConnectorNotConfigured("missing credentials")
    except GitHubConnectorNotConfigured as exc:
        raise HTTPException(
            status_code=503,
            detail="GitHub connector is not configured on this server.",
        ) from exc

    human_id = int(user["id"])
    state = f"ghlink.{human_id}.{secrets.token_urlsafe(24)}"
    auth_url = build_github_authorize_url(state=state)
    response = RedirectResponse(auth_url, status_code=302)
    response.set_cookie(
        key=CONNECTOR_OAUTH_STATE_COOKIE,
        value=state,
        max_age=600,
        **cookie_kwargs(),
    )
    return response


@connectors_router.get("/api/auth/connectors/github/callback")
async def github_link_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    connector_oauth_state: str | None = Cookie(
        default=None, alias=CONNECTOR_OAUTH_STATE_COOKIE,
    ),
) -> RedirectResponse:
    """OAuth callback for the Clawbits GitHub connector App.

    Exchanges ``code`` → profile, upserts ``human_connectors``, discards
    the access token. Does not touch the Clawbits / WorkOS session.
    """
    frontend = _frontend_root()

    def _done(resp: RedirectResponse) -> RedirectResponse:
        resp.delete_cookie(CONNECTOR_OAUTH_STATE_COOKIE, path="/")
        return resp

    if error:
        return _done(_connectors_error_redirect(f"github_oauth_{error}"))
    if not code or not state or state != connector_oauth_state:
        return _done(_connectors_error_redirect("oauth_state_mismatch"))

    parts = state.split(".", 2)  # ghlink, human_id, csrf
    if len(parts) != 3 or parts[0] != "ghlink" or not parts[1].isdigit():
        return _done(_connectors_error_redirect("oauth_state_mismatch"))
    link_human_id = int(parts[1])

    try:
        session_user = get_current_human_user(
            request,
            session_cookie=request.cookies.get(SESSION_COOKIE),
            dev_session_cookie=request.cookies.get(DEV_SESSION_COOKIE),
        )
    except HTTPException:
        return _done(RedirectResponse(
            f"{frontend}/login?error="
            + urllib.parse.quote("connector_link_requires_login"),
            status_code=302,
        ))

    if int(session_user["id"]) != link_human_id:
        return _done(_connectors_error_redirect("oauth_state_mismatch"))

    try:
        profile = await exchange_code_for_profile(
            code=code,
            redirect_uri=connector_oauth_redirect_uri(),
        )
    except GitHubConnectorNotConfigured:
        return _done(_connectors_error_redirect("github_not_configured"))
    except Exception:  # noqa: BLE001
        log.warning("connectors.github.oauth_exchange_failed", exc_info=True)
        return _done(_connectors_error_redirect("github_oauth_failed"))

    try:
        with _db(request) as db:
            _upsert_profile(db, human_id=link_human_id, profile=profile)
    except HTTPException as exc:
        if exc.status_code == 409:
            return _done(_connectors_error_redirect("github_already_linked"))
        raise

    return _done(RedirectResponse(
        f"{frontend}/settings/connectors?connected=github",
        status_code=302,
    ))


@connectors_router.delete(
    "/api/human/connectors/{provider}", status_code=204,
)
def disconnect_provider(
    provider: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> None:
    """Drop the connector row. Does not unlink the WorkOS login identity."""
    if get_provider(provider) is None:
        raise HTTPException(status_code=404, detail="Unknown connector")
    with _db(request) as db:
        TableWrite.delete_human_connector(
            db, human_id=int(user["id"]), provider=provider,
        )
        db.commit()
