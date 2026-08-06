"""SSE endpoints and helpers for realtime channel events.

The stream is a plain Server-Sent Events feed. The frontend connects via
``fetch`` (so the bearer token stays in the ``Authorization`` header, not
the URL) and parses the body as a standard ``text/event-stream``.

Two streams exist:

* :func:`stream_channel_events` — per-channel topic, drives the in-channel
  feed (typing, presence, post.created/updated for the channel).
* :func:`stream_human_events` — per-user topic, drives global concerns
  (sidebar unread badges, cross-tab read/mute sync). Implemented via
  fan-out: when a post is created in a channel, the publisher writes the
  same envelope to every member's per-user topic.

Event envelope (JSON on each SSE ``data:`` line):

    {
      "type": "post.created" | "post.updated" |
              "member.status" | "presence.snapshot" |
              "channel.read" | "channel.muted",
      "channel_id": "...",
      "data": {...}
    }
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import inspect
import json
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

from fastapi import Request
from fastapi.responses import StreamingResponse

from clawbits.datastructures.mm_models import (
    AgentLivenessStatus,
    AgentPresenceStatus,
    GlobalUserStatus,
    MemberKind,
    RealtimeEventType,
)
from clawbits.realtime.bus import (
    EventBus,
    agent_topic,
    channel_topic,
    get_bus,
    get_publish_loop,
    human_topic,
)

log = logging.getLogger(__name__)

# Keepalive cadence — browsers and proxies kill idle connections around
# 60–120s; a comment frame every 20s is a common default.
_KEEPALIVE_SECONDS = 20


def sse_pack(event: dict[str, Any]) -> bytes:
    """Encode an event dict as a single SSE frame."""
    return f"data: {json.dumps(event, default=str)}\n\n".encode()


def sse_comment(text: str = "ka") -> bytes:
    return f": {text}\n\n".encode()


EventFilter = Callable[[dict[str, Any]], bool | Awaitable[bool]]


async def _event_allowed(
    event_filter: EventFilter | None,
    event: dict[str, Any],
) -> bool:
    if event_filter is None:
        return True
    result = event_filter(event)
    if inspect.isawaitable(result):
        result = await result
    return bool(result)


async def _stream_topic(
    request: Request,
    topic: str,
    initial_snapshot: list[dict[str, Any]] | None = None,
    log_label: str = "",
    event_filter: EventFilter | None = None,
) -> StreamingResponse:
    """Generic SSE pump for a single Redis pub/sub topic.

    Used by both per-channel and per-human streams; differs only in topic
    string and the snapshot prepended at connect time.
    """
    bus = get_bus()

    async def generator() -> AsyncIterator[bytes]:
        queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=256)
        disconnected = asyncio.Event()

        async def pump() -> None:
            try:
                async for event in bus.subscribe(topic):
                    if disconnected.is_set():
                        break
                    if not await _event_allowed(event_filter, event):
                        continue
                    try:
                        queue.put_nowait(sse_pack(event))
                    except asyncio.QueueFull:
                        log.warning(
                            "SSE queue full for %s — dropping event",
                            log_label or topic,
                        )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("SSE pump failed for %s: %s", log_label or topic, exc)

        pump_task = asyncio.create_task(pump())
        try:
            if initial_snapshot:
                for event in initial_snapshot:
                    yield sse_pack(event)

            while True:
                if await request.is_disconnected():
                    disconnected.set()
                    break
                if pump_task.done():
                    # Defence in depth: the pump now self-heals (see
                    # EventBus.subscribe), so it should only finish when we
                    # cancel it on disconnect. If it ever ends on its own, stop
                    # the response so the client reconnects with a fresh pump
                    # instead of holding a live-looking stream that silently
                    # delivers nothing.
                    break
                try:
                    frame = await asyncio.wait_for(queue.get(), timeout=_KEEPALIVE_SECONDS)
                    yield frame
                except TimeoutError:
                    yield sse_comment()
        finally:
            disconnected.set()
            pump_task.cancel()
            try:
                await pump_task
            except (asyncio.CancelledError, Exception):
                pass

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def stream_human_events(
    request: Request,
    human_id: int,
    initial_snapshot: list[dict[str, Any]] | None = None,
) -> StreamingResponse:
    """Open the global per-user SSE stream.

    Carries cross-channel events: ``post.created`` for any channel the
    human is a member of, plus ``channel.read`` and ``channel.muted`` for
    cross-tab sync. The per-channel stream stays for in-channel concerns
    (typing, presence).
    """
    return await _stream_topic(
        request,
        human_topic(human_id),
        initial_snapshot=initial_snapshot,
        log_label=f"human {human_id}",
    )


async def stream_channel_events(
    request: Request,
    channel_id: str,
    initial_snapshot: list[dict[str, Any]] | None = None,
    event_filter: EventFilter | None = None,
) -> StreamingResponse:
    """Open an SSE stream for `channel_id`.

    `initial_snapshot` is a list of event dicts sent before the live
    subscription starts — typically the current presence snapshot so the
    client doesn't start with an empty member-status map.
    """
    return await _stream_topic(
        request,
        channel_topic(channel_id),
        initial_snapshot=initial_snapshot,
        log_label=f"channel {channel_id}",
        event_filter=event_filter,
    )


def _envelope(type_: RealtimeEventType, channel_id: str, data: Any) -> dict[str, Any]:
    return {"type": type_, "channel_id": channel_id, "data": data}


async def publish_post_created(
    bus: EventBus,
    channel_id: str,
    post: dict[str, Any],
    member_human_ids: list[int] | None = None,
) -> None:
    """Publish a new-post event.

    Always fires on the per-channel topic (drives the in-channel feed).
    If `member_human_ids` is supplied, also fans out to each member's
    per-user topic so their global SSE stream — and thus their sidebar
    badge — updates in real time even when they aren't viewing the
    channel.
    """
    envelope = _envelope("post.created", channel_id, post)
    await bus.publish(channel_topic(channel_id), envelope)
    if member_human_ids:
        for hid in member_human_ids:
            await bus.publish(human_topic(hid), envelope)
        # Browser push for members whose tab is closed/backgrounded — the
        # "reach them when SSE can't" layer. Hand the fan-out off to the
        # background dispatcher rather than awaiting it here: this coroutine is
        # run to completion by ``fire_and_forget`` (on a threadpool thread for
        # sync endpoints like an agent posting), and the fan-out is slow
        # external HTTP, so doing it inline would block that thread / stretch
        # the fire-and-forget task. ``schedule_post_web_push`` enqueues and
        # returns instantly; the lifespan-owned worker does the sending, skips
        # the author + muted members, and prunes dead subscriptions. No-op
        # unless VAPID is configured. Lazy import avoids an import cycle.
        try:
            from clawbits.realtime.web_push import schedule_post_web_push

            schedule_post_web_push(channel_id, post, member_human_ids)
        except Exception as exc:
            log.warning("publish_post_created: web-push enqueue failed: %s", exc)


async def publish_post_updated(bus: EventBus, channel_id: str, post: dict[str, Any]) -> None:
    await bus.publish(channel_topic(channel_id), _envelope("post.updated", channel_id, post))


# ---------------------------------------------------------------------------
# Streaming-append coalescing (LIVE_AGENT_ACTIVITY_PLAN §4.2)
# ---------------------------------------------------------------------------
#
# Token-streamed replies PATCH the draft every ~180ms and each PATCH re-fans
# the FULL post payload. Bound the outbound event rate with a per-post
# throttle: while the post is still ``streaming``, at most one publish per
# window; superseded intermediates are DROPPED, which is safe because every
# payload carries the full cumulative text (the next publish or the finalize
# supersedes it). Terminal payloads (``published`` etc.) always publish
# immediately, so the final state is never lost or delayed.
#
# A throttle (drop) rather than a debounce (delay) on purpose: it needs no
# cross-call asyncio state, so it behaves identically under all three
# ``fire_and_forget`` contexts, including the ephemeral-loop test fallback.
STREAMING_POST_UPDATE_MIN_INTERVAL_SECONDS = 0.05
_STREAM_THROTTLE_MAX_ENTRIES = 2048
_last_streaming_publish: dict[int, float] = {}


def _prune_streaming_throttle(now: float) -> None:
    """Drop stale throttle entries (posts reaped/cancelled mid-stream never
    hit the terminal pop). Cheap: only runs when the map is oversized."""
    if len(_last_streaming_publish) <= _STREAM_THROTTLE_MAX_ENTRIES:
        return
    cutoff = now - 60.0
    for pid, ts in list(_last_streaming_publish.items()):
        if ts < cutoff:
            _last_streaming_publish.pop(pid, None)


async def publish_post_updated_streaming(
    bus: EventBus, channel_id: str, post: dict[str, Any]
) -> None:
    """``post.updated`` for the streaming PATCH path, rate-bounded per post.

    Only the agentic streaming-PATCH call site routes through here; human
    edit paths keep calling :func:`publish_post_updated` directly.
    """
    post_id = post.get("post_id")
    now = time.monotonic()
    if post.get("status") == "streaming" and isinstance(post_id, int):
        _prune_streaming_throttle(now)
        last = _last_streaming_publish.get(post_id)
        if last is not None and (now - last) < STREAMING_POST_UPDATE_MIN_INTERVAL_SECONDS:
            return  # superseded by the next append/finalize (full payloads)
        _last_streaming_publish[post_id] = now
        await publish_post_updated(bus, channel_id, post)
        return
    if isinstance(post_id, int):
        _last_streaming_publish.pop(post_id, None)
    await publish_post_updated(bus, channel_id, post)


def _reset_streaming_throttle_for_tests() -> None:
    _last_streaming_publish.clear()


async def publish_channel_event(
    bus: EventBus,
    channel_id: str,
    event: dict[str, Any],
    member_human_ids: list[int] | None = None,
) -> None:
    """Publish an inline channel-timeline event (membership change today;
    designed to carry future event types like ``channel.renamed`` over
    the same channel).

    Mirrors ``publish_post_created`` exactly so the client can treat
    events as a parallel append source for the same in-memory stream.
    Fires on the per-channel topic for in-channel feed updates, and
    optionally fans out to each member's per-user topic so any
    sidebar-side bookkeeping the client wants to do off the event
    stays consistent across tabs even when the channel isn't open."""
    envelope = _envelope("channel.event", channel_id, event)
    await bus.publish(channel_topic(channel_id), envelope)
    if member_human_ids:
        for hid in member_human_ids:
            await bus.publish(human_topic(hid), envelope)


async def publish_post_deleted(
    bus: EventBus,
    channel_id: str,
    post_id: int,
    member_human_ids: list[int] | None = None,
) -> None:
    """Tell channel subscribers to drop ``post_id`` from their feed.

    Mirrors ``publish_post_created``: fires on the channel topic, and
    optionally fans out to each member's per-user topic so the sidebar
    preview / unread count can be reconciled when the deleted post was
    the channel's most-recent message."""
    envelope = _envelope("post.deleted", channel_id, {"post_id": post_id})
    await bus.publish(channel_topic(channel_id), envelope)
    if member_human_ids:
        for hid in member_human_ids:
            await bus.publish(human_topic(hid), envelope)


async def publish_channel_read(
    bus: EventBus, human_id: int, channel_id: str, last_read_post_id: int
) -> None:
    """Tell all of this human's connected tabs/devices that the read pointer
    advanced — they should clear the unread badge for this channel.

    Includes ``human_id`` so a receiving client can also mirror the pointer
    onto its in-channel members cache (cross-device read receipts). Additive
    field — older clients that don't read it are unaffected."""
    await bus.publish(
        human_topic(human_id),
        _envelope(
            "channel.read",
            channel_id,
            {"human_id": human_id, "last_read_post_id": last_read_post_id},
        ),
    )


async def publish_member_read(
    bus: EventBus, human_id: int, channel_id: str, last_read_post_id: int
) -> None:
    """Tell every channel subscriber that ``human_id``'s read pointer
    advanced. Drives outgoing-message read receipts — the sender's client
    can now compute whether all other members have caught up to a given
    post. Fires on the channel topic only; the personal sync uses
    :func:`publish_channel_read` for sidebar badge state."""
    await bus.publish(
        channel_topic(channel_id),
        _envelope(
            "member.read",
            channel_id,
            {"human_id": human_id, "last_read_post_id": last_read_post_id},
        ),
    )


async def publish_channel_muted(
    bus: EventBus, human_id: int, channel_id: str, muted: bool
) -> None:
    """Sync mute state across this human's tabs/devices."""
    await bus.publish(
        human_topic(human_id),
        _envelope("channel.muted", channel_id, {"muted": muted}),
    )


async def publish_channel_pinned(
    bus: EventBus, human_id: int, channel_id: str, pinned: bool
) -> None:
    """Sync pin state across this human's tabs/devices. Pinning is
    per-user UI state, so other members of the channel are unaffected
    and we publish on the personal topic only."""
    await bus.publish(
        human_topic(human_id),
        _envelope("channel.pinned", channel_id, {"pinned": pinned}),
    )


async def publish_channel_added(
    bus: EventBus, human_id: int, channel: dict[str, Any]
) -> None:
    """Tell this human's tabs to drop ``channel`` into the sidebar.

    Fires on join / DM-open / add-as-member so the recipient's sidebar
    refreshes without needing a page reload. Payload carries the full
    channel response so a client can choose to splice it in directly,
    though the default handler just invalidates the channels query."""
    await bus.publish(
        human_topic(human_id),
        _envelope("channel.added", channel["channel_id"], channel),
    )


async def publish_channel_removed(
    bus: EventBus, human_id: int, channel_id: str
) -> None:
    """Tell this human's tabs to remove ``channel_id`` from the sidebar.

    Fires when the user is kicked or leaves — drives cross-tab sidebar
    sync and lets the receiver navigate away if they were viewing the
    channel they just lost access to."""
    await bus.publish(
        human_topic(human_id),
        _envelope("channel.removed", channel_id, {"channel_id": channel_id}),
    )


async def publish_agent_channel_added(
    bus: EventBus, agent_id: str, channel: dict[str, Any]
) -> None:
    """Tell a live agent WebSocket that it was added to ``channel``.

    The agent WS subscribes to channel topics known at connect time; this
    per-agent control event lets it attach the new channel immediately instead
    of waiting for the plugin's rare control refresh.
    """
    await bus.publish(
        agent_topic(agent_id),
        _envelope("channel.added", channel["channel_id"], channel),
    )


async def publish_agent_channel_removed(
    bus: EventBus, agent_id: str, channel_id: str
) -> None:
    """Tell a live agent WebSocket that it lost ``channel_id`` membership."""
    await bus.publish(
        agent_topic(agent_id),
        _envelope("channel.removed", channel_id, {"channel_id": channel_id}),
    )


async def publish_automation_sync(
    bus: EventBus, agent_id: str, desired_generation: int
) -> None:
    """Nudge a live agent WebSocket to reconcile its automations.

    Fires when an operator changes the agent's desired automation set, so the
    plugin reconciles near-instantly instead of waiting for its next poll. The
    poll remains the reliable fallback if the agent is offline. The event has no
    ``channel_id`` (it is per-agent control, not channel traffic); the plugin
    pulls ``GET /api/agentic/automations/desired`` on receipt."""
    await bus.publish(
        agent_topic(agent_id),
        {
            "type": "automation.sync",
            "data": {"desired_generation": desired_generation},
        },
    )


async def publish_attention_nudge(
    bus: EventBus, agent_id: str, channel_id: str, post: dict[str, Any]
) -> int | None:
    """Nudge a live agent to consider replying to a post it wasn't tagged in.

    Fired by the server-side LobsterTalk attention gate when a new channel post
    reads as something the agent could help with. Published on the per-agent
    control topic (not the channel topic) so only the flagged agent sees it; the
    plugin dispatches the post as if addressed but frames it "reply only if you
    can add something useful". The ``data`` is the same post payload as
    ``post.created`` so the plugin normalizes it identically. No ``channel_id``
    on the envelope's type slot — this is per-agent control, not channel traffic —
    but the channel id rides along so the plugin knows where the post lives.

    Returns the subscriber count from the publish (``None`` on failure). The
    agent topic's only subscriber is the server-side WS control pump, so ``0``
    means no live agent socket on any worker — the caller uses that to refund
    its cooldown instead of burning it on a nudge nobody heard.

    The wire name is deliberately the PRE-rename ``mutualist.consider``: every
    plugin deployed today (openclaw pl0.15.1 in the reef image, the hermes
    adapter on agent boxes) filters for that name only, so publishing
    ``lobstertalk.consider`` silently muted nudges fleet-wide — verified
    end-to-end on 2026-08-03 (an agent ACKed the legacy name after ignoring
    the new one). Current plugin source accepts BOTH names, so this stays
    compatible with upgraded agents; publishing both events instead would
    double-dispatch on them. Flip back to ``lobstertalk.consider`` only once
    the deployed plugins all carry the dual-name filter."""
    return await bus.publish(
        agent_topic(agent_id),
        {"type": "mutualist.consider", "channel_id": channel_id, "data": post},
    )


async def publish_org_added(
    bus: EventBus, human_id: int, org: dict[str, Any]
) -> None:
    """Tell this human's tabs to drop ``org`` into the org switcher.

    Fires when the user is invited to an org (in-app invite or WorkOS
    reconciliation) and when they create a new org themselves — the
    latter for cross-tab consistency, since the tab that issued the
    create already updates its cache via the mutation response. The
    payload is the full :class:`OrgResponse` shape, including the
    activity counters so the switcher's badge math is correct on the
    first paint.

    ``channel_id`` is empty in the envelope because this event has no
    channel scope — mirrors the convention used by ``user.status``."""
    await bus.publish(
        human_topic(human_id),
        _envelope("org.added", "", org),
    )


async def publish_member_status(
    bus: EventBus,
    channel_id: str,
    member_kind: MemberKind,
    member_id: str,
    status: AgentPresenceStatus,
    activity: dict[str, Any] | None = None,
) -> None:
    """``activity`` (optional) is the agent-reported mid-turn detail from the
    status endpoint - included in the payload only when present so old
    clients and the common human/typing case stay byte-identical."""
    payload: dict[str, Any] = {
        "member_kind": member_kind,
        "member_id": member_id,
        "status": status,
    }
    if activity is not None:
        payload["activity"] = activity
    await bus.publish(
        channel_topic(channel_id),
        _envelope("member.status", channel_id, payload),
    )


async def publish_user_status(
    bus: EventBus,
    human_id: int,
    status: GlobalUserStatus,
    last_seen_at: str | None,
    channel_ids: list[str],
    fellow_human_ids: list[int],
    last_seen_label: str | None = None,
) -> None:
    """Fan a user's global status change out to every place a viewer
    might be watching them.

    * The user's own per-user topic — so their other tabs see the
      transition (e.g. tab 2 going idle while tab 1 stays online).
    * Every channel they're a member of — so anyone currently viewing
      that channel's member list updates without re-fetching.
    * Every fellow human's per-user topic — so a viewer sitting on
      the home page or another route, subscribed only to their own
      global stream, still gets the dot update for someone they share
      a channel with. Without this hop, sidebar DM rows would only
      refresh once the viewer actually opened the DM.

    ``channel_id`` on the envelope is empty for per-user deliveries
    (the event is global) and the channel id for per-channel
    deliveries, matching how other events disambiguate per-topic
    payloads.

    ``last_seen_label`` is the bucketed "Last seen recently" string
    used when the user has hidden their precise last-seen; clients
    render it in place of the raw timestamp."""
    payload = {
        "human_id": human_id,
        "status": status,
        "last_seen_at": last_seen_at,
        "last_seen_label": last_seen_label,
    }
    await bus.publish(human_topic(human_id), _envelope("user.status", "", payload))
    for cid in channel_ids:
        await bus.publish(channel_topic(cid), _envelope("user.status", cid, payload))
    for hid in fellow_human_ids:
        await bus.publish(human_topic(hid), _envelope("user.status", "", payload))


async def publish_agent_status(
    bus: EventBus,
    agent_id: str,
    status: AgentLivenessStatus,
    last_alive_at: str | None,
    channel_ids: list[str],
    human_ids: list[int],
) -> None:
    """Fan an agent's global liveness change out to every viewer who might be
    watching it: each channel the agent is in (so open member lists update)
    and each human who shares a channel with it (so their sidebar / DM-row dot
    flips even from the home page).

    Unlike :func:`publish_user_status` there's no per-subject self-topic hop —
    agents aren't SSE viewers, they're only *observed*. Emitted only on the
    positive transition (setup/offline -> available); the reverse is time-based
    and derived client-side from ``last_alive_at``.

    ``channel_id`` on the envelope is the channel id for per-channel deliveries
    and empty for the per-human deliveries (global there), matching the
    ``user.status`` convention."""
    payload = {
        "agent_id": agent_id,
        "status": status,
        "last_alive_at": last_alive_at,
    }
    for cid in channel_ids:
        await bus.publish(channel_topic(cid), _envelope("agent.status", cid, payload))
    for hid in human_ids:
        await bus.publish(human_topic(hid), _envelope("agent.status", "", payload))


async def build_presence_snapshot_event(
    bus: EventBus, channel_id: str
) -> dict[str, Any]:
    snapshot = await bus.presence_snapshot(channel_id)
    return _envelope(
        "presence.snapshot",
        channel_id,
        {
            "members": [
                {
                    "member_kind": e.member_kind,
                    "member_id": e.member_id,
                    "status": e.status,
                    # Only agents mid-turn carry activity; omit elsewhere so
                    # the common payload stays unchanged.
                    **({"activity": e.activity} if e.activity is not None else {}),
                }
                for e in snapshot
            ]
        },
    )


def _log_threadsafe_publish_result(future: Any) -> None:
    """Surface an exception from a cross-thread publish (never blocks)."""
    try:
        exc = future.exception()
    except concurrent.futures.CancelledError:
        return
    if exc is not None:
        log.warning("fire_and_forget publish failed: %s", exc)


def fire_and_forget(coro) -> None:
    """Schedule an async publish without awaiting.

    Three call contexts, in priority order:

    1. **Async endpoint** — a loop is already running on this thread; create
       a task on it directly.
    2. **Sync endpoint** (threadpool thread, no running loop) — hand the
       coroutine to the captured main loop via ``run_coroutine_threadsafe``.
       That loop owns the bus's redis connection pool, so the publish
       actually reaches Redis. Running it on a fresh ``asyncio.run`` loop
       instead makes redis ops fail with "attached to a different loop" and
       silently drops the event — the root cause of a single-shot agent
       reply (one ``post.created``, no streaming follow-ups) never reaching
       connected clients until they reload.
    3. **No main loop captured** (pre-startup, or tests that skip the
       lifespan) — fall back to ``asyncio.run``; correct when the bus client
       isn't yet bound to another loop, as in the fake-bus tests.
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop is not None:
        task = loop.create_task(coro)
        task.add_done_callback(lambda t: t.exception())
        return

    main_loop = get_publish_loop()
    if main_loop is not None and not main_loop.is_closed():
        future = asyncio.run_coroutine_threadsafe(coro, main_loop)
        future.add_done_callback(_log_threadsafe_publish_result)
        return

    try:
        asyncio.run(coro)
    except Exception as exc:
        log.warning("fire_and_forget fallback failed: %s", exc)


# Raise a 403 up the stack consistently for membership checks.
