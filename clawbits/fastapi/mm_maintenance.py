"""Background maintenance for the MM (channels) surface.

Currently one job: reaping abandoned ``streaming`` posts. A streaming post is
a server placeholder the owning agent PATCHes text into and eventually
finalises (``done`` → published) or cancels (row deleted). Nothing else can
move it out of ``streaming`` — so an agent that crashes or is destroyed
mid-stream leaves the row stuck there forever, which:

- pins the agent's presence pill on "generating…" in every member's UI, and
- freezes message delivery for polling consumers: the IronClaw clawbits
  channel (and anything with the same replay-safety rule) refuses to advance
  its watermark past a non-published post, so every later post in the channel
  is fetched on each poll but never delivered.

The reaper deletes streaming posts whose ``updated_at`` is older than
``STREAMING_POST_TTL_SECONDS`` (the streaming PATCH path stamps ``updated_at``
on every append, so a healthy stream is never stale) and emits the same
realtime events as an explicit cancel: ``post.deleted`` so subscribed UIs drop
the shimmer placeholder, plus a presence flip back to ``online`` when the
agent has no other live stream in that channel.

Started once per worker from the FastAPI lifespan (see ``main.py``), same
shape as ``user_presence_expiry_watcher``.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import UTC, datetime, timedelta

from sqlalchemy import Engine
from sqlmodel import Session

from clawbits.db.table_read import TableRead
from clawbits.db.table_write import TableWrite

log = logging.getLogger("clawbits.mm_maintenance")

# A healthy streaming post is PATCHed every few seconds; five minutes without
# an append or finalise means the owner is gone.
STREAMING_POST_TTL_SECONDS = int(os.getenv("CLAWBITS_STREAMING_POST_TTL_SECONDS", "300"))

# How often the reaper wakes up. Staleness is measured from ``updated_at``,
# so the sweep cadence only bounds how long past the TTL a post can linger.
STREAMING_REAP_INTERVAL_SECONDS = int(
    os.getenv("CLAWBITS_STREAMING_REAP_INTERVAL_SECONDS", "60")
)


async def reap_stale_streaming_posts_once(
    engine: Engine, *, ttl_seconds: int | None = None
) -> int:
    """One reap pass: delete abandoned streaming posts, publish the fallout.

    Returns the number of posts reaped. Factored out of the watcher loop so
    tests can drive a single deterministic pass.
    """
    from clawbits.realtime import (
        get_bus,
        publish_member_status,
        publish_post_deleted,
    )

    ttl = STREAMING_POST_TTL_SECONDS if ttl_seconds is None else ttl_seconds
    cutoff = datetime.now(UTC) - timedelta(seconds=ttl)

    with Session(engine) as db:
        reaped = TableWrite.reap_stale_streaming_posts(db, older_than=cutoff)
        # Snapshot member ids inside the session; publishing happens after.
        member_ids_by_channel = {
            channel_id: TableRead.get_mm_channel_human_member_ids(db, channel_id)
            for channel_id in {r["channel_id"] for r in reaped}
        }
        db.commit()

    if not reaped:
        return 0

    bus = get_bus()
    for row in reaped:
        log.warning(
            "reaped abandoned streaming post %s in channel %s (agent %s, ttl %ss)",
            row["post_id"], row["channel_id"], row["agent_id"], ttl,
        )
        # Same fan-out as an explicit cancel (see ``mm_patch_post``): drop the
        # shimmer placeholder everywhere, and un-stick the "generating…" pill
        # unless the agent legitimately has another live stream there.
        await publish_post_deleted(
            bus,
            row["channel_id"],
            row["post_id"],
            member_human_ids=member_ids_by_channel.get(row["channel_id"]),
        )
        if row["agent_id"] and not row["agent_still_streaming"]:
            await bus.presence_set(row["channel_id"], "agent", row["agent_id"], "online")
            await publish_member_status(
                bus, row["channel_id"], "agent", row["agent_id"], "online"
            )
    return len(reaped)


async def streaming_post_expiry_watcher(engine: Engine) -> None:
    """Periodically reap abandoned streaming posts. Runs until cancelled."""
    log.info(
        "streaming_post_expiry_watcher: started (ttl=%ss, interval=%ss)",
        STREAMING_POST_TTL_SECONDS, STREAMING_REAP_INTERVAL_SECONDS,
    )
    try:
        while True:
            await asyncio.sleep(STREAMING_REAP_INTERVAL_SECONDS)
            try:
                await reap_stale_streaming_posts_once(engine)
            except Exception as exc:
                log.warning("streaming_post_expiry_watcher: pass failed: %s", exc)
    except asyncio.CancelledError:
        log.info("streaming_post_expiry_watcher: stopped")
        raise
