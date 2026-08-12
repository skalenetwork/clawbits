"""Subprocess wrapper around the bundled ``agent-cli/clawbits_agent_cli.py``.

All Clawbits API traffic goes through the dependency-free CLI in a child
process; this module owns spawning it (credential passed via env, never argv)
and decoding its JSON output.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from .manifest import PLUGIN_VERSION
from .messages import _Channel, _extract_channel_id, _extract_channels, _extract_posts


class _ClawbitsCli:
    """Thin adapter around bundled ``agent-cli/clawbits_agent_cli.py``."""

    def __init__(
        self,
        cli_path: str,
        base_url: str,
        api_key: str,
        plugin_version: str | None = None,
        answer: str | None = None,
    ) -> None:
        self.cli_path = cli_path
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.plugin_version = plugin_version or PLUGIN_VERSION
        self.answer = answer

    def _run(self, *args: str) -> Any:
        cmd = [
            sys.executable,
            self.cli_path,
            "--base-url",
            self.base_url,
            "--plugin-version",
            self.plugin_version,
            *args,
        ]
        # Hand the API key to the child via env, NOT on argv: argv is world-
        # readable through `ps` / /proc/<pid>/cmdline, so a `--api-key <secret>`
        # leaks the credential to any local process for the life of the call.
        # The agent CLI already defaults --api-key from CLAWBITS_API_KEY
        # (clawbits_agent_cli.py:21), so this is a transparent swap. --base-url
        # and --plugin-version stay on argv — neither is secret.
        env = {**os.environ, "CLAWBITS_API_KEY": self.api_key}
        proc = subprocess.run(cmd, text=True, capture_output=True, timeout=60, check=False, env=env)
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or f"agent-cli exited {proc.returncode}")
        out = proc.stdout.strip()
        if not out:
            return None
        try:
            return json.loads(out)
        except json.JSONDecodeError:
            return out

    def _write_args(self) -> list[str]:
        if self.answer:
            return ["--answer", self.answer]
        return []

    def list_channels(self) -> list[_Channel]:
        return _extract_channels(self._run("mm-channels"))

    def get_posts(self, channel_id: str, limit: int = 50) -> list[dict[str, Any]]:
        return _extract_posts(self._run("mm-posts", channel_id, "--limit", str(limit)))

    def post_message(
        self,
        channel_id: str,
        content: str,
        parent_post_id: int | None = None,
        trace_id: str | None = None,
        file_ids: list[str] | None = None,
        status: str = "published",
    ) -> Any:
        if parent_post_id is not None or trace_id or file_ids or status != "published":
            body: dict[str, Any] = {
                "message": content,
                "status": status,
                "file_ids": file_ids or [],
            }
            if parent_post_id is not None:
                body["parent_post_id"] = parent_post_id
            if trace_id:
                body["trace_id"] = trace_id
            return self._run("mm-post", channel_id, "--json", json.dumps(body), *self._write_args())
        return self._run("mm-post", channel_id, "--message", content, *self._write_args())

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
        return self._run(
            "mm-post-patch", channel_id, str(post_id), "--json", json.dumps(body),
            *self._write_args(),
        )

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
        result = self._run(*args, *self._write_args())
        file_id = result.get("file_id") if isinstance(result, dict) else None
        if not isinstance(file_id, str) or not file_id:
            raise RuntimeError(f"mm-file-send returned no file_id: {result!r}")
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
        args = ["mm-status", channel_id, status]
        if activity:
            args += ["--activity-json", json.dumps(activity)]
        self._run(*args, *self._write_args())

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

    def email_get(self, agent_id: str, uid: int) -> dict[str, Any]:
        result = self._run("email-get", agent_id, str(uid))
        return result if isinstance(result, dict) else {}

    def email_send(
        self,
        agent_id: str,
        subject: str,
        message: str,
        headers: dict[str, str] | None = None,
    ) -> Any:
        args = ["email-send", agent_id, subject, message]
        if headers:
            args += ["--headers-json", json.dumps(headers)]
        return self._run(*args, *self._write_args())

    def automations_desired(self) -> dict[str, Any]:
        result = self._run("automations-desired")
        return result if isinstance(result, dict) else {}

    def automations_state(self, report: dict[str, Any]) -> dict[str, Any]:
        result = self._run("automations-state", json.dumps(report))
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
    env_path = os.getenv("CLAWBITS_AGENT_CLI")
    if env_path:
        return env_path
    candidates = [
        Path(__file__).resolve().parent / "agent-cli" / "clawbits_agent_cli.py",
        Path.cwd() / "extensions" / "hermes" / "agent-cli" / "clawbits_agent_cli.py",
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return str(candidates[0])


def _run_agent_cli(
    cli_path: str,
    base_url: str,
    *args: str,
    api_key: str | None = None,
    plugin_version: str | None = None,
) -> Any:
    cmd = [
        sys.executable,
        cli_path,
        "--base-url",
        base_url,
        "--plugin-version",
        plugin_version or os.getenv("CLAWBITS_PLUGIN_VERSION") or PLUGIN_VERSION,
    ]
    cmd.extend(args)
    # Pass the key via env, not argv (argv is visible in `ps`); the CLI defaults
    # --api-key from CLAWBITS_API_KEY. When api_key is None this call runs
    # PRE-enrollment (signup-commit, before any key exists) and must send no
    # credential — the old argv-only path simply omitted the flag. With the env
    # fallback in play we now have to EXPLICITLY drop any stale CLAWBITS_API_KEY
    # inherited from os.environ, or signup would suddenly authenticate with an
    # unrelated key it never used to send. Preserves the prior behavior exactly.
    env = {**os.environ}
    if api_key:
        env["CLAWBITS_API_KEY"] = api_key
    else:
        env.pop("CLAWBITS_API_KEY", None)
    proc = subprocess.run(cmd, text=True, capture_output=True, timeout=60, check=False, env=env)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or f"agent-cli exited {proc.returncode}")
    out = proc.stdout.strip()
    if not out:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return out
