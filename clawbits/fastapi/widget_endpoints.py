"""Chat widgets over HTTP: start one, act on it, and the org switch that allows them.

Widgets run in one-to-one chats for now: between people, or a person and an agent that may play.
An action is a row lock on the widget, a move validated by its kind (both in
:mod:`clawbits.widgets.service`), and a ``widget.updated`` carrying the fresh scene. Nothing posts:
only starting a widget writes a message, so a move never pings. A seated agent is woken instead,
with ids only, on its own control topic.
The chat's own switch lives on ``PATCH /api/human/mm/channels/{id}``.
"""
import asyncio
import logging
from collections.abc import Collection

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import Engine
from sqlmodel import Session, select

from clawbits import audit
from clawbits.datastructures.mm_models import MmPostResponse
from clawbits.datastructures.widget_models import (
    EndActiveWidgetsResponse,
    OrgWidgetsResponse,
    SetOrgWidgetsRequest,
    WidgetActionRequest,
    WidgetCreateRequest,
    WidgetListResponse,
    WidgetResponse,
)
from clawbits.db.models import MmChannel, MmPost, MmWidget
from clawbits.db.table_read import TableRead
from clawbits.db.table_write import TableWrite
from clawbits.fastapi.human_endpoints import (
    _get_db,
    _require_org_owner,
    _verify_org_membership,
)
from clawbits.fastapi.human_mm_endpoints import _require_human_member
from clawbits.fastapi.workos_auth import _frontend_root, get_current_human_user
from clawbits.realtime import (
    EventBus,
    fire_and_forget,
    get_bus,
    publish_agent_widget_turn,
    publish_channel_read,
    publish_org_updated,
    publish_post_created,
    publish_widget_turn,
    publish_widget_updated,
)
from clawbits.widgets import KINDS, limits
from clawbits.widgets import service as widget_service
from clawbits.widgets.service import Participant, WidgetError

log = logging.getLogger(__name__)

widget_router = APIRouter(tags=["Widgets"])


async def publish_widget(bus: EventBus, widget: dict) -> None:
    """The widget's fresh public scene to its chat, to each seated human whether it waits on them,
    and a wake to each seated agent, the one that just acted included, and when it ends.
    ``widget`` must be the public view (no viewer): a private kind's event tells clients to refetch."""
    await publish_widget_updated(bus, widget["channel_id"], WidgetResponse(**widget).model_dump())
    for seat in widget["seats"]:
        waiting = widget["status"] == "active" and seat["seat"] in widget["waiting_on"]
        if seat["human_id"] is not None:
            await publish_widget_turn(bus, seat["human_id"], widget, waiting)
        elif seat["agent_id"] is not None:
            await _wake_agent(bus, seat["agent_id"], widget, seat["seat"], waiting)


async def _wake_agent(bus: EventBus, agent_id: str, widget: dict, seat: str, waiting: bool) -> None:
    """Wake a seated agent: once per rev, within its daily budget, since each wake costs it a turn.
    A wake skipped or unheard is caught up from its channel list's ``widget_waiting``."""
    widget_id, rev = widget["widget_id"], widget["rev"]
    verdict = await asyncio.to_thread(limits.claim_wake, agent_id, widget_id, rev)
    if verdict == "over_budget":
        log.warning(
            "agent %s is past its daily widget wakes; widget %s rev %s not sent", agent_id, widget_id, rev
        )
    if verdict != "wake":
        return
    if await publish_agent_widget_turn(bus, agent_id, widget, seat, waiting) == 0:
        log.info("agent %s has no live socket for widget %s rev %s", agent_id, widget_id, rev)


async def publish_widgets(engine: Engine, widget_ids: Collection[str]) -> None:
    """:func:`publish_widget` for widgets changed outside an action (aborted, reaped, ended)."""
    if not widget_ids:
        return

    def load() -> list[dict]:
        with Session(engine) as db:
            return [w for widget_id in widget_ids if (w := TableRead.get_mm_widget(db, widget_id))]

    bus = get_bus()
    for widget in await asyncio.to_thread(load):
        await publish_widget(bus, widget)


def _limit(limit: limits.Limit, human_id: int) -> None:
    """429 once the person is past ``limit`` this minute, worded like the other rate limits."""
    if (retry := limits.retry_after(limit, human_id)) is not None:
        # The hint rides in the detail: the global HTTPException handler drops exc.headers.
        raise HTTPException(status_code=429, detail=f"Too many requests; retry in ~{retry}s")


def _http(e: WidgetError) -> HTTPException:
    """A refused widget call as these routes have always answered it."""
    return HTTPException(status_code=e.status_code, detail=e.detail)


@widget_router.post(
    "/api/human/mm/channels/{channel_id}/widgets", response_model=WidgetResponse, status_code=201
)
def create_widget(
    channel_id: str,
    body: WidgetCreateRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Start a widget in a one-to-one chat; the caller takes ``seat`` (random when omitted) and
    the other side (a person, or an agent that may play) the remaining one. Needs the org's and
    the chat's switches on, and no other active widget in the chat. Posts one message that shows
    it. An agent that can't play now is a 422 ``This agent can't play games``."""
    # Before the rate limit, as it always was: a malformed request costs no slot.
    if body.seat is not None and body.seat not in KINDS[body.kind].seats:
        raise HTTPException(status_code=422, detail=f"Unknown seat {body.seat!r}")
    _limit(limits.CREATE, user["id"])
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        try:
            created = widget_service.create(
                db, user["id"], channel_id, body.kind, body.seat, frontend_root=_frontend_root()
            )
        except WidgetError as e:
            raise _http(e) from e
        post_id = created.post_id
        post = MmPostResponse(**TableRead.hydrate_mm_posts(db, [db.get(MmPost, post_id)])[0])
        member_human_ids = TableRead.get_mm_channel_human_member_ids(db, channel_id)

    bus = get_bus()
    fire_and_forget(
        publish_post_created(bus, channel_id, post.model_dump(), member_human_ids=member_human_ids)
    )
    fire_and_forget(publish_channel_read(bus, user["id"], channel_id, post_id))
    fire_and_forget(publish_widget(bus, created.public))
    return WidgetResponse(**created.view)


@widget_router.get("/api/human/mm/channels/{channel_id}/widgets", response_model=WidgetListResponse)
def list_widgets(
    channel_id: str,
    request: Request,
    active: bool = True,
    user: dict = Depends(get_current_human_user),
):
    """The chat's widgets, newest first: the active one only, unless ``active=false``."""
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        widgets = TableRead.list_mm_widgets(db, channel_id, active_only=active, viewer_human_id=user["id"])
    return WidgetListResponse(widgets=[WidgetResponse(**w) for w in widgets])


@widget_router.get("/api/human/mm/widgets/{widget_id}", response_model=WidgetResponse)
def get_widget(widget_id: str, request: Request, user: dict = Depends(get_current_human_user)):
    """A widget in a chat the caller belongs to; any other is the same 404."""
    with _get_db(request) as db:
        widget = TableRead.get_mm_widget(db, widget_id, viewer_human_id=user["id"])
        if widget is None or not TableRead.is_mm_channel_member_human(
            db, widget["channel_id"], user["id"]
        ):
            raise HTTPException(status_code=404, detail="Widget not found")
    return WidgetResponse(**widget)


@widget_router.post("/api/human/mm/widgets/{widget_id}/actions", response_model=WidgetResponse)
def act_on_widget(
    widget_id: str,
    body: WidgetActionRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Apply one action by the caller's seat. ``expected_rev`` must be the current ``rev``, so
    an action taken on a stale board is a 409 rather than a surprise. ``end`` is the exception:
    any seated player stops the game with it, on any board, even with a switch off."""
    _limit(limits.HUMAN_ACT, user["id"])
    with _get_db(request) as db:
        try:
            result = widget_service.act(
                db,
                Participant.human(user["id"]),
                widget_id,
                body.action.model_dump(),
                body.expected_rev,
            )
        except WidgetError as e:
            raise _http(e) from e

    fire_and_forget(publish_widget(get_bus(), result.public))
    return WidgetResponse(**result.view)


@widget_router.get("/api/human/orgs/{org_id}/widgets", response_model=OrgWidgetsResponse)
def get_org_widgets(org_id: str, request: Request, user: dict = Depends(get_current_human_user)):
    """The org's widgets switch and how many widgets are active under it. Any member can read."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        org = TableRead.get_organization(db, org_id)
        if org is None:
            raise HTTPException(status_code=404, detail="Organization not found")
        return OrgWidgetsResponse(
            enabled=org["widgets_enabled"],
            active_count=TableRead.count_active_mm_widgets_in_org(db, org_id),
        )


@widget_router.put("/api/human/orgs/{org_id}/widgets", response_model=OrgWidgetsResponse)
def set_org_widgets(
    org_id: str,
    body: SetOrgWidgetsRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Turn widgets on or off for the org. Owner only. Off is a 409 while any widget is active:
    end them first (``POST .../widgets/end-active``)."""
    with _get_db(request) as db:
        _require_org_owner(db, org_id, user, "change widget settings")
        org = TableWrite.lock_organization(db, org_id)
        if org is None:
            raise HTTPException(status_code=404, detail="Organization not found")
        active = TableRead.count_active_mm_widgets_in_org(db, org_id)
        if not body.enabled and active:
            raise HTTPException(
                status_code=409,
                detail=f"{active} widget{'' if active == 1 else 's'} still active; end them first",
            )
        changed = org.widgets_enabled != body.enabled
        org.widgets_enabled = body.enabled
        workos_org_id = org.workos_org_id
        db.commit()
        member_ids = TableRead.get_org_member_human_ids(db, org_id) if changed else []

    bus = get_bus()
    for human_id in member_ids:
        fire_and_forget(
            publish_org_updated(bus, human_id, {"org_id": org_id, "widgets_enabled": body.enabled})
        )
    audit.widgets_updated(
        request, actor_user=user, workos_org_id=workos_org_id, enabled=body.enabled
    )
    return OrgWidgetsResponse(enabled=body.enabled, active_count=active)


@widget_router.post(
    "/api/human/orgs/{org_id}/widgets/end-active", response_model=EndActiveWidgetsResponse
)
def end_active_widgets(org_id: str, request: Request, user: dict = Depends(get_current_human_user)):
    """End every active widget in the org's chats, so its switch can turn off. Owner only."""
    with _get_db(request) as db:
        _require_org_owner(db, org_id, user, "end widgets")
        ended = TableWrite.abort_mm_widgets(
            db,
            "ended",
            MmWidget.channel_id.in_(select(MmChannel.channel_id).where(MmChannel.org_id == org_id)),
        )
        org = TableRead.get_organization(db, org_id)
        db.commit()

    fire_and_forget(publish_widgets(request.app._engine, [widget_id for widget_id, _ in ended]))
    audit.widgets_updated(
        request,
        actor_user=user,
        workos_org_id=(org or {}).get("workos_org_id", ""),
        ended=len(ended),
    )
    return EndActiveWidgetsResponse(ended=len(ended))
