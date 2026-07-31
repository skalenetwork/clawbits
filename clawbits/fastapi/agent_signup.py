import logging
import os
import random
import secrets
import urllib.parse
import uuid as _uuid
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlmodel import Session

from clawbits.datastructures.agent_id import AgentId
from clawbits.datastructures.challenge_question_response import ChallengeQuestionResponse
from clawbits.datastructures.create_agent_request import CreateAgentRequest
from clawbits.datastructures.create_agent_response import CreateAgentResponse
from clawbits.datastructures.known_answers import get_random_question_answer
from clawbits.datastructures.nickname import NickName
from clawbits.datastructures.signup_request import SignupRequest
from clawbits.db.table_read import TableRead
from clawbits.db.table_write import TableWrite

logger = logging.getLogger(__name__)


class AgentSignup:
    @staticmethod
    def agents_signup_impl(
        server,
        payload: SignupRequest,
    ) -> ChallengeQuestionResponse:
        org_id = payload.org_id
        signup_token = payload.signup_token
        human_id: int | None = None

        with Session(server._engine) as db:
            org = TableRead.get_organization(db, org_id)
            if org is None:
                raise HTTPException(
                    status_code=404, detail=f"Organization '{org_id}' not found"
                )
            if signup_token:
                signup_session = TableRead.get_challenge_session(db, signup_token)
                if signup_session is None:
                    raise HTTPException(status_code=401, detail="Invalid signup token")
                if signup_session.get("used"):
                    raise HTTPException(status_code=401, detail="Signup token already used")
                if datetime.now(UTC) > signup_session["expires_at"]:
                    TableWrite.delete_challenge_session(db, signup_token)
                    raise HTTPException(status_code=401, detail="Signup token expired")
                if signup_session.get("org_id") != org_id or signup_session.get("human_id") is None:
                    raise HTTPException(status_code=401, detail="Invalid signup token")
                human_id = int(signup_session["human_id"])

        # Generate challenge question and session token
        question, answer = get_random_question_answer()
        session_token = "agentic-" + secrets.token_urlsafe(32)

        # Persist the challenge session in the database with a short expiration (e.g., 10 minutes)
        expires_at = datetime.now(UTC) + timedelta(minutes=10)
        with Session(server._engine) as db:
            TableWrite.create_challenge_session(
                db,
                session_token=session_token,
                question=question,
                answer=answer,
                expires_at=expires_at,
                owner_email=signup_token,
                org_id=org_id,
                human_id=human_id,
            )
            db.commit()

        return ChallengeQuestionResponse(
            session_token=session_token,
            challenge_question=question,
        )

    @staticmethod
    async def agents_signup_commit_impl(
        server,
        payload: CreateAgentRequest,
    ) -> CreateAgentResponse:
        """Complete agent creation by answering the challenge question from /api/agentic/agents/signup.

        Two flows feed this:

        - Token-initiated signup (``session_token`` prefixed ``agentic-`` with
          ``human_id`` stored): the agent answers a challenge after presenting
          a one-time human-issued signup token. Commit binds org + operator
          immediately. No approval row.

        - Human-initiated signup (``session_token`` prefixed ``human-``):
          the human is already authenticated when they create the session,
          so commit binds org + operator immediately. No approval row.
        """
        from clawbits.fastapi.avatar_hooks import await_agent_avatar, await_channel_avatar

        session_token = payload.session_token
        challenge_response = payload.challenge_response

        if not session_token:
            raise HTTPException(status_code=401, detail="session_token is required")

        is_human_session = session_token.startswith("human-")

        if not is_human_session and not challenge_response:
            raise HTTPException(status_code=401, detail="challenge_response is required")

        with Session(server._engine) as db:
            challenge = TableRead.get_challenge_session(db, session_token)
            if challenge is None:
                raise HTTPException(
                    status_code=401,
                    detail="Invalid challenge response: session token not found, expired, already used, or incorrect answer",
                )
            org_id = challenge.get("org_id")
            human_id = challenge.get("human_id")
            if org_id is None:
                raise HTTPException(
                    status_code=400,
                    detail="Challenge session is missing org_id",
                )

            if is_human_session:
                if challenge.get("used"):
                    raise HTTPException(status_code=401, detail="Session token already used")
                if datetime.now(UTC) > challenge["expires_at"]:
                    TableWrite.delete_challenge_session(db, session_token)
                    raise HTTPException(status_code=401, detail="Session token expired")
                if human_id is None:
                    raise HTTPException(
                        status_code=400,
                        detail="Human session is missing human_id",
                    )
            else:
                is_valid, _ = TableRead.validate_challenge_response(
                    db, session_token, challenge_response
                )
                if not is_valid:
                    raise HTTPException(
                        status_code=401,
                        detail="Invalid challenge response: session token not found, expired, already used, or incorrect answer",
                    )

            signup_token = challenge.get("owner_email")
            # "Run on Reef" stamps the reef VM id onto the human signup session
            # (which is ``challenge`` for a direct human-commit, or the
            # ``signup_session`` looked up below for the VM/agentic path). NULL
            # for self-hosted signups.
            reef_sandbox_id: str | None = challenge.get("reef_sandbox_id")
            if human_id is not None and signup_token:
                signup_session = TableRead.get_challenge_session(db, signup_token)
                if signup_session is None:
                    raise HTTPException(status_code=401, detail="Invalid signup token")
                if signup_session.get("used"):
                    raise HTTPException(status_code=401, detail="Signup token already used")
                if datetime.now(UTC) > signup_session["expires_at"]:
                    TableWrite.delete_challenge_session(db, signup_token)
                    raise HTTPException(status_code=401, detail="Signup token expired")
                reef_sandbox_id = signup_session.get("reef_sandbox_id") or reef_sandbox_id
                TableWrite.mark_challenge_session_used(db, signup_token)
            TableWrite.mark_challenge_session_used(db, session_token)

            org = TableRead.get_organization(db, org_id)
            if org is None:
                raise HTTPException(status_code=404, detail=f"Organization '{org_id}' not found")

            agent_id, nickname = AgentSignup.generate_random_id_and_nickname(db, server)

            # Provision the Stalwart mailbox best-effort. Agent creation must NOT
            # be blocked by the mail server being down/misconfigured - the mailbox
            # is also ensured lazily on first email send, and can be re-provisioned
            # later. (This was the original 503 failure mode.)
            from clawbits.email.stalwart_provision import provision_mailbox
            if not provision_mailbox(agent_id.value):
                logger.warning(
                    "Mailbox provisioning failed for agent %s; created without a "
                    "mailbox (will be ensured on first email use).",
                    agent_id.value,
                )

            api_key_str = TableWrite.create_agent(db, agent_id, nickname)
            if reef_sandbox_id:
                # Provisioned via "Run on Reef": link the agent to its reef VM.
                TableWrite.set_agent_reef_sandbox(db, agent_id.value, reef_sandbox_id)

            if human_id is not None:
                # Human/token-initiated: bind org + operator + DM immediately.
                TableWrite.set_agent_org_and_operator(
                    db, agent_id.value, org_id, int(human_id)
                )
                comm_channel, comm_channel_created = TableWrite.ensure_owner_agent_comm_channel(
                    db, agent_id.value
                )
                # Upload avatars BEFORE the commit that makes these rows
                # world-visible. The org-wide agent poll (New Agent dialog,
                # settings page) fetches an agent's avatar URL the instant its
                # row appears; if the SVG isn't in R2 yet that fetch 404s and
                # Cloudflare caches the 404 at the edge. Committing after the
                # upload closes that window — the URL is always live before any
                # reader can see the row. Best-effort: await_* swallow failures
                # internally so a DiceBear/R2 blip never blocks agent creation
                # (the client self-heals and the backfill fills the gap later).
                await await_agent_avatar(agent_id=agent_id.value)
                if comm_channel_created:
                    await await_channel_avatar(
                        channel_id=comm_channel["channel_id"], channel_type="direct"
                    )
                db.commit()
                return CreateAgentResponse(
                    agent_id=agent_id,
                    api_key=api_key_str,
                    signup_request_id=None,
                    status="approved",
                )

            # Anonymous path — leave org/operator unset until a human
            # approves the resulting signup request.
            request_id = str(_uuid.uuid4())
            TableWrite.create_signup_request(db, request_id, agent_id.value, org_id)
            db.commit()

        # See claim_pending branch above for why we await here.
        await await_agent_avatar(agent_id=agent_id.value)

        frontend_root = os.environ.get(
            "CLAWBITS_FRONTEND_URL", "http://localhost:5173"
        ).rstrip("/")
        approval_url = (
            f"{frontend_root}/settings/agents"
            f"?org_id={urllib.parse.quote(org_id)}"
            f"&signup_request={urllib.parse.quote(request_id)}"
        )

        return CreateAgentResponse(
            agent_id=agent_id,
            api_key=api_key_str,
            signup_request_id=request_id,
            status="pending_approval",
            approval_url=approval_url,
        )

    @staticmethod
    def approve_signup_request(
        server, request_id: str, reviewed_by: int, db: Session | None = None
    ) -> dict:
        """Approve a pending signup request — binds the agent to its org +
        operator and provisions the operator↔agent DM channel.

        If ``db`` is provided, it is used directly (the caller owns the
        transaction). Otherwise a fresh session is opened and committed.
        """
        if db is not None:
            return AgentSignup._approve_signup_request_inner(db, request_id, reviewed_by)

        with Session(server._engine) as sess:
            result = AgentSignup._approve_signup_request_inner(sess, request_id, reviewed_by)
            sess.commit()
            return result

    @staticmethod
    def _approve_signup_request_inner(
        db: Session, request_id: str, reviewed_by: int
    ) -> dict:
        req = TableRead.get_signup_request(db, request_id)
        if req is None:
            raise HTTPException(status_code=404, detail="Signup request not found")
        if req["status"] != "pending_approval":
            raise HTTPException(status_code=409, detail=f"Signup request already {req['status']}")

        agent_id = req["agent_id"]
        org_id = req["org_id"]

        # Bind the agent to its org + operator (the approver).
        TableWrite.set_agent_org_and_operator(db, agent_id, org_id, reviewed_by)

        # Create the operator↔agent DM. The public per-agent channel is
        # intentionally not provisioned here — the operator can opt in later
        # via "Start chat with your agent".
        comm_channel, comm_channel_created = TableWrite.ensure_owner_agent_comm_channel(
            db, agent_id
        )

        TableWrite.approve_signup_request(db, request_id, reviewed_by)
        result = TableRead.get_signup_request(db, request_id)

        # Only fire the avatar hook when we actually created the channel —
        # re-approving (idempotent path) shouldn't trigger another DiceBear
        # fetch + R2 upload.
        if comm_channel_created:
            from clawbits.fastapi.avatar_hooks import fire_channel_avatar
            fire_channel_avatar(
                channel_id=comm_channel["channel_id"], channel_type="direct"
            )

        return result

    @staticmethod
    def generate_random_id_and_nickname(
        db: Session, server
    ) -> tuple[AgentId, NickName]:
        _, nickname = random.choice(list(server._bot_names.items()))
        candidate_id = base_id = nickname
        counter = 0
        while TableRead.get_agent_by_agentid(db, AgentId(candidate_id)) is not None:
            counter += 1
            if counter % 3 == 0:
                base_id = candidate_id
            candidate_id = f"{base_id}{random.randint(1, 9)}"
        return AgentId(candidate_id), NickName(nickname)
