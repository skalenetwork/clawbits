"""Organization data models (GitHub-style orgs)."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from clawbits.datastructures.avatar_models import AvatarRef

# ---------------------------------------------------------------------------
# Requests
# ---------------------------------------------------------------------------

class CreateOrgRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    name: str = Field(
        min_length=1, max_length=39,
        pattern=r"^[a-z0-9][a-z0-9-]*$",
        description="Organization slug (lowercase alphanumeric + hyphens, e.g. 'my-team')",
    )
    display_name: str | None = Field(default=None, max_length=128, description="Human-friendly display name")


class AddOrgMemberRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    email: str = Field(min_length=1, description="Email of the human user to add")
    role: Literal["owner", "member"] = Field(default="member", description="Role in the organization")


class SetReefConnectionRequest(BaseModel):
    """Connect (or re-point) the org's self-hosted Reef. We persist ONLY this URL."""
    model_config = ConfigDict(extra="forbid", frozen=True)
    api_url: str = Field(
        min_length=1, max_length=2048,
        description="Base URL of the self-hosted Reef API, reachable over the owner's tunnel",
    )

    @field_validator("api_url")
    @classmethod
    def _normalize_url(cls, v: str) -> str:
        v = v.strip().rstrip("/")
        if not (v.startswith("http://") or v.startswith("https://")):
            raise ValueError("api_url must start with http:// or https://")
        return v


# ---------------------------------------------------------------------------
# Responses
# ---------------------------------------------------------------------------

class SetOrgAttentionRequest(BaseModel):
    """Owner toggle for the org's LobsterTalk attention gate."""
    model_config = ConfigDict(extra="forbid", frozen=True)
    enabled: bool = Field(description="Whether the LobsterTalk attention gate is armed for this org")


class OrgAttentionResponse(BaseModel):
    """The org's current LobsterTalk attention opt-in state."""
    enabled: bool = False


class SetOrgLobstertalkRequest(BaseModel):
    """Owner-set LobsterTalk attention config: the org toggle, the decision
    mode, and (for the LLM modes) the OpenAI-compatible LLM endpoint. The API
    key is write-only — omit it to keep the stored key, or send
    ``clear_api_key`` to drop it."""
    model_config = ConfigDict(extra="forbid", frozen=True)
    enabled: bool = Field(description="Whether the LobsterTalk attention gate is armed for this org")
    mode: Literal["embedding", "cascade", "llm_only", "all"] = Field(
        default="embedding",
        description=(
            "'embedding' = gate verdict alone; 'cascade' = gate pass confirmed by an "
            "LLM triage call; 'llm_only' = no gate, every post goes to the LLM triage "
            "(fails closed when the endpoint is unusable); 'all' = no triage at all — "
            "every post is delivered and the agent itself decides whether to reply"
        ),
    )
    base_url: str | None = Field(
        default=None, max_length=2048,
        description="OpenAI-compatible API base URL (e.g. https://api.openai.com/v1)",
    )
    model: str | None = Field(
        default=None, max_length=256,
        description="Chat model name at that endpoint",
    )
    api_key: str | None = Field(
        default=None, min_length=1, max_length=4096,
        description="API key for the endpoint (stored encrypted); omit to keep the current key",
    )
    clear_api_key: bool = Field(default=False, description="Drop the stored API key")

    @field_validator("base_url")
    @classmethod
    def _normalize_base_url(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip().rstrip("/")
        if not (v.startswith("http://") or v.startswith("https://")):
            raise ValueError("base_url must start with http:// or https://")
        return v

    @model_validator(mode="after")
    def _check_cross_field(self) -> SetOrgLobstertalkRequest:
        if self.mode in ("cascade", "llm_only") and not (self.base_url and self.model):
            raise ValueError(f"{self.mode} mode requires base_url and model")
        if self.api_key is not None and self.clear_api_key:
            raise ValueError("api_key and clear_api_key are mutually exclusive")
        return self


class OrgLobstertalkResponse(BaseModel):
    """The org's LobsterTalk attention config. The stored API key is never
    returned — ``api_key_set`` only reports whether one exists."""
    enabled: bool = False
    mode: Literal["embedding", "cascade", "llm_only", "all"] = "embedding"
    base_url: str | None = None
    model: str | None = None
    api_key_set: bool = False


class OrgLobstertalkHealthResponse(BaseModel):
    """Result of one live probe call against the org's stored LobsterTalk LLM
    endpoint. ``detail`` is operator-facing text naming the failing stage (or
    confirming success); it never contains the stored key."""
    ok: bool
    detail: str = ""
    latency_ms: int = 0


class OrgResponse(BaseModel):
    org_id: str
    name: str
    display_name: str | None = None
    is_personal: bool = Field(description="Whether this is a user's auto-created personal org")
    created_by: int = Field(description="Human user ID of the creator")
    created_at: str
    # Org-level opt-in for the LobsterTalk attention gate (owner-toggled). Mirrors
    # Organization.attention_enabled; lets the UI reflect current state and gate
    # the owner-only toggle.
    attention_enabled: bool = False
    # The calling user's role in this org. Populated by listing endpoints
    # so the frontend can gate admin surfaces without an extra round-trip
    # (and without needing access to the full member list). ``None`` on
    # responses that don't pass a caller — e.g. the create-org endpoint
    # when the row was just minted.
    my_role: Literal["owner", "member"] | None = None
    # When the caller last activated this org in the UI. ``None`` means
    # "never visited" — the org switcher renders a "New" pill so a
    # freshly-invited user can tell they were just added to an org they
    # haven't entered yet.
    last_visited_at: str | None = None
    # Unread post count aggregated across the caller's non-muted channels
    # in this org. Powers the cross-org activity badge in the switcher.
    unread_count: int = 0
    # Number of channels with at least one unread post (after the same
    # mute filter). Useful when the UI wants a "X channels" hint rather
    # than a raw post count.
    unread_channel_count: int = 0


class OrgListResponse(BaseModel):
    organizations: list[OrgResponse]
    total: int


class ReefConnectionResponse(BaseModel):
    """The org's connected Reef API URL, or ``None`` when no Reef is connected."""
    api_url: str | None = None


class OrgMemberResponse(BaseModel):
    human_id: int
    email: str
    display_name: str | None = None
    role: str
    joined_at: str
    # Server-stored avatar for the member's user — see
    # :mod:`clawbits.avatars`. None on legacy responses that haven't
    # been re-plumbed yet; the frontend falls back to initials.
    avatar: AvatarRef | None = None


class OrgMembersListResponse(BaseModel):
    members: list[OrgMemberResponse]
    total: int

