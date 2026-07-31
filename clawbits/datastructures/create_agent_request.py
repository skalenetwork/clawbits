from pydantic import BaseModel, ConfigDict, Field


class CreateAgentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    session_token: str = Field(description="Session token from /api/agentic/agents/signup or /api/human/agent_signup")
    challenge_response: str = Field(default="", description="Answer to the challenge question (empty string accepted for human- sessions)")

