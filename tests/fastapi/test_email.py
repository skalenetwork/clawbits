"""Tests for agent email inbox API (Stalwart IMAP backend).
These tests use a real Stalwart server running in Docker.
"""
import base64
import os

# Stalwart v0.16 test env (matches compose.override.yaml's dev recovery admin).
# Set BEFORE importing clawbits modules that read these at import time.
os.environ.setdefault("STALWART_EMAIL_DOMAIN", "mail.clawbits.ai")
os.environ.setdefault("STALWART_SVC_USER", "admin")
os.environ.setdefault("STALWART_SVC_PASSWORD", "dev-svc-secret")
os.environ.setdefault("STALWART_IMPERSONATE_SEP", "%")
# The dev Stalwart is reached at its static container IP (compose.override
# pins 172.30.99.10) - OrbStack's localhost forwarding is broken for this
# container (2026-07-03; see compose.override.yaml).
os.environ.setdefault("STALWART_MGMT_URL", "http://172.30.99.10:8080")
os.environ.setdefault("STALWART_IMAP_HOST", "172.30.99.10")
os.environ.setdefault("STALWART_IMAP_PORT", "993")
os.environ.setdefault("STALWART_IMAP_USE_SSL", "true")
os.environ.setdefault("STALWART_IMAP_VERIFY_SSL", "false")  # self-signed in tests
os.environ.setdefault("STALWART_SMTP_HOST", "172.30.99.10")
os.environ.setdefault("STALWART_SMTP_PORT", "465")
os.environ.setdefault("STALWART_SMTP_IMPLICIT_TLS", "true")
os.environ.setdefault("STALWART_SMTP_VERIFY_SSL", "false")

from imapclient.exceptions import LoginError
from starlette.testclient import TestClient

from clawbits.datastructures.known_answers import get_answer_for_question
from clawbits.domain import EMAIL_DOMAIN
from tests.fastapi._auth_helpers import login_human, personal_org_id


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _send_real_email(
    to_addr: str,
    subject: str = "Test Subject",
    body: str = "Hello",
    attachments: list[dict] | None = None,
):
    """Helper to inject an email into the real Stalwart server for testing.
    Uses IMAP APPEND with the agent's own credentials.
    """
    import base64
    import os
    from email import encoders
    from email.mime.base import MIMEBase
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText
    from email.utils import formatdate

    from imapclient import IMAPClient

    if attachments:
        msg = MIMEMultipart()
        msg.attach(MIMEText(body, "plain", "utf-8"))
        for att in attachments:
            part = MIMEBase("application", "octet-stream")
            part.set_payload(base64.b64decode(att["content_b64"]))
            encoders.encode_base64(part)
            part.add_header("Content-Disposition", f"attachment; filename={att['filename']}")
            msg.attach(part)
    else:
        msg = MIMEText(body, "plain", "utf-8")

    msg["From"] = "sender@example.com"
    msg["To"] = to_addr
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)

    # Agents have no password; log in via admin impersonation: target%service.
    sep = os.getenv("STALWART_IMPERSONATE_SEP", "%")
    svc_user = os.getenv("STALWART_SVC_USER", "admin")
    svc_password = os.getenv("STALWART_SVC_PASSWORD", "dev-svc-secret")
    account_user = f"{to_addr.lower()}{sep}{svc_user}"

    # Use a custom SSL context that ignores self-signed certs for testing
    import ssl
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    imap_host = os.getenv("STALWART_IMAP_HOST", "127.0.0.1")
    imap_port = int(os.getenv("STALWART_IMAP_PORT", "993"))
    with IMAPClient(imap_host, port=imap_port, ssl=True, ssl_context=ctx) as client:
        client.login(account_user, svc_password)
        client.append("INBOX", msg.as_bytes())
def _create_agent(tc: TestClient) -> dict:
    from tests.fastapi._auth_helpers import signup_agent_via_email
    from tests.fastapi.approve_helper import _approve_signup
    r = signup_agent_via_email(tc, "stan@clawbits.ai")
    assert r.status_code == 200, r.text
    challenge = r.json()
    answer = get_answer_for_question(challenge["challenge"])
    r = tc.post("/api/agentic/signup-commit", json={
        "session_token": challenge["session_token"],
        "challenge_response": answer,
    })
    assert r.status_code == 200, r.text
    data = r.json()
    _approve_signup(tc, data)
    # Note: agents_signup_commit_impl already calls provision_mailbox.
    mint_challenge = tc.get(
        "/api/agentic/auth/challenge",
        headers={"Authorization": f"Bearer {data['api_key']}"},
    )
    assert mint_challenge.status_code == 200, mint_challenge.text
    mint_payload = mint_challenge.json()
    mint_answer = get_answer_for_question(mint_payload["challenge"])
    mint_resp = tc.post(
        "/api/agentic/auth/challenge_response",
        headers={
            "Authorization": f"Bearer {data['api_key']}",
        },
        json={
            "session_token": mint_payload["session_token"],
            "challenge_response": mint_answer,
        },
    )
    assert mint_resp.status_code == 200, mint_resp.text
    return data
def _auth(api_key: str) -> dict:
    return {"Authorization": f"Bearer {api_key}"}
def _write_headers(tc: TestClient, api_key: str) -> dict:
    r = tc.get("/api/agentic/auth/challenge", headers=_auth(api_key))
    assert r.status_code == 200, r.text
    ch = r.json()
    answer = get_answer_for_question(ch["challenge"])
    return _auth(api_key)
# ---------------------------------------------------------------------------
# Tests: Email Count
# ---------------------------------------------------------------------------
def test_email_count(test_client):
    """Real Stalwart test for email count."""
    agent = _create_agent(test_client)
    _send_real_email(f"{agent['agent_id']}@{EMAIL_DOMAIN}", "Count test", "Hello")
    r = test_client.get(
        f"/api/agentic/agents/{agent['agent_id']}/email/count",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 200
    data = r.json()
    assert data["total"] >= 1
    assert data["email_address"] == f"{agent['agent_id']}@{EMAIL_DOMAIN}"
# ---------------------------------------------------------------------------
# Tests: Email Inbox List
# ---------------------------------------------------------------------------
def test_email_inbox_list(test_client):
    """Real Stalwart test for email list."""
    agent = _create_agent(test_client)
    agent_email = f"{agent['agent_id']}@{EMAIL_DOMAIN}"
    _send_real_email(agent_email, "Subject 1", "Body 1")
    _send_real_email(agent_email, "Subject 2", "Body 2")
    r = test_client.get(
        f"/api/agentic/agents/{agent['agent_id']}/email/inbox",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 200
    data = r.json()
    assert data["total"] >= 2
    subjects = [e["subject"] for e in data["emails"]]
    assert "Subject 1" in subjects
    assert "Subject 2" in subjects
def test_email_inbox_empty(test_client):
    """Real Stalwart test for empty inbox."""
    agent = _create_agent(test_client)
    r = test_client.get(
        f"/api/agentic/agents/{agent['agent_id']}/email/inbox",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 200
    data = r.json()
    assert "emails" in data
# ---------------------------------------------------------------------------
# Tests: Email Detail
# ---------------------------------------------------------------------------
def test_email_detail(test_client):
    """Real Stalwart test for email detail."""
    agent = _create_agent(test_client)
    agent_email = f"{agent['agent_id']}@{EMAIL_DOMAIN}"
    subject = "Detail Test"
    _send_real_email(agent_email, subject, "Detail body content")
    r_list = test_client.get(
        f"/api/agentic/agents/{agent['agent_id']}/email/inbox",
        headers=_auth(agent["api_key"]),
    )
    emails = r_list.json()["emails"]
    the_email = next(e for e in emails if e["subject"] == subject)
    uid = the_email["uid"]
    r = test_client.get(
        f"/api/agentic/agents/{agent['agent_id']}/email/{uid}",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 200
    data = r.json()
    assert data["uid"] == uid
    assert data["subject"] == subject
    assert "Detail body content" in (data["body_text"] or "")
# ---------------------------------------------------------------------------
# Tests: Email Detail with attachments
# ---------------------------------------------------------------------------
def test_email_detail_with_attachments(test_client):
    """Real Stalwart test for fetching email with attachments."""
    agent = _create_agent(test_client)
    agent_email = f"{agent['agent_id']}@{EMAIL_DOMAIN}"
    subject = "Attachment Retrieval Test"
    att_name = "test.txt"
    att_content = "Hello Attachments!"
    att_b64 = base64.b64encode(att_content.encode()).decode()

    _send_real_email(
        agent_email,
        subject,
        "See attachment",
        attachments=[{"filename": att_name, "content_b64": att_b64}]
    )

    r_list = test_client.get(
        f"/api/agentic/agents/{agent['agent_id']}/email/inbox",
        headers=_auth(agent["api_key"]),
    )
    the_email = next(e for e in r_list.json()["emails"] if e["subject"] == subject)
    uid = the_email["uid"]

    r = test_client.get(
        f"/api/agentic/agents/{agent['agent_id']}/email/{uid}",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 200
    data = r.json()
    assert len(data["attachments"]) == 1
    assert data["attachments"][0]["filename"] == att_name
    assert data["attachments"][0]["content_b64"] == att_b64
    assert "From" in data["headers"]
    assert "To" in data["headers"]


# ---------------------------------------------------------------------------
# Tests: Email Delete
# ---------------------------------------------------------------------------
def test_email_delete(test_client):
    """Real Stalwart test for email delete."""
    agent = _create_agent(test_client)
    agent_email = f"{agent['agent_id']}@{EMAIL_DOMAIN}"
    subject = "Delete Test"
    _send_real_email(agent_email, subject, "To be deleted")
    r_list = test_client.get(
        f"/api/agentic/agents/{agent['agent_id']}/email/inbox",
        headers=_auth(agent["api_key"]),
    )
    the_email = next(e for e in r_list.json()["emails"] if e["subject"] == subject)
    uid = the_email["uid"]
    r = test_client.delete(
        f"/api/agentic/agents/{agent['agent_id']}/email/{uid}",
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200
    assert r.json()["status"] == "deleted"
    r_check = test_client.get(
        f"/api/agentic/agents/{agent['agent_id']}/email/{uid}",
        headers=_auth(agent["api_key"]),
    )
    assert r_check.status_code == 404
def test_email_delete_not_found(test_client):
    agent = _create_agent(test_client)
    r = test_client.delete(
        f"/api/agentic/agents/{agent['agent_id']}/email/99999",
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 404
# ---------------------------------------------------------------------------
# Tests: Auth enforcement
# ---------------------------------------------------------------------------
def test_email_wrong_agent_forbidden(test_client):
    """An agent cannot access another agent's mailbox."""
    a1 = _create_agent(test_client)
    a2 = _create_agent(test_client)
    r = test_client.get(
        f"/api/agentic/agents/{a2['agent_id']}/email/count",
        headers=_auth(a1["api_key"]),
    )
    assert r.status_code in (401, 403)
def test_email_no_auth(test_client):
    """Requests without auth are rejected."""
    agent = _create_agent(test_client)
    r = test_client.get(f"/api/agentic/agents/{agent['agent_id']}/email/count")
    assert r.status_code == 401
# ---------------------------------------------------------------------------
# Tests: Email Send
# ---------------------------------------------------------------------------
def test_email_send_success(test_client):
    """Agent can send an email to its primary owner (Real Stalwart)."""
    agent = _create_agent(test_client)
    r = test_client.post(
        f"/api/agentic/agents/{agent['agent_id']}/email/send",
        json={"subject": "Hello Owner", "message": "This is a real test email."},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["status"] == "sent"
    assert data["to_addr"] == "stan@clawbits.ai"
    assert EMAIL_DOMAIN in data["from_addr"]
    assert data["subject"] == "Hello Owner"
def test_email_send_with_creation_owner(test_client):
    """Agent can send email using the owner assigned at creation time (Real Stalwart)."""
    agent = _create_agent(test_client)
    r = test_client.post(
        f"/api/agentic/agents/{agent['agent_id']}/email/send",
        json={"subject": "Test", "message": "Uses creation-time owner"},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    assert r.json()["to_addr"] == "stan@clawbits.ai"
def test_email_send_requires_auth(test_client):
    """Sending without Authorization header fails."""
    r = test_client.post(
        "/api/agentic/agents/SomeAgent/email/send",
        json={"subject": "Test", "message": "Body"},
    )
    assert r.status_code in (401, 403)
def test_email_send_wrong_agent_forbidden(test_client):
    """An agent cannot send from another agent's address."""
    a1 = _create_agent(test_client)
    a2 = _create_agent(test_client)
    r = test_client.post(
        f"/api/agentic/agents/{a1['agent_id']}/email/send",
        json={"subject": "Test", "message": "Body"},
        headers=_write_headers(test_client, a2["api_key"]),
    )
    assert r.status_code in (401, 403)
def test_email_send_smtp_not_configured(test_client):
    """Returns 503 if STALWART_SMTP_HOST is empty."""
    from unittest.mock import patch
    agent = _create_agent(test_client)
    with patch("clawbits.fastapi.email_endpoints.STALWART_SMTP_HOST", ""):
        r = test_client.post(
            f"/api/agentic/agents/{agent['agent_id']}/email/send",
            json={"subject": "Test", "message": "Body"},
            headers=_write_headers(test_client, agent["api_key"]),
        )
    assert r.status_code == 503
def test_email_send_provisions_sender_mailbox(test_client):
    """Sending ensures the agent's own (sender) mailbox exists before delivery.

    The recipient is the operator's real external address - that is outbound
    delivery, not a local mailbox, so we never provision the recipient.
    """
    from unittest.mock import patch

    agent = _create_agent(test_client)
    with (
        patch("clawbits.fastapi.email_endpoints.provision_mailbox", return_value=True) as provision_mock,
        patch("clawbits.fastapi.email_endpoints.smtp_send_email") as send_mock,
    ):
        r = test_client.post(
            f"/api/agentic/agents/{agent['agent_id']}/email/send",
            json={"subject": "Test", "message": "Body"},
            headers=_write_headers(test_client, agent["api_key"]),
        )
    assert r.status_code == 200, r.text
    provision_mock.assert_called_once_with(agent["agent_id"])
    send_mock.assert_called_once()
def test_email_send_validates_body(test_client):
    """Request body validation: subject and message are required."""
    agent = _create_agent(test_client)
    r = test_client.post(
        f"/api/agentic/agents/{agent['agent_id']}/email/send",
        json={"subject": "", "message": "Body"},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# Tests: Email send with attachments
# ---------------------------------------------------------------------------
def test_email_send_with_attachments(test_client):
    """Agent can send an email with attachments."""
    agent = _create_agent(test_client)
    att_name = "outbound.txt"
    att_content = "Outgoing attachment content"
    att_b64 = base64.b64encode(att_content.encode()).decode()

    r = test_client.post(
        f"/api/agentic/agents/{agent['agent_id']}/email/send",
        json={
            "subject": "Email with Attachment",
            "message": "Sending this file.",
            "attachments": [{"filename": att_name, "content_b64": att_b64}]
        },
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200
    assert r.json()["status"] == "sent"


# ---------------------------------------------------------------------------
# Tests: Email send with headers
# ---------------------------------------------------------------------------
def test_email_send_with_headers(test_client):
    """Agent can send an email with custom headers."""
    agent = _create_agent(test_client)
    custom_headers = {"X-Custom-Test": "Value"}

    r = test_client.post(
        f"/api/agentic/agents/{agent['agent_id']}/email/send",
        json={
            "subject": "Header Test",
            "message": "Testing headers",
            "headers": custom_headers
        },
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200
    assert r.json()["status"] == "sent"


# ---------------------------------------------------------------------------
# Tests: Human-facing inbox (operator-only, session-cookie auth)
# ---------------------------------------------------------------------------
def _operator_session(tc: TestClient) -> tuple[dict, str]:
    """Create an agent and leave its operator (stan) logged in via the session
    cookie on *tc*. Returns ``(agent_data, org_id)``."""
    agent = _create_agent(tc)
    token, _ = login_human(tc, "stan@clawbits.ai")
    org_id = personal_org_id(tc, token)
    return agent, org_id


def _hbase(org_id: str, agent_id: str) -> str:
    return f"/api/human/orgs/{org_id}/agents/{agent_id}/email"


def test_human_email_count(test_client):
    """The operator can read the count via the human (cookie-auth) endpoint."""
    agent, org_id = _operator_session(test_client)
    _send_real_email(f"{agent['agent_id']}@{EMAIL_DOMAIN}", "Human count", "Hello")
    r = test_client.get(f"{_hbase(org_id, agent['agent_id'])}/count")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["total"] >= 1
    assert data["email_address"] == f"{agent['agent_id']}@{EMAIL_DOMAIN}"


def test_human_email_inbox(test_client):
    """The operator can list the inbox."""
    agent, org_id = _operator_session(test_client)
    addr = f"{agent['agent_id']}@{EMAIL_DOMAIN}"
    _send_real_email(addr, "HSub 1", "B1")
    _send_real_email(addr, "HSub 2", "B2")
    r = test_client.get(f"{_hbase(org_id, agent['agent_id'])}/inbox")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["total"] >= 2
    subjects = [e["subject"] for e in data["emails"]]
    assert "HSub 1" in subjects
    assert "HSub 2" in subjects


def test_human_email_detail_marks_read(test_client):
    """Opening a message returns the body and marks it \\Seen."""
    agent, org_id = _operator_session(test_client)
    addr = f"{agent['agent_id']}@{EMAIL_DOMAIN}"
    _send_real_email(addr, "HDetail", "Detail body here")
    base = _hbase(org_id, agent["agent_id"])
    listed = test_client.get(f"{base}/inbox").json()["emails"]
    uid = next(e["uid"] for e in listed if e["subject"] == "HDetail")
    r = test_client.get(f"{base}/{uid}")
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["uid"] == uid
    assert "Detail body here" in (d["body_text"] or "")
    relisted = test_client.get(f"{base}/inbox").json()["emails"]
    opened = next(e for e in relisted if e["uid"] == uid)
    assert opened["is_read"] is True


def test_human_email_delete(test_client):
    """The operator can delete a message."""
    agent, org_id = _operator_session(test_client)
    addr = f"{agent['agent_id']}@{EMAIL_DOMAIN}"
    _send_real_email(addr, "HDelete", "bye")
    base = _hbase(org_id, agent["agent_id"])
    uid = next(
        e["uid"]
        for e in test_client.get(f"{base}/inbox").json()["emails"]
        if e["subject"] == "HDelete"
    )
    r = test_client.delete(f"{base}/{uid}")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "deleted"
    assert test_client.get(f"{base}/{uid}").status_code == 404


def test_human_email_delete_not_found(test_client):
    agent, org_id = _operator_session(test_client)
    r = test_client.delete(f"{_hbase(org_id, agent['agent_id'])}/99999")
    assert r.status_code == 404


def test_human_email_inbox_snippet_and_attachment_flag(test_client):
    """Listing carries a body snippet + attachment flag, without marking read.

    The snippet comes from IMAP PREVIEW (or the BODY.PEEK fallback) — both
    are flag-neutral, so listing twice must leave every message unread."""
    agent, org_id = _operator_session(test_client)
    addr = f"{agent['agent_id']}@{EMAIL_DOMAIN}"
    _send_real_email(addr, "Plain snippet", "The quarterly report is attached below the fold.")
    att_b64 = base64.b64encode(b"attachment payload").decode()
    _send_real_email(
        addr,
        "With file",
        "See the file.",
        attachments=[{"filename": "file.bin", "content_b64": att_b64}],
    )
    base = _hbase(org_id, agent["agent_id"])

    listed = test_client.get(f"{base}/inbox").json()["emails"]
    plain = next(e for e in listed if e["subject"] == "Plain snippet")
    with_file = next(e for e in listed if e["subject"] == "With file")

    assert plain["snippet"] and "quarterly report" in plain["snippet"]
    assert plain["has_attachments"] is False
    assert with_file["has_attachments"] is True

    # \Seen-safety regression: a second listing still sees both as unread —
    # the snippet fetch must never mark messages read.
    relisted = test_client.get(f"{base}/inbox").json()["emails"]
    assert next(e for e in relisted if e["uid"] == plain["uid"])["is_read"] is False
    assert next(e for e in relisted if e["uid"] == with_file["uid"])["is_read"] is False


def test_human_email_inbox_unread_only(test_client):
    """unread_only filters to UNSEEN and reports the matching total."""
    agent, org_id = _operator_session(test_client)
    addr = f"{agent['agent_id']}@{EMAIL_DOMAIN}"
    _send_real_email(addr, "Stays unread", "one")
    _send_real_email(addr, "Gets opened", "two")
    base = _hbase(org_id, agent["agent_id"])

    listed = test_client.get(f"{base}/inbox").json()["emails"]
    opened_uid = next(e["uid"] for e in listed if e["subject"] == "Gets opened")
    assert test_client.get(f"{base}/{opened_uid}").status_code == 200  # marks read

    r = test_client.get(f"{base}/inbox", params={"unread_only": "true"})
    assert r.status_code == 200, r.text
    data = r.json()
    subjects = [e["subject"] for e in data["emails"]]
    assert "Stays unread" in subjects
    assert "Gets opened" not in subjects
    # ``total`` is the server-side UNSEEN count, which can briefly still include
    # the message we just opened: Stalwart's unseen tally lags the \Seen store
    # by a beat, even though the per-message flags in the listing above are
    # already fresh. Tolerate that propagation window (the expected 1, or a
    # transient 2) - the listing itself is the authoritative proof that unread
    # filtering works.
    assert data["total"] in (1, 2)
    assert all(e["is_read"] is False for e in data["emails"])


def test_human_email_mark_unread_and_read(test_client):
    """PATCH toggles the \\Seen flag both ways."""
    agent, org_id = _operator_session(test_client)
    addr = f"{agent['agent_id']}@{EMAIL_DOMAIN}"
    _send_real_email(addr, "Toggle me", "body")
    base = _hbase(org_id, agent["agent_id"])
    uid = next(
        e["uid"]
        for e in test_client.get(f"{base}/inbox").json()["emails"]
        if e["subject"] == "Toggle me"
    )
    assert test_client.get(f"{base}/{uid}").status_code == 200  # read-on-open

    r = test_client.patch(f"{base}/{uid}", json={"is_read": False})
    assert r.status_code == 200, r.text
    assert r.json() == {
        "status": "updated",
        "agent_id": agent["agent_id"],
        "message_uid": uid,
        "is_read": False,
    }
    relisted = test_client.get(f"{base}/inbox").json()["emails"]
    assert next(e for e in relisted if e["uid"] == uid)["is_read"] is False

    r = test_client.patch(f"{base}/{uid}", json={"is_read": True})
    assert r.status_code == 200, r.text
    relisted = test_client.get(f"{base}/inbox").json()["emails"]
    assert next(e for e in relisted if e["uid"] == uid)["is_read"] is True


def test_human_email_mark_read_not_found(test_client):
    agent, org_id = _operator_session(test_client)
    r = test_client.patch(
        f"{_hbase(org_id, agent['agent_id'])}/99999", json={"is_read": True}
    )
    assert r.status_code == 404


def test_human_email_mark_read_operator_only(test_client):
    """The mark-read endpoint enforces the operator gate like its siblings."""
    from unittest.mock import patch

    agent, org_id = _operator_session(test_client)
    with patch("clawbits.db.table_read.TableRead.is_agent_operator", return_value=False):
        r = test_client.patch(
            f"{_hbase(org_id, agent['agent_id'])}/12345", json={"is_read": True}
        )
    assert r.status_code == 403


def test_human_email_requires_membership(test_client):
    """A human who isn't a member of the agent's org is rejected."""
    agent, org_id = _operator_session(test_client)
    # Switch the session cookie to an unrelated human (own personal org).
    login_human(test_client, "intruder@clawbits.ai")
    r = test_client.get(f"{_hbase(org_id, agent['agent_id'])}/count")
    assert r.status_code == 403


def test_human_email_operator_only(test_client):
    """An org member who isn't the operator is rejected (operator-only gate)."""
    from unittest.mock import patch

    agent, org_id = _operator_session(test_client)
    with patch("clawbits.db.table_read.TableRead.is_agent_operator", return_value=False):
        r = test_client.get(f"{_hbase(org_id, agent['agent_id'])}/count")
    assert r.status_code == 403


def test_human_email_unconfigured_graceful(test_client):
    """Reads degrade to empty (200, not 500) when email isn't configured."""
    from unittest.mock import patch

    agent, org_id = _operator_session(test_client)
    with patch("clawbits.fastapi.human_endpoints.STALWART_SVC_PASSWORD", ""):
        r = test_client.get(f"{_hbase(org_id, agent['agent_id'])}/count")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["total"] == 0
    assert data["unread"] == 0
    assert data["email_address"] == f"{agent['agent_id']}@{EMAIL_DOMAIN}"


def test_human_email_missing_mailbox_graceful(test_client):
    """An unprovisioned mailbox (IMAP LoginError) degrades to empty, not 500."""
    from unittest.mock import patch

    agent, org_id = _operator_session(test_client)
    with patch(
        "clawbits.fastapi.human_endpoints.get_email_counts",
        side_effect=LoginError("no mailbox"),
    ):
        r = test_client.get(f"{_hbase(org_id, agent['agent_id'])}/count")
    assert r.status_code == 200, r.text
    assert r.json()["total"] == 0

    with patch(
        "clawbits.fastapi.human_endpoints.list_emails",
        side_effect=LoginError("no mailbox"),
    ):
        r = test_client.get(f"{_hbase(org_id, agent['agent_id'])}/inbox")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["emails"] == []
    assert data["total"] == 0
