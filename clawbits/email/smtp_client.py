"""Stalwart SMTP client for sending emails from agent mailboxes.

Each agent has an email address ``{agent_id}@{EMAIL_DOMAIN}``. Outbound mail is
submitted via Stalwart using v0.16 **administrative impersonation**: we
authenticate on the submission port as ``{from_addr}%{service}`` with the
*service account's* password, which satisfies the ``mustMatchSender`` policy for
``MAIL FROM: {from_addr}``. Agent accounts have no password of their own.

Environment variables:
    STALWART_SMTP_HOST        - SMTP server hostname (compose: stalwart, dev: localhost)
    STALWART_SMTP_PORT        - submission port (default: 465 implicit TLS; 587 = STARTTLS)
    STALWART_SMTP_VERIFY_SSL  - "true" to verify the submission TLS cert (default: true)
    STALWART_SVC_USER         - service/impersonator account (default: admin)
    STALWART_SVC_PASSWORD     - service account password (required)
    STALWART_IMPERSONATE_SEP  - impersonation separator char (default: %)
    STALWART_SMTP_TIMEOUT_SECONDS - per-operation socket timeout, connect included (default: 20)
    STALWART_SMTP_ALLOW_INSECURE  - "true" lets AUTH go out in plaintext when a non-TLS relay
                                    offers no STARTTLS (local relays only; default: false)
"""
import base64
import logging
import mimetypes
import os
import smtplib
import ssl
from email import encoders
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formatdate

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

STALWART_SMTP_HOST = os.getenv("STALWART_SMTP_HOST", "localhost")
STALWART_SMTP_PORT = int(os.getenv("STALWART_SMTP_PORT", "465"))
STALWART_SMTP_VERIFY_SSL = os.getenv("STALWART_SMTP_VERIFY_SSL", "true").lower() == "true"
# Implicit TLS (SMTPS, port 465) vs STARTTLS (587). Decoupled from the port
# number so a host-mapped port (e.g. 10465 in dev) still uses the right mode.
STALWART_SMTP_IMPLICIT_TLS = os.getenv(
    "STALWART_SMTP_IMPLICIT_TLS", "true" if STALWART_SMTP_PORT != 587 else "false"
).lower() == "true"
STALWART_SVC_USER = os.getenv("STALWART_SVC_USER", "admin")
STALWART_SVC_PASSWORD = os.getenv("STALWART_SVC_PASSWORD", "")
STALWART_IMPERSONATE_SEP = os.getenv("STALWART_IMPERSONATE_SEP", "%")
STALWART_SMTP_TIMEOUT = float(os.getenv("STALWART_SMTP_TIMEOUT_SECONDS", "20"))
STALWART_SMTP_ALLOW_INSECURE = os.getenv("STALWART_SMTP_ALLOW_INSECURE", "false").lower() == "true"


class SmtpDeliveryError(smtplib.SMTPException):
    """Submission did not end in acceptance; ``outcome`` is retry_wait|failed|unknown, ``reason`` a short code."""

    def __init__(self, outcome: str, reason: str):
        super().__init__(f"{outcome}: {reason}")
        self.outcome = outcome
        self.reason = reason


def _classify(exc: BaseException, *, submitting: bool) -> SmtpDeliveryError:
    """Map an smtplib/socket failure to the outcome it implies for a retry.

    4xx -> retry_wait, 5xx or missing STARTTLS/AUTH -> failed. A failure without a reply code is
    ``unknown`` once submission began (the server may hold the message), else retry_wait.
    """
    code = getattr(exc, "smtp_code", None)
    if isinstance(exc, smtplib.SMTPRecipientsRefused):
        code = min((c for c, _ in exc.recipients.values()), default=None)
    if isinstance(exc, smtplib.SMTPNotSupportedError):
        return SmtpDeliveryError("failed", "tls_or_auth_unavailable")
    if isinstance(code, int) and 400 <= code < 500:
        return SmtpDeliveryError("retry_wait", f"smtp_{code}")
    if isinstance(code, int) and code >= 500:
        return SmtpDeliveryError("failed", f"smtp_{code}")
    if submitting:
        return SmtpDeliveryError("unknown", "submission_interrupted")
    return SmtpDeliveryError("retry_wait", "connect_failed")


def _open_session(login_user: str) -> smtplib.SMTP:
    """Connect under finite deadlines, require the configured TLS mode, then AUTH; close on failure."""
    ssl_context = ssl.create_default_context()
    if not STALWART_SMTP_VERIFY_SSL:
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE

    if STALWART_SMTP_IMPLICIT_TLS:
        smtp = smtplib.SMTP_SSL(
            STALWART_SMTP_HOST, STALWART_SMTP_PORT, context=ssl_context, timeout=STALWART_SMTP_TIMEOUT
        )
    else:
        smtp = smtplib.SMTP(STALWART_SMTP_HOST, STALWART_SMTP_PORT, timeout=STALWART_SMTP_TIMEOUT)
    try:
        smtp.ehlo()
        # starttls() raises SMTPNotSupportedError when the server does not offer it.
        if not STALWART_SMTP_IMPLICIT_TLS and (not STALWART_SMTP_ALLOW_INSECURE or smtp.has_extn("starttls")):
            smtp.starttls(context=ssl_context)
            smtp.ehlo()
        smtp.login(login_user, STALWART_SVC_PASSWORD)
    except BaseException:
        smtp.close()
        raise
    return smtp


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def send_email(
    from_addr: str,
    to_addr: str,
    subject: str,
    body_text: str,
    attachments: list[dict] | None = None,
    headers: dict[str, str] | None = None,
    *,
    message_id: str | None = None,
) -> None:
    """Send an email via Stalwart SMTP with optional attachments and custom headers.

    Args:
        from_addr: Sender email (e.g. ``YellowMess@clawbits.ai``).
        to_addr:   Recipient email (the agent's owner).
        subject:   Email subject line.
        body_text: Plain-text body.
        attachments: List of dicts with {"filename": str, "content_b64": str}.
        headers:   Custom email headers.
        message_id: Pins the Message-ID header; a Message-ID in ``headers`` is then ignored.

    Raises:
        SmtpDeliveryError: Unless the server accepted the message.
    """
    if attachments:
        msg = MIMEMultipart()
        msg.attach(MIMEText(body_text, "plain", "utf-8"))

        for att in attachments:
            filename = att["filename"]
            content_b64 = att["content_b64"]
            try:
                content = base64.b64decode(content_b64)
            except Exception as e:
                logger.error(f"Failed to decode attachment {filename}: {e}")
                continue

            ctype, encoding = mimetypes.guess_type(filename)
            if ctype is None or encoding is not None:
                ctype = "application/octet-stream"
            maintype, subtype = ctype.split("/", 1)

            part = MIMEBase(maintype, subtype)
            part.set_payload(content)
            encoders.encode_base64(part)
            part.add_header("Content-Disposition", "attachment", filename=filename)
            msg.attach(part)
    else:
        msg = MIMEText(body_text, "plain", "utf-8")

    msg["From"] = from_addr
    msg["To"] = to_addr
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)
    reserved = {"from", "to", "subject", "date"}
    if message_id is not None:
        msg["Message-ID"] = message_id
        reserved.add("message-id")

    if headers:
        for k, v in headers.items():
            # Skip core headers that we already set
            if k.lower() in reserved:
                continue
            msg[k] = v

    # Serialised before the session: an unrepresentable header is a deterministic local
    # failure, so it must never be classified as an interrupted submission.
    try:
        raw = msg.as_string()
    except Exception as exc:
        raise SmtpDeliveryError("failed", "message_build_failed") from exc

    logger.info(f"Sending email from {from_addr} to {to_addr}: {subject!r}")

    # Impersonation login: authenticate AS the sender via the service account.
    login_user = f"{from_addr}{STALWART_IMPERSONATE_SEP}{STALWART_SVC_USER}"
    try:
        smtp = _open_session(login_user)
    except (smtplib.SMTPException, OSError) as exc:
        logger.error(f"SMTP session setup failed: {exc!r}")
        raise _classify(exc, submitting=False) from exc
    try:
        smtp.sendmail(from_addr, [to_addr], raw)
    except Exception as exc:
        raise _classify(exc, submitting=True) from exc
    finally:
        # A failed QUIT after acceptance must not turn "accepted" into an error.
        try:
            smtp.quit()
        except Exception:
            smtp.close()

    logger.info(f"Email sent successfully from {from_addr} to {to_addr}")
