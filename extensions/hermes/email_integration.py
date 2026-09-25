"""Clawbits mail parsing helpers and the native Hermes email tool."""

from __future__ import annotations

import html
import json
import logging
import re
from dataclasses import dataclass
from email.utils import getaddresses
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from .account import active_account
from .email_reader import MAX_HTML_CHARS
from .health import error_code

logger = logging.getLogger(__name__)

EMAIL_WATERMARK_FILE = "clawbits-email-watermark.json"
DEFAULT_EMAIL_POLL_INTERVAL_SECONDS = 60.0
MIN_EMAIL_POLL_INTERVAL_SECONDS = 30.0

# Server limits on EmailSendRequest (clawbits/datastructures/email_models.py):
# message is 1..10000 and subject is 1..256. Anything longer 422s, so the plugin
# fits the reply itself before it is queued for sending.
EMAIL_BODY_MAX_CHARS = 9_500
EMAIL_SUBJECT_MAX_CHARS = 256
_EMAIL_TRUNCATION_NOTE = "\n\n[... truncated — the full reply is in the Clawbits chat.]"

# Headers that mark a message as machine-generated (RFC 3834 and the de-facto
# List-Id/Precedence conventions). Replying to one is how mail loops start.
_AUTOMATED_HEADERS = ("auto-submitted", "list-id", "list-unsubscribe")
_AUTO_PRECEDENCE_VALUES = frozenset({"bulk", "list", "junk", "auto_reply"})
# RFC 5322 msg-id tokens; anything else in Message-ID/References is dropped from a reply.
_MSG_ID = re.compile(r"<[^<>\s@]{1,250}@[^<>\s@]{1,250}>")
MAX_REFERENCES = 10


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


def email_body(detail: dict[str, Any]) -> tuple[str, bool]:
    """``(text, truncated)``: the plain body, else text extracted from the HTML body cut at
    MAX_HTML_CHARS."""
    plain = detail.get("body_text")
    if isinstance(plain, str) and plain.strip():
        return plain.strip(), False
    rich = detail.get("body_html")
    if not isinstance(rich, str):
        return "", False
    return _html_to_text(rich[:MAX_HTML_CHARS]), len(rich) > MAX_HTML_CHARS


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
    if not clean.lower().startswith("re:"):
        clean = f"Re: {clean}"
    return clean[:EMAIL_SUBJECT_MAX_CHARS]


def fit_email_body(message: str) -> str:
    """Fit a reply into the server's body limit; over it the send 422s and the reply is lost."""
    text = str(message or "").strip()
    if not text:
        return "(the agent produced an empty reply)"
    if len(text) <= EMAIL_BODY_MAX_CHARS:
        return text
    kept = text[: EMAIL_BODY_MAX_CHARS - len(_EMAIL_TRUNCATION_NOTE)].rstrip()
    return kept + _EMAIL_TRUNCATION_NOTE


def _header(headers: dict[str, str], name: str) -> str | None:
    target = name.lower()
    for key, value in headers.items():
        if key.lower() == target and value.strip():
            return value.strip()
    return None


def _reply_headers(context: _EmailReplyContext) -> dict[str, str]:
    # Auto-Submitted lets the far side's own loop prevention recognise this as a
    # machine reply and not answer it (RFC 3834).
    headers = {"Auto-Submitted": "auto-replied"}
    message_ids = _MSG_ID.findall(_header(context.headers, "message-id") or "")
    if message_ids:
        message_id = message_ids[0]
        references = _MSG_ID.findall(_header(context.headers, "references") or "")
        chain = [ref for ref in references if ref != message_id] + [message_id]
        headers["In-Reply-To"] = message_id
        headers["References"] = " ".join(chain[-MAX_REFERENCES:])
    return headers


def _headers_of(detail: dict[str, Any]) -> dict[str, str]:
    raw_headers = detail.get("headers")
    return raw_headers if isinstance(raw_headers, dict) else {}


def _header_set(headers: dict[str, str], name: str) -> bool:
    value = _header(headers, name)
    return bool(value) and value.lower() != "no"


def is_automated(detail: dict[str, Any]) -> bool:
    """Bulk, list or auto-submitted mail (the ingestion class), separate from reply-loop
    suppression."""
    headers = _headers_of(detail)
    if any(_header_set(headers, name) for name in _AUTOMATED_HEADERS):
        return True
    return (_header(headers, "precedence") or "").lower() in _AUTO_PRECEDENCE_VALUES


def is_auto_submitted(detail: dict[str, Any]) -> bool:
    """Never auto-reply to this message: it is automated or asks for no auto-responses.

    Answering an autoresponder is the classic mail loop: the agent replies, the
    far side auto-replies, and neither side stops.
    """
    return is_automated(detail) or _header_set(_headers_of(detail), "x-auto-response-suppress")


def _extract_address(value: Any) -> str:
    """The lowercased addr-spec of a single-address header value; empty for none or several."""
    found = [addr.strip().lower() for _, addr in getaddresses([str(value or "")]) if addr.strip()]
    return found[0] if len(found) == 1 else ""


def message_id(detail: dict[str, Any]) -> str | None:
    """The first valid msg-id token of the Message-ID header."""
    found = _MSG_ID.findall(_header(_headers_of(detail), "message-id") or "")
    return found[0] if found else None


def _is_self_addressed(detail: dict[str, Any], agent_id: str, mailbox: str | None) -> bool:
    """Mail from this agent's own address: the backend's ``sender_auth.address``, else the parsed
    From addr-spec (a display name never counts)."""
    auth = detail.get("sender_auth")
    address = auth.get("address") if isinstance(auth, dict) else None
    sender = address.strip().lower() if isinstance(address, str) else ""
    sender = sender or _extract_address(detail.get("from_addr"))
    if not sender:
        return False
    if mailbox and sender == mailbox.lower():
        return True
    local, _, domain = sender.partition("@")
    # Match the local part ONLY within the agent's own mail domain: a stranger
    # at <agent_id>@gmail.com is a different person, and swallowing their mail
    # silently is worse than answering it.
    own_domain = not mailbox or domain == mailbox.lower().partition("@")[2]
    return local == agent_id.lower() and own_domain


def _watermark_path(home: Path) -> Path:
    return home / EMAIL_WATERMARK_FILE


def load_email_watermark(home: Path) -> tuple[int | None, int | None]:
    """Return ``(last_uid, uidvalidity)``; either is None when not recorded.

    IMAP UIDs are only monotonic within one UIDVALIDITY. Without recording it, a
    mailbox reprovision that resets UIDs to 1 leaves every new message below the
    stored watermark and intake stops permanently and silently.
    """
    try:
        raw = json.loads(_watermark_path(home).read_text(encoding="utf-8"))
        last_uid = int(raw["last_uid"])
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None, None
    validity = raw.get("uidvalidity")
    return last_uid, int(validity) if isinstance(validity, (int, float)) else None


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


def _email_tool_available() -> bool:
    """True only for a usable account with sending enabled and a running mailroom."""
    from .mailroom import active_mailroom

    try:
        account = active_account()
    except Exception:
        return False
    return bool(account and account.send_email and active_mailroom())


def _tool_error(message: str, code: str) -> str:
    return json.dumps({"error": message, "code": code})


def _send_email_tool(args: dict[str, Any], **_: Any) -> str:
    """Send through the active profile's mailroom; the delivery state, or ``{error, code}``."""
    from .mailroom import active_mailroom

    try:
        account = active_account()
    except Exception:
        account = None
    if account is None:
        return _tool_error("Clawbits is not configured for this profile", "clawbits_unavailable")
    if not account.send_email:
        return _tool_error("Sending email is disabled for this profile", "email_send_disabled")
    mailroom = active_mailroom()
    if mailroom is None:
        return _tool_error("The Clawbits gateway is not running for this profile",
                           "clawbits_unavailable")
    try:
        result = mailroom.send_tool_email(str(args.get("subject") or ""),
                                          str(args.get("message") or ""))
    except Exception as exc:
        logger.warning("clawbits: send tool failed (%s)", error_code(exc))
        return _tool_error("The email could not be recorded for sending", error_code(exc))
    return json.dumps(result, ensure_ascii=False)


EMAIL_TOOL_SCHEMA = {
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
}
