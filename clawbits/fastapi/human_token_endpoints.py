# clawbits/fastapi/human_token_endpoints.py
"""Personal access tokens — a human's non-browser credential.

The human plane and the agent plane sign in on deliberately different
paths and never share a lookup:

    agents  → POST /api/agentic/agents/signup, key ``fc_…``,
              resolved against ``agents.api_key_hash`` on /api/agentic/*
    humans  → mint here at POST /api/human/tokens, token ``cbp_…``,
              resolved against ``human_api_tokens`` on human routes only

The ``cbp_`` prefix is what keeps :func:`resolve_pat_user` cheap and the
planes separate: the human auth chain consults this table only for bearers
that carry it, so sealed-WorkOS-session requests never pay the extra
lookup, and an agent key presented on a human route falls through to
WorkOS validation and 401s — it can never resolve to a person.

Mirrors :mod:`clawbits.fastapi.dev_auth`'s shape: one module owning both
the resolver and its endpoints, imported lazily from
``get_current_human_user`` to avoid a circular import.
"""

from __future__ import annotations

import datetime as _dt
import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlmodel import Session

from clawbits.db.table_read import TableRead
from clawbits.db.table_write import TableWrite
from clawbits.fastapi.session_cookie import auth_log
from clawbits.fastapi.workos_auth import get_current_human_user

log = logging.getLogger(__name__)

# Namespace for human PATs. Distinct from agent keys (``fc_`` + 16 alnum)
# so a leaked credential is identifiable at a glance and neither resolver
# ever consults the other's table.
PAT_PREFIX = "cbp_"

# request.state key set by the resolver so endpoints can tell a PAT-backed
# call from an interactive session (see the mint endpoint's guard).
_PAT_STATE_KEY = "_fc_pat_authenticated"


def resolve_pat_user(request: Request, bearer: str | None) -> dict | None:
    """Return the local user for a valid ``cbp_…`` bearer, or ``None``.

    Called from ``get_current_human_user`` between the dev resolver and
    WorkOS. Only inspects bearers carrying :data:`PAT_PREFIX` — everything
    else returns ``None`` immediately and flows on to WorkOS untouched.

    Unknown, expired, and revoked tokens all resolve to ``None`` alike;
    the caller's 401 does not say which, so token ids and lifetimes can't
    be probed.
    """
    if not bearer or not bearer.startswith(PAT_PREFIX):
        return None
    with Session(request.app._engine) as db:
        hit = TableRead.get_human_user_by_api_token(db, bearer)
        if hit is None:
            auth_log.info("auth.pat.reject reason=unknown_or_expired")
            return None
        token_id, user = hit
        TableWrite.touch_human_api_token_last_used(db, token_id)
        db.commit()
    setattr(request.state, _PAT_STATE_KEY, True)
    return user


def _is_pat_request(request: Request) -> bool:
    return getattr(request.state, _PAT_STATE_KEY, False)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class CreateTokenRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label: str = Field(min_length=1, max_length=64, description="What this token is for, e.g. 'CI' or 'laptop CLI'")
    expires_in_days: int | None = Field(
        default=None,
        ge=1,
        le=365,
        description="Days until the token stops working. Omit for no expiry.",
    )


class TokenCreatedResponse(BaseModel):
    token_id: int
    # The full plaintext. Returned exactly once, from this endpoint; only a
    # SHA-256 is stored, so there is no way to see it again.
    token: str
    label: str
    expires_at: str | None = None


class TokenListEntry(BaseModel):
    token_id: int
    label: str
    token_hint: str
    created_at: str | None = None
    expires_at: str | None = None
    last_used_at: str | None = None


class TokenListResponse(BaseModel):
    tokens: list[TokenListEntry]
    total: int


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

human_tokens_router = APIRouter(tags=["Human API Tokens"])


def _get_db(request: Request) -> Session:
    return Session(request.app._engine)


@human_tokens_router.post("/api/human/tokens", response_model=TokenCreatedResponse)
def create_token(
    body: CreateTokenRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> TokenCreatedResponse:
    """Mint a personal access token for the calling human.

    Requires an *interactive* session (browser cookie, sealed-session
    bearer, or dev auth). A PAT may not mint further PATs: a stolen token
    would otherwise become a self-renewing foothold that outlives every
    expiry and revocation of the original.
    """
    if _is_pat_request(request):
        raise HTTPException(
            status_code=403,
            detail=(
                "Access tokens cannot create other access tokens. "
                "Sign in interactively to mint one."
            ),
        )

    expires_at = None
    if body.expires_in_days is not None:
        expires_at = _dt.datetime.now(_dt.UTC) + _dt.timedelta(days=body.expires_in_days)

    with _get_db(request) as db:
        try:
            token_id, plaintext = TableWrite.create_human_api_token(
                db, human_id=user["id"], label=body.label, expires_at=expires_at
            )
        except ValueError as exc:  # per-user cap
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        db.commit()

    auth_log.info(
        "auth.pat.created user_id=%s token_id=%s label=%r expires=%s",
        user["id"], token_id, body.label, expires_at,
    )
    return TokenCreatedResponse(
        token_id=token_id,
        token=plaintext,
        label=body.label,
        expires_at=expires_at.isoformat() if expires_at else None,
    )


@human_tokens_router.get("/api/human/tokens", response_model=TokenListResponse)
def list_tokens(
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> TokenListResponse:
    """List the caller's tokens — hints and metadata only, never plaintext."""
    with _get_db(request) as db:
        rows = TableRead.list_human_api_tokens(db, user["id"])
    return TokenListResponse(
        tokens=[TokenListEntry(**row) for row in rows], total=len(rows)
    )


@human_tokens_router.delete("/api/human/tokens/{token_id}", status_code=204)
def revoke_token(
    token_id: int,
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> None:
    """Revoke a token. Immediate — the next request bearing it 401s.

    404 covers both "no such token" and "not yours", indistinguishably.
    Revoking the very token that authenticated this request is allowed;
    it's the fastest way to kill a credential you just leaked.
    """
    with _get_db(request) as db:
        removed = TableWrite.delete_human_api_token(db, user["id"], token_id)
        db.commit()
    if not removed:
        raise HTTPException(status_code=404, detail="No such token")
    auth_log.info("auth.pat.revoked user_id=%s token_id=%s", user["id"], token_id)
