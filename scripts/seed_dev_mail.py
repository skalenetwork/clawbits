#!/usr/bin/env python
"""Seed a local dev agent's mailbox with realistic sample emails.

Local-loop email dev — no DNS, no public deliverability. This provisions the
agent's mailbox if needed, then injects messages straight into its INBOX via
IMAP APPEND using Stalwart admin impersonation (the same credential path the
app uses). It lets you exercise the human Inbox tab end to end — list, open
(mark-read), attachments, HTML bodies, delete — against the local Stalwart.

Prereq: the dev Stalwart container is up, e.g.
    docker compose -f compose.yaml -f compose.override.yaml up -d db redis stalwart

Usage (dev defaults are baked in, so it works with no env; running under
dotenvx makes it use .env.development instead):
    .venv/bin/python scripts/seed_dev_mail.py Electrolyte
    .venv/bin/python scripts/seed_dev_mail.py Electrolyte --count 3 --reset
    dotenvx run -f .env.development -- .venv/bin/python scripts/seed_dev_mail.py LoomGlow

Options:
    --count N        only inject the N newest samples (default: all)
    --reset          delete any existing INBOX messages first (idempotent re-seed)
    --no-provision   skip ensuring the mailbox exists (assume it already does)
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from email import encoders
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formatdate

from imapclient import SEEN

# Dev defaults — set BEFORE importing clawbits.email (those modules read these
# at import time). setdefault means a real environment / dotenvx wins. Mirrors
# tests/fastapi/test_email.py so the local loop "just works".
_DEV_ENV = {
    "STALWART_EMAIL_DOMAIN": "mail.clawbits.ai",
    "STALWART_SVC_USER": "admin",
    "STALWART_SVC_PASSWORD": "dev-svc-secret",
    "STALWART_IMPERSONATE_SEP": "%",
    "STALWART_MGMT_URL": "http://172.30.99.10:8080",
    "STALWART_MGMT_VERIFY_SSL": "false",
    "STALWART_IMAP_HOST": "172.30.99.10",
    "STALWART_IMAP_PORT": "993",
    "STALWART_IMAP_USE_SSL": "true",
    "STALWART_IMAP_VERIFY_SSL": "false",
}
for _k, _v in _DEV_ENV.items():
    os.environ.setdefault(_k, _v)

# Run from anywhere: clawbits is used from the source tree (not pip-installed),
# so put the repo root on the import path.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from clawbits.email.imap_client import (  # noqa: E402  (env + sys.path first)
    STALWART_SVC_PASSWORD,
    _imap_connection,
    agent_email_address,
    get_email_counts,
)
from clawbits.email.stalwart_provision import provision_mailbox  # noqa: E402

_HOUR = 3600
_DAY = 86400


def _sample_messages(agent_addr: str) -> list[bytes]:
    """A small bank of varied messages (plain, HTML, attachment) — newest first.

    Dates are staggered so the list reads naturally; the inbox sorts by IMAP
    UID, so callers append oldest-first to keep UID order aligned with date.
    """
    now = time.time()

    def _stamp(msg, frm: str, subject: str, ago: float) -> bytes:
        msg["From"] = frm
        msg["To"] = agent_addr
        msg["Subject"] = subject
        msg["Date"] = formatdate(now - ago, localtime=True)
        return msg.as_bytes()

    def plain(frm, subject, body, ago):
        return _stamp(MIMEText(body, "plain", "utf-8"), frm, subject, ago)

    def html(frm, subject, body, ago):
        return _stamp(MIMEText(body, "html", "utf-8"), frm, subject, ago)

    def attached(frm, subject, body, filename, content, ago):
        m = MIMEMultipart()
        m.attach(MIMEText(body, "plain", "utf-8"))
        part = MIMEBase("application", "octet-stream")
        part.set_payload(content)
        encoders.encode_base64(part)
        part.add_header("Content-Disposition", f'attachment; filename="{filename}"')
        m.attach(part)
        return _stamp(m, frm, subject, ago)

    return [
        plain(
            "Priya Nair <priya@brightpath.example>",
            "Lunch next week?",
            "Hey! Are you free for lunch on Tuesday or Wednesday? Would love to catch up.",
            0.4 * _HOUR,
        ),
        plain(
            "Maya Reed <maya@northwind.example>",
            "Q3 partnership follow-up",
            "Hi there,\n\nThanks for the call earlier. Sharing the deck and the proposed "
            "timeline so we can lock scope by Friday.\n\nBest,\nMaya",
            2 * _HOUR,
        ),
        attached(
            "Devon Park <devon@brightpath.example>",
            "Re: API access for the integration",
            "Sounds good - I've enabled the sandbox key on our side. Onboarding notes attached.",
            "onboarding-notes.txt",
            b"1. Use the sandbox base URL.\n2. Rotate the key after go-live.\n",
            5 * _HOUR,
        ),
        html(
            "GitHub <notifications@github.example>",
            "[clawbits] PR #42 merged",
            "<div style='font-family:sans-serif'><h2>Pull request merged</h2>"
            "<p><b>#42 Add agent inbox</b> was merged into <code>main</code>.</p>"
            "<p><a href='https://example.com'>View on GitHub</a></p></div>",
            1 * _DAY,
        ),
        plain(
            "billing@stripe.example",
            "Your receipt from Northwind Labs",
            "This is a receipt for your recent payment of $480.00. No action needed.",
            2 * _DAY,
        ),
        html(
            "Acme Weekly <news@acme.example>",
            "This week in Acme: 5 things to know",
            "<div style='font-family:sans-serif'><h3>Acme Weekly</h3><ol>"
            "<li>New dashboard shipped</li><li>API v2 in beta</li><li>Hiring 3 engineers</li>"
            "<li>Community call Thursday</li><li>Status page revamp</li></ol></div>",
            3 * _DAY,
        ),
    ]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Seed a local dev agent's inbox with sample emails.")
    ap.add_argument("agent_id", help="agent handle, e.g. Electrolyte")
    ap.add_argument("--count", type=int, default=None, help="only the N newest samples (default: all)")
    ap.add_argument("--reset", action="store_true", help="delete existing INBOX messages first")
    ap.add_argument("--no-provision", action="store_true", help="skip ensuring the mailbox exists")
    args = ap.parse_args(argv)

    if not STALWART_SVC_PASSWORD:
        print(
            "STALWART_SVC_PASSWORD is empty — run under dotenvx (-f .env.development) "
            "or export the dev value.",
            file=sys.stderr,
        )
        return 2

    agent_id = args.agent_id
    addr = agent_email_address(agent_id)

    if not args.no_provision:
        try:
            created = provision_mailbox(agent_id)
            print(f"provision {addr}: {'ok' if created else 'already existed'}")
        except Exception as e:  # noqa: BLE001 — best-effort; the mailbox may already exist
            print(f"warning: provisioning failed ({e}); continuing", file=sys.stderr)

    messages = _sample_messages(addr)
    if args.count is not None:
        messages = messages[: max(0, args.count)]

    # Append oldest-first so the highest IMAP UID is the most recent message
    # (the inbox sorts by UID, newest first). Mark the oldest third as read so
    # the UI shows both read and unread styling.
    ordered = list(reversed(messages))
    read_until = len(ordered) // 3

    try:
        with _imap_connection(agent_id) as client:
            if args.reset:
                client.select_folder("INBOX")
                existing = client.search(["ALL"])
                if existing:
                    client.delete_messages(existing)
                    client.expunge()
                    print(f"reset: removed {len(existing)} existing message(s)")
            for i, raw in enumerate(ordered):
                client.append("INBOX", raw, flags=[SEEN] if i < read_until else [])
        counts = get_email_counts(agent_id)
    except Exception as e:  # noqa: BLE001 — surface a friendly hint instead of a traceback
        print(f"error: could not seed {addr}: {e}", file=sys.stderr)
        print("Is the dev Stalwart up?  docker compose ... up -d stalwart", file=sys.stderr)
        return 1

    print(f"seeded {len(ordered)} message(s) into {addr}")
    print(f"INBOX now: total={counts['total']} unread={counts['unread']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
