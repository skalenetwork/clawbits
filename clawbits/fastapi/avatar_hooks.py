"""Post-commit hooks that schedule avatar uploads after entity creation.

Each ``fire_*_avatar`` schedules an async ``ensure_*_avatar`` to run
as a background task — the endpoint returns immediately while the
DiceBear fetch + R2 upload happen in the background. Exceptions are
logged and swallowed so an R2 / DiceBear outage never breaks the
user-visible creation flow; the next backfill run picks up any rows
whose upload failed.

Call these AFTER ``session.commit()`` so a rolled-back transaction
doesn't leave an orphan SVG behind.
"""
from __future__ import annotations

import asyncio
import logging

from clawbits.avatars import (
    AvatarKind,
    ensure_agent_avatar,
    ensure_channel_avatar,
    ensure_user_avatar,
)
from clawbits.avatars.config import CURRENT_AVATAR_VERSION, make_avatars_r2_client

logger = logging.getLogger(__name__)

# Hold strong refs to in-flight tasks so the event loop doesn't GC
# them mid-flight. Tasks remove themselves from the set on completion.
_inflight: set[asyncio.Task[None]] = set()


async def _safe(label: str, coro: object) -> None:
    """Await ``coro`` and log any exception under ``label``.

    Wrapped in this helper because ``asyncio.create_task`` exceptions
    are otherwise lost / surfaced as "unhandled exception in task"
    warnings without context. We want context-rich logs for ops.
    """
    try:
        await coro  # type: ignore[misc]
    except Exception:
        logger.exception("avatar hook failed: %s", label)


def _track(label: str, coro: object) -> None:
    wrapped = _safe(label, coro)
    try:
        task = asyncio.create_task(wrapped)
    except RuntimeError:
        # No running event loop — typical in sync test contexts (FastAPI
        # TestClient runs sync routes in a worker thread) or scripts
        # that invoke the table-write layer outside an async server.
        # The avatar will be uploaded by the next backfill run; close
        # both coroutines here so Python doesn't raise the "coroutine
        # was never awaited" RuntimeWarning.
        logger.debug("no running event loop; skipping avatar hook %s", label)
        getattr(wrapped, "close", lambda: None)()
        getattr(coro, "close", lambda: None)()
        return
    _inflight.add(task)
    task.add_done_callback(_inflight.discard)


# Client construction is deferred to inside these async wrappers so a
# missing CLOUDFLARE_ACCOUNT_ID / API_TOKEN (typical in CI + unit-test
# envs) surfaces as a single swallowed log line rather than a
# synchronous ValueError that breaks the surrounding creation flow.

async def _ensure_channel_via_new_client(
    channel_id: str, channel_type: str, version: int
) -> None:
    r2 = make_avatars_r2_client()
    await ensure_channel_avatar(
        r2,
        channel_id=channel_id,
        version=version,
        channel_type=channel_type,
    )


def fire_channel_avatar(
    *,
    channel_id: str,
    channel_type: str = "public",
    version: int = CURRENT_AVATAR_VERSION,
) -> None:
    """Schedule a generated avatar upload for a newly-created channel.

    ``channel_type`` picks the overlay icon (hash vs lock vs none).
    """
    _track(
        f"channel/{channel_id}",
        _ensure_channel_via_new_client(channel_id, channel_type, version),
    )


async def await_channel_avatar(
    *,
    channel_id: str,
    channel_type: str = "public",
    version: int = CURRENT_AVATAR_VERSION,
) -> None:
    """Synchronously upload a channel's avatar before returning.

    Used by channel-creation endpoints where the client navigates to
    the new channel immediately and an ``<img>`` for the avatar URL
    fires within milliseconds. If the SVG isn't in R2 yet, the public
    domain serves a 404 — and Cloudflare caches that 404 at the edge,
    so subsequent requests *also* return 404 even after the upload
    eventually lands.

    Awaiting the upload before the response goes back to the client
    closes that race: the first GET is guaranteed a cache miss + 200.
    Adds ~600–800ms to channel-create latency, acceptable for a
    one-time-per-channel cost.
    """
    try:
        r2 = make_avatars_r2_client()
        await ensure_channel_avatar(
            r2,
            channel_id=channel_id,
            version=version,
            channel_type=channel_type,
        )
    except Exception:
        logger.exception("avatar upload failed (channel/%s)", channel_id)


async def await_user_avatar(
    *,
    user_id: int,
    version: int = CURRENT_AVATAR_VERSION,
) -> None:
    """Synchronously upload a user's avatar before returning.

    Mirrors :func:`await_channel_avatar`. The signup response carries
    the avatar URL the client renders immediately — a missed upload
    leaves Cloudflare caching a 404 for that key at the edge until
    the next ``avatar_version`` bump.

    The fire-and-forget :func:`fire_channel_avatar` only works from async
    callers; sync FastAPI routes run in an anyio worker thread without
    a running event loop, where ``asyncio.create_task`` raises. Routes
    that provision users should ``await`` this helper after commit.
    """
    try:
        r2 = make_avatars_r2_client()
        await ensure_user_avatar(
            r2,
            user_id=user_id,
            version=version,
            kind=AvatarKind.GENERATED,
        )
    except Exception:
        logger.exception("avatar upload failed (user/%s)", user_id)


async def await_agent_avatar(
    *,
    agent_id: str,
    version: int = CURRENT_AVATAR_VERSION,
) -> None:
    """Synchronously upload an agent's avatar before returning.

    Mirrors :func:`await_channel_avatar` — the signup response hands
    the client an agent_id whose avatar URL is fetched right away
    (e.g. by the approving human's settings page). Missing the upload
    poisons that key in the Cloudflare edge cache.
    """
    try:
        r2 = make_avatars_r2_client()
        await ensure_agent_avatar(
            r2,
            agent_id=agent_id,
            version=version,
            kind=AvatarKind.GENERATED,
        )
    except Exception:
        logger.exception("avatar upload failed (agent/%s)", agent_id)
