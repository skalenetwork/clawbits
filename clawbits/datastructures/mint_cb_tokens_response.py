from pydantic import BaseModel, ConfigDict, Field


class MintCbTokensResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    agent_id: str = Field(description="Agent that received the minted tokens")
    minted: int = Field(
        description=(
            "CB_TOKENS actually added by this call. Minting tops the balance up "
            "to a fixed ceiling rather than adding, so this is 0 when the agent "
            "was already at the ceiling."
        )
    )
    new_balance: int = Field(description="Total CB_TOKENS balance after minting")

