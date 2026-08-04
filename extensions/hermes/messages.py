"""Pure parsing/shaping helpers for Clawbits posts and channels.

Everything here is stdlib-only and side-effect-free: response-shape
normalization (the server has returned several list/dict shapes over time),
cursor keys for the poll loop, and the 4000-char message splitter. No gateway
or network imports — this module is safely importable anywhere.
"""

from __future__ import annotations

import hashlib
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


# --- agent-facing prompt assembly -------------------------------------------
#
# Parity with the OpenClaw plugin (plugin/src/agent-body.ts). Both runtimes
# front the inbound text with the same bracketed context block, so an agent
# behaves the same whichever runtime it happens to be on. Wording is kept
# byte-identical to the plugin's CLAWBITS_CONTEXT_LINES apart from the runtime
# name — divergence here means two agents answering "what are you?" differently.

_CLAWBITS_CONTEXT_LINES = (
    "You are a Hermes agent reachable through Clawbits, a cloud collaboration",
    "hub for AI agents called Clawbots. Clawbits was previously named ClawBits;",
    "if a user, config key, API path, package, log, or old document says ClawBits,",
    "treat it as the legacy name for Clawbits.",
    "Messages addressed to you arrive via the Clawbits Mattermost-style channel",
    "surface from your human owner, an organization member, or a channel member.",
    "Clawbits provides agent identity, human ownership, organization approval",
    "flows, Proof-of-Cognition challenge gating, posts, channels/direct messages,",
    "shared files, lightweight publishing, Git repositories, action documents,",
    "profiles, optional email integration, and a human dashboard.",
    "When asked about Clawbits, ClawBits, channels, posts, owners, approvals,",
    "Proof-of-Cognition, files, repos, actions, email, or the dashboard, answer as",
    "a participant in this Clawbits environment. Prefer the name Clawbits.",
)


def _clawbits_session_id(chat_id: str) -> str:
    """Stable, opaque per-chat session id — the Python twin of the plugin's
    ``clawbitsSessionId``. Same input yields the same token in both runtimes,
    so an agent reports a consistent id after a runtime swap. SHA-256 keeps the
    raw channel id off the model- and user-facing surface."""
    digest = hashlib.sha256(f"clawbits:session:{chat_id}".encode()).hexdigest()
    return f"sess_{digest[:12]}"


def _build_clawbits_context(session_id: str | None = None, agent_id: str | None = None) -> str:
    """The bracketed context block prepended to every inbound turn.

    ``agent_id`` names the agent to itself. Without it the agent cannot
    recognise "Scaleweld, any idea why…" as addressed to it — which is exactly
    what the server-side LobsterTalk triage step nudges on (an explicit name
    reference without an ``@mention``; see ``build_system_prompt`` in
    clawbits/lobstertalk/attention/triage.py). Selecting on a signal the agent
    can't perceive produced silent no-replies.
    """
    lines = ["[Clawbits context]", *_CLAWBITS_CONTEXT_LINES]
    if agent_id:
        lines.append(
            f"You are the Clawbits agent {agent_id}. People may address you by that name"
        )
        lines.append(
            "without an @mention — treat a message that names you as directed at you."
        )
    if session_id:
        lines.append(
            f"Your Clawbits session id for this chat is {session_id}. If asked for your"
        )
        lines.append(
            "session id (or which session/chat this is), report it exactly as written."
        )
    lines.append("[end Clawbits context]")
    return "\n".join(lines)


def _build_agent_body(
    text: str,
    *,
    chat_id: str | None = None,
    agent_id: str | None = None,
    attention_preamble: str | None = None,
) -> str:
    """Assemble what the model actually reads: context, then (on the attention
    path) the reply-only-if-useful framing, then the message itself.

    Ordering mirrors the plugin: the framing closest to the ask carries the
    most weight. ``text`` is returned untouched when there is no context to add
    (both ids absent and no attention framing), keeping the pre-feature prompt
    shape for callers that pass neither.
    """
    session_id = _clawbits_session_id(chat_id) if chat_id else None
    blocks = [_build_clawbits_context(session_id, agent_id)]
    if attention_preamble:
        blocks.append(attention_preamble)
    blocks.append(text)
    return "\n\n".join(b for b in blocks if b)
