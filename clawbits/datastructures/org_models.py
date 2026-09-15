"""Organization data models (GitHub-style orgs)."""
from datetime import datetime
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from clawbits.datastructures.avatar_models import AvatarRef
from clawbits.reef_repo import NAME_RE, OWNER_RE, PUBLIC_HOST_RE, REPO_RE, Health


class CreateOrgRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    name: str = Field(
        min_length=1, max_length=39,
        pattern=r"^[a-z0-9][a-z0-9-]*$",
        description="Organization slug (lowercase alphanumeric + hyphens, e.g. 'my-team')",
    )
    display_name: str | None = Field(default=None, max_length=128, description="Human-friendly display name")


class UpdateOrgRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)
    display_name: str = Field(min_length=1, max_length=128, description="Public organization name")


class AddOrgMemberRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    email: str = Field(min_length=1, description="Email of the human user to add")
    role: Literal["owner", "member"] = Field(default="member", description="Role in the organization")


class UpdateOrgMemberRoleRequest(BaseModel):
    """Promote/demote an existing org member. Owner-only on the server."""
    model_config = ConfigDict(extra="forbid", frozen=True)
    role: Literal["owner", "member"] = Field(description="New role in the organization")


class SetReefRepoRequest(BaseModel):
    """Connect the org's reef repository. Git is the only bus to a reef host."""
    model_config = ConfigDict(extra="forbid", frozen=True)
    repo: str = Field(
        pattern=REPO_RE.pattern,
        description="The private repository on github.com, as ``owner/name``",
    )
    token: str = Field(
        min_length=1, max_length=512,
        description="Fine-grained token scoped to that repository, Contents read and write",
    )


class CreateReefAgentRequest(BaseModel):
    """Declare one agent on a reef host: clawbits writes its fleet file."""
    model_config = ConfigDict(extra="forbid", frozen=True)
    host: str = Field(pattern=NAME_RE.pattern, description="A host that has written a status file")
    role: str = Field(pattern=NAME_RE.pattern, description="A role from the org's catalog")
    name: str | None = Field(
        default=None, pattern=NAME_RE.pattern,
        description="The agent's name on that host; defaults to its agent id, lowercased",
    )
    owner: str | None = Field(
        default=None, pattern=OWNER_RE.pattern,
        description="Who `reef agent serve` admits for terminals; defaults to the caller",
    )
    public_host: str | None = Field(
        default=None, pattern=PUBLIC_HOST_RE.pattern,
        description="Optional OPENCLAW_PUBLIC_HOST for the agent's own URL",
    )


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
    key is write-only: omit it to keep the stored key, or send
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
    cooldown_seconds: int | None = Field(
        default=None, ge=30, le=3600,
        description=(
            "Per-(agent, channel) nudge cooldown override in seconds; null "
            "inherits the server default. Bounded 30..3600 — the floor is what "
            "keeps a busy channel from becoming a turn-per-message firehose "
            "(and, in the LLM modes, a call-per-message bill); huge values "
            "effectively mute the feature."
        ),
    )

    @field_validator("base_url")
    @classmethod
    def _normalize_base_url(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip().rstrip("/")
        if not (v.startswith("http://") or v.startswith("https://")):
            raise ValueError("base_url must start with http:// or https://")
        # Userinfo, query and fragment can each carry a secret, and GET echoes this to every member.
        parts = urlsplit(v)
        if parts.username or parts.password or "@" in parts.netloc:
            raise ValueError("base_url must not contain credentials (user:pass@…)")
        if parts.query:
            raise ValueError("base_url must not contain a query string")
        if parts.fragment:
            raise ValueError("base_url must not contain a fragment")
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
    returned: ``api_key_set`` only reports whether one exists.
    ``cooldown_seconds`` is null while inheriting ``default_cooldown_seconds``."""
    enabled: bool = False
    mode: Literal["embedding", "cascade", "llm_only", "all"] = "embedding"
    base_url: str | None = None
    model: str | None = None
    api_key_set: bool = False
    cooldown_seconds: int | None = None
    default_cooldown_seconds: int = 300


class OrgLobstertalkHealthResponse(BaseModel):
    """Result of one live probe call against the org's stored LobsterTalk LLM
    endpoint. ``detail`` is operator-facing text naming the failing stage (or
    confirming success); it never contains the stored key."""
    ok: bool
    detail: str = ""
    latency_ms: int = 0


class SetOrgLobstertalkChannelRequest(BaseModel):
    """Owner write to the per-channel LobsterTalk allowlist (closed by
    default): whether the attention pass may operate in one public channel."""
    model_config = ConfigDict(extra="forbid", frozen=True)
    approved: bool = Field(description="Whether LobsterTalk may operate in this channel")


class OrgLobstertalkChannelResponse(BaseModel):
    channel_id: str
    lobstertalk_approved: bool


class OrgResponse(BaseModel):
    org_id: str
    name: str
    display_name: str | None = None
    avatar: AvatarRef | None = None
    is_personal: bool = Field(description="Whether this is a user's auto-created personal org")
    created_by: int = Field(description="Human user ID of the creator")
    created_at: str
    attention_enabled: bool = False
    reef_connected: bool = False
    my_role: Literal["owner", "member"] | None = None
    last_visited_at: str | None = None
    unread_count: int = 0
    unread_channel_count: int = 0
    member_count: int = 0


class OrgListResponse(BaseModel):
    organizations: list[OrgResponse]
    total: int


class ReefApplied(BaseModel):
    """The ``main`` and ``fleet`` HEADs a host last applied in full."""
    main: str
    fleet: str


class ReefHostAgent(BaseModel):
    """One row of the host's ``reef agent list --json``. ``image`` is what the
    VM runs; it defaults so a host on a reef that predates it still validates."""
    name: str
    role: str
    image: str = ""
    desired: str
    state: str
    vm: str | None = None
    synced: bool
    role_current: bool


class ReefEvent(BaseModel):
    """One row of the host's ``reef events --json``."""
    agent: str
    at: datetime
    kind: str
    detail: str


class ReefHostResponse(BaseModel):
    """One reef host, as its own status file describes it. ``last_seen`` is the
    reconciler's coarse heartbeat and ``health`` is read off it and the last
    apply (:func:`clawbits.reef_repo.parse_status`). ``applied`` is null until
    an apply lands; ``error`` is why the last one failed."""
    host: str
    reef: str | None = None
    last_seen: datetime | None = None
    health: Health
    applied: ReefApplied | None = None
    error: str | None = None
    agents: list[ReefHostAgent] = []
    events: list[ReefEvent] = []


class ReefAgentResponse(BaseModel):
    """A declared agent and when its one-time signup token dies. Still declared
    for as long as that token is unspent: enrolling is what ends the state."""
    host: str
    name: str
    expires_at: datetime


class CreateReefAgentResponse(ReefAgentResponse):
    """A declared agent with the id and nickname picked for it at mint."""
    agent_id: str
    nickname: str


class ReefResponse(BaseModel):
    """The org's reef repository, every host reporting into it by name, and
    the agents declared but not yet enrolled. ``connected`` is false when no
    repository is stored, or when its token cannot be unsealed (the secrets
    key rotated)."""
    repo: str | None = None
    connected: bool
    hosts: list[ReefHostResponse] = []
    declared: list[ReefAgentResponse] = []


class ReefSecretResponse(BaseModel):
    env: str
    host: str


class ReefRoleResponse(BaseModel):
    """One reviewed role from ``main:roles/``: the whole blast radius an agent
    created from it inherits."""
    name: str
    image: str
    egress: list[str]
    secrets: list[ReefSecretResponse]
    resources: dict[str, int]


class OrgMemberResponse(BaseModel):
    human_id: int
    email: str
    display_name: str | None = None
    role: str
    joined_at: str
    avatar: AvatarRef | None = None


class OrgMembersListResponse(BaseModel):
    members: list[OrgMemberResponse]
    total: int

