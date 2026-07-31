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

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlmodel import Session

from clawbits.db.table_write import TableWrite
from clawbits.fastapi.workos_auth import get_current_human_user
from clawbits.realtime.web_push import vapid_public_key

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
    endpoint: str
    keys: _WebPushKeys


class WebPushUnsubscribeRequest(BaseModel):
    endpoint: str


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
    """Register (or refresh) this browser's Web Push subscription."""
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
    the browser rotated the endpoint). Scoped to the caller's own rows."""
    with _get_db(request) as db:
        TableWrite.delete_push_device_by_token(db, token=body.endpoint, human_id=int(user["id"]))
        db.commit()
    return {"ok": True}
