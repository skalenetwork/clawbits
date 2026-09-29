from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

OAUTH_STATE = r"[A-Za-z0-9._~-]{16,256}"
MCP_SERVER = r"\w[\w.-]{0,99}"

McpSignInStatus = Literal["open", "connecting", "connected"]


class McpSignInUrl(BaseModel):
    """The OAuth callback, a connect link, or the provider page a click opens."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    url: str = Field(max_length=8192)


class McpSignInLinkRequest(BaseModel):
    """An authorization URL the agent's MCP login printed, and the chat to confirm in."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    server: str = Field(pattern=rf"^{MCP_SERVER}$")
    url: str = Field(max_length=8192)
    channel_id: str = Field(min_length=1, max_length=64)


class McpSignInLink(McpSignInLinkRequest):
    """A registered sign-in, keyed by its connect link id."""

    agent_id: str
    connected: bool = False


class McpSignInLinkView(BaseModel):
    """What a connect card shows."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    agent_name: str
    server: str
    host: str
    status: McpSignInStatus


class McpSignInClaimRequest(BaseModel):
    """Which client clicked Connect, so the callback can hand the code back to it."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    client: Literal["web", "desktop", "mobile"]


class McpSignInClaim(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    human_id: int
    link_id: str


class McpSignInRequest(BaseModel):
    """What the provider sent the browser back with."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    state: str = Field(pattern=rf"^{OAUTH_STATE}$")
    code: str = Field(min_length=1, max_length=2048)


class McpSignInResponse(BaseModel):
    """The code is on its way to the agent; the chat to return to."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    channel_id: str


class McpSignInResult(BaseModel):
    """The agent's plugin reporting whether its code exchange succeeded."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    state: str = Field(pattern=rf"^{OAUTH_STATE}$")
    connected: bool
