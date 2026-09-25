"""The Clawbits platform adapter: intake, dispatch, presence, delivery.

Everything with a lifecycle lives here — the poll/liveness/WebSocket loops,
the turn lifecycle hooks, status heartbeats, and outbound sends (text and
native images). Chat posts are admitted to the profile's durable journal
(:mod:`.inbox_state`) before they are dispatched, one automatic turn at a time
per chat. Mail is never a turn: :mod:`.mailroom`, started here once the journal
is open, owns it end to end. Pure helpers live in :mod:`.messages`, network-fetch
guarding in :mod:`.media`, and the CLI subprocess wrapper in :mod:`.cli_client`.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import importlib
import itertools
import json
import logging
import os
import re
import secrets
import time
from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    ProcessingOutcome,
    SendResult,
)
from gateway.session import SessionSource

from .account import bind_account, resolve_account, scoped_setting, unbind_account
from .attachments import cache_post_attachments
from .automations import hold_missed_slots, run_automations_reconciler
from .cli_client import _ClawbitsCli, _default_cli_path, http_status
from .health import HealthStatus, profile_name, run_status_writer, suspension_opted_in
from .inbox_state import (
    MAX_OPEN,
    InboxJournal,
    Item,
    JournalMigrationError,
    JournalTooNew,
    NewItem,
    Source,
    open_journal,
)
from .mailroom import Mailroom, bind_mailroom, unbind_mailroom
from .manifest import PLUGIN_VERSION
from .media import _download_to_tempfile
from .messages import (
    _Channel,
    _clawbits_channel_prompt,
    _context_line,
    _extract_channels,
    _extract_control_settings,
    _extract_files,
    _is_server_handled_command,
    _is_user_post,
    _message_id_from_response,
    _parent_post_id_from_metadata,
    _post_id,
    _post_sequence,
    _split_message_chunks,
    _trace_id_from_metadata,
)
from .read_cursors import load_read_cursors

logger = logging.getLogger(__name__)

DEFAULT_POLL_INTERVAL_SECONDS = 3.0
# Liveness heartbeat cadence. Clawbits flips an agent to "offline" after 40 min of
# silence, so this must stay comfortably inside that window; ~10 min matches the
# OpenClaw plugin (plugin/src/liveness.ts) and leaves room for a few failed pings.
DEFAULT_LIVENESS_INTERVAL_SECONDS = 600.0
# Cadence for re-asserting the "generating" presence pill during a turn. The
# server stores that status with a ~15s TTL (clawbits/realtime/bus.py
# STATUS_TTL_SECONDS), heartbeated by the client — so a single set at turn
# start lapses mid-turn on any slow model turn or tool call (image generation
# especially). Re-ping inside the TTL to keep the pill lit for the whole turn.
GENERATING_HEARTBEAT_INTERVAL_SECONDS = 10.0

# Framing for a LobsterTalk attention nudge — same wording as the OpenClaw
# plugin (plugin/src/agent-body.ts buildAttentionBlock), so both runtimes give
# the model an identical contract: the message wasn't addressed to it, a
# server-side triage step flagged it, and silence is an acceptable outcome.
_ATTENTION_PREAMBLE = (
    "[Attention]\n"
    "You were not directly mentioned. A triage step flagged the message below as\n"
    "one you might be able to help with. Reply only if you can add something\n"
    "genuinely useful right now; otherwise do not reply at all.\n"
    "[end Attention]"
)

_REPLY_CONTEXT_CAP = 2_000
# Lifetime of the cached operator identity (agent_info.operator_id plus the
# canonical operator DM) that gates gateway controls.
_OPERATOR_TTL_SECONDS = 300.0

# --- Chat intake ----------------------------------------------------------------
# Forward reads page ``after_post_id`` oldest first: at most this many pages of
# this size per channel per pass, with at most this many channels at once.
_PAGE_SIZE = 100
_PAGES_PER_PASS = 5
_DRAIN_CONCURRENCY = 4
# Historical items (admitted as backlog or while snoozed) are answered in
# consolidated turns of at most this many, the newest as the trigger and the
# rest (plus unaddressed chatter between them) as context lines.
_CATCH_UP_BATCH = 50
_CATCH_UP_CONTEXT_LINES = 50
_CATCH_UP_CONTEXT_CHARS = 400
# A channel first seen after the first full pass starts below its newest this-many posts.
_DISCOVERED_PAGE = 20
# Another author's post with one of these statuses is read again once it is published.
_UNSETTLED = ("streaming", "draft")
_HISTORICAL = ("backlog", "snoozed")
_CATCH_UP_HEADER = (
    "[Missed messages]",
    "These messages arrived in this channel while you were offline or snoozed and",
    "are still unanswered. The current message below is the newest one addressed",
    "to you; treat the list as context and fold anything still worth answering",
    "into your reply.",
)
# MessageEvent.metadata key tying a turn's hooks to the journal items it carries.
_DISPATCH_KEY = "clawbits_dispatch"
_DISPATCH_RETRY_SECONDS = 30.0
_LEGACY_POLICIES = ("review", "adopt", "new_only")
_DEFAULT_INTER_AGENT_MESSAGE_LIMIT = 10
_MAX_INTER_AGENT_MESSAGE_LIMIT = 50
_HUMAN_GUIDANCE_MESSAGE = "Nice, but need human guidance to proceed."
# The server clamps activity labels at ACTIVITY_LABEL_MAX_CHARS = 1200 — raised
# from 160 on purpose so the UI can show what an agent actually ran. Stay under
# it rather than re-imposing the old cut.
_ACTIVITY_LABEL_MAX_CHARS = 1000
# Tool names Hermes renders as "is using <tool>…"; anything else stays out of labels.
_TOOL_NAME_RE = re.compile(r"[A-Za-z0-9_.:-]{1,64}")
# The one live-status phrase whose preview may be shown (opt-in, redacted).
_WEB_SEARCH_PREFIX = "is searching the web for "
_REDACTION_UNAVAILABLE = "[redaction-unavailable]"
# An interim thinking bubble is a short status line. Anything longer is a real
# reply that happens to start with the emoji.
_MAX_INTERIM_BUBBLE_CHARS = 400
# Server cap on a streaming PATCH replace body (MmPostPatchRequest.replace).
_PATCH_REPLACE_MAX_CHARS = 40_000

# Drafts opened by the CURRENT turn. A ContextVar rather than a plain set
# because turns run concurrently in the same channel: each gateway processing
# task gets its own copy of the context (seeded in on_processing_start), so a
# finishing turn closes only its own drafts and never yanks a sibling turn's
# live stream out from under it.
_turn_streams: contextvars.ContextVar[set[str] | None] = contextvars.ContextVar(
    "clawbits_turn_streams", default=None
)


def _sanitize_activity(text: str) -> str:
    clean = re.sub(r"[\x00-\x1f\x7f]+", " ", str(text or ""))
    clean = re.sub(
        r"(?i)\b([\w.-]*(?:key|token|password|secret))[\"']?\s*[:=]\s*\S+",
        r"\1=[redacted]",
        clean,
    )
    return re.sub(r"\s+", " ", clean).strip()[:_ACTIVITY_LABEL_MAX_CHARS]


def _redacted(text: str) -> str:
    """Hermes's forced redactor plus its egress sweep; '[redaction-unavailable]' on any failure."""
    try:
        from agent.redact import redact_for_egress, redact_sensitive_text

        forced = redact_sensitive_text(text, force=True, redact_url_credentials=True)
        return redact_for_egress(forced)
    except Exception:
        return _REDACTION_UNAVAILABLE


def _tool_activity(phrase: str, *, preview: bool) -> dict[str, Any]:
    """Action-only activity from Hermes's live-status phrase.

    The opt-in preview covers web-search queries only, redacted."""
    text = str(phrase or "")
    if preview and text.startswith(_WEB_SEARCH_PREFIX):
        query = _sanitize_activity(text[len(_WEB_SEARCH_PREFIX):].rstrip("…"))
        return {"kind": "tool", "label": _redacted(f"Searching the web for {query}"), "tool": None}
    words = text.rstrip("…").split()
    if len(words) >= 3 and words[:2] == ["is", "using"] and _TOOL_NAME_RE.fullmatch(words[2]):
        return {"kind": "tool", "label": f"Using {words[2]}", "tool": words[2]}
    if len(words) >= 2 and words[0] == "is" and words[1].isalpha() and len(words[1]) <= 32:
        return {"kind": "tool", "label": words[1].capitalize(), "tool": None}
    return {"kind": "tool", "label": "Working", "tool": None}


def _env_float(raw: Any, default: float, label: str) -> float:
    """Parse ``raw`` as a float, falling back to ``default`` on garbage.

    A malformed interval override (``CLAWBITS_POLL_INTERVAL=off``, an empty
    value, a stray typo) must not take out adapter construction — a raw
    ``float(...)`` there raises inside ``__init__`` and the whole platform
    silently fails to load. Log the bad value and use the default instead.
    """
    if raw is None:
        return default
    try:
        return float(raw)
    except (ValueError, TypeError):
        logger.warning("clawbits: invalid %s=%r — using default %s", label, raw, default)
        return default


def _is_native_command(text: str) -> bool:
    """Whether Hermes would dispatch ``text`` as a built-in gateway command."""
    from hermes_cli.commands import resolve_command

    command = MessageEvent(text=text).get_command()
    return bool(command) and resolve_command(command) is not None


@dataclass
class _Lane:
    """One chat's single-flight state: the automatic dispatch in flight, hooked turns running."""

    inflight: str | None = None
    running: int = 0


@dataclass
class _Dispatch:
    """Journal items handed to Hermes as one event, tied to its hooks by the token."""

    token: str
    channel: _Channel
    items: list[Item]
    automatic: bool
    control: bool = False
    # Hermes may answer this one itself, without a turn or its hooks.
    inline: bool = False
    context: str | None = None
    delivered: bool = False
    started: bool = False

    @property
    def trigger(self) -> Item:
        return self.items[-1]

    @property
    def ids(self) -> list[int]:
        return [item.id for item in self.items]


class ClawbitsAdapter(BasePlatformAdapter):
    # All three are read by Hermes (gateway/platforms/base.py):
    # ``supports_status_text`` gates the live per-tool status wiring in
    # gateway/run.py, ``splits_long_messages`` tells it we chunk our own
    # over-length bodies, and ``REQUIRES_EDIT_FINALIZE`` routes a final
    # edit_message(finalize=True) instead of a fresh post, which is what
    # closes our streaming draft.
    supports_status_text = True
    splits_long_messages = True
    REQUIRES_EDIT_FINALIZE = True

    # The server authenticates every sender on its own transport; there is no
    # local allowlist for the gateway to consult.
    @property
    def authorization_is_upstream(self) -> bool:
        return True

    def __init__(self, config: PlatformConfig, reader_llm: Any = None) -> None:
        super().__init__(config, Platform("clawbits"))
        extra = config.extra or {}
        # Hermes constructs the adapter inside its owning profile's scope, so
        # the account and the captured context pin every request and task to
        # that profile for the adapter's lifetime.
        self.account = resolve_account(config)
        self._owner_context = contextvars.copy_context()
        self.base_url = self.account.base_url
        self.api_key = self.account.api_key
        # Read by Hermes's credential fingerprint: a second profile holding the
        # same key is refused instead of double-polling one agent.
        self.api_token = self.account.api_key
        self.agent_id = self.account.agent_id
        self.fallback_channel_id = self.account.channel_id
        # Parse via _env_float, not a bare float(...): a garbage override must
        # fall back to the default with a warning, not crash adapter init.
        self.poll_interval = _env_float(
            extra.get("poll_interval") or scoped_setting("CLAWBITS_POLL_INTERVAL"),
            DEFAULT_POLL_INTERVAL_SECONDS,
            "CLAWBITS_POLL_INTERVAL",
        )
        self.liveness_interval = _env_float(
            extra.get("liveness_interval") or scoped_setting("CLAWBITS_LIVENESS_INTERVAL"),
            DEFAULT_LIVENESS_INTERVAL_SECONDS,
            "CLAWBITS_LIVENESS_INTERVAL",
        )
        self.cli_path = str(extra.get("agent_cli") or _default_cli_path())
        self.client = _ClawbitsCli.for_account(self.account, self.cli_path)
        self._task: asyncio.Task[None] | None = None
        self._liveness_task: asyncio.Task[None] | None = None
        self._ws_task: asyncio.Task[None] | None = None
        self._mailroom_task: asyncio.Task[None] | None = None
        self._automations_task: asyncio.Task[None] | None = None
        self._status_task: asyncio.Task[None] | None = None
        self._automations_wake = asyncio.Event()
        # Per-subsystem health for `hermes clawbits doctor`, written by _status_task.
        self._health = HealthStatus.for_home(self.account.hermes_home, PLUGIN_VERSION)
        self._loop: asyncio.AbstractEventLoop | None = None
        # "generating" heartbeats of the turns in flight, keyed by message id.
        self._heartbeats: dict[str, asyncio.Task[None]] = {}
        self._channels: dict[str, _Channel] = {}
        # Chat intake state. The journal (opened in connect) owns every cursor;
        # a channel is drained by one task at a time under its lock, and its
        # lane lets one automatic dispatch run at a time.
        self._journal: InboxJournal | None = None
        # Mail never becomes a turn: the mailroom reads it with reader_llm and
        # delivers its artifacts and owner replies itself.
        self._reader_llm = reader_llm
        self._mailroom: Mailroom | None = None
        self._boot = secrets.token_hex(4)
        self._seq = itertools.count(1)
        self._dispatches: dict[str, _Dispatch] = {}
        self._lanes: dict[str, _Lane] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._drain_slots = asyncio.Semaphore(_DRAIN_CONCURRENCY)
        self._handoffs: set[asyncio.Task[None]] = set()
        self._woken: set[str] = set()
        self._wake_event = asyncio.Event()
        self._full_pass_at = 0.0
        self._caught_up: set[str] = set()  # channels read to their end since connect
        self._paused: set[str] = set()  # channels whose server ignores after_post_id
        self._intake_fault: str | None = None
        # A turn outcome the journal could not record; its items wait in processing until
        # the next reconcile sends them to review.
        self._unrecorded = False
        self._stopping = False
        # Pre-journal per-channel cursors, used only for a channel the server
        # gives no read pointer, under the legacy migration policy.
        self._legacy_cursors = load_read_cursors(self.account.hermes_home)
        self._legacy_policy = self._policy(
            extra.get("inbox_legacy_migration") or scoped_setting("CLAWBITS_INBOX_LEGACY_MIGRATION")
        )
        self._legacy_moved = False
        # Flipped off after the first "HTTP 404" from the ack endpoint so a
        # pre-pointer server costs one failed call, not one per settled turn.
        self._mark_read_supported = True
        self._snoozed = False
        self._operator: tuple[str, str, float] | None = None
        self._operator_email: str | None = None
        self._inter_agent_mode = False
        self._inter_agent_message_limit = _DEFAULT_INTER_AGENT_MESSAGE_LIMIT
        self._consecutive_agent_turns = 0
        self._awaiting_human_guidance = False
        self._guidance_notice_sent = False
        self._reply_prefixes: dict[str, str] = {}
        self._stream_reply_prefixes: dict[str, str] = {}
        # message_id -> chat_id for drafts that have been opened but not yet
        # finalised, so an abandoned turn can still close them.
        self._open_streams: dict[str, str] = {}
        # message_id -> body of posts this adapter published (a direct send or a finalized stream).
        self._published: dict[str, str] = {}
        self._activity_supported = True
        self._activities: dict[str, dict[str, Any]] = {}
        # Word-boundary @mention matcher, compiled once. A naive
        # ``f"@{agent_id}" in text`` false-positives when this agent's id is a
        # prefix of another (``@agent_1`` inside ``@agent_12``) and never lets
        # us strip the token. The lookarounds pin the match to a real boundary;
        # mirrors the OpenClaw plugin's mentionRegex (plugin/src/inbound-poller.ts).
        self._mention_re = re.compile(rf"(?<!\w)@{re.escape(self.agent_id)}(?!\w)")
        # Set after the first full successful poll (channels discovered, sources
        # opened) — the point at which the agent can actually receive a message.
        # The liveness loop waits on it, so "available" in Clawbits means ready,
        # not merely running. Survives a reconnect on this instance on purpose.
        self._ready = asyncio.Event()

    @staticmethod
    def _policy(raw: Any) -> str:
        policy = str(raw or "review").strip().lower()
        if policy not in _LEGACY_POLICIES:
            logger.warning("clawbits: bad CLAWBITS_INBOX_LEGACY_MIGRATION=%r; using review", raw)
            return "review"
        return policy

    # is_reconnect (gateway API since hermes 0.18) is accepted but unused: the
    # journal holds every cursor, so there is no server-side queue to drop or
    # preserve — the base class allows queue-less adapters to ignore the flag.
    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if not self.account.usable:
            logger.error("Clawbits needs CLAWBITS_API_KEY and CLAWBITS_AGENT_ID for this profile")
            self._set_fatal_error(
                "clawbits_not_configured",
                "Clawbits needs CLAWBITS_API_KEY and CLAWBITS_AGENT_ID for this profile",
                retryable=False,
            )
            return False
        if not Path(self.cli_path).exists():
            logger.error("Clawbits agent CLI not found: %s", self.cli_path)
            return False
        if suspension_opted_in():
            logger.warning(
                "clawbits: Hermes idle suspension is opted in; Clawbits polling has no wake path"
            )
        if not await self._open_journal():
            return False
        home = self.account.hermes_home
        # The gateway starts its cron ticker only after its adapters connect, so the
        # awaited hold lands before the first tick. Hermes's cron package is imported
        # on this loop thread first: first imports from two threads at once can meet a
        # half-initialised cron.scheduler.
        with contextlib.suppress(Exception):
            importlib.import_module("cron")
        try:
            held = await asyncio.to_thread(hold_missed_slots, home)
            if held:
                logger.info("clawbits: held %d overdue automation slot(s) for catch-up", held)
        except Exception:
            logger.warning("clawbits: could not hold missed automation slots", exc_info=True)
        self._running = True
        self._stopping = False
        self._caught_up.clear()
        self._loop = asyncio.get_running_loop()
        bind_account(self.account)
        self._status_task = self._spawn(run_status_writer(self._health, lambda: self._running))
        self._task = self._spawn(self._poll_loop())
        self._liveness_task = self._spawn(self._liveness_loop())
        self._ws_task = self._spawn(self._lobstertalk_ws_loop())
        self._start_mailroom()
        self._automations_task = self._spawn(
            run_automations_reconciler(
                self.client,
                self.agent_id,
                self.fallback_channel_id,
                self._automations_wake,
                lambda: self._running,
                hermes_home=home,
                health=self._health,
            )
        )
        logger.info("Clawbits adapter connected to %s", self.base_url)
        return True

    async def _open_journal(self) -> bool:
        """Open the owning profile's journal and reconcile it; False while intake must hold.

        A newer or unmigratable journal holds intake (retryable fatal error, no tasks);
        any other open failure leaves ``_journal`` None and chat intake paused until a
        full pass opens it."""
        home = self.account.hermes_home
        if self._journal is None:
            try:
                self._journal = await asyncio.to_thread(
                    open_journal, home, backend=self.base_url, agent_id=self.agent_id,
                    profile=profile_name(home),
                )
            except JournalTooNew:
                return await self._hold_intake(
                    "journal_schema_newer", "clawbits_state_too_new",
                    "Clawbits inbox journal was written by a newer plugin",
                )
            except JournalMigrationError as exc:
                return await self._hold_intake(
                    exc.code, "clawbits_state_migration", "Clawbits inbox journal migration failed"
                )
            except Exception:
                retry = self._intake_fault == "journal_unavailable"
                (logger.debug if retry else logger.error)(
                    "clawbits: inbox journal unavailable; chat intake paused", exc_info=True
                )
                return True
        self._health.hold(None)
        recovered = self._journal.reconcile(set(self._dispatches))
        self._unrecorded = False
        if any(recovered.values()):
            logger.info("clawbits: inbox journal reconciled after restart: %s", recovered)
        if held := self._journal.hold_legacy():
            logger.warning("clawbits: a pre-journal plugin ran; %d source(s) held for review", held)
        return True

    def _start_mailroom(self) -> None:
        """Run this profile's one mailroom once its journal is open.

        Built in the owning profile's context, like every task ``_spawn`` starts: its knobs
        come from that profile's settings, never the caller's.
        """
        if self._mailroom is not None or self._journal is None:
            return
        self._mailroom = self._owner_context.copy().run(
            lambda: Mailroom(
                account=self.account, client=self.client, journal=self._journal,
                llm=self._reader_llm, health=self._health, operator=self._operator_contact,
                snoozed=lambda: self._snoozed,
            )
        )
        bind_mailroom(self._mailroom)
        self._mailroom_task = self._spawn(self._mailroom.run(lambda: self._running))

    async def _hold_intake(self, reason: str, code: str, message: str) -> bool:
        """Hold all intake: status hold, flushed now, and a retryable fatal error."""
        logger.error("clawbits: %s; intake held (%s)", message, reason)
        self._health.hold(reason)
        await asyncio.to_thread(self._health.flush, True)
        self._set_fatal_error(code, message, retryable=True)
        return False

    def _spawn(self, coro: Coroutine[Any, Any, Any]) -> asyncio.Task[Any]:
        """Create a task in the owning profile's context captured at construction."""
        return asyncio.get_running_loop().create_task(coro, context=self._owner_context.copy())

    async def disconnect(self) -> None:
        self._running = False
        unbind_account(self.account)
        if self._mailroom is not None:
            unbind_mailroom(self._mailroom)
            self._mailroom = None
        for attr in (
            "_task",
            "_liveness_task",
            "_ws_task",
            "_mailroom_task",
            "_automations_task",
            "_status_task",
        ):
            task = getattr(self, attr, None)
            if task is None:
                continue
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            setattr(self, attr, None)
        pending = [*self._heartbeats.values(), *self._handoffs]
        self._heartbeats.clear()
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        for message_id, stream_chat in list(self._open_streams.items()):
            await self._close_stream_best_effort(
                stream_chat, message_id, "_(reply interrupted)_"
            )
        self._loop = None

    async def cancel_background_tasks(self) -> None:
        """Shutdown: a turn cancelled from here on stays in processing for restart review."""
        self._stopping = True
        await super().cancel_background_tasks()

    def set_status_text(self, chat_id: str, text: str | None) -> None:
        """Map Hermes's live tool phrase onto Clawbits's ephemeral activity lane.

        Hermes calls this with a phrase while a tool runs and with ``None`` when
        it finishes (gateway/run.py). ``None`` must CLEAR the lane — building a
        ``{"kind": "generating"}`` payload for it would re-assert the pill the
        caller is trying to put down. Only the action reaches Clawbits (see
        ``_tool_activity``): the phrase preview can carry tool arguments.
        """
        super().set_status_text(chat_id, text)
        loop = self._loop
        if loop is None or not loop.is_running():
            return
        activity = _tool_activity(text, preview=self.account.activity_preview) if text else None
        update = self._set_activity_best_effort(chat_id, activity)
        try:
            asyncio.run_coroutine_threadsafe(update, loop)
        except RuntimeError:
            update.close()

    async def _set_activity_best_effort(
        self, chat_id: str, activity: dict[str, Any] | None
    ) -> None:
        if activity:
            self._activities[chat_id] = activity
        else:
            self._activities.pop(chat_id, None)
        try:
            await asyncio.to_thread(
                self.client.set_status,
                chat_id,
                "generating",
                activity if (activity and self._activity_supported) else None,
            )
        except Exception as exc:
            if self._activity_supported and activity and http_status(exc) == 422:
                self._activity_supported = False
                logger.info("clawbits: server rejected live activity; using plain presence")
                try:
                    await asyncio.to_thread(self.client.set_status, chat_id, "generating")
                    return
                except Exception:
                    pass
            logger.debug("Clawbits activity update failed", exc_info=True)

    def _trim_stream_state(self) -> None:
        """Bound the per-stream maps the way the inbound ones are bounded — a
        crashed turn never pops its entry, so these would otherwise only grow."""
        for store in (self._stream_reply_prefixes, self._open_streams, self._published):
            while len(store) > _REPLY_CONTEXT_CAP:
                del store[next(iter(store))]

    def _mark_published(self, message_id: str | None, content: str) -> None:
        """Remember a published post's body: Hermes repeats the final edit of it."""
        if message_id:
            self._published[str(message_id)] = content
            self._trim_stream_state()

    def _prefix_for_reply(self, reply_to: str | None) -> str:
        return self._reply_prefixes.get(str(reply_to or ""), "")

    @staticmethod
    def _with_prefix(content: str, prefix: str) -> str:
        if not prefix or content.lstrip().startswith(prefix):
            return content
        return f"{prefix} {content}".strip()

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> SendResult:
        metadata = metadata or {}

        # Hermes routes interim "thinking" chatter through an ordinary send,
        # marked by a leading 💬 bubble (gateway display: show_reasoning /
        # interim_assistant_messages). Those belong on Clawbits's ephemeral
        # activity lane, not in the transcript.
        #
        # The guard is deliberately tight: an interim bubble is short and
        # unthreaded, so a long or replied-to message that merely opens with the
        # emoji is treated as a real reply and posted. Swallowing one silently
        # would lose it with no trace.
        if (
            content.startswith("💬 ")
            and metadata.get("notify") is not True
            and metadata.get("expect_edits") is not True
            and reply_to is None
            and len(content) <= _MAX_INTERIM_BUBBLE_CHARS
        ):
            await self._set_activity_best_effort(
                chat_id,
                {"kind": "thinking", "label": _sanitize_activity(content[2:])},
            )
            return SendResult(success=True)

        expect_edits = metadata.get("expect_edits") is True
        parent_post_id = _parent_post_id_from_metadata(metadata, reply_to)
        trace_id = _trace_id_from_metadata(metadata)
        prefix = self._prefix_for_reply(reply_to)
        visible_content = self._with_prefix(content, prefix)
        dispatched = False
        try:
            await self._set_status_best_effort(chat_id, "generating")
            if not Path(self.cli_path).exists():
                raise FileNotFoundError(f"Clawbits agent CLI not found: {self.cli_path}")

            if expect_edits:
                # Create empty: create-post is capped at 4k, while PATCH replace
                # accepts the larger streamed reply body.
                dispatched = True
                raw = await asyncio.to_thread(
                    self.client.post_message,
                    chat_id,
                    "",
                    parent_post_id,
                    trace_id,
                    None,
                    "streaming",
                )
                message_id = _message_id_from_response(raw)
                if not message_id:
                    raise RuntimeError("streaming post returned no id")
                if visible_content:
                    await asyncio.to_thread(
                        self.client.patch_message,
                        chat_id,
                        message_id,
                        replace=visible_content,
                    )
                self._open_streams[message_id] = chat_id
                opened = _turn_streams.get()
                if opened is not None:
                    opened.add(message_id)
                if prefix:
                    self._stream_reply_prefixes[message_id] = prefix
                self._trim_stream_state()
                return SendResult(success=True, message_id=message_id, raw_response=raw)

            raw: Any = None
            for chunk in _split_message_chunks(visible_content) or [""]:
                dispatched = True
                raw = await asyncio.to_thread(
                    self.client.post_message, chat_id, chunk, parent_post_id, trace_id
                )
            message_id = _message_id_from_response(raw)
            self._mark_published(message_id, content)
            return SendResult(success=True, message_id=message_id, raw_response=raw)
        except Exception as exc:
            logger.exception("Clawbits send failed")
            return SendResult(success=False, error=str(exc), retryable=not dispatched)
        finally:
            # A stream remains generating until the turn completes.
            await self._set_status_best_effort(
                chat_id, "generating" if expect_edits else "online"
            )

    async def edit_message(
        self,
        chat_id: str,
        message_id: str,
        content: str,
        *,
        finalize: bool = False,
        **kwargs: Any,
    ) -> SendResult:
        if finalize and self._published.get(str(message_id)) == content:
            # Hermes's repeat final edit of a post already published with this body.
            return SendResult(success=True, message_id=str(message_id))
        prefix = self._stream_reply_prefixes.get(str(message_id), "")
        visible_content = self._fit_patch_body(self._with_prefix(content, prefix))
        try:
            raw = await asyncio.to_thread(
                self.client.patch_message,
                chat_id,
                message_id,
                replace=visible_content,
                done=finalize,
            )
            if finalize:
                self._stream_reply_prefixes.pop(str(message_id), None)
                self._open_streams.pop(str(message_id), None)
                self._mark_published(message_id, content)
            return SendResult(success=True, message_id=str(message_id), raw_response=raw)
        except Exception as exc:
            logger.warning("clawbits: streaming post edit failed", exc_info=True)
            if finalize:
                self._stream_reply_prefixes.pop(str(message_id), None)
                self._open_streams.pop(str(message_id), None)
            return SendResult(success=False, error=str(exc), retryable=True)

    @staticmethod
    def _fit_patch_body(content: str) -> str:
        """Keep a streamed body inside the server's PATCH replace cap.

        Over the cap the PATCH 422s, which used to leave the draft open forever
        (it is never finalised) — a stuck shimmer until the server reaps it.
        """
        if len(content) <= _PATCH_REPLACE_MAX_CHARS:
            return content
        note = "\n\n_(reply truncated)_"
        return content[: _PATCH_REPLACE_MAX_CHARS - len(note)].rstrip() + note

    async def _close_stream_best_effort(self, chat_id: str, message_id: str, reason: str) -> None:
        """Never leave a draft in `streaming`.

        An abandoned draft shimmers in the channel and pins the "generating"
        pill until the server's reaper catches it minutes later.
        """
        try:
            await asyncio.to_thread(
                self.client.patch_message, chat_id, message_id, replace=reason, done=True
            )
        except Exception:
            logger.debug("clawbits: could not close abandoned stream", exc_info=True)
        finally:
            self._stream_reply_prefixes.pop(str(message_id), None)
            self._open_streams.pop(str(message_id), None)

    async def delete_message(self, chat_id: str, message_id: str) -> bool:
        try:
            await asyncio.to_thread(
                self.client.patch_message, chat_id, message_id, cancel=True
            )
            self._stream_reply_prefixes.pop(str(message_id), None)
            self._open_streams.pop(str(message_id), None)
            return True
        except Exception:
            logger.debug("clawbits: streaming post cancel failed", exc_info=True)
            return False

    async def _upload_and_post_image(
        self,
        chat_id: str,
        image_path: str,
        caption: str | None,
        metadata: dict[str, Any],
        reply_to: str | None,
        content_type: str | None = None,
    ) -> SendResult:
        """Upload a local image via the direct byte route and post it with
        ``file_ids`` — one message, image + caption together. A caption
        over the server's 4000-char post cap is split: the first chunk
        rides with the image, the rest follow as plain posts. Raises on
        failure so each caller picks its own safe fallback (notice for a
        local path, URL-as-text for a downloaded URL)."""
        parent_post_id = _parent_post_id_from_metadata(metadata, reply_to)
        trace_id = _trace_id_from_metadata(metadata)
        try:
            await self._set_status_best_effort(chat_id, "generating")
            file_id = await asyncio.to_thread(
                self.client.upload_file, chat_id, image_path, content_type
            )
            first, *overflow = _split_message_chunks(caption or "") or [""]
            raw = await asyncio.to_thread(
                self.client.post_message, chat_id, first, parent_post_id, trace_id, [file_id]
            )
            image_post = raw
            for chunk in overflow:
                raw = await asyncio.to_thread(
                    self.client.post_message, chat_id, chunk, parent_post_id, trace_id
                )
            return SendResult(
                success=True,
                message_id=_message_id_from_response(image_post),
                raw_response=image_post,
            )
        finally:
            await self._set_status_best_effort(chat_id, "online")

    async def send_image_file(
        self,
        chat_id: str,
        image_path: str,
        caption: str | None = None,
        reply_to: str | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> SendResult:
        """Deliver a local image (e.g. one the agent generated with its
        configured image_gen provider) as a native Clawbits attachment.

        The gateway routes generated media here; without this override the
        base class posts a "couldn't deliver" notice. Any failure falls back
        to that base behavior — which never echoes the host path into chat.
        """
        safe_path = self.validate_media_delivery_path(image_path)
        if safe_path is None:
            return await super().send_image_file(
                chat_id, image_path, caption=caption, reply_to=reply_to, metadata=metadata, **kwargs
            )
        try:
            return await self._upload_and_post_image(
                chat_id, safe_path, caption, metadata or {}, reply_to
            )
        except Exception:
            logger.exception("Clawbits native image send failed; posting fallback notice")
            return await super().send_image_file(
                chat_id, image_path, caption=caption, reply_to=reply_to, metadata=metadata, **kwargs
            )

    async def send_image(
        self,
        chat_id: str,
        image_url: str,
        caption: str | None = None,
        reply_to: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> SendResult:
        """Deliver a URL-hosted image natively: download it (15 MiB cap,
        private-address guard), then reuse the local-file upload path. The
        response's Content-Type rides along so the upload stores the real
        MIME even for extension-less URLs. Falls back to the base behavior
        (URL appended to the text) when download or upload fails — a public
        URL in chat is still useful, unlike a host path."""
        try:
            tmp_path, content_type = await asyncio.to_thread(
                _download_to_tempfile, image_url
            )
        except Exception:
            logger.exception("Clawbits image download failed; sending URL as text")
            return await super().send_image(
                chat_id, image_url, caption=caption, reply_to=reply_to, metadata=metadata
            )
        try:
            return await self._upload_and_post_image(
                chat_id, tmp_path, caption, metadata or {}, reply_to,
                content_type=content_type,
            )
        except Exception:
            logger.exception("Clawbits native image send failed; sending URL as text")
            return await super().send_image(
                chat_id, image_url, caption=caption, reply_to=reply_to, metadata=metadata
            )
        finally:
            with contextlib.suppress(OSError):
                os.unlink(tmp_path)

    async def get_chat_info(self, chat_id: str) -> dict[str, Any]:
        """Return basic info about a Clawbits channel.

        Required abstract method on ``BasePlatformAdapter`` — without it the
        class is abstract and the gateway can't instantiate the adapter. Looks
        the channel up via the agent CLI; falls back to a minimal descriptor
        when it can't be resolved (e.g. CLI error, or the operator channel).
        """
        try:
            channels = await asyncio.to_thread(self.client.list_channels)
            for ch in channels:
                if ch.id == chat_id:
                    is_direct = ch.channel_type in {None, "direct"}
                    return {"name": ch.name or chat_id, "type": "dm" if is_direct else "channel"}
        except Exception:
            logger.debug("get_chat_info: channel lookup failed for %s", chat_id, exc_info=True)
        is_direct = chat_id == self.fallback_channel_id
        return {"name": "Clawbits", "type": "dm" if is_direct else "channel"}

    async def _poll_loop(self) -> None:
        """Full intake passes every ``poll_interval``, woken channels in between."""
        only: set[str] | None = None
        while self._running:
            try:
                await self._poll_once(only)
                if self._intake_fault:
                    self._health.fail("chat", self._intake_fault, interval_s=self.poll_interval)
                else:
                    self._health.ok("chat", interval_s=self.poll_interval)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._health.fail("chat", exc, interval_s=self.poll_interval)
                logger.exception("Clawbits poll failed")
            only = await self._next_wake()

    def _wake(self, chat_id: str) -> None:
        """Ask the poll loop to drain ``chat_id`` before the next interval tick."""
        self._woken.add(chat_id)
        self._wake_event.set()

    async def _next_wake(self) -> set[str] | None:
        """The channels woken before the next full pass is due; None when it is due."""
        due = self._full_pass_at + self.poll_interval
        remaining = due - time.monotonic()
        if remaining > 0 and self._running:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._wake_event.wait(), remaining)
        self._wake_event.clear()
        woken, self._woken = self._woken, set()
        return None if time.monotonic() >= due else woken

    async def _liveness_loop(self) -> None:
        """Heartbeat to Clawbits: once ready, then every ``LIVENESS_INTERVAL``.

        Clawbits derives an agent's online dot from ``last_alive_at`` and calls it
        offline after 40 minutes of silence — so an agent that never pings is *never*
        "available". That is not cosmetic: the Add-agent wizard's final step waits for
        exactly this signal, so without a heartbeat a perfectly healthy agent hangs on
        "Almost ready…" forever. The OpenClaw plugin has always pinged (see
        ``plugin/src/liveness.ts``); the Hermes plugin never did.

        The FIRST ping is gated on ``_ready`` (first full poll done, greeting sent),
        not on ``connect()``: pinging at connect lit the wizard's "Say Hi" the moment
        the gateway scheduled our tasks, before channel discovery had run — a hi sent
        in that window landed before cursor seeding and was swallowed as backlog. The
        OpenClaw plugin only pings after its whole setup flow (signup → channel →
        greeting → healthcheck) has finished; this is the same promise: "available"
        means the agent will actually see your message. On a reconnect ``_ready`` is
        already set and the ping fires immediately, keeping the dot honest through
        outages.

        Deliberately its own task, not folded into ``_poll_loop``: the poll cadence is
        seconds (message latency) while this is minutes, and a failing poll must not
        take the heartbeat down with it (an agent that can't read messages is still
        alive, and the operator needs to see that rather than a false "offline").
        Best-effort — a failed ping is logged and retried on the next tick.
        """
        await self._ready.wait()
        while self._running:
            try:
                await asyncio.to_thread(self.client.alive)
                self._health.ok("liveness", interval_s=self.liveness_interval)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._health.fail("liveness", exc, interval_s=self.liveness_interval)
                logger.warning("Clawbits liveness ping failed", exc_info=True)
            await asyncio.sleep(self.liveness_interval)

    async def _set_status_best_effort(
        self, chat_id: str, status: str, *, activity: bool = True
    ) -> None:
        if status != "generating":
            self._activities.pop(chat_id, None)
        activity = self._activities.get(chat_id) if (activity and status == "generating") else None
        try:
            await asyncio.to_thread(
                self.client.set_status,
                chat_id,
                status,
                activity if self._activity_supported else None,
            )
        except TypeError:
            # Test doubles and older client wrappers expose the historical
            # two-argument signature.
            try:
                await asyncio.to_thread(self.client.set_status, chat_id, status)
            except Exception:
                logger.debug(
                    "Clawbits status update failed: %s -> %s",
                    chat_id,
                    status,
                    exc_info=True,
                )
        except Exception:
            logger.debug("Clawbits status update failed: %s -> %s", chat_id, status, exc_info=True)

    async def _generating_heartbeat(self, chat_id: str) -> None:
        """Re-assert "generating" every ``GENERATING_HEARTBEAT_INTERVAL_SECONDS``
        until cancelled, so the presence pill (a ~15s TTL'd server field) stays
        lit for the whole turn instead of lapsing during a long model turn or
        tool call. The initial "generating" is set by the caller; this only
        renews it."""
        try:
            while True:
                await asyncio.sleep(GENERATING_HEARTBEAT_INTERVAL_SECONDS)
                # Bare "generating", no activity payload: re-sending the sticky
                # label would keep re-asserting a tool that finished long ago.
                await self._set_status_best_effort(chat_id, "generating", activity=False)
        except asyncio.CancelledError:
            raise

    def _apply_controls(self, raw: Any) -> None:
        settings = _extract_control_settings(raw)
        prior_inter_agent = self._inter_agent_mode
        snoozed = settings.get("snoozed")
        if isinstance(snoozed, bool):
            self._snoozed = snoozed
        inter_agent = settings.get("inter_agent_mode_enabled")
        if isinstance(inter_agent, bool):
            self._inter_agent_mode = inter_agent
        limit = settings.get("inter_agent_message_limit")
        if isinstance(limit, (int, float)):
            self._inter_agent_message_limit = max(
                1, min(_MAX_INTER_AGENT_MESSAGE_LIMIT, int(limit))
            )
        channels = _extract_channels(raw)
        if channels:
            self._channels = {channel.id: channel for channel in channels}
        if prior_inter_agent and not self._inter_agent_mode:
            self._reset_inter_agent()

    def _reset_inter_agent(self) -> None:
        self._consecutive_agent_turns = 0
        self._awaiting_human_guidance = False
        self._guidance_notice_sent = False

    async def _dispatch_realtime_post(self, event: dict[str, Any]) -> None:
        """A WebSocket ``post.created`` only wakes its channel's forward read."""
        post = event.get("data") if isinstance(event.get("data"), dict) else {}
        if channel_id := event.get("channel_id") or post.get("channel_id"):
            self._wake(str(channel_id))

    def _events_ws_url(self) -> str:
        # No ``?api_key=`` query param: a secret in the URL lands in server and
        # proxy access logs. The credential rides an ``Authorization: Bearer``
        # header instead (see _lobstertalk_ws_loop) — the server accepts either
        # (clawbits/fastapi/clawbits_server.py mm_agent_events_ws).
        base = self.base_url.rstrip("/")
        scheme, _, host = base.partition("://")
        ws_scheme = "wss" if scheme == "https" else "ws"
        return f"{ws_scheme}://{host}/api/agentic/mm/events/ws"

    async def _lobstertalk_ws_loop(self) -> None:
        """Listen on the agent events WebSocket for LobsterTalk attention nudges.

        ``lobstertalk.consider`` events exist only on the per-agent control
        topic — Redis pub/sub with no replay — so the poll loop can never see
        them; without this socket the server-side attention gate is inert for
        Hermes agents (the nudge publishes to zero receivers and refunds its
        cooldown). It also carries ``snapshot`` (agent controls), ``post.created``
        and ``automation.sync``. ``post.created`` only wakes the channel's
        forward read, so posts are still admitted in order by the journal.

        Fail-soft: no ``websockets`` package → one warning, poll-only. Drops
        reconnect with exponential backoff; protocol-level ping keeps idle
        connections alive through proxies.
        """
        try:
            import websockets  # Hermes core dependency; guard anyway
        except ImportError:
            logger.warning(
                "clawbits: 'websockets' not available — LobsterTalk attention nudges disabled (poll-only)"
            )
            self._health.fail("events", "websockets_missing")
            return
        # Authenticate via header, not URL query param (keeps the key out of
        # access logs).
        auth_headers = {"Authorization": f"Bearer {self.api_key}"}
        backoff = 1.0
        while self._running:
            try:
                async with websockets.connect(
                    self._events_ws_url(),
                    ping_interval=20,
                    max_size=2**22,
                    additional_headers=auth_headers,
                ) as ws:
                    logger.info("clawbits: agent events WebSocket connected (LobsterTalk nudges live)")
                    self._health.ok("events")
                    backoff = 1.0
                    async for raw in ws:
                        if not self._running:
                            break
                        try:
                            event = json.loads(raw)
                        except (json.JSONDecodeError, TypeError):
                            continue
                        # "mutualist.consider" is the pre-rename name for the same
                        # event; accepted so this adapter still gets nudges from a
                        # server that hasn't been redeployed yet.
                        if not isinstance(event, dict):
                            continue
                        event_type = event.get("type")
                        if event_type == "snapshot":
                            self._operator = None
                            self._apply_controls(event.get("data"))
                        elif event_type == "post.created":
                            await self._dispatch_realtime_post(event)
                        elif event_type == "automation.sync":
                            self._automations_wake.set()
                        elif event_type in ("lobstertalk.consider", "mutualist.consider"):
                            await self._dispatch_attention(event)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if not self._running:
                    break
                self._health.fail("events", exc)
                logger.warning(
                    "clawbits: events WebSocket dropped; reconnecting in %.0fs", backoff, exc_info=True
                )
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60.0)

    async def _dispatch_attention(self, event: dict[str, Any]) -> None:
        """Admit a ``lobstertalk.consider`` nudge to its channel's attention lane.

        The server has already applied the heavy gates (attention route win,
        per-agent opt-in, snooze, @mention, own-post, cooldown). The nudge is
        admitted once, and only for a post the post lane skips as unaddressed;
        its turn carries the attention preamble in ``channel_context`` and never
        gateway control."""
        post = event.get("data")
        if not isinstance(post, dict) or self._journal is None or self._snoozed:
            return
        channel_id = str(event.get("channel_id") or post.get("channel_id") or "")
        channel_id = channel_id or self.fallback_channel_id
        pos = _post_sequence(post)
        if not channel_id or pos <= 0:
            return
        channel = self._channels.get(channel_id) or _Channel(channel_id, "public", channel_id)
        async with self._channel_lock(channel_id):
            source = await self._chat_source(channel)
            if source.state != "active":
                return
            seen = self._journal.lane_item(source, "post", pos)
            skip = seen.note if seen else self._skip_reason(channel, post)
            if skip != "not_addressed":
                return
            row = NewItem(pos, _post_id(post), "attention", payload=post, lane="attention")
            self._journal.admit(source, [row], enumerated=source.enumerated)
            self._health.receipt("chat")
        logger.info("clawbits: LobsterTalk nudge for post %s in %s admitted", pos, channel_id)
        self._wake(channel_id)

    async def _poll_once(self, only: set[str] | None = None) -> None:
        """One intake pass: a full pass refreshes the snapshot and drains every channel,
        a wake pass drains only the ``only`` channels."""
        if only is None:
            self._full_pass_at = time.monotonic()
            if self._journal is None and not await self._open_journal():
                await self._notify_fatal_error()
                return
            self._start_mailroom()
            await self._refresh_channels()
        results = []
        if self._journal is not None:
            channels = [c for c in self._channels.values() if only is None or c.id in only]
            results = await asyncio.gather(
                *(self._drain_channel(channel, fresh=only is None) for channel in channels),
                return_exceptions=True,
            )
        paused = self._paused & self._channels.keys()
        self._intake_fault = (
            "journal_unavailable" if self._journal is None
            else "forward_read_unsupported" if paused
            else "journal_write_failed" if self._unrecorded else None
        )
        if errors := [r for r in results if isinstance(r, Exception)]:
            raise errors[0]
        if not self._ready.is_set():
            # First full pass done: every channel has a journal source, so anything
            # posted from here on is admitted. Greet BEFORE unblocking the liveness
            # loop — the operator must find the greeting already in the channel
            # when the wizard says "available".
            await self._greet_once()
            self._ready.set()

    async def _refresh_channels(self) -> None:
        try:
            control_snapshot = getattr(self.client, "control_snapshot", None)
            if callable(control_snapshot):
                raw_snapshot = await asyncio.to_thread(control_snapshot)
                self._apply_controls(raw_snapshot)
                channels = _extract_channels(raw_snapshot)
            else:
                channels = await asyncio.to_thread(self.client.list_channels)
        except Exception:
            if not self.fallback_channel_id:
                raise
            logger.warning("Clawbits channel discovery failed; using fallback", exc_info=True)
            channels = [_Channel(self.fallback_channel_id, None, "Clawbits")]
        if not channels and self.fallback_channel_id:
            channels = [_Channel(self.fallback_channel_id, None, "Clawbits")]
        self._channels = {channel.id: channel for channel in channels}

    # --- Chat intake ------------------------------------------------------------

    def _lane(self, chat_id: str) -> _Lane:
        return self._lanes.setdefault(chat_id, _Lane())

    def _channel_lock(self, chat_id: str) -> asyncio.Lock:
        return self._locks.setdefault(chat_id, asyncio.Lock())

    async def _drain_channel(self, channel: _Channel, *, fresh: bool = False) -> None:
        """The channel's ordering owner: admit new posts, hand off what the lane allows, ack.

        ``fresh``: ``channel`` is from this pass's snapshot, so a newest post at or below the
        cursor means there is nothing to read."""
        async with self._drain_slots, self._channel_lock(channel.id):
            source = await self._chat_source(channel)
            if source.state != "active":
                return
            head = channel.latest_post_id
            if fresh and head is not None and head <= source.enumerated:
                self._caught_up.add(channel.id)
            elif (source := await self._admit_forward(channel, source)) is None:
                return
            while dispatch := await self._next_chat_dispatch(channel, source):
                self._hand_off(dispatch)
            await self._ack_settled(channel, source)

    async def _chat_source(self, channel: _Channel) -> Source:
        """The channel's journal source; the legacy cursor file moves aside once it is absorbed."""
        source = self._journal.source("chat", channel.id) or await self._new_chat_source(channel)
        if not self._legacy_moved and self._legacy_absorbed():
            self._journal.move_legacy("chat")
            self._legacy_moved = True
        return source

    def _legacy_absorbed(self) -> bool:
        """Every legacy chat cursor is an active journal source, so the file is only a backup.

        Until then a restart still needs it: a channel this process has not reached yet would
        otherwise start from ``discovered:recent`` and skip its backlog without a trace."""
        return all(
            (source := self._journal.source("chat", chat_id)) is not None
            and source.state == "active"
            for chat_id in self._legacy_cursors
        )

    async def _new_chat_source(self, channel: _Channel) -> Source:
        """Adopt the server read pointer; without one, apply the legacy cursor policy. Else a
        channel first seen after the first full pass reads its recent posts as backlog, and a
        first start is new_only (start at the newest post, acked by the drain)."""
        journal = self._journal
        pointer = channel.last_read_post_id
        if pointer is not None:
            source = journal.create_source(
                "chat", channel.id, "", enumerated=pointer, note="adopted:server_pointer"
            )
            journal.set_acked(source, pointer)
            return source
        legacy = self._legacy_cursors.get(channel.id)
        if legacy is not None and self._legacy_policy == "adopt":
            return journal.create_source(
                "chat", channel.id, "", enumerated=legacy, note="migrated:adopt"
            )
        if legacy is not None and self._legacy_policy == "review":
            logger.warning(
                "clawbits: channel %s has only a local read cursor; held for"
                " `hermes clawbits inbox migrate`",
                channel.id,
            )
            return journal.create_source(
                "chat", channel.id, "", enumerated=legacy, note="legacy_cursor",
                state="migration_needs_review",
            )
        if self._ready.is_set():
            page = await asyncio.to_thread(self.client.get_posts, channel.id, _DISCOVERED_PAGE)
            start = max(0, min(map(_post_sequence, page), default=1) - 1)
            return journal.create_source(
                "chat", channel.id, "", enumerated=start, note="discovered:recent"
            )
        newest = channel.latest_post_id
        if newest is None:
            page = await asyncio.to_thread(self.client.get_posts, channel.id, 1)
            newest = max(map(_post_sequence, page), default=0)
        self._caught_up.add(channel.id)
        note = "first_start:new_only" if legacy is None else "migrated:new_only"
        return journal.create_source("chat", channel.id, "", enumerated=newest, note=note)

    async def _admit_forward(self, channel: _Channel, source: Source) -> Source | None:
        """Read after the cursor, oldest first, admitting each page with its cursor in one
        transaction, up to MAX_OPEN open items. Another author's unpublished post is left out
        and holds the cursor (and so the ack) below it until it is published or removed; the
        posts after it are still admitted. None when the server ignores ``after_post_id``."""
        after = cursor = source.enumerated
        held = False
        for _ in range(_PAGES_PER_PASS):
            raw = await asyncio.to_thread(self.client.get_posts, channel.id, _PAGE_SIZE, after)
            posts = sorted(raw, key=_post_sequence)
            if any(_post_sequence(post) <= after for post in posts):
                if channel.id not in self._paused:
                    self._paused.add(channel.id)
                    logger.warning("clawbits: %s ignores after_post_id; intake paused", channel.id)
                return None
            self._paused.discard(channel.id)
            live, room = channel.id in self._caught_up, MAX_OPEN - self._journal.open_count(source)
            last = _post_sequence(posts[-1]) if posts else after
            known = {item.pos for item in self._journal.posts_between(source, after, last)}
            rows: list[NewItem] = []
            full = False
            for post in posts:
                pos = _post_sequence(post)
                if pos not in known and not self._is_settled(post):
                    held = True
                elif pos not in known:
                    row = await self._classify_post(channel, post, live=live)
                    if row.state == "pending":
                        if full := room <= 0:
                            break
                        room -= 1
                    rows.append(row)
                cursor = cursor if held else pos
            if rows or cursor > source.enumerated:
                source = self._journal.admit(source, rows, enumerated=cursor)
            if rows:
                self._health.receipt("chat")
            if full:
                return source
            if len(raw) < _PAGE_SIZE:
                self._caught_up.add(channel.id)
                return source
            after = last
        return source

    def _is_own(self, post: dict[str, Any]) -> bool:
        return self.agent_id in (post.get("agent_id"), post.get("user_id"))

    def _is_settled(self, post: dict[str, Any]) -> bool:
        """False for another author's unpublished post: its final text is not known yet."""
        return self._is_own(post) or post.get("status") not in _UNSETTLED

    def _is_direct_channel(self, channel: _Channel) -> bool:
        return channel.channel_type in {None, "direct"} or channel.id == self.fallback_channel_id

    def _is_pair_channel(self, channel: _Channel) -> bool:
        return self._is_direct_channel(channel) or channel.channel_type == "agent_chat"

    def _skip_reason(self, channel: _Channel, post: dict[str, Any]) -> str | None:
        """Why a post is not ours to answer, or None when it is addressed to this agent."""
        text = str(post.get("message") or "")
        if self._is_own(post):
            return "own"
        if not _is_user_post(post):
            return "system"
        if not text.strip() and not _extract_files(post):
            return "empty"
        if not (self._is_pair_channel(channel) or self._mention_re.search(text)):
            return "not_addressed"
        if post.get("agent_id") and not self._inter_agent_mode:
            return "inter_agent_off"
        if self._is_direct_channel(channel) and _is_server_handled_command(text):
            return "server_command"
        return None

    async def _classify_post(
        self, channel: _Channel, post: dict[str, Any], *, live: bool
    ) -> NewItem:
        """Admission disposition: pending as live, backlog or snoozed, or ignored with a reason.

        Agent posts never become historical work, so a restart cannot resume inter-agent
        ping-pong; while snoozed only the verified operator's native commands stay live."""
        skip = self._skip_reason(channel, post)
        reason = "live" if live else "backlog"
        if skip is None:
            mentioned = self._mention_re.search(str(post.get("message") or ""))
            if live and mentioned and not post.get("agent_id"):
                self._reset_inter_agent()
            if live and self._snoozed and not await self._is_operator_command(channel, post):
                reason = "snoozed"
            if post.get("agent_id") and reason != "live":
                skip = "inter_agent_backlog"
        payload = None if skip == "own" else post
        state = "ignored" if skip else "pending"
        return NewItem(_post_sequence(post), _post_id(post), reason, state, skip, payload)

    async def _next_chat_dispatch(self, channel: _Channel, source: Source) -> _Dispatch | None:
        """The next dispatch the lane allows: while it is busy or snoozed only an operator
        control; otherwise a catch-up batch, an attention item or the oldest live item.
        Historical gateway commands are recorded as ignored, never run."""
        lane = self._lane(channel.id)
        busy = bool(lane.inflight or lane.running)
        if busy or self._snoozed:
            for item in self._journal.due(source, MAX_OPEN):
                if await self._is_bypass(channel, item):
                    return self._dispatch(
                        channel, [item], automatic=not busy, control=True, inline=True
                    )
            return None
        due = self._journal.due(source, _CATCH_UP_BATCH + 1)
        while due:
            head = due[0]
            if head.lane == "post" and head.reason in _HISTORICAL:
                run = list(itertools.takewhile(lambda i: i.reason in _HISTORICAL, due))
                if commands := [item.id for item in run if self._is_command(item.payload)]:
                    self._journal.finish(commands, "ignored", "historical_command")
                    due = self._journal.due(source, _CATCH_UP_BATCH + 1)
                    continue
                batch = run[:_CATCH_UP_BATCH]
                context = self._catch_up_block(source, batch, more=len(run) > len(batch))
                return self._dispatch(channel, batch, automatic=True, context=context)
            if await self._inter_agent_blocked(channel, head):
                due.pop(0)
                continue
            if head.lane == "attention":
                return self._dispatch(channel, [head], automatic=True, context=_ATTENTION_PREAMBLE)
            control = await self._is_operator_control(channel, head.payload)
            inline = control and self._handled_in_place(channel, head)
            return self._dispatch(channel, [head], automatic=True, control=control, inline=inline)
        return None

    def _catch_up_block(self, source: Source, batch: list[Item], *, more: bool) -> str | None:
        """Untrusted channel_context for a catch-up turn: the batch's other messages plus the
        skipped chatter between them (oldest chatter dropped first past the line cap)."""
        keep = {item.id for item in batch}
        lines = [
            (item.id in keep, line)
            for item in self._journal.posts_between(source, batch[0].pos - 1, batch[-1].pos - 1)
            if (item.id in keep or item.state == "ignored")
            and (line := _context_line(item.payload, _CATCH_UP_CONTEXT_CHARS))
        ]
        spare = len(lines) - _CATCH_UP_CONTEXT_LINES
        kept: list[str] = []
        for in_batch, line in lines:
            if not in_batch and spare > 0:
                spare -= 1
                continue
            kept.append(line)
        if not kept and not more:
            return None
        tail = ["(More missed messages follow in the next turn.)"] if more else []
        return "\n".join([*_CATCH_UP_HEADER, *kept, *tail, "[end Missed messages]"])

    async def _inter_agent_blocked(self, channel: _Channel, item: Item) -> bool:
        """Apply the inter-agent gate to an agent-authored trigger; a blocked one is ignored."""
        if not item.payload.get("agent_id"):
            return False
        if not self._inter_agent_mode:
            self._journal.finish([item.id], "ignored", "inter_agent_off")
            return True
        budget = self._consecutive_agent_turns < self._inter_agent_message_limit
        if budget and not self._awaiting_human_guidance:
            self._consecutive_agent_turns += 1
            return False
        self._awaiting_human_guidance = True
        self._journal.finish([item.id], "ignored", "guidance")
        if not self._guidance_notice_sent:
            self._guidance_notice_sent = True
            await self._post_guidance_notice(channel.id, item.payload)
        return True

    def _is_command(self, post: dict[str, Any]) -> bool:
        """The post, own @mention stripped, is a Hermes gateway command."""
        return _is_native_command(self._strip_self_mentions(str(post.get("message") or "")))

    async def _is_operator_command(self, channel: _Channel, post: dict[str, Any]) -> bool:
        return self._is_command(post) and await self._is_operator_control(channel, post)

    def _handled_in_place(self, channel: _Channel, item: Item) -> bool:
        """Hermes answers this live post itself, with no turn and no hooks: a native command, or
        (not while snoozed) an answer to a pending clarify or approval prompt."""
        if item.lane != "post" or item.reason != "live":
            return False
        answer = not self._snoozed and self._pending_prompt(
            self._session_source(channel, item.payload)
        )
        return answer or self._is_command(item.payload)

    async def _is_bypass(self, channel: _Channel, item: Item) -> bool:
        """A live post by the verified operator that Hermes handles in place."""
        return self._handled_in_place(channel, item) and await self._is_operator_control(
            channel, item.payload
        )

    def _pending_prompt(self, source: SessionSource) -> bool:
        """A clarify or approval prompt awaits an answer in this chat's Hermes session."""
        try:
            key = self._source_session_key(source)
            from tools import approval, clarify_gateway

            return bool(
                clarify_gateway.get_pending_for_session(key, include_choice_prompts=True)
                or approval.has_blocking_approval(key)
            )
        except Exception:
            return False

    def _dispatch(self, channel: _Channel, items: list[Item], **kwargs: Any) -> _Dispatch:
        return _Dispatch(f"{self._boot}:{next(self._seq)}", channel, items, **kwargs)

    def _hand_off(self, dispatch: _Dispatch) -> None:
        """Claim the items under the channel lock, then deliver the event from its own task."""
        self._journal.claim(dispatch.ids, dispatch.token)
        self._dispatches[dispatch.token] = dispatch
        if dispatch.automatic:
            self._lane(dispatch.channel.id).inflight = dispatch.token
        task = self._spawn(self._deliver(dispatch))
        self._handoffs.add(task)
        task.add_done_callback(self._handoffs.discard)

    async def _deliver(self, dispatch: _Dispatch) -> None:
        """Build the event (attachments download here, outside the channel lock) and hand it to
        Hermes; a control Hermes handled in place is settled as processed('control')."""
        event = None
        journal = self._journal
        try:
            event = await self._chat_event(dispatch)
            await self.handle_message(event)
        except asyncio.CancelledError:
            self._release(dispatch)
            if event is None:  # never reached Hermes: give the claim back
                self._record(journal.retry_later, dispatch.ids, "cancelled", 0, count_attempt=False)
            raise
        except Exception:
            logger.warning("clawbits: handing a post to Hermes failed; will retry", exc_info=True)
            self._release(dispatch)
            self._record(
                journal.retry_later, dispatch.ids, "dispatch_error", _DISPATCH_RETRY_SECONDS
            )
            return
        dispatch.delivered = True
        if dispatch.inline and not dispatch.started:
            self._release(dispatch)
            self._record(journal.finish, dispatch.ids, "processed", "control")

    def _record(self, write: Callable[..., Any], *args: Any, **kwargs: Any) -> None:
        """A journal write after hand-off; on failure its items wait in processing for review."""
        try:
            write(*args, **kwargs)
        except Exception:
            self._unrecorded = True
            logger.exception("clawbits: could not record a turn outcome; left for restart review")

    def _release(self, dispatch: _Dispatch) -> None:
        self._dispatches.pop(dispatch.token, None)
        lane = self._lane(dispatch.channel.id)
        if lane.inflight == dispatch.token:
            lane.inflight = None

    def _settle(self, dispatch: _Dispatch, outcome: ProcessingOutcome) -> None:
        """Record a turn's outcome on its own items; a shutdown cancel stays for restart review."""
        if outcome is ProcessingOutcome.SUCCESS:
            if len(dispatch.items) > 1:
                self._journal.finish(dispatch.ids[:-1], "processed", "summarized")
            self._journal.finish([dispatch.trigger.id], "processed", "triggered")
        elif outcome is not ProcessingOutcome.CANCELLED:
            self._journal.finish(dispatch.ids, "needs_review", "turn_failed")
        elif not self._stopping:
            self._journal.finish(dispatch.ids, "ignored", "operator_cancelled")

    async def _ack_settled(self, channel: _Channel, source: Source) -> None:
        """Ack the settled prefix (nothing at or past the first unfinished post) to the server."""
        source = self._journal.settle(source)
        if source.settled <= source.acked or not self._mark_read_supported:
            return
        try:
            await asyncio.to_thread(self.client.mark_read, channel.id, source.settled)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if http_status(exc) == 404:
                self._mark_read_supported = False
                logger.info("clawbits: server has no read-pointer endpoint; acks disabled")
            else:
                logger.warning("clawbits: read ack failed for %s", channel.id, exc_info=True)
            return
        self._journal.set_acked(source, source.settled)

    def _session_source(self, channel: _Channel, post: dict[str, Any]) -> SessionSource:
        sender = str(post.get("agent_id") or post.get("user_id") or post.get("human_id") or "")
        return SessionSource(
            platform=Platform("clawbits"),
            chat_id=channel.id,
            chat_name=channel.name,
            chat_type="dm" if self._is_direct_channel(channel) else "channel",
            user_id=sender or None,
            user_name=sender or None,
            message_id=_post_id(post),
        )

    async def _chat_event(self, dispatch: _Dispatch) -> MessageEvent:
        """The trigger's raw text (own @mention stripped, attachment notes added), the trusted
        channel_prompt, the untrusted channel_context and the dispatch token."""
        channel, post = dispatch.channel, dispatch.trigger.payload
        text = str(post.get("message") or "")
        if self._mention_re.search(text):
            text = self._strip_self_mentions(text)
        paths, media_types, notes = await asyncio.to_thread(
            cache_post_attachments, self.client, post
        )
        if notes:
            text = (text.rstrip() + "\n\n" + "\n".join(notes)).strip()
        post_id = _post_id(post)
        if self._inter_agent_mode and not self._is_pair_channel(channel):
            if post.get("agent_id"):
                self._remember_reply_prefix(post_id, f"@{post['agent_id']}")
            elif post.get("poster_display_name"):
                handle = re.sub(r"[^A-Za-z0-9_.-]", "-", str(post["poster_display_name"]).strip())
                self._remember_reply_prefix(post_id, f"@{handle.strip('-')}")
        return MessageEvent(
            text=text,
            message_type=self._message_type_for_media(media_types),
            source=self._session_source(channel, post),
            raw_message=post,
            message_id=post_id,
            media_urls=paths,
            media_types=media_types,
            channel_prompt=_clawbits_channel_prompt(channel.id, self.agent_id),
            channel_context=dispatch.context,
            allow_gateway_control=dispatch.control,
            metadata={_DISPATCH_KEY: dispatch.token},
        )

    async def _greet_once(self) -> None:
        """Post OpenClaw's first-contact greeting to the operator channel, once ever.

        Mirrors ``plugin/src/setup-flow.ts`` ``sendGreeting`` (same wording, same
        operator-name lookup) so a Hermes agent introduces itself exactly like an
        OpenClaw agent does at the end of ITS setup flow. One-shot across gateway
        restarts via a marker file in HERMES_HOME — the signup CLI can't do this
        (it runs before the gateway, when the agent may not even be approved), and
        re-greeting on every boot would hammer the channel. Best-effort: a failure
        is logged and retried on the NEXT boot (marker only written on success),
        never blocking readiness — a mute-but-listening agent beats a hung wizard.
        """
        try:
            marker = self.account.hermes_home / ".clawbits_greeted"
            if marker.exists():
                return
            channel_id = self.fallback_channel_id or await asyncio.to_thread(
                self.client.operator_channel, self.agent_id
            )
            if not channel_id:
                logger.warning("clawbits: no operator channel — skipping greeting")
                return
            info = await asyncio.to_thread(self.client.agent_info, self.agent_id)
            operator = str(info.get("operator_display_name") or "").strip()
            org = str(info.get("org_id") or scoped_setting("CLAWBITS_ORG_ID") or "").strip()
            message = (
                f"Hi {operator}! Agent {self.agent_id} reporting in for {org}."
                if operator
                else f"Greetings from {self.agent_id} to organization {org}!"
            )
            await asyncio.to_thread(self.client.post_message, channel_id, message)
            marker.write_text("", encoding="utf-8")
            logger.info("clawbits: greeted the operator channel %s", channel_id)
        except Exception:
            logger.warning("clawbits: greeting failed — will retry on next boot", exc_info=True)

    @staticmethod
    def _message_type_for_media(media_types: list[str]) -> Any:
        if not media_types:
            return MessageType.TEXT
        first = media_types[0].lower()
        if first.startswith("image/"):
            return MessageType.PHOTO
        if first.startswith("video/"):
            return MessageType.VIDEO
        if first.startswith("audio/"):
            return MessageType.AUDIO
        return MessageType.DOCUMENT

    def _remember_reply_prefix(self, post_id: str, prefix: str) -> None:
        if not prefix:
            return
        self._reply_prefixes[post_id] = prefix
        while len(self._reply_prefixes) > _REPLY_CONTEXT_CAP:
            del self._reply_prefixes[next(iter(self._reply_prefixes))]

    async def _post_guidance_notice(self, channel_id: str, post: dict[str, Any]) -> None:
        sender = str(post.get("agent_id") or "")
        prefix = f"@{sender}" if sender else ""
        message = f"{prefix} {_HUMAN_GUIDANCE_MESSAGE}".strip()
        try:
            await asyncio.to_thread(self.client.post_message, channel_id, message)
        except Exception:
            logger.warning("clawbits: failed to post inter-agent guidance notice", exc_info=True)

    def _strip_self_mentions(self, text: str) -> str:
        """Remove this agent's @mention token(s) and tidy the leftover space.

        Mirrors the OpenClaw plugin's collapseSelfMentions
        (plugin/src/inbound-poller.ts): match on a real word boundary, drop the
        token, then collapse the space/tab run it leaves behind and trim the
        ends. Newlines are left intact so multi-line posts keep their shape.
        """
        stripped = self._mention_re.sub("", text)
        stripped = re.sub(r"[ \t]{2,}", " ", stripped)
        return stripped.strip()

    async def _operator_identity(self) -> tuple[str, str] | None:
        """(operator human id, canonical operator DM id), cached briefly; None if unverifiable.

        Every uncached lookup reports the ``controls`` subsystem, so a run of denied gateway
        commands is readable from status.json instead of only from the log."""
        if self._operator and time.monotonic() - self._operator[2] < _OPERATOR_TTL_SECONDS:
            return self._operator[:2]
        self._operator = None
        try:
            info = await asyncio.to_thread(self.client.agent_info, self.agent_id)
            channel_id = await asyncio.to_thread(self.client.operator_channel, self.agent_id)
        except Exception as exc:
            self._health.fail("controls", exc)
            logger.warning(
                "clawbits: operator identity unavailable; gateway controls denied", exc_info=True
            )
            return None
        email = info.get("operator_email")
        self._operator_email = email if isinstance(email, str) and email else None
        if info.get("operator_id") is None or not channel_id:
            self._health.fail("controls", "operator_unresolved")
            return None
        self._operator = (str(info["operator_id"]), str(channel_id), time.monotonic())
        self._health.ok("controls", state="operator_bound")
        return self._operator[:2]

    async def _operator_contact(self) -> tuple[str | None, str | None]:
        """(operator email, operator DM id) for owner mail and its notices; None when unknown."""
        identity = await self._operator_identity()
        return self._operator_email, identity[1] if identity else self.fallback_channel_id or None

    async def _is_operator_control(self, channel: _Channel, post: dict[str, Any]) -> bool:
        """True only for a post the verified operator (a human) wrote in the operator DM."""
        human_id = post.get("human_id")
        if post.get("agent_id") or human_id is None or channel.channel_type not in {None, "direct"}:
            return False
        return await self._operator_identity() == (str(human_id), channel.id)

    @staticmethod
    def _token(event: MessageEvent) -> str | None:
        return (getattr(event, "metadata", None) or {}).get(_DISPATCH_KEY)

    async def on_processing_start(self, event: MessageEvent) -> None:
        _turn_streams.set(set())
        chat_id = event.source.chat_id
        self._lane(chat_id).running += 1
        if dispatch := self._dispatches.get(self._token(event)):
            dispatch.started = True
        self._heartbeats[event.message_id] = self._spawn(self._generating_heartbeat(chat_id))
        await self._set_status_best_effort(chat_id, "generating")

    async def on_processing_complete(self, event: MessageEvent, outcome: ProcessingOutcome) -> None:
        chat_id = event.source.chat_id
        lane = self._lane(chat_id)
        lane.running = max(0, lane.running - 1)
        # Only this token's hooks settle its items. A delivered dispatch with no start
        # hook is one Hermes absorbed: it frees the lane once the chat is idle, and its
        # items wait for restart review.
        if dispatch := self._dispatches.get(self._token(event)):
            self._record(self._settle, dispatch, outcome)
            self._release(dispatch)
        pending = self._dispatches.get(lane.inflight or "")
        absorbed = pending is None or (pending.delivered and not pending.started)
        if not lane.running and absorbed:
            lane.inflight = None
        self._wake(chat_id)
        heartbeat = self._heartbeats.pop(event.message_id, None)
        if heartbeat is not None:
            heartbeat.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await heartbeat
        # A turn that raised, or produced no final reply, can leave its draft open.
        for message_id in list(_turn_streams.get() or ()):
            if message_id in self._open_streams:
                await self._close_stream_best_effort(
                    self._open_streams[message_id], message_id, "_(reply failed to generate)_"
                )
        if not lane.running:
            await self._set_status_best_effort(chat_id, "online")
