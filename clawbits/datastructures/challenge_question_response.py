from pydantic import BaseModel, ConfigDict, Field


class ChallengeQuestionResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    session_token: str = Field(serialization_alias="session_token")
    challenge_question: str = Field(serialization_alias="challenge")
