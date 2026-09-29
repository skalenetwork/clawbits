"""SMTP transport: deadlines, required TLS, outcome classification and Message-ID pinning."""
import socket
import threading
import time
from email import message_from_bytes

import pytest

from clawbits.email import smtp_client
from clawbits.email.smtp_client import SmtpDeliveryError, send_email


class FakeSmtp:
    """One-connection scripted SMTP server; ``replies`` maps a verb (or ``<body>``) to a reply or ``drop``."""

    def __init__(self, *, ehlo=("250-fake", "250 AUTH PLAIN"), replies=None, greet=True):
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(1)
        self.port = self.sock.getsockname()[1]
        self.ehlo, self.replies, self.greet = ehlo, replies or {}, greet
        self.seen: list[str] = []
        self.body = b""
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        conn, _ = self.sock.accept()
        with conn, conn.makefile("rb") as f:
            if not self.greet:
                time.sleep(3)
                return

            def send(line):
                conn.sendall(line.encode() + b"\r\n")

            send("220 fake ESMTP")
            while line := f.readline():
                verb = line.decode().split(" ")[0].strip().upper()
                self.seen.append(verb)
                reply = self.replies.get(verb)
                if reply == "drop":
                    return
                if verb == "EHLO":
                    for e in self.ehlo:
                        send(e)
                elif verb == "DATA":
                    send(reply or "354 go")
                    if reply:
                        continue
                    while (chunk := f.readline()) not in (b".\r\n", b""):
                        self.body += chunk
                    self.seen.append("<body>")
                    final = self.replies.get("<body>", "250 ok")
                    if final == "drop":
                        return
                    send(final)
                elif verb == "QUIT":
                    send(reply or "221 bye")
                    return
                else:
                    send(reply or ("235 ok" if verb == "AUTH" else "250 ok"))


@pytest.fixture(autouse=True)
def plaintext(monkeypatch):
    monkeypatch.setattr(smtp_client, "STALWART_SMTP_HOST", "127.0.0.1")
    monkeypatch.setattr(smtp_client, "STALWART_SMTP_IMPLICIT_TLS", False)
    monkeypatch.setattr(smtp_client, "STALWART_SMTP_ALLOW_INSECURE", True)
    monkeypatch.setattr(smtp_client, "STALWART_SMTP_TIMEOUT", 0.5)
    monkeypatch.setattr(smtp_client, "STALWART_SVC_PASSWORD", "pw")


def send(port, monkeypatch, **kwargs):
    monkeypatch.setattr(smtp_client, "STALWART_SMTP_PORT", port)
    send_email("agent@mail.test", "owner@example.com", "s", "body", **kwargs)


def outcome(server, monkeypatch):
    with pytest.raises(SmtpDeliveryError) as exc:
        send(server.port, monkeypatch)
    return exc.value.outcome, exc.value.reason


def test_accepted_when_quit_fails(monkeypatch):
    server = FakeSmtp(replies={"QUIT": "500 nope"})
    send(server.port, monkeypatch)
    assert "<body>" in server.seen


def test_unknown_when_connection_drops_after_data(monkeypatch):
    assert outcome(FakeSmtp(replies={"<body>": "drop"}), monkeypatch) == ("unknown", "submission_interrupted")


def test_unknown_when_connection_drops_mid_submission(monkeypatch):
    assert outcome(FakeSmtp(replies={"DATA": "drop"}), monkeypatch) == ("unknown", "submission_interrupted")


def test_retry_wait_on_4xx(monkeypatch):
    assert outcome(FakeSmtp(replies={"<body>": "451 try later"}), monkeypatch) == ("retry_wait", "smtp_451")
    assert outcome(FakeSmtp(replies={"MAIL": "421 busy"}), monkeypatch) == ("retry_wait", "smtp_421")


def test_failed_on_5xx(monkeypatch):
    assert outcome(FakeSmtp(replies={"RCPT": "550 no such user"}), monkeypatch) == ("failed", "smtp_550")
    assert outcome(FakeSmtp(replies={"AUTH": "535 bad creds"}), monkeypatch) == ("failed", "smtp_535")


def test_retry_wait_on_silent_server_within_deadline(monkeypatch):
    started = time.monotonic()
    assert outcome(FakeSmtp(greet=False), monkeypatch) == ("retry_wait", "connect_failed")
    assert time.monotonic() - started < 3

    closed = socket.socket()
    closed.bind(("127.0.0.1", 0))
    port = closed.getsockname()[1]
    closed.close()
    with pytest.raises(SmtpDeliveryError) as exc:
        send(port, monkeypatch)
    assert (exc.value.outcome, exc.value.reason) == ("retry_wait", "connect_failed")


def test_missing_starttls_fails_closed_before_auth(monkeypatch):
    monkeypatch.setattr(smtp_client, "STALWART_SMTP_ALLOW_INSECURE", False)
    server = FakeSmtp()
    assert outcome(server, monkeypatch) == ("failed", "tls_or_auth_unavailable")
    assert "AUTH" not in server.seen and "MAIL" not in server.seen


def test_insecure_opt_in_allows_plaintext_relay(monkeypatch):
    server = FakeSmtp()
    send(server.port, monkeypatch)
    assert server.seen[:3] == ["EHLO", "AUTH", "MAIL"]


def test_unrepresentable_header_fails_before_any_session(monkeypatch):
    server = FakeSmtp()
    with pytest.raises(SmtpDeliveryError) as exc:
        send(server.port, monkeypatch, headers={"X-Tag": "ok\r\nBcc: sneak@evil.example"})
    assert (exc.value.outcome, exc.value.reason) == ("failed", "message_build_failed")
    assert server.seen == []


def test_message_id_header_pinned_once(monkeypatch):
    server = FakeSmtp()
    send(server.port, monkeypatch, headers={"Message-ID": "<evil@d>", "X-Tag": "t"}, message_id="<x@d>")
    sent = message_from_bytes(server.body)
    assert sent.get_all("Message-ID") == ["<x@d>"] and sent["X-Tag"] == "t"

    legacy = FakeSmtp()
    send(legacy.port, monkeypatch, headers={"Message-ID": "<own@d>"})
    assert message_from_bytes(legacy.body).get_all("Message-ID") == ["<own@d>"]
