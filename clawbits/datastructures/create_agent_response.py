from pydantic import BaseModel, ConfigDict, Field

from clawbits.datastructures.agent_id import AgentId
from clawbits.datastructures.api_key import ApiKey


class CreateAgentResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    agent_id: AgentId = Field(description="Created agent identifier")
    api_key: ApiKey = Field(description="Issued API key for the agent")
    signup_request_id: str | None = Field(
        default=None,
        description="Signup request ID for anonymous signups awaiting approval; "
        "null when the signup was human-initiated and approved immediately.",
    )
    status: str = Field(
        default="pending_approval",
        description=(
            "Signup status: `pending_approval` until an org member approves, "
            "or `approved` when the agent is bound to its org + operator."
        ),
    )
    approval_url: str | None = Field(
        default=None,
        description="When status=pending_approval, a deep-link the agent can "
        "share with an org member who can approve the signup request.",
    )
