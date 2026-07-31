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
"""
import base64
import logging
import mimetypes
import os
import smtplib
import ssl
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
) -> None:
    """Send an email via Stalwart SMTP with optional attachments and custom headers.

    Args:
        from_addr: Sender email (e.g. ``YellowMess@clawbits.ai``).
        to_addr:   Recipient email (the agent's owner).
        subject:   Email subject line.
        body_text: Plain-text body.
        attachments: List of dicts with {"filename": str, "content_b64": str}.
        headers:   Custom email headers.

    Raises:
        smtplib.SMTPException: On any SMTP error.
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
            from email import encoders
            encoders.encode_base64(part)
            part.add_header("Content-Disposition", "attachment", filename=filename)
            msg.attach(part)
    else:
        msg = MIMEText(body_text, "plain", "utf-8")

    msg["From"] = from_addr
    msg["To"] = to_addr
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)

    if headers:
        for k, v in headers.items():
            # Skip core headers that we already set
            if k.lower() in ("from", "to", "subject", "date"):
                continue
            msg[k] = v

    logger.info(f"Sending email from {from_addr} to {to_addr}: {subject!r}")

    # Impersonation login: authenticate AS the sender via the service account.
    login_user = f"{from_addr}{STALWART_IMPERSONATE_SEP}{STALWART_SVC_USER}"

    if STALWART_SMTP_VERIFY_SSL:
        ssl_context = ssl.create_default_context()
    else:
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE

    if STALWART_SMTP_IMPLICIT_TLS:
        smtp_cm = smtplib.SMTP_SSL(STALWART_SMTP_HOST, STALWART_SMTP_PORT, context=ssl_context)
    else:
        smtp_cm = smtplib.SMTP(STALWART_SMTP_HOST, STALWART_SMTP_PORT)

    with smtp_cm as smtp:
        smtp.ehlo()
        if not STALWART_SMTP_IMPLICIT_TLS and smtp.has_extn("starttls"):
            smtp.starttls(context=ssl_context)
            smtp.ehlo()

        try:
            smtp.login(login_user, STALWART_SVC_PASSWORD)
            logger.debug(f"SMTP authenticated as {login_user}")
        except smtplib.SMTPException as e:
            logger.error(f"SMTP auth failed: {e}")
            raise

        smtp.sendmail(from_addr, [to_addr], msg.as_string())

    logger.info(f"Email sent successfully from {from_addr} to {to_addr}")
