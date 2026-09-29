"""The pre-journal read-cursor file, read once for migration.

Pre-journal plugins kept ``{channel_id: last_read_post_id}`` in
``<profile home>/clawbits-read-cursors.json``. The journal (:mod:`.inbox_state`)
owns every cursor: the adapter reads this map only for a channel whose server
read pointer is missing, under the CLAWBITS_INBOX_LEGACY_MIGRATION policy, and
the journal moves the file into its ``legacy/`` directory once a chat source is
active. Values are server post-id serials.
"""

from __future__ import annotations

import json
from pathlib import Path

READ_CURSOR_FILE = "clawbits-read-cursors.json"


def load_read_cursors(home: Path) -> dict[str, int]:
    """The saved ``{channel_id: last_read_post_id}`` map; ``{}`` when missing or corrupt."""
    try:
        raw = json.loads((Path(home) / READ_CURSOR_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
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
