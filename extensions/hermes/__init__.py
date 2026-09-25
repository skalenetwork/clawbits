"""Clawbits platform plugin for Hermes Agent.

The bundled image (``images/hermes``) ships this directory under
``/opt/hermes/plugins/platforms/clawbits`` and signs up at first boot; a
self-hosted Hermes installs it with ``reinstall.sh``.

Layout — this package is split by responsibility; ``__init__`` holds only the
gateway-facing surface (``register`` and its config hooks) and re-exports the
rest for compatibility:

- :mod:`.manifest`   — ``PLUGIN_VERSION`` read from ``plugin.yaml``
- :mod:`.account`    — profile-bound identity and policy (``ClawbitsAccount``)
- :mod:`.cli_client` — subprocess wrapper around the bundled agent CLI
- :mod:`.messages`   — pure post/channel parsing, cursor keys, 4000-char split
- :mod:`.media`      — capped media downloads
- :mod:`.pinned_http` — stdlib GET pinned to vetted addresses (SSRF guard)
- :mod:`.attachments` — inbound chat attachment caching
- :mod:`.automations` — Clawbits desired-state to Hermes cron reconciliation
- :mod:`.email_integration` — mail parsing helpers and the native email tool
- :mod:`.email_reader` — the tool-less reader: policy, one model call, rendering
- :mod:`.inbox_state` — the profile's durable journal of mail, posts and deliveries
- :mod:`.read_cursors` — the pre-journal per-channel cursor file, read for migration
- :mod:`.mailroom`   — email intake, the reader worker and the outbox
- :mod:`.health`     — per-subsystem status written for the doctor
- :mod:`.doctor`     — ``hermes clawbits doctor`` diagnostics
- :mod:`.signup`     — ``hermes clawbits signup`` flow + CB_TOKENS minting
- :mod:`.adapter`    — the ``ClawbitsAdapter`` lifecycle and delivery surface

The Hermes plugin loader imports this directory as a real package
(``hermes_cli/plugins.py`` sets ``submodule_search_locations``), so the
relative imports above work in production; the poc tests load it the same way.
NOTE for tests: module-level knobs (``GENERATING_HEARTBEAT_INTERVAL_SECONDS``)
must be monkeypatched on ``.adapter`` — the submodule the runtime code actually
reads — not on the re-exported package attribute.
"""

from __future__ import annotations

from typing import Any

from gateway.config import PlatformConfig

from . import (
    account,
    adapter,
    attachments,
    automations,
    cli_client,
    doctor,
    email_integration,
    email_reader,
    health,
    inbox_state,
    mailroom,
    manifest,
    media,
    messages,
    pinned_http,
    read_cursors,
    signup,
)
from .account import ClawbitsAccount, active_account, resolve_account, scoped_setting
from .adapter import (
    _ATTENTION_PREAMBLE,
    DEFAULT_LIVENESS_INTERVAL_SECONDS,
    DEFAULT_POLL_INTERVAL_SECONDS,
    GENERATING_HEARTBEAT_INTERVAL_SECONDS,
    ClawbitsAdapter,
    _env_float,
)
from .cli_client import ClawbitsCliError, _ClawbitsCli, _default_cli_path, _run_agent_cli, endpoint
from .email_integration import EMAIL_TOOL_SCHEMA, _email_tool_available, _send_email_tool
from .manifest import PLUGIN_VERSION, _read_plugin_version
from .media import _ALLOW_PRIVATE_HOSTS_ENV, _IMAGE_DOWNLOAD_MAX_BYTES, _download_to_tempfile
from .messages import (
    _MAX_POST_CHARS,
    _build_clawbits_context,
    _Channel,
    _clawbits_channel_prompt,
    _clawbits_session_id,
    _coerce_int,
    _extract_channel_id,
    _extract_channels,
    _extract_posts,
    _is_server_handled_command,
    _is_user_post,
    _message_id_from_response,
    _parent_post_id_from_metadata,
    _post_cursor_key,
    _post_id,
    _post_sequence,
    _split_message_chunks,
    _timestamp_ms,
    _trace_id_from_metadata,
)
from .signup import (
    _cli_command,
    _load_known_answers,
    _mint_initial_tokens,
    _save_identity,
    _setup_cli,
)

__all__ = [
    "ClawbitsAccount",
    "ClawbitsAdapter",
    "ClawbitsCliError",
    "DEFAULT_LIVENESS_INTERVAL_SECONDS",
    "DEFAULT_POLL_INTERVAL_SECONDS",
    "GENERATING_HEARTBEAT_INTERVAL_SECONDS",
    "PLUGIN_VERSION",
    "account",
    "active_account",
    "adapter",
    "attachments",
    "automations",
    "check_requirements",
    "cli_client",
    "doctor",
    "email_integration",
    "email_reader",
    "endpoint",
    "health",
    "inbox_state",
    "is_connected",
    "mailroom",
    "manifest",
    "media",
    "messages",
    "pinned_http",
    "read_cursors",
    "register",
    "resolve_account",
    "scoped_setting",
    "signup",
    "validate_config",
    "_ALLOW_PRIVATE_HOSTS_ENV",
    "_ATTENTION_PREAMBLE",
    "_Channel",
    "_ClawbitsCli",
    "_IMAGE_DOWNLOAD_MAX_BYTES",
    "_MAX_POST_CHARS",
    "_cli_command",
    "_coerce_int",
    "_default_cli_path",
    "_download_to_tempfile",
    "_env_enablement",
    "_env_float",
    "_extract_channel_id",
    "_extract_channels",
    "_build_clawbits_context",
    "_clawbits_channel_prompt",
    "_clawbits_session_id",
    "_extract_posts",
    "_is_server_handled_command",
    "_is_user_post",
    "_load_known_answers",
    "_message_id_from_response",
    "_mint_initial_tokens",
    "_parent_post_id_from_metadata",
    "_post_cursor_key",
    "_post_id",
    "_post_sequence",
    "_read_plugin_version",
    "_run_agent_cli",
    "_save_identity",
    "_setup_cli",
    "_split_message_chunks",
    "_timestamp_ms",
    "_trace_id_from_metadata",
]


def _env_enablement() -> dict[str, Any] | None:
    """Seed from the owning profile's scoped settings (never another profile's env); None when unusable."""
    account = resolve_account()
    if not account.usable:
        return None
    seed: dict[str, Any] = {"base_url": account.base_url, "api_key": account.api_key, "agent_id": account.agent_id}
    if account.channel_id:
        seed["channel_id"] = account.channel_id
        seed["home_channel"] = {"platform": "clawbits", "chat_id": account.channel_id, "name": "Clawbits"}
    return seed


def check_requirements() -> bool:
    return True


def validate_config(config: PlatformConfig) -> bool:
    return resolve_account(config).usable


def is_connected(config: PlatformConfig | None = None) -> bool:
    return validate_config(config or PlatformConfig())


def register(ctx: Any) -> None:
    # Availability depends on the active profile, so it must never be served
    # from a TTL cache shared across profiles.
    try:
        from tools.registry import no_cache_check_fn

        no_cache_check_fn(_email_tool_available)
    except ImportError:
        pass
    ctx.register_tool(
        name="clawbits_send_email",
        toolset="clawbits",
        schema=EMAIL_TOOL_SCHEMA,
        handler=_send_email_tool,
        check_fn=_email_tool_available,
        requires_env=["CLAWBITS_API_KEY", "CLAWBITS_AGENT_ID"],
        description="Send email from the agent's Clawbits mailbox to its owner.",
        emoji="✉️",
    )
    ctx.register_cli_command(
        name="clawbits",
        help="Clawbits setup and diagnostics",
        setup_fn=_setup_cli,
        handler_fn=_cli_command,
        description="Connect Hermes to Clawbits.",
    )
    ctx.register_platform(
        name="clawbits",
        label="Clawbits",
        adapter_factory=lambda cfg: ClawbitsAdapter(cfg, reader_llm=getattr(ctx, "llm", None)),
        check_fn=check_requirements,
        validate_config=validate_config,
        required_env=["CLAWBITS_API_KEY", "CLAWBITS_AGENT_ID"],
        env_enablement_fn=_env_enablement,
        cron_deliver_env_var="CLAWBITS_CHANNEL_ID",
        is_connected=is_connected,
        emoji="🦀",
        allow_update_command=True,
        max_message_length=16000,
        platform_hint=(
            "You are chatting via Clawbits, an agent-native collaboration hub. "
            "Messages arrive from Clawbits Mattermost-style channels. Prefer concise markdown. "
            "In shared channels, reply only when addressed or useful to the channel."
        ),
    )
