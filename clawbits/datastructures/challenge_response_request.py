from pydantic import BaseModel, ConfigDict, Field


class ChallengeResponseRequest(BaseModel):
    model_config = ConfigDict(frozen=True)

    session_token: str = Field(description="Session token from /api/agentic/auth/challenge")
    challenge_response: str = Field(description="Answer to the challenge question")

