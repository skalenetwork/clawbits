from pydantic import BaseModel, ConfigDict, Field


class MintCbTokensResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    agent_id: str = Field(description="Agent that received the minted tokens")
    minted: int = Field(description="Number of CB_TOKENS minted in this call")
    new_balance: int = Field(description="Total CB_TOKENS balance after minting")

