"""The contract every widget kind implements. See :mod:`clawbits.widgets`."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Protocol

WidgetStatus = Literal["active", "finished", "aborted"]
# Why the server ended a widget for its players; kinds render these in their scene.
AbortReason = Literal[
    "aborted", "idle", "left", "ended", "host_deleted", "stopped", "agent_idle", "games_off"
]

ABORT_TEXT: dict[str, str] = {
    # Why a widget ended early, the reason alone: clients say that it ended.
    "aborted": "A player called it off",
    "idle": "2 days without a move",
    "left": "A player left",
    "ended": "An organization admin ended it",
    "host_deleted": "Its message was deleted",
    "stopped": "A player ended it",
    # The agent seat stopped answering: the idle reaper's own reason for agents.
    "agent_idle": "The agent stopped responding",
    # The agent's "Can play games" setting was switched off.
    "games_off": "The agent's games were switched off",
}


class InvalidAction(ValueError):
    """The action is malformed or not allowed in the widget's current state."""


class NotYourTurn(InvalidAction):
    """The caller's seat may not act now."""


@dataclass(frozen=True, slots=True)
class Step:
    """What an action did: the next state, the widget's status, and its outcome once it ends."""

    state: dict[str, Any]
    status: WidgetStatus = "active"
    outcome: dict[str, Any] | None = None


class WidgetKind(Protocol):
    """A kind owns its rules; the server owns storage, seats, revisions and realtime."""

    seats: tuple[str, ...]
    # True when a seat may see what others may not (a fleet, a hand): each viewer then gets its own
    # scene, and realtime events carry only the public one.
    private: bool

    def init(self) -> dict[str, Any]:
        """The state of a new widget."""
        ...

    def turn(self, state: dict[str, Any]) -> str | None:
        """The seat expected to act next while active, ``None`` when no one is."""
        ...

    def waiting_on(self, state: dict[str, Any]) -> tuple[str, ...]:
        """Every seat the widget waits on while active, in seat order; ``turn`` is always one of
        them. More than one while seats act at once (fleets placed, bets made)."""
        ...

    def act(self, state: dict[str, Any], seat: str, action: dict[str, Any]) -> Step:
        """Apply ``action`` by ``seat``. Raises :class:`InvalidAction` (or :class:`NotYourTurn`)."""
        ...

    def scene(
        self,
        state: dict[str, Any],
        status: WidgetStatus,
        outcome: dict[str, Any] | None,
        seat: str | None = None,
    ) -> dict[str, Any]:
        """The declarative view ``seat`` draws (``None``: anyone without a seat). Data only, never
        markup or code; a private kind shows a seat only what that seat may know."""
        ...
