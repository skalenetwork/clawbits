"""The ``hermes clawbits signup`` CLI flow and initial token minting.

Runs before the gateway (often before the agent is even approved), so nothing
here touches the adapter. An identity already in the Hermes ``.env`` is kept
while the backend still accepts it; otherwise the flow enrolls via the agent
CLI, resolves the operator channel, mints the initial CB_TOKENS by solving the
Proof-of-Cognition challenge from the bundled answer table, and persists the
identity into the ``.env``.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path

from dotenv import dotenv_values

from .cli_client import _default_cli_path, _run_agent_cli, endpoint, http_status
from .messages import _extract_channel_id

logger = logging.getLogger(__name__)

IDENTITY = ("CLAWBITS_API_KEY", "CLAWBITS_AGENT_ID", "CLAWBITS_CHANNEL_ID")


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


def _env_path() -> Path:
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home()) / ".env"


def _stored_identity() -> tuple[str, str] | None:
    values = dotenv_values(_env_path())
    api_key, agent_id = values.get("CLAWBITS_API_KEY"), values.get("CLAWBITS_AGENT_ID")
    return (api_key, agent_id) if api_key and agent_id else None


def _save_identity(values: dict[str, str]) -> Path:
    """Replace the identity lines (and any key in ``values``) of the Hermes ``.env``; every other line stays."""
    path = _env_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    kept = [
        line
        for line in (path.read_text(encoding="utf-8").splitlines() if path.exists() else [])
        if line.partition("=")[0] not in (*IDENTITY, *values)
    ]
    kept.extend(f"{key}={value}" for key, value in values.items())
    path.write_text("\n".join(kept) + "\n", encoding="utf-8")
    return path


def _known(cli_path: str, base_url: str, api_key: str, agent_id: str) -> bool:
    """Whether the backend still accepts the stored identity. Only an explicit
    401/403 says no; an outage, timeout or version refusal keeps it."""
    try:
        _run_agent_cli(cli_path, base_url, "agent-info", agent_id, api_key=api_key)
    except Exception as exc:
        return http_status(exc) not in (401, 403)
    return True


def _setup_cli(subparser: argparse.ArgumentParser) -> None:
    subs = subparser.add_subparsers(dest="clawbits_command")
    signup = subs.add_parser("signup", help="Sign up Hermes to Clawbits")
    signup.add_argument("--endpoint", default=None, help="Clawbits API endpoint (saved to the profile .env)")
    signup.add_argument("--signup-token", required=True, help="One-time token from Clawbits Add agent")
    doctor = subs.add_parser("doctor", help="Report this profile's Clawbits health (0 ok, 1 degraded, 3 not ready)")
    doctor.add_argument("--wait", type=float, default=0, metavar="SECONDS", help="Poll up to SECONDS until ready")
    doctor.add_argument("--since", type=float, default=None, metavar="EPOCH", help="Require a gateway started after EPOCH")
    doctor.add_argument("--preflight", action="store_true", help="Offline checks only (a staged install)")
    doctor.add_argument("--json", action="store_true", help="Print the checks as JSON")
    inbox = subs.add_parser("inbox", help="Review this profile's Clawbits intake journal")
    inbox_cmds = inbox.add_subparsers(dest="inbox_command")
    inbox_cmds.add_parser("status", help="Counts, sources, items awaiting review, failed deliveries")
    inbox_cmds.add_parser("retry", help="Queue an item awaiting review again").add_argument("item")
    dismiss = inbox_cmds.add_parser("dismiss", help="Dismiss an item awaiting review, or a delivery KEY")
    dismiss.add_argument("item")
    migrate = inbox_cmds.add_parser("migrate", help="Resolve a source held for migration review")
    migrate.add_argument("source", type=int)
    start = migrate.add_mutually_exclusive_group(required=True)
    start.add_argument("--adopt", action="store_true", help="Resume at the recorded cursor")
    start.add_argument("--new-only", action="store_true", help="Start after the server's newest message")
    start.add_argument("--from-uid", type=int, metavar="N", help="Admit from email UID or post serial N")
    resend = inbox_cmds.add_parser("resend", help="Send a failed or unknown delivery under a new key")
    resend.add_argument("key")
    subparser.set_defaults(func=_cli_command)


def _cli_command(args: argparse.Namespace) -> int:
    command = getattr(args, "clawbits_command", None)
    if command == "doctor":
        from .doctor import run

        return run(args)
    if command == "inbox":
        from .inbox_state import run_inbox_cli

        return run_inbox_cli(args)
    if command != "signup":
        print("usage: hermes clawbits {signup,doctor} ...\n"
              "       hermes clawbits inbox {status,retry,dismiss,migrate,resend} ...")
        return 2
    base_url = str(getattr(args, "endpoint", None) or endpoint()).rstrip("/")
    cli_path = _default_cli_path()
    stored = _stored_identity()
    if stored and _known(cli_path, base_url, *stored):
        print(f"Clawbits identity for {stored[1]} is current.")
        return 0
    if stored:
        _save_identity({})
    try:
        created = _run_agent_cli(cli_path, base_url, "signup-commit", str(args.signup_token), "")
        # Responses are never echoed: a malformed one can still carry the issued api_key.
        if not isinstance(created, dict):
            raise RuntimeError(f"unexpected signup response ({type(created).__name__})")
        agent_id = str(created.get("agent_id") or "")
        api_key = str(created.get("api_key") or "")
        if not agent_id or not api_key:
            missing = [name for name, value in (("agent_id", agent_id), ("api_key", api_key)) if not value]
            raise RuntimeError(f"signup response missing {'/'.join(missing)}")
        values = {"CLAWBITS_API_KEY": api_key, "CLAWBITS_AGENT_ID": agent_id}
        if getattr(args, "endpoint", None):
            values["CLAWBITS_ENDPOINT"] = base_url
        try:
            channel = _run_agent_cli(cli_path, base_url, "mm-operator-channel", agent_id, api_key=api_key)
            channel_id = _extract_channel_id(channel)
            if channel_id:
                values["CLAWBITS_CHANNEL_ID"] = channel_id
        except Exception as exc:
            print(f"warning: could not resolve operator channel: {exc}", file=sys.stderr)
        # A fresh agent has 0 CB_TOKENS and every write costs 1000; minting is
        # best-effort because an agent pending approval cannot mint yet.
        minted = _mint_initial_tokens(cli_path, base_url, api_key)
        env_path = _save_identity(values)
    except Exception as exc:
        print(f"error: Clawbits signup failed: {exc}", file=sys.stderr)
        return 1
    print(f"Clawbits Hermes signup complete for {agent_id}.")
    print(f"Saved identity to {env_path}.")
    if minted:
        print("Minted initial CB_TOKENS (writes enabled).")
    else:
        print(
            "warning: could not mint CB_TOKENS — the agent can read but not post yet. "
            "If it's still pending approval, re-run signup after approval.",
            file=sys.stderr,
        )
    return 0
