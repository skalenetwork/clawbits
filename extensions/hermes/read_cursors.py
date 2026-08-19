"""Durable per-channel read cursors — the restart resume points.

The chat twin of the email UID watermark (:mod:`.email_integration`): a small
JSON map ``{channel_id: last_read_post_id}`` in ``HERMES_HOME``, which under
reef is the persistent ``/opt/data`` volume, so it survives restarts,
recreates, and image upgrades alike.

The server's ``AgentChannelState`` pointer is the source of truth (it arrives
on ``GET /channels`` as ``last_read_post_id``); this file is the fallback for
servers that predate it, and a warm-start hint that saves nothing being
re-examined when the server is unreachable at boot. Values are server post-id
serials — never timestamps, which are not comparable across the guest/server
clock boundary.

Write scheme mirrors ``save_email_watermark``: temp file + fsync + atomic
``os.replace`` in the same directory, so a SIGKILL mid-write can't leave
truncated JSON (which would read as "no cursors" and degrade to a first-boot
seed — safe, but a needless loss of the resume point).
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

READ_CURSOR_FILE = "clawbits-read-cursors.json"


def _cursor_path() -> Path:
    try:
        from hermes_constants import get_hermes_home

        home = Path(get_hermes_home())
    except Exception:
        home = Path(os.getenv("HERMES_HOME", "~/.hermes")).expanduser()
    return home / READ_CURSOR_FILE


def load_read_cursors() -> dict[str, int]:
    """Return the saved ``{channel_id: last_read_post_id}`` map, or ``{}``.

    A missing or corrupt file means "no local resume points" — the caller
    falls back to the server pointer or a first-boot seed, never crashes.
    """
    try:
        raw = json.loads(_cursor_path().read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        return {}
    if not isinstance(raw, dict):
        return {}
    cursors: dict[str, int] = {}
    for channel_id, value in raw.items():
        try:
            cursors[str(channel_id)] = int(value)
        except (TypeError, ValueError):
            continue
    return cursors


def save_read_cursors(cursors: dict[str, int]) -> None:
    """Atomically persist the cursor map. Raises on I/O failure — callers
    treat a failed persist as best-effort (the in-memory map and the server
    pointer still carry the session)."""
    path = _cursor_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".clawbits-cursors-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            payload: dict[str, Any] = {
                str(k): max(0, int(v)) for k, v in cursors.items()
            }
            json.dump(payload, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise
