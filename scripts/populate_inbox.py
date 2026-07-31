#!/usr/bin/env python3
"""Populate a local dev agent's email INBOX with test messages.

Drops messages straight into the agent's Stalwart INBOX via IMAP APPEND (admin
impersonation), bypassing SMTP and the spam filter - so they always land where
the app's inbox view + email poller read (INBOX), not in Junk.

Usage:
    python scripts/populate_inbox.py <agent_id> [count]
    python scripts/populate_inbox.py soapmap 8

Env (defaults match .env.development):
    STALWART_IMAP_HOST=localhost  STALWART_IMAP_PORT=993
    STALWART_SVC_USER=admin       STALWART_SVC_PASSWORD=dev-svc-secret
    STALWART_EMAIL_DOMAIN=mail.clawbits.ai   STALWART_IMPERSONATE_SEP=%
"""
import os
import ssl
import sys
import time
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

HOST = os.getenv("STALWART_IMAP_HOST", "localhost")
PORT = int(os.getenv("STALWART_IMAP_PORT", "993"))
SVC_USER = os.getenv("STALWART_SVC_USER", "admin")
SVC_PASS = os.getenv("STALWART_SVC_PASSWORD", "dev-svc-secret")
DOMAIN = os.getenv("STALWART_EMAIL_DOMAIN", "mail.clawbits.ai")
SEP = os.getenv("STALWART_IMPERSONATE_SEP", "%")

# (from_name, from_addr, subject, body)
SAMPLES = [
    ("Alice Chen", "alice@example.com", "Lunch tomorrow?",
     "Hey! Are you free for lunch tomorrow around noon? Thinking the place on 5th."),
    ("GitHub", "notifications@github.com", "[clawbits] PR #204 needs review",
     "Dmytro requested your review on pull request #204: 'automations: run-now'.\n\nView it: https://github.com/skalenetwork/clawbits/pull/204"),
    ("Stripe", "receipts@stripe.com", "Your receipt from Acme Inc.",
     "Thanks for your payment of $49.00. Invoice #A1B2C3. This is a test receipt."),
    ("Bob Martinez", "bob@example.org", "Re: quarterly numbers",
     "Attached are the revised figures. Let me know if the Q3 column looks right to you.\n\n- Bob"),
    ("Calendar", "calendar@example.com", "Reminder: standup at 10:00",
     "This is a reminder that 'Daily Standup' starts in 15 minutes.\n\nJoin: https://meet.example.com/standup"),
    ("Newsletter", "hello@techdigest.example", "This week in AI",
     "Top stories: new model releases, agent frameworks, and more. Unsubscribe anytime."),
    ("Support", "support@vendor.example", "Ticket #5521 resolved",
     "Your support ticket has been marked resolved. Reply to reopen if the issue persists."),
    ("Mom", "mom@family.example", "call me when you get a chance",
     "Nothing urgent, just wanted to hear how you're doing. Love you."),
]


def imap_connect(agent_id: str):
    import imaplib
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    client = imaplib.IMAP4_SSL(HOST, PORT, ssl_context=ctx)
    target = f"{agent_id.lower()}@{DOMAIN}"
    client.login(f"{target}{SEP}{SVC_USER}", SVC_PASS)
    return client


def build(agent_id: str, from_name, from_addr, subject, body, minutes_ago: int) -> EmailMessage:
    m = EmailMessage()
    m["From"] = f"{from_name} <{from_addr}>"
    m["To"] = f"{agent_id.lower()}@{DOMAIN}"
    m["Subject"] = subject
    m["Date"] = formatdate(time.time() - minutes_ago * 60, localtime=True)
    m["Message-ID"] = make_msgid(domain=from_addr.split("@")[-1])
    m.set_content(body)
    return m


def main():
    import imaplib
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    agent_id = sys.argv[1]
    count = int(sys.argv[2]) if len(sys.argv) > 2 else len(SAMPLES)

    client = imap_connect(agent_id)
    try:
        client.select("INBOX")
        n = 0
        for i in range(count):
            fn, fa, subj, body = SAMPLES[i % len(SAMPLES)]
            # stagger dates so they sort naturally, newest last-appended
            msg = build(agent_id, fn, fa, subj, body, minutes_ago=(count - i) * 7)
            # append unread: empty flag string leaves \Seen off
            typ, resp = client.append(
                "INBOX", "", imaplib.Time2Internaldate(time.time()), msg.as_bytes()
            )
            if typ == "OK":
                n += 1
            else:
                print("  append failed:", resp)
        typ, data = client.select("INBOX")
        print(f"Appended {n} message(s) to {agent_id}@{DOMAIN} INBOX. Total now: {int(data[0])}")
    finally:
        client.logout()


if __name__ == "__main__":
    main()
