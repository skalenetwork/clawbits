"""The one place widgets start and change, whoever calls: people and agents, each over its own REST.

A route authenticates its caller as a :class:`Participant` and maps a :class:`WidgetError` onto its
wire; locks, switches, seats, the kind's rules and saving all live here, so the planes can't drift.
Not re-exported from :mod:`clawbits.widgets`: ``clawbits.db.table_read`` imports the kinds from
there, and this module imports ``table_read``.
"""
from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Any, Literal

from sqlalchemy import ColumnElement
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from clawbits.datastructures.mm_models import PAIR_CHANNEL_TYPES
from clawbits.db.models import (
    Agent,
    MmChannel,
    MmChannelMember,
    MmWidget,
    MmWidgetSeat,
    Organization,
    OrgMember,
)
from clawbits.db.table_read import TableRead
from clawbits.db.table_write import DELETED_AGENT_ID, TableWrite
from clawbits.fastapi.version_check import widgets_eligible
from clawbits.widgets import KINDS, InvalidAction, NotYourTurn, WidgetKind, brief, chess, limits

# The action every kind takes from a seated player in any phase: no winner, and no rev check, since
# it's how a stalled game gets cleared.
END = "end"

_INTRO = {
    "chess": "♟ {name} started a chess game",
    "battleship": "⚓ {name} started a game of battleship",
    "poker": "♠ {name} started a poker match",
    "blackjack": "♣ {name} started a blackjack match",
}

WidgetErrorCode = Literal[
    "not_found",
    "ended",
    "stale_rev",
    "no_seat",
    "not_your_turn",
    "illegal_action",
    "kind_unavailable",
    "widgets_off",
    "unsupported_chat",
    "agent_unavailable",
    "already_active",
    "forbidden",
]
# One HTTP status per code: what the human routes have always answered.
_STATUS: dict[WidgetErrorCode, int] = {
    "not_found": 404,
    "ended": 409,
    "stale_rev": 409,
    "no_seat": 403,
    "not_your_turn": 403,
    "illegal_action": 422,
    "kind_unavailable": 409,
    "widgets_off": 403,
    "unsupported_chat": 422,
    "agent_unavailable": 422,
    "already_active": 409,
    "forbidden": 403,
}


class WidgetError(Exception):
    """A refused call: ``code`` for callers that branch on it, ``status_code`` and ``detail``
    for HTTP."""

    def __init__(self, code: WidgetErrorCode, detail: str) -> None:
        super().__init__(detail)
        self.code: WidgetErrorCode = code
        self.status_code: int = _STATUS[code]
        self.detail: str = detail


@dataclass(frozen=True, slots=True)
class Participant:
    """Who calls: a human or an agent, exactly one id set. A seat row holds the same pair."""

    human_id: int | None = None
    agent_id: str | None = None

    def __post_init__(self) -> None:
        if (self.human_id is None) == (self.agent_id is None):
            raise ValueError("A participant is either a human or an agent")

    @classmethod
    def human(cls, human_id: int) -> Participant:
        return cls(human_id=human_id)

    @classmethod
    def agent(cls, agent_id: str) -> Participant:
        return cls(agent_id=agent_id)

    def holds_seat(self) -> ColumnElement[bool]:
        """Matches the ``mm_widget_seats`` rows this participant holds."""
        if self.human_id is not None:
            return MmWidgetSeat.human_id == self.human_id
        return MmWidgetSeat.agent_id == self.agent_id

    def is_member(self, db: Session, channel_id: str, *, ending: bool = False) -> bool:
        """In the chat and still allowed in it, as on every other route: a revoked contact grant
        shuts an agent's DM, whose membership rows linger, to the person and the agent alike. A
        person ``ending`` a game needs only to be in the chat: the way out of a game never shuts."""
        if self.human_id is not None:
            if not TableRead.is_mm_channel_member_human(db, channel_id, self.human_id):
                return False
            agent_id = None if ending else TableRead.dm_agent_peer(db, channel_id)
            return agent_id is None or TableRead.can_dm_agent(db, agent_id, human_id=self.human_id)
        assert self.agent_id is not None
        return TableRead.is_mm_channel_member(
            db, channel_id, self.agent_id
        ) and TableRead.can_agent_access_dm(db, channel_id, self.agent_id)

    @classmethod
    def holding(cls, row: MmWidgetSeat) -> Participant:
        """Who holds a seat row."""
        return cls(human_id=row.human_id, agent_id=row.agent_id)


@dataclass(frozen=True, slots=True)
class Result:
    """A widget after a call: as the caller sees it, the public view its events carry, for a
    start the message that shows it, and for a move ``{seat: rev}`` for each seat it left waiting
    that the move came to or that keeps it, the rev taken under the row lock (a "your move" ping
    is due only while it stands)."""

    view: dict[str, Any]
    public: dict[str, Any]
    post_id: int | None = None
    handed: dict[str, int] = field(default_factory=dict)


def _result(
    db: Session,
    widget_id: str,
    participant: Participant,
    post_id: int | None = None,
    handed: dict[str, int] | None = None,
) -> Result:
    """Read back a committed call. Each player's score rides on people's views and on the public
    one, the chat's ``widget.updated`` (an agent streaming the chat sees that too); an agent's own
    view never carries it."""
    view = TableRead.get_mm_widget(
        db,
        widget_id,
        viewer_human_id=participant.human_id,
        viewer_agent_id=participant.agent_id,
        with_scores=participant.human_id is not None,
    )
    public = TableRead.get_mm_widget(db, widget_id, with_scores=True)
    assert view is not None and public is not None  # committed under our lock
    return Result(view, public, post_id, handed or {})


def _require_switches(channel: MmChannel | None, org: Organization | None) -> None:
    """The org's switch, then the chat's: either off refuses everything but :data:`END`."""
    if org is None or not org.widgets_enabled:
        raise WidgetError("widgets_off", "Widgets are off in this organization")
    if channel is None or not channel.widgets_enabled:
        raise WidgetError("widgets_off", "Widgets are off in this chat")


def _opponent(db: Session, channel: MmChannel, human_id: int) -> Participant:
    """Who plays the starter in a one-to-one chat: the other person of a DM between people, or the
    agent of a person's DM or agent chat with one. The agent must be able and allowed to play
    (:func:`widgets_eligible`), awake, and still reachable by the person; its row stays locked
    (shared) so switching its games off waits for this game and then ends it."""
    members = db.exec(
        select(MmChannelMember.human_id, MmChannelMember.agent_id).where(
            MmChannelMember.channel_id == channel.channel_id
        )
    ).all()
    people = [h for h, _ in members if h is not None and h != human_id]
    agents = [a for _, a in members if a is not None and a != DELETED_AGENT_ID]
    if channel.channel_type == "direct" and len(people) == 1 and not any(a for _, a in members):
        return Participant.human(people[0])
    if channel.channel_type not in PAIR_CHANNEL_TYPES or people or len(agents) != 1:
        raise WidgetError(
            "unsupported_chat", "Widgets run in one-to-one chats between people for now"
        )
    agent = TableWrite.lock_agent(db, agents[0], shared=True)
    if (
        agent is None
        or agent.snoozed
        or not widgets_eligible(agent.agent_type, agent.capabilities, agent.widgets_enabled)
        or not TableRead.can_agent_access_dm(db, channel.channel_id, agent.agent_id)
    ):
        raise WidgetError("agent_unavailable", "This agent can't play games")
    return Participant.agent(agent.agent_id)


def _person_deals(kind_name: str, state: dict[str, Any], holders: dict[str, Participant]) -> str | None:
    """The person's seat at a poker showdown against an agent: they deal the next hand, whoever's
    button it is, so a match never waits on an agent to start a hand. ``None`` everywhere else."""
    if kind_name != "poker" or state.get("phase") != "showdown":
        return None
    people = [seat for seat, holder in holders.items() if holder.human_id is not None]
    return people[0] if len(holders) == 2 and len(people) == 1 else None


def _expected(
    kind_name: str, kind: WidgetKind, state: dict[str, Any], holders: dict[str, Participant]
) -> tuple[str | None, tuple[str, ...]]:
    """``turn`` and ``waiting_on`` for a state: the kind's, unless who holds the seats changes it."""
    if (dealer := _person_deals(kind_name, state, holders)) is not None:
        return dealer, (dealer,)
    return kind.turn(state), kind.waiting_on(state)


def _operates_a_seat(db: Session, human_id: int, holders: dict[str, Participant]) -> bool:
    """``human_id`` operates an agent holding one of these seats and is still in its org: removing
    someone from an org leaves ``operator_id`` set but takes every power over its agents."""
    agent_ids = [holder.agent_id for holder in holders.values() if holder.agent_id is not None]
    return bool(agent_ids) and db.exec(
        select(Agent.agent_id)
        .join(OrgMember, OrgMember.org_id == Agent.org_id)
        .where(Agent.agent_id.in_(agent_ids))
        .where(Agent.operator_id == human_id)
        .where(OrgMember.human_id == human_id)
    ).first() is not None


def create(
    db: Session,
    human_id: int,
    channel_id: str,
    kind_name: str,
    seat: str | None,
    *,
    frontend_root: str,
) -> Result:
    """Start a widget in a one-to-one chat and commit: the starter (a person; the caller checked
    they belong to the chat) takes ``seat``, random when ``None``, and the other side (a person or
    an agent, see :func:`_opponent`) the remaining one. Needs both switches on and no other active
    widget in the chat. Posts the one message that shows it, linking under ``frontend_root``."""
    kind = KINDS.get(kind_name)
    if kind is None:
        raise WidgetError("kind_unavailable", "This kind of widget is no longer available")
    if seat is not None and seat not in kind.seats:
        raise WidgetError("illegal_action", f"Unknown seat {seat!r}")
    # The chat locked, the org held: neither switch turns off between this check and the insert.
    channel = TableWrite.lock_mm_channel(db, channel_id)
    if channel is None:
        raise WidgetError("not_found", "Channel not found")
    org = TableWrite.lock_organization(db, channel.org_id, shared=True) if channel.org_id else None
    _require_switches(channel, org)
    opponent = _opponent(db, channel, human_id)
    mine = seat or random.choice(kind.seats)
    theirs = next(s for s in kind.seats if s != mine)
    holders = {mine: Participant.human(human_id), theirs: opponent}
    state = kind.init()
    turn, waiting_on = _expected(kind_name, kind, state, holders)
    try:
        widget_id = TableWrite.create_mm_widget(
            db,
            channel_id=channel_id,
            kind=kind_name,
            state=state,
            turn=turn,
            waiting_on=waiting_on,
            seats={s: (holder.human_id, holder.agent_id) for s, holder in holders.items()},
            created_by_human_id=human_id,
        )
    except IntegrityError as e:
        db.rollback()
        raise WidgetError("already_active", "This chat already has an active widget") from e
    name = TableRead.resolve_human_display(db, human_id) or "Someone"
    message = f"{_INTRO[kind_name].format(name=name)} · {frontend_root}/widgets/{widget_id}"
    post_id = TableWrite.create_mm_post_human(
        db, channel_id, human_id, message, widget_id=widget_id
    )
    TableWrite.mark_mm_channel_read(db, channel_id, human_id, post_id)
    db.commit()
    return _result(db, widget_id, Participant.human(human_id), post_id)


def act(
    db: Session,
    participant: Participant,
    widget_id: str,
    action: dict[str, Any],
    expected_rev: int | None,
) -> Result:
    """Apply one action by the participant's seat and commit. ``expected_rev``, when given (people
    always give it), must be the current ``rev``, so a move on a stale board is refused rather than
    a surprise. A person's older board is still good while their seat neither acted nor got the
    move since it, provided the kind takes the action now. :data:`END` skips that check, the
    switches and the contact check: it ends the game as ``stopped``; an agent seat's operator
    (still in its org) may use it from outside the chat."""
    widget = TableWrite.lock_mm_widget(db, widget_id)
    if widget is None:
        raise WidgetError("not_found", "Widget not found")
    ending = action.get("type") == END
    holders = {
        row.seat: Participant.holding(row)
        for row in db.exec(select(MmWidgetSeat).where(MmWidgetSeat.widget_id == widget_id)).all()
    }
    seat = next((s for s, holder in holders.items() if holder == participant), None)
    # A stalled agent's game is its operator's to clear, wherever it's played.
    operates = (
        ending
        and seat is None
        and participant.human_id is not None
        and _operates_a_seat(db, participant.human_id, holders)
    )
    if not operates and not participant.is_member(db, widget.channel_id, ending=ending):
        raise WidgetError("not_found", "Widget not found")
    if widget.status != "active":
        raise WidgetError("ended", "This widget has ended")
    stale = not ending and expected_rev is not None and expected_rev != widget.rev
    if stale and not (
        participant.human_id is not None
        and seat in widget.waiting_on
        and expected_rev is not None
        and expected_rev < widget.rev
        and (widget.acted_revs or {}).get(seat, widget.rev) <= expected_rev
    ):
        raise WidgetError("stale_rev", "The widget changed meanwhile; try again")
    if seat is None and not operates:
        raise WidgetError("no_seat", "You don't have a seat in this widget")
    if ending:
        if participant.agent_id is not None:
            # A person's way out of a stalled game, not an agent's out of a losing one: an agent's
            # side is ended by its operator, never by the agent itself.
            raise WidgetError("forbidden", "An agent can't end a game")
        TableWrite.abort_mm_widgets(db, "stopped", MmWidget.widget_id == widget_id)
        db.commit()
        return _result(db, widget_id, participant)
    # Unlocked reads: neither switch turns off while a widget is active, so this only backs that up.
    channel = db.get(MmChannel, widget.channel_id)
    org = db.get(Organization, channel.org_id) if channel and channel.org_id else None
    _require_switches(channel, org)
    kind = KINDS.get(widget.kind)
    if kind is None:
        raise WidgetError("kind_unavailable", "This kind of widget is no longer available")
    assert seat is not None  # only END goes on without one
    try:
        dealer = _person_deals(widget.kind, widget.state, holders)
        if action.get("type") == "deal" and dealer not in (None, seat):
            raise NotYourTurn("The other player deals the next hand")
        step = kind.act(widget.state, seat, action)
    except InvalidAction as e:
        if stale:
            # Taken on an older board only if it still fits; otherwise that board is the reason.
            raise WidgetError("stale_rev", "The widget changed meanwhile; try again") from e
        code: WidgetErrorCode = "not_your_turn" if isinstance(e, NotYourTurn) else "illegal_action"
        raise WidgetError(code, str(e)) from e
    turn, waiting_on = _expected(widget.kind, kind, step.state, holders)
    handed = TableWrite.save_mm_widget_step(
        db,
        widget,
        state=step.state,
        status=step.status,
        outcome=step.outcome,
        turn=turn,
        waiting_on=waiting_on,
        seat=seat,
    )
    db.commit()
    return _result(db, widget_id, participant, handed=handed)


def agent_reaches(db: Session, agent_id: str, widget_id: str) -> bool:
    """The widget exists and ``agent_id`` is in its chat and may still reach it: checked first on
    every agent call, so any other widget is the same "not found"."""
    row = db.get(MmWidget, widget_id)
    return row is not None and Participant.agent(agent_id).is_member(db, row.channel_id)


def agent_view(db: Session, agent_id: str, widget_id: str, *, private: bool) -> dict[str, Any] | None:
    """What ``agent_id`` reads of a widget in a chat it may still reach, ``None`` for any other:
    its own seat's scene, options and how to play them when ``private`` asks and it holds one, else
    the public scene, to talk about and not to play from; briefed by :mod:`clawbits.widgets.brief`.
    Only a game's own session asks ``private``, so a hand never reaches the agent's ordinary chat
    turns, nor does a move get made from one."""
    if not agent_reaches(db, agent_id, widget_id):
        return None
    row = db.get(MmWidget, widget_id)  # loaded by agent_reaches: no second query
    assert row is not None
    widget = TableRead.get_mm_widget(db, widget_id, viewer_agent_id=agent_id if private else None)
    assert widget is not None
    kind = KINDS.get(row.kind)
    position = None
    if row.kind == "chess" and kind is not None and not kind.private:
        # Chess keeps no secrets, so its position may come from the moves themselves.
        at = chess.position(row.state)
        legal = at.legal_moves()
        position = (at.fen(), sorted(at.san(move, legal) for move in legal))
    own = private and any(s["agent_id"] == agent_id for s in widget["seats"])
    agent_type = db.exec(select(Agent.agent_type).where(Agent.agent_id == agent_id)).first()
    return brief.agent_view(widget, agent_id, agent_type, own_scene=own, position=position)


def agent_widgets(
    db: Session, agent_id: str, *, channel_id: str | None = None, waiting: bool = False
) -> list[dict[str, Any]]:
    """The active widgets ``agent_id`` holds a seat in, newest first, in chats it may still reach
    (only ``channel_id``, when given); with ``waiting``, only those waiting on its move."""
    if waiting and limits.wakes_spent(agent_id):
        # Past its daily wake budget, catch-up stops offering moves too, or it would wake past the cap.
        return []
    me = Participant.agent(agent_id)
    entries = [
        brief.summary(widget, agent_id)
        for widget in TableRead.list_active_mm_widgets_seating_agent(db, agent_id, channel_id)
        if me.is_member(db, widget["channel_id"])
    ]
    return [e for e in entries if e["your_move"] or not waiting]
