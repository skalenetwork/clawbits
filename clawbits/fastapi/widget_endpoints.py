"""Chat widgets over HTTP: start one, act on it, and the org switch that allows them.

Widgets run in one-to-one chats between people for now. An action is a row lock on the widget,
a move validated by its kind (:mod:`clawbits.widgets`), and a ``widget.updated`` carrying the
fresh scene. Nothing posts: only starting a widget writes a message, so a move never pings.
The chat's own switch lives on ``PATCH /api/human/mm/channels/{id}``.
"""
import asyncio
import random
from collections.abc import Collection

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import Engine
from sqlalchemy.exc import IntegrityError
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
from clawbits.db.models import MmChannel, MmChannelMember, MmPost, MmWidget, MmWidgetSeat
from clawbits.db.table_read import TableRead
from clawbits.db.table_write import TableWrite
from clawbits.fastapi.human_endpoints import (
    _get_db,
    _rate_limit,
    _require_org_owner,
    _verify_org_membership,
)
from clawbits.fastapi.human_mm_endpoints import _require_human_member
from clawbits.fastapi.workos_auth import _frontend_root, get_current_human_user
from clawbits.realtime import (
    EventBus,
    fire_and_forget,
    get_bus,
    publish_channel_read,
    publish_org_updated,
    publish_post_created,
    publish_widget_turn,
    publish_widget_updated,
)
from clawbits.widgets import KINDS, InvalidAction, NotYourTurn

widget_router = APIRouter(tags=["Widgets"])

_CREATE_LIMIT = 10
_INTRO = {
    "chess": "♟ {name} started a chess game",
    "battleship": "⚓ {name} started a game of battleship",
    "poker": "♠ {name} started a poker match",
    "blackjack": "♣ {name} started a blackjack match",
}


async def publish_widget(bus: EventBus, widget: dict) -> None:
    """The widget's fresh public scene to its chat, and to each seated human whether it waits on them.
    ``widget`` must be the public view (no viewer): a private kind's event tells clients to refetch."""
    await publish_widget_updated(bus, widget["channel_id"], WidgetResponse(**widget).model_dump())
    for seat in widget["seats"]:
        if seat["human_id"] is not None:
            my_turn = widget["status"] == "active" and widget["turn"] == seat["seat"]
            await publish_widget_turn(bus, seat["human_id"], widget["channel_id"], my_turn)


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


def _dm_opponent(db: Session, channel: MmChannel, human_id: int) -> int:
    """The other person of a one-to-one chat between people: the only place widgets run for now."""
    members = db.exec(
        select(MmChannelMember.human_id, MmChannelMember.agent_id).where(
            MmChannelMember.channel_id == channel.channel_id
        )
    ).all()
    others = [h for h, _ in members if h is not None and h != human_id]
    if channel.channel_type != "direct" or any(a is not None for _, a in members) or len(others) != 1:
        raise HTTPException(
            status_code=422, detail="Widgets run in one-to-one chats between people for now"
        )
    return others[0]


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
    the other person the remaining one. Needs the org's and the chat's switches on, and no
    other active widget in the chat. Posts one message that shows it."""
    kind = KINDS[body.kind]
    if body.seat is not None and body.seat not in kind.seats:
        raise HTTPException(status_code=422, detail=f"Unknown seat {body.seat!r}")
    _rate_limit(f"widget-create:{user['id']}", limit=_CREATE_LIMIT)
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        # The chat locked, the org held: neither switch turns off between this check and the insert.
        channel = TableWrite.lock_mm_channel(db, channel_id)
        if channel is None:
            raise HTTPException(status_code=404, detail="Channel not found")
        org = TableWrite.lock_organization(db, channel.org_id, shared=True) if channel.org_id else None
        if org is None or not org.widgets_enabled:
            raise HTTPException(status_code=403, detail="Widgets are off in this organization")
        if not channel.widgets_enabled:
            raise HTTPException(status_code=403, detail="Widgets are off in this chat")
        opponent = _dm_opponent(db, channel, user["id"])
        mine = body.seat or random.choice(kind.seats)
        theirs = next(seat for seat in kind.seats if seat != mine)
        state = kind.init()
        try:
            widget_id = TableWrite.create_mm_widget(
                db,
                channel_id=channel_id,
                kind=body.kind,
                state=state,
                turn=kind.turn(state),
                seats={mine: user["id"], theirs: opponent},
                created_by_human_id=user["id"],
            )
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=409, detail="This chat already has an active widget")
        name = TableRead.resolve_human_display(db, user["id"]) or "Someone"
        message = f"{_INTRO[body.kind].format(name=name)} · {_frontend_root()}/widgets/{widget_id}"
        post_id = TableWrite.create_mm_post_human(db, channel_id, user["id"], message, widget_id=widget_id)
        TableWrite.mark_mm_channel_read(db, channel_id, user["id"], post_id)
        db.commit()
        widget = TableRead.get_mm_widget(db, widget_id, viewer_human_id=user["id"])
        public = TableRead.get_mm_widget(db, widget_id)
        post = MmPostResponse(**TableRead.hydrate_mm_posts(db, [db.get(MmPost, post_id)])[0])
        member_human_ids = TableRead.get_mm_channel_human_member_ids(db, channel_id)

    bus = get_bus()
    fire_and_forget(
        publish_post_created(bus, channel_id, post.model_dump(), member_human_ids=member_human_ids)
    )
    fire_and_forget(publish_channel_read(bus, user["id"], channel_id, post_id))
    fire_and_forget(publish_widget(bus, public))
    return WidgetResponse(**widget)


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
    an action taken on a stale board is a 409 rather than a surprise."""
    with _get_db(request) as db:
        widget = TableWrite.lock_mm_widget(db, widget_id)
        if widget is None or not TableRead.is_mm_channel_member_human(
            db, widget.channel_id, user["id"]
        ):
            raise HTTPException(status_code=404, detail="Widget not found")
        if widget.status != "active":
            raise HTTPException(status_code=409, detail="This widget has ended")
        if body.expected_rev != widget.rev:
            raise HTTPException(status_code=409, detail="The widget changed meanwhile; try again")
        seat = db.exec(
            select(MmWidgetSeat.seat)
            .where(MmWidgetSeat.widget_id == widget_id)
            .where(MmWidgetSeat.human_id == user["id"])
        ).first()
        if seat is None:
            raise HTTPException(status_code=403, detail="You don't have a seat in this widget")
        kind = KINDS.get(widget.kind)
        if kind is None:
            raise HTTPException(status_code=409, detail="This kind of widget is no longer available")
        try:
            step = kind.act(widget.state, seat, body.action.model_dump())
        except NotYourTurn as e:
            raise HTTPException(status_code=403, detail=str(e)) from e
        except InvalidAction as e:
            raise HTTPException(status_code=422, detail=str(e)) from e
        TableWrite.save_mm_widget_step(
            db,
            widget,
            state=step.state,
            status=step.status,
            outcome=step.outcome,
            turn=kind.turn(step.state),
        )
        db.commit()
        out = TableRead.get_mm_widget(db, widget_id, viewer_human_id=user["id"])
        public = TableRead.get_mm_widget(db, widget_id)

    fire_and_forget(publish_widget(get_bus(), public))
    return WidgetResponse(**out)


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
