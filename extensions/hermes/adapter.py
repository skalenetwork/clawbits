"""The Clawbits platform adapter: polling, dispatch, presence, delivery.

Everything with a lifecycle lives here — the poll/liveness/WebSocket loops,
turn spawning, status heartbeats, and outbound sends (text and native
images). Pure helpers live in :mod:`.messages`, network-fetch guarding in
:mod:`.media`, and the CLI subprocess wrapper in :mod:`.cli_client`.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
from pathlib import Path
from typing import Any

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import BasePlatformAdapter, MessageEvent, MessageType, SendResult
from gateway.session import SessionSource

from .attachments import cache_post_attachments
from .automations import run_automations_reconciler
from .cli_client import _ClawbitsCli, _default_cli_path
from .email_integration import (
    DEFAULT_EMAIL_POLL_INTERVAL_SECONDS,
    MIN_EMAIL_POLL_INTERVAL_SECONDS,
    _email_uids,
    _EmailReplyContext,
    _is_self_addressed,
    email_reply_context,
    load_email_watermark,
    prepare_email_event,
    save_email_watermark,
    send_email_reply,
)
from .manifest import PLUGIN_VERSION
from .media import _download_to_tempfile
from .messages import (
    _build_agent_body,
    _Channel,
    _extract_channels,
    _extract_control_settings,
    _extract_files,
    _is_user_post,
    _message_id_from_response,
    _parent_post_id_from_metadata,
    _post_cursor_key,
    _post_id,
    _split_message_chunks,
    _trace_id_from_metadata,
)

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "http://localhost:8000"
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

# Upper bound on the post-id dedupe window (self._seen). The set holds only
# posts actually DISPATCHED (plus the first-poll backlog seed) — its job is to
# stop the poll loop and the LobsterTalk nudge path handling the same post
# twice, not to dedupe the poll loop against itself: the per-channel cursor in
# _maybe_dispatch already rejects anything at/below its high-water mark, so an
# id evicted here is still blocked by cursor comparison. This just stops the set
# from growing without bound on a long-lived agent that has processed hundreds
# of thousands of posts.
_SEEN_CAP = 20_000
_REPLY_CONTEXT_CAP = 2_000
_DEFAULT_INTER_AGENT_MESSAGE_LIMIT = 10
_MAX_INTER_AGENT_MESSAGE_LIMIT = 50
_HUMAN_GUIDANCE_MESSAGE = "Nice, but need human guidance to proceed."


def _truthy_env(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _sanitize_activity(text: str) -> str:
    clean = re.sub(r"[\x00-\x1f\x7f]+", " ", str(text or ""))
    clean = re.sub(
        r"(?i)(api[_ -]?key|token|password|secret)\s*[:=]\s*\S+",
        r"\1=[redacted]",
        clean,
    )
    return re.sub(r"\s+", " ", clean).strip()[:160]


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


def _ws_header_kwarg(websockets_module: Any) -> str:
    """Name of the ``websockets.connect`` kwarg that carries extra request headers.

    websockets>=14 renamed ``extra_headers`` to ``additional_headers``. We send
    the agent's Bearer credential as a header (never a URL query param — that
    lands in access logs), so we must attach it under whichever name the
    installed library accepts. The vendored hermes runtime pins
    websockets==15.0.1 (``additional_headers``), but this plugin also installs
    into other hermes venvs, so inspect the signature rather than assume. Falls
    back to the current name if the signature can't be read.
    """
    import inspect

    try:
        params = inspect.signature(websockets_module.connect).parameters
    except (TypeError, ValueError):
        return "additional_headers"
    if "additional_headers" in params:
        return "additional_headers"
    if "extra_headers" in params:
        return "extra_headers"
    return "additional_headers"


class ClawbitsAdapter(BasePlatformAdapter):
    supports_status_text = True
    splits_long_messages = True
    REQUIRES_EDIT_FINALIZE = True

    def __init__(self, config: PlatformConfig) -> None:
        super().__init__(config, Platform("clawbits"))
        extra = config.extra or {}
        self.base_url = str(extra.get("base_url") or os.getenv("CLAWBITS_BASE_URL") or DEFAULT_BASE_URL)
        self.api_key = str(
            config.api_key or config.token or extra.get("api_key") or os.getenv("CLAWBITS_API_KEY") or ""
        )
        self.agent_id = str(extra.get("agent_id") or os.getenv("CLAWBITS_AGENT_ID") or "")
        self.fallback_channel_id = str(
            extra.get("channel_id") or os.getenv("CLAWBITS_CHANNEL_ID") or ""
        )
        # Parse via _env_float, not a bare float(...): a garbage override must
        # fall back to the default with a warning, not crash adapter init.
        self.poll_interval = _env_float(
            extra.get("poll_interval") or os.getenv("CLAWBITS_POLL_INTERVAL"),
            DEFAULT_POLL_INTERVAL_SECONDS,
            "CLAWBITS_POLL_INTERVAL",
        )
        self.liveness_interval = _env_float(
            extra.get("liveness_interval") or os.getenv("CLAWBITS_LIVENESS_INTERVAL"),
            DEFAULT_LIVENESS_INTERVAL_SECONDS,
            "CLAWBITS_LIVENESS_INTERVAL",
        )
        self.email_poll_interval = max(
            MIN_EMAIL_POLL_INTERVAL_SECONDS,
            _env_float(
                extra.get("email_poll_interval") or os.getenv("CLAWBITS_EMAIL_POLL_INTERVAL"),
                DEFAULT_EMAIL_POLL_INTERVAL_SECONDS,
                "CLAWBITS_EMAIL_POLL_INTERVAL",
            ),
        )
        self.cli_path = str(extra.get("agent_cli") or _default_cli_path())
        self.answer = str(extra.get("answer") or os.getenv("CLAWBITS_CHALLENGE_ANSWER") or "") or None
        self.client = _ClawbitsCli(
            self.cli_path,
            self.base_url,
            self.api_key,
            str(extra.get("plugin_version") or os.getenv("CLAWBITS_PLUGIN_VERSION") or PLUGIN_VERSION),
            self.answer,
        )
        self._task: asyncio.Task[None] | None = None
        self._liveness_task: asyncio.Task[None] | None = None
        self._ws_task: asyncio.Task[None] | None = None
        self._email_task: asyncio.Task[None] | None = None
        self._automations_task: asyncio.Task[None] | None = None
        self._automations_wake = asyncio.Event()
        self._loop: asyncio.AbstractEventLoop | None = None
        # In-flight turn tasks (see _spawn_turn) — held so disconnect can cancel
        # them and so the set keeps a strong reference (asyncio only weakly
        # references running tasks; an unreferenced one can be GC'd mid-turn).
        self._turn_tasks: set[asyncio.Task[None]] = set()
        # Insertion-ordered post-id dedupe window (dict, not set) capped at
        # _SEEN_CAP so it can't grow forever; _remember() evicts oldest-first.
        self._seen: dict[str, None] = {}
        self._cursors: dict[str, tuple[int, int, str]] = {}
        self._channels: dict[str, _Channel] = {}
        self._snoozed = False
        self._inter_agent_mode = False
        self._inter_agent_message_limit = _DEFAULT_INTER_AGENT_MESSAGE_LIMIT
        self._consecutive_agent_turns = 0
        self._awaiting_human_guidance = False
        self._guidance_notice_sent = False
        self._reply_prefixes: dict[str, str] = {}
        self._stream_reply_prefixes: dict[str, str] = {}
        self._email_reply_contexts: dict[str, _EmailReplyContext] = {}
        self._stream_email_contexts: dict[str, _EmailReplyContext] = {}
        self._email_watermark = load_email_watermark()
        self._email_mailbox: str | None = None
        self._activity_supported = True
        self._activities: dict[str, dict[str, Any]] = {}
        # Word-boundary @mention matcher, compiled once. A naive
        # ``f"@{agent_id}" in text`` false-positives when this agent's id is a
        # prefix of another (``@agent_1`` inside ``@agent_12``) and never lets
        # us strip the token. The lookarounds pin the match to a real boundary;
        # mirrors the OpenClaw plugin's mentionRegex (plugin/src/inbound-poller.ts).
        self._mention_re = re.compile(rf"(?<!\w)@{re.escape(self.agent_id)}(?!\w)")
        # Set after the first full successful poll (channels discovered, cursors
        # seeded) — the point at which the agent can actually receive a message.
        # The liveness loop waits on it, so "available" in Clawbits means ready,
        # not merely running. Survives a reconnect on this instance on purpose.
        self._ready = asyncio.Event()

    # is_reconnect (gateway API since hermes 0.18) is accepted but unused: we poll
    # with client-side cursors (_cursors/_seen survive a reconnect on this instance),
    # so there is no server-side queue to drop or preserve — the base class allows
    # queue-less adapters to ignore the flag.
    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if not self.api_key or not self.agent_id:
            logger.error("Clawbits needs CLAWBITS_API_KEY and CLAWBITS_AGENT_ID")
            return False
        if not Path(self.cli_path).exists():
            logger.error("Clawbits agent CLI not found: %s", self.cli_path)
            return False
        self._running = True
        self._loop = asyncio.get_running_loop()
        self._task = asyncio.create_task(self._poll_loop())
        self._liveness_task = asyncio.create_task(self._liveness_loop())
        self._ws_task = asyncio.create_task(self._lobstertalk_ws_loop())
        if _truthy_env("CLAWBITS_EMAIL_ENABLED", True):
            self._email_task = asyncio.create_task(self._email_loop())
        self._automations_task = asyncio.create_task(
            run_automations_reconciler(
                self.client,
                self.agent_id,
                self.fallback_channel_id,
                self._automations_wake,
                lambda: self._running,
            )
        )
        logger.info("Clawbits adapter connected to %s", self.base_url)
        return True

    async def disconnect(self) -> None:
        self._running = False
        for attr in (
            "_task",
            "_liveness_task",
            "_ws_task",
            "_email_task",
            "_automations_task",
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
        # In-flight turns die with the platform — they'd have nowhere to
        # deliver anyway, and a clarify-blocked one would otherwise linger.
        for task in list(self._turn_tasks):
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        self._turn_tasks.clear()
        self._loop = None

    def set_status_text(self, chat_id: str, text: str | None) -> None:
        """Map Hermes's live tool phrase onto Clawbits's ephemeral activity lane."""
        super().set_status_text(chat_id, text)
        loop = self._loop
        if loop is None or not loop.is_running():
            return
        label = _sanitize_activity(text or "")
        words = label.split()
        activity = (
            {
                "kind": "tool",
                "label": label,
                "tool": words[1][:64] if len(words) > 1 else None,
            }
            if label
            else {"kind": "generating", "label": ""}
        )
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
                activity if self._activity_supported else None,
            )
        except Exception as exc:
            if self._activity_supported and activity and "HTTP 422" in str(exc):
                self._activity_supported = False
                logger.info("clawbits: server rejected live activity; using plain presence")
                try:
                    await asyncio.to_thread(self.client.set_status, chat_id, "generating")
                    return
                except Exception:
                    pass
            logger.debug("Clawbits activity update failed", exc_info=True)

    def _prefix_for_reply(self, reply_to: str | None) -> str:
        return self._reply_prefixes.get(str(reply_to or ""), "")

    @staticmethod
    def _with_prefix(content: str, prefix: str) -> str:
        if not prefix or content.lstrip().startswith(prefix):
            return content
        return f"{prefix} {content}".strip()

    async def _send_email_response(
        self,
        chat_id: str,
        context: _EmailReplyContext,
        content: str,
    ) -> SendResult:
        """Email the owner, then mirror the sent response into their DM."""
        raw = await asyncio.to_thread(
            send_email_reply, self.client, self.agent_id, context, content
        )
        mirror: Any = None
        try:
            mirror = await asyncio.to_thread(self.client.post_message, chat_id, content)
        except Exception:
            logger.warning("clawbits: email sent but DM mirror failed", exc_info=True)
        return SendResult(
            success=True,
            message_id=_message_id_from_response(mirror) or f"email:{context.uid}",
            raw_response=raw,
        )

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> SendResult:
        metadata = metadata or {}
        reply_key = str(reply_to or "")

        # Hermes exposes scratch-thinking through thinking_progress. Keep it
        # ephemeral: convert the bubble into activity and report no chat post.
        if (
            content.startswith("💬 ")
            and metadata.get("notify") is not True
            and metadata.get("expect_edits") is not True
        ):
            await self._set_activity_best_effort(
                chat_id,
                {"kind": "thinking", "label": _sanitize_activity(content[2:])},
            )
            return SendResult(success=True)

        email_context = self._email_reply_contexts.get(reply_key)
        expect_edits = metadata.get("expect_edits") is True
        if email_context and not expect_edits:
            try:
                return await self._send_email_response(chat_id, email_context, content)
            except Exception as exc:
                logger.exception("Clawbits email reply failed")
                return SendResult(success=False, error=str(exc), retryable=False)

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
                    raise RuntimeError(f"streaming post returned no id: {raw!r}")
                if visible_content:
                    await asyncio.to_thread(
                        self.client.patch_message,
                        chat_id,
                        message_id,
                        replace=visible_content,
                    )
                if prefix:
                    self._stream_reply_prefixes[message_id] = prefix
                if email_context:
                    self._stream_email_contexts[message_id] = email_context
                return SendResult(success=True, message_id=message_id, raw_response=raw)

            raw: Any = None
            for chunk in _split_message_chunks(visible_content) or [""]:
                dispatched = True
                raw = await asyncio.to_thread(
                    self.client.post_message, chat_id, chunk, parent_post_id, trace_id
                )
            return SendResult(success=True, message_id=_message_id_from_response(raw), raw_response=raw)
        except Exception as exc:
            logger.exception("Clawbits send failed")
            return SendResult(success=False, error=str(exc), retryable=not dispatched)
        finally:
            # A stream remains generating until _run_turn finishes.
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
        prefix = self._stream_reply_prefixes.get(str(message_id), "")
        visible_content = self._with_prefix(content, prefix)
        email_context = self._stream_email_contexts.get(str(message_id))
        email_sent = False
        try:
            if finalize and email_context:
                await asyncio.to_thread(
                    send_email_reply,
                    self.client,
                    self.agent_id,
                    email_context,
                    content,
                )
                email_sent = True
            raw = await asyncio.to_thread(
                self.client.patch_message,
                chat_id,
                message_id,
                replace=visible_content,
                done=finalize,
            )
            if finalize:
                self._stream_reply_prefixes.pop(str(message_id), None)
                self._stream_email_contexts.pop(str(message_id), None)
            return SendResult(success=True, message_id=str(message_id), raw_response=raw)
        except Exception as exc:
            logger.warning("clawbits: streaming post edit failed", exc_info=True)
            # Email is the primary delivery for an email-triggered turn. Avoid a
            # gateway fallback that would send the same email twice merely
            # because its cosmetic DM mirror failed to finalize.
            if email_sent:
                return SendResult(success=True, message_id=str(message_id))
            return SendResult(success=False, error=str(exc), retryable=True)

    async def delete_message(self, chat_id: str, message_id: str) -> bool:
        try:
            await asyncio.to_thread(
                self.client.patch_message, chat_id, message_id, cancel=True
            )
            self._stream_reply_prefixes.pop(str(message_id), None)
            self._stream_email_contexts.pop(str(message_id), None)
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
        while self._running:
            try:
                await self._poll_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Clawbits poll failed")
            await asyncio.sleep(self.poll_interval)

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
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning("Clawbits liveness ping failed", exc_info=True)
            await asyncio.sleep(self.liveness_interval)

    async def _set_status_best_effort(self, chat_id: str, status: str) -> None:
        if status != "generating":
            self._activities.pop(chat_id, None)
        activity = self._activities.get(chat_id) if status == "generating" else None
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
                await self._set_status_best_effort(chat_id, "generating")
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
            self._consecutive_agent_turns = 0
            self._awaiting_human_guidance = False
            self._guidance_notice_sent = False

    async def _dispatch_realtime_post(self, event: dict[str, Any]) -> None:
        post = event.get("data")
        if not isinstance(post, dict):
            return
        channel_id = str(event.get("channel_id") or post.get("channel_id") or "")
        if not channel_id:
            return
        channel = self._channels.get(channel_id) or _Channel(channel_id, None, channel_id)
        await self._maybe_dispatch(channel, post)

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
        cooldown). Everything else stays on the poll loop: posts arrive there
        with cursor/seen dedupe, so this loop deliberately ignores
        ``post.created`` and every other event type rather than introducing a
        second delivery path for the same messages.

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
            return
        # Authenticate via header, not URL query param (keeps the key out of
        # access logs). The kwarg name differs by websockets version — >=14
        # calls it ``additional_headers``, older releases ``extra_headers`` —
        # so resolve it once against the installed library (see _ws_header_kwarg).
        auth_headers = {"Authorization": f"Bearer {self.api_key}"}
        header_kwarg = _ws_header_kwarg(websockets)
        backoff = 1.0
        while self._running:
            try:
                async with websockets.connect(
                    self._events_ws_url(),
                    ping_interval=20,
                    max_size=2**22,
                    **{header_kwarg: auth_headers},
                ) as ws:
                    logger.info("clawbits: agent events WebSocket connected (LobsterTalk nudges live)")
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
                            self._apply_controls(event.get("data"))
                        elif event_type == "post.created":
                            await self._dispatch_realtime_post(event)
                        elif event_type == "automation.sync":
                            self._automations_wake.set()
                        elif event_type in ("lobstertalk.consider", "mutualist.consider"):
                            await self._dispatch_attention(event)
            except asyncio.CancelledError:
                raise
            except Exception:
                if not self._running:
                    break
                logger.warning(
                    "clawbits: events WebSocket dropped; reconnecting in %.0fs", backoff, exc_info=True
                )
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60.0)

    async def _dispatch_attention(self, event: dict[str, Any]) -> None:
        """Turn a ``lobstertalk.consider`` control event into an agent turn.

        The event carries the same post payload as ``post.created`` plus the
        channel id. The server has already applied the heavy gates (attention
        route win, per-agent opt-in, snooze, @mention, own-post, cooldown);
        client-side we only dedupe against the poll loop and skip empties.
        The attention preamble frames the turn as reply-only-if-useful.
        ``raw_message``/``message_id`` carry the triggering post id, so the
        reply threads under it via ``_parent_post_id_from_metadata``."""
        post = event.get("data")
        if not isinstance(post, dict):
            return
        channel_id = str(event.get("channel_id") or post.get("channel_id") or "") or self.fallback_channel_id
        post_id = _post_id(post)
        text = str(post.get("message") or "").strip()
        if not channel_id or not post_id or not text or self._snoozed:
            return
        if post_id in self._seen:
            return
        post_agent_id = str(post.get("agent_id") or "")
        if post_agent_id == self.agent_id:
            return  # own post — server skips these already; stay safe
        if post_agent_id and not self._inter_agent_mode:
            return
        if post_agent_id:
            if (
                self._awaiting_human_guidance
                or self._consecutive_agent_turns >= self._inter_agent_message_limit
            ):
                self._awaiting_human_guidance = True
                self._remember(post_id)
                if not self._guidance_notice_sent:
                    self._guidance_notice_sent = True
                    await self._post_guidance_notice(channel_id, post)
                return
            self._consecutive_agent_turns += 1
            self._remember_reply_prefix(post_id, f"@{post_agent_id}")
        self._remember(post_id)
        sender_id = str(post.get("agent_id") or post.get("user_id") or post.get("human_id") or "")
        source = SessionSource(
            platform=Platform("clawbits"),
            chat_id=channel_id,
            chat_type="channel",
            user_id=sender_id or None,
            user_name=sender_id or None,
            message_id=post_id,
        )
        logger.info(
            "clawbits: LobsterTalk nudge for post %s in %s — dispatching attention turn", post_id, channel_id
        )
        # Same non-blocking dispatch as the poll loop: an attention turn that
        # blocks (clarify, long tools) must not freeze the events WebSocket.
        paths, media_types, notes = await asyncio.to_thread(
            cache_post_attachments, self.client, post
        )
        if notes:
            text = f"{text}\n\n" + "\n".join(notes)
        self._spawn_turn(
            channel_id,
            MessageEvent(
                text=_build_agent_body(
                    text,
                    chat_id=channel_id,
                    agent_id=self.agent_id or None,
                    attention_preamble=_ATTENTION_PREAMBLE,
                ),
                message_type=self._message_type_for_media(media_types),
                source=source,
                raw_message=post,
                message_id=post_id,
                media_urls=paths,
                media_types=media_types,
            ),
        )

    async def _poll_once(self) -> None:
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
            logger.warning("Clawbits channel discovery failed; using fallback channel", exc_info=True)
            channels = [_Channel(self.fallback_channel_id, None, "Clawbits")]
        if not channels and self.fallback_channel_id:
            channels = [_Channel(self.fallback_channel_id, None, "Clawbits")]
        self._channels = {channel.id: channel for channel in channels}
        for channel in channels:
            posts = await asyncio.to_thread(self.client.get_posts, channel.id)
            if channel.id not in self._cursors:
                self._cursors[channel.id] = max((_post_cursor_key(post) for post in posts), default=(0, 0, ""))
                for post in posts:
                    if post_id := _post_id(post):
                        self._remember(post_id)
                continue
            for post in posts:
                await self._maybe_dispatch(channel, post)
        if not self._ready.is_set():
            # First full pass done: every channel is cursor-seeded, so anything
            # posted from here on is dispatched, not swallowed as backlog. Greet
            # BEFORE unblocking the liveness loop — the operator must find the
            # greeting already in the channel when the wizard says "available".
            await self._greet_once()
            self._ready.set()

    async def _email_loop(self) -> None:
        while self._running:
            try:
                await self._poll_email_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                detail = str(exc).lower()
                if "not configured" in detail or "503" in detail:
                    logger.info("clawbits: email is not configured; email poller stopped")
                    return
                logger.warning("clawbits: email poll failed", exc_info=True)
            await asyncio.sleep(self.email_poll_interval)

    async def _poll_email_once(self) -> None:
        counts = await asyncio.to_thread(self.client.email_count, self.agent_id)
        mailbox = counts.get("email_address")
        if isinstance(mailbox, str) and mailbox:
            self._email_mailbox = mailbox

        watermark = self._email_watermark
        offset = 0
        page_size = 50
        uids: set[int] = set()
        while offset < page_size * 20:
            listing = await asyncio.to_thread(
                self.client.email_inbox, self.agent_id, page_size, offset
            )
            page = _email_uids(listing)
            uids.update(page)
            if len(page) < page_size or (watermark is not None and page and min(page) <= watermark):
                break
            offset += page_size

        ordered = sorted(uids)
        if watermark is None:
            seed = ordered[-1] if ordered else 0
            save_email_watermark(seed)
            self._email_watermark = seed
            logger.info("clawbits: email watermark seeded at uid %s", seed)
            return

        channel_id = self.fallback_channel_id
        if not channel_id:
            channel_id = str(
                await asyncio.to_thread(self.client.operator_channel, self.agent_id) or ""
            )
        if not channel_id:
            raise RuntimeError("no operator channel available for email dispatch")

        for uid in (value for value in ordered if value > watermark):
            detail = await asyncio.to_thread(self.client.email_get, self.agent_id, uid)
            if _is_self_addressed(detail, self.agent_id, self._email_mailbox):
                save_email_watermark(uid)
                self._email_watermark = uid
                continue
            text, paths, media_types = await asyncio.to_thread(prepare_email_event, detail)
            message_id = f"email:{uid}"
            self._email_reply_contexts[message_id] = email_reply_context(detail)
            while len(self._email_reply_contexts) > _REPLY_CONTEXT_CAP:
                del self._email_reply_contexts[next(iter(self._email_reply_contexts))]
            sender = str(detail.get("from_addr") or "owner")
            source = SessionSource(
                platform=Platform("clawbits"),
                chat_id=channel_id,
                chat_name="Clawbits email",
                chat_type="dm",
                user_id=sender,
                user_name=sender,
                message_id=message_id,
            )
            event = MessageEvent(
                text=_build_agent_body(
                    text,
                    chat_id=channel_id,
                    agent_id=self.agent_id or None,
                ),
                message_type=self._message_type_for_media(media_types),
                source=source,
                raw_message={**detail, "_clawbits_email_uid": uid},
                message_id=message_id,
                media_urls=paths,
                media_types=media_types,
            )
            self._spawn_turn(channel_id, event)
            save_email_watermark(uid)
            self._email_watermark = uid

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
            # Runtime-only import (also why it sits inside the try: the module
            # exists in the hermes venv, not wherever unit tests import us from).
            from hermes_constants import get_hermes_home

            marker = Path(get_hermes_home()) / ".clawbits_greeted"
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
            org = str(info.get("org_id") or os.getenv("CLAWBITS_ORG_ID") or "").strip()
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

    def _remember(self, post_id: str) -> None:
        """Record ``post_id`` as seen, evicting oldest ids past ``_SEEN_CAP``.

        ``self._seen`` is insertion-ordered, so the first key is the oldest;
        popping it drops the stalest entry once we exceed the cap. Eviction is
        safe: the per-channel cursor already blocks anything old, so a
        forgotten id can't be re-dispatched (see the _seen / _SEEN_CAP notes).
        """
        if post_id in self._seen:
            return
        self._seen[post_id] = None
        while len(self._seen) > _SEEN_CAP:
            del self._seen[next(iter(self._seen))]

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

    async def _maybe_dispatch(self, channel: _Channel, post: dict[str, Any]) -> None:
        post_id = _post_id(post)
        if not post_id or post_id in self._seen:
            return
        key = _post_cursor_key(post)
        cursor = self._cursors.setdefault(channel.id, (0, 0, ""))
        if key <= cursor:
            # Deliberately NOT remembered — see the note below; the cursor
            # comparison alone already stops the poll loop re-processing this.
            return
        self._cursors[channel.id] = max(cursor, key)

        if self._snoozed:
            return

        text = str(post.get("message") or "")
        has_files = bool(_extract_files(post))
        sender_id = str(post.get("agent_id") or post.get("user_id") or post.get("human_id") or "")
        is_self = sender_id == self.agent_id or post.get("agent_id") == self.agent_id
        is_agent_authored = bool(post.get("agent_id"))
        is_direct = channel.channel_type in {None, "direct"} or channel.id == self.fallback_channel_id
        mentioned = bool(self._mention_re.search(text))

        if mentioned and not is_agent_authored:
            self._consecutive_agent_turns = 0
            self._awaiting_human_guidance = False
            self._guidance_notice_sent = False

        if (
            is_self
            or not _is_user_post(post)
            or (not text.strip() and not has_files)
            or not (is_direct or mentioned)
            or (is_agent_authored and not self._inter_agent_mode)
        ):
            return

        if is_agent_authored:
            if (
                self._awaiting_human_guidance
                or self._consecutive_agent_turns >= self._inter_agent_message_limit
            ):
                self._awaiting_human_guidance = True
                self._remember(post_id)
                if not self._guidance_notice_sent:
                    self._guidance_notice_sent = True
                    await self._post_guidance_notice(channel.id, post)
                return
            self._consecutive_agent_turns += 1

        # Only DISPATCHED posts go in the dedupe set, and only here — past every
        # skip above. ``self._seen`` exists to stop the poll loop and the
        # LobsterTalk nudge path double-dispatching the same post; it is not the
        # poll loop's own dedupe (the per-channel cursor is, which is why the
        # skips above deliberately don't record anything).
        #
        # Marking every post seen the moment we looked at it — as this did
        # before — silently broke attention nudges: a channel post the agent
        # isn't mentioned in is skipped here, but the server still runs triage
        # on it and publishes a nudge seconds later. That nudge then hit
        # ``post_id in self._seen`` in _dispatch_attention and was dropped, so
        # the whole feature was inert on this runtime. The poll loop always won
        # the race — it polls every ~3s while a nudge waits on an LLM triage
        # call. Mirrors plugin/src/inbound-poller.ts, which records only posts
        # it actually dispatches for exactly this reason.
        self._remember(post_id)

        # Strip our own @mention from the text the MODEL sees: the mention token
        # is addressing metadata, not content (the fact we were tagged is already
        # implied by dispatch), and leaving it in nudges the model to echo it
        # back. raw_message keeps the untouched post so threading/parent lookups
        # still see the original. Only strip when actually mentioned — a plain DM
        # carries no mention token and its whitespace must be left alone.
        event_text = self._strip_self_mentions(text) if mentioned else text
        paths, media_types, notes = await asyncio.to_thread(
            cache_post_attachments, self.client, post
        )
        if notes:
            event_text = (event_text.rstrip() + "\n\n" + "\n".join(notes)).strip()

        if self._inter_agent_mode and not is_direct:
            if post.get("agent_id"):
                self._remember_reply_prefix(post_id, f"@{post['agent_id']}")
            elif post.get("poster_display_name"):
                handle = re.sub(r"[^A-Za-z0-9_.-]", "-", str(post["poster_display_name"]).strip())
                self._remember_reply_prefix(post_id, f"@{handle.strip('-')}")

        source = SessionSource(
            platform=Platform("clawbits"),
            chat_id=channel.id,
            chat_name=channel.name,
            chat_type="dm" if is_direct else "channel",
            user_id=sender_id or None,
            user_name=sender_id or None,
            message_id=post_id,
        )
        event = MessageEvent(
            # Same context block as the attention path (and as the OpenClaw
            # plugin): the agent should know what it is and where it is on
            # every turn, not only when a nudge brought it here.
            text=_build_agent_body(
                event_text,
                chat_id=channel.id,
                agent_id=self.agent_id or None,
            ),
            message_type=self._message_type_for_media(media_types),
            source=source,
            raw_message=post,
            message_id=post_id,
            media_urls=paths,
            media_types=media_types,
        )
        # Dispatch the turn as a BACKGROUND task — never await it here. The
        # gateway resolves mid-turn interactions (clarify answers, messages
        # queued into a busy session) through this same inbound path, so the
        # poll loop must keep receiving while a turn runs. Awaiting the turn
        # inline deadlocked exactly that: a clarify-blocked turn froze the
        # poll loop, so the answer it was waiting for could never arrive —
        # the agent sat posting "⏳ Working — N min" until the clarify timed
        # out, and every later message went unread. Cross-session ordering is
        # the gateway's job (it queues per-session); tasks here just deliver.
        self._spawn_turn(channel.id, event)

    def _spawn_turn(self, channel_id: str, event: MessageEvent) -> None:
        task = asyncio.create_task(self._run_turn(channel_id, event))
        self._turn_tasks.add(task)
        task.add_done_callback(self._turn_tasks.discard)

    async def _run_turn(self, channel_id: str, event: MessageEvent) -> None:
        # The whole turn (model + tools + delivery) runs inside handle_message.
        # Light the "generating" pill up front and heartbeat it for the turn's
        # duration so a slow turn (image generation especially) keeps showing
        # activity instead of going dark ~15s in when the presence TTL lapses.
        #
        # The initial status set is a SCHEDULED task, not awaited: this
        # coroutine's first await must be handle_message itself, so turns
        # spawned in poll order enter the gateway's session layer in that
        # order (an awaited to_thread here let a later post's turn overtake
        # an earlier one). The write itself still lands ~immediately.
        status = asyncio.create_task(self._set_status_best_effort(channel_id, "generating"))
        heartbeat = asyncio.create_task(self._generating_heartbeat(channel_id))
        try:
            await self.handle_message(event)
        except asyncio.CancelledError:
            raise
        except Exception:
            # A failed turn must not go unlogged: nothing awaits this task, so
            # an uncaught exception would otherwise vanish into the done-callback.
            logger.exception("clawbits: turn failed for channel %s", channel_id)
        finally:
            heartbeat.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await heartbeat
            # Let the initial set finish first so a fast turn's final "online"
            # can't be overwritten by its own late "generating".
            with contextlib.suppress(Exception):
                await status
            await self._set_status_best_effort(channel_id, "online")
