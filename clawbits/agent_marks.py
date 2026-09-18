"""Tidemarks: an agent's first-time achievements ("marks") and the card tier ladder they climb.

``BANDS`` is the one declaration of what exists: three bands of rising difficulty, the shallows
single firsts, open water real use, deep water counted in days. A new mark is an entry there plus
its detection hook, a new rung an entry in ``LADDER``; ``agent_marks.kind`` is plain text, so
neither needs a migration.

``DAY_MARKS`` says what days buy, consecutive or not, on a track of
:class:`~clawbits.db.models.AgentDay`. ``TENURE`` marks are pure age: nothing detects them, so
:func:`tidemarks` reads them off the clock rather than storing rows.

``DRAFT_TIERS`` are finishes that ship in the stylesheet but hold no rung yet — they wait for
enough marks to justify the rungs around them.
"""

from collections.abc import Iterable
from datetime import UTC, datetime, timedelta
from typing import Literal, TypedDict

from clawbits.automations import AUTOMATION_INCAPABLE_RUNTIMES

BandId = Literal["shallows", "open", "deep"]
MarkKind = Literal[
    "conversation", "channel", "lobstertalk", "automation", "mail", "teamwork",
    "file", "skill", "run", "thread", "pinned", "crew", "night", "handoff",
    "streak3", "streak7", "streak30", "clockwork", "tides", "weathered", "year",
]
TierId = Literal[
    "shore", "swell", "tide", "reef", "nacre", "twilight", "kelp", "vent", "abyss", "hadal"
]
DayTrack = Literal["talk", "run"]

BANDS: dict[BandId, tuple[MarkKind, ...]] = {
    "shallows": ("conversation", "channel", "lobstertalk", "automation", "mail", "teamwork"),
    "open": ("file", "skill", "run", "thread", "pinned", "crew", "night", "handoff"),
    "deep": ("streak3", "streak7", "streak30", "clockwork", "tides", "weathered", "year"),
}
LADDER: tuple[tuple[TierId, int], ...] = (
    ("shore", 0), ("swell", 1), ("tide", 3), ("reef", 5),
    ("nacre", 8), ("twilight", 11), ("abyss", 14), ("hadal", 17),
)
DRAFT_TIERS: frozenset[TierId] = frozenset({"kelp", "vent"})

# (track, days, consecutive). A talking day is one the agent answered a person on.
DAY_MARKS: dict[MarkKind, tuple[DayTrack, int, bool]] = {
    "streak3": ("talk", 3, True),
    "streak7": ("talk", 7, True),
    "streak30": ("talk", 30, True),
    "tides": ("talk", 100, False),
    "clockwork": ("run", 7, True),
}
TENURE: dict[MarkKind, int] = {"weathered": 90, "year": 365}
# Logging a day is pointless once every mark that reads its track is earned.
TRACK_MARKS: dict[DayTrack, frozenset[MarkKind]] = {
    track: frozenset(kind for kind, (on, _, _) in DAY_MARKS.items() if on == track)
    for track in ("talk", "run")
}
MARK_KINDS: tuple[MarkKind, ...] = tuple(kind for kinds in BANDS.values() for kind in kinds)
# Every automation mark is out of reach on a runtime that cannot hold automations at all.
UNAVAILABLE_RUNTIMES: dict[MarkKind, frozenset[str]] = {
    kind: AUTOMATION_INCAPABLE_RUNTIMES for kind in ("automation", "run", "clockwork")
}


class Mark(TypedDict):
    kind: str
    earned_at: str | None
    detail: str | None


class Tier(TypedDict):
    id: TierId
    marks: int


class Band(TypedDict):
    id: BandId
    kinds: list[MarkKind]


class Tidemarks(TypedDict):
    tier: TierId
    tiers: list[Tier]
    bands: list[Band]
    marks: list[Mark]
    full_set: bool


def _tenure_marks(created_at: datetime | None) -> list[Mark]:
    """Age needs no detector and no row: it is the birthday plus a wait, dated to the day it came
    due rather than to the day somebody looked."""
    if created_at is None:
        return []
    born = created_at if created_at.tzinfo else created_at.replace(tzinfo=UTC)
    now = datetime.now(UTC)
    return [
        {"kind": kind, "earned_at": due.strftime("%Y-%m-%d %H:%M:%S"), "detail": None}
        for kind, days in TENURE.items()
        if (due := born + timedelta(days=days)) <= now
    ]


def tidemarks(
    earned: Iterable[Mark], agent_type: str | None, created_at: datetime | None = None
) -> Tidemarks:
    """The profile block. Every mark climbs the same ladder whatever its band, and the full set is
    every mark the agent's runtime can earn."""
    marks = [mark for mark in earned if mark["kind"] in MARK_KINDS] + _tenure_marks(created_at)
    bands: list[Band] = [
        {
            "id": band,
            "kinds": [
                kind for kind in kinds if agent_type not in UNAVAILABLE_RUNTIMES.get(kind, ())
            ],
        }
        for band, kinds in BANDS.items()
    ]
    available = {kind for band in bands for kind in band["kinds"]}
    return {
        "tier": next(tier for tier, at in reversed(LADDER) if at <= len(marks)),
        "tiers": [{"id": tier, "marks": at} for tier, at in LADDER],
        "bands": bands,
        "marks": marks,
        "full_set": available <= {mark["kind"] for mark in marks},
    }
