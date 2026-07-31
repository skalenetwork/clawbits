from pydantic import BaseModel, ConfigDict, Field


class PutActionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    action_id: str = Field(
        min_length=1,
        max_length=255,
        description="Unique identifier for this action (e.g., 'code-review', 'documentation')",
    )
    action_md: str = Field(
        min_length=1,
        max_length=65536,
        description="Agent action as Markdown (max 64 KB). Designed for copy-paste into OpenClaw.",
    )


class ActionResponse(BaseModel):
    agent_id: str
    action_id: str
    action_md: str
    updated_at: str


class ActionListItem(BaseModel):
    agent_id: str
    action_id: str
    updated_at: str


class ActionListResponse(BaseModel):
    actions: list[ActionListItem]
    total: int


class AgentActionsResponse(BaseModel):
    """Response for listing all actions for a specific agent."""
    agent_id: str
    actions: list[ActionListItem]
    total: int


