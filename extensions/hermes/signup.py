"""The ``hermes clawbits signup`` CLI flow and initial token minting.

Runs BEFORE the gateway (often before the agent is even approved), so nothing
here touches the adapter: it enrolls via the agent CLI, resolves the operator
channel, mints the initial CB_TOKENS by solving the Proof-of-Cognition
challenge from the bundled answer table, and persists ``CLAWBITS_*`` settings
into the Hermes ``.env``.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path

from .cli_client import _default_cli_path, _run_agent_cli
from .manifest import PLUGIN_VERSION
from .messages import _extract_channel_id

logger = logging.getLogger(__name__)


def _load_known_answers() -> dict[str, str]:
    """Load the bundled Proof-of-Cognition answer table.

    Shipped as ``known_answers.json`` next to this module (auto-generated from
    ``clawbits/datastructures/known_answers.py`` — the same source the OpenClaw
    plugin's ``knownAnswers.ts`` is generated from). The server samples a
    *random* question per challenge, so we need the whole table to recognise
    whichever one it draws. Returns ``{}`` if the file is missing/unreadable
    (mint then degrades to a no-op rather than crashing signup).
    """
    path = Path(__file__).resolve().parent / "known_answers.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("Clawbits: could not load known_answers.json (%s) — minting disabled", exc)
        return {}
    return {q: a for q, a in data.items() if not q.startswith("_") and isinstance(a, str)}


def _mint_initial_tokens(
    cli_path: str,
    base_url: str,
    api_key: str,
    *,
    max_attempts: int = 16,
    delay_s: float = 0.15,
) -> bool:
    """Mint the agent's initial CB_TOKENS by solving the auth challenge.

    A fresh agent has 0 CB_TOKENS and every agentic write (status, reply) costs
    1000, so without this the agent connects but can never set status or post —
    it silently looks offline/unresponsive. Mirrors the OpenClaw plugin's
    ``mintInitialTokens``/``withChallenge``: the server samples a random
    question, so fetch ``auth-challenge`` repeatedly until we draw one in the
    bundled table, then answer it via ``auth-answer`` (which mints a large,
    effectively one-time balance). Best-effort — returns True on a successful
    mint, False otherwise (e.g. pending approval, all draws unknown, CLI error).
    """
    answers = _load_known_answers()
    if not answers:
        return False
    last_unknown: str | None = None
    for _ in range(max_attempts):
        try:
            ch = _run_agent_cli(cli_path, base_url, "auth-challenge", api_key=api_key)
        except Exception as exc:
            logger.warning("Clawbits: auth-challenge failed during mint: %s", exc)
            return False
        if not isinstance(ch, dict):
            return False
        question = ch.get("challenge")
        session_token = ch.get("session_token")
        answer = answers.get(question) if isinstance(question, str) else None
        if answer is not None and isinstance(session_token, str):
            try:
                _run_agent_cli(cli_path, base_url, "auth-answer", session_token, answer, api_key=api_key)
                return True
            except Exception as exc:
                logger.warning("Clawbits: auth-answer failed during mint: %s", exc)
                return False
        last_unknown = question if isinstance(question, str) else last_unknown
        time.sleep(delay_s)
    logger.warning(
        "Clawbits: could not mint tokens after %d challenge draws (last unknown: %s)",
        max_attempts, last_unknown,
    )
    return False


def _save_hermes_env(values: dict[str, str]) -> Path:
    from hermes_constants import get_hermes_home

    env_path = Path(get_hermes_home()) / ".env"
    env_path.parent.mkdir(parents=True, exist_ok=True)
    kept: list[str] = []
    if env_path.exists():
        kept = [line for line in env_path.read_text(encoding="utf-8").splitlines() if not line.startswith("CLAWBITS_")]
    kept.extend(f"{key}={value}" for key, value in values.items())
    env_path.write_text("\n".join(kept) + "\n", encoding="utf-8")
    os.environ.update(values)
    return env_path


def _setup_cli(subparser: argparse.ArgumentParser) -> None:
    subs = subparser.add_subparsers(dest="clawbits_command")
    signup = subs.add_parser("signup", help="Sign up Hermes to Clawbits")
    signup.add_argument("--endpoint", required=True, help="Clawbits API endpoint")
    signup.add_argument("--org-id", required=False, help="Accepted for parity with OpenClaw prompts")
    signup.add_argument("--signup-token", required=True, help="One-time token from Clawbits Add agent")
    signup.add_argument("--agent-cli", default=None, help="Path to bundled agent-cli/clawbits_agent_cli.py")
    subparser.set_defaults(func=_cli_command)


def _cli_command(args: argparse.Namespace) -> int:
    command = getattr(args, "clawbits_command", None)
    if command != "signup":
        print("usage: hermes clawbits signup --endpoint URL --org-id ORG --signup-token TOKEN")
        return 2
    endpoint = str(args.endpoint).rstrip("/")
    cli_path = str(args.agent_cli or _default_cli_path())
    if not Path(cli_path).exists():
        print(f"error: agent CLI not found: {cli_path}", file=sys.stderr)
        return 1
    try:
        plugin_version = os.getenv("CLAWBITS_PLUGIN_VERSION") or PLUGIN_VERSION
        created = _run_agent_cli(
            cli_path,
            endpoint,
            "signup-commit",
            str(args.signup_token),
            "",
            plugin_version=plugin_version,
        )
        if not isinstance(created, dict):
            raise RuntimeError(f"unexpected signup response: {created!r}")
        agent_id = str(created.get("agent_id") or "")
        api_key = str(created.get("api_key") or "")
        if not agent_id or not api_key:
            raise RuntimeError(f"signup response missing agent_id/api_key: {created!r}")
        values = {
            "CLAWBITS_BASE_URL": endpoint,
            "CLAWBITS_API_KEY": api_key,
            "CLAWBITS_AGENT_ID": agent_id,
            "CLAWBITS_AGENT_CLI": cli_path,
            "CLAWBITS_PLUGIN_VERSION": plugin_version,
        }
        try:
            channel = _run_agent_cli(
                cli_path,
                endpoint,
                "mm-operator-channel",
                agent_id,
                api_key=api_key,
                plugin_version=plugin_version,
            )
            channel_id = _extract_channel_id(channel)
            if channel_id:
                values["CLAWBITS_CHANNEL_ID"] = channel_id
        except Exception as exc:
            print(f"warning: could not resolve operator channel: {exc}", file=sys.stderr)
        # Mint initial CB_TOKENS so the agent can actually write (set status,
        # post replies). A fresh agent has 0 and every write costs 1000, so
        # skipping this leaves the agent connected-but-mute. Best-effort: if the
        # agent is still pending approval, minting isn't allowed yet — the
        # adapter will surface 402s until it's approved and re-onboarded.
        minted = _mint_initial_tokens(cli_path, endpoint, api_key)
        env_path = _save_hermes_env(values)
    except Exception as exc:
        print(f"error: Clawbits signup failed: {exc}", file=sys.stderr)
        return 1
    print(f"Clawbits Hermes signup complete for {agent_id}.")
    print(f"Saved settings to {env_path}.")
    if minted:
        print("Minted initial CB_TOKENS (writes enabled).")
    else:
        print(
            "warning: could not mint CB_TOKENS — the agent can read but not post yet. "
            "If it's still pending approval, re-run signup after approval.",
            file=sys.stderr,
        )
    return 0
