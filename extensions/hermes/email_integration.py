"""Clawbits mailbox polling and native Hermes email tool."""

from __future__ import annotations

import html
import json
import logging
import os
import re
import tempfile
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from .attachments import cache_email_attachments
from .cli_client import _ClawbitsCli, _default_cli_path
from .manifest import PLUGIN_VERSION

logger = logging.getLogger(__name__)

EMAIL_WATERMARK_FILE = "clawbits-email-watermark.json"
DEFAULT_EMAIL_POLL_INTERVAL_SECONDS = 60.0
MIN_EMAIL_POLL_INTERVAL_SECONDS = 30.0


@dataclass(frozen=True)
class _EmailReplyContext:
    uid: int
    subject: str
    headers: dict[str, str]


class _HTMLTextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        if data.strip():
            self.parts.append(data.strip())

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() in {"br", "p", "div", "li", "tr"}:
            self.parts.append("\n")


def _html_to_text(value: str) -> str:
    parser = _HTMLTextExtractor()
    try:
        parser.feed(value)
    except Exception:
        return re.sub(r"<[^>]+>", " ", html.unescape(value))
    return re.sub(r"\n{3,}", "\n\n", " ".join(parser.parts)).strip()


def _email_body(detail: dict[str, Any]) -> str:
    plain = detail.get("body_text")
    if isinstance(plain, str) and plain.strip():
        return plain.strip()
    rich = detail.get("body_html")
    return _html_to_text(rich) if isinstance(rich, str) else ""


def _email_uids(raw: dict[str, Any]) -> list[int]:
    rows = raw.get("emails")
    if not isinstance(rows, list):
        return []
    result: list[int] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            result.append(int(row.get("uid")))
        except (TypeError, ValueError):
            continue
    return sorted(set(result))


def _reply_subject(subject: str) -> str:
    clean = subject.strip()
    if not clean:
        return "Re: (no subject)"
    return clean if clean.lower().startswith("re:") else f"Re: {clean}"


def _header(headers: dict[str, str], name: str) -> str | None:
    target = name.lower()
    for key, value in headers.items():
        if key.lower() == target and value.strip():
            return value.strip()
    return None


def _reply_headers(context: _EmailReplyContext) -> dict[str, str]:
    message_id = _header(context.headers, "message-id")
    return {"In-Reply-To": message_id, "References": message_id} if message_id else {}


def _extract_address(value: Any) -> str:
    text = str(value or "").strip().lower()
    match = re.search(r"<([^>]+)>", text)
    return (match.group(1) if match else text).strip()


def _is_self_addressed(detail: dict[str, Any], agent_id: str, mailbox: str | None) -> bool:
    sender = _extract_address(detail.get("from_addr"))
    recipient = _extract_address(detail.get("to_addr"))
    if not sender:
        return False
    if recipient and sender == recipient:
        return True
    if mailbox and sender == mailbox.lower():
        return True
    return sender.split("@", 1)[0] == agent_id.lower()


def _format_email_turn(detail: dict[str, Any], notes: list[str]) -> str:
    lines = [
        "[Email received]",
        "You received a new email in your Clawbits mailbox. Reply normally to answer by email,",
        "or use clawbits_send_email to send a separate email to your owner.",
        f"From: {detail.get('from_addr') or '(unknown)'}",
        f"To: {detail.get('to_addr') or '(you)'}",
        f"Subject: {detail.get('subject') or '(no subject)'}",
        f"Date: {detail.get('date') or '(unknown)'}",
        "[end Email received]",
        "",
        _email_body(detail) or "(no text body)",
    ]
    if notes:
        lines.extend(["", "[Attachments]", *notes, "[end Attachments]"])
    return "\n".join(lines)


def _watermark_path() -> Path:
    try:
        from hermes_constants import get_hermes_home

        home = Path(get_hermes_home())
    except Exception:
        home = Path(os.getenv("HERMES_HOME", "~/.hermes")).expanduser()
    return home / EMAIL_WATERMARK_FILE


def load_email_watermark() -> int | None:
    try:
        raw = json.loads(_watermark_path().read_text(encoding="utf-8"))
        return int(raw["last_uid"])
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None


def save_email_watermark(uid: int) -> None:
    path = _watermark_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".clawbits-email-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump({"last_uid": max(0, int(uid))}, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def prepare_email_event(detail: dict[str, Any]) -> tuple[str, list[str], list[str]]:
    paths, media_types, notes = cache_email_attachments(detail)
    return _format_email_turn(detail, notes), paths, media_types


def email_reply_context(detail: dict[str, Any]) -> _EmailReplyContext:
    raw_headers = detail.get("headers")
    headers = {
        str(key): str(value)
        for key, value in (raw_headers.items() if isinstance(raw_headers, dict) else [])
        if isinstance(value, str)
    }
    return _EmailReplyContext(
        uid=int(detail.get("uid") or 0),
        subject=str(detail.get("subject") or ""),
        headers=headers,
    )


def send_email_reply(client: Any, agent_id: str, context: _EmailReplyContext, message: str) -> Any:
    return client.email_send(
        agent_id,
        _reply_subject(context.subject),
        message,
        _reply_headers(context),
    )


def _email_tool_available() -> bool:
    return bool(os.getenv("CLAWBITS_API_KEY") and os.getenv("CLAWBITS_AGENT_ID"))


def _send_email_tool(subject: str, message: str) -> str:
    client = _ClawbitsCli(
        _default_cli_path(),
        os.getenv("CLAWBITS_BASE_URL", "http://localhost:8000"),
        os.getenv("CLAWBITS_API_KEY", ""),
        os.getenv("CLAWBITS_PLUGIN_VERSION") or PLUGIN_VERSION,
        os.getenv("CLAWBITS_CHALLENGE_ANSWER") or None,
    )
    result = client.email_send(os.getenv("CLAWBITS_AGENT_ID", ""), subject, message)
    return json.dumps(result, ensure_ascii=False)


EMAIL_TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "clawbits_send_email",
        "description": "Send an email from your Clawbits mailbox to your human owner.",
        "parameters": {
            "type": "object",
            "properties": {
                "subject": {"type": "string", "description": "Email subject."},
                "message": {"type": "string", "description": "Plain-text email body."},
            },
            "required": ["subject", "message"],
        },
    },
}
