"""Human user Mattermost-style messaging endpoints.

Human users authenticate via JWT (same as other /api/human/ endpoints).
No challenge-response (PoC) is required for human users.
No gas cost is charged for human users.
"""
import asyncio
import hashlib
import json
import logging
import time as _time
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session

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
)
from clawbits.db.table_read import TableRead
from clawbits.db.table_write import TableWrite
from clawbits.fastapi.avatar_hooks import await_channel_avatar
from clawbits.fastapi.human_endpoints import _get_db, get_current_human_user
from clawbits.fastapi.mm_file_helpers import (
    build_file_response,
    build_object_key,
    cached_presigned_get,
    enrich_post_files_with_urls,
    is_mime_allowed,
    load_file_config,
    new_file_id,
    probe_image_dimensions,
)
from clawbits.fastapi.search_helpers import (
    decode_search_cursor,
    encode_search_cursor,
    parse_search_date,
)
from clawbits.fastapi.version_check import server_version
from clawbits.link_preview.extract import extract_urls
from clawbits.link_preview.service import LinkPreview, get_link_preview
from clawbits.lobstertalk.attention import (
    build_attention_context,
    consider_post,
)
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
    publish_member_status,
    publish_post_created,
    publish_post_deleted,
    publish_post_updated,
    publish_user_status,
    stream_channel_events,
    stream_human_events,
)
from clawbits.utils.parse import format_db_timestamp

# Server-side cap on embedded previews per post. The frontend renders
# at most one card to keep the row compact; the server matches so it
# doesn't waste a fetch + cache entry on URLs that won't surface.
_EMBED_PREVIEW_CAP = 1
# Hard ceiling on time spent unfurling. Hits the cached path in well
# under 10 ms; only matters for the cold path where we're waiting on
# an upstream fetch. Past this budget we let the post publish without
# a preview rather than make the send feel laggy — the client-side
# fetch path remains as a fallback for that case.
_EMBED_PREVIEW_TIMEOUT_S = 2.5


async def _resolve_embedded_link_preview(
    redis_factory: object,
    message: str,
) -> dict | None:
    """Return the JSON payload to embed on ``mm_posts.link_preview``.

    Resolves the first eligible URL in ``message`` through the Redis-
    backed unfurl pipeline. Returns ``None`` when there's nothing to
    embed (no URL, or the fetch errored + returned no usable fields, or
    the budget elapsed). Never raises — failure here must not block a
    post from publishing.

    ``redis_factory`` is intentionally untyped — pass ``get_bus()`` and
    the helper grabs a client lazily. Avoids forcing callers to ``await``
    on Redis before we know whether there's even a URL to unfurl.
    """
    import asyncio  # noqa: PLC0415

    urls = extract_urls(message)
    if not urls:
        return None
    target = urls[0]
    skipped = max(0, len(urls) - _EMBED_PREVIEW_CAP)
    try:
        redis = await redis_factory.redis_client()  # type: ignore[attr-defined]
    except Exception:
        return None
    try:
        preview: LinkPreview = await asyncio.wait_for(
            get_link_preview(redis, target),
            timeout=_EMBED_PREVIEW_TIMEOUT_S,
        )
    except (TimeoutError, Exception):
        return None
    # An ``error``-only preview with no title is no better than no
    # preview — let the row stay compact and let the client-side hook
    # try later if it wants. A preview with at least a title or image
    # is worth keeping.
    if preview.title is None and preview.image_url is None:
        return None
    payload: dict = {
        "url": preview.url,
        "canonical_url": preview.canonical_url,
        "title": preview.title,
        "description": preview.description,
        "image_url": preview.image_url,
        "site_name": preview.site_name,
        "fetched_at": preview.fetched_at,
        "error": preview.error,
        "skipped": skipped,
    }
    return payload

# Maximum window of recent posts scanned by ``GET /channels/{id}/links`` in
# one call. The endpoint walks ``message`` bodies (no pre-computed URL
# index) so a higher ceiling here costs proportional CPU; 500 is enough
# to surface several months of links on a typical channel without making
# a quiet channel feel partial.
_LINKS_SCAN_PAGE_MAX = 500

log = logging.getLogger(__name__)

human_mm_router = APIRouter(tags=["Human Mattermost"])


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _require_human_member(db: Session, channel_id: str, human_id: int) -> None:
    """Assert the caller is a member of ``channel_id`` or raise 403.

    For a direct channel with an agent peer this also enforces the agent's
    contact allowlist: contact is closed by default, so a human who is a member
    of a pre-existing agent DM but lacks ``can_dm`` is shut out here too.
    """
    if not TableRead.is_mm_channel_member_human(db, channel_id, human_id):
        raise HTTPException(status_code=403, detail="Not a member of this channel")
    _require_agent_dm_contact(db, channel_id, human_id)


def _require_agent_dm_contact(db: Session, channel_id: str, human_id: int) -> None:
    """If ``channel_id`` is an agent DM, require the caller's ``can_dm`` grant."""
    agent_id = TableRead.dm_agent_peer(db, channel_id)
    if agent_id and not TableRead.can_dm_agent(db, agent_id, human_id=human_id):
        raise HTTPException(
            status_code=403, detail="Not permitted to contact this agent"
        )


def _privacy_presence(user_row: dict | None) -> tuple[bool, str | None]:
    """Legacy shim — preserved so call sites that still want a single
    "is the user globally hidden" boolean keep working. Hidden iff both
    online-status and last-seen are hidden (i.e. the user has the
    closest equivalent to the old single-toggle ``privacy_mode``).
    """
    if user_row is None:
        return False, None
    hidden = not user_row.get("online_status_visible", True) and not user_row.get(
        "last_seen_visible", True
    )
    return hidden, user_row.get("last_seen_at")


def _resolve_presence_view(
    user_row: dict | None, status: GlobalUserStatus
) -> tuple[GlobalUserStatus, str | None, str | None]:
    """Apply the target user's privacy settings to a presence triple
    that's about to be sent to peers.

    Returns ``(broadcast_status, last_seen_at, last_seen_label)``:

    * ``broadcast_status`` — ``status`` unchanged when the user keeps
      their online status visible; ``"offline"`` otherwise.
    * ``last_seen_at`` — the raw ISO timestamp when visible; ``None``
      when hidden.
    * ``last_seen_label`` — Telegram-style bucket
      (``recently`` / ``within a week`` / ``within a month`` /
      ``a long time ago``) when hidden; ``None`` when visible.
    """
    if user_row is None:
        return status, None, None
    out_status: GlobalUserStatus = (
        status if user_row.get("online_status_visible", True) else "offline"
    )
    last_seen_visible = user_row.get("last_seen_visible", True)
    raw_ts = user_row.get("last_seen_at")
    if last_seen_visible:
        return out_status, raw_ts, None
    return out_status, None, _bucket_last_seen(raw_ts)


def _bucket_last_seen(ts: str | None) -> str:
    """Bucket an ISO ``last_seen_at`` into the Telegram-style label."""
    if not ts:
        return "a long time ago"
    try:
        parsed = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return "a long time ago"
    from datetime import UTC as _UTC

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_UTC)
    delta = datetime.now(_UTC) - parsed
    days = delta.total_seconds() / 86400.0
    if days < 3:
        return "recently"
    if days < 7:
        return "within a week"
    if days < 30:
        return "within a month"
    return "a long time ago"


def _require_presigner(request: Request) -> R2Presigner:
    """Fetch the app's R2 presigner or raise 503.

    The presigner is initialized at server startup from ``R2_ACCESS_KEY_ID``
    / ``R2_SECRET_ACCESS_KEY``; if either is unset the attribute is
    ``None`` and chat-attachment endpoints degrade to ``Service
    Unavailable``.
    """
    presigner = getattr(request.app, "_r2_presigner", None)
    if presigner is None:
        raise HTTPException(
            status_code=503,
            detail="File storage is not configured on this server",
        )
    return presigner


async def _apply_global_presence(
    bus: EventBus,
    db: Session,
    human_id: int,
    status: GlobalUserStatus,
) -> str | None:
    """Apply a global presence change: Redis state, DB ``last_seen_at``,
    and the ``user.status`` SSE event.

    On a *transition* (status changed) we always persist ``last_seen_at``
    and broadcast. On a same-status online/idle heartbeat we persist
    only every ~5 min (Redis-throttled — see
    :meth:`EventBus.last_seen_persist_try_acquire`) and stay silent on
    the bus.

    Returns the up-to-date raw ``last_seen_at`` ISO string (or ``None``
    if unknown) for callers that want to echo it in their own response —
    privacy filtering happens at the call site so the caller can choose
    whether to expose the raw timestamp or the bucket label.
    """
    prior = await bus.user_presence_get(human_id)
    if status == "offline":
        await bus.user_presence_clear(human_id)
    else:
        await bus.user_presence_set(human_id, status)

    transition = prior != status
    persisted = transition
    if not transition and status != "offline":
        persisted = await bus.last_seen_persist_try_acquire(human_id)

    if persisted:
        TableWrite.touch_human_last_seen(db, human_id)
        db.commit()
    u = TableRead.get_human_user_by_id(db, human_id)
    last_seen_iso = u.get("last_seen_at") if u else None

    if transition:
        broadcast_status, broadcast_last_seen, broadcast_label = _resolve_presence_view(
            u, status
        )
        channel_ids = TableRead.get_mm_channel_ids_for_human(db, human_id)
        fellow_ids = TableRead.get_fellow_human_ids(db, human_id)
        await publish_user_status(
            bus,
            human_id,
            broadcast_status,
            broadcast_last_seen,
            channel_ids,
            fellow_ids,
            last_seen_label=broadcast_label,
        )
    return last_seen_iso


async def _broadcast_offline_on_expiry(
    bus: EventBus, engine: Engine, human_id: int
) -> None:
    """Handle a ``user_presence:<id>`` Redis key TTL elapsing without a
    refresh — the silent-disconnect case where the user's tab died too
    quickly for ``sendBeacon('offline')`` to fire.

    Publishes ``user.status: offline`` so subscribers stop showing the
    user online. Race-protected so only one worker per cluster emits per
    expiry; a heartbeat that races back in between expiry and dispatch
    promotes the user to online and we no-op."""
    if not await bus.offline_broadcast_try_acquire(human_id):
        return

    # The heartbeat may have re-set the key after expiry but before we
    # got here. Skip the broadcast in that case — the user is back.
    fresh = await bus.user_presence_get(human_id)
    if fresh != "offline":
        return

    def _read() -> tuple[bool, str | None, list[str], list[int]]:
        with Session(engine) as db:
            u = TableRead.get_human_user_by_id(db, human_id)
            private, private_last_seen = _privacy_presence(u)
            if private:
                last_seen_iso = private_last_seen
            else:
                TableWrite.touch_human_last_seen(db, human_id)
                db.commit()
                u = TableRead.get_human_user_by_id(db, human_id)
                last_seen_iso = u.get("last_seen_at") if u else None
            channel_ids = TableRead.get_mm_channel_ids_for_human(db, human_id)
            fellow_ids = TableRead.get_fellow_human_ids(db, human_id)
        return private, last_seen_iso, channel_ids, fellow_ids

    private, last_seen_iso, channel_ids, fellow_ids = await asyncio.to_thread(_read)
    if private:
        await bus.user_presence_set(human_id, "idle")
    await publish_user_status(
        bus, human_id, "idle" if private else "offline", last_seen_iso, channel_ids, fellow_ids
    )


async def user_presence_expiry_watcher(engine: Engine) -> None:
    """Bridge Redis keyspace expirations to ``user.status: offline``.

    Started once per worker by the FastAPI lifespan. Subscribes to
    ``__keyevent@<db>__:expired`` and dispatches handler runs for any
    expired ``user_presence:<id>`` key. If keyspace notifications can't
    be enabled (managed-Redis CONFIG-locked tier, etc.) the watcher
    exits cleanly without raising — silent-disconnect detection is best
    effort, the existing snapshot-on-reconnect path still works on the
    next page load."""
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
                log.warning(
                    "user_presence_expiry_watcher: handler failed for %s: %s",
                    key, exc,
                )
    except asyncio.CancelledError:
        log.info("user_presence_expiry_watcher: stopped")
        raise

# ---------------------------------------------------------------------------
# POST /api/human/mm/channels
# ---------------------------------------------------------------------------

@human_mm_router.post("/api/human/mm/channels", response_model=MmChannelResponse)
async def create_channel(
    body: MmHumanCreateChannelRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Create a channel in an organization. Human must be a member of the specified org."""
    with _get_db(request) as db:
        if not TableRead.is_org_member(db, body.org_id, user["id"]):
            raise HTTPException(status_code=403, detail="Not a member of this organization")

        channel_id = str(uuid.uuid4())
        creator_event_payload: dict | None = None
        try:
            TableWrite.create_mm_channel(
                db, channel_id,
                body.name, body.channel_type, body.display_name,
                org_id=body.org_id, created_by_human=user["id"],
            )
            TableWrite.add_mm_channel_member_human(db, channel_id, user["id"])
            # Emit an inline timeline event for the creator's implicit
            # membership. Same shape as a self-join (actor == subject),
            # which ``create_mm_channel_event`` normalises to a NULL
            # subject so the renderer picks "joined the channel". DMs
            # are short-circuited inside the helper.
            creator_event_id = TableWrite.create_mm_channel_event(
                db, channel_id, "member.added",
                actor_human_id=user["id"],
                subject_human_id=user["id"],
            )
            creator_event_dict = (
                TableRead.get_mm_channel_event_by_id(db, creator_event_id)
                if creator_event_id
                else None
            )
            if creator_event_dict is not None:
                creator_event_payload = MmChannelEventResponse(
                    **creator_event_dict
                ).model_dump()
            db.commit()
        except IntegrityError:
            # UNIQUE(team_id, name) — a channel with this name already exists.
            raise HTTPException(
                status_code=409,
                detail=f"A chat named \"{body.display_name or body.name}\" already exists",
            )

        ch = TableRead.get_mm_channel(db, channel_id)
        response = MmChannelResponse(**ch)
    # Fan out the creator's join event so any other tab the user has
    # open (or a teammate already on the channel page in the rare
    # admin-created-on-your-behalf flow) picks it up via SSE. At this
    # point the channel has exactly one member (the creator), so the
    # delivery list is just ``[user["id"]]``.
    if creator_event_payload is not None:
        fire_and_forget(
            publish_channel_event(
                get_bus(), channel_id, creator_event_payload,
                member_human_ids=[user["id"]],
            )
        )
    # Await the avatar upload before returning — the client navigates to
    # the new channel immediately and we need the SVG in R2 before its
    # first GET, otherwise Cloudflare caches a 404 at the edge.
    # ``channel_type`` picks the overlay icon (hash vs lock).
    await await_channel_avatar(
        channel_id=channel_id, channel_type=body.channel_type
    )

    # New sidebar entry — fire on the creator's per-user topic so other
    # tabs / devices pick it up without a manual reload.
    fire_and_forget(
        publish_channel_added(get_bus(), user["id"], response.model_dump())
    )
    return response


# ---------------------------------------------------------------------------
# GET /api/human/mm/channels
# ---------------------------------------------------------------------------

@human_mm_router.get("/api/human/mm/channels", response_model=MmChannelListResponse)
async def list_channels(
    request: Request,
    org_id: str | None = None,
    user: dict = Depends(get_current_human_user),
):
    """List channels the current human user belongs to.

    When ``org_id`` is provided, scopes the result to that organization —
    matches the Slack-style mental model where each workspace owns its own
    channels and DMs. Omitting ``org_id`` returns every channel the user
    belongs to (used for cross-org notifications, etc).
    """
    with _get_db(request) as db:
        if org_id is not None and not TableRead.is_org_member(db, org_id, user["id"]):
            raise HTTPException(status_code=403, detail="Not a member of this organization")
        channels = TableRead.get_mm_channels_for_human(db, user["id"], org_id=org_id)
        return MmChannelListResponse(
            channels=[MmChannelResponse(**c) for c in channels],
            total=len(channels),
        )


# ---------------------------------------------------------------------------
# GET /api/human/mm/channels/discoverable
# ---------------------------------------------------------------------------
# NOTE: must be declared BEFORE the /{channel_id} route below so FastAPI
# doesn't capture "discoverable" as a channel id.

@human_mm_router.get(
    "/api/human/mm/channels/discoverable",
    response_model=MmDiscoverableChannelListResponse,
)
async def list_discoverable_channels(
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
            channels=[MmDiscoverableChannelResponse(**c) for c in channels],
            total=len(channels),
        )


# ---------------------------------------------------------------------------
# GET /api/human/mm/orgs/{org_id}/channels  — admin channel-management list
# ---------------------------------------------------------------------------

@human_mm_router.get(
    "/api/human/mm/orgs/{org_id}/channels",
    response_model=MmAdminChannelListResponse,
)
async def admin_list_org_channels(
    org_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """List every public + private channel in ``org_id``. Owner-only.

    Powers the channels-management page in Settings. Direct channels are
    excluded — DMs are person-to-person and not subject to org-level
    moderation in V1.
    """
    with _get_db(request) as db:
        role = TableRead.get_org_member_role(db, org_id, user["id"])
        if role != "owner":
            raise HTTPException(
                status_code=403,
                detail="Only organization admins can list all channels",
            )
        channels = TableRead.list_all_mm_channels_in_org(db, org_id, user["id"])
        return MmAdminChannelListResponse(
            channels=[MmAdminChannelResponse(**c) for c in channels],
            total=len(channels),
        )


# ---------------------------------------------------------------------------
# POST /api/human/mm/channels/{channel_id}/join
# ---------------------------------------------------------------------------

@human_mm_router.post(
    "/api/human/mm/channels/{channel_id}/join",
    response_model=MmChannelResponse,
)
async def join_channel(
    channel_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Self-join a public channel. Returns the channel after the user is added."""
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
        joined_event_payload: dict | None = None
        try:
            TableWrite.add_mm_channel_member_human(db, channel_id, user["id"])
            # Self-join: emit a ``member.added`` with actor == subject
            # so the timeline shows "X joined the channel" for everyone
            # already in the channel. Helper normalises the subject to
            # NULL to pick the "joined" renderer.
            joined_event_id = TableWrite.create_mm_channel_event(
                db, channel_id, "member.added",
                actor_human_id=user["id"],
                subject_human_id=user["id"],
            )
            joined_event_dict = (
                TableRead.get_mm_channel_event_by_id(db, joined_event_id)
                if joined_event_id
                else None
            )
            if joined_event_dict is not None:
                joined_event_payload = MmChannelEventResponse(
                    **joined_event_dict
                ).model_dump()
            # Capture member ids for the SSE fanout before commit closes
            # the session.
            members = TableRead.get_mm_channel_members(db, channel_id)
            event_member_human_ids = [
                m["human_id"] for m in members if m.get("human_id") is not None
            ]
            db.commit()
        except ValueError as e:
            raise HTTPException(status_code=409, detail=str(e)) from e
        response = MmChannelResponse(**ch)

    fire_and_forget(
        publish_channel_added(get_bus(), user["id"], response.model_dump())
    )
    if joined_event_payload is not None:
        fire_and_forget(
            publish_channel_event(
                get_bus(), channel_id, joined_event_payload,
                member_human_ids=event_member_human_ids,
            )
        )
    return response


# ---------------------------------------------------------------------------
# GET /api/human/mm/channels/{channel_id}
# ---------------------------------------------------------------------------

@human_mm_router.get("/api/human/mm/channels/{channel_id}", response_model=MmChannelResponse)
async def get_channel(
    channel_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Get channel info. Caller must be a member."""
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        ch = TableRead.get_mm_channel(db, channel_id)
        if ch is None:
            raise HTTPException(status_code=404, detail="Channel not found")
        TableRead.apply_dm_peer_display(db, [ch], user["id"])
        return MmChannelResponse(**ch)


# ---------------------------------------------------------------------------
# DELETE /api/human/mm/channels/{channel_id}  — admin-only hard delete
# ---------------------------------------------------------------------------

@human_mm_router.delete(
    "/api/human/mm/channels/{channel_id}",
    status_code=204,
    response_class=Response,
)
async def admin_delete_channel(
    channel_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Hard-delete a channel and all its posts/files/members.

    Authorised for either the channel's **creator** (so you can delete a
    channel you started even while other humans remain — distinct from
    *leaving*, which only removes you) or an **organization owner** (so
    owners can moderate any channel from Settings → Channels).

    Refuses ``direct`` channels — DMs aren't deleted this way; they're torn
    down when the last human leaves (see ``remove_member``). Fans out
    ``channel.removed`` to each former member's personal SSE topic — and to
    agent members' plugins — so their sidebars/plugins drop it in real time.
    """
    with _get_db(request) as db:
        channel = TableRead.get_mm_channel(db, channel_id)
        if channel is None:
            raise HTTPException(status_code=404, detail="Channel not found")
        if channel.get("channel_type") == "direct":
            raise HTTPException(
                status_code=400,
                detail="Direct message channels cannot be deleted this way",
            )
        org_id = channel.get("org_id")
        if org_id is None:
            # Defence in depth: a channel without an org has no owners to
            # authorise against. Today every channel created via the API
            # carries an org_id, but the schema allows null.
            raise HTTPException(
                status_code=400,
                detail="Channel is not scoped to an organization",
            )
        is_creator = channel.get("created_by_human") == user["id"]
        role = TableRead.get_org_member_role(db, org_id, user["id"])
        if not is_creator and role != "owner":
            raise HTTPException(
                status_code=403,
                detail="Only the channel creator or an organization admin can delete it",
            )

        # Snapshot agent members before the delete so their plugins also get
        # a ``channel.removed`` (``delete_mm_channel`` only returns humans).
        members = TableRead.get_mm_channel_members(db, channel_id)
        agent_ids_for_fanout = [
            m["agent_id"] for m in members if m.get("agent_id") is not None
        ]
        result = TableWrite.delete_mm_channel(db, channel_id)
        db.commit()

    if result is not None:
        bus = get_bus()
        for member_id in result["human_member_ids"]:
            fire_and_forget(
                publish_channel_removed(bus, member_id, channel_id)
            )
        for agent_id in agent_ids_for_fanout:
            await publish_agent_channel_removed(bus, agent_id, channel_id)
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# POST /api/human/mm/channels/{channel_id}/members
# ---------------------------------------------------------------------------

@human_mm_router.post("/api/human/mm/channels/{channel_id}/members", response_model=MmChannelMembersListResponse)
async def add_member(
    channel_id: str,
    body: MmAddMemberUnifiedRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Add a member (agent or human) to a channel. Caller must be a member."""
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        ch = TableRead.get_mm_channel(db, channel_id)
        if ch is None:
            raise HTTPException(status_code=404, detail="Channel not found")

        added_human_id: int | None = None
        added_agent_id: str | None = None
        try:
            if body.member_type == "agent":
                target = TableRead.get_agent_by_agentid(db, AgentId(body.member_id))
                if target is None:
                    raise HTTPException(status_code=404, detail=f"Agent '{body.member_id}' not found")
                # Bringing an agent into a channel is gated by the same
                # ``can_tag`` grant as mentioning it — you can only add an
                # agent you're allowed to tag (operator always may).
                if not TableRead.can_tag_agent(db, body.member_id, human_id=user["id"]):
                    raise HTTPException(
                        status_code=403,
                        detail=f"Not permitted to add agent '{body.member_id}'",
                    )
                TableWrite.add_mm_channel_member(db, channel_id, body.member_id)
                added_agent_id = body.member_id
            else:  # human
                added_human_id = int(body.member_id)
                target = TableRead.get_human_user_by_id(db, added_human_id)
                if target is None:
                    raise HTTPException(status_code=404, detail=f"Human user '{body.member_id}' not found")
                TableWrite.add_mm_channel_member_human(db, channel_id, added_human_id)
        except ValueError as e:
            raise HTTPException(status_code=409, detail=str(e)) from e

        # Record the membership change as an inline channel event. The
        # helper short-circuits for DMs and normalises self-actions, so
        # this is safe regardless of channel_type / who was added.
        event_id = TableWrite.create_mm_channel_event(
            db, channel_id, "member.added",
            actor_human_id=user["id"],
            subject_human_id=added_human_id,
            subject_agent_id=added_agent_id,
        )
        event_dict = (
            TableRead.get_mm_channel_event_by_id(db, event_id)
            if event_id
            else None
        )

        members = TableRead.get_mm_channel_members(db, channel_id)
        # Capture human-member ids before commit closes the session — the
        # SSE fanout below needs them and the post-commit block runs
        # outside the ``with`` context.
        event_member_human_ids = [
            m["human_id"] for m in members if m.get("human_id") is not None
        ]
        db.commit()
        channel_payload = MmChannelResponse(**ch).model_dump()

    if added_human_id is not None:
        fire_and_forget(
            publish_channel_added(get_bus(), added_human_id, channel_payload)
        )
    if added_agent_id is not None:
        await publish_agent_channel_added(get_bus(), added_agent_id, channel_payload)
    if event_dict is not None:
        event_payload = MmChannelEventResponse(**event_dict).model_dump()
        fire_and_forget(
            publish_channel_event(
                get_bus(), channel_id, event_payload,
                member_human_ids=event_member_human_ids,
            )
        )
    return MmChannelMembersListResponse(
        members=[MmChannelMemberResponse(**m) for m in members],
        total=len(members),
    )


# ---------------------------------------------------------------------------
# DELETE /api/human/mm/channels/{channel_id}/members/{member_id}
# ---------------------------------------------------------------------------

@human_mm_router.delete("/api/human/mm/channels/{channel_id}/members/{member_id}", response_model=MmChannelMembersListResponse)
async def remove_member(
    channel_id: str,
    member_id: str,
    request: Request,
    member_type: str = "agent",
    user: dict = Depends(get_current_human_user),
):
    """Remove a member from a channel. Use ?member_type=human for human members. Caller must be a member.

    When the removal leaves the channel with no human members — i.e. the
    last human leaves a human↔agent DM or a group channel — the channel
    is hard-deleted rather than stranded with only agents (or empty). The
    frontend surfaces a confirmation before issuing this call in that case.
    """
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        removed_human_id: int | None = None
        removed_agent_id: str | None = None
        if member_type == "human":
            removed_human_id = int(member_id)
            TableWrite.remove_mm_channel_member_human(db, channel_id, removed_human_id)
        else:
            TableWrite.remove_mm_channel_member(db, channel_id, member_id)
            removed_agent_id = member_id

        members = TableRead.get_mm_channel_members(db, channel_id)
        # ``members`` reflects the state *after* the removal.
        remaining_human_ids = [
            m["human_id"] for m in members if m.get("human_id") is not None
        ]

        channel_deleted = False
        agent_ids_for_fanout: list[str] = []
        event_dict: dict | None = None
        event_member_human_ids: list[int] = []

        if removed_human_id is not None and not remaining_human_ids:
            # The last human just left. Tear the channel down completely
            # (posts, files, events, memberships) so it doesn't linger as
            # an agent-only husk that no human can ever reopen. Capture the
            # agent members first so their plugins get a ``channel.removed``
            # after commit.
            agent_ids_for_fanout = [
                m["agent_id"] for m in members if m.get("agent_id") is not None
            ]
            TableWrite.delete_mm_channel(db, channel_id)
            channel_deleted = True
            members = []
        else:
            # Inline timeline event. Self-removal normalises to "left" via
            # the helper's subject-NULL rule. Skipped on deletion — the
            # event table rows are dropped with the channel anyway.
            event_id = TableWrite.create_mm_channel_event(
                db, channel_id, "member.removed",
                actor_human_id=user["id"],
                subject_human_id=removed_human_id,
                subject_agent_id=removed_agent_id,
            )
            event_dict = (
                TableRead.get_mm_channel_event_by_id(db, event_id)
                if event_id
                else None
            )
            # The removed human should also receive the event for cross-tab
            # consistency, but they shouldn't appear in ``members`` so
            # ``publish_channel_removed`` below handles their sidebar.
            event_member_human_ids = remaining_human_ids
        db.commit()

    if removed_human_id is not None:
        fire_and_forget(
            publish_channel_removed(get_bus(), removed_human_id, channel_id)
        )
    if removed_agent_id is not None:
        await publish_agent_channel_removed(get_bus(), removed_agent_id, channel_id)
    for agent_id in agent_ids_for_fanout:
        await publish_agent_channel_removed(get_bus(), agent_id, channel_id)
    if event_dict is not None:
        event_payload = MmChannelEventResponse(**event_dict).model_dump()
        fire_and_forget(
            publish_channel_event(
                get_bus(), channel_id, event_payload,
                member_human_ids=event_member_human_ids,
            )
        )
    return MmChannelMembersListResponse(
        members=[MmChannelMemberResponse(**m) for m in members],
        total=len(members),
        channel_deleted=channel_deleted,
    )


# ---------------------------------------------------------------------------
# GET /api/human/mm/channels/{channel_id}/members
# ---------------------------------------------------------------------------

@human_mm_router.get("/api/human/mm/channels/{channel_id}/members", response_model=MmChannelMembersListResponse)
async def list_members(
    channel_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """List members of a channel. Caller must be a member.

    Seeds each human member's current ``status`` from Redis so the UI
    can render the presence dot on first paint, before the SSE
    ``user.status`` stream catches up."""
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        members = TableRead.get_mm_channel_members(db, channel_id)

    caller_id = user["id"]
    # Per-viewer ``can_tag`` on agent members so the composer can hide agents
    # the caller may not ``@``-mention (contact is closed by default). Recomputed
    # cheaply against the agent's allowlist; humans carry no tag gate.
    with _get_db(request) as db:
        for m in members:
            aid = m.get("agent_id")
            m["can_tag"] = (
                TableRead.can_tag_agent(db, aid, human_id=caller_id)
                if aid is not None
                else None
            )
    human_ids = [m["human_id"] for m in members if m.get("human_id") is not None]
    statuses = await get_bus().user_presence_get_many(human_ids)
    for m in members:
        hid = m.get("human_id")
        if hid is None:
            m["status"] = None
            m["last_seen_label"] = None
            continue
        raw_status = statuses.get(hid) or "offline"
        out_status, out_last_seen, out_label = _resolve_presence_view(m, raw_status)
        m["status"] = out_status
        m["last_seen_at"] = out_last_seen
        m["last_seen_label"] = out_label
        # Hide other members' read pointers when they've turned off
        # read receipts. The caller always sees their own pointer (the
        # client uses it to compute the unread badge), but to other
        # members it's stripped so "Read" indicators don't fire under
        # their outgoing posts.
        if hid != caller_id and not m.get("read_receipts_enabled", True):
            m["last_read_post_id"] = None
    return MmChannelMembersListResponse(
        members=[MmChannelMemberResponse(**m) for m in members],
        total=len(members),
    )


# ---------------------------------------------------------------------------
# POST /api/human/mm/channels/{channel_id}/posts
# ---------------------------------------------------------------------------

USAGE_COMMAND = "/cb-usage"


def _is_usage_command(message: str) -> bool:
    """True when the post is the bare ``/cb-usage`` command (case-insensitive)."""
    return (message or "").strip().lower() == USAGE_COMMAND


def _create_usage_reply(
    db: Session, channel_id: str, parent_post_id: int, trace_id: str | None
) -> int | None:
    """Reply to a human ``/cb-usage`` post with the channel agent's CB_TOKENS balance.

    Returns the new reply post id, or ``None`` when the command does not apply
    (not a DM, or no agent to report on). ``/cb-usage`` is a DM-only command —
    anywhere else the post is just a normal message. The balance read is
    fail-soft: any failure becomes a chat reply rather than failing the human's
    send, so ``/cb-usage`` never breaks the conversation.
    """
    channel = TableRead.get_mm_channel(db, channel_id)
    if channel is None or channel.get("channel_type") != "direct":
        return None
    members = TableRead.get_mm_channel_members(db, channel_id)
    agent_ids = [m["agent_id"] for m in members if m.get("agent_id")]
    if not agent_ids:
        return None
    # DMs carry a single agent; if a channel somehow has several, report the first.
    agent_id = agent_ids[0]
    try:
        balance = TableRead.get_cb_tokens(db, AgentId(agent_id))
        reply_message = f"CB_TOKENS remaining: {balance:,}"
    except Exception as e:
        log.exception("/cb-usage balance lookup failed: %s", e)
        reply_message = "Usage unavailable right now — couldn't read the CB_TOKENS balance."
    return TableWrite.create_mm_post(
        db, channel_id, agent_id, reply_message,
        parent_post_id=parent_post_id,
        trace_id=trace_id,
    )


@human_mm_router.post("/api/human/mm/channels/{channel_id}/posts", response_model=MmPostResponse)
async def create_post(
    channel_id: str,
    body: MmPostRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Post a message to a channel. Caller must be a member.

    The message may only ``@``-tag agents the caller is permitted to contact
    (contact is closed by default). A permitted post publishes immediately —
    there is no owner-approval hold.
    """
    from clawbits.db.models import MmPost

    if body.status != "published":
        raise HTTPException(
            status_code=400,
            detail="Human users may only create published posts",
        )
    cfg = load_file_config()
    if len(body.file_ids) > cfg.max_per_post:
        raise HTTPException(
            status_code=400,
            detail=f"Too many files: {len(body.file_ids)} (max {cfg.max_per_post})",
        )

    # Resolve the embedded OG card *before* opening the DB session so we
    # don't hold a connection across network I/O. Cached URLs return in
    # <10ms; cold path is bounded by ``_EMBED_PREVIEW_TIMEOUT_S``.
    embedded_preview = await _resolve_embedded_link_preview(get_bus(), body.message)

    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])

        tagged_agent_ids = TableRead.find_tagged_agents_in_channel(
            db, channel_id, body.message
        )

        # Contact is closed by default: a human may only ``@``-tag an agent it
        # holds a ``can_tag`` grant for (the operator always may). Reject the
        # whole post rather than silently dropping the mention. Permission is
        # now the only gate — a permitted tag publishes immediately (the old
        # owner-approval hold was removed in favour of contact permissions).
        for agent_id in tagged_agent_ids:
            if not TableRead.can_tag_agent(db, agent_id, human_id=user["id"]):
                raise HTTPException(
                    status_code=403,
                    detail=f"Not permitted to tag agent '{agent_id}'",
                )

        try:
            post_id = TableWrite.create_mm_post_human(
                db, channel_id, user["id"], body.message,
                status="published",
                parent_post_id=body.parent_post_id,
                link_preview=embedded_preview,
                trace_id=body.trace_id,
            )
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e

        # Attach pre-uploaded files. The helper raises ``ValueError`` if any
        # file is ineligible (wrong owner, wrong channel, not uploaded,
        # already attached); the surrounding ``with _get_db`` rolls back so
        # the post insert is undone too — keeps the post and files atomic.
        if body.file_ids:
            try:
                TableWrite.attach_files_to_post(
                    db, post_id, body.file_ids, channel_id,
                    uploader_human_id=user["id"],
                )
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e)) from e

        # Sending a post implies the sender has read everything up to and
        # including their own post — keeps unread counts honest across tabs.
        TableWrite.mark_mm_channel_read(db, channel_id, user["id"], post_id)

        # `/cb-usage`: answer the human with the channel agent's remaining
        # CB_TOKENS as a threaded reply. Created in the same transaction so the
        # command + answer commit atomically; the read pointer above only
        # covers the human's own post, so the agent reply lands as unread.
        usage_reply_id = (
            _create_usage_reply(db, channel_id, post_id, body.trace_id)
            if _is_usage_command(body.message)
            else None
        )
        db.commit()

        row = db.get(MmPost, post_id)
        if not row:
            raise HTTPException(status_code=500, detail="Failed to retrieve created post")
        # Build the file payload from the freshly-attached rows, then run
        # the same URL enrichment as the read path so images come back
        # ready to render.
        post_dict = TableRead._mm_post_to_dict(db, row, None)
        presigner = getattr(request.app, "_r2_presigner", None)
        enrich_post_files_with_urls(post_dict, presigner, ttl=cfg.download_url_ttl)
        response = MmPostResponse(
            post_id=row.post_id,
            channel_id=row.channel_id,
            agent_id=row.agent_id,
            human_id=row.human_id,
            message=row.message,
            created_at=format_db_timestamp(row.created_at),
            poster_display_name=user.get("display_name"),
            # ``post_dict`` came from ``_mm_post_to_dict``, which already
            # computed the author's avatar — reuse it so the create-side
            # response matches the read-side payload exactly.
            avatar=post_dict.get("avatar"),
            status=row.status,
            updated_at=format_db_timestamp(row.updated_at) if row.updated_at else None,
            parent_post_id=row.parent_post_id,
            parent_preview=TableRead.mm_post_parent_preview(db, row.parent_post_id),
            link_preview=row.link_preview,
            files=[MmFileResponse(**f) for f in post_dict.get("files", [])],
            client_msg_uuid=body.client_msg_uuid,
            # Echo the trace id onto the create response + post.created SSE so
            # the sender (and the tracer) sees its turn's id on the way out.
            trace_id=body.trace_id,
        )

        # Fan-out targets for the global SSE stream: all human members of
        # the channel get the post.created on their per-user topic so their
        # sidebar updates without being subscribed to the channel itself.
        member_human_ids = TableRead.get_mm_channel_human_member_ids(db, channel_id)

        # Snapshot channel agents for the server-side attention pass while we
        # still hold the session (the pass runs fire-and-forget, past the
        # request). Returns None (cheap: one org PK get) unless the channel's org
        # has armed the gate — that org opt-in is the product switch now.
        attention_ctx = build_attention_context(db, channel_id)

        # Shape the `/cb-usage` agent reply for the same SSE fan-out as the human
        # post, so the balance answer arrives live in the channel.
        usage_reply_payload = None
        if usage_reply_id is not None:
            reply_row = db.get(MmPost, usage_reply_id)
            if reply_row is not None:
                reply_dict = TableRead._mm_post_to_dict(db, reply_row, None)
                reply_dict.pop("_raw_created_at", None)
                usage_reply_payload = MmPostResponse(**reply_dict).model_dump()

    bus = get_bus()
    fire_and_forget(
        publish_post_created(
            bus, channel_id, response.model_dump(), member_human_ids=member_human_ids
        )
    )
    # Server-side LobsterTalk: decide (and, later, deliver) whether any channel
    # agent should look at this human post. author_agent_id=None → human author.
    if attention_ctx is not None:
        fire_and_forget(
            consider_post(
                post=response.model_dump(),
                channel_id=channel_id,
                context=attention_ctx,
                author_agent_id=None,
                engine=getattr(request.app, "_engine", None),
            )
        )
    if usage_reply_payload is not None:
        fire_and_forget(
            publish_post_created(
                bus, channel_id, usage_reply_payload, member_human_ids=member_human_ids
            )
        )
    fire_and_forget(
        publish_channel_read(bus, user["id"], channel_id, post_id)
    )
    # Posting clears the "typing" entry so the bubble disappears for
    # other viewers. The author's global online state is refreshed by
    # the heartbeat hook on the frontend; we don't piggyback it here.
    fire_and_forget(bus.presence_clear(channel_id, "human", user["id"]))
    return response


# ---------------------------------------------------------------------------
# GET /api/human/mm/channels/{channel_id}/posts
# ---------------------------------------------------------------------------

@human_mm_router.get("/api/human/mm/channels/{channel_id}/posts")
async def list_posts(
    channel_id: str,
    request: Request,
    limit: int = 50,
    offset: int = 0,
    before_post_id: int | None = None,
    after_post_id: int | None = None,
    if_none_match: str | None = Header(default=None),
    user: dict = Depends(get_current_human_user),
):
    """Get posts from a channel, newest first. Caller must be a member.
    If `before_post_id` is set, returns posts strictly older than that id
    (cursor-based pagination for scrolling up through history). If
    `after_post_id` is set, returns posts strictly newer than that id
    (scroll-down through an anchored history window opened by a jump-to-
    pinned / deep-link; the live tail uses neither cursor).

    Drafts (status='draft', awaiting owner approval) and rejected posts
    are included when the caller may act on the target agent or when the
    caller authored the pending post.

    ETag/304: the response includes a hash of its own body. If the client
    sends ``If-None-Match`` matching the current state the server returns
    304 with no body — for the 30s safety-net poll on a quiet channel,
    this collapses to a tiny header round-trip. Combined with the
    presigned-URL cache (URLs stay stable until ~55 min), responses are
    byte-deterministic across polls when nothing has changed.
    """
    cfg = load_file_config()
    presigner = getattr(request.app, "_r2_presigner", None)
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        posts = TableRead.get_mm_posts_for_human(
            db, channel_id, user["id"], limit, offset, before_post_id,
            after_post_id=after_post_id,
        )
        for p in posts:
            enrich_post_files_with_urls(p, presigner, ttl=cfg.download_url_ttl)
        response_model = MmPostListResponse(
            posts=[MmPostResponse(**p) for p in posts],
            total=len(posts), limit=limit, offset=offset,
        )

    # ETag = md5 of the canonicalised JSON body. We hash the body anyway
    # since the global cache-control middleware sets ``no-store`` (which
    # would block browser-native If-None-Match), so this validation lives
    # entirely in app code — the client echoes back the last seen ETag.
    body = response_model.model_dump_json()
    etag = '"' + hashlib.md5(body.encode("utf-8")).hexdigest() + '"'
    if if_none_match == etag:
        # 304 must carry the ETag so the client knows what to keep using.
        return Response(status_code=304, headers={"ETag": etag})
    return JSONResponse(
        content=json.loads(body),
        headers={"ETag": etag},
    )


# ---------------------------------------------------------------------------
# GET /api/human/mm/search — message content search (see SEARCH_SPEC.md)
# ---------------------------------------------------------------------------

@human_mm_router.get("/api/human/mm/search", response_model=MmSearchResponse)
async def search_messages(
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
    """Full-text search over message content the caller can see.

    Scope is every channel/DM the caller is a member of, optionally narrowed
    to one ``org_id`` and/or a single ``channel_id`` (in-channel search).
    Operator filters (resolved to ids client-side): ``from_human_id`` /
    ``from_agent_id`` (``from:``), ``before`` / ``after`` (``YYYY-MM-DD``),
    ``has_link`` / ``has_file`` (``has:``). Only ``published`` posts in
    plaintext channels are searched — encrypted channels store their content
    in a separate table and are never reachable here. ``sort`` is ``recent``
    (default, newest-first) or ``relevant`` (``ts_rank_cd``). ``cursor`` is the
    opaque ``next_cursor`` from the previous page. A blank query returns no
    results unless an operator filter is present (then it's a filter listing).
    """
    sort = sort if sort in ("recent", "relevant") else "recent"
    limit = max(1, min(limit, 50))
    decoded = decode_search_cursor(cursor)
    with _get_db(request) as db:
        if org_id is not None and not TableRead.is_org_member(db, org_id, user["id"]):
            raise HTTPException(
                status_code=403, detail="Not a member of this organization"
            )
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
            cursor=decoded,
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


# ---------------------------------------------------------------------------
# GET /api/human/mm/channels/{channel_id}/posts/around/{post_id}
# Window of posts around a target — deep-link from a search result.
# ---------------------------------------------------------------------------

@human_mm_router.get(
    "/api/human/mm/channels/{channel_id}/posts/around/{post_id}",
    response_model=MmPostListResponse,
)
async def list_posts_around(
    channel_id: str,
    post_id: int,
    request: Request,
    radius: int = 25,
    user: dict = Depends(get_current_human_user),
):
    """Window of posts surrounding ``post_id`` (newest-first) so a search hit
    can be opened in context and highlighted. Caller must be a member;
    visibility matches the channel history endpoint.
    """
    radius = max(1, min(radius, 50))
    cfg = load_file_config()
    presigner = getattr(request.app, "_r2_presigner", None)
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        posts = TableRead.get_mm_posts_around_for_human(
            db, channel_id, user["id"], post_id, radius
        )
        for p in posts:
            enrich_post_files_with_urls(p, presigner, ttl=cfg.download_url_ttl)
        return MmPostListResponse(
            posts=[MmPostResponse(**p) for p in posts],
            total=len(posts),
            limit=radius,
            offset=0,
        )


# ---------------------------------------------------------------------------
# GET /api/human/mm/channels/{channel_id}/timeline
# ---------------------------------------------------------------------------

@human_mm_router.get(
    "/api/human/mm/channels/{channel_id}/timeline",
    response_model=MmTimelineResponse,
)
async def list_timeline(
    channel_id: str,
    request: Request,
    limit: int = 50,
    before_created_at: str | None = None,
    user: dict = Depends(get_current_human_user),
):
    """Merged channel timeline (posts + inline events), newest first.

    This is the read-side counterpart to the separate ``mm_posts`` /
    ``mm_channel_events`` write paths: clients render a single
    chronological stream and the server hides the underlying split.

    Pagination is single-cursor by ``created_at``. The client passes
    back the ``next_cursor`` string verbatim — the server parses it as
    a microsecond-precision ISO timestamp and fetches strictly-older
    rows from both tables. Over-fetching by one row on each side lets
    us detect ``has_more`` without an extra count query.

    Post visibility rules (drafts/rejected restricted to the author or
    the agent's owner) are preserved via ``get_mm_posts_for_human``.
    Events have no per-viewer gating beyond channel membership."""
    cfg = load_file_config()
    presigner = getattr(request.app, "_r2_presigner", None)
    cursor_dt: datetime | None = None
    if before_created_at:
        try:
            cursor_dt = datetime.fromisoformat(before_created_at)
        except ValueError as e:
            raise HTTPException(
                status_code=400, detail="invalid before_created_at",
            ) from e
    over_limit = limit + 1
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        posts = TableRead.get_mm_posts_for_human(
            db, channel_id, user["id"],
            limit=over_limit,
            before_created_at=cursor_dt,
        )
        events = TableRead.get_mm_channel_events(
            db, channel_id,
            limit=over_limit,
            before_created_at=cursor_dt,
        )
        for p in posts:
            enrich_post_files_with_urls(p, presigner, ttl=cfg.download_url_ttl)

    # Merge newest-first. Each tuple carries the full-precision sort
    # key (TIMESTAMPTZ from the DB row + integer ID) and the payload
    # dict. Sort key precision matters at the page boundary: a
    # seconds-truncated cursor would silently drop rows produced
    # later in the same second as the cursor row.
    merged: list[tuple[datetime, int, str, dict]] = []
    for p in posts:
        merged.append((p["_raw_created_at"], p["post_id"], "post", p))
    for e in events:
        merged.append((e["_raw_created_at"], e["event_id"], "event", e))
    # Sort by (datetime desc, id desc) so newer-and-higher-id wins ties.
    merged.sort(key=lambda r: (r[0], r[1]), reverse=True)

    page = merged[:limit]
    has_more = len(merged) > limit
    rows: list[MmHistoryRow] = []
    for _raw_dt, _id, kind, payload in page:
        # Pydantic v2's default ``extra="ignore"`` quietly drops the
        # internal ``_raw_created_at`` key when building the response
        # model, so the wire shape matches the schema.
        if kind == "post":
            rows.append(
                MmHistoryRow(kind="post", post=MmPostResponse(**payload))
            )
        else:
            rows.append(
                MmHistoryRow(
                    kind="event", event=MmChannelEventResponse(**payload)
                )
            )

    next_cursor: str | None = None
    if has_more and page:
        next_cursor = page[-1][0].isoformat()
    return MmTimelineResponse(
        rows=rows, has_more=has_more, next_cursor=next_cursor,
    )


# ---------------------------------------------------------------------------
# GET /api/human/mm/channels/{channel_id}/inline-events
# ---------------------------------------------------------------------------
#
# Path is ``inline-events`` to disambiguate from the per-channel SSE
# stream rooted at ``/events`` (which has lived at that URL since the
# original Mattermost-style fanout). "Inline" reflects how these
# events render — in-line with posts in the timeline — and matches
# the table name (``mm_channel_events``).

@human_mm_router.get(
    "/api/human/mm/channels/{channel_id}/inline-events",
    response_model=MmChannelEventListResponse,
)
async def list_channel_events(
    channel_id: str,
    request: Request,
    limit: int = 100,
    user: dict = Depends(get_current_human_user),
):
    """Flat list of inline channel events, newest first.

    A parallel read source to ``/posts`` for clients that prefer to
    keep the post and event streams cached separately and merge at
    render time (rather than consuming the unified ``/timeline`` view).
    Caller must be a channel member."""
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        events = TableRead.get_mm_channel_events(db, channel_id, limit=limit)
    return MmChannelEventListResponse(
        events=[MmChannelEventResponse(**e) for e in events],
        total=len(events),
    )


# ---------------------------------------------------------------------------
# GET /api/human/mm/channels/{channel_id}/export
#
# "Download this conversation" — one JSON archive of a channel or DM.
# Same read helper (and therefore the same visibility rules) as the
# history endpoint, paged to the end instead of one screen at a time.
# ---------------------------------------------------------------------------

# Ceiling on posts in one export. Each post costs a few extra lookups in
# the read helper (reactions, files, parent preview, avatar), so an
# unbounded export of a years-old channel would hold a DB connection for
# minutes and build a response nobody can open. Past the cap we return the
# newest slice and set ``truncated`` — never a silent cut.
MAX_EXPORT_POSTS = 20_000
# Membership events are orders of magnitude rarer than posts, so one query
# with a generous cap replaces paging here.
MAX_EXPORT_EVENTS = 5_000
_EXPORT_PAGE = 500


def _export_filename(channel: dict) -> str:
    """ASCII-safe ``filename=`` for the download's Content-Disposition.

    The channel name is user-controlled and lands in a response header, so
    everything outside a conservative allowlist is folded to ``-`` — a
    quote or newline in a channel name must not be able to close the header
    value or start a new one. An all-symbol name reduces to the channel id,
    which is always safe."""
    raw = channel.get("display_name") or channel.get("name") or ""
    slug = "".join(c if c.isalnum() or c in "-_" else "-" for c in raw).strip("-")
    # Collapse runs of the separator left behind by stripped characters.
    while "--" in slug:
        slug = slug.replace("--", "-")
    slug = slug[:60] or channel["channel_id"]
    return f"clawbits-{slug}-{datetime.now(UTC).date().isoformat()}.json"


@human_mm_router.get(
    "/api/human/mm/channels/{channel_id}/export",
    response_model=MmChannelExportResponse,
)
async def export_channel(
    channel_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Download the full history of one conversation as a JSON archive.

    Works identically for a group/public channel and a DM — membership is
    the only gate, and for an agent DM ``_require_human_member`` also
    enforces the agent's contact allowlist, so a human whose ``can_dm``
    grant was revoked can't export the backlog they can no longer read.

    Posts come back **oldest-first** (an archive reads top to bottom) and
    carry attachment metadata only: no presigned URLs, which would expire
    within the hour and make the file look like it held the attachments.
    Per-post visibility is delegated to the same helper the history
    endpoint uses, so an export can never surface a draft or rejected post
    the caller couldn't already see in the channel.

    Response is served as an attachment; the body is capped at
    ``MAX_EXPORT_POSTS`` with ``truncated`` marking a conversation longer
    than that.
    """
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        channel = TableRead.get_mm_channel(db, channel_id)
        if channel is None:
            raise HTTPException(status_code=404, detail="Channel not found")
        members = TableRead.get_mm_channel_members(db, channel_id)
        events = TableRead.get_mm_channel_events(
            db, channel_id, limit=MAX_EXPORT_EVENTS
        )

        # Page backwards from the newest post. An empty page ends the walk,
        # matching what scroll-up in the UI would reach — the export is a
        # copy of the caller's view of the channel, not a privileged dump.
        posts: list[dict] = []
        truncated = False
        cursor: int | None = None
        while True:
            page = TableRead.get_mm_posts_for_human(
                db, channel_id, user["id"],
                limit=_EXPORT_PAGE,
                before_post_id=cursor,
            )
            if not page:
                break
            posts.extend(page)
            cursor = page[-1]["post_id"]
            if len(posts) >= MAX_EXPORT_POSTS:
                # Overshooting the cap mid-page means the trim below drops
                # posts we already hold — truncated, no question. Landing
                # exactly on it is ambiguous, so probe for an older post
                # rather than mislabel a channel that ends right here. The
                # probe has to run before the trim: ``cursor`` is the oldest
                # post *fetched*, which the trim may pull back.
                truncated = len(posts) > MAX_EXPORT_POSTS or bool(
                    TableRead.get_mm_posts_for_human(
                        db, channel_id, user["id"], limit=1, before_post_id=cursor,
                    )
                )
                del posts[MAX_EXPORT_POSTS:]
                break

    posts.reverse()
    events.reverse()
    body = MmChannelExportResponse(
        exported_at=format_db_timestamp(datetime.now(UTC)),
        exported_by_human_id=user["id"],
        channel=MmChannelResponse(**channel),
        members=[MmExportMember(**m) for m in members],
        posts=[MmPostResponse(**p) for p in posts],
        events=[MmChannelEventResponse(**e) for e in events],
        post_count=len(posts),
        truncated=truncated,
    )
    return JSONResponse(
        content=json.loads(body.model_dump_json()),
        headers={
            "Content-Disposition": f'attachment; filename="{_export_filename(channel)}"',
        },
    )


# ---------------------------------------------------------------------------
# GET /api/human/mm/channels/{channel_id}/attachments
# GET /api/human/mm/channels/{channel_id}/links
#
# Read-side views over channel content, sliced for the mobile
# "chat details" screen (Media / Files / Links tabs). Caller must be a
# channel member.
# ---------------------------------------------------------------------------

_ALLOWED_ATTACHMENT_KINDS = {"image", "video", "media", "file", "all"}
_ATTACHMENTS_LIMIT_MAX = 200
_LINKS_LIMIT_MAX = 100


@human_mm_router.get(
    "/api/human/mm/channels/{channel_id}/attachments",
    response_model=MmFileListResponse,
)
async def list_channel_attachments(
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
    """Uploaded attachments in a channel, sliced by content-type and
    paginated newest-first.

    **Filtering** — pass either ``kind`` (a broad bucket) or
    ``content_type`` (specific MIME). ``content_type`` wins when both
    are provided.

      - ``kind=image`` / ``kind=video`` — files whose ``content_type``
        starts with that prefix.
      - ``kind=media`` (default) — image + video in one chronological
        stream so a video posted between two images stays in place.
      - ``kind=file`` — everything that is neither image/* nor video/*
        (audio, PDFs, arbitrary uploads).
      - ``kind=all`` — no content-type filter; returns every uploaded
        attachment in the channel.
      - ``content_type=application/pdf`` — exact MIME match.
      - ``content_type=audio/`` — prefix match (trailing slash).

    **Pagination** — prefer ``before_file_id``: pass the previous
    response's ``next_cursor`` to read the next page. The cursor
    encodes ``(created_at, file_id)`` of the last item; readers stay
    correct under concurrent inserts and pagination cost is O(limit)
    at any depth, backed by ``ix_mm_files_channel_listing``. ``offset``
    is also supported for jump-to-page UIs but becomes slow past a
    few thousand rows.

    **Totals** — by default the response omits ``total`` because the
    underlying ``COUNT(*)`` is O(matching_rows). Set
    ``include_total=true`` on the first page if a UI needs to show a
    badge count; subsequent pages should leave it false.

    The response items use the same :class:`MmFileResponse` shape that
    the posts endpoint embeds. ``thumbnail_url`` is presigned for any file
    that has a poster/thumbnail (images and videos — the composer captures
    a client-side poster frame for video). The eager full ``download_url``
    is inlined only for images; videos and other files keep it null and
    fetch on demand via ``/files/{id}/url``.
    """
    if kind not in _ALLOWED_ATTACHMENT_KINDS:
        raise HTTPException(
            status_code=422,
            detail=f"kind must be one of {sorted(_ALLOWED_ATTACHMENT_KINDS)}",
        )
    if content_type is not None and not content_type.strip():
        raise HTTPException(
            status_code=422,
            detail="content_type must be non-empty when provided",
        )
    if limit < 1 or limit > _ATTACHMENTS_LIMIT_MAX:
        raise HTTPException(
            status_code=422,
            detail=f"limit must be between 1 and {_ATTACHMENTS_LIMIT_MAX}",
        )
    if offset < 0:
        raise HTTPException(status_code=422, detail="offset must be non-negative")

    cfg = load_file_config()
    presigner = getattr(request.app, "_r2_presigner", None)
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])

        before_cursor = None
        if before_file_id is not None:
            cursor_row = TableRead.get_mm_file(db, before_file_id)
            # Cursor must reference a file in *this* channel — otherwise a
            # client could pass any file_id and get a window into a
            # channel they're not a member of by accident. The visibility
            # check above already gates the channel itself; this gate
            # protects the cursor's bounding semantics.
            if cursor_row is None or cursor_row.channel_id != channel_id:
                raise HTTPException(
                    status_code=422,
                    detail="before_file_id does not match a file in this channel",
                )
            before_cursor = (cursor_row.created_at, cursor_row.file_id)

        try:
            rows = TableRead.get_mm_files_for_channel(
                db,
                channel_id,
                kind=kind,
                content_type=content_type,
                limit=limit,
                offset=offset,
                before_cursor=before_cursor,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        # ``limit + 1`` fetch trick — the extra row tells us "more
        # exists" without a separate COUNT query. Trim before serializing.
        has_more = len(rows) > limit
        if has_more:
            rows = rows[:limit]

        total: int | None = None
        if include_total:
            try:
                total = TableRead.count_mm_files_for_channel(
                    db, channel_id, kind=kind, content_type=content_type,
                )
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc

        files = [
            build_file_response(r, presigner, ttl=cfg.download_url_ttl)
            for r in rows
        ]

    next_cursor = rows[-1].file_id if (has_more and rows) else None
    return MmFileListResponse(
        files=files,
        limit=limit,
        has_more=has_more,
        next_cursor=next_cursor,
        offset=offset if offset else None,
        total=total,
    )


@human_mm_router.get(
    "/api/human/mm/channels/{channel_id}/links",
    response_model=MmLinkListResponse,
)
async def list_channel_links(
    channel_id: str,
    request: Request,
    limit: int = 50,
    before_post_id: int | None = None,
    offset: int = 0,
    user: dict = Depends(get_current_human_user),
):
    """URLs extracted from message bodies in a channel, newest first.

    There is no pre-built URL index — the endpoint scans the most
    recent ``_LINKS_SCAN_PAGE_MAX`` posts and runs the same extractor
    the mobile client uses (:func:`extract_urls`). URLs are
    deduplicated within the page; the freshest occurrence wins. The
    client follows up with ``POST /link-preview`` per URL for OG
    metadata.

    **Pagination** — ``before_post_id`` is the preferred cursor (same
    pattern as ``GET /channels/{id}/posts``). Pass back
    ``next_cursor`` from the previous response. ``offset`` is also
    supported as a fallback but loses correctness under concurrent
    inserts.

    The response is bounded by ``limit`` distinct URLs. ``has_more``
    is set when the scan window saturated — there may be older links
    behind the cursor (a deep scan that finds only repeats of URLs we
    already returned still leaves ``has_more`` true; the next page
    will resume from where this one stopped scanning).
    """
    if limit < 1 or limit > _LINKS_LIMIT_MAX:
        raise HTTPException(
            status_code=422,
            detail=f"limit must be between 1 and {_LINKS_LIMIT_MAX}",
        )
    if offset < 0:
        raise HTTPException(status_code=422, detail="offset must be non-negative")
    # Scan a wider window of posts than ``limit`` because most messages
    # carry no URL — clamping the scan to ``limit`` would frequently
    # return an empty page on a chatty channel.
    scan_limit = _LINKS_SCAN_PAGE_MAX
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        posts = TableRead.get_mm_posts_with_text_for_channel(
            db,
            channel_id,
            limit=scan_limit,
            offset=offset,
            before_post_id=before_post_id,
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
    has_more = len(posts) >= scan_limit
    next_cursor = last_scanned_post_id if has_more else None
    return MmLinkListResponse(
        links=items,
        limit=limit,
        has_more=has_more,
        next_cursor=next_cursor,
        offset=offset if offset else None,
    )


# ---------------------------------------------------------------------------
# Chat attachments
#   POST   /api/human/mm/channels/{channel_id}/files     — request upload URL
#   POST   /api/human/mm/files/{file_id}/confirm         — finalize upload
#   GET    /api/human/mm/files/{file_id}/url             — get download URL
#   DELETE /api/human/mm/files/{file_id}                 — soft delete
# ---------------------------------------------------------------------------

@human_mm_router.post(
    "/api/human/mm/channels/{channel_id}/files",
    response_model=MmFileUploadResponse,
)
async def request_file_upload(
    channel_id: str,
    body: MmFileUploadRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Reserve an ``mm_files`` row and return a presigned PUT URL.

    The client uploads bytes directly to R2 with the returned URL — the
    backend never sees the file content. After the PUT succeeds the
    client must call ``/files/{id}/confirm`` to flip the row to
    ``status='uploaded'``; if it never does, the row is GC'd after 24h.
    """
    cfg = load_file_config()
    presigner = _require_presigner(request)

    if body.size_bytes > cfg.max_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"File too large: {body.size_bytes} bytes (max {cfg.max_bytes})",
        )
    if not is_mime_allowed(body.content_type, cfg.mime_allowlist):
        raise HTTPException(
            status_code=415,
            detail=f"Content type not allowed: {body.content_type}",
        )

    file_id = new_file_id()
    object_key = build_object_key(file_id, body.filename)
    thumb_key = (
        build_object_key(file_id, body.filename, thumbnail=True)
        if body.has_thumbnail
        else None
    )

    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        TableWrite.create_mm_file(
            db,
            file_id=file_id,
            channel_id=channel_id,
            uploader_human_id=user["id"],
            filename=body.filename,
            content_type=body.content_type,
            size_bytes=body.size_bytes,
            object_key=object_key,
            thumbnail_object_key=thumb_key,
            sha256=body.sha256,
        )
        db.commit()

    # TTL is short on purpose — the client should PUT immediately. If
    # the upload is slow on a residential connection, 5 min still covers
    # a 15 MB file at ~50 kB/s.
    put = presigner.presign_put(
        object_key,
        body.content_type,
        content_length=body.size_bytes,
        expires=300,
    )
    thumb_put: dict | None = None
    if thumb_key is not None and body.thumbnail_size_bytes is not None:
        # Thumbnails are always JPEG (the client generates them via Canvas).
        thumb_put = presigner.presign_put(
            thumb_key,
            "image/jpeg",
            content_length=body.thumbnail_size_bytes,
            expires=300,
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
    """Mark a pending file ``uploaded`` and record metadata.

    Called by the client after the PUT to R2 succeeds. Idempotent on an
    already-confirmed file owned by the same caller.
    """
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
        needs_probe = (
            row.content_type.startswith("image/")
            and (row.width is None or row.height is None)
        )
        # Prefer the thumbnail — a small fetch with the original's aspect
        # ratio. Trade-off: the stored width/height are then thumbnail-scale
        # (≤1024), not the original's absolute pixel size; the frontend only
        # needs them for the aspect-ratio box, so that's acceptable.
        probe_key = (
            row.thumbnail_object_key
            if row.thumbnail_object_key
            else row.object_key
        )

    # Server-side dimension probe — fallback for clients that couldn't
    # extract dims (Canvas decode failure, headless, etc.). Runs outside
    # the DB context manager because it does network I/O; commits the
    # result in a fresh session if successful. The chat-scroll rewrite
    # relies on every image post having dims so the message row reserves
    # the correct aspect-ratio box at first paint.
    if needs_probe:
        presigner = getattr(request.app, "_r2_presigner", None)
        if presigner is not None:
            dims = await probe_image_dimensions(presigner, probe_key)
            if dims is not None:
                w, h = dims
                with _get_db(request) as db:
                    # Metadata-only write-back: ``thumbnail_uploaded`` stays
                    # unset (None) so the client's just-confirmed thumbnail
                    # key is not clobbered.
                    TableWrite.confirm_mm_file(
                        db,
                        file_id,
                        uploader_human_id=user["id"],
                        width=w,
                        height=h,
                    )
                    db.commit()

    from clawbits.db.models import MmFile  # noqa: PLC0415

    with _get_db(request) as db:
        # Re-read so the response carries the probed dims when applicable.
        row = db.get(MmFile, file_id)
        if row is None:
            raise HTTPException(status_code=404, detail="file disappeared")
        # The confirm response is the metadata view of the row. We don't
        # inline a download URL here — the client just uploaded, it has
        # the bytes in memory.
        return build_file_response(row, presigner=None, ttl=0)


@human_mm_router.get(
    "/api/human/mm/files/{file_id}/url",
    response_model=MmFileDownloadUrlResponse,
)
async def get_file_download_url(
    file_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Issue a short-lived presigned GET URL for a file.

    Authz: caller must be a member of the channel the file is attached
    to. Soft-deleted files return 404 (the file is treated as gone).
    """
    cfg = load_file_config()
    presigner = _require_presigner(request)

    with _get_db(request) as db:
        row = TableRead.get_mm_file(db, file_id)
        if row is None:
            raise HTTPException(status_code=404, detail="File not found")
        if row.status != "uploaded":
            raise HTTPException(
                status_code=409,
                detail=f"File not ready (status={row.status})",
            )
        _require_human_member(db, row.channel_id, user["id"])
        # Video/audio get a longer-lived signature so playback doesn't 403
        # mid-watch (see ``media_download_url_ttl``). Safe to vary the TTL on
        # the shared ``:original`` cache key: the post-list enricher only
        # signs ``:original`` for images, so a media file's entry is minted
        # solely here.
        ct = (row.content_type or "").lower()
        is_media = ct.startswith("video/") or ct.startswith("audio/")
        ttl = cfg.media_download_url_ttl if is_media else cfg.download_url_ttl
        # Go through the same cache used by the post-list enricher so we
        # don't churn signatures, and so the client sees an ``expires_at``
        # consistent with what it gets via the post payload.
        url, expires_at = cached_presigned_get(
            presigner,
            cache_key=f"{row.file_id}:original",
            object_key=row.object_key,
            ttl=ttl,
            download_filename=row.filename,
        )
        expires_in = max(0, expires_at - int(_time.time()))
        return MmFileDownloadUrlResponse(
            url=url, expires_in=expires_in, expires_at=expires_at
        )


@human_mm_router.delete(
    "/api/human/mm/files/{file_id}",
    status_code=204,
    response_class=Response,
)
async def delete_file(
    file_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Soft-delete a file owned by the caller.

    Returns 204 on success, 404 if the file doesn't exist or is owned by
    someone else. R2 object removal is the GC job's responsibility — we
    only flip the row state here.
    """
    with _get_db(request) as db:
        row = TableWrite.soft_delete_mm_file(
            db, file_id, uploader_human_id=user["id"]
        )
        db.commit()
    if row is None:
        raise HTTPException(status_code=404, detail="File not found")
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# PATCH /api/human/mm/posts/{post_id}
# ---------------------------------------------------------------------------

@human_mm_router.patch(
    "/api/human/mm/posts/{post_id}", response_model=MmPostResponse
)
async def edit_post(
    post_id: int,
    body: MmPostEditRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Rewrite the text of a previously-published post the caller authored.

    Slack/Discord-style edit: no time limit, author-only, post stays
    published, ``edited_at`` is stamped so the UI can render the "(edited)"
    marker permanently. Other channel members see the change via
    ``post.updated`` SSE.
    """
    from clawbits.db.models import HumanUser, MmPost

    # Re-resolve the embedded OG card against the new message body so the
    # client doesn't fall back to its async fetch path post-edit.
    # ``None`` is a meaningful value here: an edited message with no
    # URL clears any previously-embedded card.
    embedded_preview = await _resolve_embedded_link_preview(get_bus(), body.message)

    with _get_db(request) as db:
        try:
            TableWrite.edit_mm_post_human(
                db, post_id, user["id"], body.message,
                link_preview=embedded_preview,
            )
        except LookupError:
            raise HTTPException(status_code=404, detail="Post not found")
        except PermissionError as exc:
            raise HTTPException(status_code=403, detail=str(exc))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        db.commit()

        row = db.get(MmPost, post_id)
        if row is None:
            raise HTTPException(status_code=500, detail="Failed to retrieve post")
        u = db.get(HumanUser, row.human_id) if row.human_id else None
        post_dict = TableRead._mm_post_to_dict(db, row, u)
        response = MmPostResponse(**post_dict)

    bus = get_bus()
    fire_and_forget(publish_post_updated(bus, response.channel_id, response.model_dump()))
    return response


# ---------------------------------------------------------------------------
# DELETE /api/human/mm/posts/{post_id}
# ---------------------------------------------------------------------------

@human_mm_router.delete(
    "/api/human/mm/posts/{post_id}",
    status_code=204,
    response_class=Response,
)
async def delete_post(
    post_id: int,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Hard-delete a post. Author or channel creator only.

    Returns 204 on success, 404 if the post doesn't exist, 403 if the
    caller is neither the author nor the channel creator. Replies that
    quoted the deleted post are detached (parent set to NULL) so the
    thread tail remains visible. Reactions cascade automatically;
    attached files are unbound (set NULL on post_id).
    """
    with _get_db(request) as db:
        try:
            snapshot = TableWrite.delete_mm_post_human(db, post_id, user["id"])
        except LookupError:
            raise HTTPException(status_code=404, detail="Post not found")
        except PermissionError as exc:
            raise HTTPException(status_code=403, detail=str(exc))
        channel_id = snapshot.channel_id
        # Fan out to every member so the sidebar can reconcile preview /
        # unread count if the deleted row was the channel's last message.
        member_human_ids = TableRead.get_mm_channel_human_member_ids(db, channel_id)
        db.commit()

    bus = get_bus()
    fire_and_forget(
        publish_post_deleted(
            bus, channel_id, post_id, member_human_ids=member_human_ids
        )
    )
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# POST /api/human/mm/posts/{post_id}/reactions
# ---------------------------------------------------------------------------

@human_mm_router.post(
    "/api/human/mm/posts/{post_id}/reactions", response_model=MmPostResponse
)
async def toggle_reaction(
    post_id: int,
    body: MmReactionRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Toggle a reaction. Caller must be a member of the post's channel.

    Slack/Discord semantics: if the caller already reacted with this emoji
    on this post, the row is deleted; otherwise it's inserted. Returns the
    fully-rehydrated post (with the new reactions array) and fans out a
    ``post.updated`` event so other viewers see the change in real time.
    """
    from clawbits.db.models import HumanUser, MmPost

    with _get_db(request) as db:
        post = db.get(MmPost, post_id)
        if post is None:
            raise HTTPException(status_code=404, detail="Post not found")
        _require_human_member(db, post.channel_id, user["id"])

        try:
            TableWrite.toggle_mm_post_reaction(
                db, post_id, body.emoji, human_id=user["id"],
            )
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        db.commit()

        row = db.get(MmPost, post_id)
        if row is None:
            raise HTTPException(status_code=500, detail="Failed to retrieve post")
        u = db.get(HumanUser, row.human_id) if row.human_id else None
        post_dict = TableRead._mm_post_to_dict(db, row, u)
        response = MmPostResponse(**post_dict)

    bus = get_bus()
    fire_and_forget(publish_post_updated(bus, response.channel_id, response.model_dump()))
    return response


# ---------------------------------------------------------------------------
# Pinned messages
#
# POST   /api/human/mm/posts/{post_id}/pin     — pin a post
# DELETE /api/human/mm/posts/{post_id}/pin     — unpin a post
# GET    /api/human/mm/channels/{channel_id}/pins — list pinned posts
#
# Any channel member can pin or unpin (no per-role gating). Pin / unpin
# both fan out a ``post.updated`` event so connected clients can flip the
# small pin glyph on the message and invalidate the pinned list cache.
# ---------------------------------------------------------------------------


def _rehydrate_post_response(db: Session, post_id: int) -> MmPostResponse:
    """Reload a post and wrap it in the standard response envelope.

    Used after a pin/unpin mutation so the fan-out event carries the
    full post payload, exactly matching what other ``post.updated``
    publishers do (see edit / react)."""
    from clawbits.db.models import HumanUser, MmPost

    row = db.get(MmPost, post_id)
    if row is None:
        raise HTTPException(status_code=500, detail="Failed to retrieve post")
    u = db.get(HumanUser, row.human_id) if row.human_id else None
    post_dict = TableRead._mm_post_to_dict(db, row, u)
    return MmPostResponse(**post_dict)


@human_mm_router.post(
    "/api/human/mm/posts/{post_id}/pin", response_model=MmPostResponse
)
async def pin_post(
    post_id: int,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Pin a channel post. Idempotent — re-pinning does not bump the
    timestamp. Caller must be a member of the post's channel."""
    from clawbits.db.models import MmPost

    with _get_db(request) as db:
        post = db.get(MmPost, post_id)
        if post is None:
            raise HTTPException(status_code=404, detail="Post not found")
        _require_human_member(db, post.channel_id, user["id"])

        try:
            TableWrite.pin_mm_post_human(db, post_id, user["id"])
        except LookupError:
            raise HTTPException(status_code=404, detail="Post not found")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        db.commit()
        response = _rehydrate_post_response(db, post_id)

    bus = get_bus()
    fire_and_forget(publish_post_updated(bus, response.channel_id, response.model_dump()))
    return response


@human_mm_router.delete(
    "/api/human/mm/posts/{post_id}/pin", response_model=MmPostResponse
)
async def unpin_post(
    post_id: int,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Unpin a channel post. Idempotent — unpinning an unpinned post is
    a no-op. Caller must be a member of the post's channel."""
    from clawbits.db.models import MmPost

    with _get_db(request) as db:
        post = db.get(MmPost, post_id)
        if post is None:
            raise HTTPException(status_code=404, detail="Post not found")
        _require_human_member(db, post.channel_id, user["id"])

        try:
            TableWrite.unpin_mm_post_human(db, post_id)
        except LookupError:
            raise HTTPException(status_code=404, detail="Post not found")
        db.commit()
        response = _rehydrate_post_response(db, post_id)

    bus = get_bus()
    fire_and_forget(publish_post_updated(bus, response.channel_id, response.model_dump()))
    return response


@human_mm_router.get(
    "/api/human/mm/channels/{channel_id}/pins",
    response_model=MmPinnedListResponse,
)
async def list_pinned_posts(
    channel_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """List every pinned post in a channel, newest-pinned first.

    Returns the full set (no pagination) — pin counts in practice stay
    well under a hundred. Caller must be a channel member."""
    cfg = load_file_config()
    presigner = getattr(request.app, "_r2_presigner", None)
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        posts = TableRead.list_pinned_mm_posts(db, channel_id)
        # Inline presigned URLs for any attached images so the popover
        # can render thumbnails without an extra round-trip.
        for p in posts:
            enrich_post_files_with_urls(p, presigner, ttl=cfg.download_url_ttl)
        return MmPinnedListResponse(
            posts=[MmPostResponse(**p) for p in posts],
            total=len(posts),
        )


# ---------------------------------------------------------------------------
# POST /api/human/mm/direct
# ---------------------------------------------------------------------------

@human_mm_router.post("/api/human/mm/direct", response_model=MmChannelResponse)
async def create_or_get_direct(
    body: MmDirectUnifiedRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Open or get a DM channel between the current human user and a target (agent or human).

    The DM is scoped to ``body.org_id`` — that's the workspace the caller is in
    when they hit "New DM". Both parties must belong to that org. The same two
    people can have distinct DMs in different orgs (Slack-style)."""
    with _get_db(request) as db:
        human_id = user["id"]
        org_id = body.org_id

        if not TableRead.is_org_member(db, org_id, human_id):
            raise HTTPException(status_code=403, detail="Not a member of this organization")

        # Notify caller + (if human-to-human) target on a fresh creation.
        # Empty when we're returning an existing DM.
        notify_human_ids: list[int] = []

        if body.target_type == "human":
            target_human_id = int(body.target_id)
            if target_human_id == human_id:
                raise HTTPException(status_code=400, detail="Cannot create a DM channel with yourself")

            # Verify target exists and is a member of the same org.
            target = TableRead.get_human_user_by_id(db, target_human_id)
            if target is None:
                raise HTTPException(status_code=404, detail=f"Human user '{body.target_id}' not found")
            if not TableRead.is_org_member(db, org_id, target_human_id):
                raise HTTPException(status_code=403, detail="Target user is not a member of this organization")

            existing = TableRead.find_dm_channel_human_human(db, human_id, target_human_id, org_id)
            if existing:
                TableRead.apply_dm_peer_display(db, [existing], human_id)
                return MmChannelResponse(**existing)

            channel_id = str(uuid.uuid4())
            sorted_ids = sorted([human_id, target_human_id])
            dm_name = f"dm-human-{sorted_ids[0]}-human-{sorted_ids[1]}"
            display_a = user.get("display_name") or user.get("email", str(human_id))
            display_b = target.get("display_name") or target.get("email", str(target_human_id))
            TableWrite.create_mm_channel(
                db, channel_id,
                dm_name, "direct", display_name=f"DM: {display_a} ↔ {display_b}",
                org_id=org_id,
            )
            TableWrite.add_mm_channel_member_human(db, channel_id, human_id)
            TableWrite.add_mm_channel_member_human(db, channel_id, target_human_id)
            db.commit()
            notify_human_ids = [human_id, target_human_id]

        else:  # target_type == "agent"
            target_agent_id = body.target_id

            target = TableRead.get_agent_by_agentid(db, AgentId(target_agent_id))
            if target is None:
                raise HTTPException(status_code=404, detail=f"Agent '{target_agent_id}' not found")

            # The agent must be owned by the active org — otherwise the DM
            # would land in an org neither party can see together.
            agent_org_id = TableRead.get_agent_org_id(db, target_agent_id)
            if agent_org_id is None or org_id != agent_org_id:
                raise HTTPException(status_code=403, detail="Agent does not belong to this organization")

            # Contact is closed by default: only the operator and humans the
            # operator/org owner granted ``can_dm`` may open or re-open this DM.
            if not TableRead.can_dm_agent(db, target_agent_id, human_id=human_id):
                raise HTTPException(
                    status_code=403, detail="Not permitted to contact this agent"
                )

            existing = TableRead.find_dm_channel_human_agent(db, human_id, target_agent_id, org_id)
            if existing:
                TableRead.apply_dm_peer_display(db, [existing], human_id)
                return MmChannelResponse(**existing)

            channel_id = str(uuid.uuid4())
            dm_name = f"dm-human-{human_id}-agent-{target_agent_id}"
            display_h = user.get("display_name") or user.get("email", str(human_id))
            TableWrite.create_mm_channel(
                db, channel_id,
                dm_name, "direct", display_name=f"DM: {display_h} ↔ {target_agent_id}",
                org_id=org_id,
            )
            TableWrite.add_mm_channel_member_human(db, channel_id, human_id)
            TableWrite.add_mm_channel_member(db, channel_id, target_agent_id)
            db.commit()
            notify_human_ids = [human_id]

        ch = TableRead.get_mm_channel(db, channel_id)
        # Build per-recipient payloads so each viewer's channel.added event
        # carries their viewer-aware DM title (rather than a shared payload
        # that reads as "self" for one of the two participants).
        per_recipient_payloads: dict[int, dict] = {}
        for hid in notify_human_ids:
            ch_for_hid = dict(ch)
            TableRead.apply_dm_peer_display(db, [ch_for_hid], hid)
            per_recipient_payloads[hid] = MmChannelResponse(**ch_for_hid).model_dump()
        response = MmChannelResponse(**per_recipient_payloads.get(human_id, ch))
        agent_channel_payload = MmChannelResponse(**ch).model_dump() if body.target_type == "agent" else None

    # The DM channel row is brand new — await the avatar upload so its
    # URL resolves by the time the recipients render the channel.added
    # event. (Edge-caching 404s makes async risky here too.)
    # DMs get no overlay icon — they're rendered as a member-stack
    # tile via ChatAvatar on the client, so the underlying channel
    # avatar isn't user-visible.
    await await_channel_avatar(channel_id=channel_id, channel_type="direct")
    bus = get_bus()
    for hid in notify_human_ids:
        fire_and_forget(publish_channel_added(bus, hid, per_recipient_payloads[hid]))
    if agent_channel_payload is not None:
        await publish_agent_channel_added(bus, body.target_id, agent_channel_payload)
    return response


# ---------------------------------------------------------------------------
# GET /api/human/mm/channels/{channel_id}/events  (SSE stream)
# ---------------------------------------------------------------------------

@human_mm_router.get("/api/human/mm/channels/{channel_id}/events")
async def stream_events(
    channel_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> StreamingResponse:
    """Open an SSE stream of channel events (posts, member status).

    Connect with ``fetch`` (not ``EventSource``) so the ``Authorization:
    Bearer <JWT>`` header carries through. The response is a standard
    ``text/event-stream``.

    Membership is enforced for the stream's whole lifetime, not just at
    connect: the event filter below closes the stream the moment it sees
    the viewer's own removal cross the channel topic, and re-verifies
    membership on a short TTL as the backstop for revocation paths that
    publish nothing there (DM kick, channel deletion, ``can_dm``
    revocation).
    """
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])

    viewer_id = user["id"]
    last_check = _time.monotonic()

    def reauthorize_if_stale() -> None:
        """Re-verify membership at most once per TTL. Raises StreamClosed
        when access is gone. Shared by the per-event filter and the
        keepalive hook so a revoked stream closes whether or not events
        are flowing."""
        nonlocal last_check
        now = _time.monotonic()
        if now - last_check < MEMBERSHIP_RECHECK_TTL_SECONDS:
            return
        last_check = now
        try:
            with _get_db(request) as db:
                _require_human_member(db, channel_id, viewer_id)
        except HTTPException:
            raise StreamClosed() from None

    def allow_event(event: dict) -> bool:
        if event.get("type") == "channel.event":
            data = event.get("data") or {}
            if data.get("event_type") == "member.removed":
                removed_self = (
                    # Self-leave: create_mm_channel_event nulls the subject
                    # when actor == subject, so match on the actor instead.
                    data.get("subject_human_id") is None
                    and data.get("subject_agent_id") is None
                    and data.get("actor_human_id") == viewer_id
                )
                if data.get("subject_human_id") == viewer_id or removed_self:
                    raise StreamClosed()
        reauthorize_if_stale()
        return True

    bus = get_bus()
    # Per-channel presence now carries only the ``typing`` indicator —
    # the user's global online/idle state is owned by the per-user
    # heartbeat (POST /api/human/presence). The initial snapshot is
    # still useful so newly-connected clients see who is currently
    # typing in this channel.
    snapshot = [await build_presence_snapshot_event(bus, channel_id)]
    return await stream_channel_events(
        request,
        channel_id,
        initial_snapshot=snapshot,
        event_filter=allow_event,
        reauthorize=reauthorize_if_stale,
    )


# ---------------------------------------------------------------------------
# POST /api/human/mm/channels/{channel_id}/typing
# ---------------------------------------------------------------------------

@human_mm_router.post("/api/human/mm/channels/{channel_id}/typing", status_code=204)
async def typing_heartbeat(
    channel_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Signal the user is currently typing. TTL ~6s; call every ~3s.

    Suppressed silently when the caller has disabled typing indicators
    in their privacy settings — the request still returns 204 so the
    client doesn't need to special-case the toggle, but no peer ever
    sees them as typing.
    """
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        fresh = TableRead.get_human_user_by_id(db, user["id"])
    if not (fresh and fresh.get("typing_indicators_enabled", True)):
        return Response(status_code=204)
    bus = get_bus()
    await bus.presence_set(channel_id, "human", user["id"], "typing")
    await publish_member_status(bus, channel_id, "human", str(user["id"]), "typing")
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# POST /api/human/presence  — global online/idle/offline heartbeat
# GET  /api/human/users/{user_id}/presence  — read one user's status
# ---------------------------------------------------------------------------

@human_mm_router.post(
    "/api/human/presence", response_model=MmUserPresenceResponse
)
async def update_user_presence(
    body: MmUserPresenceRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> MmUserPresenceResponse:
    """Set the caller's global presence (online / idle / offline).

    Idempotent: same-status heartbeats refresh the Redis TTL silently
    and only persist ``last_seen_at`` every ~5 min. A transition
    (status changed) writes ``last_seen_at`` immediately and broadcasts
    ``user.status`` on the caller's per-user topic and to every channel
    they're a member of."""
    bus = get_bus()
    with _get_db(request) as db:
        await _apply_global_presence(bus, db, user["id"], body.status)
        fresh = TableRead.get_human_user_by_id(db, user["id"])
    out_status, out_last_seen, out_label = _resolve_presence_view(fresh, body.status)
    return MmUserPresenceResponse(
        human_id=user["id"],
        status=out_status,
        last_seen_at=out_last_seen,
        last_seen_label=out_label,
    )


@human_mm_router.get(
    "/api/human/users/{user_id}/presence", response_model=MmUserPresenceResponse
)
async def get_user_presence(
    user_id: int,
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> MmUserPresenceResponse:
    """Read another user's current presence + last_seen_at.

    Used by profile pages or anywhere we render a single user out of
    context (no SSE channel covering them). Auth gating is intentionally
    light — presence is broadcast on shared channels anyway."""
    del user  # auth-only dep
    bus = get_bus()
    status = await bus.user_presence_get(user_id)
    with _get_db(request) as db:
        u = TableRead.get_human_user_by_id(db, user_id)
    if u is None:
        raise HTTPException(status_code=404, detail="User not found")
    out_status, out_last_seen, out_label = _resolve_presence_view(u, status)
    return MmUserPresenceResponse(
        human_id=user_id,
        status=out_status,
        last_seen_at=out_last_seen,
        last_seen_label=out_label,
    )


# ---------------------------------------------------------------------------
# POST /api/human/mm/channels/{channel_id}/read  — advance read pointer
# ---------------------------------------------------------------------------

@human_mm_router.post(
    "/api/human/mm/channels/{channel_id}/read", response_model=MmMarkReadResponse
)
async def mark_channel_read(
    channel_id: str,
    body: MmMarkReadRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Mark a channel read up through ``post_id``. Idempotent; the pointer
    never moves backwards. Cross-tab sync via ``channel.read`` event on the
    user's global SSE stream.
    """
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        # Clamp the requested pointer to the channel's actual latest post
        # — frontends may pass an optimistic value when they only know
        # the latest they've rendered.
        fresh = TableRead.get_human_user_by_id(db, user["id"])
        latest = TableRead.get_mm_channel_latest_published_post_id(db, channel_id)
        target = body.post_id if latest is None else min(body.post_id, latest)
        new_last_read = TableWrite.mark_mm_channel_read(
            db, channel_id, user["id"], target
        )
        db.commit()

    # Always sync the caller's own tabs (their unread badge depends on
    # this), but suppress the peer-visible ``member.read`` broadcast
    # when the caller has read receipts disabled. Other channel members
    # won't see "Read" under their outgoing posts, but the caller's own
    # sidebar still clears the unread counter correctly.
    bus = get_bus()
    fire_and_forget(
        publish_channel_read(bus, user["id"], channel_id, new_last_read)
    )
    if fresh and fresh.get("read_receipts_enabled", True):
        fire_and_forget(
            publish_member_read(bus, user["id"], channel_id, new_last_read)
        )
    return MmMarkReadResponse(
        channel_id=channel_id, last_read_post_id=new_last_read
    )


# ---------------------------------------------------------------------------
# POST /api/human/mm/channels/{channel_id}/mute  — toggle mute flag
# ---------------------------------------------------------------------------

@human_mm_router.post(
    "/api/human/mm/channels/{channel_id}/mute", response_model=MmMuteResponse
)
async def mute_channel(
    channel_id: str,
    body: MmMuteRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Mute or unmute a channel for the current user. Muted channels still
    receive messages and accrue unread counts (Telegram-style), but are
    excluded from the global tab-title counter on the frontend.
    """
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        muted = TableWrite.set_mm_channel_muted(db, channel_id, user["id"], body.muted)
        db.commit()

    fire_and_forget(publish_channel_muted(get_bus(), user["id"], channel_id, muted))
    return MmMuteResponse(channel_id=channel_id, muted=muted)


# ---------------------------------------------------------------------------
# POST /api/human/mm/channels/{channel_id}/pin  — toggle pin flag
# ---------------------------------------------------------------------------

@human_mm_router.post(
    "/api/human/mm/channels/{channel_id}/pin", response_model=MmPinResponse
)
async def pin_channel(
    channel_id: str,
    body: MmPinRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Pin or unpin a channel for the current user. Pinned channels appear
    in a dedicated "Pins" section at the top of the sidebar; pin state is
    per-user, so other members of the channel see their own ordering."""
    with _get_db(request) as db:
        _require_human_member(db, channel_id, user["id"])
        pinned = TableWrite.set_mm_channel_pinned(db, channel_id, user["id"], body.pinned)
        db.commit()

    fire_and_forget(publish_channel_pinned(get_bus(), user["id"], channel_id, pinned))
    return MmPinResponse(channel_id=channel_id, pinned=pinned)


# ---------------------------------------------------------------------------
# GET /api/human/events  — global per-user SSE stream
# ---------------------------------------------------------------------------

@human_mm_router.get("/api/human/events")
async def stream_global_events(
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> StreamingResponse:
    """Open the global SSE stream for the current human user.

    Carries cross-channel events (sidebar unread updates, cross-tab read
    sync, mute sync). The per-channel ``…/channels/{id}/events`` stream
    stays for in-channel concerns (typing indicators, presence).

    The first frame is a ``server.hello`` carrying the running server
    version. A deploy restarts the server, every open stream drops, and the
    clients reconnect — so this frame reaches every tab on the next deploy
    for free, with no polling. A client whose bundle version differs from
    the announced one (a tab left open across a deploy) prompts a reload.
    """
    hello = {
        "type": "server.hello",
        "channel_id": "",
        "data": {"version": server_version()},
    }
    return await stream_human_events(
        request, user["id"], initial_snapshot=[hello]
    )


# ---------------------------------------------------------------------------
# POST /api/human/mm/link-preview  — OpenGraph unfurl
# ---------------------------------------------------------------------------

@human_mm_router.post(
    "/api/human/mm/link-preview", response_model=LinkPreviewResponse
)
async def link_preview(
    body: LinkPreviewRequest,
    user: dict = Depends(get_current_human_user),
) -> LinkPreviewResponse:
    """Fetch + parse OG / Twitter / ``<title>`` metadata for ``body.url``.

    Auth-gated to keep this from being usable as a public open-proxy
    scanner. The result is cached in Redis (24h on success, 5min on
    failure) so the same URL doesn't hit the network for every viewer
    of a chat message — one client unfurls it, every other client gets
    the cached card.

    Returns 200 even on fetch failure; the response carries ``error``
    set. Mobile / web clients can decide whether to render a degraded
    card or hide it entirely.
    """
    redis = await get_bus().redis_client()
    preview = await get_link_preview(redis, body.url)
    return LinkPreviewResponse(**preview.__dict__)
