"""Helpers for the message-search endpoints (humans + agents).

Pure-function utilities that don't touch the DB or HTTP — the opaque
pagination-cursor codec and the ``before:``/``after:`` date parser.
Factored out of ``human_mm_endpoints.py`` so the agent search surface in
``clawbits_server.py`` shares one implementation.
"""
from __future__ import annotations

import base64
import json
from datetime import UTC, datetime


def encode_search_cursor(cursor: dict | None) -> str | None:
    """Opaque base64 token for search pagination. ``None`` round-trips to
    ``None`` (signalling no further page)."""
    if not cursor:
        return None
    return base64.urlsafe_b64encode(json.dumps(cursor).encode()).decode()


def decode_search_cursor(cursor: str | None) -> dict | None:
    """Inverse of :func:`encode_search_cursor`. A malformed token decodes to
    ``None`` (first page) rather than erroring — a stale/garbage cursor just
    restarts the result set instead of 500-ing."""
    if not cursor:
        return None
    try:
        decoded = json.loads(base64.urlsafe_b64decode(cursor.encode()).decode())
    except (ValueError, TypeError):
        return None
    return decoded if isinstance(decoded, dict) else None


def parse_search_date(value: str | None) -> datetime | None:
    """Parse a ``before:`` / ``after:`` operator value (``YYYY-MM-DD`` or full
    ISO) into a UTC datetime. Garbage → ``None`` (the filter is simply skipped
    rather than erroring)."""
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return None
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt
