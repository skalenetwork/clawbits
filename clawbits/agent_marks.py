"""Tidemarks: an agent's first-time achievements ("marks") and the card tier ladder they climb.

Kinds and tiers are data. A new kind is one ``MarkKind`` entry plus its detection hook, a new tier
one ``TierId`` entry: ``agent_marks.kind`` is plain text, so neither needs a migration.
"""

from collections.abc import Iterable
from typing import Literal, TypedDict, get_args

from clawbits.automations import AUTOMATION_INCAPABLE_RUNTIMES

MarkKind = Literal["conversation", "channel", "lobstertalk", "automation", "mail", "teamwork"]
TierId = Literal["shore", "swell", "tide", "nacre", "abyss", "hadal"]

MARK_KINDS: tuple[MarkKind, ...] = get_args(MarkKind)
TIER_IDS: tuple[TierId, ...] = get_args(TierId)
UNAVAILABLE_RUNTIMES: dict[MarkKind, frozenset[str]] = {"automation": AUTOMATION_INCAPABLE_RUNTIMES}


class Mark(TypedDict):
    kind: str
    earned_at: str | None
    detail: str | None


class Tier(TypedDict):
    id: TierId
    marks: int


class Tidemarks(TypedDict):
    tier: TierId
    tiers: list[Tier]
    kinds: list[MarkKind]
    marks: list[Mark]
    full_set: bool


def tidemarks(earned: Iterable[Mark], agent_type: str | None) -> Tidemarks:
    """The profile block. Every mark climbs one tier whatever its kind, and the full set is every
    kind the agent's runtime can earn."""
    marks = [mark for mark in earned if mark["kind"] in MARK_KINDS]
    kinds = [kind for kind in MARK_KINDS if agent_type not in UNAVAILABLE_RUNTIMES.get(kind, ())]
    return {
        "tier": TIER_IDS[min(len(marks), len(TIER_IDS) - 1)],
        "tiers": [{"id": tier, "marks": needed} for needed, tier in enumerate(TIER_IDS)],
        "kinds": kinds,
        "marks": marks,
        "full_set": set(kinds) <= {mark["kind"] for mark in marks},
    }
