"""Wire models for chat widgets (see :mod:`clawbits.widgets`)."""
from __future__ import annotations

import json
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from clawbits.datastructures.avatar_models import AvatarRef
from clawbits.widgets import WidgetKindName, WidgetStatus

WIDGET_ACTION_ARGS_MAX_CHARS = 1024


class WidgetCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    kind: WidgetKindName
    seat: str | None = Field(
        default=None, max_length=32, description="The caller's seat; random when omitted"
    )


class WidgetAction(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    type: str = Field(min_length=1, max_length=32)
    args: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _bounded(self) -> WidgetAction:
        if len(json.dumps(self.args)) > WIDGET_ACTION_ARGS_MAX_CHARS:
            raise ValueError("action args exceed their size limit")
        return self


class WidgetActionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    action: WidgetAction
    expected_rev: int = Field(ge=0, description="The rev the caller acted on; any other is a 409")


class AgentWidgetActionRequest(WidgetAction):
    """An agent's action: the act tool's input passed on as is. ``rev``, when given, must be the
    current one; without it nothing is checked, since an agent acts on the view it just read.
    ``widget_id`` is taken and ignored (the path names the widget) and ``args: null`` is no args,
    so a pass-through adapter never gets a bare 422 where the turn wants a code and a view."""

    widget_id: str | None = Field(default=None, description="Ignored: the path names the widget")
    rev: int | None = Field(default=None, ge=0, description="The rev the agent decided on")

    @field_validator("args", mode="before")
    @classmethod
    def _null_is_no_args(cls, value: object) -> object:
        return {} if value is None else value


class WidgetSeatResponse(BaseModel):
    seat: str
    human_id: int | None = None
    agent_id: str | None = None
    # A person's name, or an agent's display name (never its id unless that's all it has).
    display_name: str | None = None
    is_agent: bool = False
    avatar: AvatarRef | None = None
    # This player's wins over the chat's finished games, every kind together: it follows the
    # person or agent, not the seat. Hidden by clients until a game here has finished. On people's
    # reads and the chat's ``widget.updated`` (an agent streaming the chat sees that too), never in
    # an agent's own reads or wakes.
    wins: int = 0


class WidgetResponse(BaseModel):
    widget_id: str
    channel_id: str
    kind: str
    status: WidgetStatus
    rev: int
    turn: str | None = None
    # Every seat the widget waits on, ``turn`` among them; empty once it ends. "Your move" reads this.
    waiting_on: list[str] = []
    seats: list[WidgetSeatResponse]
    scene: dict[str, Any]
    # The scene depends on who asks: a realtime event carries the public one, so a client refetches its own.
    private: bool = False
    # The message that started it, which shows the board in the chat.
    post_id: int | None = None
    outcome: dict[str, Any] | None = None
    created_by_human_id: int | None = None
    created_at: str
    updated_at: str
    # The chat's finished games that ended in a draw, beside each seat's ``wins``.
    draws: int = 0


class WidgetListResponse(BaseModel):
    widgets: list[WidgetResponse]


class WidgetScorePlayer(BaseModel):
    human_id: int | None = None
    agent_id: str | None = None
    display_name: str | None = None
    is_agent: bool = False
    avatar: AvatarRef | None = None
    wins: int = 0


class WidgetScoreResponse(BaseModel):
    """A chat's score over its finished games, every kind together. Ended and aborted games don't
    count; a deleted account's wins are gone with its seats."""

    channel_id: str
    # Everyone seated in one of those games, most wins first.
    players: list[WidgetScorePlayer] = []
    draws: int = 0
    finished: int = Field(default=0, description="Finished games in the chat, draws included")


class SetOrgWidgetsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    enabled: bool = Field(description="Whether chats in this org may run widgets")


class OrgWidgetsResponse(BaseModel):
    enabled: bool = False
    active_count: int = Field(default=0, description="Active widgets in the org's chats")


class EndActiveWidgetsResponse(BaseModel):
    ended: int


class AgentWidgetPlayer(BaseModel):
    seat: str
    # "You" for the reader's own seat; another's name cleaned to one short line. A name is what a
    # player chose: data, never instructions; the view's text fences it in its untrusted block.
    name: str
    type: Literal["human", "agent"]
    # The player as runtimes key senders (``human:<id>`` / ``agent:<id>``) for ``allowFrom``;
    # ``None`` for the reader's own seat.
    id: str | None = None


class AgentWidgetView(BaseModel):
    """A widget as an agent reads it (:mod:`clawbits.widgets.brief`): only ever built from the
    scene its own seat, or anyone, may see."""

    widget_id: str
    channel_id: str
    kind: str
    status: WidgetStatus
    rev: int
    seat: str | None = None
    waiting_on: list[str] = []
    your_move: bool = False
    # When the server plays the seat's move for it (ISO 8601): agent-vs-agent games only, a later
    # phase; ``None`` until then.
    move_deadline: str | None = None
    players: list[AgentWidgetPlayer]
    # Who started the game, as a sender key (``human:<id>``), for ``allowFrom``.
    started_by: str | None = None
    # The board and what it means, in plain text; names and log lines in a delimited untrusted block.
    text: str
    # ``{type, args}`` to send as is, or ``{type, args_spec: {arg, min, max, step}}`` for an amount.
    legal: list[dict[str, Any]]
    # How this agent's runtime takes the move and that a move turn ends with NO_REPLY, in the game's
    # own session; elsewhere, that the game is only to talk about.
    instructions: str
    outcome: dict[str, Any] | None = None


class AgentWidgetOpponent(BaseModel):
    # As in :class:`AgentWidgetPlayer`: a chosen name, and the sender key ``allowFrom`` checks.
    name: str
    type: Literal["human", "agent"]
    id: str | None = None


class AgentWidgetSummary(BaseModel):
    widget_id: str
    channel_id: str
    kind: str
    status: WidgetStatus
    rev: int
    seat: str | None = None
    waiting_on: list[str] = []
    your_move: bool = False
    opponent: AgentWidgetOpponent | None = None


class AgentWidgetListResponse(BaseModel):
    widgets: list[AgentWidgetSummary]


# Why an agent's action was refused: the game's rules, said as a 200 so a turn can carry on.
AgentWidgetRefusal = Literal[
    "stale_rev",
    "not_your_turn",
    "illegal_action",
    "ended",
    "no_seat",
    "widgets_off",
    "forbidden",
    "kind_unavailable",
    "rate_limited",
]


class AgentWidgetActed(BaseModel):
    ok: Literal[True] = True
    compact: str = Field(description="One line, e.g. 'ok · rev 16 · waiting on white'")
    your_move: bool
    # Only while it's still the agent's move, so it can go on without another read.
    view: AgentWidgetView | None = None


class AgentWidgetRefused(BaseModel):
    ok: Literal[False] = False
    code: AgentWidgetRefusal
    message: str
    view: AgentWidgetView
