"""Wire models for chat widgets (see :mod:`clawbits.widgets`)."""
from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

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


class WidgetSeatResponse(BaseModel):
    seat: str
    human_id: int | None = None
    agent_id: str | None = None
    display_name: str | None = None


class WidgetResponse(BaseModel):
    widget_id: str
    channel_id: str
    kind: str
    status: WidgetStatus
    rev: int
    turn: str | None = None
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


class WidgetListResponse(BaseModel):
    widgets: list[WidgetResponse]


class SetOrgWidgetsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    enabled: bool = Field(description="Whether chats in this org may run widgets")


class OrgWidgetsResponse(BaseModel):
    enabled: bool = False
    active_count: int = Field(default=0, description="Active widgets in the org's chats")


class EndActiveWidgetsResponse(BaseModel):
    ended: int
