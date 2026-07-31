from pydantic import BaseModel


class RotateKeyCommitRequest(BaseModel):
    new_api_key: str

