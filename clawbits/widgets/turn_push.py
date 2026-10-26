"""One "your move" ping to a person a game handed the move to, when they don't take it soon.

Each move's hand-off marks (``{seat: rev}``, :meth:`TableWrite.save_mm_widget_step`) arm a timer
here, on the loop that published the move, for each seat a person holds. After
:data:`DELAY_SECONDS` the server rereads the game (:func:`due`) and pings only while the seat still
waits at that mark, the person still holds it and may still reach the chat, and the chat isn't
muted; muting is the only off switch. A person gets one ping per game until they act in it
(:func:`limits.claim_turn_push`), however often the move comes back to them. One decision reaches
every device at once: ``widget.notify`` on their own topic (the desktop app's banner), web push,
and APNs unless they're online on web or desktop (their banners gate on focus there). The push
service holds a web push for a browser that's offline up to
:data:`web_push.TURN_PUSH_TTL_SECONDS` (10 minutes), so it can still show that late, after they
moved from another device: the price of reaching a browser that wakes a little later.

The copy is ``Your move`` / ``<Game> with <name>``: the name is a display name, never an email, and
nothing says what's on the board, in a hand or in the chips. Timers live in this process's memory,
so a restart drops every ping pending at that moment: best effort, as the push queue is.
``CLAWBITS_WIDGET_TURN_PUSH=0`` turns pings off; ``CLAWBITS_WIDGET_TURN_PUSH_DELAY_SECONDS`` is the
grace. Not re-exported from :mod:`clawbits.widgets`: it imports ``table_read``, which imports that
package.
"""
from __future__ import annotations

import asyncio
import logging
import os
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from sqlmodel import Session

from clawbits.db.engine import new_session
from clawbits.db.table_read import TableRead
from clawbits.realtime import web_push
from clawbits.realtime.bus import EventBus, get_bus
from clawbits.realtime.sse import publish_widget_notify
from clawbits.widgets import KINDS, limits
from clawbits.widgets.service import Participant

log = logging.getLogger(__name__)

ENABLED = os.getenv("CLAWBITS_WIDGET_TURN_PUSH", "1") != "0"
DELAY_SECONDS = float(os.getenv("CLAWBITS_WIDGET_TURN_PUSH_DELAY_SECONDS", "30"))
TITLE = "Your move"
NAME_MAX = 40
NO_NAME = "your opponent"

# The fire tasks in flight: the loop keeps only weak references to tasks.
_tasks: set[asyncio.Task[None]] = set()


@dataclass(frozen=True, slots=True)
class Notice:
    """A ping that's due: to whom, for which game and hand-off mark, and what it says."""

    human_id: int
    channel_id: str
    widget_id: str
    rev: int
    title: str
    body: str


def schedule(widget: Mapping[str, Any], handed: Mapping[str, int]) -> None:
    """Arm a ping for each person ``handed`` the move, ``{seat: rev}`` from the move that did it,
    in ``widget`` (its public response dict). Call on the loop that publishes the move. No-op
    while switched off or once the widget isn't active; an agent's seat is woken instead."""
    if not ENABLED or not handed or widget["status"] != "active":
        return
    loop = asyncio.get_running_loop()
    for seat in widget["seats"]:
        if seat["human_id"] is not None and seat["seat"] in handed:
            args = (widget["widget_id"], seat["seat"], seat["human_id"], handed[seat["seat"]])
            loop.call_later(DELAY_SECONDS, _spawn, loop, *args)


def _spawn(
    loop: asyncio.AbstractEventLoop, widget_id: str, seat: str, human_id: int, rev: int
) -> None:
    task = loop.create_task(_fire(widget_id, seat, human_id, rev))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


def due(session: Session, widget_id: str, seat: str, human_id: int, rev: int) -> Notice | None:
    """The ping ``human_id`` is owed for ``seat`` since the hand-off at ``rev``, or ``None`` when
    the game ended, the seat no longer waits at that mark (they acted, from any device, or the
    move left and came back), someone else holds it, they can't reach the chat any more, or they
    muted it."""
    target = TableRead.turn_push_target(session, widget_id, human_id)
    if (
        target is None
        or target["status"] != "active"
        or target["seat"] != seat
        or seat not in target["waiting_on"]
        or target["acted_revs"].get(seat) != rev
        or target["muted"]
        or not Participant.human(human_id).is_member(session, target["channel_id"])
    ):
        return None
    kind = KINDS.get(target["kind"])
    # The public scene's title only: no board, hand, chips or last move.
    scene = kind.scene(target["state"], target["status"], target["outcome"], None) if kind else {}
    game = scene.get("title") or target["kind"].capitalize()
    body = f"{game} with {_clean_name(target['opponent'])}"
    return Notice(human_id, target["channel_id"], widget_id, rev, TITLE, body)


def _clean_name(name: str | None) -> str:
    """A name fit for a lock screen: whitespace runs one space, control and format characters
    (bidi overrides, zero-width marks) gone, at most :data:`NAME_MAX` characters; when nothing is
    left, :data:`NO_NAME`."""
    spaced = "".join(" " if c.isspace() else c for c in name or "")
    kept = "".join(c for c in spaced if unicodedata.category(c) not in ("Cc", "Cf"))
    return " ".join(kept.split())[:NAME_MAX].rstrip() or NO_NAME


def _due_now(widget_id: str, seat: str, human_id: int, rev: int) -> Notice | None:
    with new_session() as session:
        return due(session, widget_id, seat, human_id, rev)


async def _fire(widget_id: str, seat: str, human_id: int, rev: int) -> None:
    """The grace is over: ping if it's still due and the person's once-per-game ping is free. A
    failure after the claim and before ``widget.notify`` went out gives the key back: nothing was
    sent, so it mustn't hold back their next ping. So does a cancel (shutdown) that lands before
    the publish starts; once it has, the PUBLISH may be out, so the key stays spent. A cancel
    during the claim itself keeps a key its SET may have taken: ``claimed`` never got the answer."""
    claimed = sending = sent = False
    try:
        if await asyncio.to_thread(_due_now, widget_id, seat, human_id, rev) is None:
            return
        claimed = await asyncio.to_thread(limits.claim_turn_push, human_id, widget_id)
        if not claimed:
            return
        # A move that landed between the check and the claim cleared no key yet: check again, and
        # give the key back if it's no longer due, or it would hold back their next real ping.
        notice = await asyncio.to_thread(_due_now, widget_id, seat, human_id, rev)
        if notice is None:
            await asyncio.to_thread(limits.clear_turn_push, human_id, widget_id)
            return
        bus = get_bus()
        sending = True
        await publish_widget_notify(
            bus,
            human_id,
            notice.channel_id,
            {"widget_id": widget_id, "rev": rev, "title": notice.title, "body": notice.body},
        )
        sent = True
        web_push.schedule_turn_push(
            human_id,
            notice.channel_id,
            widget_id,
            notice.title,
            notice.body,
            apns=not await _online(bus, human_id),
        )
    except asyncio.CancelledError:
        if claimed and not sending:
            limits.clear_turn_push(human_id, widget_id)  # in line: the loop is going down
        raise
    except Exception:
        log.exception("turn ping of %s for widget %s rev %s failed", human_id, widget_id, rev)
        if claimed and not sent:
            await asyncio.to_thread(limits.clear_turn_push, human_id, widget_id)


async def _online(bus: EventBus, human_id: int) -> bool:
    """A visible web or desktop tab of theirs was active in the last minutes: their phone keeps
    quiet. Unknown counts as away."""
    try:
        return await bus.user_presence_get(human_id) == "online"
    except Exception as e:
        log.warning("presence of %s not read for a turn ping: %s", human_id, e)
        return False
