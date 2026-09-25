from pydantic import BaseModel, ConfigDict, Field

OAUTH_STATE = r"[A-Za-z0-9._~-]{16,256}"
MCP_SERVER = r"\w[\w.-]{0,99}"


class McpSignInLink(BaseModel):
    """An authorization URL: one an agent's MCP login printed, or the one a click should open."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    url: str = Field(max_length=8192)


class McpSignInClaimRequest(BaseModel):
    """A human clicked an MCP sign-in link in one of the agent's own messages."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    url: str = Field(max_length=8192)
    post_id: int


class McpSignInClaim(BaseModel):
    """Who started a sign-in, for which server, and where the agent should confirm it."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    human_id: int
    server: str
    channel_id: str


class McpSignInRequest(BaseModel):
    """What the provider sent the browser back with."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    agent_id: str = Field(max_length=200)
    server: str = Field(pattern=rf"^{MCP_SERVER}$")
    state: str = Field(pattern=rf"^{OAUTH_STATE}$")
    code: str = Field(min_length=1, max_length=2048)


class McpSignInResponse(BaseModel):
    """The agent confirmed the sign-in: its MCP server's tools are usable now."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    agent_name: str
    channel_id: str


class McpSignInResult(BaseModel):
    """The agent's plugin reporting whether its code exchange succeeded."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    state: str = Field(pattern=rf"^{OAUTH_STATE}$")
    connected: bool
