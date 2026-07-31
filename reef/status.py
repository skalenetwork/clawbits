"""The agent-volunteered status file — Reef reads it host-side from the sandbox's
status mount, **never executing anything in the guest**.

The agent (its image entrypoint) writes a small, secret-free JSON object to its
status dir; Reef bind-mounts that dir on the host and reads it back. The shape is
the agent's contract (versions today, more telemetry later) — Reef passes it
through. See reef/images/openclaw-runtime/entrypoint.sh and docs/REEF.md.
"""

import json
from pathlib import Path

STATUS_FILENAME = "status.json"
_MAX_BYTES = 64 * 1024  # the agent writes a tiny object; ignore anything larger


def read_status_file(host_dir: str | Path) -> dict | None:
    """Parse ``<host_dir>/status.json`` host-side. ``None`` when it's missing,
    oversized, malformed, or not a JSON object — e.g. the agent hasn't written it
    yet (or at all). Best-effort and side-effect-free."""
    path = Path(host_dir) / STATUS_FILENAME
    try:
        if path.stat().st_size > _MAX_BYTES:
            return None
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None
