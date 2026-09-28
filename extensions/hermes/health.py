"""Plugin health: a small status file the running adapter keeps and ``doctor`` reads.

``<profile home>/plugin-data/clawbits-platform/status.json`` holds, per subsystem, the
last success, the last failure as a code (never exception text) and the loop interval.
The adapter mutates it in memory; ``flush`` runs off the event loop (``run_status_writer``).
Failure codes and hold reasons are identifiers; any other string is stored as ``invalid_code``.
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import os
import re
import subprocess
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

PLUGIN_NAME = "clawbits-platform"
STATUS_FORMAT = 1
_REFRESH_S = 30.0
_CODE = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,63}")


def profile_home(home: Path | str | None = None) -> Path:
    """``home`` (default: the active Hermes profile) with ``~`` and ``$VAR`` expanded."""
    if home is None:
        try:
            from hermes_constants import get_hermes_home

            home = get_hermes_home()
        except Exception:  # outside a Hermes runtime (unit tests, tooling)
            home = os.getenv("HERMES_HOME") or "~/.hermes"
    return Path(os.path.expandvars(os.path.expanduser(str(home))))


def state_dir(home: Path | str | None = None) -> Path:
    """The plugin's state dir ``<home>/plugin-data/clawbits-platform`` (default: active profile)."""
    return profile_home(home) / "plugin-data" / PLUGIN_NAME


def profile_name(home: Path | str | None = None) -> str:
    """Hermes's profile id for ``home``; ``default`` when Hermes cannot tell."""
    try:
        from hermes_constants import profile_name_for_home

        return profile_name_for_home(profile_home(home)) or "default"
    except Exception:
        return "default"


def suspension_opted_in() -> bool:
    """Hermes idle suspension is opted in (scale-to-zero plus a relay wake URL); Clawbits has no wake path."""
    try:
        from gateway.relay import relay_wake_url
        from gateway.scale_to_zero import scale_to_zero_enabled

        return bool(scale_to_zero_enabled() and relay_wake_url())
    except Exception:
        return False


def _as_code(value: str) -> str:
    return value if _CODE.fullmatch(value) else "invalid_code"


def error_code(exc: BaseException) -> str:
    """``http_<status>``, ``timeout``, the CLI's error code, or the class name; never the message."""
    from . import cli_client

    status = cli_client.http_status(exc) if isinstance(exc, Exception) else None
    if status:
        return f"http_{status}"
    if isinstance(exc, (TimeoutError, subprocess.TimeoutExpired)):
        return "timeout"
    cli_error = getattr(cli_client, "ClawbitsCliError", None)
    code = getattr(exc, "code", None)
    if cli_error and isinstance(exc, cli_error) and isinstance(code, str) and _CODE.fullmatch(code):
        return code
    return type(exc).__name__


class HealthStatus:
    """In-memory subsystem health for one adapter instance, persisted by ``flush``."""

    def __init__(self, directory: Path, *, plugin_version: str, profile: str) -> None:
        self.path = Path(directory) / "status.json"
        self.doc: dict[str, Any] = {
            "format": STATUS_FORMAT, "plugin_version": plugin_version, "profile": profile,
            "pid": os.getpid(), "started_at": time.time(), "hold": None, "subsystems": {},
        }
        self._dirty, self._flushed = True, 0.0
        self._lock = threading.Lock()  # the loop mutates while a worker thread flushes
        self._write = threading.Lock()  # one flush at a time, so the newest snapshot lands last

    @classmethod
    def for_home(cls, home: Path | str | None, plugin_version: str) -> HealthStatus:
        """Status of the profile at ``home``, kept in its state dir."""
        return cls(state_dir(home), plugin_version=plugin_version, profile=profile_name(home))

    def ok(self, name: str, *, interval_s: float | None = None, **facts: Any) -> None:
        """Record a successful pass; ``facts`` are non-secret values (state, epoch, incremental)."""
        with self._lock:
            entry = self._entry(name, interval_s)
            self._dirty |= (entry.get("error") is not None or "last_ok_at" not in entry
                            or any(entry.get(k) != v for k, v in facts.items()))
            entry.update(last_ok_at=time.time(), error=None, failures=0, **facts)

    def fail(self, name: str, exc: BaseException | str, *, interval_s: float | None = None) -> None:
        """Record a failed pass as a code (an exception's, or ``exc`` when it is one)."""
        code = error_code(exc) if isinstance(exc, BaseException) else _as_code(str(exc))
        with self._lock:
            entry = self._entry(name, interval_s)
            self._dirty |= entry.get("error") != code
            entry.update(last_error_at=time.time(), error=code, failures=int(entry.get("failures") or 0) + 1)

    def receipt(self, name: str) -> None:
        """Record a durable admission on subsystem ``name``."""
        with self._lock:
            self._entry(name, None)["last_receipt_at"] = time.time()

    def hold(self, reason: str | None) -> None:
        """Hold all intake for ``reason`` (``None`` releases)."""
        reason = None if reason is None else _as_code(reason)
        with self._lock:
            self._dirty |= self.doc["hold"] != reason
            self.doc["hold"] = reason

    def stopped(self) -> None:
        """Mark the adapter disconnected."""
        with self._lock:
            self.doc["stopped_at"] = time.time()
            self._dirty = True

    def flush(self, force: bool = False) -> None:
        """Atomically write status.json (0600) if dirty or the refresh is due; never raises."""
        with self._write:
            now = time.time()
            with self._lock:
                if not (force or self._dirty or now - self._flushed >= _REFRESH_S):
                    return
                self.doc["updated_at"] = now
                doc, self._dirty, self._flushed = copy.deepcopy(self.doc), False, now
            try:
                from utils import atomic_json_write

                self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                atomic_json_write(self.path, doc, indent=None, mode=0o600)
            except Exception:
                self._dirty = True
                logger.debug("clawbits: status file write failed", exc_info=True)

    def _entry(self, name: str, interval_s: float | None) -> dict[str, Any]:
        entry = self.doc["subsystems"].setdefault(name, {})
        if interval_s is not None:
            entry["interval_s"] = interval_s
        return entry


async def run_status_writer(health: HealthStatus, running: Callable[[], bool], tick_s: float = 5.0) -> None:
    """Flush off the event loop while ``running()`` (a status fsync can stall for seconds); record the stop on exit."""
    try:
        while running():
            await asyncio.to_thread(health.flush)
            await asyncio.sleep(tick_s)
    finally:
        health.stopped()
        await asyncio.to_thread(health.flush, True)


def read_status(home: Path | str | None = None) -> dict[str, Any] | None:
    """Last status written in ``home``; None if absent, unreadable or another format."""
    try:
        doc = json.loads((state_dir(home) / "status.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) and doc.get("format") == STATUS_FORMAT else None
