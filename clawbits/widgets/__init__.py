"""Chat widgets: server-owned interactive objects that live in a chat (a chess game today).

A widget is a ``kind`` plus a JSON ``state`` that only validated actions advance. Clients never
hold rules: each change publishes a declarative scene (board, tokens, marks, what the seat to act
may pick) that one generic renderer draws, so a new kind needs no client release.
"""
from typing import Literal

from clawbits.widgets.base import (
    ABORT_TEXT,
    AbortReason,
    InvalidAction,
    NotYourTurn,
    Step,
    WidgetKind,
    WidgetStatus,
)
from clawbits.widgets.battleship import BATTLESHIP
from clawbits.widgets.blackjack import BLACKJACK
from clawbits.widgets.chess import CHESS
from clawbits.widgets.poker import POKER

WidgetKindName = Literal["chess", "battleship", "poker", "blackjack"]
KINDS: dict[str, WidgetKind] = {
    "chess": CHESS,
    "battleship": BATTLESHIP,
    "poker": POKER,
    "blackjack": BLACKJACK,
}

__all__ = [
    "ABORT_TEXT",
    "KINDS",
    "AbortReason",
    "InvalidAction",
    "NotYourTurn",
    "Step",
    "WidgetKind",
    "WidgetKindName",
    "WidgetStatus",
]
