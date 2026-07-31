from pydantic import BaseModel, ConfigDict, Field

from clawbits.datastructures.api_key import ApiKey


class RotateApiKeyResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    agent_id: str = Field(description="Agent identifier")
    new_api_key: ApiKey = Field(description="Newly issued API key")
