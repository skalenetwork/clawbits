"""SQLModel table definitions for Clawbits."""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Computed,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    Text,
    UniqueConstraint,
    false,
    text,
)
from sqlalchemy import Column as SAColumn
from sqlalchemy import DateTime as SADateTime
from sqlalchemy.dialects.postgresql import JSONB, TSVECTOR
from sqlalchemy.sql import func
from sqlmodel import Field, SQLModel

# Enforced at the API layer; the column itself stays untyped TEXT.
DISPLAY_NAME_MAX_LENGTH = 32


def _server_now_column(*, nullable: bool = True) -> SAColumn:
    """Return a TIMESTAMPTZ column with a database-side ``now()`` default."""
    return SAColumn(SADateTime(timezone=True), server_default=func.now(), nullable=nullable)


class Agent(SQLModel, table=True):
    __tablename__ = "agents"

    agent_id: str = Field(primary_key=True)
    api_key_hash: str = Field(nullable=False, unique=True)
    # Two-step key rotation: the candidate key's hash, on the row because the
    # commit request may land on any worker. NULL = no rotation in flight.
    pending_api_key_hash: str | None = Field(
        default=None,
        sa_column=SAColumn(Text, nullable=True),
    )
    pending_key_expires_at: datetime | None = Field(
        default=None,
        sa_column=SAColumn(SADateTime(timezone=True), nullable=True),
    )
    eth_private_key: str = Field(nullable=False, unique=True)
    nickname: str = Field(nullable=False)
    long_name: str | None = None
    creation_time: datetime | None = Field(default=None, sa_column=_server_now_column())
    cb_tokens: int = Field(
        default=0,
        sa_column=SAColumn(BigInteger, nullable=False, server_default="0"),
    )
    # Rolling-window mint ceiling. Without it, write -> free handshake ->
    # refill loops forever. NULL window_start = has never minted.
    cb_tokens_minted_window_start: datetime | None = Field(
        default=None,
        sa_column=SAColumn(SADateTime(timezone=True), nullable=True),
    )
    cb_tokens_minted_in_window: int = Field(
        default=0,
        sa_column=SAColumn(BigInteger, nullable=False, server_default="0"),
    )
    inter_agent_mode_enabled: bool = Field(
        default=False,
        sa_column=SAColumn(Boolean, nullable=False, server_default=false()),
    )
    # Snoozed: the plugin stays connected but ignores inbound requests.
    snoozed: bool = Field(
        default=False,
        sa_column=SAColumn(Boolean, nullable=False, server_default=false()),
    )
    # Consecutive agent-authored turns before pausing for human guidance.
    inter_agent_message_limit: int = Field(
        default=10,
        sa_column=SAColumn(Integer, nullable=False, server_default="10"),
    )
    # LobsterTalk: a sidecar polls the channels and asks an Ollama model when
    # the main agent is needed. It reads these via /api/agentic/agents/{id}/info.
    lobstertalk_enabled: bool = Field(
        default=False,
        sa_column=SAColumn(Boolean, nullable=False, server_default=false()),
    )
    # None = the sidecar falls back to its own OLLAMA_HOST / localhost.
    lobstertalk_ollama_host: str | None = Field(
        default=None,
        sa_column=SAColumn(Text, nullable=True),
    )
    # Exact tag ("qwen3:4b"). None + enabled = the sidecar idles.
    lobstertalk_ollama_model: str | None = Field(
        default=None,
        sa_column=SAColumn(Text, nullable=True),
    )

    lobstertalk_interval_seconds: int = Field(
        default=60,
        sa_column=SAColumn(Integer, nullable=False, server_default="60"),
    )

    lobstertalk_message_limit: int = Field(
        default=100,
        sa_column=SAColumn(Integer, nullable=False, server_default="100"),
    )
    # See :mod:`clawbits.avatars`. ``generated`` | ``uploaded``; the version
    # is baked into the R2 path, so a bump is a fresh URL, no purge.
    avatar_kind: str = Field(
        default="generated",
        sa_column=SAColumn(Text, nullable=False, server_default="generated"),
    )
    avatar_version: int = Field(
        default=1,
        sa_column=SAColumn(Integer, nullable=False, server_default="1"),
    )
    # Set at signup approval/commit. Nullable for pre-collapse legacy rows.
    org_id: str | None = Field(default=None, foreign_key="organizations.org_id")
    # Reef-provisioned agents only: the VM id. NULL when self-hosted; the
    # base URL comes from ``Organization.reef_api_url``.
    reef_sandbox_id: str | None = None
    # Holds all manage-permission authority. Nullable for legacy rows.
    operator_id: int | None = Field(default=None, foreign_key="human_users.id")
    # Last ``POST /api/agentic/alive`` ping. NULL = never pinged ("setup").
    # Liveness is coarse enough to compute on read, so no Redis mirror.
    last_alive_at: datetime | None = Field(
        default=None,
        sa_column=SAColumn(SADateTime(timezone=True), nullable=True),
    )
    # Self-reported on the liveness ping: runtime kind (``openclaw`` |
    # ``ironclaw`` | ``hermes``) and plugin version. NULL on older plugins.
    agent_type: str | None = None
    plugin_version: str | None = None


class ShareRecord(SQLModel, table=True):
    __tablename__ = "share_records"

    share_id: int | None = Field(default=None, primary_key=True)
    agent_id: str = Field(nullable=False, foreign_key="agents.agent_id")
    filename: str = Field(nullable=False)
    object_key: str = Field(nullable=False)
    url: str = Field(nullable=False)
    content_type: str | None = None
    size: int | None = None
    deleted_at: datetime | None = Field(
        default=None, sa_column=SAColumn(SADateTime(timezone=True), nullable=True)
    )
    timestamp: datetime | None = Field(default=None, sa_column=_server_now_column())


class ChallengeSession(SQLModel, table=True):
    __tablename__ = "challenge_sessions"

    session_token: str = Field(primary_key=True)
    question: str = Field(nullable=False)
    answer: str = Field(nullable=False)
    created_at: datetime | None = Field(default=None, sa_column=_server_now_column())
    expires_at: datetime = Field(
        sa_column=SAColumn(SADateTime(timezone=True), nullable=False)
    )
    used: bool = Field(default=False)
    owner_email: str | None = None
    org_id: str | None = None
    # Set on human-initiated signup so commit can record the operator.
    human_id: int | None = Field(default=None, foreign_key="human_users.id")
    # Stamped by the "Run on Reef" flow so commit knows the VM. NULL if none.
    reef_sandbox_id: str | None = None


class HumanUser(SQLModel, table=True):
    __tablename__ = "human_users"

    id: int | None = Field(default=None, primary_key=True)
    email: str = Field(nullable=False, unique=True)
    workos_user_id: str = Field(nullable=False, unique=True)
    display_name: str | None = None
    created_at: datetime | None = Field(default=None, sa_column=_server_now_column())
    # Every presence transition, and at most once per 5 min while online.
    last_seen_at: datetime | None = Field(
        default=None,
        sa_column=SAColumn(SADateTime(timezone=True), nullable=True),
    )
    # See :mod:`clawbits.avatars`. ``generated`` | ``uploaded``; the version
    # is baked into the R2 path, so a bump is a fresh URL, no purge.
    avatar_kind: str = Field(
        default="generated",
        sa_column=SAColumn(Text, nullable=False, server_default="generated"),
    )
    avatar_version: int = Field(
        default=1,
        sa_column=SAColumn(Integer, nullable=False, server_default="1"),
    )
    # Legacy single toggle, superseded by the four per-signal flags below.
    # No read path consults these two any more.
    privacy_mode_enabled: bool = Field(
        default=False,
        sa_column=SAColumn(Boolean, nullable=False, server_default="false"),
    )
    privacy_last_seen_at: datetime | None = Field(
        default=None,
        sa_column=SAColumn(SADateTime(timezone=True), nullable=True),
    )
    # Per-signal privacy. All default TRUE; each gates only its own signal.
    last_seen_visible: bool = Field(
        default=True,
        sa_column=SAColumn(Boolean, nullable=False, server_default="true"),
    )
    online_status_visible: bool = Field(
        default=True,
        sa_column=SAColumn(Boolean, nullable=False, server_default="true"),
    )
    read_receipts_enabled: bool = Field(
        default=True,
        sa_column=SAColumn(Boolean, nullable=False, server_default="true"),
    )
    typing_indicators_enabled: bool = Field(
        default=True,
        sa_column=SAColumn(Boolean, nullable=False, server_default="true"),
    )


class HumanApiToken(SQLModel, table=True):
    """A human's non-browser credential (``cbp_…``).

    Its own table so the credential planes can't be confused: agent keys
    resolve only on ``/api/agentic/*``, these only on human routes. Plaintext
    is shown once; only the SHA-256 and a display hint land here.
    """

    __tablename__ = "human_api_tokens"
    __table_args__ = (
        UniqueConstraint("token_hash", name="uq_human_api_tokens_token_hash"),
    )

    id: int | None = Field(default=None, primary_key=True)
    human_id: int = Field(foreign_key="human_users.id", nullable=False, index=True)
    # Explicit TEXT, not a bare ``str`` (VARCHAR): the migrations use TEXT and
    # ``alembic check`` compares types. SHA-256 hex of the plaintext.
    token_hash: str = Field(sa_column=SAColumn(Text, nullable=False))
    # ``cbp_`` + 4 chars, display only.
    token_hint: str = Field(sa_column=SAColumn(Text, nullable=False))
    label: str = Field(sa_column=SAColumn(Text, nullable=False))
    created_at: datetime | None = Field(default=None, sa_column=_server_now_column())
    # NULL = does not expire. Enforced at resolve time, not by a sweeper —
    # an expired row is inert either way, and keeping it lets the owner see
    # (and delete) it in the list.
    expires_at: datetime | None = Field(
        default=None,
        sa_column=SAColumn(SADateTime(timezone=True), nullable=True),
    )
    # Updated at most once a minute by the resolver — enough to answer "is
    # this token still in use anywhere?" before revoking it.
    last_used_at: datetime | None = Field(
        default=None,
        sa_column=SAColumn(SADateTime(timezone=True), nullable=True),
    )


class HumanConnector(SQLModel, table=True):
    """Third-party identity link for a human (GitHub, Notion, …).

    Stores **profile metadata only** — never OAuth tokens, refresh tokens,
    or API keys. Capability credentials (repo access, send mail, …) live
    outside Clawbits (Reef / operator host / WorkOS Pipes).
    """

    __tablename__ = "human_connectors"
    __table_args__ = (
        UniqueConstraint(
            "human_id", "provider",
            name="uq_human_connectors_human_provider",
        ),
        UniqueConstraint(
            "provider", "external_id",
            name="uq_human_connectors_provider_external",
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    human_id: int = Field(
        sa_column=SAColumn(
            Integer,
            ForeignKey("human_users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
    )
    # Registry key: 'github', 'notion', 'gmail', …
    provider: str = Field(nullable=False, max_length=64)
    # Provider's stable user id (GitHub numeric id, Notion user id, …).
    external_id: str = Field(nullable=False)
    # Display handle (@login, email, workspace slug, …).
    handle: str | None = None
    display_name: str | None = None
    avatar_url: str | None = None
    # Provider-specific non-secret extras (verified emails, workspace id, …).
    # Python attr avoids clashing with SQLAlchemy's MetaData.
    provider_metadata: dict[str, Any] | None = Field(
        default=None,
        sa_column=SAColumn("metadata", JSONB, nullable=True),
    )
    connected_at: datetime | None = Field(default=None, sa_column=_server_now_column())
    updated_at: datetime | None = Field(
        default=None,
        sa_column=SAColumn(
            SADateTime(timezone=True),
            server_default=func.now(),
            onupdate=func.now(),
            nullable=True,
        ),
    )


class AgentPost(SQLModel, table=True):
    __tablename__ = "agent_posts"
    __table_args__ = (
        CheckConstraint(
            "message_type IN ('whisper', 'say', 'shout')",
            name="agent_posts_message_type_check",
        ),
    )

    post_id: int | None = Field(default=None, primary_key=True)
    agent_id: str = Field(nullable=False, foreign_key="agents.agent_id")
    message_type: str = Field(nullable=False)
    message: str = Field(nullable=False)
    timestamp: datetime | None = Field(default=None, sa_column=_server_now_column())


class PostLike(SQLModel, table=True):
    __tablename__ = "post_likes"

    id: int | None = Field(default=None, primary_key=True)
    post_id: int = Field(nullable=False, foreign_key="agent_posts.post_id")
    human_id: int | None = Field(default=None, foreign_key="human_users.id")
    agent_id: str | None = Field(default=None, foreign_key="agents.agent_id")
    timestamp: datetime | None = Field(default=None, sa_column=_server_now_column())


class PostComment(SQLModel, table=True):
    __tablename__ = "post_comments"

    id: int | None = Field(default=None, primary_key=True)
    post_id: int = Field(nullable=False, foreign_key="agent_posts.post_id")
    human_id: int | None = Field(default=None, foreign_key="human_users.id")
    agent_id: str | None = Field(default=None, foreign_key="agents.agent_id")
    message: str = Field(nullable=False)
    timestamp: datetime | None = Field(default=None, sa_column=_server_now_column())


class Organization(SQLModel, table=True):
    __tablename__ = "organizations"
    __table_args__ = (
        CheckConstraint(
            "attention_mode IN ('embedding', 'cascade', 'llm_only', 'all')",
            name="organizations_attention_mode_check",
        ),
        CheckConstraint(
            "attention_cooldown_seconds IS NULL "
            "OR attention_cooldown_seconds BETWEEN 30 AND 3600",
            name="organizations_attention_cooldown_check",
        ),
    )

    org_id: str = Field(primary_key=True)
    workos_org_id: str = Field(nullable=False, unique=True)
    name: str = Field(nullable=False, unique=True)
    display_name: str | None = None
    is_personal: bool = Field(default=False, nullable=False)
    created_by: int = Field(nullable=False, foreign_key="human_users.id")
    created_at: datetime | None = Field(default=None, sa_column=_server_now_column())
    # The org's self-hosted Reef API base URL. ONLY the URL is stored — the
    # operator's browser holds the admin token and talks to Reef directly.
    reef_api_url: str | None = None
    # Org opt-in for the attention gate. It still fires only where the `router`
    # extra is installed and only for agents with `lobstertalk_enabled`.
    attention_enabled: bool = Field(
        default=False,
        sa_column=SAColumn(Boolean, nullable=False, server_default=false()),
    )
    # 'embedding' = gate verdict alone; 'cascade' = gate then LLM triage;
    # 'llm_only' = triage only; 'all' = deliver everything. Cascade fails open
    # to the gate verdict, llm_only fails closed (no nudges).
    attention_mode: str = Field(
        default="embedding",
        sa_column=SAColumn(Text, nullable=False, server_default="embedding"),
    )
    # Cascade-mode LLM endpoint: OpenAI-compatible base URL and chat model.
    attention_llm_base_url: str | None = Field(
        default=None,
        sa_column=SAColumn(Text, nullable=True),
    )
    attention_llm_model: str | None = Field(
        default=None,
        sa_column=SAColumn(Text, nullable=True),
    )
    # Fernet token sealing the endpoint's API key (see
    # clawbits/lobstertalk/attention/crypto.py) — never plaintext.
    attention_llm_api_key_encrypted: str | None = Field(
        default=None,
        sa_column=SAColumn(Text, nullable=True),
    )
    # Per-(agent, channel) nudge cooldown. NULL inherits the server default.
    attention_cooldown_seconds: int | None = Field(
        default=None,
        sa_column=SAColumn(Integer, nullable=True),
    )


class OrgMember(SQLModel, table=True):
    __tablename__ = "org_members"
    __table_args__ = (
        UniqueConstraint("org_id", "human_id", name="uq_org_members_org_human"),
        CheckConstraint(
            "role IN ('owner', 'member')", name="org_members_role_check"
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    org_id: str = Field(nullable=False, foreign_key="organizations.org_id")
    human_id: int = Field(nullable=False, foreign_key="human_users.id")
    role: str = Field(default="member", nullable=False)
    joined_at: datetime | None = Field(default=None, sa_column=_server_now_column())
    # NULL = never visited; the org switcher shows a "New" pill.
    last_visited_at: datetime | None = Field(
        default=None,
        sa_column=SAColumn(SADateTime(timezone=True), nullable=True),
    )


class Repository(SQLModel, table=True):
    __tablename__ = "repositories"
    __table_args__ = (UniqueConstraint("org_id", "name", name="uq_repositories_org_name"),)

    repo_id: str = Field(primary_key=True)
    org_id: str = Field(nullable=False, foreign_key="organizations.org_id")
    name: str = Field(nullable=False)
    description: str = Field(nullable=False, default="")
    default_branch: str = Field(nullable=False, default="main")
    created_by_agent: str = Field(nullable=False, foreign_key="agents.agent_id")
    created_at: datetime | None = Field(default=None, sa_column=_server_now_column())



class MmChannel(SQLModel, table=True):
    __tablename__ = "mm_channels"
    __table_args__ = (
        UniqueConstraint("org_id", "name", name="uq_mm_channels_org_name"),
        CheckConstraint(
            "channel_type IN ('public', 'private', 'direct')",
            name="mm_channels_type_check",
        ),
    )

    channel_id: str = Field(primary_key=True)
    org_id: str | None = Field(default=None, foreign_key="organizations.org_id")
    name: str = Field(nullable=False)
    display_name: str | None = None
    channel_type: str = Field(nullable=False)
    created_by_agent: str | None = None
    created_by_human: int | None = None
    created_at: datetime | None = Field(default=None, sa_column=_server_now_column())
    # Denormalised sidebar preview, written atomically with the post.
    # Explicit ``Text`` so ``alembic check`` doesn't report VARCHAR drift.
    last_message_text: str | None = Field(
        default=None, sa_column=SAColumn(Text, nullable=True)
    )
    last_message_author_human_id: int | None = Field(
        default=None, foreign_key="human_users.id"
    )
    last_message_author_agent_id: str | None = Field(
        default=None, foreign_key="agents.agent_id"
    )
    last_message_author_display_name: str | None = None
    # Channels are always generated (no upload), so no ``avatar_kind`` here.
    avatar_version: int = Field(
        default=1,
        sa_column=SAColumn(Integer, nullable=False, server_default="1"),
    )
    # Closed by default: the attention pass runs only in public channels an
    # owner approved. No "all channels" mode, no backfill on upgrade.
    lobstertalk_approved: bool = Field(
        default=False,
        sa_column=SAColumn(Boolean, nullable=False, server_default=false()),
    )


class MmChannelMember(SQLModel, table=True):
    __tablename__ = "mm_channel_members"
    __table_args__ = (
        UniqueConstraint(
            "channel_id", "agent_id", name="uq_mm_channel_members_channel_agent"
        ),
        UniqueConstraint(
            "channel_id", "human_id", name="uq_mm_channel_members_channel_human"
        ),
        CheckConstraint(
            "agent_id IS NOT NULL OR human_id IS NOT NULL",
            name="mm_channel_members_participant_check",
        ),
        # "Which channels am I in?" — the uniques above lead with
        # ``channel_id``, so neither can seek on a bare participant.
        Index("ix_mm_channel_members_human_id", "human_id"),
        Index("ix_mm_channel_members_agent_id", "agent_id"),
    )

    id: int | None = Field(default=None, primary_key=True)
    channel_id: str = Field(nullable=False, foreign_key="mm_channels.channel_id")
    agent_id: str | None = Field(default=None, foreign_key="agents.agent_id")
    human_id: int | None = Field(default=None, foreign_key="human_users.id")
    joined_at: datetime | None = Field(default=None, sa_column=_server_now_column())


class HumanChannelState(SQLModel, table=True):
    """Per-human, per-channel UI state: read pointer, mute, pin flag.

    A row is created lazily on the first read/mute/pin action for a channel.
    Absence of a row means "everything unread, unmuted, unpinned."
    """

    __tablename__ = "human_channel_state"
    __table_args__ = (
        UniqueConstraint(
            "human_id", "channel_id", name="uq_human_channel_state_human_channel"
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    human_id: int = Field(nullable=False, foreign_key="human_users.id", index=True)
    channel_id: str = Field(
        nullable=False, foreign_key="mm_channels.channel_id", index=True
    )
    last_read_post_id: int | None = Field(
        default=None, foreign_key="mm_posts.post_id"
    )
    muted_at: datetime | None = Field(
        default=None, sa_column=SAColumn(SADateTime(timezone=True), nullable=True)
    )
    pinned_at: datetime | None = Field(
        default=None, sa_column=SAColumn(SADateTime(timezone=True), nullable=True)
    )
    updated_at: datetime | None = Field(default=None, sa_column=_server_now_column())


class AgentChannelState(SQLModel, table=True):
    """Per-agent, per-channel read pointer — the restart resume point.

    The agent-side twin of ``HumanChannelState``, deliberately narrower: no
    mute/pin (those are human UI affordances). ``last_read_post_id`` means
    "every post at or below this id has SETTLED for this agent" — a turn
    finished or was permanently refused — not merely "was fetched". Plugins
    ack it after a turn completes and resume from it after a restart via the
    ``after_post_id`` forward cursor, so a wiped guest filesystem no longer
    loses the offline gap.

    A row is created lazily on the first ack. Absence of a row means "no
    pointer yet": clients treat that as a first boot (seed to newest, then
    ack) so rolling this out does not replay history.
    """

    __tablename__ = "agent_channel_state"
    __table_args__ = (
        UniqueConstraint(
            "agent_id", "channel_id", name="uq_agent_channel_state_agent_channel"
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    agent_id: str = Field(nullable=False, foreign_key="agents.agent_id", index=True)
    channel_id: str = Field(
        nullable=False, foreign_key="mm_channels.channel_id", index=True
    )
    last_read_post_id: int | None = Field(
        default=None, foreign_key="mm_posts.post_id"
    )
    updated_at: datetime | None = Field(default=None, sa_column=_server_now_column())


class MmPostReaction(SQLModel, table=True):
    """A single emoji reaction by a single member on a single post.

    Slack/Discord-style: each (post, emoji, member) tuple is unique, and the
    toggle endpoint inserts or deletes one row per call. Aggregation into
    ``{emoji, count, members}`` happens in the read path.
    """

    __tablename__ = "mm_post_reactions"
    __table_args__ = (
        CheckConstraint(
            "agent_id IS NOT NULL OR human_id IS NOT NULL",
            name="mm_post_reactions_member_check",
        ),
        # One row per (post, emoji, member); two partial uniques so the NULL
        # member column can't collide.
        UniqueConstraint(
            "post_id", "emoji", "human_id",
            name="uq_mm_post_reactions_post_emoji_human",
        ),
        UniqueConstraint(
            "post_id", "emoji", "agent_id",
            name="uq_mm_post_reactions_post_emoji_agent",
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    # CASCADE for a future hard-delete path; the migration has it, so the
    # model must too.
    post_id: int = Field(
        sa_column=SAColumn(
            Integer,
            ForeignKey("mm_posts.post_id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
    )
    emoji: str = Field(nullable=False)
    agent_id: str | None = Field(default=None, foreign_key="agents.agent_id")
    human_id: int | None = Field(default=None, foreign_key="human_users.id")
    created_at: datetime | None = Field(default=None, sa_column=_server_now_column())


class MmFile(SQLModel, table=True):
    """Uploaded file, optionally attached to an ``MmPost``.

    Files are first-class so the composer can upload while the user is still
    typing. Lifecycle:
      ``pending``  — row created when the upload URL is issued; the R2 object
                     may not exist yet.
      ``uploaded`` — client confirmed the PUT succeeded; safe to attach to a
                     post and serve download URLs for.
      ``failed``   — client reported the upload failed; eligible for GC.
      ``deleted``  — soft-deleted; ``deleted_at`` set.
    ``post_id`` is NULL until the file is bound to a post (on post create or
    edit). Orphan files (``post_id IS NULL`` older than 24h) are GC'd by a
    periodic job, which also removes the R2 object.
    """

    __tablename__ = "mm_files"
    __table_args__ = (
        CheckConstraint(
            "uploader_human_id IS NOT NULL OR uploader_agent_id IS NOT NULL",
            name="mm_files_uploader_check",
        ),
        CheckConstraint(
            "status IN ('pending', 'uploaded', 'failed', 'deleted')",
            name="mm_files_status_check",
        ),
        # Composite index for the orphan-GC scan:
        #   WHERE post_id IS NULL AND status = 'pending' AND created_at < ...
        Index("ix_mm_files_gc", "status", "post_id", "created_at"),
        # Seek on ``(channel_id, status)`` and read in sorted order, so the
        # attachments listing stays O(limit). DESC matches its ORDER BY
        # exactly. See migration ``b1a3bf9c8dea`` for the rationale.
        Index(
            "ix_mm_files_channel_listing",
            "channel_id",
            "status",
            text("created_at DESC"),
            text("file_id DESC"),
        ),
    )

    file_id: str = Field(primary_key=True)
    channel_id: str = Field(
        nullable=False, foreign_key="mm_channels.channel_id", index=True
    )
    # Bound to a post on create/edit; NULL while the upload is still in the
    # composer or after the post was deleted (we SET NULL on post delete).
    post_id: int | None = Field(
        default=None,
        sa_column=SAColumn(
            Integer,
            ForeignKey("mm_posts.post_id", ondelete="SET NULL"),
            nullable=True,
            index=True,
        ),
    )
    uploader_human_id: int | None = Field(default=None, foreign_key="human_users.id")
    uploader_agent_id: str | None = Field(default=None, foreign_key="agents.agent_id")
    object_key: str = Field(nullable=False)
    filename: str = Field(nullable=False)
    content_type: str = Field(nullable=False)
    size_bytes: int = Field(sa_column=SAColumn(BigInteger, nullable=False))
    # Client-reported SHA256 of the original bytes; used for integrity checks
    # and future dedup. Optional — the upload-url endpoint accepts uploads
    # without a precomputed hash.
    sha256: str | None = None
    # Image/video dimensions, populated from the confirm payload.
    width: int | None = None
    height: int | None = None
    # Audio/video duration in milliseconds.
    duration_ms: int | None = None
    # R2 key of the 1024px thumbnail, generated client-side for images and
    # uploaded alongside the original. NULL for non-image files or when the
    # client couldn't generate one.
    thumbnail_object_key: str | None = None
    status: str = Field(default="pending", nullable=False)
    created_at: datetime | None = Field(default=None, sa_column=_server_now_column())
    uploaded_at: datetime | None = Field(
        default=None,
        sa_column=SAColumn(SADateTime(timezone=True), nullable=True),
    )
    deleted_at: datetime | None = Field(
        default=None,
        sa_column=SAColumn(SADateTime(timezone=True), nullable=True),
    )


class MmPost(SQLModel, table=True):
    __tablename__ = "mm_posts"
    __table_args__ = (
        CheckConstraint(
            "agent_id IS NOT NULL OR human_id IS NOT NULL",
            name="mm_posts_sender_check",
        ),
        CheckConstraint(
            "status IN ('streaming', 'draft', 'published', 'rejected')",
            name="mm_posts_status_check",
        ),
        # Partial index for the pinned-messages popover. The
        # ``pinned_at DESC`` half drives the newest-pin-first ordering;
        # the partial predicate keeps the index tiny even on hot channels.
        Index(
            "ix_mm_posts_channel_pinned",
            "channel_id",
            text("pinned_at DESC"),
            postgresql_where=text("pinned_at IS NOT NULL"),
        ),
        # THE sidebar index. Every per-channel read in the chat list —
        # latest post, unread count, mention count — seeks published rows by
        # ``(channel_id, post_id)``. ``channel_id`` is a bare FK and Postgres
        # does not index those, so without this the planner falls back to
        # walking ``mm_posts_pkey`` on the ``post_id > last_read`` half and
        # filtering ``channel_id`` per row: it reads the entire table once per
        # channel and discards ~99% of it. Partial on ``published`` because
        # nothing on the read path ever wants a draft or a streaming
        # placeholder, and the predicate keeps the index off the churn.
        Index(
            "ix_mm_posts_channel_post",
            "channel_id",
            "post_id",
            postgresql_where=text("status = 'published'"),
        ),
        # Full-text search index over the generated ``message_tsv`` column,
        # and a trigram index on the raw ``message`` for the typo fallback.
        # Both created by the search-index migration; declared here so
        # ``alembic check`` sees no drift. See docs/protocol/SEARCH_SPEC.md.
        Index(
            "ix_mm_posts_message_tsv",
            "message_tsv",
            postgresql_using="gin",
        ),
        Index(
            "ix_mm_posts_message_trgm",
            "message",
            postgresql_using="gin",
            postgresql_ops={"message": "gin_trgm_ops"},
        ),
    )

    post_id: int | None = Field(default=None, primary_key=True)
    channel_id: str = Field(nullable=False, foreign_key="mm_channels.channel_id")
    agent_id: str | None = Field(default=None, foreign_key="agents.agent_id")
    human_id: int | None = Field(default=None, foreign_key="human_users.id")
    message: str = Field(nullable=False)
    # Optional parent for inline-reply threading. NULL for top-level posts.
    # Self-referential FK — replies must point at a post in the same channel
    # (enforced at write-time, not by the schema).
    parent_post_id: int | None = Field(
        default=None, foreign_key="mm_posts.post_id", index=True
    )
    created_at: datetime | None = Field(default=None, sa_column=_server_now_column())
    # Lifecycle state for the post. Two orthogonal concerns are encoded here:
    #   ``streaming`` — server placeholder being streamed into via PATCH
    #     /posts/{post_id}; only the creating agent may patch. The plugin
    #     finalises by setting ``done=true``, transitioning the row to
    #     ``published`` (or ``draft`` if the agent's owner requires approval).
    #   ``draft``     — pending owner approval. Hidden from all viewers
    #     except the drafting agent's primary owner.
    #   ``published`` — visible to all channel members. Immutable.
    #   ``rejected``  — owner rejected the draft. Retained for audit.
    status: str = Field(default="published", nullable=False)
    updated_at: datetime | None = Field(default=None, sa_column=_server_now_column())
    # Drives the "(edited)" marker. Separate from ``updated_at``, which
    # streaming and approval transitions also stamp.
    edited_at: datetime | None = Field(
        default=None,
        sa_column=SAColumn(SADateTime(timezone=True), nullable=True),
    )
    # NULL = not pinned; the value orders the pinned popover newest-first.
    pinned_at: datetime | None = Field(
        default=None,
        sa_column=SAColumn(SADateTime(timezone=True), nullable=True),
    )
    pinned_by_human_id: int | None = Field(
        default=None, foreign_key="human_users.id"
    )
    # Server-resolved OG card for the first URL, so the client renders it
    # with no fetch. NULL falls back to the client-side preview hook.
    link_preview: dict | None = Field(
        default=None,
        sa_column=SAColumn(JSONB, nullable=True),
    )
    # Trace id minted by the client and persisted so the agent can stamp its
    # reply with the same one, stitching spans across every hop.
    trace_id: str | None = Field(
        default=None,
        sa_column=SAColumn(Text, nullable=True),
    )
    # STORED GENERATED by Postgres, never written from Python. Declared so
    # ``alembic check`` sees no drift and the ORM can query it.
    message_tsv: Any | None = Field(
        default=None,
        sa_column=SAColumn(
            TSVECTOR(),
            Computed("to_tsvector('english', message)", persisted=True),
            nullable=True,
        ),
    )


class MmChannelEvent(SQLModel, table=True):
    """Inline non-message events in a channel timeline.

    Lives alongside :class:`MmPost` rather than as a discriminated row
    inside it: events have no post-shaped state (edits, reactions, pins,
    threads, files, link previews), and keeping them separate means the
    post mutation endpoints can't accidentally apply to events. The
    history endpoint merges posts and events server-side via UNION ALL
    ordered by ``created_at`` so the client still sees one stream.

    Identity model mirrors :class:`MmPost`: ``actor_*`` is who took the
    action (exactly one of human/agent set, enforced by the check
    constraint); ``subject_*`` is the target. NULL subject means the
    actor acted on themselves — the renderer picks "joined"/"left" over
    "added X"/"removed X" on that signal.

    ``payload`` is a future-proofing JSONB slot. Always NULL for
    ``member.*`` events; reserved for event types that carry diff-like
    data (e.g. ``channel.renamed`` storing old/new names) without
    needing a migration.

    DMs never get events: the emit helper short-circuits on
    ``channel_type == 'direct'`` so this table stays free of 1:1 noise.
    """

    __tablename__ = "mm_channel_events"
    __table_args__ = (
        CheckConstraint(
            "event_type IN ('member.added', 'member.removed')",
            name="mm_channel_events_type_check",
        ),
        CheckConstraint(
            "actor_human_id IS NOT NULL OR actor_agent_id IS NOT NULL",
            name="mm_channel_events_actor_check",
        ),
        Index(
            "ix_mm_channel_events_channel_created",
            "channel_id", "created_at",
        ),
    )

    event_id: int | None = Field(default=None, primary_key=True)
    channel_id: str = Field(nullable=False, foreign_key="mm_channels.channel_id")
    event_type: str = Field(nullable=False)
    actor_human_id: int | None = Field(default=None, foreign_key="human_users.id")
    actor_agent_id: str | None = Field(default=None, foreign_key="agents.agent_id")
    subject_human_id: int | None = Field(default=None, foreign_key="human_users.id")
    subject_agent_id: str | None = Field(default=None, foreign_key="agents.agent_id")
    payload: dict | None = Field(
        default=None,
        sa_column=SAColumn(JSONB, nullable=True),
    )
    created_at: datetime | None = Field(default=None, sa_column=_server_now_column())



class AgentAction(SQLModel, table=True):
    __tablename__ = "agent_actions"

    agent_id: str = Field(primary_key=True, foreign_key="agents.agent_id")
    action_id: str = Field(primary_key=True)
    action_md: str = Field(nullable=False)
    updated_at: datetime | None = Field(default=None, sa_column=_server_now_column())


class AgentProfile(SQLModel, table=True):
    __tablename__ = "agent_profiles"

    agent_id: str = Field(primary_key=True, foreign_key="agents.agent_id")
    display_name: str | None = None
    bio: str | None = None
    location: str | None = None
    website: str | None = None
    avatar_url: str | None = None
    header_url: str | None = None
    # Generated agent-side and pushed; the server only stores and relays.
    description: str | None = None
    # When the agent last (re)generated ``description``. NULL while the value
    # is still the creation placeholder (``description_source == "default"``).
    description_generated_at: datetime | None = Field(
        default=None, sa_column=SAColumn(SADateTime(timezone=True), nullable=True)
    )
    # "default" (creation placeholder) | "auto" (agent-generated) | "manual".
    description_source: str | None = None
    # Set by a regen request, cleared on the next push. Drives "Refreshing…".
    description_regen_requested_at: datetime | None = Field(
        default=None, sa_column=SAColumn(SADateTime(timezone=True), nullable=True)
    )
    updated_at: datetime | None = Field(default=None, sa_column=_server_now_column())


class AgentSignupRequest(SQLModel, table=True):
    __tablename__ = "agent_signup_requests"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending_approval', 'approved', 'rejected')",
            name="agent_signup_requests_status_check",
        ),
    )

    request_id: str = Field(primary_key=True)
    agent_id: str = Field(nullable=False, foreign_key="agents.agent_id")
    org_id: str = Field(nullable=False, foreign_key="organizations.org_id")
    status: str = Field(default="pending_approval", nullable=False)
    created_at: datetime | None = Field(default=None, sa_column=_server_now_column())
    reviewed_by: int | None = Field(default=None, foreign_key="human_users.id")
    reviewed_at: datetime | None = Field(
        default=None, sa_column=SAColumn(SADateTime(timezone=True), nullable=True)
    )


class AgentClaim(SQLModel, table=True):
    """Agent ownership claim, keyed on email.

    When an agent signs up with an ``owner_email`` for a human who hasn't
    registered yet, a row is inserted here. On the human's first WorkOS
    login we resolve all claims for their email and link the agents.
    """

    __tablename__ = "agent_claims"
    __table_args__ = (
        UniqueConstraint("email", "agent_id", name="uq_agent_claims_email_agent"),
    )

    id: int | None = Field(default=None, primary_key=True)
    email: str = Field(nullable=False, index=True)
    agent_id: str = Field(nullable=False, foreign_key="agents.agent_id")
    created_at: datetime | None = Field(default=None, sa_column=_server_now_column())



class PushDevice(SQLModel, table=True):
    """A registered push target for a human — one row per device/browser.

    Web push (the only transport wired today) stores the browser's push
    subscription: ``token`` is the endpoint URL and ``p256dh``/``auth`` are
    the subscription's encryption keys. The schema is transport-tagged so the
    native mobile apps can reuse it later — iOS (APNs) and Android (FCM) set
    ``token`` to the native device token and leave the web-push key columns
    NULL.

    A row's presence means "believed deliverable": the dispatcher prunes a
    device the moment its push service reports the subscription gone (HTTP
    404/410), so we never accumulate dead endpoints.
    """

    __tablename__ = "push_devices"
    __table_args__ = (
        # The routing identity is unique per subscription — re-subscribing
        # the same browser upserts this row rather than duplicating it.
        UniqueConstraint("token", name="uq_push_devices_token"),
        CheckConstraint(
            "transport IN ('webpush', 'apns', 'fcm')",
            name="push_devices_transport_check",
        ),
        Index("ix_push_devices_human", "human_id"),
    )

    id: int | None = Field(default=None, primary_key=True)
    human_id: int = Field(nullable=False, foreign_key="human_users.id")
    # 'webpush' today; 'apns' | 'fcm' reserved for the native mobile apps.
    transport: str = Field(
        default="webpush",
        sa_column=SAColumn(Text, nullable=False, server_default="webpush"),
    )
    # Routing identity, unique per subscription/device: the Web Push endpoint
    # URL for webpush; the APNs/FCM device token for the native transports.
    token: str = Field(sa_column=SAColumn(Text, nullable=False))
    # Web Push subscription encryption keys (base64url). NULL for apns/fcm.
    p256dh: str | None = Field(default=None, sa_column=SAColumn(Text, nullable=True))
    auth: str | None = Field(default=None, sa_column=SAColumn(Text, nullable=True))
    # Which app surface registered this device: 'web' | 'ios' | 'android'.
    app: str = Field(
        default="web",
        sa_column=SAColumn(Text, nullable=False, server_default="web"),
    )
    # Free-form UA string captured at subscribe time — lets a future settings
    # screen show the user which device a subscription belongs to.
    user_agent: str | None = Field(
        default=None, sa_column=SAColumn(Text, nullable=True)
    )
    enabled: bool = Field(
        default=True,
        sa_column=SAColumn(Boolean, nullable=False, server_default="true"),
    )
    created_at: datetime | None = Field(default=None, sa_column=_server_now_column())
    last_seen_at: datetime | None = Field(
        default=None,
        sa_column=SAColumn(SADateTime(timezone=True), nullable=True),
    )


class AgentContactPermission(SQLModel, table=True):
    """Who may contact an agent — the agent's operator-managed allowlist.

    Contact is **closed by default**: with no row, a principal (a human or
    another agent) can neither open a DM with this agent nor ``@``-tag it in a
    channel. The agent's operator (``Agent.operator_id``) is always implicitly
    allowed and is therefore never stored here. A grant carries two
    independently-toggled surfaces:

    - ``can_dm``  — may open/access a direct-message channel with the agent.
    - ``can_tag`` — may ``@``-mention the agent in a channel (and add it to one).

    Each row names exactly one principal: either ``human_id`` or
    ``principal_agent_id`` is set, never both, never neither. A grant with both
    surfaces ``false`` is equivalent to having no row.
    """

    __tablename__ = "agent_contact_permissions"
    __table_args__ = (
        UniqueConstraint(
            "agent_id", "human_id", name="uq_agent_contact_perms_agent_human"
        ),
        UniqueConstraint(
            "agent_id",
            "principal_agent_id",
            name="uq_agent_contact_perms_agent_principal",
        ),
        CheckConstraint(
            "(human_id IS NULL) <> (principal_agent_id IS NULL)",
            name="agent_contact_perms_principal_check",
        ),
        Index("ix_agent_contact_perms_agent", "agent_id"),
    )

    id: int | None = Field(default=None, primary_key=True)
    # The agent being contacted — the owner of this allowlist.
    agent_id: str = Field(nullable=False, foreign_key="agents.agent_id")
    # The granted principal. Exactly one of these is set (see check constraint).
    human_id: int | None = Field(default=None, foreign_key="human_users.id")
    principal_agent_id: str | None = Field(
        default=None, foreign_key="agents.agent_id"
    )
    can_dm: bool = Field(
        default=False,
        sa_column=SAColumn(Boolean, nullable=False, server_default=false()),
    )
    can_tag: bool = Field(
        default=False,
        sa_column=SAColumn(Boolean, nullable=False, server_default=false()),
    )
    # The human (operator or org owner) who last wrote this grant.
    created_by: int | None = Field(default=None, foreign_key="human_users.id")
    created_at: datetime | None = Field(default=None, sa_column=_server_now_column())


# Bumped when ``desired_spec`` changes shape; echoed by the agent so we can
# spot a plugin too old to apply it.
AUTOMATION_SCHEMA_VERSION = "1"


class Automation(SQLModel, table=True):
    """An agent automation — Clawbits' control-plane mirror of one OpenClaw cron job.

    Clawbits never schedules anything itself; OpenClaw's cron engine is the
    system of record. This table holds the operator's *desired* state and a
    *mirror* of what the agent's plugin last reported. The plugin reconciles the
    local gateway cron to ``desired_spec`` over the agent's existing outbound
    lane — Clawbits never connects in.

    - ``managed_by='clawbits'`` rows carry a ``desired_spec`` and are reconciled
      to it; the plugin creates/updates/removes the matching gateway cron job.
    - ``managed_by='external'`` rows are mirror-only (read-only in the UI),
      materialized from the self-report when the agent reports a cron job
      Clawbits did not author (e.g. one made via ``openclaw cron``).
    """

    __tablename__ = "automations"
    __table_args__ = (
        CheckConstraint(
            "managed_by IN ('clawbits', 'external')",
            name="automations_managed_by_check",
        ),
        CheckConstraint(
            "sync_status IN ('requested', 'applied', 'failed', 'removing')",
            name="automations_sync_status_check",
        ),
        # One row per (agent, gateway job); NULLs are distinct in Postgres, so
        # not-yet-applied rows coexist freely.
        UniqueConstraint(
            "agent_id", "gateway_job_id", name="uq_automations_agent_job"
        ),
        Index("ix_automations_agent", "agent_id"),
        Index("ix_automations_org", "org_id"),
    )

    automation_id: str = Field(primary_key=True)
    agent_id: str = Field(nullable=False, foreign_key="agents.agent_id")
    org_id: str | None = Field(default=None, foreign_key="organizations.org_id")

    # 'clawbits' = operator-authored + reconciled; 'external' = mirror-only.
    managed_by: str = Field(
        default="clawbits",
        sa_column=SAColumn(Text, nullable=False, server_default="clawbits"),
    )

    # Normalized cron payload, not a raw ``CronJob`` (runtime-owned fields
    # live in the reported_* columns). NULL for mirror-only rows.
    desired_spec: dict[str, Any] | None = Field(
        default=None, sa_column=SAColumn(JSONB, nullable=True)
    )
    # Monotonic per agent; bumped on every operator intent change so the plugin
    # can tell whether a given report reflects the latest desired state.
    desired_generation: int = Field(
        default=0,
        sa_column=SAColumn(BigInteger, nullable=False, server_default="0"),
    )
    # Canonical hash of ``desired_spec`` for drift/apply comparison — never
    # compare raw JSON text.
    spec_hash: str | None = None

    # The mirror: the spec + runtime state the agent last reported.
    reported_spec: dict[str, Any] | None = Field(
        default=None, sa_column=SAColumn(JSONB, nullable=True)
    )
    # ``CronJobState`` projection: nextRunAtMs, lastRunAtMs, lastRunStatus,
    # lastError, consecutiveErrors, lastDurationMs, runningAtMs, ...
    reported_state: dict[str, Any] | None = Field(
        default=None, sa_column=SAColumn(JSONB, nullable=True)
    )
    # A report only advances ``sync_status`` if it is for this generation.
    observed_generation: int | None = Field(
        default=None, sa_column=SAColumn(BigInteger, nullable=True)
    )

    # Run-now, separate from desired state: the plugin runs once when this
    # exceeds ``run_observed_generation``. Monotonic, so repeat clicks collapse.
    run_requested_generation: int = Field(
        default=0,
        sa_column=SAColumn(BigInteger, nullable=False, server_default="0"),
    )
    run_observed_generation: int = Field(
        default=0,
        sa_column=SAColumn(BigInteger, nullable=False, server_default="0"),
    )

    schema_version: str = Field(
        default=AUTOMATION_SCHEMA_VERSION,
        sa_column=SAColumn(
            Text, nullable=False, server_default=AUTOMATION_SCHEMA_VERSION
        ),
    )
    # Reported by the agent: the gateway + plugin versions that produced the
    # mirror, so we can flag a plugin too old for the current schema.
    openclaw_version: str | None = None
    plugin_version: str | None = None

    sync_status: str = Field(
        default="requested",
        sa_column=SAColumn(Text, nullable=False, server_default="requested"),
    )
    sync_error: str | None = None

    # The OpenClaw cron job id, set once the plugin has created the job.
    gateway_job_id: str | None = None

    # External/disappeared-job detection + soft delete.
    last_seen_at: datetime | None = Field(
        default=None, sa_column=SAColumn(SADateTime(timezone=True), nullable=True)
    )
    missing_since: datetime | None = Field(
        default=None, sa_column=SAColumn(SADateTime(timezone=True), nullable=True)
    )
    deleted_at: datetime | None = Field(
        default=None, sa_column=SAColumn(SADateTime(timezone=True), nullable=True)
    )
    last_reported_at: datetime | None = Field(
        default=None, sa_column=SAColumn(SADateTime(timezone=True), nullable=True)
    )

    created_by: int | None = Field(default=None, foreign_key="human_users.id")
    created_at: datetime | None = Field(default=None, sa_column=_server_now_column())
    updated_at: datetime | None = Field(default=None, sa_column=_server_now_column())


class AutomationRun(SQLModel, table=True):
    """One recorded run of an automation — a bounded projection of an OpenClaw
    ``CronRunLogEntry`` the agent self-reported (``cron.runs``).

    The run is the real artifact: a green status means the run didn't crash,
    not that the task succeeded. Ingestion is bounded and de-duplicated on
    ``(automation_id, gateway_run_id)`` so re-reporting the same run upserts
    rather than piling up.
    """

    __tablename__ = "automation_runs"
    __table_args__ = (
        UniqueConstraint(
            "automation_id", "gateway_run_id", name="uq_automation_runs_run"
        ),
        Index("ix_automation_runs_automation", "automation_id"),
    )

    id: int | None = Field(default=None, primary_key=True)
    automation_id: str = Field(
        nullable=False, foreign_key="automations.automation_id"
    )
    agent_id: str = Field(nullable=False, foreign_key="agents.agent_id")
    gateway_job_id: str | None = None
    gateway_run_id: str | None = None
    status: str | None = None
    started_at: datetime | None = Field(
        default=None, sa_column=SAColumn(SADateTime(timezone=True), nullable=True)
    )
    finished_at: datetime | None = Field(
        default=None, sa_column=SAColumn(SADateTime(timezone=True), nullable=True)
    )
    # Bounded ``CronRunLogEntry`` projection (status / delivery / model /
    # provider / token-usage telemetry).
    summary: dict[str, Any] | None = Field(
        default=None, sa_column=SAColumn(JSONB, nullable=True)
    )
    diagnostics: dict[str, Any] | None = Field(
        default=None, sa_column=SAColumn(JSONB, nullable=True)
    )
    created_at: datetime | None = Field(default=None, sa_column=_server_now_column())


# Bumped when the report contract changes; echoed back for forward-compat.
AGENT_USAGE_SCHEMA_VERSION = "1"

# Sentinel, not NULL: ``provider`` is part of the daily primary key, and NULLs
# are pairwise distinct, so the ON-CONFLICT fold would never accumulate.
UNKNOWN_PROVIDER = "unknown"


class AgentUsageEvent(SQLModel, table=True):
    """One self-reported LLM call — the dedup ledger and a short-retention
    recent-activity feed.

    The agent's plugin reads token usage inside its own OpenClaw and reports
    it over the outbound ``api_key`` lane; Clawbits is a passive store and
    never dials in. Rows are deduped on ``(agent_id, event_id)`` so
    at-least-once reporting never double-counts. Advisory telemetry only:
    self-reported numbers must never feed billing, quotas, or enforcement.
    Rows older than the retention window are pruned — ``agent_usage_daily``
    is the durable rollup.
    """

    __tablename__ = "agent_usage_events"
    __table_args__ = (
        UniqueConstraint("agent_id", "event_id", name="uq_agent_usage_event"),
        CheckConstraint(
            "source IN ('hook', 'jsonl')",
            name="agent_usage_events_source_check",
        ),
        Index("ix_agent_usage_events_agent_time", "agent_id", "occurred_at"),
        Index("ix_agent_usage_events_org_time", "org_id", "occurred_at"),
    )

    usage_event_id: str = Field(primary_key=True)
    agent_id: str = Field(nullable=False, foreign_key="agents.agent_id")
    # Denormalized from ``agent.org_id`` at ingest, for org rollup queries.
    org_id: str | None = Field(default=None, foreign_key="organizations.org_id")
    # Client idempotency key: hook ``runId:callId`` or a JSONL line hash.
    event_id: str = Field(nullable=False)
    # Model-call time. Client-supplied, so ingest window-validates it in both
    # directions (retention horizon / future skew); drives the daily buckets.
    occurred_at: datetime = Field(
        sa_column=SAColumn(SADateTime(timezone=True), nullable=False)
    )
    model: str = Field(nullable=False)
    provider: str = Field(
        default=UNKNOWN_PROVIDER,
        sa_column=SAColumn(Text, nullable=False, server_default=UNKNOWN_PROVIDER),
    )
    input_tokens: int = Field(
        default=0, sa_column=SAColumn(BigInteger, nullable=False, server_default="0")
    )
    output_tokens: int = Field(
        default=0, sa_column=SAColumn(BigInteger, nullable=False, server_default="0")
    )
    cache_read_tokens: int = Field(
        default=0, sa_column=SAColumn(BigInteger, nullable=False, server_default="0")
    )
    cache_write_tokens: int = Field(
        default=0, sa_column=SAColumn(BigInteger, nullable=False, server_default="0")
    )
    # Passthrough from the source; NULL for OAuth/subscription agents.
    # Clawbits owns no pricing table.
    cost_usd: Decimal | None = Field(
        default=None, sa_column=SAColumn(Numeric(18, 6), nullable=True)
    )
    currency: str = Field(
        default="USD", sa_column=SAColumn(Text, nullable=False, server_default="USD")
    )
    # One source per agent: the two derive different event_ids for the same
    # call, so dedup can't bridge them.
    source: str = Field(sa_column=SAColumn(Text, nullable=False))
    reported_at: datetime | None = Field(default=None, sa_column=_server_now_column())


class AgentUsageDaily(SQLModel, table=True):
    """Durable per-day usage rollup — the dashboard's source of truth.

    Tiny (agents x days x models) and kept forever, so all-time totals
    survive raw-event pruning. Populated at ingest: each *newly inserted*
    event row is folded into its bucket, so a duplicate event inserts nothing
    and adds nothing. Every PK column is NOT NULL (``provider`` uses the
    ``"unknown"`` sentinel) — a nullable member would break the ON-CONFLICT
    accumulation.
    """

    __tablename__ = "agent_usage_daily"
    __table_args__ = (
        Index("ix_agent_usage_daily_org_date", "org_id", "usage_date"),
    )

    agent_id: str = Field(primary_key=True, foreign_key="agents.agent_id")
    # UTC calendar day of the underlying model calls.
    usage_date: date = Field(primary_key=True)
    model: str = Field(primary_key=True)
    provider: str = Field(primary_key=True)
    org_id: str | None = Field(default=None, foreign_key="organizations.org_id")
    input_tokens: int = Field(
        default=0, sa_column=SAColumn(BigInteger, nullable=False, server_default="0")
    )
    output_tokens: int = Field(
        default=0, sa_column=SAColumn(BigInteger, nullable=False, server_default="0")
    )
    cache_read_tokens: int = Field(
        default=0, sa_column=SAColumn(BigInteger, nullable=False, server_default="0")
    )
    cache_write_tokens: int = Field(
        default=0, sa_column=SAColumn(BigInteger, nullable=False, server_default="0")
    )
    cost_usd: Decimal | None = Field(
        default=None, sa_column=SAColumn(Numeric(18, 6), nullable=True)
    )
    call_count: int = Field(
        default=0, sa_column=SAColumn(BigInteger, nullable=False, server_default="0")
    )


# Bumped when the normalized manifest shape changes in a way the plugin must
# understand.
SKILL_SCHEMA_VERSION = "1"


class Skill(SQLModel, table=True):
    """One skill in an org's library — the mutable pointer.

    Identity and lineage only; content lives in immutable ``skill_versions``
    rows. ``org_id`` is NOT NULL and is the tenancy boundary: a skill has no
    agent to join through, so the column carries the check itself.
    """

    __tablename__ = "skills"
    __table_args__ = (
        CheckConstraint(
            "visibility IN ('private', 'org', 'public')",
            name="skills_visibility_check",
        ),
        CheckConstraint(
            "origin IN ('authored', 'forked', 'imported')",
            name="skills_origin_check",
        ),
        # One slug per org among LIVE skills; partial on ``deleted_at IS NULL``
        # so a soft-deleted skill doesn't burn its name forever.
        Index(
            "uq_skills_org_slug",
            "org_id",
            "slug",
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
        ),
        Index("ix_skills_org", "org_id"),
    )

    skill_id: str = Field(primary_key=True)
    org_id: str = Field(nullable=False, foreign_key="organizations.org_id")
    # Directory name on the agent, and the frontmatter ``name``.
    slug: str = Field(sa_column=SAColumn(Text, nullable=False))
    display_name: str = Field(sa_column=SAColumn(Text, nullable=False))
    # The frontmatter ``description``; injected into every prompt.
    summary: str = Field(sa_column=SAColumn(Text, nullable=False))
    icon_emoji: str | None = None

    # 'public' ships but the tier stays dark pending a licensing decision.
    visibility: str = Field(
        default="org",
        sa_column=SAColumn(Text, nullable=False, server_default="org"),
    )
    origin: str = Field(
        default="authored",
        sa_column=SAColumn(Text, nullable=False, server_default="authored"),
    )
    runtimes: list[str] | None = Field(
        default=None, sa_column=SAColumn(JSONB, nullable=True)
    )

    # No cascade: deleting the source must never delete the fork.
    forked_from_skill_id: str | None = Field(
        default=None,
        sa_column=SAColumn(Text, ForeignKey("skills.skill_id"), nullable=True),
    )
    forked_from_version_id: str | None = Field(
        default=None, sa_column=SAColumn(Text, nullable=True)
    )

    # NULL = draft, never published, not installable.
    latest_version_id: str | None = Field(
        default=None, sa_column=SAColumn(Text, nullable=True)
    )

    archived_at: datetime | None = Field(
        default=None, sa_column=SAColumn(SADateTime(timezone=True), nullable=True)
    )
    deleted_at: datetime | None = Field(
        default=None, sa_column=SAColumn(SADateTime(timezone=True), nullable=True)
    )
    created_by: int | None = Field(default=None, foreign_key="human_users.id")
    created_at: datetime | None = Field(default=None, sa_column=_server_now_column())
    updated_at: datetime | None = Field(default=None, sa_column=_server_now_column())


class SkillVersion(SQLModel, table=True):
    """One immutable published version. Editing publishes a new row.

    No update path, so ``content_hash`` is stable under a fixed id and is safe
    as the plugin's drift gate.
    """

    __tablename__ = "skill_versions"
    __table_args__ = (
        UniqueConstraint("skill_id", "version", name="uq_skill_versions_skill_version"),
        Index("ix_skill_versions_skill", "skill_id"),
        Index("ix_skill_versions_hash", "content_hash"),
    )

    version_id: str = Field(primary_key=True)
    skill_id: str = Field(nullable=False, foreign_key="skills.skill_id")
    # Semver; publishing is an implicit patch bump.
    version: str = Field(sa_column=SAColumn(Text, nullable=False))
    # sha256 over {manifest, body_md, files}; the plugin's drift gate.
    content_hash: str = Field(sa_column=SAColumn(Text, nullable=False))

    # Normalized + neutralized frontmatter, never a raw SKILL.md.
    manifest: dict[str, Any] = Field(sa_column=SAColumn(JSONB, nullable=False))
    body_md: str = Field(sa_column=SAColumn(Text, nullable=False))
    # [{path, content, sha256, size_bytes}]
    files: list[dict[str, Any]] | None = Field(
        default=None, sa_column=SAColumn(JSONB, nullable=True)
    )
    total_bytes: int = Field(
        default=0, sa_column=SAColumn(Integer, nullable=False, server_default="0")
    )
    # Always false in v1 (no scripts/); ships so the affordance exists early.
    has_executable: bool = Field(
        default=False,
        sa_column=SAColumn(Boolean, nullable=False, server_default=false()),
    )

    changelog: str | None = None
    schema_version: str = Field(
        default=SKILL_SCHEMA_VERSION,
        sa_column=SAColumn(Text, nullable=False, server_default=SKILL_SCHEMA_VERSION),
    )
    published_by: int | None = Field(default=None, foreign_key="human_users.id")
    created_at: datetime | None = Field(default=None, sa_column=_server_now_column())


class AgentSkillInstall(SQLModel, table=True):
    """One skill present on (or destined for) one agent — the sync plane.

    The only table an agent report may touch. ``managed_by='clawbits'`` rows are
    reconciled to a resolved version; ``managed_by='external'`` rows mirror
    skills the agent already had (image-bundled, terminal-installed, or
    installed by the agent itself) and are never written or deleted.

    ``UNIQUE(agent_id, slug)`` is deliberately NOT partial: a partial index
    would let a tombstone and a live row for the same slug coexist, making
    reconcile ordering load-bearing.
    """

    __tablename__ = "agent_skill_installs"
    __table_args__ = (
        CheckConstraint(
            "managed_by IN ('clawbits', 'external')",
            name="agent_skill_installs_managed_check",
        ),
        CheckConstraint(
            "sync_status IN ('requested', 'applied', 'staged', 'failed', 'removing')",
            name="agent_skill_installs_sync_status_check",
        ),
        CheckConstraint(
            "channel IN ('pinned', 'latest')",
            name="agent_skill_installs_channel_check",
        ),
        UniqueConstraint("agent_id", "slug", name="uq_agent_skill_installs_agent_slug"),
        Index("ix_agent_skill_installs_agent", "agent_id"),
        Index("ix_agent_skill_installs_org", "org_id"),
        Index("ix_agent_skill_installs_skill", "skill_id"),
    )

    install_id: str = Field(primary_key=True)
    agent_id: str = Field(nullable=False, foreign_key="agents.agent_id")
    org_id: str | None = Field(default=None, foreign_key="organizations.org_id")
    # NULL exactly when managed_by='external'.
    skill_id: str | None = Field(
        default=None, sa_column=SAColumn(Text, ForeignKey("skills.skill_id"), nullable=True)
    )
    slug: str = Field(sa_column=SAColumn(Text, nullable=False))

    managed_by: str = Field(
        default="external",
        sa_column=SAColumn(Text, nullable=False, server_default="external"),
    )
    # 'latest' follows the skill's current version; 'pinned' stays put.
    channel: str = Field(
        default="latest",
        sa_column=SAColumn(Text, nullable=False, server_default="latest"),
    )
    pinned_version_id: str | None = None
    resolved_version_id: str | None = None
    desired_content_hash: str | None = None
    enabled: bool = Field(
        default=True, sa_column=SAColumn(Boolean, nullable=False, server_default=text("true"))
    )

    desired_generation: int = Field(
        default=0, sa_column=SAColumn(BigInteger, nullable=False, server_default="0")
    )
    observed_generation: int | None = Field(
        default=None, sa_column=SAColumn(BigInteger, nullable=True)
    )

    sync_status: str = Field(
        default="requested",
        sa_column=SAColumn(Text, nullable=False, server_default="requested"),
    )
    sync_error: str | None = None
    # watch | restart | ondemand. Verified 'watch' on OpenClaw 2026.6.11.
    apply_mode: str | None = None

    reported_version: str | None = None
    reported_content_hash: str | None = None
    reported_path: str | None = None
    # Agent-reported, therefore untrusted display text.
    reported_root: str | None = None
    reported_source: str | None = None
    reported_manifest: dict[str, Any] | None = Field(
        default=None, sa_column=SAColumn(JSONB, nullable=True)
    )
    # Loader verdict: eligible / modelVisible / missing requirements.
    reported_state: dict[str, Any] | None = Field(
        default=None, sa_column=SAColumn(JSONB, nullable=True)
    )

    schema_version: str = Field(
        default=SKILL_SCHEMA_VERSION,
        sa_column=SAColumn(Text, nullable=False, server_default=SKILL_SCHEMA_VERSION),
    )
    plugin_version: str | None = None
    agent_runtime_version: str | None = None

    missing_streak: int = Field(
        default=0, sa_column=SAColumn(Integer, nullable=False, server_default="0")
    )
    last_seen_at: datetime | None = Field(
        default=None, sa_column=SAColumn(SADateTime(timezone=True), nullable=True)
    )
    missing_since: datetime | None = Field(
        default=None, sa_column=SAColumn(SADateTime(timezone=True), nullable=True)
    )
    last_reported_at: datetime | None = Field(
        default=None, sa_column=SAColumn(SADateTime(timezone=True), nullable=True)
    )
    deleted_at: datetime | None = Field(
        default=None, sa_column=SAColumn(SADateTime(timezone=True), nullable=True)
    )

    installed_by: int | None = Field(default=None, foreign_key="human_users.id")
    created_at: datetime | None = Field(default=None, sa_column=_server_now_column())
    updated_at: datetime | None = Field(default=None, sa_column=_server_now_column())


class AgentSkillSyncState(SQLModel, table=True):
    """Per-agent sync facts not about one skill: the generation, the kill
    switch, and agent-reported observability.

    ``prompt_budget_observed`` is the early warning for OpenClaw's
    ``maxSkillsPromptChars``, past which the loader silently drops skills.
    """

    __tablename__ = "agent_skill_sync_state"

    agent_id: str = Field(primary_key=True, foreign_key="agents.agent_id")
    desired_generation: int = Field(
        default=0, sa_column=SAColumn(BigInteger, nullable=False, server_default="0")
    )
    # Kill switch: the client reports but changes nothing while true.
    paused: bool = Field(
        default=False, sa_column=SAColumn(Boolean, nullable=False, server_default=false())
    )
    # 'observe' = the client has no write path; 'apply' = it reconciles.
    report_mode: str | None = None
    # Reported so a wrong root resolution is visible instead of silent.
    skills_root: str | None = None
    scanned_roots: list[str] | None = Field(
        default=None, sa_column=SAColumn(JSONB, nullable=True)
    )
    apply_mode: str | None = None
    prompt_chars_observed: int | None = None
    prompt_budget_observed: int | None = None
    report_truncated: bool = Field(
        default=False, sa_column=SAColumn(Boolean, nullable=False, server_default=false())
    )
    plugin_version: str | None = None
    agent_runtime_version: str | None = None
    last_reported_at: datetime | None = Field(
        default=None, sa_column=SAColumn(SADateTime(timezone=True), nullable=True)
    )
    updated_at: datetime | None = Field(default=None, sa_column=_server_now_column())
