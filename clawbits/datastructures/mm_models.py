"""Mattermost-style messaging data models."""
from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from clawbits.datastructures.avatar_models import AvatarRef

AgentPresenceStatus = Literal["online", "idle", "typing", "generating", "offline"]
GlobalUserStatus = Literal["online", "idle", "offline"]
AgentLivenessStatus = Literal["setup", "available", "offline"]
MemberKind = Literal["agent", "human"]


def agent_dm_channel_name(human_id: int, agent_id: str) -> str:
    return f"dm-human-{human_id}-agent-{agent_id}"


def agent_default_channel_name(agent_id: str) -> str:
    return f"agent-{agent_id}"


AGENT_CHAT = "agent_chat"
PAIR_CHANNEL_TYPES: tuple[str, ...] = ("direct", AGENT_CHAT)
NEW_CHAT_TITLE = "New chat"


TITLE_MAX_LEN = 40

_TITLE_MENTION = re.compile(r"@[\w.-]+")
_TITLE_MARKUP = re.compile(r"^(?:[>#•]+\s*|[-*+]\s+|\d+[.)]\s+)+")
# Openers that say nothing in a list: the ask starts after them.
_TITLE_OPENER = re.compile(
    r"^(?:(?:hey|hi|hello|yo|ok|okay|so|pls|plz|please|thanks|thx)[\s,!.]+)*"
    r"(?:(?:can|could|would|will)\s+(?:you|u)\s+|i\s+(?:need|want)\s+(?:you\s+)?to\s+|let'?s\s+)?",
    re.IGNORECASE,
)
# A cut title should not end on a word that was reaching for the next one.
_TITLE_DANGLING = re.compile(
    r"^(?:an?|and|are|as|at|be|but|by|for|from|in|is|its?|my|of|on|or|that|the|this|to"
    r"|was|were|will|with|your?)$",
    re.IGNORECASE,
)
_TITLE_TAIL = ".,;:?!…"


def heuristic_chat_title(message: str, *, max_len: int = TITLE_MAX_LEN) -> str | None:
    """A short handle for a chat, taken from the message that opened it.

    Reads as a phrase, not a severed sentence: the ask starts after any greeting,
    a cut lands on a word boundary, and a trailing function word left reaching for
    the next one is dropped. Casing stays the writer's, so ``npm`` survives, and an
    ellipsis appears only where a single word had to be cut through.
    """
    lines = (
        re.sub(r"\s+", " ", _TITLE_MARKUP.sub("", _TITLE_MENTION.sub("", raw).strip()))
        for raw in message.splitlines()
        if not raw.lstrip().startswith("```")
    )
    line = next((s for s in (p.strip() for p in lines) if s), "")
    line = _TITLE_OPENER.sub("", line, count=1).strip(" ,:;-").rstrip(_TITLE_TAIL)
    if not line:
        return None
    if len(line) <= max_len:
        return line
    head, boundary, _ = line[: max_len + 1].rpartition(" ")
    if not boundary:
        return line[:max_len] + "…"
    words = head.split(" ")
    while len(words) > 1 and _TITLE_DANGLING.match(words[-1].strip(_TITLE_TAIL)):
        words.pop()
    return " ".join(words).rstrip(_TITLE_TAIL)


RealtimeEventType = Literal[
    "post.created",
    "post.updated",
    "post.deleted",
    "member.status",
    "member.read",
    "member.removed",
    "presence.snapshot",
    "channel.read",
    "channel.muted",
    "channel.added",
    "channel.removed",
    "channel.event",
    "user.status",
    "agent.status",
    "org.added",
    "automation.sync",
    "model.selection",
    "server.hello",
]
MmPostStatus = Literal["streaming", "draft", "published", "rejected"]
# Extend together with the DB check constraint.
MmChannelEventType = Literal["member.added", "member.removed"]

# The plugin pings every ~10 min, so this tolerates ~4 missed beats; change both together.
AGENT_OFFLINE_AFTER = timedelta(minutes=40)


def agent_liveness_status(
    last_alive_at: datetime | None,
    *,
    now: datetime | None = None,
) -> AgentLivenessStatus:
    """``setup`` before the first alive ping, ``available`` while the last one is at most
    :data:`AGENT_OFFLINE_AFTER` old, ``offline`` after. Naive timestamps are read as UTC."""
    if last_alive_at is None:
        return "setup"
    if last_alive_at.tzinfo is None:
        last_alive_at = last_alive_at.replace(tzinfo=UTC)
    return (
        "available"
        if (now or datetime.now(UTC)) - last_alive_at <= AGENT_OFFLINE_AFTER
        else "offline"
    )


class MmCreateChannelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    name: str = Field(min_length=1, max_length=64, description="Channel name (unique within org)")
    display_name: str | None = Field(default=None, max_length=128, description="Human-friendly display name")
    channel_type: Literal["public", "private"] = Field(default="public", description="Channel type")


class MmHumanCreateChannelRequest(BaseModel):
    """Human channel creation; requires org_id."""
    model_config = ConfigDict(extra="forbid", frozen=True)
    org_id: str = Field(description="Organization the channel belongs to (caller must be a member)")
    name: str = Field(min_length=1, max_length=64, description="Channel name (unique within org)")
    display_name: str | None = Field(default=None, max_length=128, description="Human-friendly display name")
    channel_type: Literal["public", "private"] = Field(default="public", description="Channel type")


class MmAddMemberRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    agent_id: str = Field(min_length=1, description="Agent ID to add as a member")


class MmAddMemberUnifiedRequest(BaseModel):
    """Unified add-member request supporting both agent and human members."""
    model_config = ConfigDict(extra="forbid", frozen=True)
    member_id: str = Field(min_length=1, description="Agent ID or human user ID to add")
    member_type: Literal["agent", "human"] = Field(description="Whether the member is an agent or human")


class MmPostRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    message: str = Field(default="", max_length=40000, description="Message content")
    status: MmPostStatus = Field(
        default="published",
        description=(
            "Lifecycle to create the post in. 'published' (default) = "
            "immediately visible. 'streaming' = server placeholder the agent "
            "streams into via PATCH. 'draft' = pending owner approval."
        ),
    )
    parent_post_id: int | None = Field(
        default=None,
        description=(
            "Optional parent post to reply to. Must be a post in the same "
            "channel with status 'published' or 'streaming'."
        ),
    )
    file_ids: list[str] = Field(
        default_factory=list,
        max_length=20,
        description="Pre-uploaded mm_files ids to attach to this post.",
    )
    client_msg_uuid: str | None = Field(
        default=None,
        max_length=64,
        description="Client-generated id echoed back on response and SSE for optimistic-send dedupe.",
    )
    trace_id: str | None = Field(
        default=None,
        max_length=64,
        description="End-to-end latency trace id, persisted and re-stamped onto the agent's reply.",
    )

    @model_validator(mode="after")
    def _require_message_unless_streaming(self) -> MmPostRequest:
        if self.status != "streaming" and not self.message and not self.file_ids:
            raise ValueError(
                "message or file_ids is required unless status='streaming'"
            )
        return self


class MmDirectRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    target_agent_id: str = Field(min_length=1, description="Agent ID to open a DM with")


class MmDirectUnifiedRequest(BaseModel):
    """Unified DM request supporting both agent and human targets."""
    model_config = ConfigDict(extra="forbid", frozen=True)
    org_id: str = Field(min_length=1, description="Org context the DM lives in — caller (and human target) must be a member")
    target_id: str = Field(min_length=1, description="Agent ID or human user ID to open a DM with")
    target_type: Literal["agent", "human"] = Field(description="Whether the target is an agent or human")


class MmAgentChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    org_id: str = Field(min_length=1)
    agent_id: str = Field(min_length=1)


class MmChannelPatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    display_name: str = Field(min_length=1, max_length=128)


class ModelChoice(BaseModel):
    """A model ref and thinking level; ``None`` inherits, per field."""
    model: str | None = None
    thinking: str | None = None


class MmChannelResponse(BaseModel):
    channel_id: str
    org_id: str | None = None
    name: str
    display_name: str | None = None
    channel_type: str
    private: bool = False
    created_by_agent: str | None = None
    created_by_human: int | None = None
    created_at: str
    last_message_at: str | None = None
    latest_post_id: int | None = None
    # None means no read pointer yet: an agent seeds to the newest post instead of replaying.
    last_read_post_id: int | None = None
    unread_count: int = 0
    unread_mention_count: int = 0
    muted: bool = False
    pinned: bool = False
    last_message_text: str | None = None
    last_message_author_human_id: int | None = None
    last_message_author_agent_id: str | None = None
    last_message_author_display_name: str | None = None
    last_message_author_avatar: AvatarRef | None = None
    last_message_attachment_count: int = 0
    dm_peer_human_id: int | None = None
    dm_peer_agent_id: str | None = None
    dm_peer: MmChannelMemberResponse | None = None
    avatar: AvatarRef | None = None
    model: str | None = None
    thinking: str | None = None


class MmChannelMemberResponse(BaseModel):
    agent_id: str | None = None
    human_id: int | None = None
    display_name: str | None = None
    joined_at: str
    status: GlobalUserStatus | None = None
    last_seen_at: str | None = None
    last_seen_label: str | None = None
    avatar: AvatarRef | None = None
    last_read_post_id: int | None = None
    agent_status: AgentLivenessStatus | None = None
    last_alive_at: str | None = None
    # None where not computed; clients treat it as allowed.
    can_tag: bool | None = None
    is_operator: bool = False
    model_choice: ModelChoice | None = None


class MmReactionRequest(BaseModel):
    """Toggle the caller's reaction with this emoji on a post."""
    model_config = ConfigDict(extra="forbid", frozen=True)
    emoji: str = Field(min_length=1, max_length=32, description="Unicode emoji glyph")


class MmPostReactionAggregate(BaseModel):
    """One distinct emoji on a post with everyone who reacted with it. Viewer-agnostic, so
    one SSE envelope fits every member."""
    emoji: str
    count: int
    human_ids: list[int] = Field(default_factory=list)
    agent_ids: list[str] = Field(default_factory=list)


class MmPostEditRequest(BaseModel):
    """New text for a published post the caller authored. Editing to empty is not a delete."""
    model_config = ConfigDict(extra="forbid", frozen=True)
    message: str = Field(min_length=1, max_length=4000, description="New message text")


class MmPostParentPreview(BaseModel):
    """Quote block for an inline reply, read live from the parent: a truncated excerpt, its
    status, and its attachment count so an attachment-only parent is not rendered as empty."""
    post_id: int
    agent_id: str | None = None
    human_id: int | None = None
    poster_display_name: str | None = None
    message_excerpt: str
    status: MmPostStatus
    attachment_count: int = 0


MmFileStatus = Literal["pending", "uploaded", "failed", "deleted"]


class MmFileUploadRequest(BaseModel):
    """Reserve a pending file. Type and size are pinned into the presigned PUT signature, so
    R2 rejects an upload that differs."""
    model_config = ConfigDict(extra="forbid", frozen=True)
    filename: str = Field(min_length=1, max_length=255)
    content_type: str = Field(min_length=1, max_length=255)
    size_bytes: int = Field(gt=0, description="File size in bytes; capped server-side")
    sha256: str | None = Field(default=None, min_length=64, max_length=64)
    has_thumbnail: bool = False
    thumbnail_size_bytes: int | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def _validate_filename_and_thumbnail(self) -> MmFileUploadRequest:
        # Control characters would leak into the download Content-Disposition header.
        if any(ord(c) < 0x20 or ord(c) == 0x7F for c in self.filename):
            raise ValueError("filename contains control characters")
        if self.has_thumbnail and self.thumbnail_size_bytes is None:
            raise ValueError(
                "thumbnail_size_bytes is required when has_thumbnail=True"
            )
        return self


class MmFileUploadResponse(BaseModel):
    """Presigned PUT targets. Send ``upload_headers`` exactly: every one is signed."""
    file_id: str
    upload_url: str
    upload_headers: dict[str, str]
    upload_expires_in: int
    object_key: str
    thumbnail_upload_url: str | None = None
    thumbnail_upload_headers: dict[str, str] | None = None
    thumbnail_object_key: str | None = None


class MmFileConfirmRequest(BaseModel):
    """Finish an upload with client-computed metadata. Idempotent."""
    model_config = ConfigDict(extra="forbid", frozen=True)
    width: int | None = Field(default=None, ge=1)
    height: int | None = Field(default=None, ge=1)
    duration_ms: int | None = Field(default=None, ge=0)
    sha256: str | None = Field(default=None, min_length=64, max_length=64)
    thumbnail_uploaded: bool = False


class MmFileResponse(BaseModel):
    """File metadata, optionally bundled in post responses."""
    file_id: str
    channel_id: str
    filename: str
    content_type: str
    size_bytes: int
    status: MmFileStatus
    width: int | None = None
    height: int | None = None
    duration_ms: int | None = None
    created_at: str
    uploaded_at: str | None = None
    download_url: str | None = None
    download_url_expires_at: int | None = None
    thumbnail_url: str | None = None
    thumbnail_url_expires_at: int | None = None
    uploader_human_id: int | None = None
    uploader_agent_id: str | None = None
    post_id: int | None = None


class MmFileDownloadUrlResponse(BaseModel):
    url: str
    expires_in: int
    expires_at: int


class MmPostLinkPreviewEmbedded(BaseModel):
    """Server-resolved card for the first URL of a post. ``skipped`` counts the other URLs."""
    url: str
    canonical_url: str | None = None
    title: str | None = None
    description: str | None = None
    image_url: str | None = None
    site_name: str | None = None
    fetched_at: float | None = None
    error: str | None = None
    skipped: int = 0


class MmPostResponse(BaseModel):
    post_id: int
    channel_id: str
    agent_id: str | None = None
    human_id: int | None = None
    poster_display_name: str | None = None
    avatar: AvatarRef | None = None
    message: str
    created_at: str
    status: MmPostStatus = "published"
    updated_at: str | None = None
    edited_at: str | None = None
    pinned_at: str | None = None
    pinned_by_human_id: int | None = None
    parent_post_id: int | None = None
    parent_preview: MmPostParentPreview | None = None
    link_preview: MmPostLinkPreviewEmbedded | None = None
    reactions: list[MmPostReactionAggregate] = Field(default_factory=list)
    files: list[MmFileResponse] = Field(default_factory=list)
    # Only on the create response and its post.created event; never on reads.
    client_msg_uuid: str | None = None
    trace_id: str | None = None


class MmChannelEventResponse(BaseModel):
    """An inline timeline event. A NULL subject means the actor acted on themselves
    (joined/left); names and avatars are resolved server-side."""
    event_id: int
    channel_id: str
    event_type: MmChannelEventType
    actor_human_id: int | None = None
    actor_agent_id: str | None = None
    actor_display_name: str | None = None
    actor_avatar: AvatarRef | None = None
    subject_human_id: int | None = None
    subject_agent_id: str | None = None
    subject_display_name: str | None = None
    subject_avatar: AvatarRef | None = None
    payload: dict | None = None
    created_at: str


class MmHistoryRow(BaseModel):
    """One merged timeline row: ``post`` or ``event``, as ``kind`` says."""
    kind: Literal["post", "event"]
    post: MmPostResponse | None = None
    event: MmChannelEventResponse | None = None


class MmChannelEventListResponse(BaseModel):
    """Channel events, newest first."""
    events: list[MmChannelEventResponse]
    total: int


class MmTimelineResponse(BaseModel):
    """Merged timeline page, newest first. Pass ``next_cursor`` back as
    ``before_created_at``; ``None`` at the start of the channel."""
    rows: list[MmHistoryRow]
    has_more: bool
    next_cursor: str | None = None


class MmExportMember(BaseModel):
    """Identity only: presence, last-seen and read pointers are privacy-gated per viewer and
    must not be frozen into a file the caller keeps."""
    agent_id: str | None = None
    human_id: int | None = None
    display_name: str | None = None
    joined_at: str


class MmChannelExportResponse(BaseModel):
    """A downloadable archive of one conversation. ``posts`` and ``events`` are oldest-first,
    visibility matches the history endpoint, attachments carry no presigned URLs, and
    ``truncated`` marks a conversation longer than the post cap."""
    export_version: int = 1
    exported_at: str
    exported_by_human_id: int
    channel: MmChannelResponse
    members: list[MmExportMember]
    posts: list[MmPostResponse]
    events: list[MmChannelEventResponse]
    post_count: int
    truncated: bool = False


class MmPinnedListResponse(BaseModel):
    """Every pinned post in a channel, newest pin first."""
    posts: list[MmPostResponse]
    total: int


class MmPostPatchRequest(BaseModel):
    """Agent-only mutation of its streaming post. Exactly one of ``append`` or ``replace``
    unless finishing: ``done`` publishes (or drafts), ``cancel`` deletes the placeholder and
    excludes the others."""
    model_config = ConfigDict(extra="forbid", frozen=True)
    append: str | None = Field(default=None, max_length=4000)
    replace: str | None = Field(default=None, max_length=40000)
    done: bool = False
    cancel: bool = False

    @model_validator(mode="after")
    def _require_exactly_one_op(self) -> MmPostPatchRequest:
        if self.cancel:
            if self.append is not None or self.replace is not None or self.done:
                raise ValueError(
                    "cancel is mutually exclusive with append/replace/done"
                )
            return self
        if self.append is not None and self.replace is not None:
            raise ValueError("append and replace are mutually exclusive")
        if self.append is None and self.replace is None and not self.done:
            raise ValueError("append, replace, done, or cancel must be set")
        return self


# Above the plugin's own 1000-char cap (1068 on the wire), or the server re-truncates it.
ACTIVITY_LABEL_MAX_CHARS = 1200
ACTIVITY_TOOL_MAX_CHARS = 64


class MmAgentActivity(BaseModel):
    """Transient, never-persisted description of what an agent is doing mid-turn. Lengths
    are clamped, never rejected, and unknown fields from newer plugins are ignored."""
    model_config = ConfigDict(extra="ignore", frozen=True)
    kind: Literal["generating", "thinking", "tool", "tool_done"]
    label: str = ""
    tool: str | None = None
    ok: bool | None = None
    duration_ms: int | None = Field(default=None, ge=0)

    @field_validator("label", mode="before")
    @classmethod
    def _clamp_label(cls, v: object) -> str:
        return v[:ACTIVITY_LABEL_MAX_CHARS] if isinstance(v, str) else ""

    @field_validator("tool", mode="before")
    @classmethod
    def _clamp_tool(cls, v: object) -> str | None:
        return (v[:ACTIVITY_TOOL_MAX_CHARS] or None) if isinstance(v, str) else None


class MmAgentStatusRequest(BaseModel):
    """Agent realtime status, optionally with the activity behind it. Unknown fields from
    newer plugins are ignored."""
    model_config = ConfigDict(extra="ignore", frozen=True)
    status: AgentPresenceStatus
    activity: MmAgentActivity | None = None


class MmUserPresenceRequest(BaseModel):
    """Global presence heartbeat; ``offline`` is the explicit on-unload tombstone."""
    model_config = ConfigDict(extra="forbid", frozen=True)
    status: GlobalUserStatus


class MmUserPresenceResponse(BaseModel):
    human_id: int
    status: GlobalUserStatus
    last_seen_at: str | None = None
    last_seen_label: str | None = None


class MmAgentAliveRequest(BaseModel):
    """Optional body of an agent's alive ping: its self-reported runtime kind. An empty or
    missing body validates; the agent is identified by its bearer key."""

    model_config = ConfigDict(extra="ignore")
    agent_type: str | None = None


class MmAgentAliveResponse(BaseModel):
    """The stored ping time, the derived status and the offline window."""
    status: AgentLivenessStatus
    last_alive_at: str
    offline_after_seconds: int


class AutomationStateReportRequest(BaseModel):
    """Agent self-report of its local cron state (telemetry-class, billing-exempt):
    Clawbits-managed jobs, jobs the agent created itself, and recent runs."""

    model_config = ConfigDict(extra="ignore")
    openclaw_version: str | None = None
    plugin_version: str | None = None
    managed: list[dict[str, Any]] = Field(default_factory=list)
    external: list[dict[str, Any]] = Field(default_factory=list)
    runs: list[dict[str, Any]] = Field(default_factory=list)


class AutomationStateReportResponse(BaseModel):
    """The server's desired generation, so the plugin can tell it has converged."""

    ok: bool = True
    desired_generation: int
    runs_ingested: int = 0


class AutomationDesiredItem(BaseModel):
    automation_id: str
    gateway_job_id: str | None = None
    desired_generation: int
    intent: Literal["present", "absent"]
    desired_spec: dict[str, Any] | None = None
    spec_hash: str | None = None
    run_requested_generation: int = 0
    run_observed_generation: int = 0


class AutomationDesiredResponse(BaseModel):
    """The managed automations the plugin reconciles its gateway cron to."""

    schema_version: str
    desired_generation: int
    automations: list[AutomationDesiredItem]


class UsageReportEvent(BaseModel):
    """One LLM call's token usage. ``event_id`` is the idempotency key, deduplicated per
    agent; ``cost_usd`` is passed through when the runtime knows it."""

    model_config = ConfigDict(extra="ignore")
    event_id: str = Field(min_length=1, max_length=256)
    occurred_at_ms: int
    model: str = Field(min_length=1, max_length=256)
    provider: str | None = None
    input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)
    cache_read_tokens: int = Field(default=0, ge=0)
    cache_write_tokens: int = Field(default=0, ge=0)
    cost_usd: float | None = Field(default=None, ge=0)
    currency: str = "USD"


class UsageReportRequest(BaseModel):
    """Advisory LLM usage from the agent's own machine: observability, never billing. One
    ``source`` at a time, since hook and jsonl derive different event ids for a call."""

    model_config = ConfigDict(extra="ignore")
    plugin_version: str | None = None
    openclaw_version: str | None = None
    source: Literal["hook", "jsonl"] = "hook"
    events: list[UsageReportEvent] = Field(default_factory=list)


class UsageReportResponse(BaseModel):
    """Counts of stored, duplicate and out-of-window events."""

    ok: bool = True
    schema_version: str
    ingested: int = 0
    duplicates: int = 0
    rejected: int = 0


class PrivacyModeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    enabled: bool = True


class PrivacyModeResponse(BaseModel):
    human_id: int
    enabled: bool
    status: GlobalUserStatus = "idle"
    last_seen_at: str | None = None


class PrivacySettingsRequest(BaseModel):
    """Partial update: only the keys present are applied."""
    model_config = ConfigDict(extra="forbid")
    last_seen_visible: bool | None = None
    online_status_visible: bool | None = None
    read_receipts_enabled: bool | None = None
    typing_indicators_enabled: bool | None = None


class PrivacySettingsResponse(BaseModel):
    """Current privacy settings for the calling human."""
    last_seen_visible: bool
    online_status_visible: bool
    read_receipts_enabled: bool
    typing_indicators_enabled: bool


class MmMarkReadRequest(BaseModel):
    """Mark a channel read up to ``post_id``. Pointer never moves backwards."""
    model_config = ConfigDict(extra="forbid", frozen=True)
    post_id: int = Field(ge=0, description="Mark as read up through this post id")


class MmMarkReadResponse(BaseModel):
    channel_id: str
    last_read_post_id: int


class MmMuteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    muted: bool


class MmMuteResponse(BaseModel):
    channel_id: str
    muted: bool


class MmPinRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    pinned: bool


class MmPinResponse(BaseModel):
    channel_id: str
    pinned: bool


class LinkPreviewRequest(BaseModel):
    """A URL to unfurl. A failed fetch answers with ``error`` set and empty fields."""
    model_config = ConfigDict(extra="forbid", frozen=True)
    url: str = Field(min_length=1, max_length=2048, description="URL to unfurl")


class LinkPreviewResponse(BaseModel):
    url: str
    canonical_url: str | None = None
    title: str | None = None
    description: str | None = None
    image_url: str | None = None
    site_name: str | None = None
    fetched_at: float
    error: str | None = None


class MmChannelListResponse(BaseModel):
    channels: list[MmChannelResponse]
    total: int
    inter_agent_mode_enabled: bool = False
    snoozed: bool = False
    inter_agent_message_limit: int = 10
    default_model: str | None = None
    default_thinking: str | None = None


class MmDiscoverableChannelResponse(BaseModel):
    channel_id: str
    org_id: str | None = None
    name: str
    display_name: str | None = None
    channel_type: str
    created_at: str
    member_count: int = 0
    avatar: AvatarRef | None = None


class MmDiscoverableChannelListResponse(BaseModel):
    channels: list[MmDiscoverableChannelResponse]
    total: int


class MmAdminChannelResponse(BaseModel):
    """A row of the org-admin channel list: never a DM."""
    channel_id: str
    org_id: str | None = None
    name: str
    display_name: str | None = None
    channel_type: str
    created_at: str
    created_by_human: int | None = None
    last_message_at: str | None = None
    last_message_text: str | None = None
    member_count: int = 0
    avatar: AvatarRef | None = None
    lobstertalk_approved: bool = False


class MmAdminChannelListResponse(BaseModel):
    channels: list[MmAdminChannelResponse]
    total: int


class MmChannelMembersListResponse(BaseModel):
    members: list[MmChannelMemberResponse]
    total: int
    channel_deleted: bool = False


class MmPostListResponse(BaseModel):
    posts: list[MmPostResponse]
    # The size of this page, not the channel's post count: page on ``has_more``.
    total: int
    limit: int
    offset: int
    # Forward-cursor reads only: stop paging early and the newest backlog is lost.
    has_more: bool = False


class MmSearchAuthor(BaseModel):
    """Author of a search hit; ``kind`` says which id is set."""
    kind: MemberKind
    human_id: int | None = None
    agent_id: str | None = None
    display_name: str | None = None
    avatar: AvatarRef | None = None


class MmSearchResult(BaseModel):
    """A search hit with channel context. ``snippet`` wraps matches in ``<mark>`` with the rest
    HTML-escaped (plain for typo-fallback hits); ``rank`` is opaque."""
    post_id: int
    channel_id: str
    channel_display_name: str | None = None
    channel_type: str
    created_at: str
    author: MmSearchAuthor
    snippet: str
    rank: float


class MmSearchResponse(BaseModel):
    results: list[MmSearchResult] = Field(default_factory=list)
    next_cursor: str | None = None
    query: str
    sort: str


class MmAgentSearchResponse(MmSearchResponse):
    """Agent search response. ``scope`` echoes the retrieval surface applied:
    ``all_channels``, ``public_channels`` or ``context_and_public``."""

    scope: str


class MmFileListResponse(BaseModel):
    """Channel attachments page. Pass ``next_cursor`` back as ``before_file_id``; ``offset``
    is echoed for offset paging; ``total`` is set only with ``include_total=true``."""
    files: list[MmFileResponse]
    limit: int
    has_more: bool
    next_cursor: str | None = None
    offset: int | None = None
    total: int | None = None


class MmLinkItem(BaseModel):
    """A URL from a chat message; unfurl it with ``POST /api/human/mm/link-preview``."""
    url: str
    post_id: int
    post_created_at: str


class MmLinkListResponse(BaseModel):
    """Distinct URLs from message bodies, freshest occurrence first. ``next_cursor`` is the
    last scanned post, to pass back as ``before_post_id``; there is no total."""
    links: list[MmLinkItem]
    limit: int
    has_more: bool
    next_cursor: int | None = None
    offset: int | None = None


class SkillStateReportRequest(BaseModel):
    """Agent self-report of the skills on disk. ``report_mode='observe'`` means the client
    cannot write, so the server must not advance desired state from it."""

    model_config = ConfigDict(extra="ignore")
    report_mode: str | None = None
    plugin_version: str | None = None
    runtime: str | None = None
    runtime_version: str | None = None
    skills_root: str | None = None
    scanned_roots: list[str] = Field(default_factory=list)
    apply_mode: str | None = None
    prompt_chars_observed: int | None = None
    prompt_budget_observed: int | None = None
    truncated: bool = False
    skills: list[dict[str, Any]] = Field(default_factory=list)


class SkillStateReportResponse(BaseModel):
    """Ack for a skills self-report. ``truncated`` means the server dropped a tail."""

    ok: bool = True
    schema_version: str
    seen: int = 0
    mirrored: int = 0
    truncated: bool = False


class SkillDesiredResponse(BaseModel):
    """The desired skill set the plugin reconciles to. Index only: bodies are fetched per
    version, and only when the local hash differs."""

    schema_version: str
    paused: bool = False
    desired_generation: int = 0
    skills: list[dict[str, Any]] = Field(default_factory=list)


class SkillVersionContentResponse(BaseModel):
    """One version's files, with SKILL.md rendered for the caller's runtime."""

    version_id: str
    content_hash: str
    files: list[dict[str, Any]] = Field(default_factory=list)


class ModelOption(BaseModel):
    """A model the agent's engine can call: ``ref`` exactly as the engine takes it, with the
    thinking levels it accepts."""

    ref: str
    provider: str
    name: str
    levels: list[str]
    default_level: str | None = None


class ModelStateReportRequest(BaseModel):
    """Agent self-report of its model catalog and runtime default. Over the cap is a 422,
    never a truncation."""

    model_config = ConfigDict(extra="ignore")
    models: list[ModelOption] = Field(max_length=2000)
    default_model: str | None = None
    default_thinking: str | None = None


class ModelStateReportResponse(BaseModel):
    changed: bool


class AgentModelsResponse(BaseModel):
    """``models`` is ``None`` until the agent reports a catalog."""

    models: list[ModelOption] | None
    runtime_default: ModelChoice | None
    default: ModelChoice
    reported_at: datetime | None


class SetAgentModelRequest(BaseModel):
    """The agent default when ``channel_id`` is ``None``, else that conversation's choice."""

    model_config = ConfigDict(extra="forbid")
    channel_id: str | None = None
    model: str | None = None
    thinking: str | None = None
