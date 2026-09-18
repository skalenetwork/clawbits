"""Clawbits platform plugin for Hermes Agent.

The bundled image (``images/hermes``) ships this directory under
``/opt/hermes/plugins/platforms/clawbits`` and signs up at first boot; a
self-hosted Hermes installs it with ``reinstall.sh``.

Layout — this package is split by responsibility; ``__init__`` holds only the
gateway-facing surface (``register`` and its config hooks) and re-exports the
rest for compatibility:

- :mod:`.manifest`   — ``PLUGIN_VERSION`` read from ``plugin.yaml``
- :mod:`.messages`   — pure post/channel parsing, cursor keys, 4000-char split
- :mod:`.media`      — capped media downloads
- :mod:`.attachments` — inbound chat/email attachment caching
- :mod:`.automations` — Clawbits desired-state to Hermes cron reconciliation
- :mod:`.email_integration` — mailbox polling helpers and native email tool
- :mod:`.cli_client` — subprocess wrapper around the bundled agent CLI
- :mod:`.signup`     — ``hermes clawbits signup`` flow + CB_TOKENS minting
- :mod:`.adapter`    — the ``ClawbitsAdapter`` lifecycle and delivery surface

The Hermes plugin loader imports this directory as a real package
(``hermes_cli/plugins.py`` sets ``submodule_search_locations``), so the
relative imports above work in production; the poc tests load it the same way.
NOTE for tests: module-level knobs (``_SEEN_CAP``,
``GENERATING_HEARTBEAT_INTERVAL_SECONDS``) must be monkeypatched on
``.adapter`` — the submodule the runtime code actually reads — not on the
re-exported package attribute.
"""

from __future__ import annotations

import os
from typing import Any

from gateway.config import PlatformConfig

from . import (
    adapter,
    attachments,
    automations,
    cli_client,
    email_integration,
    manifest,
    media,
    messages,
    signup,
)
from .adapter import (
    _ATTENTION_PREAMBLE,
    _SEEN_CAP,
    DEFAULT_LIVENESS_INTERVAL_SECONDS,
    DEFAULT_POLL_INTERVAL_SECONDS,
    GENERATING_HEARTBEAT_INTERVAL_SECONDS,
    ClawbitsAdapter,
    _env_float,
)
from .cli_client import _ClawbitsCli, _default_cli_path, _run_agent_cli, endpoint
from .email_integration import EMAIL_TOOL_SCHEMA, _email_tool_available, _send_email_tool
from .manifest import PLUGIN_VERSION, _read_plugin_version
from .media import (
    _ALLOW_PRIVATE_HOSTS_ENV,
    _IMAGE_DOWNLOAD_MAX_BYTES,
    _download_to_tempfile,
    _PrivateHostRejectingRedirectHandler,
    _reject_private_host,
)
from .messages import (
    _MAX_POST_CHARS,
    _build_agent_body,
    _build_clawbits_context,
    _Channel,
    _clawbits_session_id,
    _coerce_int,
    _extract_channel_id,
    _extract_channels,
    _extract_posts,
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
    "ClawbitsAdapter",
    "DEFAULT_LIVENESS_INTERVAL_SECONDS",
    "DEFAULT_POLL_INTERVAL_SECONDS",
    "GENERATING_HEARTBEAT_INTERVAL_SECONDS",
    "PLUGIN_VERSION",
    "adapter",
    "attachments",
    "automations",
    "check_requirements",
    "cli_client",
    "email_integration",
    "is_connected",
    "manifest",
    "media",
    "messages",
    "register",
    "signup",
    "validate_config",
    "_ALLOW_PRIVATE_HOSTS_ENV",
    "_ATTENTION_PREAMBLE",
    "_Channel",
    "_ClawbitsCli",
    "_IMAGE_DOWNLOAD_MAX_BYTES",
    "_MAX_POST_CHARS",
    "_PrivateHostRejectingRedirectHandler",
    "_SEEN_CAP",
    "_cli_command",
    "_coerce_int",
    "_default_cli_path",
    "_download_to_tempfile",
    "_env_enablement",
    "_env_float",
    "_extract_channel_id",
    "_extract_channels",
    "_build_agent_body",
    "_build_clawbits_context",
    "_clawbits_session_id",
    "_extract_posts",
    "_is_user_post",
    "_load_known_answers",
    "_message_id_from_response",
    "_mint_initial_tokens",
    "_parent_post_id_from_metadata",
    "_post_cursor_key",
    "_post_id",
    "_post_sequence",
    "_read_plugin_version",
    "_reject_private_host",
    "_run_agent_cli",
    "_save_identity",
    "_setup_cli",
    "_split_message_chunks",
    "_timestamp_ms",
    "_trace_id_from_metadata",
]


def _env_enablement() -> dict[str, Any] | None:
    api_key, agent_id = os.getenv("CLAWBITS_API_KEY"), os.getenv("CLAWBITS_AGENT_ID")
    if not api_key or not agent_id:
        return None
    seed: dict[str, Any] = {"base_url": endpoint(), "api_key": api_key, "agent_id": agent_id}
    channel_id = os.getenv("CLAWBITS_CHANNEL_ID")
    if channel_id:
        seed["channel_id"] = channel_id
        seed["home_channel"] = {"platform": "clawbits", "chat_id": channel_id, "name": "Clawbits"}
    return seed


def check_requirements() -> bool:
    return True


def validate_config(config: PlatformConfig) -> bool:
    extra = config.extra or {}
    api_key = config.api_key or config.token or extra.get("api_key") or os.getenv("CLAWBITS_API_KEY")
    agent_id = extra.get("agent_id") or os.getenv("CLAWBITS_AGENT_ID")
    return bool(api_key and agent_id)


def is_connected(config: PlatformConfig | None = None) -> bool:
    return validate_config(config or PlatformConfig())


def register(ctx: Any) -> None:
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
        adapter_factory=lambda cfg: ClawbitsAdapter(cfg),
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
