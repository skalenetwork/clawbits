"""Human messaging endpoints: JWT auth, no Proof-of-Cognition, no gas."""
import asyncio
import hashlib
import logging
import re
import time as _time
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from urllib.parse import quote

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from clawbits.cloudflare.r2_presign import R2Presigner
from clawbits.datastructures.agent_id import AgentId
from clawbits.datastructures.mm_models import (
    GlobalUserStatus,
    LinkPreviewRequest,
    LinkPreviewResponse,
    MmAddMemberUnifiedRequest,
    MmAdminChannelListResponse,
    MmAdminChannelResponse,
    MmChannelEventListResponse,
    MmChannelEventResponse,
    MmChannelExportResponse,
    MmChannelListResponse,
    MmChannelMemberResponse,
    MmChannelMembersListResponse,
    MmChannelResponse,
    MmDirectUnifiedRequest,
    MmDiscoverableChannelListResponse,
    MmDiscoverableChannelResponse,
    MmExportMember,
    MmFileConfirmRequest,
    MmFileDownloadUrlResponse,
    MmFileListResponse,
    MmFileResponse,
    MmFileUploadRequest,
    MmFileUploadResponse,
    MmHistoryRow,
    MmHumanCreateChannelRequest,
    MmLinkItem,
    MmLinkListResponse,
    MmMarkReadRequest,
    MmMarkReadResponse,
    MmMuteRequest,
    MmMuteResponse,
    MmPinnedListResponse,
    MmPinRequest,
    MmPinResponse,
    MmPostEditRequest,
    MmPostListResponse,
    MmPostRequest,
    MmPostResponse,
    MmReactionRequest,
    MmSearchResponse,
    MmSearchResult,
    MmTimelineResponse,
    MmUserPresenceRequest,
    MmUserPresenceResponse,
    agent_dm_channel_name,
)
from clawbits.db.models import MmChannel, MmPost
from clawbits.db.table_read import TableRead
from clawbits.db.table_write import TableWrite
from clawbits.fastapi.avatar_hooks import await_channel_avatar
from clawbits.fastapi.human_endpoints import _get_db
from clawbits.fastapi.mm_file_helpers import (
    build_file_response,
    build_object_key,
    cached_presigned_get,
    enrich_post_files_with_urls,
    is_mime_allowed,
    load_file_config,
    new_file_id,
    probe_image_dimensions,
    resolve_content_type,
)
from clawbits.fastapi.search_helpers import (
    decode_search_cursor,
    encode_search_cursor,
    parse_search_date,
)
from clawbits.fastapi.version_check import server_version
from clawbits.fastapi.workos_auth import get_current_human_user, revalidate_stream_credential
from clawbits.link_preview.extract import extract_urls
from clawbits.link_preview.service import get_link_preview
from clawbits.lobstertalk.attention import build_attention_context, consider_post
from clawbits.realtime import (
    MEMBERSHIP_RECHECK_TTL_SECONDS,
    EventBus,
    StreamClosed,
    build_presence_snapshot_event,
    fire_and_forget,
    get_bus,
    publish_agent_channel_added,
    publish_agent_channel_removed,
    publish_channel_added,
    publish_channel_event,
    publish_channel_muted,
    publish_channel_pinned,
    publish_channel_read,
    publish_channel_removed,
    publish_member_read,
    publish_member_removed,
    publish_member_status,
    publish_post_created,
    publish_post_deleted,
    publish_post_updated,
    publish_user_status,
    stream_channel_events,
    stream_human_events,
)
from clawbits.utils.parse import format_db_timestamp

_EMBED_PREVIEW_TIMEOUT_S = 2.5
_LINKS_SCAN_PAGE_MAX = 500
_LINKS_LIMIT_MAX = 100
_ATTACHMENTS_LIMIT_MAX = 200
_ALLOWED_ATTACHMENT_KINDS = {"image", "video", "media", "file", "all"}
MAX_EXPORT_POSTS = 20_000
MAX_EXPORT_EVENTS = 5_000
_EXPORT_PAGE = 500

log = logging.getLogger(__name__)

human_mm_router = APIRouter(tags=["Human Mattermost"])


def _require_human_member(db: Session, channel_id: str, human_id: int) -> None:
    """403 unless the caller is a member; an agent DM also needs the caller's ``can_dm``."""
    if not TableRead.is_mm_channel_member_human(db, channel_id, human_id):
        raise HTTPException(status_code=403, detail="Not a member of this channel")
    agent_id = TableRead.dm_agent_peer(db, channel_id)
    if agent_id and not TableRead.can_dm_agent(db, agent_id, human_id=human_id):
        raise HTTPException(status_code=403, detail="Not permitted to contact this agent")


def _require_channel_admin(db: Session, channel: dict, human_id: int, action: str) -> None:
    """The channel creator or an org owner: one authority for deleting a channel and for
    removing others, or any member could evict everyone and leave, deleting the channel."""
    org_id = channel["org_id"]
    if org_id is None:
        raise HTTPException(status_code=400, detail="Channel is not scoped to an organization")
    if (
        channel["created_by_human"] != human_id
        and TableRead.get_org_member_role(db, org_id, human_id) != "owner"
    ):
        raise HTTPException(
            status_code=403,
            detail=f"Only the channel creator or an organization admin can {action}",
        )


def _resolve_presence_view(
    user_row: dict | None, status: GlobalUserStatus
) -> tuple[GlobalUserStatus, str | None, str | None]:
    """``(status, last_seen_at, last_seen_label)`` as peers may see them under the user's
    privacy settings: a hidden status reads ``offline``, a hidden last-seen is bucketed."""
    if user_row is None:
        return status, None, None
    visible_status: GlobalUserStatus = (
        status if user_row.get("online_status_visible", True) else "offline"
    )
    if user_row.get("last_seen_visible", True):
        return visible_status, user_row.get("last_seen_at"), None
    return visible_status, None, _bucket_last_seen(user_row.get("last_seen_at"))


def _bucket_last_seen(ts: str | None) -> str:
    try:
        seen = datetime.fromisoformat(ts) if ts else None
    except ValueError:
        seen = None
    if seen is None:
        return "a long time ago"
    if seen.tzinfo is None:
        seen = seen.replace(tzinfo=UTC)
    days = (datetime.now(UTC) - seen).total_seconds() / 86400
    if days < 3:
        return "recently"
    if days < 7:
        return "within a week"
    if days < 30:
        return "within a month"
    return "a long time ago"


async def _present(members: list[dict], viewer_id: int | None) -> None:
    """Seed human members' presence under their privacy settings, and hide the read
    pointers of other members who turned read receipts off."""
    statuses = await get_bus().user_presence_get_many(
        [m["human_id"] for m in members if m["human_id"] is not None]
    )
    for m in members:
        if (human_id := m["human_id"]) is None:
            continue
        m["status"], m["last_seen_at"], m["last_seen_label"] = _resolve_presence_view(
            m, statuses[human_id]
        )
        if human_id != viewer_id and not m["read_receipts_enabled"]:
            m["last_read_post_id"] = None


async def _present_dm_peers(channels: list[dict]) -> None:
    await _present([c["dm_peer"] for c in channels if c.get("dm_peer")], viewer_id=None)


def _require_presigner(request: Request) -> R2Presigner:
    presigner = getattr(request.app, "_r2_presigner", None)
    if presigner is None:
        raise HTTPException(status_code=503, detail="File storage is not configured on this server")
    return presigner


def _with_file_urls(request: Request, posts: list[dict]) -> list[dict]:
    presigner = getattr(request.app, "_r2_presigner", None)
    cfg = load_file_config()
    for post in posts:
        enrich_post_files_with_urls(post, presigner, cfg)
    return posts


def _record_channel_event(
    db: Session, channel_id: str, event_type: str, **identities: int | str | None
) -> dict | None:
    """Insert a timeline event and return its response payload; ``None`` on a DM."""
    event_id = TableWrite.create_mm_channel_event(db, channel_id, event_type, **identities)
    event = TableRead.get_mm_channel_event_by_id(db, event_id) if event_id else None
    return MmChannelEventResponse(**event).model_dump() if event else None


def _rehydrate_post_response(db: Session, post_id: int) -> MmPostResponse:
    if (row := db.get(MmPost, post_id)) is None:
        raise HTTPException(status_code=500, detail="Failed to retrieve post")
    return MmPostResponse(**TableRead.hydrate_mm_posts(db, [row])[0])


def _mutate_post(
    request: Request, post_id: int, user: dict, mutate: Callable[[Session], object]
) -> MmPostResponse:
    """Membership-gated post mutation answering with, and fanning out, the full post."""
    with _get_db(request) as db:
        post = db.get(MmPost, post_id)
        if post is None:
            raise HTTPException(status_code=404, detail="Post not found")
        _require_human_member(db, post.channel_id, user["id"])
        try:
            mutate(db)
        except LookupError:
            raise HTTPException(status_code=404, detail="Post not found")
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        db.commit()
        response = _rehydrate_post_response(db, post_id)
    fire_and_forget(publish_post_updated(get_bus(), response.channel_id, response.model_dump()))
    return response


async def _resolve_embedded_link_preview(message: str) -> dict | None:
    """The card for the first URL in ``message``, or ``None`` when there is no URL, no title
    or image, or the unfurl overran its budget. Never raises."""
    if not (urls := extract_urls(message)):
        return None
    try:
        redis = await get_bus().redis_client()
        preview = await asyncio.wait_for(
            get_link_preview(redis, urls[0]), timeout=_EMBED_PREVIEW_TIMEOUT_S
        )
    except Exception:
        return None
    if preview.title is None and preview.image_url is None:
        return None
    return {**preview.__dict__, "skipped": len(urls) - 1}


async def _embed_link_preview(engine: Engine, post_id: int, message: str) -> None:
    if (preview := await _resolve_embedded_link_preview(message)) is None:
        return

    def store() -> MmPostResponse | None:
        with Session(engine) as db:
            if not TableWrite.set_mm_post_link_preview(db, post_id, message, preview):
                return None
            db.commit()
            return _rehydrate_post_response(db, post_id)

    if (post := await asyncio.to_thread(store)) is not None:
        await publish_post_updated(get_bus(), post.channel_id, post.model_dump())


async def _broadcast_offline_on_expiry(bus: EventBus, engine: Engine, human_id: int) -> None:
    """A presence key expired without a refresh (the tab died before its offline beacon):
    broadcast ``user.status`` once per cluster, unless a heartbeat brought the user back."""
    if not await bus.offline_broadcast_try_acquire(human_id):
        return
    if await bus.user_presence_get(human_id) != "offline":
        return

    def read() -> tuple[bool, str | None, list[str], list[int]]:
        with Session(engine) as db:
            u = TableRead.get_human_user_by_id(db, human_id)
            private = (
                u is not None and not u["online_status_visible"] and not u["last_seen_visible"]
            )
            if not private:
                TableWrite.touch_human_last_seen(db, human_id)
                db.commit()
                u = TableRead.get_human_user_by_id(db, human_id)
            return (
                private,
                u["last_seen_at"] if u else None,
                TableRead.get_mm_channel_ids_for_human(db, human_id),
                TableRead.get_fellow_human_ids(db, human_id),
            )

    private, last_seen_at, channel_ids, fellow_ids = await asyncio.to_thread(read)
    if private:
        await bus.user_presence_set(human_id, "idle")
    await publish_user_status(
        bus, human_id, "idle" if private else "offline", last_seen_at, channel_ids, fellow_ids
    )


async def user_presence_expiry_watcher(engine: Engine) -> None:
    """Bridge Redis keyspace expirations to ``user.status: offline``, once per worker.
    Exits quietly when keyspace notifications cannot be enabled."""
    bus = get_bus()
    if not await bus.enable_keyspace_notifications():
        log.warning(
            "user_presence_expiry_watcher: keyspace notifications unavailable; "
            "offline-on-silent-disconnect disabled"
        )
        return
    log.info("user_presence_expiry_watcher: started")
    try:
        async for key in bus.subscribe_expirations():
            human_id = EventBus.parse_user_presence_key(key)
            if human_id is None:
                continue
            try:
                await _broadcast_offline_on_expiry(bus, engine, human_id)
            except Exception as exc:
                log.warning("user_presence_expiry_watcher: handler failed for %s: %s", key, exc)
    except asyncio.CancelledError:
        log.info("user_presence_expiry_watcher: stopped")
        raise


@human_mm_router.post("/api/human/mm/channels", response_model=MmChannelResponse)
async def create_channel(
    body: MmHumanCreateChannelRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Create a channel in an organization the caller belongs to."""
    def create() -> tuple[MmChannelResponse, dict | None]:
        with _get_db(request) as db:
            if not TableRead.is_org_member(db, body.org_id, user["id"]):
                raise HTTPException(status_code=403, detail="Not a member of this organization")
            channel_id = str(uuid.uuid4())
            try:
                TableWrite.create_mm_channel(
                    db, channel_id, body.name, body.channel_type, body.display_name,
                    org_id=body.org_id, created_by_human=user["id"],
                )
                TableWrite.add_mm_channel_member_human(db, channel_id, user["id"])
                event = _record_channel_event(
                    db, channel_id, "member.added",
                    actor_human_id=user["id"], subject_human_id=user["id"],
                )
                db.commit()
            except IntegrityError:
                raise HTTPException(
                    status_code=409,
                    detail=f"A chat named \"{body.display_name or body.name}\" already exists",
                )
            return MmChannelResponse(**TableRead.get_mm_channel(db, channel_id)), event

    response, event = await asyncio.to_thread(create)
    if event is not None:
        fire_and_forget(
            publish_channel_event(
                get_bus(), response.channel_id, event, member_human_ids=[user["id"]]
            )
        )
    # Awaited: the client opens the channel at once, and the edge caches a 404 for a missing SVG.
    await await_channel_avatar(channel_id=response.channel_id, channel_type=body.channel_type)
    fire_and_forget(publish_channel_added(get_bus(), user["id"], response.model_dump()))
    return response


@human_mm_router.get("/api/human/mm/channels", response_model=MmChannelListResponse)
async def list_channels(
    request: Request,
    org_id: str | None = None,
    user: dict = Depends(get_current_human_user),
):
    """Channels the caller belongs to, scoped to ``org_id`` when given."""
    def load() -> list[dict]:
        with _get_db(request) as db:
            if org_id is not None and not TableRead.is_org_member(db, org_id, user["id"]):
                raise HTTPException(status_code=403, detail="Not a member of this organization")
            return TableRead.get_mm_channels_for_human(db, user["id"], org_id=org_id)

    channels = await asyncio.to_thread(load)
    await _present_dm_peers(channels)
    return MmChannelListResponse(
        channels=[MmChannelResponse(**c) for c in channels], total=len(channels)
    )


@human_mm_router.get(
    "/api/human/mm/channels/discoverable",
    response_model=MmDiscoverableChannelListResponse,
)
def list_discoverable_channels(
    request: Request,
    org_id: str,
    user: dict = Depends(get_current_human_user),
):
    """Public channels in ``org_id`` the caller has not joined yet."""
    with _get_db(request) as db:
        if not TableRead.is_org_member(db, org_id, user["id"]):
            raise HTTPException(status_code=403, detail="Not a member of this organization")
        channels = TableRead.get_discoverable_mm_channels(db, org_id, user["id"])
    return MmDiscoverableChannelListResponse(
        channels=[MmDiscoverableChannelResponse(**c) for c in channels], total=len(channels)
    )


@human_mm_router.get(
    "/api/human/mm/orgs/{org_id}/channels",
    response_model=MmAdminChannelListResponse,
)
def admin_list_org_channels(
    org_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Every public and private channel in ``org_id``, for its owners. DMs are excluded."""
    with _get_db(request) as db:
        if TableRead.get_org_member_role(db, org_id, user["id"]) != "owner":
            raise HTTPException(
                status_code=403, detail="Only organization admins can list all channels"
            )
        channels = TableRead.list_all_mm_channels_in_org(db, org_id, user["id"])
    return MmAdminChannelListResponse(
        channels=[MmAdminChannelResponse(**c) for c in channels], total=len(channels)
    )


@human_mm_router.post(
    "/api/human/mm/channels/{channel_id}/join",
    response_model=MmChannelResponse,
)
def join_channel(
    channel_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Self-join a public channel."""
    with _get_db(request) as db:
        ch = TableRead.get_mm_channel(db, channel_id)
        if ch is None:
            raise HTTPException(status_code=404, detail="Channel not found")
        if ch["channel_type"] != "public":
            raise HTTPException(status_code=403, detail="Channel is not joinable")
        if ch["org_id"] and not TableRead.is_org_member(db, ch["org_id"], user["id"]):
            raise HTTPException(status_code=403, detail="Not a member of this organization")
        if TableRead.is_mm_channel_member_human(db, channel_id, user["id"]):
            return MmChannelResponse(**ch)
        try:
            TableWrite.add_mm_channel_member_human(db, channel_id, user["id"])
            event = _record_channel_event(
                db, channel_id, "member.added",
                actor_human_id=user["id"], subject_human_id=user["id"],
            )
            member_human_ids = TableRead.get_mm_channel_human_member_ids(db, channel_id)
            db.commit()
        except ValueError as e:
            raise HTTPException(status_code=409, detail=str(e)) from e

    response = MmChannelResponse(**ch)
    fire_and_forget(publish_channel_added(get_bus(), user["id"], response.model_dump()))
    if event is not None:
        fire_and_forget(
            publish_channel_event(get_bus(), channel_id, event, member_human_ids=member_human_ids)
        )
    return response


@human_mm_router.get("/api/human/mm/channels/{channel_id}", response_model=MmChannelResponse)
async def get_channel(
    channel_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Channel info. Caller must be a member."""
    def load() -> dict:
        with _get_db(request) as db:
            _require_human_member(db, channel_id, user["id"])
            ch = TableRead.get_mm_channel(db, channel_id)
            if ch is None:
                raise HTTPException(status_code=404, detail="Channel not found")
            TableRead.apply_dm_peers(db, [ch], user["id"])
            return ch

    ch = await asyncio.to_thread(load)
    await _present_dm_peers([ch])
    return MmChannelResponse(**ch)


@human_mm_router.delete(
    "/api/human/mm/channels/{channel_id}",
    status_code=204,
    response_class=Response,
)
def admin_delete_channel(
    channel_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Hard-delete a channel with all its posts, files and members. The creator or an org
    owner only; a DM is torn down by its last human leaving instead."""
    with _get_db(request) as db:
        channel = TableRead.get_mm_channel(db, channel_id)
        if channel is None:
            raise HTTPException(status_code=404, detail="Channel not found")
        if channel["channel_type"] == "direct":
            raise HTTPException(
                status_code=400, detail="Direct message channels cannot be deleted this way"
            )
        _require_channel_admin(db, channel, user["id"], "delete it")
        agent_ids = [
            m["agent_id"]
            for m in TableRead.get_mm_channel_members(db, channel_id)
            if m["agent_id"] is not None
        ]
        result = TableWrite.delete_mm_channel(db, channel_id)
        db.commit()

    if result is not None:
        bus = get_bus()
        for human_id in result["human_member_ids"]:
            fire_and_forget(publish_member_removed(bus, channel_id, human_id=human_id))
            fire_and_forget(publish_channel_removed(bus, human_id, channel_id))
        for agent_id in agent_ids:
            fire_and_forget(publish_member_removed(bus, channel_id, agent_id=agent_id))
            fire_and_forget(publish_agent_channel_removed(bus, agent_id, channel_id))
    return Response(status_code=204)


@human_mm_router.post(
    "/api/human/mm/channels/{channel_id}/members",
    response_model=MmChannelMembersListResponse,
)
def add_member(
    channel_id: str,
    body: MmAddMemberUnifiedRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Add an agent or a human of the channel's org. Caller must be a member."""
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        ch = TableRead.get_mm_channel(db, channel_id)
        if ch is None:
            raise HTTPException(status_code=404, detail="Channel not found")
        if ch["channel_type"] == "direct":
            raise HTTPException(
                status_code=400, detail="Cannot add members to a direct message channel"
            )
        added_human_id: int | None = None
        try:
            if body.member_type == "agent":
                if TableRead.get_agent_by_agentid(db, AgentId(body.member_id)) is None:
                    raise HTTPException(
                        status_code=404, detail=f"Agent '{body.member_id}' not found"
                    )
                # can_tag is a contact grant, not org membership: without this check an
                # operator could pull their agent into another org's channel and read it.
                if ch["org_id"] and TableRead.get_agent_org_id(db, body.member_id) != ch["org_id"]:
                    raise HTTPException(
                        status_code=403, detail="Agent does not belong to this organization"
                    )
                if not TableRead.can_tag_agent(db, body.member_id, human_id=user["id"]):
                    raise HTTPException(
                        status_code=403, detail=f"Not permitted to add agent '{body.member_id}'"
                    )
                TableWrite.add_mm_channel_member(db, channel_id, body.member_id)
            else:
                added_human_id = int(body.member_id)
                if TableRead.get_human_user_by_id(db, added_human_id) is None:
                    raise HTTPException(
                        status_code=404, detail=f"Human user '{body.member_id}' not found"
                    )
                if ch["org_id"] and not TableRead.is_org_member(db, ch["org_id"], added_human_id):
                    raise HTTPException(
                        status_code=403,
                        detail="Target user is not a member of this organization",
                    )
                TableWrite.add_mm_channel_member_human(db, channel_id, added_human_id)
        except ValueError as e:
            raise HTTPException(status_code=409, detail=str(e)) from e
        event = _record_channel_event(
            db, channel_id, "member.added",
            actor_human_id=user["id"],
            subject_human_id=added_human_id,
            subject_agent_id=body.member_id if added_human_id is None else None,
        )
        members = TableRead.get_mm_channel_members(db, channel_id)
        db.commit()

    channel_payload = MmChannelResponse(**ch).model_dump()
    bus = get_bus()
    if added_human_id is not None:
        fire_and_forget(publish_channel_added(bus, added_human_id, channel_payload))
    else:
        fire_and_forget(publish_agent_channel_added(bus, body.member_id, channel_payload))
    if event is not None:
        fire_and_forget(
            publish_channel_event(
                bus, channel_id, event,
                member_human_ids=[m["human_id"] for m in members if m["human_id"] is not None],
            )
        )
    return MmChannelMembersListResponse(
        members=[MmChannelMemberResponse(**m) for m in members], total=len(members)
    )


@human_mm_router.delete(
    "/api/human/mm/channels/{channel_id}/members/{member_id}",
    response_model=MmChannelMembersListResponse,
)
def remove_member(
    channel_id: str,
    member_id: str,
    request: Request,
    member_type: str = "agent",
    user: dict = Depends(get_current_human_user),
):
    """Remove a member; ``?member_type=human`` for a human.

    Leaving needs only membership. Removing someone else needs the channel creator or an
    org owner, and is never allowed on the other party of a DM. A removal that leaves no
    human hard-deletes the channel and reports ``channel_deleted``."""
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        channel = TableRead.get_mm_channel(db, channel_id)
        if channel is None:
            raise HTTPException(status_code=404, detail="Channel not found")
        removed_human_id = int(member_id) if member_type == "human" else None
        removed_agent_id = None if member_type == "human" else member_id
        if removed_human_id != user["id"]:
            if channel["channel_type"] == "direct":
                raise HTTPException(
                    status_code=400,
                    detail="Cannot remove the other party from a direct message channel",
                )
            _require_channel_admin(db, channel, user["id"], "remove other members")
        if removed_human_id is not None:
            TableWrite.remove_mm_channel_member_human(db, channel_id, removed_human_id)
        else:
            TableWrite.remove_mm_channel_member(db, channel_id, member_id)

        members = TableRead.get_mm_channel_members(db, channel_id)
        remaining_human_ids = [m["human_id"] for m in members if m["human_id"] is not None]
        channel_deleted = removed_human_id is not None and not remaining_human_ids
        orphaned_agent_ids: list[str] = []
        event: dict | None = None
        if channel_deleted:
            orphaned_agent_ids = [m["agent_id"] for m in members if m["agent_id"] is not None]
            TableWrite.delete_mm_channel(db, channel_id)
            members = []
        else:
            event = _record_channel_event(
                db, channel_id, "member.removed",
                actor_human_id=user["id"],
                subject_human_id=removed_human_id,
                subject_agent_id=removed_agent_id,
            )
        db.commit()

    bus = get_bus()
    # On the channel topic, so a live stream is cut off now rather than at its next re-check.
    fire_and_forget(
        publish_member_removed(bus, channel_id, human_id=removed_human_id, agent_id=removed_agent_id)
    )
    if removed_human_id is not None:
        fire_and_forget(publish_channel_removed(bus, removed_human_id, channel_id))
    else:
        fire_and_forget(publish_agent_channel_removed(bus, member_id, channel_id))
    for agent_id in orphaned_agent_ids:
        fire_and_forget(publish_member_removed(bus, channel_id, agent_id=agent_id))
        fire_and_forget(publish_agent_channel_removed(bus, agent_id, channel_id))
    if event is not None:
        fire_and_forget(
            publish_channel_event(bus, channel_id, event, member_human_ids=remaining_human_ids)
        )
    return MmChannelMembersListResponse(
        members=[MmChannelMemberResponse(**m) for m in members],
        total=len(members),
        channel_deleted=channel_deleted,
    )


@human_mm_router.get(
    "/api/human/mm/channels/{channel_id}/members",
    response_model=MmChannelMembersListResponse,
)
async def list_members(
    channel_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Channel members with presence seeded from Redis and, for agents, whether the caller
    may ``@``-tag them. Caller must be a member."""
    caller_id = user["id"]

    def load() -> list[dict]:
        with _get_db(request) as db:
            _require_human_member(db, channel_id, caller_id)
            members = TableRead.get_mm_channel_members(db, channel_id)
            taggable = TableRead.taggable_agent_ids(
                db, [m["agent_id"] for m in members if m["agent_id"] is not None], human_id=caller_id
            )
            for m in members:
                if m["agent_id"] is not None:
                    m["can_tag"] = m["agent_id"] in taggable
            return members

    members = await asyncio.to_thread(load)
    await _present(members, viewer_id=caller_id)
    return MmChannelMembersListResponse(
        members=[MmChannelMemberResponse(**m) for m in members], total=len(members)
    )


def _create_usage_reply(
    db: Session, channel_id: str, parent_post_id: int, trace_id: str | None
) -> int | None:
    """Answer ``/cb-usage`` in a DM with the agent's CB_TOKENS balance as a threaded reply.
    ``None`` outside a DM with an agent; a failed balance read still replies."""
    channel = db.get(MmChannel, channel_id)
    if channel is None or channel.channel_type != "direct":
        return None
    agent_id = next(
        (m["agent_id"] for m in TableRead.get_mm_channel_members(db, channel_id) if m["agent_id"]),
        None,
    )
    if agent_id is None:
        return None
    try:
        reply = f"CB_TOKENS remaining: {TableRead.get_cb_tokens(db, AgentId(agent_id)):,}"
    except Exception as e:
        log.exception("/cb-usage balance lookup failed: %s", e)
        reply = "Usage unavailable right now — couldn't read the CB_TOKENS balance."
    return TableWrite.create_mm_post(
        db, channel_id, agent_id, reply, parent_post_id=parent_post_id, trace_id=trace_id
    )


@human_mm_router.post("/api/human/mm/channels/{channel_id}/posts", response_model=MmPostResponse)
def create_post(
    channel_id: str,
    body: MmPostRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Post to a channel the caller belongs to. ``@``-tags are limited to agents the caller
    may contact; a permitted post publishes immediately. The link preview follows as a
    ``post.updated`` once it resolves."""
    if body.status != "published":
        raise HTTPException(status_code=400, detail="Human users may only create published posts")
    cfg = load_file_config()
    if len(body.file_ids) > cfg.max_per_post:
        raise HTTPException(
            status_code=400,
            detail=f"Too many files: {len(body.file_ids)} (max {cfg.max_per_post})",
        )

    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        for agent_id in TableRead.find_tagged_agents_in_channel(db, channel_id, body.message):
            if not TableRead.can_tag_agent(db, agent_id, human_id=user["id"]):
                raise HTTPException(
                    status_code=403, detail=f"Not permitted to tag agent '{agent_id}'"
                )
        try:
            post_id = TableWrite.create_mm_post_human(
                db, channel_id, user["id"], body.message,
                status="published",
                parent_post_id=body.parent_post_id,
                trace_id=body.trace_id,
            )
            if body.file_ids:
                TableWrite.attach_files_to_post(
                    db, post_id, body.file_ids, channel_id, uploader_human_id=user["id"]
                )
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        TableWrite.mark_mm_channel_read(db, channel_id, user["id"], post_id)
        usage_reply_id = (
            _create_usage_reply(db, channel_id, post_id, body.trace_id)
            if body.message.strip().lower() == "/cb-usage"
            else None
        )
        db.commit()

        ids = [post_id] if usage_reply_id is None else [post_id, usage_reply_id]
        post, *usage_replies = TableRead.hydrate_mm_posts(
            db, db.exec(select(MmPost).where(MmPost.post_id.in_(ids)).order_by(MmPost.post_id)).all()
        )
        response = MmPostResponse(
            **_with_file_urls(request, [post])[0], client_msg_uuid=body.client_msg_uuid
        )
        member_human_ids = TableRead.get_mm_channel_human_member_ids(db, channel_id)
        attention_ctx = build_attention_context(db, channel_id)

    bus = get_bus()
    fire_and_forget(
        publish_post_created(
            bus, channel_id, response.model_dump(), member_human_ids=member_human_ids
        )
    )
    if attention_ctx is not None:
        fire_and_forget(
            consider_post(
                post=response.model_dump(),
                channel_id=channel_id,
                context=attention_ctx,
                author_agent_id=None,
                engine=request.app._engine,
            )
        )
    for usage_reply in usage_replies:
        fire_and_forget(
            publish_post_created(
                bus, channel_id, MmPostResponse(**usage_reply).model_dump(),
                member_human_ids=member_human_ids,
            )
        )
    fire_and_forget(publish_channel_read(bus, user["id"], channel_id, post_id))
    fire_and_forget(bus.presence_clear(channel_id, "human", user["id"]))
    fire_and_forget(_embed_link_preview(request.app._engine, post_id, body.message))
    return response


@human_mm_router.get("/api/human/mm/channels/{channel_id}/posts")
def list_posts(
    channel_id: str,
    request: Request,
    limit: int = 50,
    offset: int = 0,
    before_post_id: int | None = None,
    after_post_id: int | None = None,
    if_none_match: str | None = Header(default=None),
    user: dict = Depends(get_current_human_user),
):
    """Channel posts, newest first. ``before_post_id`` pages older history; ``after_post_id``
    pages newer posts from an anchored window (jump to pin, deep link). Drafts and rejected
    posts show only to their author or the agent's operator.

    The response carries an ETag of its body; a matching ``If-None-Match`` gets an empty 304.
    Validation lives in the app because the cache middleware sets ``no-store``."""
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        posts = _with_file_urls(
            request,
            TableRead.get_mm_posts_for_human(
                db, channel_id, user["id"], limit, offset, before_post_id,
                after_post_id=after_post_id,
            ),
        )
    body = MmPostListResponse(
        posts=[MmPostResponse(**p) for p in posts], total=len(posts), limit=limit, offset=offset
    ).model_dump_json().encode()
    etag = f'"{hashlib.md5(body).hexdigest()}"'
    if if_none_match == etag:
        return Response(status_code=304, headers={"ETag": etag})
    return Response(body, media_type="application/json", headers={"ETag": etag})


@human_mm_router.get("/api/human/mm/search", response_model=MmSearchResponse)
def search_messages(
    request: Request,
    q: str = "",
    org_id: str | None = None,
    channel_id: str | None = None,
    sort: str = "recent",
    cursor: str | None = None,
    limit: int = 25,
    from_human_id: int | None = None,
    from_agent_id: str | None = None,
    before: str | None = None,
    after: str | None = None,
    has_link: bool = False,
    has_file: bool = False,
    user: dict = Depends(get_current_human_user),
):
    """Full-text search over published plaintext posts in the caller's channels, optionally
    narrowed to ``org_id`` or one ``channel_id``. Operators: ``from_human_id`` /
    ``from_agent_id``, ``before`` / ``after`` (``YYYY-MM-DD``), ``has_link`` / ``has_file``.
    ``sort`` is ``recent`` or ``relevant``; ``cursor`` is the previous ``next_cursor``. A
    blank query returns nothing unless a filter is set."""
    sort = sort if sort in ("recent", "relevant") else "recent"
    limit = max(1, min(limit, 50))
    with _get_db(request) as db:
        if org_id is not None and not TableRead.is_org_member(db, org_id, user["id"]):
            raise HTTPException(status_code=403, detail="Not a member of this organization")
        if channel_id is not None:
            _require_human_member(db, channel_id, user["id"])
        results, next_cursor = TableRead.search_mm_posts_for_human(
            db,
            user["id"],
            q,
            org_id=org_id,
            channel_id=channel_id,
            sort=sort,
            limit=limit,
            cursor=decode_search_cursor(cursor),
            from_human_id=from_human_id,
            from_agent_id=from_agent_id,
            before=parse_search_date(before),
            after=parse_search_date(after),
            has_link=has_link,
            has_file=has_file,
        )
    return MmSearchResponse(
        results=[MmSearchResult(**r) for r in results],
        next_cursor=encode_search_cursor(next_cursor),
        query=q,
        sort=sort,
    )


@human_mm_router.get(
    "/api/human/mm/channels/{channel_id}/posts/around/{post_id}",
    response_model=MmPostListResponse,
)
def list_posts_around(
    channel_id: str,
    post_id: int,
    request: Request,
    radius: int = 25,
    user: dict = Depends(get_current_human_user),
):
    """Up to ``radius`` posts either side of ``post_id``, newest first, with the history
    endpoint's visibility, so a search hit opens in context."""
    radius = max(1, min(radius, 50))
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        posts = _with_file_urls(
            request,
            TableRead.get_mm_posts_around_for_human(db, channel_id, user["id"], post_id, radius),
        )
    return MmPostListResponse(
        posts=[MmPostResponse(**p) for p in posts], total=len(posts), limit=radius, offset=0
    )


@human_mm_router.get(
    "/api/human/mm/channels/{channel_id}/timeline",
    response_model=MmTimelineResponse,
)
def list_timeline(
    channel_id: str,
    request: Request,
    limit: int = 50,
    before_created_at: str | None = None,
    user: dict = Depends(get_current_human_user),
):
    """Posts and inline channel events merged newest first. Pass ``next_cursor`` back
    verbatim as ``before_created_at``."""
    try:
        cursor = datetime.fromisoformat(before_created_at) if before_created_at else None
    except ValueError as e:
        raise HTTPException(status_code=400, detail="invalid before_created_at") from e
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        posts = _with_file_urls(
            request,
            TableRead.get_mm_posts_for_human(
                db, channel_id, user["id"], limit=limit + 1, before_created_at=cursor
            ),
        )
        events = TableRead.get_mm_channel_events(
            db, channel_id, limit=limit + 1, before_created_at=cursor
        )

    rows = sorted(
        [
            (p["_raw_created_at"], p["post_id"], MmHistoryRow(kind="post", post=MmPostResponse(**p)))
            for p in posts
        ]
        + [
            (
                e["_raw_created_at"],
                e["event_id"],
                MmHistoryRow(kind="event", event=MmChannelEventResponse(**e)),
            )
            for e in events
        ],
        key=lambda r: r[:2],
        reverse=True,
    )
    page, has_more = rows[:limit], len(rows) > limit
    if has_more:
        # The cursor is a timestamp, so end the page before a tie group it would split.
        page = [r for r in page if r[0] != rows[limit][0]] or page
    return MmTimelineResponse(
        rows=[row for *_, row in page],
        has_more=has_more,
        next_cursor=page[-1][0].isoformat() if has_more and page else None,
    )


@human_mm_router.get(
    "/api/human/mm/channels/{channel_id}/inline-events",
    response_model=MmChannelEventListResponse,
)
def list_channel_events(
    channel_id: str,
    request: Request,
    limit: int = 100,
    user: dict = Depends(get_current_human_user),
):
    """Inline channel events, newest first. Caller must be a member."""
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        events = TableRead.get_mm_channel_events(db, channel_id, limit=limit)
    return MmChannelEventListResponse(
        events=[MmChannelEventResponse(**e) for e in events], total=len(events)
    )


def _export_disposition(channel: dict) -> str:
    """RFC 6266 attachment header. The user-controlled channel name has every character but
    alphanumerics, ``-`` and ``_`` folded to ``-``: ASCII ones only in the ``filename``
    fallback, any in ``filename*`` as percent-encoded UTF-8, so a non-latin name survives."""
    raw = channel.get("display_name") or channel.get("name") or ""
    date = datetime.now(UTC).date().isoformat()

    def filename(keep: Callable[[str], bool]) -> str:
        slug = re.sub("-+", "-", "".join(c if keep(c) or c in "-_" else "-" for c in raw))
        return f"clawbits-{slug.strip('-')[:60] or channel['channel_id']}-{date}.json"

    fallback = filename(lambda c: c.isascii() and c.isalnum())
    encoded = quote(filename(str.isalnum), safe="")
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{encoded}"


@human_mm_router.get(
    "/api/human/mm/channels/{channel_id}/export",
    response_model=MmChannelExportResponse,
)
def export_channel(
    channel_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """The caller's view of one conversation as a JSON attachment: posts and events
    oldest-first, attachments as metadata only, at most ``MAX_EXPORT_POSTS`` posts with
    ``truncated`` set when older ones exist."""
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        channel = TableRead.get_mm_channel(db, channel_id)
        if channel is None:
            raise HTTPException(status_code=404, detail="Channel not found")
        members = TableRead.get_mm_channel_members(db, channel_id)
        events = TableRead.get_mm_channel_events(db, channel_id, limit=MAX_EXPORT_EVENTS)
        posts: list[dict] = []
        truncated = False
        cursor: int | None = None
        while page := TableRead.get_mm_posts_for_human(
            db, channel_id, user["id"], limit=_EXPORT_PAGE, before_post_id=cursor
        ):
            posts.extend(page)
            cursor = page[-1]["post_id"]
            if len(posts) >= MAX_EXPORT_POSTS:
                # Probe before trimming: landing exactly on the cap is only a truncation if
                # an older post exists, and the trim may pull ``cursor`` back.
                truncated = len(posts) > MAX_EXPORT_POSTS or bool(
                    TableRead.get_mm_posts_for_human(
                        db, channel_id, user["id"], limit=1, before_post_id=cursor
                    )
                )
                del posts[MAX_EXPORT_POSTS:]
                break

    body = MmChannelExportResponse(
        exported_at=format_db_timestamp(datetime.now(UTC)),
        exported_by_human_id=user["id"],
        channel=MmChannelResponse(**channel),
        members=[MmExportMember(**m) for m in members],
        posts=[MmPostResponse(**p) for p in reversed(posts)],
        events=[MmChannelEventResponse(**e) for e in reversed(events)],
        post_count=len(posts),
        truncated=truncated,
    )
    return Response(
        body.model_dump_json(),
        media_type="application/json",
        headers={"Content-Disposition": _export_disposition(channel)},
    )


@human_mm_router.get(
    "/api/human/mm/channels/{channel_id}/attachments",
    response_model=MmFileListResponse,
)
def list_channel_attachments(
    channel_id: str,
    request: Request,
    kind: str = "media",
    content_type: str | None = None,
    limit: int = 50,
    before_file_id: str | None = None,
    offset: int = 0,
    include_total: bool = False,
    user: dict = Depends(get_current_human_user),
):
    """Uploaded attachments in a channel, newest first.

    ``kind`` is ``image``, ``video``, ``media`` (both, the default), ``file`` (neither) or
    ``all``; ``content_type`` (an exact MIME, or a ``type/`` prefix) wins over it. Page with
    ``before_file_id`` set to the previous ``next_cursor``; ``offset`` also works but slows
    with depth. ``include_total`` adds a count, meant for the first page only. Thumbnails are
    presigned for images and videos; the full ``download_url`` is inlined for images only."""
    if kind not in _ALLOWED_ATTACHMENT_KINDS:
        raise HTTPException(
            status_code=422, detail=f"kind must be one of {sorted(_ALLOWED_ATTACHMENT_KINDS)}"
        )
    if content_type is not None and not content_type.strip():
        raise HTTPException(status_code=422, detail="content_type must be non-empty when provided")
    if limit < 1 or limit > _ATTACHMENTS_LIMIT_MAX:
        raise HTTPException(
            status_code=422, detail=f"limit must be between 1 and {_ATTACHMENTS_LIMIT_MAX}"
        )
    if offset < 0:
        raise HTTPException(status_code=422, detail="offset must be non-negative")

    presigner = getattr(request.app, "_r2_presigner", None)
    ttl = load_file_config().download_url_ttl
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        before_cursor = None
        if before_file_id is not None:
            cursor_row = TableRead.get_mm_file(db, before_file_id)
            if cursor_row is None or cursor_row.channel_id != channel_id:
                raise HTTPException(
                    status_code=422,
                    detail="before_file_id does not match a file in this channel",
                )
            before_cursor = (cursor_row.created_at, cursor_row.file_id)
        try:
            rows = TableRead.get_mm_files_for_channel(
                db, channel_id,
                kind=kind, content_type=content_type,
                limit=limit, offset=offset, before_cursor=before_cursor,
            )
            total = (
                TableRead.count_mm_files_for_channel(
                    db, channel_id, kind=kind, content_type=content_type
                )
                if include_total
                else None
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        has_more = len(rows) > limit
        rows = rows[:limit]
        files = [build_file_response(r, presigner, ttl=ttl) for r in rows]

    return MmFileListResponse(
        files=files,
        limit=limit,
        has_more=has_more,
        next_cursor=rows[-1].file_id if has_more else None,
        offset=offset or None,
        total=total,
    )


@human_mm_router.get(
    "/api/human/mm/channels/{channel_id}/links",
    response_model=MmLinkListResponse,
)
def list_channel_links(
    channel_id: str,
    request: Request,
    limit: int = 50,
    before_post_id: int | None = None,
    offset: int = 0,
    user: dict = Depends(get_current_human_user),
):
    """Distinct URLs from the newest ``_LINKS_SCAN_PAGE_MAX`` message bodies, freshest
    occurrence first. ``next_cursor`` is the last scanned post, to pass back as
    ``before_post_id``; ``has_more`` means the scan window filled."""
    if limit < 1 or limit > _LINKS_LIMIT_MAX:
        raise HTTPException(
            status_code=422, detail=f"limit must be between 1 and {_LINKS_LIMIT_MAX}"
        )
    if offset < 0:
        raise HTTPException(status_code=422, detail="offset must be non-negative")
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        posts = TableRead.get_mm_posts_with_text_for_channel(
            db, channel_id, limit=_LINKS_SCAN_PAGE_MAX, offset=offset, before_post_id=before_post_id
        )

    seen: set[str] = set()
    items: list[MmLinkItem] = []
    last_scanned_post_id: int | None = None
    for post in posts:
        last_scanned_post_id = post.post_id
        for url in extract_urls(post.message):
            if url in seen:
                continue
            seen.add(url)
            items.append(
                MmLinkItem(
                    url=url,
                    post_id=post.post_id,
                    post_created_at=format_db_timestamp(post.created_at),
                )
            )
            if len(items) >= limit:
                break
        if len(items) >= limit:
            break
    has_more = len(posts) >= _LINKS_SCAN_PAGE_MAX
    return MmLinkListResponse(
        links=items,
        limit=limit,
        has_more=has_more,
        next_cursor=last_scanned_post_id if has_more else None,
        offset=offset or None,
    )


@human_mm_router.post(
    "/api/human/mm/channels/{channel_id}/files",
    response_model=MmFileUploadResponse,
)
def request_file_upload(
    channel_id: str,
    body: MmFileUploadRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Reserve a pending file and return presigned PUT URLs. The client uploads straight to
    R2, then calls ``/files/{id}/confirm``; unconfirmed rows are collected after 24h."""
    cfg = load_file_config()
    presigner = _require_presigner(request)
    if body.size_bytes > cfg.max_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"File too large: {body.size_bytes} bytes (max {cfg.max_bytes})",
        )
    content_type = resolve_content_type(body.filename, body.content_type)
    if not is_mime_allowed(content_type, cfg.mime_allowlist):
        raise HTTPException(status_code=415, detail=f"Content type not allowed: {content_type}")

    file_id = new_file_id()
    object_key = build_object_key(file_id, body.filename)
    thumb_key = (
        build_object_key(file_id, body.filename, thumbnail=True) if body.has_thumbnail else None
    )
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        TableWrite.create_mm_file(
            db,
            file_id=file_id,
            channel_id=channel_id,
            uploader_human_id=user["id"],
            filename=body.filename,
            content_type=content_type,
            size_bytes=body.size_bytes,
            object_key=object_key,
            thumbnail_object_key=thumb_key,
            sha256=body.sha256,
        )
        db.commit()

    put = presigner.presign_put(
        object_key, content_type, content_length=body.size_bytes, expires=300
    )
    thumb_put = (
        presigner.presign_put(
            thumb_key, "image/jpeg", content_length=body.thumbnail_size_bytes, expires=300
        )
        if thumb_key is not None and body.thumbnail_size_bytes is not None
        else None
    )
    return MmFileUploadResponse(
        file_id=file_id,
        upload_url=put["url"],
        upload_headers=put["headers"],
        upload_expires_in=put["expires_in"],
        object_key=object_key,
        thumbnail_upload_url=thumb_put["url"] if thumb_put else None,
        thumbnail_upload_headers=thumb_put["headers"] if thumb_put else None,
        thumbnail_object_key=thumb_key,
    )


@human_mm_router.post(
    "/api/human/mm/files/{file_id}/confirm",
    response_model=MmFileResponse,
)
async def confirm_file_upload(
    file_id: str,
    body: MmFileConfirmRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Mark a pending upload ``uploaded`` and record its metadata. Idempotent for the
    uploader. An image without dimensions is probed server-side, preferring its thumbnail,
    so every image post can reserve its aspect-ratio box on first paint."""
    def confirm() -> tuple[MmFileResponse, str | None]:
        with _get_db(request) as db:
            try:
                row = TableWrite.confirm_mm_file(
                    db,
                    file_id,
                    uploader_human_id=user["id"],
                    width=body.width,
                    height=body.height,
                    duration_ms=body.duration_ms,
                    sha256=body.sha256,
                    thumbnail_uploaded=body.thumbnail_uploaded,
                )
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e)) from e
            db.commit()
            needs_probe = row.content_type.startswith("image/") and (
                row.width is None or row.height is None
            )
            return build_file_response(row, presigner=None, ttl=0), (
                (row.thumbnail_object_key or row.object_key) if needs_probe else None
            )

    response, probe_key = await asyncio.to_thread(confirm)
    presigner = getattr(request.app, "_r2_presigner", None)
    if (
        probe_key is None
        or presigner is None
        or (dims := await probe_image_dimensions(presigner, probe_key)) is None
    ):
        return response

    def write_dims() -> MmFileResponse:
        with _get_db(request) as db:
            # No thumbnail_uploaded: leaving it unset keeps the just-confirmed thumbnail key.
            row = TableWrite.confirm_mm_file(
                db, file_id, uploader_human_id=user["id"], width=dims[0], height=dims[1]
            )
            db.commit()
            return build_file_response(row, presigner=None, ttl=0)

    return await asyncio.to_thread(write_dims)


@human_mm_router.get(
    "/api/human/mm/files/{file_id}/url",
    response_model=MmFileDownloadUrlResponse,
)
def get_file_download_url(
    file_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """A short-lived presigned GET URL for a file in a channel the caller belongs to."""
    cfg = load_file_config()
    presigner = _require_presigner(request)
    with _get_db(request) as db:
        row = TableRead.get_mm_file(db, file_id)
        if row is None:
            raise HTTPException(status_code=404, detail="File not found")
        if row.status != "uploaded":
            raise HTTPException(status_code=409, detail=f"File not ready (status={row.status})")
        _require_human_member(db, row.channel_id, user["id"])
        url, expires_at = cached_presigned_get(
            presigner,
            cache_key=f"{row.file_id}:original",
            object_key=row.object_key,
            ttl=cfg.download_url_ttl_for(row.content_type),
            download_filename=row.filename,
        )
    return MmFileDownloadUrlResponse(
        url=url, expires_in=max(0, expires_at - int(_time.time())), expires_at=expires_at
    )


@human_mm_router.delete(
    "/api/human/mm/files/{file_id}",
    status_code=204,
    response_class=Response,
)
def delete_file(
    file_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Soft-delete a file the caller uploaded; 404 for anyone else's. R2 cleanup is the GC's."""
    with _get_db(request) as db:
        row = TableWrite.soft_delete_mm_file(db, file_id, uploader_human_id=user["id"])
        db.commit()
    if row is None:
        raise HTTPException(status_code=404, detail="File not found")
    return Response(status_code=204)


@human_mm_router.patch("/api/human/mm/posts/{post_id}", response_model=MmPostResponse)
async def edit_post(
    post_id: int,
    body: MmPostEditRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Rewrite a published post the caller authored. Stamps ``edited_at`` and re-resolves
    the link preview, which a message without a URL clears."""
    link_preview = await _resolve_embedded_link_preview(body.message)

    def edit() -> MmPostResponse:
        with _get_db(request) as db:
            try:
                TableWrite.edit_mm_post_human(
                    db, post_id, user["id"], body.message, link_preview=link_preview
                )
            except LookupError:
                raise HTTPException(status_code=404, detail="Post not found")
            except PermissionError as exc:
                raise HTTPException(status_code=403, detail=str(exc))
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc))
            db.commit()
            return _rehydrate_post_response(db, post_id)

    response = await asyncio.to_thread(edit)
    fire_and_forget(publish_post_updated(get_bus(), response.channel_id, response.model_dump()))
    return response


@human_mm_router.delete(
    "/api/human/mm/posts/{post_id}",
    status_code=204,
    response_class=Response,
)
def delete_post(
    post_id: int,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Hard-delete a post; the author or the channel creator only. Replies are detached,
    reactions cascade and attached files are unbound."""
    with _get_db(request) as db:
        try:
            snapshot = TableWrite.delete_mm_post_human(db, post_id, user["id"])
        except LookupError:
            raise HTTPException(status_code=404, detail="Post not found")
        except PermissionError as exc:
            raise HTTPException(status_code=403, detail=str(exc))
        channel_id = snapshot.channel_id
        member_human_ids = TableRead.get_mm_channel_human_member_ids(db, channel_id)
        db.commit()

    fire_and_forget(
        publish_post_deleted(get_bus(), channel_id, post_id, member_human_ids=member_human_ids)
    )
    return Response(status_code=204)


@human_mm_router.post("/api/human/mm/posts/{post_id}/reactions", response_model=MmPostResponse)
def toggle_reaction(
    post_id: int,
    body: MmReactionRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Toggle the caller's reaction with ``emoji`` on a post in one of their channels."""
    return _mutate_post(
        request, post_id, user,
        lambda db: TableWrite.toggle_mm_post_reaction(db, post_id, body.emoji, human_id=user["id"]),
    )


@human_mm_router.post("/api/human/mm/posts/{post_id}/pin", response_model=MmPostResponse)
def pin_post(
    post_id: int,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Pin a post; re-pinning keeps the original timestamp. Any channel member may pin."""
    return _mutate_post(
        request, post_id, user, lambda db: TableWrite.pin_mm_post_human(db, post_id, user["id"])
    )


@human_mm_router.delete("/api/human/mm/posts/{post_id}/pin", response_model=MmPostResponse)
def unpin_post(
    post_id: int,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Unpin a post; a no-op when it is not pinned. Any channel member may unpin."""
    return _mutate_post(
        request, post_id, user, lambda db: TableWrite.unpin_mm_post_human(db, post_id)
    )


@human_mm_router.get(
    "/api/human/mm/channels/{channel_id}/pins",
    response_model=MmPinnedListResponse,
)
def list_pinned_posts(
    channel_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Every pinned post in a channel, newest pin first. Caller must be a member."""
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        posts = _with_file_urls(request, TableRead.list_pinned_mm_posts(db, channel_id))
    return MmPinnedListResponse(posts=[MmPostResponse(**p) for p in posts], total=len(posts))


@human_mm_router.post("/api/human/mm/direct", response_model=MmChannelResponse)
async def create_or_get_direct(
    body: MmDirectUnifiedRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Open or get the caller's DM with an agent or human in ``body.org_id``. Both parties
    must belong to that org; the same pair has a separate DM per org."""
    human_id = user["id"]
    org_id = body.org_id

    def open_direct() -> tuple[dict[int, dict], dict | None]:
        with _get_db(request) as db:
            if not TableRead.is_org_member(db, org_id, human_id):
                raise HTTPException(status_code=403, detail="Not a member of this organization")
            if body.target_type == "human":
                target_human_id = int(body.target_id)
                if target_human_id == human_id:
                    raise HTTPException(
                        status_code=400, detail="Cannot create a DM channel with yourself"
                    )
                target = TableRead.get_human_user_by_id(db, target_human_id)
                if target is None:
                    raise HTTPException(
                        status_code=404, detail=f"Human user '{body.target_id}' not found"
                    )
                if not TableRead.is_org_member(db, org_id, target_human_id):
                    raise HTTPException(
                        status_code=403, detail="Target user is not a member of this organization"
                    )
                existing = TableRead.find_dm_channel_human_human(
                    db, human_id, target_human_id, org_id
                )
                low, high = sorted((human_id, target_human_id))
                dm_name = f"dm-human-{low}-human-{high}"
                peer_name = target.get("display_name") or target.get("email", str(target_human_id))
                human_ids, agent_ids = [human_id, target_human_id], []
            else:
                if TableRead.get_agent_by_agentid(db, AgentId(body.target_id)) is None:
                    raise HTTPException(
                        status_code=404, detail=f"Agent '{body.target_id}' not found"
                    )
                if TableRead.get_agent_org_id(db, body.target_id) != org_id:
                    raise HTTPException(
                        status_code=403, detail="Agent does not belong to this organization"
                    )
                if not TableRead.can_dm_agent(db, body.target_id, human_id=human_id):
                    raise HTTPException(
                        status_code=403, detail="Not permitted to contact this agent"
                    )
                existing = TableRead.find_dm_channel_human_agent(
                    db, human_id, body.target_id, org_id
                )
                dm_name = agent_dm_channel_name(human_id, body.target_id)
                peer_name = body.target_id
                human_ids, agent_ids = [human_id], [body.target_id]

            if existing:
                TableRead.apply_dm_peers(db, [existing], human_id)
                return {human_id: existing}, None

            # A DM that lost a member is invisible to the lookup above yet still owns its
            # unique (org_id, name): re-attach both parties instead of colliding on insert.
            orphan = TableRead.get_mm_channel_by_org_and_name(db, org_id, dm_name)
            channel_id = orphan["channel_id"] if orphan else str(uuid.uuid4())
            if orphan is None:
                caller_name = user.get("display_name") or user.get("email", str(human_id))
                TableWrite.create_mm_channel(
                    db, channel_id, dm_name, "direct",
                    display_name=f"DM: {caller_name} ↔ {peer_name}",
                    org_id=org_id,
                )
            for hid in human_ids:
                TableWrite.add_mm_channel_member_human(db, channel_id, hid)
            for aid in agent_ids:
                TableWrite.add_mm_channel_member(db, channel_id, aid)
            db.commit()

            channel = TableRead.get_mm_channel(db, channel_id)
            viewers = {hid: dict(channel) for hid in human_ids}
            for hid, view in viewers.items():
                TableRead.apply_dm_peers(db, [view], hid)
            return viewers, channel

    viewers, created = await asyncio.to_thread(open_direct)
    await _present_dm_peers(list(viewers.values()))
    response = MmChannelResponse(**viewers[human_id])
    if created is None:
        return response
    # Awaited so the avatar URL resolves by the time recipients render channel.added.
    await await_channel_avatar(channel_id=created["channel_id"], channel_type="direct")
    bus = get_bus()
    for hid, view in viewers.items():
        fire_and_forget(publish_channel_added(bus, hid, MmChannelResponse(**view).model_dump()))
    if body.target_type == "agent":
        await publish_agent_channel_added(
            bus, body.target_id, MmChannelResponse(**created).model_dump()
        )
    return response


@human_mm_router.get("/api/human/mm/channels/{channel_id}/events")
async def stream_events(
    channel_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> StreamingResponse:
    """SSE stream of channel events. Connect with ``fetch`` so the bearer header carries.

    Access holds for the stream's lifetime: the viewer's own removal on the channel topic
    closes it at once, and a TTL re-check of the credential and membership catches
    revocations that publish nothing (DM kick, channel deletion, ``can_dm`` revocation)."""
    viewer_id = user["id"]

    def require_member() -> None:
        with _get_db(request) as db:
            _require_human_member(db, channel_id, viewer_id)

    def reauthorize() -> None:
        if not revalidate_stream_credential(request, viewer_id):
            raise StreamClosed()
        require_member()

    await asyncio.to_thread(require_member)
    last_check = _time.monotonic()

    async def reauthorize_if_stale() -> None:
        nonlocal last_check
        now = _time.monotonic()
        if now - last_check < MEMBERSHIP_RECHECK_TTL_SECONDS:
            return
        last_check = now
        try:
            await asyncio.to_thread(reauthorize)
        except HTTPException:
            raise StreamClosed() from None

    async def allow_event(event: dict) -> bool:
        data = event.get("data") or {}
        if event.get("type") == "member.removed":
            if data.get("human_id") == viewer_id:
                raise StreamClosed()
            await reauthorize_if_stale()
            return False
        if event.get("type") == "channel.event" and data.get("event_type") == "member.removed":
            # A self-leave stores a NULL subject, so the leaver is the actor.
            left = (
                data.get("subject_human_id") is None
                and data.get("subject_agent_id") is None
                and data.get("actor_human_id") == viewer_id
            )
            if data.get("subject_human_id") == viewer_id or left:
                raise StreamClosed()
        await reauthorize_if_stale()
        return True

    return await stream_channel_events(
        request,
        channel_id,
        initial_snapshot=[await build_presence_snapshot_event(get_bus(), channel_id)],
        event_filter=allow_event,
        reauthorize=reauthorize_if_stale,
    )


@human_mm_router.post("/api/human/mm/channels/{channel_id}/typing", status_code=204)
def typing_heartbeat(
    channel_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Typing signal (TTL ~6s, send every ~3s); a silent no-op when the caller turned
    typing indicators off."""
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        fresh = TableRead.get_human_user_by_id(db, user["id"])
    if fresh and fresh["typing_indicators_enabled"]:
        bus = get_bus()
        fire_and_forget(bus.presence_set(channel_id, "human", user["id"], "typing"))
        fire_and_forget(publish_member_status(bus, channel_id, "human", str(user["id"]), "typing"))
    return Response(status_code=204)


@human_mm_router.post("/api/human/presence", response_model=MmUserPresenceResponse)
async def update_user_presence(
    body: MmUserPresenceRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> MmUserPresenceResponse:
    """Set the caller's global presence. A same-status heartbeat refreshes the Redis TTL and
    persists ``last_seen_at`` at most every ~5 min; a change persists it and broadcasts
    ``user.status`` to the caller's topic, channels and fellow members."""
    human_id, status = user["id"], body.status
    bus = get_bus()
    transition = await bus.user_presence_get(human_id) != status
    if status == "offline":
        await bus.user_presence_clear(human_id)
    else:
        await bus.user_presence_set(human_id, status)
    persist = transition or (
        status != "offline" and await bus.last_seen_persist_try_acquire(human_id)
    )

    def load() -> tuple[dict | None, list[str], list[int]]:
        with _get_db(request) as db:
            if persist:
                TableWrite.touch_human_last_seen(db, human_id)
                db.commit()
            fresh = TableRead.get_human_user_by_id(db, human_id)
            if not transition:
                return fresh, [], []
            return (
                fresh,
                TableRead.get_mm_channel_ids_for_human(db, human_id),
                TableRead.get_fellow_human_ids(db, human_id),
            )

    fresh, channel_ids, fellow_ids = await asyncio.to_thread(load)
    visible_status, last_seen_at, last_seen_label = _resolve_presence_view(fresh, status)
    if transition:
        await publish_user_status(
            bus, human_id, visible_status, last_seen_at, channel_ids, fellow_ids,
            last_seen_label=last_seen_label,
        )
    return MmUserPresenceResponse(
        human_id=human_id,
        status=visible_status,
        last_seen_at=last_seen_at,
        last_seen_label=last_seen_label,
    )


@human_mm_router.get(
    "/api/human/users/{user_id}/presence",
    response_model=MmUserPresenceResponse,
    dependencies=[Depends(get_current_human_user)],
)
async def get_user_presence(user_id: int, request: Request) -> MmUserPresenceResponse:
    """One user's presence, for surfaces no SSE stream covers. Any signed-in human may read
    it: presence is broadcast on shared channels anyway."""
    status = await get_bus().user_presence_get(user_id)

    def load() -> dict | None:
        with _get_db(request) as db:
            return TableRead.get_human_user_by_id(db, user_id)

    if (u := await asyncio.to_thread(load)) is None:
        raise HTTPException(status_code=404, detail="User not found")
    visible_status, last_seen_at, last_seen_label = _resolve_presence_view(u, status)
    return MmUserPresenceResponse(
        human_id=user_id,
        status=visible_status,
        last_seen_at=last_seen_at,
        last_seen_label=last_seen_label,
    )


@human_mm_router.post(
    "/api/human/mm/channels/{channel_id}/read", response_model=MmMarkReadResponse
)
def mark_channel_read(
    channel_id: str,
    body: MmMarkReadRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Advance the caller's read pointer through ``post_id``, clamped to the latest post and
    never backwards. Peers get ``member.read`` only while the caller keeps read receipts on."""
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        fresh = TableRead.get_human_user_by_id(db, user["id"])
        latest = TableRead.get_mm_channel_latest_published_post_id(db, channel_id)
        last_read = TableWrite.mark_mm_channel_read(
            db, channel_id, user["id"], body.post_id if latest is None else min(body.post_id, latest)
        )
        db.commit()

    bus = get_bus()
    fire_and_forget(publish_channel_read(bus, user["id"], channel_id, last_read))
    if fresh and fresh["read_receipts_enabled"]:
        fire_and_forget(publish_member_read(bus, user["id"], channel_id, last_read))
    return MmMarkReadResponse(channel_id=channel_id, last_read_post_id=last_read)


@human_mm_router.post(
    "/api/human/mm/channels/{channel_id}/mute", response_model=MmMuteResponse
)
def mute_channel(
    channel_id: str,
    body: MmMuteRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Mute or unmute a channel for the caller. Muted channels still accrue unread counts
    but drop out of the tab-title counter."""
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        muted = TableWrite.set_mm_channel_muted(db, channel_id, user["id"], body.muted)
        db.commit()
    fire_and_forget(publish_channel_muted(get_bus(), user["id"], channel_id, muted))
    return MmMuteResponse(channel_id=channel_id, muted=muted)


@human_mm_router.post(
    "/api/human/mm/channels/{channel_id}/pin", response_model=MmPinResponse
)
def pin_channel(
    channel_id: str,
    body: MmPinRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Pin or unpin a channel in the caller's own sidebar."""
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        pinned = TableWrite.set_mm_channel_pinned(db, channel_id, user["id"], body.pinned)
        db.commit()
    fire_and_forget(publish_channel_pinned(get_bus(), user["id"], channel_id, pinned))
    return MmPinResponse(channel_id=channel_id, pinned=pinned)


@human_mm_router.get("/api/human/events")
async def stream_global_events(
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> StreamingResponse:
    """The caller's cross-channel SSE stream. Its first frame, ``server.hello``, carries the
    server version, so a tab left open across a deploy learns to reload on reconnect."""
    hello = {"type": "server.hello", "channel_id": "", "data": {"version": server_version()}}
    return await stream_human_events(request, user["id"], initial_snapshot=[hello])


@human_mm_router.post("/api/human/mm/link-preview", response_model=LinkPreviewResponse)
async def link_preview(
    body: LinkPreviewRequest,
    user: dict = Depends(get_current_human_user),
) -> LinkPreviewResponse:
    """Unfurl ``body.url`` into an OpenGraph card, cached in Redis (24h, 5min on failure).
    A failed fetch is still a 200 with ``error`` set. Auth-gated so it is no open proxy."""
    redis = await get_bus().redis_client()
    preview = await get_link_preview(redis, body.url)
    return LinkPreviewResponse(**preview.__dict__)
