"""The game wake loop (WIDGETS_AGENTS_PLAN §4 P4; the OpenClaw twin is plugin/src/widgets/wake.ts):
turns "a game waits on your move" signals into one silent turn per move, in the game's own session.

Signals come from the agent WebSocket (``widget.turn``, ids only) and from catch-up (the snapshot's
and every channel list's ``widget_waiting``, ``GET /widgets?waiting=1`` after ``resync_required``),
so one move is usually reported several times. Per game:
- one pending wake; a newer rev replaces it, an older one is ignored;
- ``waiting: false`` drops it; an ended game drops everything, and its sessions are deleted once
  its last turn is over (never reused: its id is remembered as ended);
- a rev already woken is woken again only on a backoff (1, 5, 15 min after its turn ended), then not
  until the rev changes, so a model that stops early can neither stall the game nor loop;
- at dispatch the game is read again (its private view), and once more when the move's turn may
  start (after the adapter's waits for a slot and a free session): no wake unless it is still the
  agent's move and the agent is neither snoozed nor paused (``hermes pause``: an internal turn
  passes the gateway's own emergency stop, so the loop checks it).
One game runs one wake at a time. Hermes has no per-sender allowlist on this platform (the server
authenticates every sender and rechecks contact on every agentic call), so there is no allowFrom.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

# Same-rev re-wakes, counted from the end of the previous wake's turn.
WAKE_RETRY_BACKOFF_S = (60.0, 300.0, 900.0)
# An ended game's cleanup again while a turn on its session still goes, then the sweep's.
CLEANUP_RETRY_S = (60.0, 300.0, 900.0)
# Games remembered as ended, so a late signal can't wake one again.
ENDED_MEMORY = 500


class GameGone(Exception):
    """The game is gone, out of the agent's reach (a 404), or (raised by ``dispatch``) over."""


@dataclass(frozen=True)
class WidgetSignal:
    """A "this game changed" signal, from any source: whether it now waits on the agent's seat."""

    widget_id: str
    channel_id: str
    rev: int
    kind: str
    seat: str | None
    waiting: bool
    status: str


def turn_signal(channel_id: Any, data: Any) -> WidgetSignal | None:
    """A ``widget.turn`` event (``{type, channel_id, data: {widget_id, rev, kind, seat, waiting,
    status}}``); None when malformed."""
    if not isinstance(data, dict):
        return None
    widget_id, rev, status = data.get("widget_id"), data.get("rev"), data.get("status")
    if not (
        isinstance(widget_id, str) and widget_id and isinstance(channel_id, str) and channel_id
        and type(rev) is int and isinstance(status, str)
    ):
        return None
    kind, seat = data.get("kind"), data.get("seat")
    return WidgetSignal(
        widget_id, channel_id, rev, kind if isinstance(kind, str) else "",
        seat if isinstance(seat, str) else None, data.get("waiting") is True, status,
    )


def waiting_signals(raw: Any) -> list[WidgetSignal]:
    """The games a channel list (the WebSocket snapshot or ``GET /channels``) says wait on the agent:
    each channel's ``widget_waiting`` (``{widget_id, rev, kind, seat}``), active by construction."""
    channels = raw if isinstance(raw, list) else raw.get("channels") if isinstance(raw, dict) else None
    out = []
    for channel in channels if isinstance(channels, list) else []:
        waiting = channel.get("widget_waiting") if isinstance(channel, dict) else None
        if isinstance(waiting, dict):
            data = {**waiting, "waiting": True, "status": "active"}
            if (signal := turn_signal(channel.get("channel_id") or channel.get("id"), data)) is not None:
                out.append(signal)
    return out


def summary_signal(summary: Any) -> WidgetSignal | None:
    """A ``GET /widgets`` entry."""
    if not isinstance(summary, dict):
        return None
    return turn_signal(summary.get("channel_id"), {**summary, "waiting": summary.get("your_move") is True})


@dataclass
class _Woken:
    rev: int
    at: float
    attempts: int


@dataclass
class _Game:
    channel_id: str
    latest_rev: int = -1
    pending: WidgetSignal | None = None
    queued: bool = False
    running: bool = False
    woken: _Woken | None = None
    cancel_retry: Callable[[], None] | None = None


def _call_later(delay: float, run: Callable[[], None]) -> Callable[[], None]:
    return asyncio.get_running_loop().call_later(delay, run).cancel


class WidgetWakes:
    """The wake loop of one adapter.

    ``read(widget_id)`` returns the private view (raising :class:`GameGone` on a 404);
    ``dispatch(view, attempt)`` runs the move's turn to its end, reading the view again once it may
    start (:class:`GameGone` ends the game); ``ended(widget_id)`` deletes an
    ended game's sessions ("busy" tries again later); ``spawn`` runs a coroutine in the owner's
    context; ``enabled``, ``snoozed`` and ``paused`` gate every wake."""

    def __init__(
        self,
        *,
        read: Callable[[str], Awaitable[dict[str, Any]]],
        dispatch: Callable[[dict[str, Any], int], Awaitable[bool]],
        spawn: Callable[[Coroutine[Any, Any, Any]], Any],
        ended: Callable[[str], Awaitable[str | None]] | None = None,
        enabled: Callable[[], bool] = lambda: True,
        snoozed: Callable[[], bool] = lambda: False,
        paused: Callable[[], bool] = lambda: False,
        now: Callable[[], float] = time.monotonic,
        call_later: Callable[[float, Callable[[], None]], Callable[[], None]] = _call_later,
        end_grace_s: Callable[[], float] = lambda: 0.0,
    ) -> None:
        self._read, self._dispatch, self._spawn, self._ended_cb = read, dispatch, spawn, ended
        self._enabled, self._snoozed, self._paused = enabled, snoozed, paused
        self._now, self._call_later, self._end_grace_s = now, call_later, end_grace_s
        self._games: dict[str, _Game] = {}
        self._ended: OrderedDict[str, None] = OrderedDict()
        self._disposed = False

    def seated(self, widget_id: str) -> bool:
        """Whether the agent holds a seat in this game, as far as any signal told."""
        return widget_id in self._games or widget_id in self._ended

    def offer(self, signal: WidgetSignal, source: str) -> None:
        if self._disposed or signal.widget_id in self._ended:
            return
        if signal.status != "active":
            self._end(signal.widget_id)
            return
        if not self._enabled():
            return
        game = self._games.setdefault(signal.widget_id, _Game(signal.channel_id))
        if signal.rev < game.latest_rev:
            return
        game.latest_rev = signal.rev
        if not signal.waiting:
            # The opponent's move now: whatever was pending is moot.
            game.pending = None
            self._cancel_retry(game)
            return
        if self._snoozed() or self._paused():
            logger.debug("clawbits: game %s rev %d (%s) not woken: snoozed or paused",
                         signal.widget_id, signal.rev, source)
            return
        if not self._due(game, signal.rev):
            return
        game.pending = signal
        self._queue(signal.widget_id, game)

    def dispose(self) -> None:
        """Stop retries; later signals are ignored."""
        self._disposed = True
        for game in self._games.values():
            self._cancel_retry(game)

    def _queue(self, widget_id: str, game: _Game) -> None:
        if game.queued or game.running or self._disposed:
            return
        game.queued = True
        self._spawn(self._run(widget_id, game))

    def _due(self, game: _Game, rev: int) -> bool:
        """Whether ``rev`` may be woken now: a new rev always, the last one only on its backoff."""
        woken = game.woken
        if woken is None or woken.rev != rev:
            return True
        if woken.attempts > len(WAKE_RETRY_BACKOFF_S):
            return False
        return self._now() >= woken.at + WAKE_RETRY_BACKOFF_S[woken.attempts - 1]

    async def _run(self, widget_id: str, game: _Game) -> None:
        game.queued = False
        signal, game.pending = game.pending, None
        if signal is None or self._games.get(widget_id) is not game or self._disposed:
            return
        if not self._enabled() or self._snoozed() or self._paused():
            return
        game.running = True
        try:
            await self._wake(widget_id, game)
        finally:
            game.running = False
            if game.pending is not None and self._games.get(widget_id) is game:
                self._queue(widget_id, game)

    async def _wake(self, widget_id: str, game: _Game) -> None:
        try:
            view = await self._read(widget_id)
        except GameGone:
            self._end(widget_id)
            return
        except Exception as exc:
            logger.warning("clawbits: game %s not read for its wake (%s)", widget_id, exc)
            return
        if view.get("status") != "active":
            self._end(widget_id)
            return
        rev = view.get("rev")
        if type(rev) is not int:
            return
        game.latest_rev = max(game.latest_rev, rev)
        if not view.get("your_move") or not view.get("seat"):
            logger.debug("clawbits: game %s rev %d not woken: not this agent's move", widget_id, rev)
            return
        if not self._due(game, rev):
            return
        # Claimed before the turn and never due while it runs, so the signals its own moves raise
        # can't wake it twice; the backoff counts from its end.
        attempts = game.woken.attempts + 1 if game.woken and game.woken.rev == rev else 1
        woken = game.woken = _Woken(rev, math.inf, attempts)
        self._cancel_retry(game)
        logger.info("clawbits: game %s wakes %s at rev %d (attempt %d)", widget_id, view.get("seat"), rev, attempts)
        try:
            await self._dispatch(view, attempts)
        except GameGone:  # it ended while the move waited for its turn
            if self._games.get(widget_id) is game:
                self._end(widget_id)
        except Exception:
            logger.warning("clawbits: game %s wake failed", widget_id, exc_info=True)
        finally:
            woken.at = self._now()
            self._schedule_retry(widget_id, game, view)

    def _cancel_retry(self, game: _Game) -> None:
        if game.cancel_retry is not None:
            game.cancel_retry()
            game.cancel_retry = None

    def _schedule_retry(self, widget_id: str, game: _Game, view: dict[str, Any]) -> None:
        """Look again once the backoff passes: the read at dispatch drops it if the move was made."""
        woken = game.woken
        if woken is None or woken.attempts > len(WAKE_RETRY_BACKOFF_S) or self._disposed:
            return
        if self._games.get(widget_id) is not game:
            return
        signal = WidgetSignal(
            widget_id, str(view.get("channel_id") or game.channel_id), woken.rev,
            str(view.get("kind") or ""), view.get("seat"), True, "active",
        )
        holder: list[Callable[[], None]] = []

        def fire() -> None:
            if not holder or game.cancel_retry is not holder[0]:
                return
            game.cancel_retry = None
            self.offer(signal, "retry")

        holder.append(self._call_later(WAKE_RETRY_BACKOFF_S[woken.attempts - 1], fire))
        game.cancel_retry = holder[0]

    def _end(self, widget_id: str) -> None:
        game = self._games.pop(widget_id, None)
        if game is not None:
            self._cancel_retry(game)
            game.pending = None
        self._ended[widget_id] = None
        while len(self._ended) > ENDED_MEMORY:
            self._ended.popitem(last=False)
        self._cleanup(widget_id, 0)

    def _cleanup(self, widget_id: str, attempt: int) -> None:
        """Delete an ended game's sessions once its turns are over; while one still goes, again on
        a backoff, then the sweep's."""
        ended = self._ended_cb
        if ended is None or (attempt > 0 and self._disposed):
            return

        async def run() -> None:
            await asyncio.sleep(self._end_grace_s() if attempt == 0 else CLEANUP_RETRY_S[attempt - 1])
            try:
                outcome = await ended(widget_id)
            except Exception:
                logger.warning("clawbits: game %s cleanup failed", widget_id, exc_info=True)
                return
            if outcome == "busy" and attempt < len(CLEANUP_RETRY_S) and not self._disposed:
                logger.debug("clawbits: cleanup of game %s waits for a turn on its session", widget_id)
                self._cleanup(widget_id, attempt + 1)

        self._spawn(run())

