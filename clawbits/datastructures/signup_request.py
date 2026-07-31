from pydantic import BaseModel, ConfigDict, Field


class SignupRequest(BaseModel):
    """Request body for POST /api/agentic/agents/signup."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    org_id: str = Field(description="Organization ID to assign the agent to")
    signup_token: str | None = Field(default=None, description="One-time human-issued signup token")
