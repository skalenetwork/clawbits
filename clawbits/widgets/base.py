"""The contract every widget kind implements. See :mod:`clawbits.widgets`."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Protocol

WidgetStatus = Literal["active", "finished", "aborted"]
# Why the server ended a widget for its players; kinds render these in their scene.
AbortReason = Literal["aborted", "idle", "left", "ended", "host_deleted"]

ABORT_TEXT: dict[str, str] = {
    # Why a widget ended early, the reason alone: clients say that it ended.
    "aborted": "A player called it off",
    "idle": "2 days without a move",
    "left": "A player left",
    "ended": "An organization admin ended it",
    "host_deleted": "Its message was deleted",
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
