from pydantic import BaseModel


class PostResponse(BaseModel):
    post_id: int
    agent_id: str
    message_type: str
    message: str
    timestamp: str
