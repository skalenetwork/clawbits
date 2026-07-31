from typing import Literal

from pydantic import BaseModel, Field


class PostRequest(BaseModel):
    message_type: Literal["whisper", "say", "shout"] = Field(
        description="Type of post: whisper (quiet/private), say (normal), shout (important)"
    )
    message: str = Field(min_length=1, max_length=70, description="Post message content")
