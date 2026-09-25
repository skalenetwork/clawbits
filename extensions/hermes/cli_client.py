"""Subprocess wrapper around the bundled ``agent-cli/clawbits_agent_cli.py``.

All Clawbits API traffic goes through the dependency-free CLI in a child
process. This module owns spawning it with an allowlisted environment (the
owning account's credentials ride env, never argv), passing private payloads
as ``@file`` references, and reducing failures to body-free errors.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import subprocess
import sys
import tempfile
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from .account import DEFAULT_ENDPOINT, ClawbitsAccount, scoped_setting
from .manifest import PLUGIN_VERSION
from .messages import _Channel, _extract_channel_id, _extract_channels, _extract_posts

# Transport and locale settings only; credentials are added per owning account.
_CHILD_ENV_ALLOW = frozenset({
    "PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "SYSTEMROOT",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
    "http_proxy", "https_proxy", "no_proxy", "all_proxy",
})

_STATUS_CODES = {
    400: "bad_request", 401: "unauthorized", 402: "payment_required", 403: "forbidden",
    404: "not_found", 409: "conflict", 413: "too_large", 422: "validation_error",
    426: "plugin_outdated", 429: "rate_limited", 503: "unavailable",
}
_CODE_RE = re.compile(r"[a-z0-9_]{1,64}")


def endpoint() -> str:
    """Active profile's endpoint (scoped setting), default https://app.clawbits.ai."""
    return (scoped_setting("CLAWBITS_ENDPOINT") or DEFAULT_ENDPOINT).rstrip("/")


class ClawbitsCliError(RuntimeError):
    """Agent-CLI failure as HTTP status plus stable code; str() never carries bodies, URLs or argv.

    ``detail`` is the server's structured ``detail`` object when the error body
    has one (e.g. ``{"code": "mailbox_epoch_changed", "uidvalidity": 7}``), else None.
    """

    def __init__(self, status: int | None, code: str, detail: dict[str, Any] | None = None) -> None:
        self.status, self.code, self.detail = status, code, detail
        super().__init__(f"HTTP {status}: {code}" if status else f"agent-cli: {code}")


def _cli_error(returncode: int, stderr: str) -> ClawbitsCliError:
    """Classify the CLI's stderr ('HTTP <status>: <body>' or a traceback) without keeping it."""
    found = re.search(r"^HTTP (\d{3}): ?(.*)$", stderr, re.MULTILINE | re.DOTALL)
    if not found:
        if returncode == 2 and re.search(r"^usage:", stderr, re.MULTILINE):
            return ClawbitsCliError(None, "usage_error")
        last = (stderr.strip().splitlines() or [""])[-1]
        kind = re.match(r"^(?:\w+\.)*(\w*(?:Error|Exception))(?::|$)", last)
        return ClawbitsCliError(None, kind.group(1) if kind else f"exit_{returncode}")
    status = int(found.group(1))
    try:
        body = json.loads(found.group(2))
    except ValueError:
        body = None
    detail = body.get("detail") if isinstance(body, dict) else None
    if isinstance(detail, str) and "not configured" in detail.lower():
        return ClawbitsCliError(status, "not_configured")
    detail = detail if isinstance(detail, dict) else None
    code = detail.get("code") if detail else None
    if not (isinstance(code, str) and _CODE_RE.fullmatch(code)):
        code = _STATUS_CODES.get(status, "http_error")
    return ClawbitsCliError(status, code, detail)


def http_status(error: BaseException) -> int | None:
    """Status of a CLI failure: ClawbitsCliError.status, else parsed from an 'HTTP NNN:' line."""
    status = getattr(error, "status", None)
    if isinstance(status, int):
        return status
    found = re.search(r"^HTTP (\d{3}):", str(error), re.MULTILINE)
    return int(found.group(1)) if found else None


@contextlib.contextmanager
def private_json_file(payload: Any) -> Iterator[str]:
    """Yield '@<path>' of a 0600 ASCII JSON temp file (random 'clawbits-*.json'); unlinked on success, error or cancellation."""
    fd, path = tempfile.mkstemp(prefix="clawbits-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="ascii") as handle:
            json.dump(payload, handle)
        yield f"@{path}"
    finally:
        with contextlib.suppress(OSError):
            os.unlink(path)


def child_env(api_key: str | None, *, answer: str | None = None, user_agent: str | None = None) -> dict[str, str]:
    """Allowlisted transport env plus only the owning account's key, challenge answer and user agent."""
    env = {name: value for name, value in os.environ.items() if name in _CHILD_ENV_ALLOW}
    for name, value in (
        ("CLAWBITS_API_KEY", api_key),
        ("CLAWBITS_CHALLENGE_ANSWER", answer),
        ("CLAWBITS_USER_AGENT", user_agent),
    ):
        if value:
            env[name] = value
    return env


def _exec_cli(
    cli_path: str,
    base_url: str,
    args: tuple[str, ...],
    env: dict[str, str],
    plugin_version: str | None = None,
    timeout: float = 60,
) -> Any:
    """Run one agent-CLI command under ``env``; parsed JSON stdout, raises ClawbitsCliError on failure."""
    cmd = [sys.executable, cli_path, "--base-url", base_url, "--plugin-version", plugin_version or PLUGIN_VERSION, *args]
    try:
        proc = subprocess.run(cmd, text=True, capture_output=True, timeout=timeout, check=False, env=env)
    except subprocess.TimeoutExpired:
        raise ClawbitsCliError(None, "timeout") from None
    if proc.returncode != 0:
        raise _cli_error(proc.returncode, proc.stderr) from None
    out = proc.stdout.strip()
    if not out:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return out


def _run_agent_cli(
    cli_path: str,
    base_url: str,
    *args: str,
    api_key: str | None = None,
    answer: str | None = None,
    user_agent: str | None = None,
    plugin_version: str | None = None,
    timeout: float = 60,
) -> Any:
    """Account-less CLI call (signup, setup): the user agent falls back to the active scope's setting."""
    env = child_env(api_key, answer=answer, user_agent=user_agent or scoped_setting("CLAWBITS_USER_AGENT"))
    return _exec_cli(cli_path, base_url, args, env, plugin_version, timeout)


class _ClawbitsCli:
    """Thin adapter around bundled ``agent-cli/clawbits_agent_cli.py``."""

    def __init__(
        self,
        cli_path: str,
        base_url: str,
        api_key: str,
        plugin_version: str | None = None,
        answer: str | None = None,
        user_agent: str | None = None,
    ) -> None:
        self.cli_path = cli_path
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.plugin_version = plugin_version or PLUGIN_VERSION
        self.answer = answer
        self.user_agent = user_agent

    @classmethod
    def for_account(cls, account: ClawbitsAccount, cli_path: str | None = None) -> _ClawbitsCli:
        """Client bound to one profile's endpoint, key, answer and user agent."""
        return cls(
            cli_path or _default_cli_path(),
            account.base_url,
            account.api_key,
            PLUGIN_VERSION,
            account.answer,
            account.user_agent,
        )

    def _run(self, *args: str) -> Any:
        env = child_env(self.api_key, answer=self.answer, user_agent=self.user_agent)
        return _exec_cli(self.cli_path, self.base_url, args, env, self.plugin_version)

    def list_channels(self) -> list[_Channel]:
        return _extract_channels(self._run("mm-channels"))

    def get_posts(
        self,
        channel_id: str,
        limit: int = 50,
        after_post_id: int | None = None,
    ) -> list[dict[str, Any]]:
        """Newest ``limit`` posts — or, with ``after_post_id``, the forward
        cursor read: posts strictly newer than that serial, oldest first.
        The boot catch-up pages this to read exactly the offline gap."""
        args = ["mm-posts", channel_id, "--limit", str(limit)]
        if after_post_id is not None:
            args += ["--after-post-id", str(after_post_id)]
        return _extract_posts(self._run(*args))

    def mark_read(self, channel_id: str, post_id: int) -> Any:
        """Ack the durable read pointer (``POST .../read``) — called when a
        turn settles. Monotonic and billing-exempt server-side, and needs no
        challenge (same class as ``alive``), so it is a single HTTP call."""
        return self._run("mm-mark-read", channel_id, str(post_id))

    def post_message(
        self,
        channel_id: str,
        content: str,
        parent_post_id: int | None = None,
        trace_id: str | None = None,
        file_ids: list[str] | None = None,
        status: str = "published",
    ) -> Any:
        body: dict[str, Any] = {"message": content, "status": status, "file_ids": file_ids or []}
        if parent_post_id is not None:
            body["parent_post_id"] = parent_post_id
        if trace_id:
            body["trace_id"] = trace_id
        with private_json_file(body) as ref:
            return self._run("mm-post", channel_id, "--json", ref)

    def patch_message(
        self,
        channel_id: str,
        post_id: str,
        *,
        replace: str | None = None,
        done: bool = False,
        cancel: bool = False,
    ) -> Any:
        body: dict[str, Any] = {}
        if replace is not None:
            body["replace"] = replace
        if done:
            body["done"] = True
        if cancel:
            body["cancel"] = True
        with private_json_file(body) as ref:
            return self._run("mm-post-patch", channel_id, str(post_id), "--json", ref)

    def upload_file(
        self, channel_id: str, path: str, content_type: str | None = None
    ) -> str:
        """Upload a local file via the direct byte route; returns the file_id.

        One CLI call (``mm-file-send``) — the server performs the R2 PUT,
        probes image dimensions, and generates the thumbnail, so no
        presign/confirm dance and no reachability to the R2 host needed.
        """
        args = ["mm-file-send", channel_id, path]
        if content_type:
            args += ["--content-type", content_type]
        result = self._run(*args)
        file_id = result.get("file_id") if isinstance(result, dict) else None
        if not isinstance(file_id, str) or not file_id:
            raise ClawbitsCliError(None, "missing_file_id")
        return file_id

    def file_url(self, file_id: str) -> str | None:
        result = self._run("mm-file-url", file_id)
        value = result.get("url") if isinstance(result, dict) else None
        return value if isinstance(value, str) and value else None

    def set_status(
        self,
        channel_id: str,
        status: str,
        activity: dict[str, Any] | None = None,
    ) -> None:
        if not activity:
            self._run("mm-status", channel_id, status)
            return
        with private_json_file(activity) as ref:
            self._run("mm-status", channel_id, status, "--activity-json", ref)

    def control_snapshot(self) -> Any:
        return self._run("mm-channels")

    def email_count(self, agent_id: str) -> dict[str, Any]:
        result = self._run("email-count", agent_id)
        return result if isinstance(result, dict) else {}

    def email_inbox(self, agent_id: str, limit: int = 50, offset: int = 0) -> dict[str, Any]:
        result = self._run(
            "email-inbox", agent_id, "--limit", str(limit), "--offset", str(offset)
        )
        return result if isinstance(result, dict) else {}

    def email_changes(
        self,
        agent_id: str,
        after_uid: int,
        *,
        uidvalidity: int | None = None,
        through_uid: int | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        """One ascending, epoch-bound page of ``GET /email/changes`` (flag-neutral)."""
        args = ["email-changes", agent_id, "--after-uid", str(after_uid), "--limit", str(limit)]
        if uidvalidity is not None:
            args += ["--uidvalidity", str(uidvalidity)]
        if through_uid is not None:
            args += ["--through-uid", str(through_uid)]
        result = self._run(*args)
        return result if isinstance(result, dict) else {}

    def email_get(
        self,
        agent_id: str,
        uid: int,
        *,
        uidvalidity: int | None = None,
        mark_read: bool = True,
        attachment_content: bool = True,
    ) -> dict[str, Any]:
        """One message; ``mark_read=False`` peeks, ``uidvalidity`` pins the mailbox epoch."""
        args = ["email-get", agent_id, str(uid)]
        if uidvalidity is not None:
            args += ["--uidvalidity", str(uidvalidity)]
        if not mark_read:
            args.append("--peek")
        if not attachment_content:
            args.append("--no-attachment-content")
        result = self._run(*args)
        return result if isinstance(result, dict) else {}

    def email_send(
        self,
        agent_id: str,
        subject: str,
        message: str,
        headers: dict[str, str] | None = None,
        *,
        idempotency_key: str | None = None,
    ) -> Any:
        """POST send with the body in a private file; with a key the response is the delivery record."""
        body: dict[str, Any] = {"subject": subject, "message": message}
        if headers:
            body["headers"] = headers
        key_args = ["--idempotency-key", idempotency_key] if idempotency_key else []
        with private_json_file(body) as ref:
            return self._run("email-send", agent_id, "--json", ref, *key_args)

    def email_delivery(self, agent_id: str, key: str) -> dict[str, Any]:
        """The keyed outbox record, ``GET /email/deliveries/{key}``."""
        result = self._run("email-delivery", agent_id, key)
        return result if isinstance(result, dict) else {}

    def automations_desired(self) -> dict[str, Any]:
        result = self._run("automations-desired")
        return result if isinstance(result, dict) else {}

    def automations_state(self, report: dict[str, Any]) -> dict[str, Any]:
        with private_json_file(report) as ref:
            result = self._run("automations-state", ref)
        return result if isinstance(result, dict) else {}

    def agent_info(self, agent_id: str) -> dict[str, Any]:
        result = self._run("agent-info", agent_id)
        return result if isinstance(result, dict) else {}

    def operator_channel(self, agent_id: str) -> str | None:
        return _extract_channel_id(self._run("mm-operator-channel", agent_id))

    def alive(self) -> None:
        """Liveness heartbeat (``POST /api/agentic/alive``) — marks the agent
        "available" in Clawbits, the analogue of a human's online dot."""
        self._run("alive")


def _default_cli_path() -> str:
    return str(Path(__file__).resolve().parent / "agent-cli" / "clawbits_agent_cli.py")
