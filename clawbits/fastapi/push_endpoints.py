"""Push-notification subscription endpoints.

Browser clients register their Web Push subscription here; the dispatcher
in :mod:`clawbits.realtime.web_push` sends to the stored devices when a post
is published. All endpoints require an authenticated human — subscriptions
are per-user, and a device row is owned by the human who registered it.

iOS/Android (APNs/FCM) will add sibling ``/api/push/{ios,android}/...``
routes later that write the same ``push_devices`` table with a different
transport.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlmodel import Session

from clawbits.db.table_write import TableWrite
from clawbits.fastapi.workos_auth import get_current_human_user
from clawbits.realtime.web_push import (
    MAX_ENDPOINT_LEN,
    validate_push_endpoint,
    vapid_configured,
    vapid_public_key,
)
from clawbits.ssrf import UnsafeHostError, redact_url

log = logging.getLogger(__name__)

push_router = APIRouter(tags=["Push"])


def _get_db(request: Request) -> Session:
    return Session(request.app._engine)


class _WebPushKeys(BaseModel):
    p256dh: str
    auth: str


class WebPushSubscribeRequest(BaseModel):
    # Shape mirrors the browser's ``PushSubscription.toJSON()`` so the client
    # can POST it verbatim. ``expirationTime`` (also in that object) is
    # ignored — pydantic drops unknown fields by default.
    #
    # ``endpoint`` is a URL the *server* later POSTs to, so it is bounded here
    # and vetted by ``validate_push_endpoint`` before it reaches the table.
    endpoint: str = Field(max_length=MAX_ENDPOINT_LEN)
    keys: _WebPushKeys


class WebPushUnsubscribeRequest(BaseModel):
    endpoint: str = Field(max_length=MAX_ENDPOINT_LEN)


@push_router.get("/api/push/vapid-public-key")
def get_vapid_public_key(user: dict = Depends(get_current_human_user)) -> dict:
    """The ``applicationServerKey`` the browser needs to subscribe.

    ``key`` is null when web push isn't configured server-side (no VAPID
    keys) — the client hides the enable-notifications affordance in that
    case rather than offering a button that can't work.
    """
    return {"key": vapid_public_key()}


@push_router.post("/api/push/web/subscribe")
def subscribe_web_push(
    body: WebPushSubscribeRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> dict:
    """Register (or refresh) this browser's Web Push subscription.

    404s when VAPID isn't configured: without keys nothing can ever be sent,
    so storing subscriptions would only accumulate unvetted rows. The client
    already hides the affordance in that case (``/api/push/vapid-public-key``
    returns null).
    """
    if not vapid_configured():
        raise HTTPException(status_code=404, detail="Web push is not configured")
    try:
        validate_push_endpoint(body.endpoint)
    except UnsafeHostError as exc:
        log.warning(
            "push subscribe refused for human %s: %s (%s)",
            user["id"],
            redact_url(body.endpoint),
            exc,
        )
        raise HTTPException(status_code=422, detail=f"Invalid push endpoint: {exc}") from exc
    user_agent = request.headers.get("user-agent")
    with _get_db(request) as db:
        TableWrite.upsert_webpush_device(
            db,
            human_id=int(user["id"]),
            token=body.endpoint,
            p256dh=body.keys.p256dh,
            auth=body.keys.auth,
            user_agent=user_agent,
            app="web",
        )
        db.commit()
    return {"ok": True}


@push_router.post("/api/push/web/unsubscribe")
def unsubscribe_web_push(
    body: WebPushUnsubscribeRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> dict:
    """Drop this browser's subscription (user turned notifications off, or
    the browser rotated the endpoint). Scoped to the caller's own rows.

    Not endpoint-validated: this only ever deletes, and a row stored before
    the validation landed must still be removable by its owner."""
    if not vapid_configured():
        raise HTTPException(status_code=404, detail="Web push is not configured")
    with _get_db(request) as db:
        TableWrite.delete_push_device_by_token(db, token=body.endpoint, human_id=int(user["id"]))
        db.commit()
    return {"ok": True}
