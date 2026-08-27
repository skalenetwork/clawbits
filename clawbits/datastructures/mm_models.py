"""Mattermost-style messaging data models."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from clawbits.datastructures.avatar_models import AvatarRef

# ---------------------------------------------------------------------------
# Shared literal types — single source of truth for presence + event names.
# ---------------------------------------------------------------------------

AgentPresenceStatus = Literal["online", "idle", "typing", "generating", "offline"]
# Global online/idle/offline for a human user. Drives avatar dots on
# DM rows and channel member lists. Per-channel ephemeral state for
# humans is now limited to "typing" (still on the ``member.status``
# stream — see the typing endpoint).
GlobalUserStatus = Literal["online", "idle", "offline"]
# Global liveness for an AGENT, derived from ``Agent.last_alive_at`` (the last
# time the agent's plugin pinged ``POST /api/agentic/alive``). This is the
# agent analogue of a human's online/offline dot — distinct from the per-channel
# ``AgentPresenceStatus`` above, which is the transient typing/generating hint
# during an active turn. "setup" = never pinged (still onboarding);
# "available" = pinged within ``AGENT_OFFLINE_AFTER``; "offline" = beyond it.
AgentLivenessStatus = Literal["setup", "available", "offline"]
MemberKind = Literal["agent", "human"]


def agent_dm_channel_name(human_id: int, agent_id: str) -> str:
    """Canonical name for a human↔agent direct channel."""
    return f"dm-human-{human_id}-agent-{agent_id}"


RealtimeEventType = Literal[
    "post.created",
    "post.updated",
    "post.deleted",
    "member.status",
    "member.read",
    # Control event on the *channel* topic naming who just lost access, so a
    # live subscriber can be cut off the moment it happens. Distinct from
    # ``channel.removed`` (personal topic, drives the sidebar) and from the
    # ``channel.event`` timeline row, which is suppressed on DMs and so
    # cannot carry this. Clients other than the streams ignore it.
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
    # Per-agent control: nudges the agent's plugin to reconcile its
    # automations (cron) against Clawbits' desired set. Carries the current
    # desired_generation; the plugin pulls /automations/desired on receipt.
    "automation.sync",
    # Connection-level (not bus-published): the first frame of the global
    # stream, carrying the server's version so a client on a stale bundle
    # can prompt a reload after a deploy.
    "server.hello",
]
MmPostStatus = Literal["streaming", "draft", "published", "rejected"]
# Inline channel timeline events (membership changes today, designed to
# absorb channel.renamed / topic.changed / archive / etc. without a wire
# change — extend the literal and the DB check constraint together).
MmChannelEventType = Literal["member.added", "member.removed"]

# How long after an agent's last alive-ping we keep showing it "available".
# The plugin pings every ~10 min (see plugin/src/liveness.ts), so 40 min
# tolerates ~4 consecutive missed pings (clock skew, a deferred beat, a brief
# gateway restart) before we flip the agent to "offline". Deliberately decoupled
# from OpenClaw's own 30/60-min LLM heartbeat — that's a model turn, not a
# liveness signal. Bump this and the plugin's ping interval together.
AGENT_OFFLINE_AFTER = timedelta(minutes=40)


def agent_liveness_status(
    last_alive_at: datetime | None,
    *,
    now: datetime | None = None,
) -> AgentLivenessStatus:
    """Derive an agent's global liveness from its last alive-ping timestamp.

    Single source of truth for the thresholds — used by the member-list read
    path and the ``/api/agentic/alive`` endpoint. ``last_alive_at is None``
    means the agent has never pinged and is still in setup; otherwise it's
    "available" within :data:`AGENT_OFFLINE_AFTER` of the last ping and
    "offline" beyond it. Naive timestamps (some DB drivers drop tzinfo) are
    assumed UTC so the arithmetic never raises.
    """
    if last_alive_at is None:
        return "setup"
    if now is None:
        now = datetime.now(UTC)
    if last_alive_at.tzinfo is None:
        last_alive_at = last_alive_at.replace(tzinfo=UTC)
    # Inclusive at the boundary: a ping exactly AGENT_OFFLINE_AFTER old still
    # reads "available" (40 min -> available; 40 min + 1s -> offline).
    return "available" if (now - last_alive_at) <= AGENT_OFFLINE_AFTER else "offline"


# ---------------------------------------------------------------------------
# Requests
# ---------------------------------------------------------------------------

class MmCreateChannelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    name: str = Field(min_length=1, max_length=64, description="Channel name (unique within org)")
    display_name: str | None = Field(default=None, max_length=128, description="Human-friendly display name")
    channel_type: Literal["public", "private"] = Field(default="public", description="Channel type")


class MmHumanCreateChannelRequest(BaseModel):
    """Human channel creation — requires org_id."""
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
    # ``streaming`` and ``draft`` posts may start empty — ``streaming`` will be
    # filled by the agent via PATCH; ``draft`` will be flipped to ``published``
    # by the owner via /approve.
    message: str = Field(default="", max_length=4000, description="Message content")
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
    # Pre-uploaded attachments to bind to this post. Each id must reference
    # an ``mm_files`` row owned by the caller, ``status='uploaded'``, not yet
    # attached to a post, in the same channel as this one. Enforced atomically
    # at create time; rejection rolls the post back.
    file_ids: list[str] = Field(
        default_factory=list,
        max_length=20,  # hard upper bound; soft limit is MM_FILES_MAX_PER_POST
        description="Pre-uploaded mm_files ids to attach to this post.",
    )
    # Echoed back on the create response and the post.created SSE event so
    # optimistic clients can dedupe between their local temp post and the
    # server-fanned-out one without relying on content fingerprinting.
    # Not persisted; lives only on the in-flight response/event.
    client_msg_uuid: str | None = Field(
        default=None,
        max_length=64,
        description="Client-generated id echoed back on response and SSE for optimistic-send dedupe.",
    )
    # End-to-end latency trace id (``tr_<uuid>``). Minted by the originating
    # client on a human send and re-stamped by the agent onto its reply, so
    # one id spans the whole round-trip. Unlike ``client_msg_uuid`` this IS
    # persisted (the agent reads it back off the inbound post via a separate
    # GET). Omitted by clients that aren't tracing — defaults to None.
    trace_id: str | None = Field(
        default=None,
        max_length=64,
        description="End-to-end latency trace id, persisted and re-stamped onto the agent's reply.",
    )

    @model_validator(mode="after")
    def _require_message_unless_streaming(self) -> MmPostRequest:
        # Drafts are typically created with the full message (the agent has
        # already produced its reply and is awaiting approval). Only the
        # streaming path may legitimately start empty. Attaching files
        # counts as content — a post with files needs no message text.
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


# ---------------------------------------------------------------------------
# Responses
# ---------------------------------------------------------------------------

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
    # Newest published post id in this channel, or None when it has none.
    # Filled by the agent channel-list read so a reconnecting agent can tell
    # which channels moved while it was offline and skip the quiet ones
    # without a posts GET each. A monotonic serial, so it is also the value to
    # pass back as ``after_post_id``. Left None by the human paths, which
    # already carry unread counts.
    latest_post_id: int | None = None
    # The caller's own read pointer in this channel — humans from
    # ``HumanChannelState``, agents from ``AgentChannelState``. For agents
    # this is the restart resume point: ``None`` means "no pointer yet"
    # (treat as first boot — seed to newest, then ack); otherwise drain
    # ``posts?after_post_id=<this>`` to read exactly the offline gap.
    # Filled by the list endpoints; single-channel endpoints leave it None.
    last_read_post_id: int | None = None
    # Unread / mute state from the caller's perspective (both the human and
    # the agent list endpoints fill unread_count / unread_mention_count;
    # mute/pin stay human-only). Defaults mean "no state": single-channel
    # endpoints leave them untouched.
    unread_count: int = 0
    # Subset of ``unread_count`` whose posts address the caller — directly
    # (``@<handle>``) or channel-wide (``@here``). Drives the sidebar's
    # accent "mentioned" badge (which pierces mute). Filled by the list
    # endpoint; single-channel endpoints leave it at 0.
    unread_mention_count: int = 0
    muted: bool = False
    # Per-user pin flag from ``HumanChannelState``. True means the user has
    # pinned this channel — the sidebar renders it in a dedicated "Pins"
    # section above Channels/DMs (and excludes it from those sections so
    # it never appears twice). Single-channel endpoints leave this at the
    # default of ``False`` since pin state is only meaningful in a list.
    pinned: bool = False
    # Denormalised preview of the latest published post — drives the
    # Telegram-style sidebar row. Author identity is a snapshot at post
    # time so renames don't backfill.
    last_message_text: str | None = None
    last_message_author_human_id: int | None = None
    last_message_author_agent_id: str | None = None
    last_message_author_display_name: str | None = None
    # Resolved avatar for the last-message author so the sidebar can
    # render the tiny preview tile without an extra lookup. Built per
    # request from the author id — not snapshotted on the channel row,
    # so renames / re-rolls show up live.
    last_message_author_avatar: AvatarRef | None = None
    # Count of uploaded files on the latest published post. Drives the
    # paperclip indicator in sidebar / chats-list previews so users can
    # see at a glance that a conversation contains attachments without
    # opening it. Zero (default) when the channel is empty or the last
    # message is text-only.
    last_message_attachment_count: int = 0
    # On a direct channel with another human, the peer's user id; on a
    # direct channel with an agent, the peer agent id. Filled in by
    # ``apply_dm_peer_display``; absent for group/public channels. Lets the
    # sidebar render the peer's presence dot and the command palette dedupe a
    # DM against its People/Agents entry, without fetching the member list.
    dm_peer_human_id: int | None = None
    dm_peer_agent_id: str | None = None
    # Generated channel avatar — see :mod:`clawbits.avatars`. Defaults
    # to None so older response paths that haven't been re-plumbed yet
    # still validate; the frontend falls back to its initial-letter
    # placeholder when the field is missing.
    avatar: AvatarRef | None = None


class MmChannelMemberResponse(BaseModel):
    agent_id: str | None = None
    human_id: int | None = None
    display_name: str | None = None
    joined_at: str
    # Global presence — only populated for human members. Seeded from
    # Redis on the list endpoint so the UI has a value to render before
    # the first SSE update arrives.
    status: GlobalUserStatus | None = None
    last_seen_at: str | None = None
    # Bucketed last-seen string when the member hid their precise
    # timestamp (see ``MmUserPresenceResponse.last_seen_label``). Null
    # when the precise timestamp is exposed in ``last_seen_at``.
    last_seen_label: str | None = None
    # Member avatar — points at the user's or agent's R2-stored SVG.
    # See :mod:`clawbits.avatars` for the URL scheme.
    avatar: AvatarRef | None = None
    # Read pointer — human members from ``HumanChannelState``, agent
    # members from ``AgentChannelState`` (the agent acks it when a turn
    # settles; it doubles as the agent's restart resume point). Drives
    # outgoing-message read receipts: the UI shows "Read" under the
    # latest outgoing post whose ``post_id`` is ≤ every other member's
    # ``last_read_post_id``. Null when the member has never opened /
    # acked the channel (e.g., they were just added) or — humans only —
    # has read receipts disabled in their privacy settings.
    last_read_post_id: int | None = None
    # Global agent liveness — only populated for AGENT members (None for
    # humans, who use ``status`` / ``last_seen_at`` above). ``agent_status`` is
    # the server's snapshot at read time; ``last_alive_at`` is the raw last-ping
    # timestamp so the client can re-derive available->offline locally on a
    # timer (the dot flips at the 40-min mark without a re-fetch). See
    # ``agent_liveness_status``.
    agent_status: AgentLivenessStatus | None = None
    last_alive_at: str | None = None
    # Per-viewer contact gate — only populated for AGENT members on the human
    # members endpoint. True when the requesting human may ``@``-tag this agent
    # (contact is closed by default). ``None`` for human members / endpoints
    # that don't compute it; the UI treats missing as "allowed" for back-compat.
    can_tag: bool | None = None


class MmReactionRequest(BaseModel):
    """Toggle-style reaction request — POST with the emoji to add or remove.

    The server checks whether the caller already reacted with this emoji on
    this post; if so, the row is deleted, otherwise inserted. Same shape
    for human and agent callers.
    """
    model_config = ConfigDict(extra="forbid", frozen=True)
    emoji: str = Field(min_length=1, max_length=32, description="Unicode emoji glyph")


class MmPostReactionAggregate(BaseModel):
    """One row per distinct emoji on a post — count + the member sets.

    The frontend derives ``reacted_by_me`` by checking whether the caller's
    own id appears in ``human_ids`` / ``agent_ids``. Keeping this server-
    agnostic (no per-viewer flag) lets a single SSE envelope fan out to
    every channel member without per-recipient rewriting.
    """
    emoji: str
    count: int
    human_ids: list[int] = Field(default_factory=list)
    agent_ids: list[str] = Field(default_factory=list)


class MmPostEditRequest(BaseModel):
    """PATCH body for editing the *text* of a previously-published post.

    Author check + status check (must be ``published``) are enforced
    server-side. Empty messages are rejected here at the schema level —
    Slack-style "edit to empty == delete" is intentionally not supported
    in v1 to keep the surface narrow.
    """
    model_config = ConfigDict(extra="forbid", frozen=True)
    message: str = Field(min_length=1, max_length=4000, description="New message text")


class MmPostParentPreview(BaseModel):
    """Inline-reply quote-block payload, snapshotted at read time.

    Lets the UI render "Replying to <author>: <excerpt>" without a second
    fetch. ``message_excerpt`` is truncated server-side so the payload
    stays bounded even when the parent is a 4000-char post. ``status`` is
    included so the client can degrade gracefully when the parent was
    rejected (renders as "Original message removed").

    ``attachment_count`` is the number of uploaded files on the parent.
    A post is allowed to carry files with no text at all, so without it
    the quote-block had no way to tell "attachment-only message" from
    "genuinely blank" and rendered a misleading "(empty message)".
    """
    post_id: int
    agent_id: str | None = None
    human_id: int | None = None
    poster_display_name: str | None = None
    message_excerpt: str
    status: MmPostStatus
    attachment_count: int = 0


MmFileStatus = Literal["pending", "uploaded", "failed", "deleted"]


class MmFileUploadRequest(BaseModel):
    """Client → server: "I want to upload this file."

    The server creates an ``mm_files`` row (status=pending) and returns
    a presigned PUT URL the client uses to push the bytes directly to R2.
    ``content_type`` and ``size_bytes`` are pinned at presign time — the
    PUT signature includes both, so a client that lies about either is
    rejected by R2 at upload time (not just at confirm).
    """
    model_config = ConfigDict(extra="forbid", frozen=True)
    filename: str = Field(min_length=1, max_length=255)
    content_type: str = Field(min_length=1, max_length=255)
    size_bytes: int = Field(gt=0, description="File size in bytes; capped server-side")
    # Optional client-computed SHA256 of the original bytes; used on
    # ``/confirm`` for integrity check and future dedup.
    sha256: str | None = Field(default=None, min_length=64, max_length=64)
    # Set to True if the client will upload a thumbnail JPEG alongside the
    # original (image files only). Server presigns a second PUT URL for it.
    has_thumbnail: bool = False
    # Required when ``has_thumbnail=True`` — the thumbnail PUT signature
    # pins ``Content-Length`` to this value, same as the original.
    thumbnail_size_bytes: int | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def _validate_filename_and_thumbnail(self) -> MmFileUploadRequest:
        # Control characters (CR, LF, NUL, etc.) in a filename would leak
        # into the ``response-content-disposition`` header we set on the
        # download URL and the ``alt`` text rendered in the UI. Strip the
        # exposure at the API boundary instead of every consumer.
        if any(ord(c) < 0x20 or ord(c) == 0x7F for c in self.filename):
            raise ValueError("filename contains control characters")
        if self.has_thumbnail and self.thumbnail_size_bytes is None:
            raise ValueError(
                "thumbnail_size_bytes is required when has_thumbnail=True"
            )
        return self


class MmFileUploadResponse(BaseModel):
    """Server → client: file row reserved, here are the URLs to PUT to.

    The client MUST send ``headers`` exactly as returned with each PUT —
    every signed header is part of the signature.
    """
    file_id: str
    upload_url: str
    upload_headers: dict[str, str]
    upload_expires_in: int
    object_key: str
    # Present only when the request had ``has_thumbnail=True``. The
    # client should PUT a 1024px JPEG here in parallel with the original.
    thumbnail_upload_url: str | None = None
    thumbnail_upload_headers: dict[str, str] | None = None
    thumbnail_object_key: str | None = None


class MmFileConfirmRequest(BaseModel):
    """Client → server: "I finished uploading."

    The server flips the row to ``status='uploaded'``, records any
    metadata the client computed (dimensions, duration, hash), and stamps
    ``uploaded_at``. Idempotent — a duplicate confirm is a no-op.
    """
    model_config = ConfigDict(extra="forbid", frozen=True)
    width: int | None = Field(default=None, ge=1)
    height: int | None = Field(default=None, ge=1)
    duration_ms: int | None = Field(default=None, ge=0)
    sha256: str | None = Field(default=None, min_length=64, max_length=64)
    # The client set ``has_thumbnail=True`` at upload-url time and now
    # confirms the thumbnail PUT also succeeded. False means "I tried but
    # the thumb upload failed" — the row keeps thumbnail_object_key NULL.
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
    # Presigned GET URL, valid for ~1h. The post-read path inlines this
    # for images so they render without a second round trip; for other
    # types the client requests it on demand via ``/files/{id}/url``.
    download_url: str | None = None
    # Unix epoch seconds when ``download_url`` stops being valid on R2.
    # The server may return a URL that was cached for a while, so this is
    # how the client knows the *real* remaining lifetime, not just "ttl
    # from when I received the payload."
    download_url_expires_at: int | None = None
    # Presigned GET for the 1024px thumbnail. NULL for non-image files.
    thumbnail_url: str | None = None
    thumbnail_url_expires_at: int | None = None
    # Uploader identity + source message. Surfaced by the channel
    # attachments listing so the history UI can show "shared by …" and link
    # back to the originating post. Null on the upload-confirm response
    # (the file isn't bound to a post yet).
    uploader_human_id: int | None = None
    uploader_agent_id: str | None = None
    post_id: int | None = None


class MmFileDownloadUrlResponse(BaseModel):
    url: str
    expires_in: int
    expires_at: int


class MmPostLinkPreviewEmbedded(BaseModel):
    """Server-resolved OG card embedded on a post at create/edit time.

    Eliminates the asynchronous client-side unfurl that previously made
    the message row resize when the response landed. Shape mirrors
    :class:`clawbits.link_preview.service.LinkPreview` plus a ``cap``
    indicator the client can use to surface "1 of N previews" UI if it
    ever needs to.

    ``url`` is required so the client can still link out even if the
    fetch produced no parseable metadata. The other fields are optional;
    a card with only ``site_name``/``canonical_url`` populated may still
    render as a thin domain chip.
    """
    url: str
    canonical_url: str | None = None
    title: str | None = None
    description: str | None = None
    image_url: str | None = None
    site_name: str | None = None
    fetched_at: float | None = None
    error: str | None = None
    # Number of URLs in the message that were skipped (server only
    # resolves the first one). ``0`` means "this was the only URL".
    skipped: int = 0


class MmPostResponse(BaseModel):
    post_id: int
    channel_id: str
    agent_id: str | None = None
    human_id: int | None = None
    poster_display_name: str | None = None
    # Avatar of the post author (human or agent). None on legacy paths
    # that have not been rewired yet — frontend degrades to its
    # initial-letter fallback when the field is missing.
    avatar: AvatarRef | None = None
    message: str
    created_at: str
    status: MmPostStatus = "published"
    updated_at: str | None = None
    # ISO timestamp of the most recent user-visible edit; ``None`` means
    # the post has never been edited. Drives the "(edited)" marker.
    edited_at: str | None = None
    # ISO timestamp of the moment this post was pinned to its channel;
    # ``None`` means the post is not currently pinned. Drives the small
    # pin glyph next to the timestamp and inclusion in the pinned-
    # messages popover.
    pinned_at: str | None = None
    pinned_by_human_id: int | None = None
    parent_post_id: int | None = None
    parent_preview: MmPostParentPreview | None = None
    # Server-resolved OG card for the first shareable URL in the message.
    # ``None`` when the message has no URL, the fetch failed irrecoverably,
    # or the post predates the server-side unfurl path (legacy reads).
    # When ``None`` on a post with URLs in the body, the frontend falls
    # back to its client-side ``useLinkPreview`` hook.
    link_preview: MmPostLinkPreviewEmbedded | None = None
    reactions: list[MmPostReactionAggregate] = Field(default_factory=list)
    files: list[MmFileResponse] = Field(default_factory=list)
    # Echoed back from MmPostRequest.client_msg_uuid only on the synchronous
    # create response and the post.created SSE event. Never set on reads.
    client_msg_uuid: str | None = None
    # End-to-end latency trace id. Persisted (see MmPost.trace_id), so unlike
    # ``client_msg_uuid`` it IS populated on reads too — that's how the agent
    # poller reads the inbound post's id and re-stamps it onto the reply.
    trace_id: str | None = None


class MmChannelEventResponse(BaseModel):
    """A non-message channel-timeline event (member added/removed today).

    Renders inline in the channel feed as a centered, non-interactive
    line. The frontend picks the user-visible string from
    ``event_type`` + the identity of ``subject_*`` relative to
    ``actor_*``: NULL subject means actor acted on themselves (renders
    as "joined"/"left"), set subject means actor acted on someone else
    (renders as "added X"/"removed X").

    Display names and avatars are resolved server-side at response-build
    time so the client never has to do FK lookups, and historical events
    keep showing the right names even if a user's display name later
    changes (snapshot semantics)."""
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
    # Event-type-specific payload. Always ``None`` for ``member.*``;
    # reserved for future event types that need to carry diff-like data
    # (e.g. ``channel.renamed`` → ``{"old_name": ..., "new_name": ...}``).
    payload: dict | None = None
    created_at: str


class MmHistoryRow(BaseModel):
    """One row in the merged channel history stream.

    Exactly one of ``post`` / ``event`` is set, matching the ``kind``
    discriminator. The frontend renders ``post`` rows via the message
    bubble component and ``event`` rows via the centered system-message
    component. Server-side merge guarantees the rows are correctly
    chronologically ordered across both sources without the client
    having to merge."""
    kind: Literal["post", "event"]
    post: MmPostResponse | None = None
    event: MmChannelEventResponse | None = None


class MmChannelEventListResponse(BaseModel):
    """Flat list of channel events, newest first. Used by clients that
    want events as a parallel stream alongside the existing posts
    endpoint rather than via the merged timeline."""
    events: list[MmChannelEventResponse]
    total: int


class MmTimelineResponse(BaseModel):
    """Page of merged channel timeline rows, newest first.

    ``next_cursor`` is an opaque ISO-8601 timestamp string (full
    microsecond precision) that the client echoes back as
    ``?before_created_at=`` to fetch the next older page. ``None``
    when ``has_more`` is false, meaning the caller has reached the
    start of the channel."""
    rows: list[MmHistoryRow]
    has_more: bool
    next_cursor: str | None = None


class MmExportMember(BaseModel):
    """One member row in a conversation export — identity only.

    Deliberately narrower than :class:`MmChannelMemberResponse`: presence,
    last-seen and read pointers are per-viewer, privacy-gated signals, and an
    export is a file the caller keeps and can pass on. Baking another member's
    ``last_seen_at`` or ``last_read_post_id`` into it would leak a signal they
    may have switched off, with none of the runtime gating that strips it from
    the live member list."""
    agent_id: str | None = None
    human_id: int | None = None
    display_name: str | None = None
    joined_at: str


class MmChannelExportResponse(BaseModel):
    """A full downloadable archive of one conversation — channel or DM.

    Served as an attachment by ``GET /channels/{id}/export``. Unlike every
    other read path, ``posts`` is **oldest-first**: an archive is read top to
    bottom, and appending is how a future incremental export would extend it.

    Visibility matches the channel history endpoint exactly (it is the same
    read helper), so drafts and rejected posts appear only for the caller who
    may already see them in the UI. Attachments are metadata only — filename,
    size, type, and originating post — with no presigned URLs: those expire in
    about an hour, so embedding them would make the archive look like it
    carried the files while shipping links that are dead by the time anyone
    opens it. The file bytes stay in the channel.

    ``truncated`` is true when the conversation is longer than
    ``MAX_EXPORT_POSTS``; in that case the newest ``post_count`` posts are
    included and the older tail is omitted rather than silently dropped."""
    export_version: int = 1
    exported_at: str
    exported_by_human_id: int
    channel: MmChannelResponse
    members: list[MmExportMember]
    # Oldest-first, unlike the newest-first read endpoints.
    posts: list[MmPostResponse]
    # Membership events (joins/leaves), oldest-first, interleaved by
    # timestamp with ``posts`` when read as a transcript.
    events: list[MmChannelEventResponse]
    post_count: int
    truncated: bool = False


class MmPinnedListResponse(BaseModel):
    """List of currently-pinned posts in a channel, newest-pinned first.

    Drives the header pinned-messages popover. Returns the full pin
    history regardless of how far back the timeline the messages are —
    pinned messages older than the loaded scroll window must still show
    up in the popover."""
    posts: list[MmPostResponse]
    total: int


class MmPostPatchRequest(BaseModel):
    """Agent-only request to mutate a streaming post while producing a reply.

    Either ``append`` (concatenate to current message) or ``replace``
    (overwrite the entire message body) must be supplied — not both.
    Setting ``done`` finalises the stream: ``status`` flips to ``published``
    (or ``draft`` if the agent's owner requires approval) and further
    PATCHes will be rejected.

    Setting ``cancel`` deletes the streaming row outright. Use this when
    the runner decided not to reply (silent reply) so the channel UI
    doesn't render an empty post placeholder. ``cancel`` is mutually
    exclusive with append/replace/done.
    """
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


# Defensive display clamps for agent-reported activity (LIVE_AGENT_ACTIVITY
# plan: "server truncates defensively"). Clamped, never rejected - the agent
# lane must stay forgiving for telemetry-class payloads.
#
# This is a BACKSTOP, not the primary limit: the plugin's in-VM sanitizer
# (plugin/src/activity/sanitize.ts) is the real choke point and caps the tool
# summary and the thinking tail at 1000 chars each. This value must stay ABOVE
# the largest label that sanitizer can emit, or the server silently re-truncates
# what the VM already deemed safe to send. Worst case there is
# ``<tool>: '<snippet>'`` = ACTIVITY_TOOL_MAX_CHARS + 4 + 1000 = 1068, so 1200
# leaves headroom for a future bump on the plugin side without a matching
# server deploy. Raised from 160 with the plugin caps (owner decision,
# 2026-08-11) so the UI can show what an agent actually ran.
ACTIVITY_LABEL_MAX_CHARS = 1200
ACTIVITY_TOOL_MAX_CHARS = 64


class MmAgentActivity(BaseModel):
    """Transient description of what an agent is doing mid-turn.

    Carried on the status lane (never persisted): the plugin reports a
    sanitized label ("Using web_search: 'skale gas price'", a thinking
    snippet) and the UI renders it in the generating shimmer. Values are
    agent-reported display data - the server clamps lengths defensively
    but treats content as opaque. See LIVE_AGENT_ACTIVITY_PLAN.md §5.2.

    ``extra="ignore"`` (not the mm-lane ``forbid``): this is a telemetry
    payload from a fleet of plugin versions - a newer plugin sending a
    field this server doesn't know yet must degrade, not 422.
    """
    model_config = ConfigDict(extra="ignore", frozen=True)
    kind: Literal["generating", "thinking", "tool", "tool_done"]
    label: str = ""
    tool: str | None = None
    ok: bool | None = None
    duration_ms: int | None = Field(default=None, ge=0)

    @field_validator("label", mode="before")
    @classmethod
    def _clamp_label(cls, v: object) -> str:
        if not isinstance(v, str):
            return ""
        return v[:ACTIVITY_LABEL_MAX_CHARS]

    @field_validator("tool", mode="before")
    @classmethod
    def _clamp_tool(cls, v: object) -> str | None:
        if v is None or not isinstance(v, str):
            return None
        return v[:ACTIVITY_TOOL_MAX_CHARS] or None


class MmAgentStatusRequest(BaseModel):
    """Agent realtime-status update.

    ``typing`` is a hint for human-style conversational feedback;
    ``generating`` is an agent-specific state the OpenClaw plugin sets
    while a reply is in flight. ``activity`` optionally says *what* the
    agent is doing (thinking / running a tool) - transient, TTL'd with
    the presence entry, never stored in the DB.

    ``extra="ignore"`` so a newer plugin never 422s against this server.
    """
    model_config = ConfigDict(extra="ignore", frozen=True)
    status: AgentPresenceStatus
    activity: MmAgentActivity | None = None


class MmUserPresenceRequest(BaseModel):
    """Global presence heartbeat — drives the avatar dot in sidebars and
    member lists. ``offline`` is the explicit on-unload tombstone; the
    Redis TTL handles the silent-tab-closed case."""
    model_config = ConfigDict(extra="forbid", frozen=True)
    status: GlobalUserStatus


class MmUserPresenceResponse(BaseModel):
    human_id: int
    status: GlobalUserStatus
    last_seen_at: str | None = None
    # Telegram-style bucketed last-seen string, populated only when the
    # target user has hidden their precise last-seen. One of "recently",
    # "within a week", "within a month", "a long time ago". When set,
    # ``last_seen_at`` is null and clients should render this string
    # prefixed with "Last seen ".
    last_seen_label: str | None = None


class MmAgentAliveRequest(BaseModel):
    """Optional body for an agent's ``POST /api/agentic/alive`` liveness ping.

    The plugin self-reports its runtime kind here (``"openclaw"`` |
    ``"ironclaw"``); the plugin version rides the ``X-Clawbits-Plugin-Version``
    header instead. Every field is optional and extra keys are ignored, so an
    older plugin that POSTs an empty body (or no body at all) still validates.
    The agent is identified by its bearer key — any agent id in the body is
    ignored."""

    model_config = ConfigDict(extra="ignore")
    agent_type: str | None = None


class MmAgentAliveResponse(BaseModel):
    """Response to an agent's ``POST /api/agentic/alive`` liveness ping.

    Echoes the freshly-stored timestamp and the derived status (always
    "available" right after a successful ping) plus the window length, so the
    plugin can log/verify and could self-tune its cadence later. The optional
    request body (:class:`MmAgentAliveRequest`) carries self-reported metadata;
    the agent is identified by its bearer API key."""
    status: AgentLivenessStatus
    last_alive_at: str
    offline_after_seconds: int


# ---------------------------------------------------------------------------
# Automations sync (agent self-report + desired-set fetch)
# ---------------------------------------------------------------------------


class AutomationStateReportRequest(BaseModel):
    """Agent self-report of its local cron state (telemetry-class, billing-exempt).

    ``managed`` items echo Clawbits-authored jobs (keyed by ``automation_id``);
    ``external`` items are jobs the agent created itself (keyed by
    ``gateway_job_id``, mirror-only); ``runs`` is a bounded projection of recent
    ``CronRunLogEntry`` rows. Extra keys are ignored so the plugin can evolve
    the payload without breaking an older server. The agent is identified by its
    bearer key — any agent id in the body is ignored."""

    model_config = ConfigDict(extra="ignore")
    openclaw_version: str | None = None
    plugin_version: str | None = None
    managed: list[dict[str, Any]] = Field(default_factory=list)
    external: list[dict[str, Any]] = Field(default_factory=list)
    runs: list[dict[str, Any]] = Field(default_factory=list)


class AutomationStateReportResponse(BaseModel):
    """Ack for a self-report: the server's current desired generation so the
    plugin can tell whether it is converged, plus how many runs were stored."""

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
    # Run-now: the plugin runs the job once when run_requested > run_observed.
    run_requested_generation: int = 0
    run_observed_generation: int = 0


class AutomationDesiredResponse(BaseModel):
    """The Clawbits-managed automations the plugin reconciles the local gateway
    cron to: ``present`` = ensure the job matches ``desired_spec``, ``absent`` =
    remove it. ``desired_generation`` is the agent-wide version of this set."""

    schema_version: str
    desired_generation: int
    automations: list[AutomationDesiredItem]


# ---------------------------------------------------------------------------
# AI-usage self-report (agent lane)
# ---------------------------------------------------------------------------


class UsageReportEvent(BaseModel):
    """One LLM call's token usage, as read inside the agent's own OpenClaw.

    ``event_id`` is the client idempotency key (hook ``runId:callId`` or a
    JSONL line hash); the server dedups on ``(agent, event_id)`` so
    at-least-once resends never double-count. Token counts are validated
    non-negative. ``cost_usd`` is a passthrough — present only for API-key
    sessions with provider pricing configured; Clawbits owns no pricing
    table (tokens-first). Extra keys are ignored so the plugin payload can
    evolve without breaking an older server."""

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
    """Agent self-report of recent LLM usage (telemetry-class, billing-exempt).

    Advisory numbers from the agent's own machine — observability, not
    metering; never an input to billing, quotas, or enforcement. The agent is
    identified by its bearer key — any agent id in the body is ignored.
    ``source`` declares which collector produced the events; an agent runs
    one source at a time (hook xor jsonl) because the two derive different
    ``event_id``s for the same call, so dedup cannot bridge them."""

    model_config = ConfigDict(extra="ignore")
    plugin_version: str | None = None
    openclaw_version: str | None = None
    source: Literal["hook", "jsonl"] = "hook"
    events: list[UsageReportEvent] = Field(default_factory=list)


class UsageReportResponse(BaseModel):
    """Ack for a usage report: how many events were newly stored, how many
    were dedup'd, and how many fell outside the accepted time window (older
    than retention, or beyond the future-skew bound). Rejections are counted,
    never silent."""

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
    """PATCH body for ``/api/human/privacy-settings``.

    Every field is optional — only the keys actually present are
    applied. This lets the client toggle one switch at a time without
    racing concurrent edits of the other three.
    """
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
    """Ask the server to unfurl a URL into an OpenGraph card. The URL is
    sent as-is; the server validates scheme + host before any network
    call. Failures come back with ``error`` set and the data fields
    null — clients can render a degraded card or hide it entirely."""
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


# ---------------------------------------------------------------------------
# List wrappers
# ---------------------------------------------------------------------------

class MmChannelListResponse(BaseModel):
    channels: list[MmChannelResponse]
    total: int
    # Agent-level settings surfaced here so polling clients can adapt without
    # a separate /info fetch.
    inter_agent_mode_enabled: bool = False
    snoozed: bool = False
    inter_agent_message_limit: int = 10


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
    """A channel row in the org-admin channels-management list.

    Subset of :class:`MmChannelResponse` plus ``member_count``. DMs are
    excluded by the listing endpoint, so this never carries DM-specific
    fields.
    """
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
    # Per-channel LobsterTalk allowlist state (closed by default) — drives the
    # approval toggles on Settings → LobsterTalk. Only ever true for public
    # channels; the approval endpoint refuses the rest.
    lobstertalk_approved: bool = False


class MmAdminChannelListResponse(BaseModel):
    channels: list[MmAdminChannelResponse]
    total: int


class MmChannelMembersListResponse(BaseModel):
    members: list[MmChannelMemberResponse]
    total: int
    # True when the removal that produced this response left the channel
    # with no human members and the server consequently hard-deleted it.
    # The members/total fields are empty in that case; clients use this
    # flag to switch their copy from "Left channel" to "Channel deleted"
    # and to drop the row instead of refetching members.
    channel_deleted: bool = False


class MmPostListResponse(BaseModel):
    posts: list[MmPostResponse]
    # NOTE: this is the size of THIS page, not the channel's post count. It has
    # always been ``len(posts)``; use ``has_more`` to decide whether to page.
    total: int
    limit: int
    offset: int
    # Only meaningful on a forward-cursor read (``after_post_id``): true when
    # more posts exist past this page. A resuming reader must keep paging while
    # this is true — stopping early silently drops the newest part of its own
    # backlog. Always false on the default newest-first read.
    has_more: bool = False


class MmSearchAuthor(BaseModel):
    """Author of a search hit. Exactly one of ``human_id`` / ``agent_id`` is
    set; ``kind`` says which."""
    kind: MemberKind
    human_id: int | None = None
    agent_id: str | None = None
    display_name: str | None = None
    avatar: AvatarRef | None = None


class MmSearchResult(BaseModel):
    """A single message-content search hit with channel context and a
    highlighted snippet."""
    post_id: int
    channel_id: str
    channel_display_name: str | None = None
    channel_type: str
    created_at: str
    author: MmSearchAuthor
    # Server-highlighted excerpt: matched terms wrapped in ``<mark>…</mark>``
    # by Postgres ``ts_headline`` (which HTML-escapes the rest of the text).
    # Empty/plain for trigram-fallback hits, which did not match exactly.
    snippet: str
    # ``ts_rank_cd`` for relevant sort, trigram ``similarity()`` for the
    # fallback. Opaque to the client; carried for stable ordering/debugging.
    rank: float


class MmSearchResponse(BaseModel):
    results: list[MmSearchResult] = Field(default_factory=list)
    # Opaque pagination token; pass back verbatim as ``cursor``.
    # ``None`` means there is no further page.
    next_cursor: str | None = None
    # The query as received, so the client can render "results for X".
    query: str
    # Sort mode actually applied: ``"recent"`` or ``"relevant"``.
    sort: str


class MmAgentSearchResponse(MmSearchResponse):
    """Agent-surface search response. ``scope`` echoes the context-derived
    retrieval surface actually applied — ``"all_channels"`` (operator-DM
    context), ``"public_channels"`` (public context), or
    ``"context_and_public"`` — so a runtime can tell what its query could
    see. It is a per-request guardrail, not a security boundary."""

    scope: str


class MmFileListResponse(BaseModel):
    """Channel-scoped file list for the chat-details "Media" / "Files" tabs.

    The list is paginated via an opaque cursor: clients pass back
    ``next_cursor`` from the previous response as ``before_file_id``
    on the next request. Offset is also supported for callers that
    want jump-to-page semantics, but cursor is preferred — it stays
    correct under concurrent inserts and is O(limit) at any depth,
    while offset becomes O(channel_total) past a few thousand rows.

    ``total`` is omitted (``None``) by default because counting at
    scale is O(channel_total) on every page. Callers that need a
    count for an initial render pass ``include_total=true`` on the
    first page only.
    """
    files: list[MmFileResponse]
    limit: int
    has_more: bool
    # ``file_id`` of the last item, suitable to pass back as
    # ``before_file_id``. ``None`` when ``has_more`` is false.
    next_cursor: str | None = None
    # Echoed back when the request used offset pagination so the
    # client can build the next URL without re-tracking state.
    offset: int | None = None
    # Total matching rows in the channel. Only set when the caller
    # asks for it via ``include_total=true`` — otherwise omitted to
    # keep page requests cheap on large channels.
    total: int | None = None


class MmLinkItem(BaseModel):
    """One URL extracted from a chat message. The client follows up with
    ``POST /api/human/mm/link-preview`` per ``url`` for OG metadata."""
    url: str
    post_id: int
    post_created_at: str


class MmLinkListResponse(BaseModel):
    """Channel-scoped list of distinct URLs harvested from message bodies,
    newest first. Dedup keeps only the freshest occurrence of each URL.

    Pagination uses ``before_post_id`` as an opaque cursor — same
    pattern as ``GET /channels/{id}/posts``. Each page scans up to
    ``_LINKS_SCAN_PAGE_MAX`` posts and emits up to ``limit`` distinct
    URLs; ``next_cursor`` is the ``post_id`` of the last *scanned*
    post (whether or not it contributed a URL), so the next page
    resumes from where this one stopped without re-walking history.

    ``total`` is intentionally absent: pre-counting requires
    extracting URLs from every message in the channel, which is the
    whole work this endpoint exists to chunk up. ``has_more`` reflects
    whether the underlying post scan saturated its window.
    """
    links: list[MmLinkItem]
    limit: int
    has_more: bool
    # ``post_id`` of the last scanned post, suitable to pass back as
    # ``before_post_id``. ``None`` when ``has_more`` is false.
    next_cursor: int | None = None
    offset: int | None = None



class SkillStateReportRequest(BaseModel):
    """Agent self-report of the skills present on disk (billing-exempt).

    ``report_mode='observe'`` is the safety contract: the client has no write
    path, so the server must not advance desired state from this report. The
    agent is identified by its bearer key; any agent id in the body is ignored.
    """

    model_config = ConfigDict(extra="ignore")
    report_mode: str | None = None
    plugin_version: str | None = None
    runtime: str | None = None
    runtime_version: str | None = None
    skills_root: str | None = None
    scanned_roots: list[str] = Field(default_factory=list)
    apply_mode: str | None = None
    # Early warning for OpenClaw's cap, past which it silently drops skills.
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
    """The desired skill set the plugin reconciles to. Index only — bodies are
    fetched per version, and only when the local hash differs."""

    schema_version: str
    paused: bool = False
    desired_generation: int = 0
    skills: list[dict[str, Any]] = Field(default_factory=list)


class SkillVersionContentResponse(BaseModel):
    """One version's files, with SKILL.md rendered for the caller's runtime."""

    version_id: str
    content_hash: str
    files: list[dict[str, Any]] = Field(default_factory=list)
