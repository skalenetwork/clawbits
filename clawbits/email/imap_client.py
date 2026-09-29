"""Stalwart IMAP client wrapper for agent email inboxes.

Each agent has an email address ``{agent_id}@{EMAIL_DOMAIN}``. We read any
agent's mailbox with a single service credential using Stalwart v0.16
**administrative impersonation**: log in as ``{target}%{service}`` with the
*service account's* password (the service account holds the ``impersonate``
permission). Agent accounts themselves have no password.

Environment variables:
    STALWART_IMAP_HOST        - IMAP server hostname (compose: stalwart, dev: localhost)
    STALWART_IMAP_PORT        - IMAP server port (default: 993 for SSL)
    STALWART_IMAP_USE_SSL     - "true" to use SSL (default: true)
    STALWART_IMAP_VERIFY_SSL  - "true" to verify SSL certificates (default: true)
    STALWART_SVC_USER         - service/impersonator account (default: admin)
    STALWART_SVC_PASSWORD     - service account password (required)
    STALWART_EMAIL_DOMAIN     - Email domain (via clawbits.domain.EMAIL_DOMAIN)
    STALWART_IMPERSONATE_SEP  - impersonation separator char (default: %)
    STALWART_IMAP_TIMEOUT_SECONDS - per-operation socket timeout (default: 30)
    STALWART_AUTHSERV_ID      - authserv-id of Stalwart's own Authentication-Results
                                (unset: every sender verdict is "unknown")
"""
import base64
import email
import email.header
import email.utils
import logging
import os
import quopri
from collections.abc import Generator, Iterator
from contextlib import contextmanager
from email.message import Message

from imapclient import IMAPClient

from clawbits.domain import EMAIL_DOMAIN
from clawbits.email.sender_auth import UNTRUSTED_AUTH_HEADERS, sender_auth_verdict

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

STALWART_IMAP_HOST = os.getenv("STALWART_IMAP_HOST", "localhost")
STALWART_IMAP_PORT = int(os.getenv("STALWART_IMAP_PORT", "993"))
STALWART_IMAP_USE_SSL = os.getenv("STALWART_IMAP_USE_SSL", "true").lower() == "true"
STALWART_IMAP_VERIFY_SSL = os.getenv("STALWART_IMAP_VERIFY_SSL", "true").lower() == "true"
STALWART_SVC_USER = os.getenv("STALWART_SVC_USER", "admin")
STALWART_SVC_PASSWORD = os.getenv("STALWART_SVC_PASSWORD", "")
STALWART_EMAIL_DOMAIN = EMAIL_DOMAIN
STALWART_IMPERSONATE_SEP = os.getenv("STALWART_IMPERSONATE_SEP", "%")
STALWART_IMAP_TIMEOUT = float(os.getenv("STALWART_IMAP_TIMEOUT_SECONDS", "30"))
STALWART_AUTHSERV_ID = os.getenv("STALWART_AUTHSERV_ID", "").strip() or None


class MailboxEpochChanged(Exception):
    """The INBOX UIDVALIDITY differs from the caller's, so its UIDs now name different messages."""

    def __init__(self, uidvalidity: int):
        super().__init__(f"mailbox epoch changed (uidvalidity={uidvalidity})")
        self.uidvalidity = uidvalidity


def agent_email_address(agent_id: str) -> str:
    """Return the email address for an agent, e.g. ``YellowMess@clawbits.ai``."""
    return f"{agent_id}@{STALWART_EMAIL_DOMAIN}"


# ---------------------------------------------------------------------------
# Connection context manager
# ---------------------------------------------------------------------------

@contextmanager
def _imap_connection(agent_id: str) -> Generator[IMAPClient]:
    """Open an IMAP connection to *agent_id*'s mailbox via admin impersonation.

    We log in as ``{agent}@{domain}%{service}`` with the service account's
    password. Agent accounts have no password of their own; the impersonator's
    credentials are what Stalwart verifies. Account names are lowercase.
    """
    target = f"{agent_id.lower()}@{STALWART_EMAIL_DOMAIN}"
    account_user = f"{target}{STALWART_IMPERSONATE_SEP}{STALWART_SVC_USER}"
    account_password = STALWART_SVC_PASSWORD

    ssl_context = None
    if STALWART_IMAP_USE_SSL and not STALWART_IMAP_VERIFY_SSL:
        import ssl
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE

    client = IMAPClient(
        STALWART_IMAP_HOST,
        port=STALWART_IMAP_PORT,
        ssl=STALWART_IMAP_USE_SSL,
        ssl_context=ssl_context,
        timeout=STALWART_IMAP_TIMEOUT,
    )
    try:
        # Login with lowercased agent account credentials
        client.login(account_user, account_password)
        logger.debug(f"IMAP authenticated as {account_user}")
        yield client
    finally:
        try:
            client.logout()
        except Exception:
            pass


def _select_inbox(client: IMAPClient, *, readonly: bool, uidvalidity: int | None = None) -> dict:
    """SELECT (or EXAMINE when readonly) INBOX; raise MailboxEpochChanged on an epoch mismatch."""
    selected = client.select_folder("INBOX", readonly=readonly)
    if uidvalidity is not None and selected[b"UIDVALIDITY"] != uidvalidity:
        raise MailboxEpochChanged(selected[b"UIDVALIDITY"])
    return selected


# ---------------------------------------------------------------------------
# Helper: decode header value
# ---------------------------------------------------------------------------

def _decode_header(value: str | bytes | None) -> str:
    """Decode an RFC 2047 encoded header value into a plain string."""
    if value is None:
        return ""
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    parts = email.header.decode_header(value)
    decoded = []
    for part, charset in parts:
        if isinstance(part, bytes):
            decoded.append(part.decode(charset or "utf-8", errors="replace"))
        else:
            decoded.append(part)
    return " ".join(decoded)


# ---------------------------------------------------------------------------
# Helpers: list-projection snippets + attachment detection
#
# The inbox listing enriches each summary with a short plain-text ``snippet``
# and a ``has_attachments`` flag WITHOUT marking anything ``\Seen`` (the
# folder is selected read-only, and both PREVIEW and BODY.PEEK are
# flag-neutral by spec). Preferred source is the server-computed IMAP
# ``PREVIEW`` (RFC 8970, advertised by Stalwart v0.16); the fallback peeks the
# first ``text/plain`` part found via BODYSTRUCTURE.
# ---------------------------------------------------------------------------

SNIPPET_MAX_CHARS = 140
_SNIPPET_PEEK_BYTES = 512


def _collapse_snippet(text: str) -> str | None:
    """Whitespace-collapse *text* down to a single ~140-char preview line."""
    collapsed = " ".join(text.split())
    if not collapsed:
        return None
    return collapsed[:SNIPPET_MAX_CHARS]


def _iter_leaf_parts(body, prefix: str = "") -> Iterator[tuple[str, tuple]]:
    """Yield ``(section, part)`` for every leaf of a BODYSTRUCTURE tuple.

    imapclient represents a multipart node as a tuple whose first element is a
    *list* of child parts; anything else is a leaf. Section numbers follow
    IMAP conventions ("1", "2", "1.1", ...; a non-multipart message is "1").
    """
    if not isinstance(body, tuple) or not body:
        return
    first = body[0]
    if isinstance(first, list):
        for idx, part in enumerate(first, start=1):
            section = f"{prefix}.{idx}" if prefix else str(idx)
            yield from _iter_leaf_parts(part, section)
    else:
        yield (prefix or "1", body)


def _params_have_name(params) -> bool:
    """True when a BODYSTRUCTURE param key/value tuple carries a file name."""
    if not isinstance(params, tuple):
        return False
    for i in range(0, len(params) - 1, 2):
        key = params[i]
        if isinstance(key, bytes) and key.decode("utf-8", "replace").lower() in ("name", "filename"):
            return True
    return False


def _part_is_attachment(part: tuple) -> bool:
    """Heuristic attachment test for a BODYSTRUCTURE leaf.

    Mirrors ``get_email`` (Content-Disposition: attachment) plus any part that
    names a file — so the listing paperclip matches what the detail view will
    actually show, while still flagging named inline files.
    """
    disposition_kind = None
    disposition_params: tuple = ()
    # Extension fields start after the 7 basic fields; scan defensively for
    # the disposition-shaped tuple since the exact index varies by part type.
    for element in part[7:]:
        if isinstance(element, tuple) and element and isinstance(element[0], bytes):
            kind = element[0].decode("utf-8", "replace").lower()
            if kind in ("attachment", "inline"):
                disposition_kind = kind
                if len(element) > 1 and isinstance(element[1], tuple):
                    disposition_params = element[1]
                break
    if disposition_kind == "attachment":
        return True
    params = part[2] if len(part) > 2 else None
    return _params_have_name(params) or _params_have_name(disposition_params)


def _bodystructure_has_attachments(body) -> bool:
    return any(_part_is_attachment(part) for _, part in _iter_leaf_parts(body))


def _find_text_section(body) -> tuple[str, str, str] | None:
    """Locate the first ``text/plain`` leaf: ``(section, encoding, charset)``."""
    for section, part in _iter_leaf_parts(body):
        try:
            maintype = part[0].decode("utf-8", "replace").lower()
            subtype = part[1].decode("utf-8", "replace").lower()
        except (AttributeError, IndexError):
            continue
        if maintype != "text" or subtype != "plain":
            continue
        encoding = ""
        if len(part) > 5 and isinstance(part[5], bytes):
            encoding = part[5].decode("utf-8", "replace").lower()
        charset = "utf-8"
        params = part[2] if len(part) > 2 else None
        if isinstance(params, tuple):
            for i in range(0, len(params) - 1, 2):
                key = params[i]
                if isinstance(key, bytes) and key.decode("utf-8", "replace").lower() == "charset":
                    value = params[i + 1]
                    charset = value.decode("utf-8", "replace") if isinstance(value, bytes) else str(value)
        return section, encoding, charset
    return None


def _decode_peeked_text(data: bytes, encoding: str, charset: str) -> str:
    """Best-effort decode of a *truncated* BODY.PEEK chunk."""
    if encoding == "base64":
        # A partial fetch can cut mid-quantum; trim to a whole one.
        trimmed = data[: len(data) - (len(data) % 4)]
        try:
            data = base64.b64decode(trimmed)
        except Exception:
            return ""
    elif encoding == "quoted-printable":
        try:
            data = quopri.decodestring(data)
        except Exception:
            pass
    try:
        return data.decode(charset or "utf-8", errors="replace")
    except LookupError:
        return data.decode("utf-8", errors="replace")


def _peek_response_bytes(data: dict) -> bytes | None:
    """Pull the BODY[...] payload out of a fetch response item."""
    for key, value in data.items():
        if isinstance(key, bytes) and key.startswith(b"BODY[") and isinstance(value, bytes):
            return value
    return None


def _fetch_summaries(client: IMAPClient, uids: list[int]) -> list[dict]:
    """Summary dicts for *uids* in the given order; vanished or unrequested UIDs are skipped."""
    # Fetch envelope data for the page. PREVIEW (RFC 8970) rides along in
    # the same round-trip when the server supports it.
    fetch_items = ["FLAGS", "RFC822.SIZE", "ENVELOPE", "BODYSTRUCTURE"]
    supports_preview = b"PREVIEW" in client.capabilities()
    if supports_preview:
        fetch_items.append("PREVIEW")
    fetch_data = client.fetch(uids, fetch_items)

    # Fallback snippets: for messages the server gave no PREVIEW for, peek
    # the head of their first text/plain part — grouped by section so a
    # whole page costs one extra round-trip per distinct section path.
    peek_sections: dict[str, list[int]] = {}
    peek_decode: dict[int, tuple[str, str]] = {}
    if not supports_preview:
        for uid in uids:
            data = fetch_data.get(uid)
            if data is None:
                continue
            located = _find_text_section(data.get(b"BODYSTRUCTURE"))
            if located is None:
                continue  # HTML-only or bodiless: honest snippet=None
            section, encoding, charset = located
            peek_sections.setdefault(section, []).append(uid)
            peek_decode[uid] = (encoding, charset)
    peeked_text: dict[int, str] = {}
    for section, section_uids in peek_sections.items():
        peek_data = client.fetch(section_uids, [f"BODY.PEEK[{section}]<0.{_SNIPPET_PEEK_BYTES}>"])
        for uid in section_uids:
            raw = _peek_response_bytes(peek_data.get(uid, {}))
            if raw is None:
                continue
            encoding, charset = peek_decode[uid]
            peeked_text[uid] = _decode_peeked_text(raw, encoding, charset)

    emails = []
    for uid in uids:
        data = fetch_data.get(uid)
        if data is None:
            continue

        envelope = data.get(b"ENVELOPE")
        flags = data.get(b"FLAGS", ())
        size = data.get(b"RFC822.SIZE", 0)

        is_read = b"\\Seen" in flags

        # Parse envelope fields
        from_addr = ""
        to_addr = ""
        subject = ""
        date_str = ""

        if envelope:
            subject = _decode_header(envelope.subject) if envelope.subject else ""
            date_str = envelope.date.isoformat() if envelope.date else ""
            if envelope.from_ and len(envelope.from_) > 0:
                addr = envelope.from_[0]
                from_addr = f"{addr.mailbox.decode('utf-8', errors='replace')}@{addr.host.decode('utf-8', errors='replace')}" if addr.mailbox and addr.host else str(addr)
            if envelope.to and len(envelope.to) > 0:
                addr = envelope.to[0]
                to_addr = f"{addr.mailbox.decode('utf-8', errors='replace')}@{addr.host.decode('utf-8', errors='replace')}" if addr.mailbox and addr.host else str(addr)

        snippet = None
        if supports_preview:
            preview = data.get(b"PREVIEW")
            if isinstance(preview, bytes):
                snippet = _collapse_snippet(preview.decode("utf-8", errors="replace"))
            elif isinstance(preview, str):
                snippet = _collapse_snippet(preview)
        elif uid in peeked_text:
            snippet = _collapse_snippet(peeked_text[uid])

        emails.append({
            "uid": uid,
            "from_addr": from_addr,
            "to_addr": to_addr,
            "subject": subject,
            "date": date_str,
            "is_read": is_read,
            "size": size,
            "snippet": snippet,
            "has_attachments": _bodystructure_has_attachments(data.get(b"BODYSTRUCTURE")),
        })
    return emails


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def get_email_counts(agent_id: str) -> dict:
    """Return ``{"total": N, "unread": M}`` using the IMAP STATUS command (fast)."""
    with _imap_connection(agent_id) as client:
        status = client.folder_status("INBOX", ["MESSAGES", "UNSEEN"])
        return {
            "total": status.get(b"MESSAGES", 0),
            "unread": status.get(b"UNSEEN", 0),
            "email_address": agent_email_address(agent_id),
        }


def list_emails(agent_id: str, limit: int = 50, offset: int = 0, unread_only: bool = False) -> dict:
    """List emails in the agent's INBOX.

    Returns ``{"emails": [...], "total": N, "unread_count": M, "limit": ..., "offset": ...}``.
    Emails are sorted newest-first. With ``unread_only`` the listing is
    filtered to UNSEEN messages and ``total`` becomes the count of *matching*
    messages (so pagination stays correct for the filtered view).

    Each summary also carries ``snippet`` (short plain-text preview, ``None``
    when unavailable) and ``has_attachments``. The folder is selected
    read-only and previews use PREVIEW / BODY.PEEK, so listing never marks
    anything ``\\Seen``.
    """
    with _imap_connection(agent_id) as client:
        client.select_folder("INBOX", readonly=True)

        # Get counts
        status = client.folder_status("INBOX", ["MESSAGES", "UNSEEN"])
        mailbox_total = status.get(b"MESSAGES", 0)
        unread_count = status.get(b"UNSEEN", 0)

        if mailbox_total == 0:
            return {
                "emails": [],
                "total": 0,
                "unread_count": 0,
                "limit": limit,
                "offset": offset,
            }

        # Search (optionally filtered), sort newest first
        all_uids = client.search(["UNSEEN"] if unread_only else ["ALL"])
        all_uids.sort(reverse=True)  # newest first
        total = len(all_uids) if unread_only else mailbox_total

        # Paginate
        page_uids = all_uids[offset: offset + limit]

        if not page_uids:
            return {
                "emails": [],
                "total": total,
                "unread_count": unread_count,
                "limit": limit,
                "offset": offset,
            }

        emails = _fetch_summaries(client, page_uids)

        return {
            "emails": emails,
            "total": total,
            "unread_count": unread_count,
            "limit": limit,
            "offset": offset,
        }


def list_changes(
    agent_id: str,
    after_uid: int = 0,
    *,
    uidvalidity: int | None = None,
    through_uid: int | None = None,
    limit: int = 50,
) -> dict:
    """Ascending summaries with ``after_uid < uid <= through_uid`` in one epoch; flag-neutral (EXAMINE).

    ``through_uid`` is clamped to UIDNEXT-1 and defaults to it, fixing the scan's upper bound on its
    first page. ``next_after_uid`` is the cursor for the next page (or scan).
    """
    with _imap_connection(agent_id) as client:
        selected = _select_inbox(client, readonly=True, uidvalidity=uidvalidity)
        newest = selected[b"UIDNEXT"] - 1
        through = newest if through_uid is None else min(through_uid, newest)
        after = max(after_uid, 0)
        uids: list[int] = []
        if through > after:
            # Explicit bounds, never "n:*": "*" is the highest existing UID, so "n:*" matches it even past n.
            uids = sorted(u for u in client.search(["UID", f"{after + 1}:{through}"]) if after < u <= through)
        page, has_more = uids[:limit], len(uids) > limit
        return {
            "uidvalidity": selected[b"UIDVALIDITY"],
            "through_uid": through,
            "emails": _fetch_summaries(client, page) if page else [],
            "next_after_uid": page[-1] if has_more else max(after, through),
            "has_more": has_more,
        }


def get_email(
    agent_id: str,
    message_uid: int,
    *,
    uidvalidity: int | None = None,
    mark_read: bool = True,
    attachment_content: bool = True,
) -> dict | None:
    """Fetch a single email by UID with full body content, or ``None`` if the UID does not exist.

    By default the message is marked read (\\Seen); ``mark_read=False`` uses EXAMINE + BODY.PEEK[]
    and reports the stored flag. ``sender_auth`` carries the MTA's DMARC verdict, and the untrusted
    authentication headers are left out of ``headers``. ``attachment_content=False`` omits
    ``content_b64`` but still reports each attachment's size.
    """
    with _imap_connection(agent_id) as client:
        _select_inbox(client, readonly=not mark_read, uidvalidity=uidvalidity)

        body_item = "RFC822" if mark_read else "BODY.PEEK[]"
        fetch_data = client.fetch([message_uid], ["FLAGS", body_item, "RFC822.SIZE"])
        if message_uid not in fetch_data:
            return None

        data = fetch_data[message_uid]
        raw = data.get(b"RFC822" if mark_read else b"BODY[]", b"")
        flags = data.get(b"FLAGS", ())
        size = data.get(b"RFC822.SIZE", 0)

        is_read = b"\\Seen" in flags
        if mark_read and not is_read:
            client.add_flags([message_uid], [b"\\Seen"])
            is_read = True

        msg: Message = email.message_from_bytes(raw)

        from_addr = _decode_header(msg.get("From", ""))
        to_addr = _decode_header(msg.get("To", ""))
        subject = _decode_header(msg.get("Subject", ""))
        date_str = msg.get("Date", "")

        headers = {k: _decode_header(v) for k, v in msg.items() if k.lower() not in UNTRUSTED_AUTH_HEADERS}

        body_text = None
        body_html = None
        attachments = []

        if msg.is_multipart():
            for part in msg.walk():
                content_type = part.get_content_type()
                disposition = str(part.get("Content-Disposition", ""))

                if "attachment" in disposition:
                    payload = part.get_payload(decode=True) or b""
                    attachment = {
                        "filename": part.get_filename() or "unnamed",
                        "content_type": content_type,
                        "size": len(payload),
                    }
                    if attachment_content:
                        attachment["content_b64"] = base64.b64encode(payload).decode("utf-8")
                    attachments.append(attachment)
                elif content_type == "text/plain" and body_text is None:
                    payload = part.get_payload(decode=True)
                    if payload:
                        charset = part.get_content_charset() or "utf-8"
                        body_text = payload.decode(charset, errors="replace")
                elif content_type == "text/html" and body_html is None:
                    payload = part.get_payload(decode=True)
                    if payload:
                        charset = part.get_content_charset() or "utf-8"
                        body_html = payload.decode(charset, errors="replace")
        else:
            content_type = msg.get_content_type()
            payload = msg.get_payload(decode=True)
            if payload:
                charset = msg.get_content_charset() or "utf-8"
                text = payload.decode(charset, errors="replace")
                if content_type == "text/html":
                    body_html = text
                else:
                    body_text = text

        return {
            "uid": message_uid,
            "from_addr": from_addr,
            "to_addr": to_addr,
            "subject": subject,
            "date": date_str,
            "is_read": is_read,
            "size": size,
            "body_text": body_text,
            "body_html": body_html,
            "attachments": attachments,
            "headers": headers,
            "sender_auth": sender_auth_verdict(msg, STALWART_AUTHSERV_ID),
        }


def delete_email(agent_id: str, message_uid: int, *, uidvalidity: int | None = None) -> bool:
    """Delete a message by UID, optionally only within the caller's epoch. False if the UID is not found."""
    with _imap_connection(agent_id) as client:
        _select_inbox(client, readonly=False, uidvalidity=uidvalidity)

        # Verify UID exists
        fetch_data = client.fetch([message_uid], ["FLAGS"])
        if message_uid not in fetch_data:
            return False

        client.delete_messages([message_uid])
        client.expunge()
        return True


def set_email_read(agent_id: str, message_uid: int, read: bool) -> bool:
    """Set or clear the ``\\Seen`` flag on a message by UID.

    Returns True on success, False if the UID does not exist.
    """
    with _imap_connection(agent_id) as client:
        client.select_folder("INBOX")

        # Verify UID exists
        fetch_data = client.fetch([message_uid], ["FLAGS"])
        if message_uid not in fetch_data:
            return False

        if read:
            client.add_flags([message_uid], [b"\\Seen"])
        else:
            client.remove_flags([message_uid], [b"\\Seen"])
        return True

