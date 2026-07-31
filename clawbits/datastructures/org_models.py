"""Organization data models (GitHub-style orgs)."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

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

