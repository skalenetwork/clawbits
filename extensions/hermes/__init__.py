"""Clawbits platform plugin for Hermes Agent.

Install by copying this directory to ``~/.hermes/plugins/clawbits-platform``
and enabling ``clawbits-platform`` in Hermes plugin config.

Layout — this package is split by responsibility; ``__init__`` holds only the
gateway-facing surface (``register`` and its config hooks) and re-exports the
rest for compatibility:

- :mod:`.manifest`   — ``PLUGIN_VERSION`` read from ``plugin.yaml``
- :mod:`.messages`   — pure post/channel parsing, cursor keys, 4000-char split
- :mod:`.media`      — SSRF-guarded image download for native delivery
- :mod:`.cli_client` — subprocess wrapper around the bundled agent CLI
- :mod:`.signup`     — ``hermes clawbits signup`` flow + CB_TOKENS minting
- :mod:`.adapter`    — the ``ClawbitsAdapter`` (poll/WS/liveness loops, sends)

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

from . import adapter, cli_client, manifest, media, messages, signup
from .adapter import (
    _ATTENTION_PREAMBLE,
    _SEEN_CAP,
    DEFAULT_BASE_URL,
    DEFAULT_LIVENESS_INTERVAL_SECONDS,
    DEFAULT_POLL_INTERVAL_SECONDS,
    GENERATING_HEARTBEAT_INTERVAL_SECONDS,
    ClawbitsAdapter,
    _env_float,
    _ws_header_kwarg,
)
from .cli_client import _ClawbitsCli, _default_cli_path, _run_agent_cli
from .manifest import _FALLBACK_PLUGIN_VERSION, PLUGIN_VERSION, _read_plugin_version
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
    _save_hermes_env,
    _setup_cli,
)

__all__ = [
    "ClawbitsAdapter",
    "DEFAULT_BASE_URL",
    "DEFAULT_LIVENESS_INTERVAL_SECONDS",
    "DEFAULT_POLL_INTERVAL_SECONDS",
    "GENERATING_HEARTBEAT_INTERVAL_SECONDS",
    "PLUGIN_VERSION",
    "adapter",
    "check_requirements",
    "cli_client",
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
    "_FALLBACK_PLUGIN_VERSION",
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
    "_save_hermes_env",
    "_setup_cli",
    "_split_message_chunks",
    "_timestamp_ms",
    "_trace_id_from_metadata",
    "_ws_header_kwarg",
]


def _env_enablement() -> dict[str, Any] | None:
    api_key = os.getenv("CLAWBITS_API_KEY")
    agent_id = os.getenv("CLAWBITS_AGENT_ID")
    if not api_key or not agent_id:
        return None
    extra: dict[str, Any] = {
        "base_url": os.getenv("CLAWBITS_BASE_URL", DEFAULT_BASE_URL),
        "api_key": api_key,
        "agent_id": agent_id,
    }
    channel_id = os.getenv("CLAWBITS_CHANNEL_ID")
    if channel_id:
        extra["channel_id"] = channel_id
        extra["home_channel"] = {
            "platform": "clawbits",
            "chat_id": channel_id,
            "name": "Clawbits",
        }
    return {"enabled": True, "api_key": api_key, "extra": extra}


def check_requirements() -> bool:
    return True


def validate_config(config: PlatformConfig) -> tuple[bool, str]:
    extra = config.extra or {}
    api_key = config.api_key or config.token or extra.get("api_key") or os.getenv("CLAWBITS_API_KEY")
    agent_id = extra.get("agent_id") or os.getenv("CLAWBITS_AGENT_ID")
    if not api_key:
        return False, "Missing CLAWBITS_API_KEY"
    if not agent_id:
        return False, "Missing CLAWBITS_AGENT_ID"
    return True, "ok"


def is_connected(config: PlatformConfig | None = None) -> bool:
    """Whether Clawbits credentials are configured.

    The gateway's enablement gate calls this with the candidate
    ``PlatformConfig`` (env-seeded extras layered on), so it MUST accept that
    argument — a no-arg signature raises ``TypeError`` there, which the gate
    swallows and treats as "not configured", silently skipping the platform.
    Kept callable with no args too (CLI/status checks). Honors both
    ``config.extra`` and the ``CLAWBITS_*`` env vars, mirroring
    :func:`validate_config`.
    """
    extra = (config.extra or {}) if config is not None else {}
    api_key = (
        (config.api_key or config.token if config is not None else None)
        or extra.get("api_key")
        or os.getenv("CLAWBITS_API_KEY")
    )
    agent_id = extra.get("agent_id") or os.getenv("CLAWBITS_AGENT_ID")
    return bool(api_key and agent_id)


def register(ctx: Any) -> None:
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
        required_env=["CLAWBITS_BASE_URL", "CLAWBITS_API_KEY", "CLAWBITS_AGENT_ID"],
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
