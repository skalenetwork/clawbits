"""Caps on widget calls, agent wakes and people's turn pings, counted in Redis so every worker
shares one count.

An agent's move costs no CB_TOKENS (its route is billing-exempt), so these caps are what bound a
runaway loop; people get their own, wider ones. Each window is a fixed minute that starts at its
first call. Waking an agent costs it a turn, so a wake goes out once per widget rev and within a
daily budget per agent. A person gets one "your move" ping per game until they act in it. Redis
being unreachable never stops a game: the call (or the wake, or the ping) goes through and a line
is logged.
"""
from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass
from typing import Literal

import redis

from clawbits.realtime.bus import _redis_url

log = logging.getLogger(__name__)

# Every limit's keys start with this, so tests can clear them all.
KEY_PREFIX = "widget-limit:"
WINDOW_SECONDS = 60


@dataclass(frozen=True, slots=True)
class Limit:
    name: str
    per_minute: int


AGENT_ACT = Limit("agent-act", 60)
HUMAN_ACT = Limit("human-act", 120)
CREATE = Limit("create", 10)

# Wakes per agent in a day (a window that opens at its first wake), however many games it plays.
AGENT_DAILY_WAKES = int(os.getenv("CLAWBITS_WIDGET_AGENT_DAILY_WAKES", "2000"))
DAY_SECONDS = 24 * 3600
# How long a sent turn ping holds back the next one when its person never acts: the idle reaper's
# two days, after which the game is gone anyway.
TURN_PUSH_HOLD_SECONDS = 2 * DAY_SECONDS

WakeVerdict = Literal["wake", "duplicate", "over_budget"]

_client: redis.Redis | None = None
_client_lock = threading.Lock()


def client() -> redis.Redis:
    """The shared sync client, on the realtime bus's Redis. Connects on first use."""
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                _client = redis.Redis.from_url(
                    _redis_url(), socket_timeout=1, socket_connect_timeout=1, decode_responses=True
                )
    return _client


def retry_after(limit: Limit, who: str | int) -> int | None:
    """Count one call by ``who`` against ``limit``: ``None`` while within it, else the seconds
    until its window ends."""
    key = f"{KEY_PREFIX}{limit.name}:{who}"
    try:
        # One transaction: the window opens on its first call (SET NX, any Redis version) and
        # every call counts, refused ones too, so hammering never reopens it early.
        pipe = client().pipeline()
        pipe.set(key, 0, ex=WINDOW_SECONDS, nx=True)
        pipe.incr(key)
        pipe.ttl(key)
        _, count, ttl = pipe.execute()
    except redis.RedisError as e:
        log.warning("widget limit %s for %s not checked: Redis unreachable (%s)", limit.name, who, e)
        return None
    return None if count <= limit.per_minute else max(1, ttl)


def claim_wake(agent_id: str, widget_id: str, rev: int) -> WakeVerdict:
    """Whether to wake ``agent_id`` for ``widget_id`` at ``rev``: ``"wake"`` the first time, counted
    against its daily budget; ``"duplicate"`` for a rev it was already woken at (nothing counted);
    ``"over_budget"`` once the budget is spent."""
    once = f"{KEY_PREFIX}wake:{agent_id}:{widget_id}:{rev}"
    budget = f"{KEY_PREFIX}wakes:{agent_id}"
    try:
        r = client()
        if not r.set(once, 1, ex=DAY_SECONDS, nx=True):
            return "duplicate"
        # As in retry_after: the day opens on its first wake, and every new rev counts.
        pipe = r.pipeline()
        pipe.set(budget, 0, ex=DAY_SECONDS, nx=True)
        pipe.incr(budget)
        _, count = pipe.execute()
    except redis.RedisError as e:
        log.warning(
            "widget wake of %s for %s not capped: Redis unreachable (%s)", agent_id, widget_id, e
        )
        return "wake"
    return "wake" if count <= AGENT_DAILY_WAKES else "over_budget"


def wakes_spent(agent_id: str) -> bool:
    """Whether ``agent_id`` has used up today's wake budget: catch-up reads (``?waiting=1``,
    ``widget_waiting``) then stop offering its games too, or they would wake it past the cap."""
    try:
        count = client().get(f"{KEY_PREFIX}wakes:{agent_id}")
    except redis.RedisError as e:
        log.warning("widget wake budget of %s not checked: Redis unreachable (%s)", agent_id, e)
        return False
    return count is not None and int(count) >= AGENT_DAILY_WAKES


def claim_turn_push(human_id: int, widget_id: str) -> bool:
    """Whether to ping ``human_id`` that ``widget_id`` waits on them: ``True`` once, then ``False``
    until :func:`clear_turn_push` (they acted in it). However often a game hands them the move,
    they get one ping until they act."""
    try:
        claimed = client().set(
            f"{KEY_PREFIX}turn-push:{human_id}:{widget_id}", 1, ex=TURN_PUSH_HOLD_SECONDS, nx=True
        )
    except redis.RedisError as e:
        log.warning(
            "turn ping of %s for %s not held back: Redis unreachable (%s)", human_id, widget_id, e
        )
        return True
    return bool(claimed)


def clear_turn_push(human_id: int, widget_id: str) -> None:
    """``human_id`` acted in ``widget_id``: its next hand-off may ping them again. Best effort: a
    Redis blip never fails their action, it only leaves the key held, so their next ping in this
    game waits until they act again or the hold runs out."""
    try:
        client().delete(f"{KEY_PREFIX}turn-push:{human_id}:{widget_id}")
    except redis.RedisError as e:
        log.warning(
            "turn ping of %s for %s not cleared: Redis unreachable (%s)", human_id, widget_id, e
        )
