"""Realtime event bus — Redis pub/sub fan-out across uvicorn workers.

Used by the SSE endpoint to deliver per-channel events (new posts, edits,
member status changes) to all connected clients, regardless of which
worker they're pinned to. Also tracks ephemeral member presence with
per-field TTLs so stale entries auto-expire.

Redis ≥ 7.4 is required for `HEXPIRE` (per-field TTL on hashes). We run
Redis 8.6 in compose.yaml.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from redis import asyncio as aioredis

from clawbits.datastructures.mm_models import (
    AgentPresenceStatus,
    GlobalUserStatus,
    MemberKind,
)

log = logging.getLogger(__name__)

# TTL per status — typing/generating are short-lived (heartbeated by
# the client or plugin); online is medium (heartbeated by visible tab).
STATUS_TTL_SECONDS: dict[AgentPresenceStatus, int] = {
    "typing": 6,
    "generating": 15,
    "online": 45,
    "idle": 300,
    "offline": 5,
}

# Throttle for persisting last_seen_at to the DB on heartbeat. The
# transition path always writes immediately; this only governs the
# "user has been online and still is" case so a force-killed tab still
# has a recent timestamp without burning a DB write every 30s.
LAST_SEEN_PERSIST_INTERVAL_SECONDS = 300


def _redis_url() -> str:
    return os.getenv("CLAWBITS_REDIS_URL", "redis://localhost:6379/0")


def _redis_db_index(url: str) -> int:
    """Best-effort parse of the database index out of a redis:// URL.

    Redis keyspace-notification channels are scoped per DB index
    (``__keyevent@<db>__:expired``), so a subscriber on the wrong DB
    sees nothing. Falls back to 0 on any parse failure — matches the
    Redis default when ``/<db>`` is omitted from the URL."""
    tail = url.rstrip("/").rpartition("/")[2]
    try:
        return int(tail)
    except (TypeError, ValueError):
        return 0


def channel_topic(channel_id: str) -> str:
    return f"channel:{channel_id}"


def human_topic(human_id: int) -> str:
    """Per-human pub/sub topic: drives the global SSE stream (sidebar
    unread counts, cross-tab read/mute sync, future browser notifications).
    """
    return f"human:{human_id}"


def agent_topic(agent_id: str) -> str:
    """Per-agent control topic: tells a live agent WebSocket about channel
    membership changes that are not visible on the per-channel topics it was
    subscribed to at connect time.
    """
    return f"agent:{agent_id}"


def _presence_key(channel_id: str) -> str:
    return f"presence:{channel_id}"


def _member_field(member_kind: str, member_id: str | int) -> str:
    return f"{member_kind}:{member_id}"


def _user_presence_key(human_id: int) -> str:
    """Single-field key per human user. Expires when the TTL for the
    last-written status elapses — a missing key means offline."""
    return f"user_presence:{human_id}"


def _last_seen_lock_key(human_id: int) -> str:
    """Throttle key for DB persistence of last_seen_at. Present == we
    wrote recently and may skip the DB; expires after
    ``LAST_SEEN_PERSIST_INTERVAL_SECONDS``."""
    return f"user_last_seen_lock:{human_id}"


@dataclass
class PresenceEntry:
    member_kind: MemberKind
    member_id: str
    status: AgentPresenceStatus
    # Transient agent-reported "what am I doing" payload (thinking snippet /
    # tool label). Opaque display data; rides the presence TTL. None for
    # plain status entries (humans, old plugins).
    activity: dict[str, Any] | None = None


class EventBus:
    """Thin wrapper around redis.asyncio providing pub/sub + presence.

    One publisher connection is shared across all callers. Each subscriber
    call gets its own dedicated pubsub connection (Redis pub/sub requires
    this), auto-closed when the async iterator exits.
    """

    def __init__(self, url: str):
        self._url = url
        self._redis: aioredis.Redis | None = None
        self._lock = asyncio.Lock()

    async def _client(self) -> aioredis.Redis:
        if self._redis is None:
            async with self._lock:
                if self._redis is None:
                    self._redis = aioredis.from_url(
                        self._url,
                        encoding="utf-8",
                        decode_responses=True,
                        # Keep long-lived pub/sub connections healthy. With no
                        # health check, a topic with no traffic leaves its socket
                        # idle until Redis's ``timeout`` (or a NAT/proxy) reaps it;
                        # the next blocking ``listen()`` read then raises
                        # "Timeout reading ..." which — before the resilient
                        # ``subscribe`` loop below — silently killed the SSE pump
                        # and froze every stream on that connection. redis-py PINGs
                        # idle connections every ``health_check_interval`` seconds,
                        # and TCP keepalive guards against half-open sockets.
                        health_check_interval=15,
                        socket_keepalive=True,
                    )
        return self._redis

    async def redis_client(self) -> aioredis.Redis:
        """Public accessor for the shared Redis connection.

        Used by adjacent caches (e.g., link-preview unfurls) that want
        to share the bus's connection pool rather than open their own.
        Returns the same instance ``publish``/``subscribe`` are built
        on, so callers should treat it as read-only-ish — don't ``aclose``
        it directly, the bus owns the lifetime.
        """
        return await self._client()

    async def close(self) -> None:
        if self._redis is not None:
            try:
                await self._redis.aclose()
            except Exception as exc:
                log.warning("EventBus close failed: %s", exc)
            self._redis = None

    # ------------------------------------------------------------------
    # pub/sub
    # ------------------------------------------------------------------

    async def publish(self, topic: str, event: dict[str, Any]) -> int | None:
        """Publish ``event`` on ``topic``.

        Returns the number of subscribers Redis delivered it to (``PUBLISH``'s
        return value, counted across all workers), or ``None`` when the publish
        itself failed. Most callers ignore this; the LobsterTalk nudge path uses
        ``0`` as "no live agent socket anywhere" to refund its cooldown."""
        client = await self._client()
        try:
            return await client.publish(topic, json.dumps(event, default=str))
        except Exception as exc:
            log.warning("EventBus.publish(%s) failed: %s", topic, exc)
            return None

    async def subscribe(self, topic: str) -> AsyncIterator[dict[str, Any]]:
        """Yield events published to `topic` until the consumer stops.

        Caller must `async for event in bus.subscribe(topic): ...`. The
        subscription is cleaned up on GeneratorExit / cancellation.

        Resilient to transient Redis failures. A single hiccup on the pub/sub
        connection (idle-socket reap, read timeout, broker restart) used to
        raise out of here and end the iterator for good — which killed the SSE
        pump while its HTTP response stayed open, so the client saw a live
        connection that delivered nothing. Now the subscription is torn down
        and re-established with backoff while the consumer's ``async for`` keeps
        running across the blip. Events published during the gap are lost
        (pub/sub has no replay); the client reconciles via its
        snapshot-on-(re)connect and the periodic poll fallback.
        """
        backoff = 0.5
        while True:
            client = await self._client()
            pubsub = client.pubsub()
            try:
                await pubsub.subscribe(topic)
                backoff = 0.5  # reset after a clean (re)subscribe
                while True:
                    # Poll rather than ``listen()``. ``listen()`` does a blocking
                    # read that raises ``TimeoutError`` on the connection's read
                    # timeout and then exhausts the generator — which used to
                    # silently kill the SSE pump and freeze the stream.
                    # ``get_message`` waits up to ``timeout`` for data and
                    # returns None on an idle interval (no error, connection
                    # intact), so the subscription stays up continuously and
                    # every published event is delivered.
                    message = await pubsub.get_message(
                        ignore_subscribe_messages=True, timeout=1.0
                    )
                    if message is None or message.get("type") != "message":
                        continue
                    raw = message.get("data")
                    if not raw:
                        continue
                    try:
                        evt = json.loads(raw)
                    except json.JSONDecodeError:
                        log.warning("EventBus: non-JSON payload on %s", topic)
                        continue
                    yield evt
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # A genuine connection error (not a mere idle interval): drop
                # this pub/sub and reconnect with backoff instead of ending the
                # iterator, so the consuming SSE stream survives the blip.
                log.warning("EventBus.subscribe(%s) reconnecting: %s", topic, exc)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 5.0)
            finally:
                try:
                    await pubsub.aclose()
                except Exception as exc:
                    log.debug("EventBus: pubsub cleanup failed: %s", exc)

    # ------------------------------------------------------------------
    # presence
    # ------------------------------------------------------------------

    async def presence_set(
        self,
        channel_id: str,
        member_kind: MemberKind,
        member_id: str | int,
        status: AgentPresenceStatus,
        activity: dict[str, Any] | None = None,
    ) -> None:
        """Record a member's transient status; auto-expires per status.

        With ``activity`` (agent mid-turn detail) the hash value becomes a
        JSON object ``{"status": ..., "activity": {...}}``; the plain-string
        form is kept for the common case so old readers and fakes stay
        valid. ``presence_snapshot`` understands both.
        """
        client = await self._client()
        key = _presence_key(channel_id)
        field = _member_field(member_kind, member_id)
        ttl = STATUS_TTL_SECONDS.get(status, 30)
        value: str = (
            status
            if activity is None
            else json.dumps({"status": status, "activity": activity})
        )
        try:
            await client.hset(key, field, value)
            # HEXPIRE needs Redis >= 7.4. Arg shape: key ttl FIELDS n field…
            await client.execute_command("HEXPIRE", key, ttl, "FIELDS", 1, field)
        except Exception as exc:
            log.warning("EventBus.presence_set failed: %s", exc)

    async def presence_clear(
        self,
        channel_id: str,
        member_kind: MemberKind,
        member_id: str | int,
    ) -> None:
        client = await self._client()
        try:
            await client.hdel(_presence_key(channel_id), _member_field(member_kind, member_id))
        except Exception as exc:
            log.warning("EventBus.presence_clear failed: %s", exc)

    async def presence_snapshot(self, channel_id: str) -> list[PresenceEntry]:
        client = await self._client()
        try:
            raw = await client.hgetall(_presence_key(channel_id))
        except Exception as exc:
            log.warning("EventBus.presence_snapshot failed: %s", exc)
            return []
        entries: list[PresenceEntry] = []
        for field, value in raw.items():
            kind, _, mid = field.partition(":")
            if not kind or not mid:
                continue
            status: str = value
            activity: dict[str, Any] | None = None
            # JSON form carries {"status", "activity"} (see presence_set);
            # a parse failure degrades to treating the raw value as status.
            if isinstance(value, str) and value.startswith("{"):
                try:
                    obj = json.loads(value)
                    status = obj.get("status") or "online"
                    parsed = obj.get("activity")
                    activity = parsed if isinstance(parsed, dict) else None
                except (json.JSONDecodeError, AttributeError):
                    pass
            entries.append(
                PresenceEntry(member_kind=kind, member_id=mid, status=status, activity=activity)  # type: ignore[arg-type]
            )
        return entries

    # ------------------------------------------------------------------
    # global user presence (online / idle / offline)
    # ------------------------------------------------------------------

    async def user_presence_set(
        self, human_id: int, status: GlobalUserStatus
    ) -> None:
        """Set a user's global status with TTL — a missing key means
        offline. ``offline`` is written with a short TTL so any racing
        late-arriving heartbeat from another tab can promote them back
        to online quickly."""
        client = await self._client()
        key = _user_presence_key(human_id)
        ttl = STATUS_TTL_SECONDS.get(status, 45)
        try:
            await client.set(key, status, ex=ttl)
        except Exception as exc:
            log.warning("EventBus.user_presence_set failed: %s", exc)

    async def user_presence_clear(self, human_id: int) -> None:
        """Drop the key entirely — used on explicit offline tombstones."""
        client = await self._client()
        try:
            await client.delete(_user_presence_key(human_id))
        except Exception as exc:
            log.warning("EventBus.user_presence_clear failed: %s", exc)

    async def user_presence_get(self, human_id: int) -> GlobalUserStatus:
        """Resolve a user's status. Missing key (TTL expired) → offline."""
        client = await self._client()
        try:
            raw = await client.get(_user_presence_key(human_id))
        except Exception as exc:
            log.warning("EventBus.user_presence_get failed: %s", exc)
            return "offline"
        if raw not in ("online", "idle"):
            return "offline"
        return raw  # type: ignore[return-value]

    async def user_presence_get_many(
        self, human_ids: list[int]
    ) -> dict[int, GlobalUserStatus]:
        """Batch fetch — used to seed channel member lists. Each absent
        key resolves to "offline"."""
        if not human_ids:
            return {}
        client = await self._client()
        keys = [_user_presence_key(hid) for hid in human_ids]
        try:
            raws = await client.mget(keys)
        except Exception as exc:
            log.warning("EventBus.user_presence_get_many failed: %s", exc)
            raws = [None] * len(keys)
        out: dict[int, GlobalUserStatus] = {}
        for hid, raw in zip(human_ids, raws, strict=False):
            out[hid] = raw if raw in ("online", "idle") else "offline"  # type: ignore[assignment]
        return out

    # ------------------------------------------------------------------
    # keyspace notifications (used to drive offline-on-silent-disconnect)
    # ------------------------------------------------------------------

    async def enable_keyspace_notifications(self, flags: str = "Ex") -> bool:
        """Ensure ``notify-keyspace-events`` includes the requested flags.

        Merges with whatever the server already has set so we don't
        clobber config another consumer relies on. Default ``Ex`` covers
        keyevent expiry notifications, which is all we need to drive the
        offline-on-silent-disconnect path.

        Returns True if the desired flags are present (whether we wrote
        anything or not). Returns False when the CONFIG calls fail — some
        managed Redis offerings forbid ``CONFIG SET``."""
        client = await self._client()
        try:
            existing = await client.config_get("notify-keyspace-events")
        except Exception as exc:
            log.warning("enable_keyspace_notifications: config_get failed: %s", exc)
            return False
        current = existing.get("notify-keyspace-events", "") if isinstance(existing, dict) else ""
        merged = current
        for ch in flags:
            if ch not in merged:
                merged += ch
        if merged == current:
            return True
        try:
            await client.config_set("notify-keyspace-events", merged)
        except Exception as exc:
            log.warning("enable_keyspace_notifications: config_set failed: %s", exc)
            return False
        return True

    async def subscribe_expirations(self) -> AsyncIterator[str]:
        """Yield key names as they expire in Redis.

        Requires :meth:`enable_keyspace_notifications` to have run first
        (or equivalent server-side config). The stream is best-effort —
        Redis pub/sub doesn't replay, so a missed event means we won't
        ever know that particular key expired."""
        client = await self._client()
        topic = f"__keyevent@{_redis_db_index(self._url)}__:expired"
        pubsub = client.pubsub()
        await pubsub.subscribe(topic)
        try:
            async for message in pubsub.listen():
                if message is None:
                    continue
                if message.get("type") != "message":
                    continue
                raw = message.get("data")
                if raw is None:
                    continue
                yield raw if isinstance(raw, str) else raw.decode("utf-8", "replace")
        finally:
            try:
                await pubsub.unsubscribe(topic)
                await pubsub.aclose()
            except Exception as exc:
                log.debug("subscribe_expirations cleanup failed: %s", exc)

    @staticmethod
    def parse_user_presence_key(key: str) -> int | None:
        """Return the human id encoded in a ``user_presence:<id>`` key,
        or None if the key isn't one of those (so a single expirations
        stream can be filtered by callers)."""
        prefix = "user_presence:"
        if not key.startswith(prefix):
            return None
        try:
            return int(key[len(prefix):])
        except ValueError:
            return None

    async def offline_broadcast_try_acquire(self, human_id: int) -> bool:
        """Race-protect offline broadcasts across workers.

        Every worker subscribed to keyspace notifications receives the
        same expiry event — without a lock they'd all redundantly emit
        ``user.status: offline``. The first worker to SET-NX wins and
        broadcasts; losers no-op. TTL is short so a legitimate
        re-expiry (rare but possible if a heartbeat races back online
        and then dies again) isn't suppressed indefinitely."""
        client = await self._client()
        try:
            got = await client.set(
                f"user_presence_expiry_lock:{human_id}",
                "1",
                nx=True,
                ex=10,
            )
        except Exception as exc:
            log.warning("offline_broadcast_try_acquire failed: %s", exc)
            return False
        return bool(got)

    async def last_seen_persist_try_acquire(self, human_id: int) -> bool:
        """Atomically claim a throttle slot for persisting last_seen_at.

        Returns True if the caller may write to the DB now, False if a
        recent write covered this user. Uses SET NX EX so concurrent
        workers don't all race to write. The lock expires after
        :data:`LAST_SEEN_PERSIST_INTERVAL_SECONDS`."""
        client = await self._client()
        try:
            got = await client.set(
                _last_seen_lock_key(human_id),
                "1",
                nx=True,
                ex=LAST_SEEN_PERSIST_INTERVAL_SECONDS,
            )
        except Exception as exc:
            log.warning("EventBus.last_seen_persist_try_acquire failed: %s", exc)
            # Failing closed is the safer choice for a throttle — we'd
            # rather skip a write than double-write under Redis trouble.
            return False
        return bool(got)


# ---------------------------------------------------------------------------
# process-wide singleton, managed by the FastAPI lifespan
# ---------------------------------------------------------------------------

_bus: EventBus | None = None

# The server's main event loop — the one that owns the bus's redis
# connection pool. Captured once at startup so publishes originating on
# threadpool threads (sync FastAPI endpoints) can be scheduled back onto it
# instead of a throwaway loop. See ``set_publish_loop`` / ``fire_and_forget``.
_publish_loop: asyncio.AbstractEventLoop | None = None


def set_publish_loop(loop: asyncio.AbstractEventLoop | None) -> None:
    """Record the main event loop for cross-thread publishes.

    Sync endpoints run on a threadpool thread with no running loop. Without
    a captured main loop, ``fire_and_forget`` publishes them on a fresh
    ``asyncio.run`` loop, where redis operations fail with "attached to a
    different loop" and the event is silently dropped. Recording the loop
    here lets ``fire_and_forget`` hand those coroutines to the loop that
    owns the redis pool via ``run_coroutine_threadsafe``.
    """
    global _publish_loop
    _publish_loop = loop


def get_publish_loop() -> asyncio.AbstractEventLoop | None:
    """The captured main event loop, or ``None`` before startup / in tests."""
    return _publish_loop


def get_bus() -> EventBus:
    """Return the process-wide EventBus.

    Normally set up explicitly by the FastAPI lifespan via
    :func:`init_bus`; falls back to lazy construction if a caller reaches
    the bus before startup ran (e.g. in tests that skip the lifespan).
    """
    global _bus
    if _bus is None:
        _bus = EventBus(_redis_url())
    return _bus


def init_bus() -> EventBus:
    """Create the process-wide EventBus and capture the main loop.

    Called once from the FastAPI lifespan, which runs on the server's main
    event loop — so ``get_running_loop`` here records the loop that owns the
    bus's redis pool for later cross-thread publishes. Safe to call more
    than once. Outside a running loop (some test harnesses) the capture is
    skipped and ``fire_and_forget`` keeps its ``asyncio.run`` fallback.
    """
    try:
        set_publish_loop(asyncio.get_running_loop())
    except RuntimeError:
        pass
    return get_bus()


async def shutdown_bus() -> None:
    """Close the process-wide EventBus. Paired with :func:`init_bus`."""
    global _bus
    set_publish_loop(None)
    if _bus is not None:
        await _bus.close()
        _bus = None
