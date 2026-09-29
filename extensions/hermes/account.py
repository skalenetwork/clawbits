"""Profile-bound Clawbits identity and policy.

Hermes builds a platform adapter inside its owning profile's scope (home override
plus secret scope for served profiles, unscoped for the primary). The adapter
resolves its :class:`ClawbitsAccount` once, there, and every request and task it
makes stays bound to that account. Hermes modules are imported inside functions
so this module stays importable without a Hermes runtime.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_ENDPOINT = "https://app.clawbits.ai"
_TRUE = {"1", "true", "yes", "on"}


def _routed() -> bool:
    """True when the active Hermes home is not the process's own, so os.environ belongs to another profile."""
    from hermes_constants import get_hermes_home_override, get_process_hermes_home, hermes_home_key

    override = get_hermes_home_override()
    return override is not None and hermes_home_key(override) != hermes_home_key(get_process_hermes_home())


def scoped_setting(name: str) -> str | None:
    """The owning profile's value for env var ``name``; a routed profile reads only its installed scope, never os.environ."""
    try:
        from agent.secret_scope import current_secret_scope
        from gateway.platforms._shared import get_scoped_secret

        value = (current_secret_scope() or {}).get(name) if _routed() else get_scoped_secret(name)
    except ImportError:
        logger.warning("clawbits: Hermes secret scope unavailable; %s treated as unset", name)
        return None
    return value.strip() if isinstance(value, str) and value.strip() else None


def _flag(raw: Any, default: bool) -> bool:
    if raw is None or raw == "":
        return default
    return raw if isinstance(raw, bool) else str(raw).strip().lower() in _TRUE


def _active_home() -> Path:
    from hermes_constants import get_hermes_home

    return Path(os.path.expanduser(os.path.expandvars(str(get_hermes_home()))))


def _home_key(home: Path) -> str:
    from hermes_constants import hermes_home_key

    return hermes_home_key(home)


@dataclass(frozen=True)
class ClawbitsAccount:
    """One profile's Clawbits identity and policy, resolved once and bound to its requests and tasks."""

    hermes_home: Path
    base_url: str
    agent_id: str
    api_key: str = field(repr=False)
    answer: str | None = field(default=None, repr=False)
    channel_id: str = ""
    receive_email: bool = True
    send_email: bool = True
    activity_preview: bool = False
    user_agent: str | None = None

    @property
    def key(self) -> str:
        """Registry key: Hermes's canonical key for this profile home."""
        return _home_key(self.hermes_home)

    @property
    def usable(self) -> bool:
        """Both the API key and the agent id are present."""
        return bool(self.api_key and self.agent_id)


def resolve_account(config: Any = None) -> ClawbitsAccount:
    """Active profile's account: config.api_key/token/extra first, then scoped CLAWBITS_* settings."""
    extra = getattr(config, "extra", None) or {}

    def pick(key: str, env: str) -> Any:
        value = extra.get(key)
        return value if value not in (None, "") else scoped_setting(env)

    api_key = getattr(config, "api_key", None) or getattr(config, "token", None) or pick("api_key", "CLAWBITS_API_KEY")
    return ClawbitsAccount(
        hermes_home=_active_home(),
        base_url=str(pick("base_url", "CLAWBITS_ENDPOINT") or DEFAULT_ENDPOINT).rstrip("/"),
        agent_id=str(pick("agent_id", "CLAWBITS_AGENT_ID") or ""),
        api_key=str(api_key or ""),
        answer=str(pick("answer", "CLAWBITS_CHALLENGE_ANSWER") or "") or None,
        channel_id=str(pick("channel_id", "CLAWBITS_CHANNEL_ID") or ""),
        receive_email=_flag(pick("email_enabled", "CLAWBITS_EMAIL_ENABLED"), True),
        send_email=_flag(pick("email_send_enabled", "CLAWBITS_EMAIL_SEND_ENABLED"), True),
        activity_preview=_flag(pick("activity_preview", "CLAWBITS_ACTIVITY_PREVIEW"), False),
        user_agent=str(pick("user_agent", "CLAWBITS_USER_AGENT") or "") or None,
    )


_ACCOUNTS: dict[str, ClawbitsAccount] = {}


def bind_account(account: ClawbitsAccount) -> None:
    """Publish an adapter's account for tools running in the same profile."""
    _ACCOUNTS[account.key] = account


def unbind_account(account: ClawbitsAccount) -> None:
    """Withdraw the account if it is still the one bound for its home."""
    if _ACCOUNTS.get(account.key) is account:
        del _ACCOUNTS[account.key]


def active_account() -> ClawbitsAccount | None:
    """Account for the active profile (adapter-bound, else scoped settings); None when not usable."""
    account = _ACCOUNTS.get(_home_key(_active_home())) or resolve_account()
    return account if account.usable else None
