"""Pure parsing/shaping helpers for Clawbits posts and channels.

Everything here is stdlib-only and side-effect-free: response-shape
normalization (the server has returned several list/dict shapes over time),
cursor keys for the poll loop, and the 4000-char message splitter. No gateway
or network imports — this module is safely importable anywhere.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

# The server rejects post bodies over 4000 chars (MmPostRequest
# max_length), and neither the gateway nor the agent CLI splits for us.
_MAX_POST_CHARS = 4000


def _split_message_chunks(text: str, limit: int = _MAX_POST_CHARS) -> list[str]:
    """Split ``text`` into ≤``limit``-char chunks at natural boundaries.

    Python twin of the IronClaw channel's ``split_message``: prefers the
    last newline, then the last space, inside the window; hard-cuts
    pathological unbroken runs. Returns ``[]`` for empty/whitespace-only
    text.
    """
    text = text.strip()
    if not text:
        return []
    chunks: list[str] = []
    rest = text
    while len(rest) > limit:
        window = rest[:limit]
        cut = window.rfind("\n")
        if cut <= 0:
            cut = window.rfind(" ")
        if cut <= 0:
            cut = limit
        chunk = rest[:cut].rstrip()
        if chunk:
            chunks.append(chunk)
        rest = rest[cut:].lstrip()
    if rest:
        chunks.append(rest)
    return chunks


@dataclass
class _Channel:
    id: str
    channel_type: str | None = None
    name: str | None = None


def _timestamp_ms(post: dict[str, Any]) -> int:
    value = post.get("create_at") or post.get("created_at") or post.get("created_at_raw") or 0
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        try:
            return int(float(value))
        except ValueError:
            try:
                return int(time.mktime(time.strptime(value.split(".", 1)[0], "%Y-%m-%d %H:%M:%S")) * 1000)
            except ValueError:
                return 0
    return 0


def _post_id(post: dict[str, Any]) -> str:
    value = post.get("id") or post.get("post_id") or post.get("message_id")
    return str(value) if value is not None else ""


def _coerce_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _post_sequence(post: dict[str, Any]) -> int:
    return _coerce_int(post.get("post_id") or post.get("id") or post.get("message_id")) or 0


def _post_cursor_key(post: dict[str, Any]) -> tuple[int, int, str]:
    return (_timestamp_ms(post), _post_sequence(post), _post_id(post))


def _parent_post_id_from_metadata(metadata: dict[str, Any], reply_to: str | None) -> int | None:
    for value in (metadata.get("parent_post_id"), reply_to, metadata.get("message_id")):
        parent_post_id = _coerce_int(value)
        if parent_post_id is not None:
            return parent_post_id
    raw = metadata.get("raw_message")
    if isinstance(raw, dict):
        for value in (raw.get("parent_post_id"), raw.get("post_id"), raw.get("id"), raw.get("message_id")):
            parent_post_id = _coerce_int(value)
            if parent_post_id is not None:
                return parent_post_id
    return None


def _trace_id_from_metadata(metadata: dict[str, Any]) -> str | None:
    value = metadata.get("trace_id")
    if isinstance(value, str) and value:
        return value
    raw = metadata.get("raw_message")
    if isinstance(raw, dict):
        raw_trace = raw.get("trace_id")
        if isinstance(raw_trace, str) and raw_trace:
            return raw_trace
    return None


def _extract_posts(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, list):
        posts = [p for p in raw if isinstance(p, dict)]
    elif isinstance(raw, dict) and isinstance(raw.get("posts"), list):
        posts = [p for p in raw["posts"] if isinstance(p, dict)]
    elif isinstance(raw, dict) and isinstance(raw.get("posts"), dict):
        post_map = raw["posts"]
        order = raw.get("order")
        if isinstance(order, list):
            posts = [post_map[i] for i in order if isinstance(post_map.get(i), dict)]
        else:
            posts = [p for p in post_map.values() if isinstance(p, dict)]
    else:
        posts = []
    return sorted(posts, key=_post_cursor_key)


def _extract_channels(raw: Any) -> list[_Channel]:
    items: list[Any]
    if isinstance(raw, list):
        items = raw
    elif isinstance(raw, dict):
        value = raw.get("channels") or raw.get("data") or raw.get("items") or []
        items = value if isinstance(value, list) else []
    else:
        items = []

    channels: list[_Channel] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        channel_id = item.get("id") or item.get("channel_id")
        if not channel_id:
            continue
        channels.append(
            _Channel(
                id=str(channel_id),
                channel_type=str(item.get("type") or item.get("channel_type") or "") or None,
                name=str(item.get("display_name") or item.get("name") or channel_id),
            )
        )
    return channels


def _extract_channel_id(raw: Any) -> str | None:
    if not isinstance(raw, dict):
        return None
    channel = raw.get("channel") if isinstance(raw.get("channel"), dict) else {}
    data = raw.get("data") if isinstance(raw.get("data"), dict) else {}
    value = (
        raw.get("channel_id")
        or raw.get("id")
        or channel.get("channel_id")
        or channel.get("id")
        or data.get("channel_id")
        or data.get("id")
    )
    return str(value) if value else None


def _is_user_post(post: dict[str, Any]) -> bool:
    post_type = str(post.get("type") or "")
    return post_type in {"", "custom_agent_message", "agentic_user_message", "user"}


def _message_id_from_response(raw: Any) -> str | None:
    if isinstance(raw, dict):
        value = raw.get("id") or raw.get("post_id") or raw.get("message_id")
        return str(value) if value is not None else None
    return None
