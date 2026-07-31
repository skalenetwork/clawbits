"""Email inbox API endpoints for agents.

Each agent has an email address ``{agent_id}@clawbits.ai`` backed by a
Stalwart IMAP server.  These endpoints let agents read and manage their
inbox through the Clawbits REST API.
"""
import logging

from fastapi import HTTPException, Security
from fastapi.security import APIKeyHeader
from sqlmodel import Session

from clawbits.datastructures.email_models import (
    EmailCountResponse,
    EmailDetailResponse,
    EmailListResponse,
    EmailSendRequest,
    EmailSendResponse,
    EmailSummaryResponse,
)
from clawbits.db.table_read import TableRead
from clawbits.email.imap_client import (
    STALWART_SVC_PASSWORD,
    agent_email_address,
    delete_email,
    get_email,
    get_email_counts,
    list_emails,
)
from clawbits.email.smtp_client import STALWART_SMTP_HOST
from clawbits.email.smtp_client import send_email as smtp_send_email
from clawbits.email.stalwart_provision import provision_mailbox
from clawbits.fastapi.agent_auth import extract_agent
from clawbits.gas.cost_decorator import cost

api_key_header = APIKeyHeader(name="Authorization", auto_error=False)

logger = logging.getLogger(__name__)


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
        if agent.agent_id.value != agent_id:
            raise HTTPException(
                status_code=403,
                detail="API key does not belong to this agent",
            )

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
    # GET /api/agentic/agents/{agent_id}/email/{message_uid}
    # ------------------------------------------------------------------

    @staticmethod
    @cost(1)
    def email_detail(
        server,
        agent_id: str,
        message_uid: int,
        api_key: str = Security(api_key_header),
    ) -> EmailDetailResponse:
        """Fetch a single email by UID with full body. Marks as read."""
        try:
            agent = EmailEndpoints._extract_agent(server, api_key)
            EmailEndpoints._require_mailbox_owner(agent, agent_id)
            EmailEndpoints._check_stalwart_configured()

            result = get_email(agent_id, message_uid)
            if result is None:
                raise HTTPException(status_code=404, detail=f"Email with UID {message_uid} not found")
            return EmailDetailResponse(**result)
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
    ) -> dict:
        """Delete an email by UID. Requires challenge-response."""
        try:
            agent = EmailEndpoints._extract_agent(server, api_key)
            EmailEndpoints._require_mailbox_owner(agent, agent_id)
            EmailEndpoints._check_stalwart_configured()

            deleted = delete_email(agent_id, message_uid)
            if not deleted:
                raise HTTPException(status_code=404, detail=f"Email with UID {message_uid} not found")
            return {
                "status": "deleted",
                "agent_id": agent_id,
                "message_uid": message_uid,
            }
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
    ) -> EmailSendResponse:
        """Send an email from the agent to its primary owner. Requires challenge-response."""
        try:
            agent = EmailEndpoints._extract_agent(server, api_key)
            EmailEndpoints._require_mailbox_owner(agent, agent_id)
            EmailEndpoints._check_smtp_configured()

            # Look up the agent's operator email
            with Session(server._engine) as db:
                owner_email = TableRead.get_operator_email(db, agent_id)

            if owner_email is None:
                raise HTTPException(
                    status_code=404,
                    detail=f"Agent '{agent_id}' has no operator. An org member must approve the signup request first.",
                )

            from_addr = agent_email_address(agent_id)
            # Ensure the SENDER (agent) mailbox exists. The recipient is the
            # operator's real external address - that is outbound delivery, not
            # a local mailbox, so we never provision the recipient.
            provision_mailbox(agent_id)
            # Convert attachment models to dicts for smtp_send_email
            attachments = [a.model_dump() for a in body.attachments] if body.attachments else None
            smtp_send_email(
                from_addr,
                owner_email,
                body.subject,
                body.message,
                attachments=attachments,
                headers=body.headers,
            )

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
