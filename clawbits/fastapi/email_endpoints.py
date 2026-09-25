"""Email inbox API endpoints for agents.

Each agent has an email address ``{agent_id}@clawbits.ai`` backed by a
Stalwart IMAP server.  These endpoints let agents read and manage their
inbox through the Clawbits REST API.
"""
import hashlib
import json
import logging
import re
from datetime import timedelta
from email.utils import make_msgid

from fastapi import HTTPException, Security
from fastapi.security import APIKeyHeader
from sqlmodel import Session

from clawbits.datastructures.email_models import (
    EmailChangesResponse,
    EmailCountResponse,
    EmailDetailResponse,
    EmailListResponse,
    EmailSendRequest,
    EmailSendResponse,
    EmailSummaryResponse,
)
from clawbits.db.models import EmailDelivery
from clawbits.db.table_read import TableRead
from clawbits.db.table_write import TableWrite
from clawbits.domain import EMAIL_DOMAIN
from clawbits.email.imap_client import (
    STALWART_SVC_PASSWORD,
    MailboxEpochChanged,
    agent_email_address,
    delete_email,
    get_email,
    get_email_counts,
    list_changes,
    list_emails,
)
from clawbits.email.smtp_client import STALWART_SMTP_HOST, SmtpDeliveryError
from clawbits.email.smtp_client import send_email as smtp_send_email
from clawbits.email.stalwart_provision import provision_mailbox
from clawbits.fastapi.agent_auth import extract_agent, require_own_agent
from clawbits.gas.cost_decorator import cost

api_key_header = APIKeyHeader(name="Authorization", auto_error=False)

logger = logging.getLogger(__name__)

IDEMPOTENCY_KEY_RE = re.compile(r"[A-Za-z0-9_.:~+=-]{1,128}")
DELIVERY_LEASE = timedelta(minutes=10)
DELIVERY_MAX_ATTEMPTS = 5
CHANGES_MAX_LIMIT = 200


def _epoch_conflict(exc: MailboxEpochChanged) -> HTTPException:
    """409 carrying the stable code and the mailbox's current epoch."""
    return HTTPException(
        status_code=409, detail={"code": "mailbox_epoch_changed", "uidvalidity": exc.uidvalidity}
    )


def _payload_hash(body: EmailSendRequest) -> str:
    """SHA-256 of the canonical request JSON, defaults included."""
    canonical = json.dumps(body.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def _retry_in(attempt: int) -> timedelta:
    """Backoff before a retry_wait delivery may be claimed again."""
    return timedelta(seconds=30 * 2 ** (attempt - 1))


def _delivery_response(row: EmailDelivery) -> EmailSendResponse:
    """Outbox record in the send-response shape; status is 'sent' only once SMTP accepted."""
    return EmailSendResponse(
        status="sent" if row.state == "accepted" else row.state,
        from_addr=row.from_addr,
        to_addr=row.to_addr,
        subject=row.subject,
        delivery_id=row.id,
        idempotency_key=row.idempotency_key,
        state=row.state,
        message_id=row.message_id,
        attempts=row.attempts,
        error=row.last_error,
        next_attempt_at=row.next_attempt_at,
    )


def _submit(agent_id: str, to_addr: str, body: EmailSendRequest, message_id: str | None = None) -> None:
    """Ensure the sender mailbox exists, then submit the request over SMTP."""
    # Only the sender is provisioned: the recipient is the operator's external address.
    provision_mailbox(agent_id)
    attachments = [a.model_dump() for a in body.attachments] if body.attachments else None
    smtp_send_email(
        agent_email_address(agent_id),
        to_addr,
        body.subject,
        body.message,
        attachments=attachments,
        headers=body.headers,
        message_id=message_id,
    )


class EmailEndpoints:
    """Agent email inbox endpoint implementations.

    Each static method receives the ``ClawBitsServer`` instance as its
    first argument (same pattern as the agent messaging endpoints on
    ``ClawBitsServer``).
    """

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _extract_agent(server, api_key: str):
        """Parse bearer token and return the Agent, or raise 401."""
        return extract_agent(server._engine, api_key)

    @staticmethod
    def _require_mailbox_owner(agent, agent_id: str):
        """Verify the authenticated agent owns the requested mailbox."""
        require_own_agent(agent, agent_id)

    @staticmethod
    def _check_stalwart_configured():
        """Raise 503 if Stalwart credentials are not configured."""
        if not STALWART_SVC_PASSWORD:
            raise HTTPException(
                status_code=503,
                detail="Email service not configured (STALWART_SVC_PASSWORD not set)",
            )

    @staticmethod
    def _check_smtp_configured():
        """Raise 503 if Stalwart SMTP is not configured."""
        if not STALWART_SMTP_HOST:
            raise HTTPException(
                status_code=503,
                detail="Email send service not configured (STALWART_SMTP_HOST not set)",
            )

    # ------------------------------------------------------------------
    # GET /api/agentic/agents/{agent_id}/email/count
    # ------------------------------------------------------------------

    @staticmethod
    @cost(1)
    def email_count(
        server,
        agent_id: str,
        api_key: str = Security(api_key_header),
    ) -> EmailCountResponse:
        """Get the total and unread email count for the agent's mailbox."""
        try:
            agent = EmailEndpoints._extract_agent(server, api_key)
            EmailEndpoints._require_mailbox_owner(agent, agent_id)
            EmailEndpoints._check_stalwart_configured()

            counts = get_email_counts(agent_id)
            if counts["total"]:
                with Session(server._engine) as db:
                    TableWrite.award_mark(db, agent_id, "mail")
                    db.commit()
            return EmailCountResponse(**counts)
        except HTTPException:
            raise
        except Exception as e:
            logger.exception(f"Error fetching email count: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    # ------------------------------------------------------------------
    # GET /api/agentic/agents/{agent_id}/email/inbox
    # ------------------------------------------------------------------

    @staticmethod
    @cost(1)
    def email_inbox(
        server,
        agent_id: str,
        api_key: str = Security(api_key_header),
        limit: int = 50,
        offset: int = 0,
        unread_only: bool = False,
    ) -> EmailListResponse:
        """List emails in the agent's inbox, newest first.

        With ``unread_only`` the listing (and ``total``) covers unseen
        messages only."""
        try:
            agent = EmailEndpoints._extract_agent(server, api_key)
            EmailEndpoints._require_mailbox_owner(agent, agent_id)
            EmailEndpoints._check_stalwart_configured()

            result = list_emails(agent_id, limit=limit, offset=offset, unread_only=unread_only)
            return EmailListResponse(
                emails=[EmailSummaryResponse(**e) for e in result["emails"]],
                total=result["total"],
                unread_count=result["unread_count"],
                limit=result["limit"],
                offset=result["offset"],
            )
        except HTTPException:
            raise
        except Exception as e:
            logger.exception(f"Error listing emails: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    # ------------------------------------------------------------------
    # GET /api/agentic/agents/{agent_id}/email/changes
    # ------------------------------------------------------------------

    @staticmethod
    @cost(1)
    def email_changes(
        server,
        agent_id: str,
        api_key: str = Security(api_key_header),
        after_uid: int = 0,
        uidvalidity: int | None = None,
        through_uid: int | None = None,
        limit: int = 50,
    ) -> EmailChangesResponse:
        """Ascending, epoch-bound enumeration for durable ingestion; never marks mail read."""
        try:
            agent = EmailEndpoints._extract_agent(server, api_key)
            EmailEndpoints._require_mailbox_owner(agent, agent_id)
            EmailEndpoints._check_stalwart_configured()

            result = list_changes(
                agent_id,
                after_uid,
                uidvalidity=uidvalidity,
                through_uid=through_uid,
                limit=min(max(limit, 1), CHANGES_MAX_LIMIT),
            )
            return EmailChangesResponse(**result)
        except MailboxEpochChanged as exc:
            raise _epoch_conflict(exc) from exc
        except HTTPException:
            raise
        except Exception as e:
            logger.exception(f"Error listing email changes: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    # ------------------------------------------------------------------
    # GET /api/agentic/agents/{agent_id}/email/{message_uid}
    # ------------------------------------------------------------------

    @staticmethod
    @cost(1)
    def email_detail(
        server,
        agent_id: str,
        message_uid: int,
        api_key: str = Security(api_key_header),
        uidvalidity: int | None = None,
        mark_read: bool = True,
        attachment_content: bool = True,
    ) -> EmailDetailResponse:
        """Fetch a single email by UID with full body; marks it read unless ``mark_read`` is false."""
        try:
            agent = EmailEndpoints._extract_agent(server, api_key)
            EmailEndpoints._require_mailbox_owner(agent, agent_id)
            EmailEndpoints._check_stalwart_configured()

            result = get_email(
                agent_id,
                message_uid,
                uidvalidity=uidvalidity,
                mark_read=mark_read,
                attachment_content=attachment_content,
            )
            if result is None:
                raise HTTPException(status_code=404, detail=f"Email with UID {message_uid} not found")
            return EmailDetailResponse(**result)
        except MailboxEpochChanged as exc:
            raise _epoch_conflict(exc) from exc
        except HTTPException:
            raise
        except Exception as e:
            logger.exception(f"Error fetching email detail: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    # ------------------------------------------------------------------
    # DELETE /api/agentic/agents/{agent_id}/email/{message_uid}
    # ------------------------------------------------------------------

    @staticmethod
    @cost(1)
    def email_delete(
        server,
        agent_id: str,
        message_uid: int,
        api_key: str = Security(api_key_header),
        uidvalidity: int | None = None,
    ) -> dict:
        """Delete an email by UID. Requires challenge-response."""
        try:
            agent = EmailEndpoints._extract_agent(server, api_key)
            EmailEndpoints._require_mailbox_owner(agent, agent_id)
            EmailEndpoints._check_stalwart_configured()

            deleted = delete_email(agent_id, message_uid, uidvalidity=uidvalidity)
            if not deleted:
                raise HTTPException(status_code=404, detail=f"Email with UID {message_uid} not found")
            return {
                "status": "deleted",
                "agent_id": agent_id,
                "message_uid": message_uid,
            }
        except MailboxEpochChanged as exc:
            raise _epoch_conflict(exc) from exc
        except HTTPException:
            raise
        except Exception as e:
            logger.exception(f"Error deleting email: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    # ------------------------------------------------------------------
    # POST /api/agentic/agents/{agent_id}/email/send
    # ------------------------------------------------------------------

    @staticmethod
    @cost(1)
    def email_send(
        server,
        agent_id: str,
        body: EmailSendRequest,
        api_key: str = Security(api_key_header),
        idempotency_key: str | None = None,
    ) -> EmailSendResponse:
        """Send an email from the agent to its primary owner. Requires challenge-response.

        With an ``idempotency_key`` the send goes through the durable outbox (see ``_send_keyed``).
        """
        try:
            agent = EmailEndpoints._extract_agent(server, api_key)
            EmailEndpoints._require_mailbox_owner(agent, agent_id)
            EmailEndpoints._check_smtp_configured()
            if idempotency_key is not None and not IDEMPOTENCY_KEY_RE.fullmatch(idempotency_key):
                raise HTTPException(status_code=400, detail={"code": "invalid_idempotency_key"})

            # Look up the agent's operator email
            with Session(server._engine) as db:
                owner_email = TableRead.get_operator_email(db, agent_id)

            if owner_email is None:
                raise HTTPException(
                    status_code=404,
                    detail=f"Agent '{agent_id}' has no operator. An org member must approve the signup request first.",
                )

            from_addr = agent_email_address(agent_id)
            if idempotency_key is not None:
                return EmailEndpoints._send_keyed(server, agent, body, idempotency_key, from_addr, owner_email)
            _submit(agent_id, owner_email, body)

            return EmailSendResponse(
                status="sent",
                from_addr=from_addr,
                to_addr=owner_email,
                subject=body.subject,
            )
        except HTTPException:
            raise
        except Exception as e:
            logger.exception(f"Error sending email: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    @staticmethod
    def _send_keyed(
        server, agent, body: EmailSendRequest, key: str, from_addr: str, owner_email: str
    ) -> EmailSendResponse:
        """Join or create the keyed record, run at most one SMTP attempt per claim, return the record.

        A new record is charged once, in the transaction that creates it. An attempt that dies
        without an outcome stays ``attempting`` until its lease expires, then reads as ``unknown``.
        """
        agent_id = agent.agent_id.value
        payload_hash = _payload_hash(body)
        with Session(server._engine) as db:
            row = TableWrite.create_email_delivery(
                db,
                agent_id=agent_id,
                idempotency_key=key,
                payload_hash=payload_hash,
                from_addr=from_addr,
                to_addr=owner_email,
                subject=body.subject,
                message_id=make_msgid(domain=EMAIL_DOMAIN),
            )
            if row is not None:
                server._charge_write(db, agent.agent_id)
            else:
                row = TableWrite.refresh_email_delivery(db, agent_id, key)
                if row.payload_hash != payload_hash:
                    raise HTTPException(status_code=409, detail={"code": "idempotency_key_reused"})
            delivery_id, to_addr, message_id = row.id, row.to_addr, row.message_id
            db.commit()
            attempt = TableWrite.claim_email_delivery(db, delivery_id, DELIVERY_LEASE)
            db.commit()

        if attempt is not None:
            state, error = "accepted", None
            if to_addr != owner_email:
                state, error = "failed", "recipient_changed"
            else:
                try:
                    _submit(agent_id, to_addr, body, message_id)
                except SmtpDeliveryError as exc:
                    state, error = exc.outcome, exc.reason
            if state == "retry_wait" and attempt >= DELIVERY_MAX_ATTEMPTS:
                state = "failed"
            with Session(server._engine) as db:
                TableWrite.finish_email_delivery(
                    db, delivery_id, attempt, state, error, _retry_in(attempt) if state == "retry_wait" else None
                )
                db.commit()

        with Session(server._engine) as db:
            response = _delivery_response(TableWrite.refresh_email_delivery(db, agent_id, key))
            db.commit()
        return response

    # ------------------------------------------------------------------
    # GET /api/agentic/agents/{agent_id}/email/deliveries/{idempotency_key}
    # ------------------------------------------------------------------

    @staticmethod
    @cost(1)
    def email_delivery(
        server,
        agent_id: str,
        idempotency_key: str,
        api_key: str = Security(api_key_header),
    ) -> EmailSendResponse:
        """The keyed outbox record (mailbox owner only); settles an expired attempt as unknown."""
        agent = EmailEndpoints._extract_agent(server, api_key)
        EmailEndpoints._require_mailbox_owner(agent, agent_id)
        with Session(server._engine) as db:
            row = TableWrite.refresh_email_delivery(db, agent_id, idempotency_key)
            if row is None:
                raise HTTPException(status_code=404, detail={"code": "delivery_not_found"})
            response = _delivery_response(row)
            db.commit()
        return response
