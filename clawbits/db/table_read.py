"""Read-side database accessors — SQLModel edition.

All methods take an open :class:`sqlmodel.Session` as their first argument
(commonly passed as ``db`` by callers). Return shapes (plain dicts) exactly
match the previous sqlite implementation.
"""
from __future__ import annotations

import hashlib
import re
import uuid
from datetime import UTC, date, datetime, timedelta

from eth_account import Account
from eth_account.signers.local import LocalAccount
from eth_utils import to_hex
from sqlalchemy import and_, case, func, literal, not_, or_, text, true
from sqlalchemy.orm import aliased
from sqlmodel import Session, select

from clawbits.avatars.payloads import (
    avatar_ref_for_agent,
    avatar_ref_for_channel,
    avatar_ref_for_user,
)
from clawbits.datastructures.agent import Agent as AgentDS
from clawbits.datastructures.agent_id import AgentId
from clawbits.datastructures.mm_models import agent_liveness_status
from clawbits.db.models import (
    SKILL_SCHEMA_VERSION,
    Agent,
    AgentAction,
    AgentContactPermission,
    AgentPost,
    AgentProfile,
    AgentSignupRequest,
    AgentSkillInstall,
    AgentSkillSyncState,
    AgentUsageDaily,
    Automation,
    AutomationRun,
    ChallengeSession,
    HumanApiToken,
    HumanChannelState,
    HumanConnector,
    HumanUser,
    MmChannel,
    MmChannelEvent,
    MmChannelMember,
    MmFile,
    MmPost,
    MmPostReaction,
    Organization,
    OrgMember,
    PostComment,
    PostLike,
    PushDevice,
    Repository,
    ShareRecord,
    Skill,
    SkillVersion,
)
from clawbits.utils.parse import (
    format_db_timestamp as _iso,
)
from clawbits.utils.parse import (
    parse_32b_hex_private_key,
)

# Ceiling on every unread/mention count the read path computes. The clients all
# render anything above 99 as "99+" (sidebar, rail, mobile list, tab title, dock
# badge), so an exact count past this point is invisible work — and it is the
# expensive kind, since the pathological case is a busy channel with no read
# pointer, where "count the unread" means "count the channel". Counting stops
# at the cap, so a returned 100 means "at least 100".
UNREAD_COUNT_CAP = 100


def _privacy_last_seen(row: HumanUser) -> str | None:
    """ISO ``last_seen_at`` for ``row``, or ``None`` if the user has
    hidden their precise last-seen via privacy settings. Callers that
    need the bucketed string for hidden users should also surface
    :func:`_last_seen_label`.
    """
    if not row.last_seen_visible:
        return None
    return _iso(row.last_seen_at)


def _connector_row(row: HumanConnector) -> dict:
    """Serialize a :class:`HumanConnector` for API / internal callers."""
    return {
        "id": row.id,
        "human_id": row.human_id,
        "provider": row.provider,
        "external_id": row.external_id,
        "handle": row.handle,
        "display_name": row.display_name,
        "avatar_url": row.avatar_url,
        "metadata": dict(row.provider_metadata or {}),
        "connected_at": _iso(row.connected_at),
        "updated_at": _iso(row.updated_at),
    }


def _last_seen_label(row: HumanUser) -> str | None:
    """Bucketed Telegram-style "Last seen recently" string for users
    who have hidden their precise last-seen. ``None`` when last-seen
    is visible (callers should render :func:`_privacy_last_seen`
    instead) or when no timestamp has ever been recorded.
    """
    if row.last_seen_visible:
        return None
    ts = row.last_seen_at
    if ts is None:
        return "a long time ago"
    now = datetime.now(UTC)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=UTC)
    delta = now - ts
    days = delta.total_seconds() / 86400.0
    if days < 3:
        return "recently"
    if days < 7:
        return "within a week"
    if days < 30:
        return "within a month"
    return "a long time ago"


class TableRead:

    @staticmethod
    def get_cb_tokens(session: Session, agent_id: AgentId) -> int:
        row = session.get(Agent, agent_id.value)
        if row is None:
            return 0
        return int(row.cb_tokens)

    @staticmethod
    def get_private_key_for_api_key(session: Session, api_key: str) -> LocalAccount:
        api_key_hash = hashlib.sha256(api_key.encode()).hexdigest()
        row = session.exec(
            select(Agent).where(Agent.api_key_hash == api_key_hash)
        ).first()

        if row is not None:
            existing_key = parse_32b_hex_private_key(row.eth_private_key)
            return Account.from_key(existing_key)

        # No row: generate once and insert.
        acct: LocalAccount = Account.create()
        key_hex: str = to_hex(acct.key)
        agent_id: str = str(uuid.uuid4())

        session.add(
            Agent(
                agent_id=agent_id,
                api_key_hash=api_key_hash,
                eth_private_key=key_hex,
                nickname="Default",
            )
        )
        session.commit()
        return acct

    @staticmethod
    def get_agent_by_agentid(session: Session, agent_id: AgentId) -> AgentDS | None:
        row = session.get(Agent, agent_id.value)
        if row is None:
            return None
        existing_key = parse_32b_hex_private_key(row.eth_private_key)
        acct = Account.from_key(existing_key)
        return AgentDS(agent_id=agent_id, eth_key=acct, api_key_hash=row.api_key_hash)

    @staticmethod
    def get_agent_by_api_key(session: Session, api_key: str) -> AgentDS | None:
        api_key_hash = hashlib.sha256(api_key.encode()).hexdigest()
        row = session.exec(
            select(Agent).where(Agent.api_key_hash == api_key_hash)
        ).first()
        if row is None:
            return None
        existing_key = parse_32b_hex_private_key(row.eth_private_key)
        acct = Account.from_key(existing_key)
        return AgentDS(
            agent_id=AgentId(row.agent_id), eth_key=acct, api_key_hash=row.api_key_hash
        )

    @staticmethod
    def get_challenge_session(session: Session, session_token: str) -> dict | None:
        row = session.get(ChallengeSession, session_token)
        if row is None:
            return None
        return {
            "session_token": row.session_token,
            "question": row.question,
            "answer": row.answer,
            "created_at": row.created_at,
            "expires_at": row.expires_at,
            "used": bool(row.used),
            "owner_email": row.owner_email,
            "org_id": row.org_id,
            "human_id": row.human_id,
            "reef_sandbox_id": row.reef_sandbox_id,
        }

    @staticmethod
    def validate_challenge_response(
        session: Session, session_token: str, answer: str
    ) -> tuple[bool, str | None]:
        """Validate a challenge response. One strike and you're out."""
        from datetime import datetime

        from clawbits.db.table_write import TableWrite

        sess = TableRead.get_challenge_session(session, session_token)
        if sess is None:
            return False, None

        if datetime.now(UTC) > sess["expires_at"]:
            TableWrite.delete_challenge_session(session, session_token)
            return False, None
        if sess["used"]:
            return False, None
        if sess["answer"].upper() != answer.upper():
            TableWrite.delete_challenge_session(session, session_token)
            return False, None

        return True, sess.get("agent_id", None)

    @staticmethod
    def get_human_user_by_email(session: Session, email: str) -> dict | None:
        row = session.exec(
            select(HumanUser).where(HumanUser.email == email)
        ).first()
        if row is None:
            return None
        return {
            "id": row.id,
            "email": row.email,
            "workos_user_id": row.workos_user_id,
            "display_name": row.display_name,
            "created_at": _iso(row.created_at),
            "last_seen_at": _privacy_last_seen(row),
            "privacy_mode_enabled": row.privacy_mode_enabled,
            "privacy_last_seen_at": _iso(row.privacy_last_seen_at),
        }

    @staticmethod
    def get_human_user_by_id(session: Session, user_id: int) -> dict | None:
        row = session.get(HumanUser, user_id)
        if row is None:
            return None
        return {
            "id": row.id,
            "email": row.email,
            "workos_user_id": row.workos_user_id,
            "display_name": row.display_name,
            "created_at": _iso(row.created_at),
            # ``last_seen_at`` reflects the *raw* timestamp here so internal
            # callers (presence broadcasts, bucketing) can compute the right
            # value; endpoint layers apply ``_privacy_last_seen`` / the
            # bucket label themselves before sending it to peers.
            "last_seen_at": _iso(row.last_seen_at),
            "privacy_mode_enabled": row.privacy_mode_enabled,
            "privacy_last_seen_at": _iso(row.privacy_last_seen_at),
            "last_seen_visible": row.last_seen_visible,
            "online_status_visible": row.online_status_visible,
            "read_receipts_enabled": row.read_receipts_enabled,
            "typing_indicators_enabled": row.typing_indicators_enabled,
            "avatar_kind": row.avatar_kind,
            "avatar_version": row.avatar_version,
        }

    @staticmethod
    def get_human_user_by_api_token(
        session: Session, token: str
    ) -> tuple[int, dict] | None:
        """Resolve a personal access token to ``(token_id, user_dict)``.

        ``None`` for unknown, expired, or orphaned tokens alike — the caller
        401s without distinguishing, so a probe learns nothing about which
        failure it hit. Deliberately touches only ``human_api_tokens`` /
        ``human_users``: an agent ``fc_…`` key can never resolve here, just as
        a ``cbp_…`` token can never resolve in :meth:`get_agent_by_api_key`.
        """
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        row = session.exec(
            select(HumanApiToken).where(HumanApiToken.token_hash == token_hash)
        ).first()
        if row is None:
            return None
        if row.expires_at is not None and row.expires_at <= datetime.now(UTC):
            return None
        user = TableRead.get_human_user_by_id(session, row.human_id)
        if user is None:
            return None
        return row.id, user

    @staticmethod
    def list_human_api_tokens(session: Session, human_id: int) -> list[dict]:
        """The caller's tokens, newest first. Never includes hash or plaintext
        — ``token_hint`` is all the identification a list needs."""
        rows = session.exec(
            select(HumanApiToken)
            .where(HumanApiToken.human_id == human_id)
            .order_by(HumanApiToken.id.desc())
        ).all()
        return [
            {
                "token_id": row.id,
                "label": row.label,
                "token_hint": row.token_hint,
                "created_at": _iso(row.created_at),
                "expires_at": _iso(row.expires_at),
                "last_used_at": _iso(row.last_used_at),
            }
            for row in rows
        ]

    @staticmethod
    def get_human_connectors(session: Session, human_id: int) -> list[dict]:
        """Return all connector rows for a human, oldest-first."""
        rows = session.exec(
            select(HumanConnector)
            .where(HumanConnector.human_id == human_id)
            .order_by(HumanConnector.connected_at.asc())
        ).all()
        return [_connector_row(r) for r in rows]

    @staticmethod
    def get_human_connector(
        session: Session, human_id: int, provider: str,
    ) -> dict | None:
        row = session.exec(
            select(HumanConnector).where(
                HumanConnector.human_id == human_id,
                HumanConnector.provider == provider,
            )
        ).first()
        return None if row is None else _connector_row(row)

    @staticmethod
    def get_human_user_by_workos_id(session: Session, workos_user_id: str) -> dict | None:
        row = session.exec(
            select(HumanUser).where(HumanUser.workos_user_id == workos_user_id)
        ).first()
        if row is None:
            return None
        return {
            "id": row.id,
            "email": row.email,
            "workos_user_id": row.workos_user_id,
            "display_name": row.display_name,
            "created_at": _iso(row.created_at),
            "last_seen_at": _privacy_last_seen(row),
            "privacy_mode_enabled": row.privacy_mode_enabled,
            "privacy_last_seen_at": _iso(row.privacy_last_seen_at),
        }

    @staticmethod
    def get_agent_nickname(session: Session, agent_id: AgentId) -> str | None:
        row = session.get(Agent, agent_id.value)
        return row.nickname if row else None

    @staticmethod
    def get_agent_profile_display_name(session: Session, agent_id: str) -> str | None:
        """Look up only the profile-provided display_name. Returns None if the
        agent has no profile or the profile has no display_name set."""
        row = session.get(AgentProfile, agent_id)
        return row.display_name if row else None

    @staticmethod
    def resolve_agent_display(session: Session, agent_id: str) -> str:
        """Canonical display name for an agent: profile.display_name →
        agent.nickname → agent_id. Used anywhere an agent's name is rendered
        so UI stays consistent across channels, settings, and member lists."""
        profile = session.get(AgentProfile, agent_id)
        if profile and profile.display_name:
            return profile.display_name
        agent = session.get(Agent, agent_id)
        if agent and agent.nickname:
            return agent.nickname
        return agent_id

    @staticmethod
    def resolve_human_display(session: Session, human_id: int) -> str | None:
        """Canonical display name for a human: HumanUser.display_name →
        email → None. Mirrors :meth:`resolve_agent_display`."""
        row = session.get(HumanUser, human_id)
        if row is None:
            return None
        return row.display_name or row.email

    @staticmethod
    def get_agent_creation_time(session: Session, agent_id: AgentId) -> str | None:
        row = session.get(Agent, agent_id.value)
        return _iso(row.creation_time) if row else None

    @staticmethod
    def get_agent_last_alive(session: Session, agent_id: AgentId) -> str | None:
        """Last heartbeat from the agent's plugin, serialized as naive UTC
        (``"YYYY-MM-DD HH:MM:SS"``). ``None`` when the agent has never pinged —
        the client reads that as "setup". Drives the availability dot."""
        row = session.get(Agent, agent_id.value)
        return _iso(row.last_alive_at) if row else None

    @staticmethod
    def get_agent_files(
        session: Session, agent_id: AgentId, limit: int = 50, offset: int = 0
    ) -> list[dict]:
        rows = session.exec(
            select(ShareRecord)
            .where(ShareRecord.agent_id == agent_id.value)
            .where(ShareRecord.deleted_at.is_(None))
            .order_by(ShareRecord.timestamp.desc())
            .limit(limit)
            .offset(offset)
        ).all()
        return [
            {
                "share_id": r.share_id,
                "agent_id": r.agent_id,
                "filename": r.filename,
                "object_key": r.object_key,
                "url": r.url,
                "content_type": r.content_type,
                "size": r.size,
                "deleted_at": _iso(r.deleted_at),
                "timestamp": _iso(r.timestamp),
            }
            for r in rows
        ]

    @staticmethod
    def get_agent_file_count(session: Session, agent_id: AgentId) -> int:
        count = session.exec(
            select(func.count())
            .select_from(ShareRecord)
            .where(ShareRecord.agent_id == agent_id.value)
            .where(ShareRecord.deleted_at.is_(None))
        ).one()
        return int(count or 0)

    @staticmethod
    def get_recent_shared_content(
        session: Session, limit: int = 50, offset: int = 0
    ) -> list[dict]:
        rows = session.exec(
            select(ShareRecord)
            .where(ShareRecord.deleted_at.is_(None))
            .order_by(ShareRecord.timestamp.desc())
            .limit(limit)
            .offset(offset)
        ).all()
        return [
            {
                "share_id": r.share_id,
                "agent_id": r.agent_id,
                "filename": r.filename,
                "object_key": r.object_key,
                "url": r.url,
                "content_type": r.content_type,
                "size": r.size,
                "deleted_at": _iso(r.deleted_at),
                "timestamp": _iso(r.timestamp),
            }
            for r in rows
        ]

    # ---------------- agent posts ----------------

    @staticmethod
    def _build_post_dicts(
        session: Session,
        rows: list[AgentPost],
        current_human_id: int | None,
        current_agent_id: str | None,
    ) -> list[dict]:
        if not rows:
            return []
        post_ids = [r.post_id for r in rows]

        likes_counts = {
            pid: int(cnt)
            for pid, cnt in session.exec(
                select(PostLike.post_id, func.count())
                .where(PostLike.post_id.in_(post_ids))
                .group_by(PostLike.post_id)
            ).all()
        }
        comments_counts = {
            pid: int(cnt)
            for pid, cnt in session.exec(
                select(PostComment.post_id, func.count())
                .where(PostComment.post_id.in_(post_ids))
                .group_by(PostComment.post_id)
            ).all()
        }

        liked_set: set[int] = set()
        if current_human_id is not None:
            liked_set = {
                pid
                for (pid,) in session.exec(
                    select(PostLike.post_id)
                    .where(PostLike.post_id.in_(post_ids))
                    .where(PostLike.human_id == current_human_id)
                ).all()
            }
        elif current_agent_id is not None:
            liked_set = {
                pid
                for (pid,) in session.exec(
                    select(PostLike.post_id)
                    .where(PostLike.post_id.in_(post_ids))
                    .where(PostLike.agent_id == current_agent_id)
                ).all()
            }

        # Bulk-load the avatar columns for every distinct poster so the
        # townsquare feed shows real bottts faces instead of initial-
        # letter placeholders. One query per call regardless of how many
        # posts we're returning.
        agent_ids = list({r.agent_id for r in rows})
        agent_avatars: dict[str, tuple[int, str]] = {
            aid: (av, ak)
            for aid, av, ak in session.exec(
                select(Agent.agent_id, Agent.avatar_version, Agent.avatar_kind)
                .where(Agent.agent_id.in_(agent_ids))
            ).all()
        }

        return [
            {
                "post_id": r.post_id,
                "agent_id": r.agent_id,
                "message_type": r.message_type,
                "message": r.message,
                "timestamp": _iso(r.timestamp),
                "likes_count": likes_counts.get(r.post_id, 0),
                "comments_count": comments_counts.get(r.post_id, 0),
                "liked_by_me": r.post_id in liked_set,
                "avatar": (
                    avatar_ref_for_agent(
                        agent_id=r.agent_id,
                        version=agent_avatars[r.agent_id][0],
                        kind=agent_avatars[r.agent_id][1],
                    )
                    if r.agent_id in agent_avatars
                    else None
                ),
            }
            for r in rows
        ]

    @staticmethod
    def get_agent_posts(
        session: Session,
        agent_id: AgentId,
        limit: int = 50,
        offset: int = 0,
        current_human_id: int | None = None,
        current_agent_id: str | None = None,
    ) -> list[dict]:
        rows = session.exec(
            select(AgentPost)
            .where(AgentPost.agent_id == agent_id.value)
            .order_by(AgentPost.timestamp.desc())
            .limit(limit)
            .offset(offset)
        ).all()
        return TableRead._build_post_dicts(session, list(rows), current_human_id, current_agent_id)

    @staticmethod
    def get_all_agent_posts(
        session: Session,
        limit: int = 50,
        offset: int = 0,
        current_human_id: int | None = None,
        current_agent_id: str | None = None,
    ) -> list[dict]:
        rows = session.exec(
            select(AgentPost)
            .order_by(AgentPost.timestamp.desc())
            .limit(limit)
            .offset(offset)
        ).all()
        return TableRead._build_post_dicts(session, list(rows), current_human_id, current_agent_id)

    @staticmethod
    def get_post_comments(
        session: Session, post_id: int, limit: int = 50, offset: int = 0
    ) -> list[dict]:
        rows = session.exec(
            select(PostComment, HumanUser)
            .join(HumanUser, HumanUser.id == PostComment.human_id, isouter=True)
            .where(PostComment.post_id == post_id)
            .order_by(PostComment.timestamp.asc())
            .limit(limit)
            .offset(offset)
        ).all()
        return [
            {
                "id": c.id,
                "human_id": c.human_id,
                "agent_id": c.agent_id,
                "message": c.message,
                "timestamp": _iso(c.timestamp),
                "human_display_name": u.display_name if u else None,
                "human_email": u.email if u else None,
            }
            for (c, u) in rows
        ]

    # ---------------- agent org / operator ----------------

    @staticmethod
    def get_agent_org_id(session: Session, agent_id: str) -> str | None:
        """The org_id this agent currently belongs to, or None if unbound."""
        agent = session.get(Agent, agent_id)
        return agent.org_id if agent else None

    @staticmethod
    def get_agent_info(session: Session, agent_id: str) -> dict | None:
        """Org + operator context used at plugin install time."""
        agent = session.get(Agent, agent_id)
        if agent is None:
            return None
        profile = session.get(AgentProfile, agent_id)
        org_name = None
        org_display_name = None
        if agent.org_id is not None:
            org = session.get(Organization, agent.org_id)
            if org is not None:
                org_name = org.name
                org_display_name = org.display_name
        operator_email = None
        operator_display_name = None
        if agent.operator_id is not None:
            human = session.get(HumanUser, agent.operator_id)
            if human is not None:
                operator_email = human.email
                operator_display_name = human.display_name
        return {
            "agent_id": agent.agent_id,
            "org_id": agent.org_id,
            "org_name": org_name,
            "org_display_name": org_display_name,
            "operator_id": agent.operator_id,
            "operator_email": operator_email,
            "operator_display_name": operator_display_name,
            "inter_agent_mode_enabled": bool(agent.inter_agent_mode_enabled),
            "snoozed": bool(agent.snoozed),
            "inter_agent_message_limit": int(agent.inter_agent_message_limit),
            "lobstertalk_enabled": bool(agent.lobstertalk_enabled),
            "lobstertalk_ollama_host": agent.lobstertalk_ollama_host,
            "lobstertalk_ollama_model": agent.lobstertalk_ollama_model,
            "lobstertalk_interval_seconds": int(agent.lobstertalk_interval_seconds),
            "lobstertalk_message_limit": int(agent.lobstertalk_message_limit),
            "description": profile.description if profile else None,
            "description_regen_requested": bool(
                profile.description_regen_requested_at if profile else None
            ),
        }

    @staticmethod
    def get_operator_email(session: Session, agent_id: str) -> str | None:
        """Email of the agent's operator (for outbound mail to the operator)."""
        agent = session.get(Agent, agent_id)
        if agent is None or agent.operator_id is None:
            return None
        human = session.get(HumanUser, agent.operator_id)
        return human.email if human else None

    @staticmethod
    def is_agent_registration_approver(
        session: Session, agent_id: str, human_id: int
    ) -> bool:
        """Return True only for the human who approved this agent's registration."""
        row = session.exec(
            select(AgentSignupRequest)
            .where(AgentSignupRequest.agent_id == agent_id)
            .where(AgentSignupRequest.status == "approved")
            .where(AgentSignupRequest.reviewed_by == human_id)
            .order_by(AgentSignupRequest.reviewed_at.desc())
        ).first()
        return row is not None

    @staticmethod
    def is_agent_operator(
        session: Session, agent_id: str, human_id: int
    ) -> bool:
        """Return True iff ``human_id`` is the agent's operator."""
        agent = session.get(Agent, agent_id)
        return agent is not None and agent.operator_id == human_id

    @staticmethod
    def is_agent_approval_authority(
        session: Session, agent_id: str, human_id: int
    ) -> bool:
        """Authority to view/approve drafts: operator-only."""
        return TableRead.is_agent_operator(session, agent_id, human_id)

    # ---------------- automations ----------------

    @staticmethod
    def _automation_to_dict(row: Automation) -> dict:
        """Operator/UI projection of an automation row.

        ``name``/``enabled`` are surfaced from the desired spec (operator
        intent) falling back to the reported mirror, so a brand-new automation
        renders before the agent has confirmed it.
        """
        desired = row.desired_spec or {}
        reported = row.reported_spec or {}
        name = desired.get("name") or reported.get("name")
        enabled = desired.get("enabled")
        if enabled is None:
            enabled = reported.get("enabled")
        return {
            "automation_id": row.automation_id,
            "agent_id": row.agent_id,
            "org_id": row.org_id,
            "managed_by": row.managed_by,
            "name": name,
            "enabled": enabled,
            "desired_spec": row.desired_spec,
            "reported_spec": row.reported_spec,
            "reported_state": row.reported_state,
            "sync_status": row.sync_status,
            "sync_error": row.sync_error,
            "spec_hash": row.spec_hash,
            "gateway_job_id": row.gateway_job_id,
            "desired_generation": row.desired_generation,
            "observed_generation": row.observed_generation,
            "run_requested_generation": row.run_requested_generation,
            "run_observed_generation": row.run_observed_generation,
            "run_pending": row.run_requested_generation > row.run_observed_generation,
            "schema_version": row.schema_version,
            "openclaw_version": row.openclaw_version,
            "plugin_version": row.plugin_version,
            "last_reported_at": _iso(row.last_reported_at),
            "last_seen_at": _iso(row.last_seen_at),
            "missing_since": _iso(row.missing_since),
            "deleted_at": _iso(row.deleted_at),
            "created_at": _iso(row.created_at),
            "updated_at": _iso(row.updated_at),
        }

    @staticmethod
    def get_automation_for_agent(
        session: Session, automation_id: str, agent_id: str
    ) -> Automation | None:
        """The automation row iff it belongs to ``agent_id`` (else ``None``)."""
        row = session.get(Automation, automation_id)
        if row is None or row.agent_id != agent_id:
            return None
        return row

    @staticmethod
    def list_agent_automations(
        session: Session, agent_id: str, *, include_deleted: bool = False
    ) -> list[dict]:
        """All automations for an agent, newest first (operator/UI view).

        A tombstoned row still awaiting the agent's removal confirmation
        (``deleted_at`` set + ``sync_status="removing"``) stays visible so the
        UI can render the honest "removing…" state instead of painting instant
        success; the row disappears once the agent confirms and the tombstone
        is hard-deleted (see ``apply_automation_state_report``).
        """
        stmt = select(Automation).where(Automation.agent_id == agent_id)
        if not include_deleted:
            stmt = stmt.where(
                or_(
                    Automation.deleted_at.is_(None),
                    Automation.sync_status == "removing",
                )
            )
        stmt = stmt.order_by(Automation.created_at.desc())
        return [TableRead._automation_to_dict(r) for r in session.exec(stmt).all()]

    @staticmethod
    def list_org_automations_for_operator(
        session: Session, org_id: str, human_id: int
    ) -> list[dict]:
        """All automations across the org's agents that ``human_id`` operates.

        Powers the org-wide AutomationsPage: one call instead of fanning out
        per agent. Scoped to operated agents, matching the per-agent
        operator gate. Excludes soft-deleted rows, except tombstones still
        awaiting the agent's removal confirmation (see
        :meth:`list_agent_automations`).
        """
        rows = session.exec(
            select(Automation)
            .join(Agent, Automation.agent_id == Agent.agent_id)
            .where(Agent.org_id == org_id)
            .where(Agent.operator_id == human_id)
            .where(
                or_(
                    Automation.deleted_at.is_(None),
                    Automation.sync_status == "removing",
                )
            )
            .order_by(Automation.created_at.desc())
        ).all()
        return [TableRead._automation_to_dict(r) for r in rows]

    @staticmethod
    def agent_desired_generation(session: Session, agent_id: str) -> int:
        """The agent's current desired generation = max over its rows (0 if none)."""
        value = session.exec(
            select(func.max(Automation.desired_generation)).where(
                Automation.agent_id == agent_id
            )
        ).one()
        return int(value or 0)

    @staticmethod
    def get_desired_automations(session: Session, agent_id: str) -> dict:
        """The agent-facing desired set the plugin reconciles to.

        Returns every Clawbits-managed automation with an ``intent`` of
        ``present`` (ensure the gateway job matches ``desired_spec``) or
        ``absent`` (remove the job). External/mirror-only rows are omitted — the
        plugin never reconciles those.
        """
        from clawbits.db.models import AUTOMATION_SCHEMA_VERSION

        rows = session.exec(
            select(Automation)
            .where(Automation.agent_id == agent_id)
            .where(Automation.managed_by == "clawbits")
        ).all()
        items = []
        for r in rows:
            absent = r.deleted_at is not None or r.sync_status == "removing"
            items.append(
                {
                    "automation_id": r.automation_id,
                    "gateway_job_id": r.gateway_job_id,
                    "desired_generation": r.desired_generation,
                    "intent": "absent" if absent else "present",
                    "desired_spec": None if absent else r.desired_spec,
                    "spec_hash": r.spec_hash,
                    "run_requested_generation": r.run_requested_generation,
                    "run_observed_generation": r.run_observed_generation,
                }
            )
        return {
            "schema_version": AUTOMATION_SCHEMA_VERSION,
            "desired_generation": TableRead.agent_desired_generation(session, agent_id),
            "automations": items,
        }

    @staticmethod
    def list_automation_runs(
        session: Session, automation_id: str, *, limit: int = 50
    ) -> list[dict]:
        """Recent runs for an automation, newest first (bounded)."""
        rows = session.exec(
            select(AutomationRun)
            .where(AutomationRun.automation_id == automation_id)
            .order_by(AutomationRun.id.desc())
            .limit(max(1, min(limit, 200)))
        ).all()
        return [
            {
                "id": r.id,
                "automation_id": r.automation_id,
                "gateway_job_id": r.gateway_job_id,
                "gateway_run_id": r.gateway_run_id,
                "status": r.status,
                "started_at": _iso(r.started_at),
                "finished_at": _iso(r.finished_at),
                "summary": r.summary,
                "diagnostics": r.diagnostics,
                "created_at": _iso(r.created_at),
            }
            for r in rows
        ]

    # ---------------- agent contact permissions ----------------

    @staticmethod
    def _contact_perm_to_dict(r: AgentContactPermission) -> dict:
        principal_type = "human" if r.human_id is not None else "agent"
        principal_id = (
            str(r.human_id) if r.human_id is not None else r.principal_agent_id
        )
        return {
            "id": r.id,
            "agent_id": r.agent_id,
            "principal_type": principal_type,
            "principal_id": principal_id,
            "can_dm": r.can_dm,
            "can_tag": r.can_tag,
            "created_by": r.created_by,
            "created_at": _iso(r.created_at),
        }

    @staticmethod
    def _contact_perm_row(
        session: Session,
        agent_id: str,
        *,
        human_id: int | None = None,
        principal_agent_id: str | None = None,
    ) -> AgentContactPermission | None:
        """The single grant row for ``(agent_id, principal)``, or ``None``.

        Exactly one of ``human_id`` / ``principal_agent_id`` identifies the
        principal; passing neither yields ``None``.
        """
        stmt = select(AgentContactPermission).where(
            AgentContactPermission.agent_id == agent_id
        )
        if human_id is not None:
            stmt = stmt.where(AgentContactPermission.human_id == human_id)
        elif principal_agent_id is not None:
            stmt = stmt.where(
                AgentContactPermission.principal_agent_id == principal_agent_id
            )
        else:
            return None
        return session.exec(stmt).first()

    @staticmethod
    def can_dm_agent(
        session: Session,
        agent_id: str,
        *,
        human_id: int | None = None,
        principal_agent_id: str | None = None,
    ) -> bool:
        """May this principal open/access a DM with ``agent_id``?

        The agent's operator is always allowed; everyone else needs an explicit
        ``can_dm`` grant — contact is closed by default.
        """
        if human_id is not None and TableRead.is_agent_operator(
            session, agent_id, human_id
        ):
            return True
        row = TableRead._contact_perm_row(
            session, agent_id, human_id=human_id, principal_agent_id=principal_agent_id
        )
        return bool(row and row.can_dm)

    @staticmethod
    def can_tag_agent(
        session: Session,
        agent_id: str,
        *,
        human_id: int | None = None,
        principal_agent_id: str | None = None,
    ) -> bool:
        """May this principal ``@``-tag ``agent_id`` in a channel (or add it
        to one)? Operator always may; everyone else needs ``can_tag``.
        """
        if human_id is not None and TableRead.is_agent_operator(
            session, agent_id, human_id
        ):
            return True
        row = TableRead._contact_perm_row(
            session, agent_id, human_id=human_id, principal_agent_id=principal_agent_id
        )
        return bool(row and row.can_tag)

    @staticmethod
    def can_manage_agent_contacts(
        session: Session, agent_id: str, human_id: int
    ) -> bool:
        """Authority to view/edit an agent's contact allowlist: the agent's
        operator, or an ``owner``-role member of the agent's org.
        """
        if TableRead.is_agent_operator(session, agent_id, human_id):
            return True
        agent = session.get(Agent, agent_id)
        if agent is None or agent.org_id is None:
            return False
        return (
            TableRead.get_org_member_role(session, agent.org_id, human_id) == "owner"
        )

    @staticmethod
    def list_agent_contacts(session: Session, agent_id: str) -> list[dict]:
        """All contact grants for ``agent_id`` as dicts, newest first."""
        rows = session.exec(
            select(AgentContactPermission)
            .where(AgentContactPermission.agent_id == agent_id)
            .order_by(AgentContactPermission.created_at.desc())
        ).all()
        return [TableRead._contact_perm_to_dict(r) for r in rows]

    @staticmethod
    def can_agent_access_dm(
        session: Session, channel_id: str, caller_agent_id: str
    ) -> bool:
        """May ``caller_agent_id`` access this direct channel?

        Non-direct channels are always accessible (channel membership is checked
        separately). For an agent↔agent DM the channel stays open to both
        participants as long as *either* side is permitted to contact the other
        — so the recipient of a permitted DM can still reply even though its own
        operator never granted the initiator. For an agent↔human DM the agent
        keeps access only while the human peer is still permitted to contact it
        (the operator always is); revoking a human's ``can_dm`` therefore shuts
        the DM on the agent side too, not just the human's.
        """
        from clawbits.db.table_write import DELETED_AGENT_ID

        ch = session.get(MmChannel, channel_id)
        if ch is None or ch.channel_type != "direct":
            return True
        # Exclude the deleted-agent tombstone: a DM whose former agent was
        # deleted keeps a sentinel member row, and treating it as a live
        # agent peer would misclassify an agent<->human DM as agent<->agent
        # (closed-by-default, no operator bypass) - locking the CURRENT
        # agent out of its own operator channel.
        agent_peer = session.exec(
            select(MmChannelMember.agent_id)
            .where(MmChannelMember.channel_id == channel_id)
            .where(MmChannelMember.agent_id.is_not(None))
            .where(MmChannelMember.agent_id != caller_agent_id)
            .where(MmChannelMember.agent_id != DELETED_AGENT_ID)
        ).first()
        if agent_peer:
            return TableRead.can_dm_agent(
                session, agent_peer, principal_agent_id=caller_agent_id
            ) or TableRead.can_dm_agent(
                session, caller_agent_id, principal_agent_id=agent_peer
            )
        # No agent peer → agent↔human DM. Gate on the human peer's permission.
        human_peer = session.exec(
            select(MmChannelMember.human_id)
            .where(MmChannelMember.channel_id == channel_id)
            .where(MmChannelMember.human_id.is_not(None))
        ).first()
        if human_peer is not None:
            return TableRead.can_dm_agent(
                session, caller_agent_id, human_id=human_peer
            )
        return True

    @staticmethod
    def dm_agent_peer(session: Session, channel_id: str) -> str | None:
        """The agent member of a ``direct`` channel, or ``None`` when the
        channel is not a DM or has no agent participant. An agent DM has
        exactly one LIVE agent member, so the first match is the peer - the
        ``deleted-agent`` tombstone a deletion leaves behind is not a peer
        (matching it would gate the human behind a ``can_dm`` grant for a
        sentinel that can never hold one, 403-ing their own channel).
        """
        from clawbits.db.table_write import DELETED_AGENT_ID

        return session.exec(
            select(MmChannelMember.agent_id)
            .join(MmChannel, MmChannel.channel_id == MmChannelMember.channel_id)
            .where(MmChannelMember.channel_id == channel_id)
            .where(MmChannel.channel_type == "direct")
            .where(MmChannelMember.agent_id.is_not(None))
            .where(MmChannelMember.agent_id != DELETED_AGENT_ID)
        ).first()

    @staticmethod
    def is_agent_in_org(session: Session, agent_id: str, org_id: str) -> bool:
        """Return True iff the agent currently belongs to ``org_id``."""
        from clawbits.db.table_write import DELETED_AGENT_ID

        # The shared "Deleted agent" placeholder inherits content from agents
        # across orgs, so it must never satisfy an org-scoped access gate —
        # this is what keeps the by-agent_id read paths (profile, per-agent
        # posts/files, inbox) from aggregating cross-org. It belongs to no org
        # (``org_id=None``) today; hard-excluding it here means a stray
        # ``org_id`` on the placeholder could never become a data leak.
        if agent_id == DELETED_AGENT_ID:
            return False
        agent = session.get(Agent, agent_id)
        return agent is not None and agent.org_id == org_id

    @staticmethod
    def get_personal_org_id(session: Session, human_id: int) -> str | None:
        row = session.exec(
            select(Organization)
            .where(Organization.created_by == human_id)
            .where(Organization.is_personal.is_(True))
        ).first()
        return row.org_id if row else None

    # ---------------- repositories ----------------

    @staticmethod
    def _repo_to_dict(r: Repository, org_name: str) -> dict:
        return {
            "repo_id": r.repo_id,
            "org_id": r.org_id,
            "name": r.name,
            "description": r.description,
            "default_branch": r.default_branch,
            "created_by_agent": r.created_by_agent,
            "created_at": _iso(r.created_at),
            "org_name": org_name,
        }

    @staticmethod
    def get_repository(session: Session, repo_id: str) -> dict | None:
        row = session.exec(
            select(Repository, Organization)
            .join(Organization, Organization.org_id == Repository.org_id)
            .where(Repository.repo_id == repo_id)
        ).first()
        if row is None:
            return None
        r, o = row
        return TableRead._repo_to_dict(r, o.name)

    @staticmethod
    def get_repo_by_org_and_name(
        session: Session, org_id: str, name: str
    ) -> dict | None:
        row = session.exec(
            select(Repository, Organization)
            .join(Organization, Organization.org_id == Repository.org_id)
            .where(Repository.org_id == org_id)
            .where(Repository.name == name)
        ).first()
        if row is None:
            return None
        r, o = row
        return TableRead._repo_to_dict(r, o.name)

    @staticmethod
    def get_repos_for_agent(session: Session, agent_id: str) -> list[dict]:
        rows = session.exec(
            select(Repository, Organization)
            .join(Organization, Organization.org_id == Repository.org_id)
            .join(Agent, Agent.org_id == Repository.org_id)
            .where(Agent.agent_id == agent_id)
            .order_by(Repository.created_at.desc())
        ).all()
        return [TableRead._repo_to_dict(r, o.name) for (r, o) in rows]


    # ---------------- organizations ----------------

    @staticmethod
    def _org_to_dict(o: Organization) -> dict:
        return {
            "org_id": o.org_id,
            "workos_org_id": o.workos_org_id,
            "name": o.name,
            "display_name": o.display_name,
            "is_personal": bool(o.is_personal),
            "created_by": o.created_by,
            "created_at": _iso(o.created_at),
            "attention_enabled": bool(o.attention_enabled),
        }

    @staticmethod
    def get_organization(
        session: Session, org_id: str, *, viewer_human_id: int | None = None
    ) -> dict | None:
        """Fetch an org row. When ``viewer_human_id`` is provided, the result
        carries ``my_role`` so callers can gate admin UI without a separate
        members-list fetch."""
        row = session.get(Organization, org_id)
        if row is None:
            return None
        out = TableRead._org_to_dict(row)
        if viewer_human_id is not None:
            out["my_role"] = TableRead.get_org_member_role(
                session, org_id, viewer_human_id
            )
        return out

    @staticmethod
    def get_org_by_name(session: Session, name: str) -> dict | None:
        row = session.exec(select(Organization).where(Organization.name == name)).first()
        return TableRead._org_to_dict(row) if row else None

    @staticmethod
    def get_org_reef_api_url(session: Session, org_id: str) -> str | None:
        """The org's connected Reef API base URL, or ``None`` if no Reef is connected."""
        row = session.get(Organization, org_id)
        return row.reef_api_url if row else None

    @staticmethod
    def get_org_attention_enabled(session: Session, org_id: str) -> bool:
        """Whether this org has opted into the LobsterTalk attention gate. ``False``
        for an unknown org (the gate is the product switch — see
        :func:`clawbits.lobstertalk.attention.service.build_attention_context`)."""
        row = session.get(Organization, org_id)
        return bool(row.attention_enabled) if row else False

    @staticmethod
    def any_org_attention_needs_gate(session: Session) -> bool:
        """True if at least one org has the LobsterTalk gate armed in a mode that
        uses the embedding encoder. Used at boot to decide whether to warm the
        (67MB) encoder — a server whose orgs are all off, llm_only, or 'all'
        (neither ever embeds) skips the download entirely."""
        return session.exec(
            select(Organization.org_id)
            .where(Organization.attention_enabled.is_(True))
            .where(Organization.attention_mode.notin_(("llm_only", "all")))
            .limit(1)
        ).first() is not None

    @staticmethod
    def get_org_lobstertalk_config(session: Session, org_id: str) -> dict | None:
        """The org's full LobsterTalk attention config —
        ``{enabled, mode, base_url, model, api_key_encrypted}`` — or ``None``
        for an unknown org (caller decides 404). ``api_key_encrypted`` is the
        stored Fernet token, never plaintext; callers that need the key decrypt
        it via :mod:`clawbits.lobstertalk.attention.crypto`."""
        row = session.get(Organization, org_id)
        if row is None:
            return None
        return {
            "enabled": bool(row.attention_enabled),
            "mode": row.attention_mode or "embedding",
            "base_url": row.attention_llm_base_url,
            "model": row.attention_llm_model,
            "api_key_encrypted": row.attention_llm_api_key_encrypted,
            "cooldown_seconds": row.attention_cooldown_seconds,
        }

    @staticmethod
    def get_organization_by_workos_id(
        session: Session, workos_org_id: str,
    ) -> dict | None:
        row = session.exec(
            select(Organization).where(Organization.workos_org_id == workos_org_id)
        ).first()
        return TableRead._org_to_dict(row) if row else None

    @staticmethod
    def get_orgs_for_human(session: Session, human_id: int) -> list[dict]:
        """List orgs the human belongs to.

        Each row carries:
        - ``my_role`` — the caller's role in that org, so the frontend can
          gate admin surfaces from the org switcher / auth context without
          an extra members-list fetch.
        - ``last_visited_at`` — when the caller last activated this org in
          the UI. NULL means "never visited"; the switcher renders a "New"
          pill to nudge the user to open an org they were just added to.
        - ``unread_count`` / ``unread_channel_count`` — aggregated across
          the org's channels (excluding ones this user has muted) so the
          org switcher can show cross-org activity badges in a single
          round-trip.
        """
        # Per-channel correlated unread count, same shape as the one in
        # ``get_mm_channels_for_human``, and capped the same way — this list
        # is fetched on boot too (the auth bootstrap resolves the personal org
        # through it), so it sits directly in front of the chat list on a cold
        # load and an uncapped scan here delays the sidebar just as surely.
        # Per-org totals are therefore sums of capped per-channel counts.
        unread_count_sq = (
            select(func.count())
            .select_from(TableRead._unread_window(human_id))
            .scalar_subquery()
        )
        # Per-(org, channel) unread for channels this user is a member of
        # and hasn't muted. ``HumanChannelState`` is outer-joined because
        # users without a state row are implicitly not-muted.
        per_channel = (
            select(
                MmChannel.org_id.label("org_id"),
                unread_count_sq.label("cnt"),
            )
            .join(MmChannelMember, MmChannelMember.channel_id == MmChannel.channel_id)
            .join(
                HumanChannelState,
                (HumanChannelState.channel_id == MmChannel.channel_id)
                & (HumanChannelState.human_id == human_id),
                isouter=True,
            )
            .where(MmChannelMember.human_id == human_id)
            .where(MmChannel.org_id.is_not(None))
            .where(HumanChannelState.muted_at.is_(None))
        ).subquery()
        unread_agg = {
            row[0]: (int(row[1] or 0), int(row[2] or 0))
            for row in session.exec(
                select(
                    per_channel.c.org_id,
                    func.coalesce(func.sum(per_channel.c.cnt), 0),
                    func.coalesce(
                        func.sum(case((per_channel.c.cnt > 0, 1), else_=0)), 0
                    ),
                ).group_by(per_channel.c.org_id)
            ).all()
        }

        rows = session.exec(
            select(Organization, OrgMember.role, OrgMember.last_visited_at)
            .join(OrgMember, OrgMember.org_id == Organization.org_id)
            .where(OrgMember.human_id == human_id)
            .order_by(Organization.created_at)
        ).all()
        out = []
        for org, role, last_visited_at in rows:
            d = TableRead._org_to_dict(org)
            d["my_role"] = role
            d["last_visited_at"] = _iso(last_visited_at)
            total, unread_ch = unread_agg.get(org.org_id, (0, 0))
            d["unread_count"] = total
            d["unread_channel_count"] = unread_ch
            out.append(d)
        return out

    @staticmethod
    def get_org_members(session: Session, org_id: str) -> list[dict]:
        rows = session.exec(
            select(OrgMember, HumanUser)
            .join(HumanUser, HumanUser.id == OrgMember.human_id)
            .where(OrgMember.org_id == org_id)
            .order_by(OrgMember.joined_at)
        ).all()
        return [
            {
                "human_id": m.human_id,
                "email": u.email,
                "display_name": u.display_name,
                "role": m.role,
                "joined_at": _iso(m.joined_at),
                "avatar": avatar_ref_for_user(
                    user_id=u.id, version=u.avatar_version, kind=u.avatar_kind
                ).model_dump(),
            }
            for (m, u) in rows
        ]

    @staticmethod
    def find_tagged_agents_in_channel(
        session: Session, channel_id: str, message: str
    ) -> list[str]:
        """Return ``agent_id``s of channel-member agents tagged via
        ``@<agent_id>`` in ``message``. Used to decide whether an inbound
        human post needs owner approval before the agent processes it.
        """
        if not message:
            return []
        tagged: list[str] = []
        members = TableRead.get_mm_channel_members(session, channel_id)
        for m in members:
            agent_id = m.get("agent_id")
            if agent_id and f"@{agent_id}" in message:
                tagged.append(agent_id)
        return tagged

    @staticmethod
    def _human_mention_match_regex(session: Session, human_id: int) -> str:
        """POSIX (case-insensitive) regex matching an ``@mention`` that
        targets this human: the channel-wide ``@here``, ``@user-<id>``, or
        any handle / display-name spelling the composer autocomplete would
        emit. Mirrors the frontend token normalisation in ``ChannelPage``'s
        ``myMentionTokens`` so the sidebar "mentioned" badge agrees with the
        in-channel ``@mention`` highlight.

        The trailing ``([^a-z0-9_.-]|$)`` is a token boundary using the same
        character class the renderer's ``TOKEN_RE`` uses to delimit a
        mention — it stops ``@here`` from matching inside ``@herring`` while
        still matching ``@here`` followed by a space, punctuation, newline,
        or end of message.
        """
        tokens: set[str] = {"here", f"user-{human_id}"}
        row = session.get(HumanUser, human_id)
        display = (row.display_name or "").strip() if row else ""
        if display:
            # Whitespace-stripped form ("Stan Lee" -> "stanlee").
            tokens.add(re.sub(r"\s+", "", display).lower())
            # Canonical handle the autocomplete inserts ("Stan Lee" ->
            # "stan-lee", keeping dots/hyphens already present).
            handle = re.sub(r"[^A-Za-z0-9_.-]", "", re.sub(r"\s+", "-", display)).lower()
            if handle:
                tokens.add(handle)
        alternation = "|".join(re.escape(t) for t in sorted(tokens) if t)
        return rf"@({alternation})([^a-z0-9_.-]|$)"

    @staticmethod
    def is_org_member(session: Session, org_id: str, human_id: int) -> bool:
        row = session.exec(
            select(OrgMember)
            .where(OrgMember.org_id == org_id)
            .where(OrgMember.human_id == human_id)
        ).first()
        return row is not None

    @staticmethod
    def get_org_member_role(session: Session, org_id: str, human_id: int) -> str | None:
        row = session.exec(
            select(OrgMember)
            .where(OrgMember.org_id == org_id)
            .where(OrgMember.human_id == human_id)
        ).first()
        return row.role if row else None

    # ---------------- mattermost ----------------

    @staticmethod
    def _channel_to_dict(c: MmChannel, session: Session | None = None) -> dict:
        # ``last_message_author_avatar`` is resolved on the fly from the
        # denormalised author-id columns. Skipped when no session is
        # available (caller didn't opt into the extra lookup) — the
        # client gracefully falls back to the initial-letter chip.
        author_avatar: dict | None = None
        if session is not None:
            author_avatar = TableRead._avatar_for_member(
                session,
                c.last_message_author_human_id,
                None,
                c.last_message_author_agent_id,
            )
        return {
            "channel_id": c.channel_id,
            "name": c.name,
            "display_name": c.display_name,
            "channel_type": c.channel_type,
            "created_at": _iso(c.created_at),
            "org_id": c.org_id,
            "created_by_agent": c.created_by_agent,
            "created_by_human": c.created_by_human,
            "last_message_text": c.last_message_text,
            "last_message_author_human_id": c.last_message_author_human_id,
            "last_message_author_agent_id": c.last_message_author_agent_id,
            "last_message_author_display_name": c.last_message_author_display_name,
            "last_message_author_avatar": author_avatar,
            "avatar": avatar_ref_for_channel(
                channel_id=c.channel_id, version=c.avatar_version
            ).model_dump(),
        }

    @staticmethod
    def get_mm_channel(session: Session, channel_id: str) -> dict | None:
        row = session.get(MmChannel, channel_id)
        return TableRead._channel_to_dict(row, session) if row else None

    @staticmethod
    def get_mm_channel_by_org_and_name(
        session: Session, org_id: str, name: str
    ) -> dict | None:
        row = session.exec(
            select(MmChannel)
            .where(MmChannel.org_id == org_id)
            .where(MmChannel.name == name)
        ).first()
        return TableRead._channel_to_dict(row, session) if row else None

    @staticmethod
    def get_mm_channels_for_agent(session: Session, agent_id: str) -> list[dict]:
        rows = session.exec(
            select(MmChannel)
            .join(MmChannelMember, MmChannelMember.channel_id == MmChannel.channel_id)
            .where(MmChannelMember.agent_id == agent_id)
            .order_by(MmChannel.created_at.desc())
        ).all()
        out = [TableRead._channel_to_dict(c, session) for c in rows]
        # Hide DMs the agent may no longer access — a human peer whose ``can_dm``
        # was revoked, or an agent peer whose grant was removed. Mirrors the
        # access gate in ``can_agent_access_dm`` so the bot isn't handed a
        # channel it would 403 on when it polls.
        return [
            d
            for d in out
            if d.get("channel_type") != "direct"
            or TableRead.can_agent_access_dm(session, d["channel_id"], agent_id)
        ]

    @staticmethod
    def get_mm_channel_members(session: Session, channel_id: str) -> list[dict]:
        # Outer-join HumanUser so human members come back with their
        # avatar version + kind. Agent members still need a per-row
        # ``session.get(Agent, ...)`` for the avatar metadata, which is
        # the same call ``resolve_agent_display`` already makes — the
        # SQLAlchemy session cache dedupes it to a single lookup per
        # agent id, so this isn't an extra round-trip.
        # Also outer-join ``HumanChannelState`` (keyed on the same
        # human_id + channel_id) so the read-receipt pointer comes back
        # in the same query — agents and never-opened human members
        # both land on NULL, which the response normalises away.
        rows = session.exec(
            select(MmChannelMember, HumanUser, HumanChannelState, Agent)
            .join(HumanUser, HumanUser.id == MmChannelMember.human_id, isouter=True)
            .join(
                HumanChannelState,
                (HumanChannelState.human_id == MmChannelMember.human_id)
                & (HumanChannelState.channel_id == MmChannelMember.channel_id),
                isouter=True,
            )
            # Outer-join Agent so agent members come back with last_alive_at in
            # the same query (NULL for human rows). The identity map dedupes
            # this against the avatar lookup below — no extra round-trip.
            .join(Agent, Agent.agent_id == MmChannelMember.agent_id, isouter=True)
            .where(MmChannelMember.channel_id == channel_id)
            .order_by(MmChannelMember.joined_at)
        ).all()
        return [
            {
                "agent_id": m.agent_id,
                "human_id": m.human_id,
                "joined_at": _iso(m.joined_at),
                "display_name": (
                    (u.display_name if u else None)
                    or (TableRead.resolve_agent_display(session, m.agent_id) if m.agent_id else None)
                ),
                # last_seen_at only exists for human members. Status is
                # filled in by the endpoint from Redis — kept off this
                # query so the read-path stays a single SQL hit. We
                # return the *raw* timestamp here so the endpoint can
                # decide whether to expose it or bucket it via
                # last_seen_label. ``privacy_mode_enabled`` is the
                # legacy single-toggle flag; ``*_visible`` /
                # ``*_enabled`` are the four per-signal toggles the
                # endpoint consults when applying the privacy view.
                "last_seen_at": _iso(u.last_seen_at) if u else None,
                "privacy_mode_enabled": u.privacy_mode_enabled if u else False,
                "last_seen_visible": u.last_seen_visible if u else True,
                "online_status_visible": u.online_status_visible if u else True,
                "read_receipts_enabled": u.read_receipts_enabled if u else True,
                "typing_indicators_enabled": (
                    u.typing_indicators_enabled if u else True
                ),
                "avatar": TableRead._avatar_for_member(session, m.human_id, u, m.agent_id),
                "last_read_post_id": s.last_read_post_id if s else None,
                # Global agent liveness — None for human rows (``a`` is the
                # outer-joined Agent, NULL for humans). Computed here so every
                # member-list call site gets it for free via
                # ``MmChannelMemberResponse(**m)``. ``last_alive_at`` is the raw
                # timestamp so the client can re-derive available->offline on a
                # timer without re-fetching.
                "agent_status": (
                    agent_liveness_status(a.last_alive_at) if a is not None else None
                ),
                "last_alive_at": _iso(a.last_alive_at) if a is not None else None,
            }
            for (m, u, s, a) in rows
        ]

    @staticmethod
    def _avatar_for_member(
        session: Session,
        human_id: int | None,
        human_row: HumanUser | None,
        agent_id: str | None,
    ) -> dict | None:
        """Build the avatar payload for a member or post-author row.

        Pass ``human_row`` when the caller already JOINed ``HumanUser``
        (member-list path) — it skips the extra ``session.get``. When
        ``human_id`` is set but ``human_row`` is None (post-create
        path, where no JOIN happened) we look up the row here so the
        avatar still resolves; SQLAlchemy's identity map dedupes the
        fetch if the row's already in the session.
        """
        if human_id is not None:
            row = human_row if human_row is not None else session.get(HumanUser, human_id)
            if row is None:
                return None
            return avatar_ref_for_user(
                user_id=human_id,
                version=row.avatar_version,
                kind=row.avatar_kind,
            ).model_dump()
        if agent_id is not None:
            agent = session.get(Agent, agent_id)
            if agent is None:
                return None
            return avatar_ref_for_agent(
                agent_id=agent_id,
                version=agent.avatar_version,
                kind=agent.avatar_kind,
            ).model_dump()
        return None

    @staticmethod
    def is_mm_channel_member(session: Session, channel_id: str, agent_id: str) -> bool:
        row = session.exec(
            select(MmChannelMember)
            .where(MmChannelMember.channel_id == channel_id)
            .where(MmChannelMember.agent_id == agent_id)
        ).first()
        return row is not None

    @staticmethod
    def is_mm_channel_member_human(
        session: Session, channel_id: str, human_id: int
    ) -> bool:
        row = session.exec(
            select(MmChannelMember)
            .where(MmChannelMember.channel_id == channel_id)
            .where(MmChannelMember.human_id == human_id)
        ).first()
        return row is not None

    # Inline-reply quote excerpts. Capped client-side rendering needs only
    # a short snippet; keeping the cap server-side bounds the SSE/REST
    # payload even when the parent is a 4000-char post.
    _PARENT_EXCERPT_LIMIT = 140

    @staticmethod
    def _mm_post_to_dict(session: Session, p: MmPost, u: HumanUser | None) -> dict:
        return {
            "post_id": p.post_id,
            "channel_id": p.channel_id,
            "agent_id": p.agent_id,
            "human_id": p.human_id,
            "message": p.message,
            "created_at": _iso(p.created_at),
            "poster_display_name": (
                (u.display_name if u else None)
                or (TableRead.resolve_agent_display(session, p.agent_id) if p.agent_id else None)
            ),
            "avatar": TableRead._avatar_for_member(session, p.human_id, u, p.agent_id),
            "status": p.status,
            "updated_at": _iso(p.updated_at),
            "edited_at": _iso(p.edited_at),
            "pinned_at": _iso(p.pinned_at),
            "pinned_by_human_id": p.pinned_by_human_id,
            "parent_post_id": p.parent_post_id,
            "parent_preview": TableRead.mm_post_parent_preview(session, p.parent_post_id),
            "link_preview": p.link_preview,
            # Persisted trace id — populated on reads (unlike client_msg_uuid)
            # so the agent poller can read it off the inbound post and
            # re-stamp it onto the reply. NULL on untraced/legacy rows.
            "trace_id": p.trace_id,
            "reactions": TableRead.get_mm_post_reactions(session, p.post_id),
            # Files are returned without presigned download URLs — the
            # endpoint layer enriches images with inline URLs after this
            # dict comes back. Same N+1 pattern as ``reactions``; bulk
            # fetch is a future optimization.
            "files": TableRead.get_mm_files_for_post_dicts(session, p.post_id),
            # Internal — see ``_mm_channel_event_to_dict`` for the
            # rationale. Stripped before MmPostResponse construction.
            "_raw_created_at": p.created_at,
        }

    @staticmethod
    def _resolve_identity(
        session: Session, human_id: int | None, agent_id: str | None
    ) -> tuple[str | None, dict | None]:
        """Return ``(display_name, avatar_dict)`` for an actor/subject pair.

        Both NULLs return ``(None, None)``. SQLAlchemy's identity map
        dedupes the lookups across a paged read so the per-row
        ``session.get`` is effectively free after the first row that
        references each user."""
        if human_id is not None:
            row = session.get(HumanUser, human_id)
            if row is None:
                return None, None
            return row.display_name, avatar_ref_for_user(
                user_id=human_id,
                version=row.avatar_version,
                kind=row.avatar_kind,
            ).model_dump()
        if agent_id is not None:
            agent = session.get(Agent, agent_id)
            if agent is None:
                return None, None
            return TableRead.resolve_agent_display(session, agent_id), avatar_ref_for_agent(
                agent_id=agent_id,
                version=agent.avatar_version,
                kind=agent.avatar_kind,
            ).model_dump()
        return None, None

    @staticmethod
    def _mm_channel_event_to_dict(session: Session, e: MmChannelEvent) -> dict:
        actor_name, actor_avatar = TableRead._resolve_identity(
            session, e.actor_human_id, e.actor_agent_id
        )
        subject_name, subject_avatar = TableRead._resolve_identity(
            session, e.subject_human_id, e.subject_agent_id
        )
        return {
            "event_id": e.event_id,
            "channel_id": e.channel_id,
            "event_type": e.event_type,
            "actor_human_id": e.actor_human_id,
            "actor_agent_id": e.actor_agent_id,
            "actor_display_name": actor_name,
            "actor_avatar": actor_avatar,
            "subject_human_id": e.subject_human_id,
            "subject_agent_id": e.subject_agent_id,
            "subject_display_name": subject_name,
            "subject_avatar": subject_avatar,
            "payload": e.payload,
            "created_at": _iso(e.created_at),
            # Internal — full-precision datetime kept around for the
            # timeline endpoint's cursor + sort key. Stripped before
            # building :class:`MmChannelEventResponse` (which ignores
            # unknown fields anyway, but explicit > implicit).
            "_raw_created_at": e.created_at,
        }

    @staticmethod
    def get_mm_channel_event_by_id(
        session: Session, event_id: int
    ) -> dict | None:
        row = session.get(MmChannelEvent, event_id)
        if row is None:
            return None
        return TableRead._mm_channel_event_to_dict(session, row)

    @staticmethod
    def get_mm_channel_events(
        session: Session,
        channel_id: str,
        limit: int = 50,
        before_created_at: datetime | None = None,
        before_event_id: int | None = None,
    ) -> list[dict]:
        """Page channel events newest-first.

        The composite cursor ``(before_created_at, before_event_id)``
        mirrors the ``(created_at, kind, id)`` shape used by the merged
        history endpoint — when ``before_created_at`` is supplied,
        rows are filtered to strictly precede that timestamp (or tied
        on it with a smaller ``event_id``) so paged reads can't drop
        or duplicate rows when several events share a second."""
        stmt = (
            select(MmChannelEvent)
            .where(MmChannelEvent.channel_id == channel_id)
        )
        if before_created_at is not None and before_event_id is not None:
            stmt = stmt.where(
                or_(
                    MmChannelEvent.created_at < before_created_at,
                    and_(
                        MmChannelEvent.created_at == before_created_at,
                        MmChannelEvent.event_id < before_event_id,
                    ),
                )
            )
        stmt = stmt.order_by(
            MmChannelEvent.created_at.desc(), MmChannelEvent.event_id.desc()
        ).limit(limit)
        rows = session.exec(stmt).all()
        return [TableRead._mm_channel_event_to_dict(session, e) for e in rows]

    @staticmethod
    def get_mm_files_for_post_dicts(session: Session, post_id: int) -> list[dict]:
        """Per-post file metadata as plain dicts (no presigned URLs).

        Output shape matches :class:`MmFileResponse` minus the URL fields,
        which are filled in by the endpoint layer with ``R2Presigner``.
        """
        rows = session.exec(
            select(MmFile)
            .where(MmFile.post_id == post_id)
            .where(MmFile.status == "uploaded")
            .order_by(MmFile.file_id)
        ).all()
        return [
            {
                "file_id": r.file_id,
                "channel_id": r.channel_id,
                "filename": r.filename,
                "content_type": r.content_type,
                "size_bytes": r.size_bytes,
                "status": r.status,
                "width": r.width,
                "height": r.height,
                "duration_ms": r.duration_ms,
                "created_at": _iso(r.created_at),
                "uploaded_at": _iso(r.uploaded_at),
                "download_url": None,
                "thumbnail_url": None,
                # Internal — used by the endpoint enricher to presign URLs
                # for images. Stripped before MmFileResponse construction.
                "_object_key": r.object_key,
                "_thumbnail_object_key": r.thumbnail_object_key,
            }
            for r in rows
        ]

    @staticmethod
    def get_mm_post_reactions(session: Session, post_id: int) -> list[dict]:
        """Aggregate reaction rows for a post into ``{emoji, count, human_ids,
        agent_ids}`` records, ordered by first-reacted-at so the strip reads
        chronologically. Emits an empty list when there are no reactions."""
        rows = session.exec(
            select(MmPostReaction)
            .where(MmPostReaction.post_id == post_id)
            .order_by(MmPostReaction.id)
        ).all()
        if not rows:
            return []
        # Preserve emoji insertion order so the strip renders in the order
        # reactions first appeared on the message (Slack-style).
        order: list[str] = []
        buckets: dict[str, dict] = {}
        for r in rows:
            if r.emoji not in buckets:
                order.append(r.emoji)
                buckets[r.emoji] = {
                    "emoji": r.emoji,
                    "count": 0,
                    "human_ids": [],
                    "agent_ids": [],
                }
            buckets[r.emoji]["count"] += 1
            if r.human_id is not None:
                buckets[r.emoji]["human_ids"].append(r.human_id)
            if r.agent_id is not None:
                buckets[r.emoji]["agent_ids"].append(r.agent_id)
        return [buckets[e] for e in order]

    @staticmethod
    def mm_post_parent_preview(
        session: Session, parent_post_id: int | None
    ) -> dict | None:
        if parent_post_id is None:
            return None
        parent = session.get(MmPost, parent_post_id)
        if parent is None:
            return None
        # Snapshot author display from the *current* row so renames stay
        # live in quote-blocks; status reflects the parent's current state
        # so the UI can render a "removed" pill when it was rejected.
        if parent.human_id is not None:
            human = session.get(HumanUser, parent.human_id)
            display = human.display_name if human else None
        else:
            display = (
                TableRead.resolve_agent_display(session, parent.agent_id)
                if parent.agent_id
                else None
            )
        excerpt = (parent.message or "").strip()
        if len(excerpt) > TableRead._PARENT_EXCERPT_LIMIT:
            excerpt = excerpt[: TableRead._PARENT_EXCERPT_LIMIT - 1].rstrip() + "…"
        # A post with files needs no text (see MmPostRequest's validator), so
        # the quote-block needs the count to label an attachment-only parent
        # instead of rendering it as blank. Count only — the file metadata
        # itself is never needed at quote size.
        attachment_count = int(
            session.exec(
                select(func.count(MmFile.file_id))
                .where(MmFile.post_id == parent.post_id)
                .where(MmFile.status == "uploaded")
            ).one()
        )
        return {
            "post_id": parent.post_id,
            "agent_id": parent.agent_id,
            "human_id": parent.human_id,
            "poster_display_name": display,
            "message_excerpt": excerpt,
            "status": parent.status,
            "attachment_count": attachment_count,
        }

    @staticmethod
    def _human_can_view_restricted_mm_post(
        session: Session, post: MmPost, human_id: int
    ) -> bool:
        """Visibility for draft/rejected posts.

        Agent-authored drafts are visible to that agent's approval authority.
        Human-authored drafts are visible both to their author (so the author
        can see the message is pending) and to an approval authority for at
        least one tagged target agent.
        """
        if post.human_id == human_id:
            return True
        if post.agent_id:
            return TableRead.is_agent_approval_authority(
                session, post.agent_id, human_id
            )
        for agent_id in TableRead.find_tagged_agents_in_channel(
            session, post.channel_id, post.message
        ):
            if TableRead.is_agent_approval_authority(session, agent_id, human_id):
                return True
        return False

    @staticmethod
    def get_mm_posts(
        session: Session,
        channel_id: str,
        limit: int = 50,
        offset: int = 0,
        before_post_id: int | None = None,
        include_drafts: bool = False,
    ) -> list[dict]:
        # Default visibility: streaming posts (live agent replies) and
        # published posts. Drafts (pending owner approval) and rejected
        # posts are hidden unless ``include_drafts`` is set.
        visible_statuses = (
            ("streaming", "draft", "published", "rejected")
            if include_drafts
            else ("streaming", "published")
        )
        stmt = (
            select(MmPost, HumanUser)
            .join(HumanUser, HumanUser.id == MmPost.human_id, isouter=True)
            .where(MmPost.channel_id == channel_id)
            .where(MmPost.status.in_(visible_statuses))
        )
        if before_post_id is not None:
            stmt = stmt.where(MmPost.post_id < before_post_id).order_by(
                MmPost.post_id.desc()
            ).limit(limit)
        else:
            stmt = stmt.order_by(MmPost.post_id.desc()).limit(limit).offset(offset)
        rows = session.exec(stmt).all()
        return [TableRead._mm_post_to_dict(session, p, u) for (p, u) in rows]

    @staticmethod
    def list_pinned_mm_posts(
        session: Session, channel_id: str
    ) -> list[dict]:
        """Return all pinned posts in a channel, newest-pinned first.

        Drives the pinned-messages popover. Rejected / draft / streaming
        posts are excluded — the popover should only ever show currently-
        visible content. Newest-pin-first matches Slack's pin pane order
        so collaborators see the freshly-pinned reminder at the top."""
        stmt = (
            select(MmPost, HumanUser)
            .join(HumanUser, HumanUser.id == MmPost.human_id, isouter=True)
            .where(MmPost.channel_id == channel_id)
            .where(MmPost.pinned_at.is_not(None))
            .where(MmPost.status == "published")
            .order_by(MmPost.pinned_at.desc())
        )
        rows = session.exec(stmt).all()
        return [TableRead._mm_post_to_dict(session, p, u) for (p, u) in rows]

    @staticmethod
    def get_mm_posts_for_human(
        session: Session,
        channel_id: str,
        human_id: int,
        limit: int = 50,
        offset: int = 0,
        before_post_id: int | None = None,
        before_created_at: datetime | None = None,
        after_post_id: int | None = None,
    ) -> list[dict]:
        """Get channel posts with per-post human draft visibility.

        ``before_post_id``, ``before_created_at`` and ``after_post_id`` are
        alternative cursor modes — ``before_post_id`` powers scroll-up
        (older) on the posts-only endpoint, ``before_created_at`` is used by
        the merged timeline endpoint where the cursor straddles posts +
        events and so has to be timestamp-based, and ``after_post_id`` powers
        scroll-down (newer) when the viewer is reading an *anchored* window of
        history rather than the live tail (jump-to-pinned / deep link). When
        none is set, offset pagination is used. Caller picks one."""
        # Fetch a bounded over-scan then filter. Draft/rejected posts are
        # rare, and this keeps owner/author visibility rules in one place.
        scan_limit = max(limit + offset, limit) * 3
        stmt = (
            select(MmPost, HumanUser)
            .join(HumanUser, HumanUser.id == MmPost.human_id, isouter=True)
            .where(MmPost.channel_id == channel_id)
            .where(MmPost.status.in_(("streaming", "draft", "published", "rejected")))
        )
        if after_post_id is not None:
            # Scroll-down: the posts immediately *newer* than the cursor. Scan
            # ascending so the over-scan picks the nearest newer rows (not the
            # live tail); the trimmed window is flipped back to newest-first at
            # the return to honour the endpoint's ordering contract.
            stmt = stmt.where(MmPost.post_id > after_post_id).order_by(
                MmPost.post_id.asc()
            ).limit(scan_limit)
        elif before_post_id is not None:
            stmt = stmt.where(MmPost.post_id < before_post_id).order_by(
                MmPost.post_id.desc()
            ).limit(scan_limit)
        elif before_created_at is not None:
            stmt = stmt.where(MmPost.created_at < before_created_at).order_by(
                MmPost.created_at.desc(), MmPost.post_id.desc()
            ).limit(scan_limit)
        else:
            stmt = stmt.order_by(MmPost.post_id.desc()).limit(scan_limit)
        visible = []
        for p, u in session.exec(stmt).all():
            if p.status in {"streaming", "published"} or TableRead._human_can_view_restricted_mm_post(
                session, p, human_id
            ):
                visible.append(TableRead._mm_post_to_dict(session, p, u))
        if after_post_id is not None:
            # Scanned ascending (nearest-newer first); flip to newest-first.
            return list(reversed(visible[:limit]))
        if before_post_id is not None or before_created_at is not None:
            return visible[:limit]
        return visible[offset:offset + limit]

    # ------------------------------------------------------------------
    # Message content search — see docs/protocol/SEARCH_SPEC.md
    # ------------------------------------------------------------------

    @staticmethod
    def _search_acl_filters(
        human_id: int, org_id: str | None, channel_id: str | None
    ) -> list:
        """Single source of truth for content-search visibility.

        The caller must be a member of the post's channel
        (``mm_channel_members``), only ``published`` posts are searchable,
        and the result is optionally scoped to one org and/or one channel.
        Encrypted-channel content is excluded *structurally* — it lives in
        ``mls_encrypted_posts``, never in ``mm_posts`` — so there is no flag
        to forget here. Both the primary and fallback queries apply these,
        so the rules can never drift between the two paths.

        Contact-gated DMs are excluded too: membership alone isn't enough for an
        agent DM. A revoked human keeps the lingering ``mm_channel_members`` row
        but must not be able to surface the DM's content via search, so a
        *direct* channel whose agent member the searcher can neither operate nor
        ``can_dm`` is filtered out — mirroring ``can_agent_access_dm``.
        """
        filters = [
            MmChannelMember.human_id == human_id,
            MmPost.status == "published",
        ]
        if org_id is not None:
            filters.append(MmChannel.org_id == org_id)
        if channel_id is not None:
            filters.append(MmPost.channel_id == channel_id)

        member = aliased(MmChannelMember)
        agent = aliased(Agent)
        has_dm_grant = (
            select(AgentContactPermission.id)
            .where(AgentContactPermission.agent_id == member.agent_id)
            .where(AgentContactPermission.human_id == human_id)
            .where(AgentContactPermission.can_dm.is_(True))
            .exists()
        )
        # An agent member of the post's channel the searcher can't access:
        # not its operator and without a ``can_dm`` grant.
        blocking_agent = (
            select(member.id)
            .join(agent, agent.agent_id == member.agent_id)
            .where(member.channel_id == MmPost.channel_id)
            .where(member.agent_id.is_not(None))
            .where(or_(agent.operator_id.is_(None), agent.operator_id != human_id))
            .where(~has_dm_grant)
            .exists()
        )
        filters.append(or_(MmChannel.channel_type != "direct", ~blocking_agent))
        return filters

    @staticmethod
    def _search_operator_filters(
        *,
        from_human_id: int | None = None,
        from_agent_id: str | None = None,
        before: datetime | None = None,
        after: datetime | None = None,
        has_link: bool = False,
        has_file: bool = False,
    ) -> list:
        """Operator filters (``from:`` / ``before:`` / ``after:`` / ``has:``)
        for content search. ``in:`` (channel scope) is handled by
        :meth:`_search_acl_filters` via ``channel_id``. Author/channel names
        are resolved to ids client-side before they reach here.
        """
        filters: list = []
        if from_human_id is not None:
            filters.append(MmPost.human_id == from_human_id)
        if from_agent_id is not None:
            filters.append(MmPost.agent_id == from_agent_id)
        if before is not None:
            filters.append(MmPost.created_at < before)
        if after is not None:
            filters.append(MmPost.created_at >= after)
        if has_link:
            # ``link_preview`` is JSONB and SQLAlchemy stores a Python ``None``
            # as the JSON value ``null`` (not SQL NULL), so ``IS NOT NULL``
            # would match empty rows. A real embedded preview is a JSON object,
            # so test the type — this excludes both JSON ``null`` and SQL NULL.
            filters.append(func.jsonb_typeof(MmPost.link_preview) == "object")
        if has_file:
            filters.append(
                select(MmFile.file_id)
                .where(MmFile.post_id == MmPost.post_id)
                .where(MmFile.status == "uploaded")
                .exists()
            )
        return filters

    @staticmethod
    def _plain_snippet(message: str, max_len: int = 160) -> str:
        """Whitespace-collapsed, length-capped excerpt for results that have
        no ``ts_headline`` highlight (the trigram fallback)."""
        text = " ".join((message or "").split())
        if len(text) <= max_len:
            return text
        return text[: max_len - 1].rstrip() + "…"

    @staticmethod
    def _mm_search_result_to_dict(
        session: Session,
        post: MmPost,
        user: HumanUser | None,
        channel: MmChannel,
        rank: float,
        snippet: str,
    ) -> dict:
        """Lightweight search-result row: enough to render the hit with
        channel context and jump to it, without the per-post reactions/files
        fan-out that ``_mm_post_to_dict`` does."""
        if post.human_id is not None:
            kind = "human"
            display = user.display_name if user else None
        else:
            kind = "agent"
            display = (
                TableRead.resolve_agent_display(session, post.agent_id)
                if post.agent_id
                else None
            )
        return {
            "post_id": post.post_id,
            "channel_id": post.channel_id,
            "channel_display_name": channel.display_name or channel.name,
            "channel_type": channel.channel_type,
            "created_at": _iso(post.created_at),
            "author": {
                "kind": kind,
                "human_id": post.human_id,
                "agent_id": post.agent_id,
                "display_name": display,
                "avatar": TableRead._avatar_for_member(
                    session, post.human_id, user, post.agent_id
                ),
            },
            "snippet": snippet,
            "rank": rank,
        }

    @staticmethod
    def search_mm_posts_for_human(
        session: Session,
        human_id: int,
        query: str,
        org_id: str | None = None,
        channel_id: str | None = None,
        sort: str = "recent",
        limit: int = 25,
        cursor: dict | None = None,
        *,
        from_human_id: int | None = None,
        from_agent_id: str | None = None,
        before: datetime | None = None,
        after: datetime | None = None,
        has_link: bool = False,
        has_file: bool = False,
    ) -> tuple[list[dict], dict | None]:
        """Full-text search over published posts the human can see.

        Returns ``(results, next_cursor)``. Visibility mirrors
        :meth:`get_mm_posts_for_human` / :meth:`get_mm_channels_for_human`
        via :meth:`_search_acl_filters`. Operator filters (``from:`` /
        ``before:`` / ``after:`` / ``has:``) narrow further; ``in:`` arrives
        as ``channel_id``.

        ``sort='recent'`` orders newest-first with a ``post_id`` keyset
        cursor (stable for infinite scroll); ``sort='relevant'`` orders by
        ``ts_rank_cd`` with offset paging. The cursor is an opaque dict the
        endpoint base64-encodes.

        A blank query is valid when operator filters are present — it becomes
        a filter-only listing (newest-first, plain snippets). When a fresh
        single-term query matches nothing, a ``pg_trgm`` fallback catches
        misspellings.
        """
        q = (query or "").strip()
        limit = max(1, min(limit, 50))
        op_filters = TableRead._search_operator_filters(
            from_human_id=from_human_id,
            from_agent_id=from_agent_id,
            before=before,
            after=after,
            has_link=has_link,
            has_file=has_file,
        )
        has_text = bool(q)
        # Nothing to search on — no query and no filters.
        if not has_text and not op_filters:
            return [], None

        acl = TableRead._search_acl_filters(human_id, org_id, channel_id)
        use_relevance = has_text and sort == "relevant"

        if has_text:
            tsq = func.websearch_to_tsquery("english", q)
            rank = func.ts_rank_cd(MmPost.message_tsv, tsq)
            snippet = func.ts_headline(
                "english",
                MmPost.message,
                tsq,
                "StartSel=<mark>, StopSel=</mark>, MaxFragments=2, MinWords=5, MaxWords=20",
            )
            stmt = select(
                MmPost, HumanUser, MmChannel, rank.label("rank"), snippet.label("snippet")
            )
        else:
            stmt = select(MmPost, HumanUser, MmChannel)

        stmt = (
            stmt.join(MmChannelMember, MmChannelMember.channel_id == MmPost.channel_id)
            .join(MmChannel, MmChannel.channel_id == MmPost.channel_id)
            .join(HumanUser, HumanUser.id == MmPost.human_id, isouter=True)
            .where(*acl, *op_filters)
        )
        if has_text:
            stmt = stmt.where(MmPost.message_tsv.op("@@")(tsq))

        base_offset = int(cursor.get("offset", 0)) if cursor else 0
        if use_relevance:
            stmt = (
                stmt.order_by(rank.desc(), MmPost.post_id.desc())
                .offset(base_offset)
                .limit(limit + 1)
            )
        else:  # recent / filter-only — newest-first, keyset on post_id
            if cursor and cursor.get("post_id") is not None:
                stmt = stmt.where(MmPost.post_id < int(cursor["post_id"]))
            stmt = stmt.order_by(MmPost.post_id.desc()).limit(limit + 1)

        rows = session.exec(stmt).all()
        has_more = len(rows) > limit
        rows = rows[:limit]
        if has_text:
            results = [
                TableRead._mm_search_result_to_dict(session, p, u, c, float(r or 0.0), s)
                for (p, u, c, r, s) in rows
            ]
        else:
            results = [
                TableRead._mm_search_result_to_dict(
                    session, p, u, c, 0.0, TableRead._plain_snippet(p.message)
                )
                for (p, u, c) in rows
            ]

        next_cursor: dict | None = None
        if has_more and results:
            if use_relevance:
                next_cursor = {"offset": base_offset + limit}
            else:
                next_cursor = {"post_id": rows[-1][0].post_id}

        # Typo fallback: only on a fresh (uncursored) single-term text query
        # that otherwise matched nothing — keeps it bounded and predictable.
        if has_text and not results and cursor is None and len(q.split()) == 1:
            results = TableRead._search_trigram_fallback(
                session, human_id, q, org_id, channel_id, limit, op_filters
            )

        return results, next_cursor

    @staticmethod
    def _search_trigram_fallback(
        session: Session,
        human_id: int,
        term: str,
        org_id: str | None,
        channel_id: str | None,
        limit: int,
        op_filters: list | None = None,
    ) -> list[dict]:
        """Misspelling-tolerant fallback over the trigram GIN index. Uses
        ``word_similarity`` (the ``%>`` operator) rather than whole-string
        ``similarity`` so a typo'd *word* still matches inside a longer
        message — ``similarity('kubernetes deployment', 'kubernates')`` is
        low, but ``word_similarity('kubernates', 'kubernetes deployment')``
        is high. No highlight (the term did not match exactly), so the
        snippet is a plain excerpt.

        ``message %> term`` is the commutator of ``term <% message`` — true
        when ``term`` word-matches some word in ``message`` above
        ``pg_trgm.word_similarity_threshold``. The default (0.6) is too
        strict for real misspellings, so we lower it for this transaction
        only — the ``%>`` operator still rides the trigram GIN index.
        """
        session.execute(text("SET LOCAL pg_trgm.word_similarity_threshold = 0.3"))
        sim = func.word_similarity(term, MmPost.message)
        filters = TableRead._search_acl_filters(human_id, org_id, channel_id)
        stmt = (
            select(MmPost, HumanUser, MmChannel, sim.label("rank"))
            .join(MmChannelMember, MmChannelMember.channel_id == MmPost.channel_id)
            .join(MmChannel, MmChannel.channel_id == MmPost.channel_id)
            .join(HumanUser, HumanUser.id == MmPost.human_id, isouter=True)
            .where(*filters, *(op_filters or []))
            .where(MmPost.message.op("%>")(term))
            .order_by(sim.desc(), MmPost.post_id.desc())
            .limit(limit)
        )
        return [
            TableRead._mm_search_result_to_dict(
                session, p, u, c, float(r or 0.0), TableRead._plain_snippet(p.message)
            )
            for (p, u, c, r) in session.exec(stmt).all()
        ]

    @staticmethod
    def get_mm_posts_around_for_human(
        session: Session,
        channel_id: str,
        human_id: int,
        around_post_id: int,
        radius: int = 25,
    ) -> list[dict]:
        """Window of posts surrounding ``around_post_id`` (inclusive) in a
        channel — up to ``radius`` older and ``radius`` newer — so a search
        result can be rendered in context and highlighted. Newest-first, to
        match :meth:`get_mm_posts_for_human`. Visibility uses the same
        draft/rejected rules as the history read path.
        """
        radius = max(1, min(radius, 50))
        statuses = ("streaming", "draft", "published", "rejected")
        scan = radius * 3  # over-scan so draft/rejected filtering still fills the window

        def _side(predicate, order):
            return session.exec(
                select(MmPost, HumanUser)
                .join(HumanUser, HumanUser.id == MmPost.human_id, isouter=True)
                .where(MmPost.channel_id == channel_id)
                .where(MmPost.status.in_(statuses))
                .where(predicate)
                .order_by(order)
                .limit(scan + 1)
            ).all()

        older = _side(MmPost.post_id <= around_post_id, MmPost.post_id.desc())
        newer = _side(MmPost.post_id > around_post_id, MmPost.post_id.asc())

        def _visible(p: MmPost) -> bool:
            return p.status in {"streaming", "published"} or (
                TableRead._human_can_view_restricted_mm_post(session, p, human_id)
            )

        older_v = [(p, u) for p, u in older if _visible(p)][: radius + 1]
        newer_v = [(p, u) for p, u in newer if _visible(p)][:radius]
        combined = older_v + newer_v
        combined.sort(key=lambda pu: pu[0].post_id, reverse=True)
        return [TableRead._mm_post_to_dict(session, p, u) for p, u in combined]

    @staticmethod
    def find_dm_channel(session: Session, agent_a: str, agent_b: str) -> dict | None:
        # Sub-queries to find channels where each agent is a member
        sub_a = (
            select(MmChannelMember.channel_id)
            .where(MmChannelMember.agent_id == agent_a)
            .subquery()
        )
        sub_b = (
            select(MmChannelMember.channel_id)
            .where(MmChannelMember.agent_id == agent_b)
            .subquery()
        )
        member_count = (
            select(MmChannelMember.channel_id, func.count().label("cnt"))
            .group_by(MmChannelMember.channel_id)
            .subquery()
        )
        row = session.exec(
            select(MmChannel)
            .where(MmChannel.channel_type == "direct")
            .where(MmChannel.channel_id.in_(select(sub_a.c.channel_id)))
            .where(MmChannel.channel_id.in_(select(sub_b.c.channel_id)))
            .where(
                MmChannel.channel_id.in_(
                    select(member_count.c.channel_id).where(member_count.c.cnt == 2)
                )
            )
        ).first()
        return TableRead._channel_to_dict(row, session) if row else None

    @staticmethod
    def _unread_window(human_id: int, *, mention_regex: str | None = None):
        """Correlated SELECT over the viewer's unread posts in the outer
        ``MmChannel``, capped at :data:`UNREAD_COUNT_CAP` rows.

        "Unread" is: published, newer than this human's read pointer, and not
        authored by them (your own messages are never homework). The ``human_id
        IS NULL`` arm is load-bearing — agent posts carry a NULL ``human_id``
        and ``NULL != n`` is NULL, not true, so they would drop out of the
        count without it.

        Pass ``mention_regex`` for the subset that addresses this viewer.

        The LIMIT is the point. The UI renders anything past 99 as "99+", so
        counting an unbounded backlog is work nobody can see — and it is worst
        exactly where it hurts most, on the first load of a busy channel the
        user has never opened (no read pointer, so every post counts).
        """
        stmt = (
            select(literal(1))
            .where(MmPost.channel_id == MmChannel.channel_id)
            .where(MmPost.status == "published")
            .where(
                MmPost.post_id
                > func.coalesce(HumanChannelState.last_read_post_id, 0)
            )
            .where((MmPost.human_id != human_id) | (MmPost.human_id.is_(None)))
        )
        if mention_regex is not None:
            stmt = stmt.where(MmPost.message.op("~*")(mention_regex))
        return (
            stmt.limit(UNREAD_COUNT_CAP)
            .correlate(MmChannel, HumanChannelState)
            .subquery()
        )

    @staticmethod
    def get_mm_channels_for_human(
        session: Session,
        human_id: int,
        org_id: str | None = None,
    ) -> list[dict]:
        # THE sidebar query. Everything the chat list shows for every
        # conversation the viewer is in, in one round-trip. It runs on every
        # app boot, on every SSE reconnect, and on a 30s poll, so its shape
        # matters more than almost anything else in the read path — see
        # migration ``c4e1b9a7f2d5`` for what it cost when it was wrong.
        #
        # Latest published post, as a LATERAL rather than an aggregate. The
        # obvious ``GROUP BY channel_id`` over ``mm_posts`` has to touch every
        # post in the deployment to answer for sixty channels — a cost that
        # grows with total volume and is identical for every user in the org.
        # A per-channel ``ORDER BY post_id DESC LIMIT 1`` rides
        # ``ix_mm_posts_channel_post`` and touches one row per channel instead.
        #
        # Ordering by ``post_id`` (not ``created_at``) also fixes a latent
        # correctness wrinkle: the aggregate took ``max(created_at)`` and
        # ``max(post_id)`` independently, so two posts written in the same
        # instant could hand back a timestamp from one row and an id from
        # another. ``post_id`` is a serial, so newest id IS newest post, and
        # both values now come from the same row.
        latest_post = (
            select(
                MmPost.post_id.label("post_id"),
                MmPost.created_at.label("created_at"),
            )
            .where(MmPost.channel_id == MmChannel.channel_id)
            .where(MmPost.status == "published")
            .order_by(MmPost.post_id.desc())
            .limit(1)
            .correlate(MmChannel)
            .lateral("latest_post")
        )
        unread_count_sq = (
            select(func.count())
            .select_from(TableRead._unread_window(human_id))
            .scalar_subquery()
        )
        # The subset of unread posts that address this viewer — directly
        # (``@<their handle>``) or channel-wide (``@here``). Drives the
        # sidebar's accent "mentioned" badge, which pierces mute. Same unread
        # predicate as above plus a regex match on the body (see
        # ``_human_mention_match_regex``); the regex rides the trigram index
        # from the search migration.
        mention_regex = TableRead._human_mention_match_regex(session, human_id)
        unread_mention_count_sq = (
            select(func.count())
            .select_from(
                TableRead._unread_window(human_id, mention_regex=mention_regex)
            )
            .scalar_subquery()
        )
        stmt = (
            select(
                MmChannel,
                latest_post.c.created_at.label("last_message_at"),
                latest_post.c.post_id.label("latest_post_id"),
                HumanChannelState.last_read_post_id,
                HumanChannelState.muted_at,
                HumanChannelState.pinned_at,
                unread_count_sq.label("unread_count"),
                unread_mention_count_sq.label("unread_mention_count"),
            )
            .join(MmChannelMember, MmChannelMember.channel_id == MmChannel.channel_id)
            .join(
                HumanChannelState,
                (HumanChannelState.channel_id == MmChannel.channel_id)
                & (HumanChannelState.human_id == human_id),
                isouter=True,
            )
            .join(latest_post, true(), isouter=True)
            .where(MmChannelMember.human_id == human_id)
        )
        if org_id is not None:
            stmt = stmt.where(MmChannel.org_id == org_id)
        rows = session.exec(
            stmt.order_by(
                func.coalesce(latest_post.c.created_at, MmChannel.created_at).desc()
            )
        ).all()

        # One follow-up query to count uploaded files per latest post —
        # bounded by the number of channels the user is in (typically tens),
        # so a single grouped SELECT beats embedding a correlated scalar
        # subquery against the ``latest_post`` aliased subquery here.
        latest_post_ids = [
            int(row[2]) for row in rows if row[2] is not None
        ]
        attachment_counts: dict[int, int] = {}
        if latest_post_ids:
            count_rows = session.exec(
                select(MmFile.post_id, func.count(MmFile.file_id))
                .where(MmFile.post_id.in_(latest_post_ids))
                .where(MmFile.status == "uploaded")
                .group_by(MmFile.post_id)
            ).all()
            for post_id, count in count_rows:
                if post_id is not None:
                    attachment_counts[int(post_id)] = int(count or 0)

        out = []
        for (
            c, last_message_at, latest_post_id, last_read_post_id,
            muted_at, pinned_at, unread_count, unread_mention_count,
        ) in rows:
            d = TableRead._channel_to_dict(c, session)
            d["last_message_at"] = _iso(last_message_at)
            d["latest_post_id"] = int(latest_post_id) if latest_post_id is not None else None
            d["last_read_post_id"] = int(last_read_post_id) if last_read_post_id is not None else None
            d["muted"] = muted_at is not None
            d["pinned"] = pinned_at is not None
            d["unread_count"] = int(unread_count or 0)
            d["unread_mention_count"] = int(unread_mention_count or 0)
            d["last_message_attachment_count"] = (
                attachment_counts.get(int(latest_post_id), 0)
                if latest_post_id is not None
                else 0
            )
            out.append(d)

        TableRead.apply_dm_peer_display(session, out, human_id)
        # Drop agent DMs this human may no longer contact. Contact is closed by
        # default (see ``AgentContactPermission``): the operator and explicitly
        # granted humans keep their DMs; everyone else's agent DMs fall out of
        # the sidebar to match the API access gate in ``_require_human_member``.
        # ``apply_dm_peer_display`` already resolved ``dm_peer_agent_id`` above.
        out = [
            d
            for d in out
            if not (
                d.get("dm_peer_agent_id")
                and not TableRead.can_dm_agent(
                    session, d["dm_peer_agent_id"], human_id=human_id
                )
            )
        ]
        return out

    @staticmethod
    def apply_dm_peer_display(
        session: Session, channels: list[dict], viewer_human_id: int
    ) -> None:
        """Override ``display_name`` on each direct channel in-place so the
        title reads as the OTHER participant from the viewer's perspective.

        The stored ``display_name`` is ``"DM: <a> ↔ <b>"`` with stable ordering,
        which would otherwise show both viewers the same string. Resolves human
        peers via :meth:`resolve_human_display` and agent peers via
        :meth:`resolve_agent_display`. Batched: one members query plus one
        humans query for the whole list."""
        direct_ids = [d["channel_id"] for d in channels if d.get("channel_type") == "direct"]
        if not direct_ids:
            return
        member_rows = session.exec(
            select(
                MmChannelMember.channel_id,
                MmChannelMember.human_id,
                MmChannelMember.agent_id,
            ).where(MmChannelMember.channel_id.in_(direct_ids))
        ).all()
        peer_by_channel: dict[str, tuple[str, int | str]] = {}
        other_human_ids: set[int] = set()
        other_agent_ids: set[str] = set()
        for cid, hid, aid in member_rows:
            if hid is not None and hid == viewer_human_id:
                continue
            if hid is not None:
                peer_by_channel[cid] = ("human", hid)
                other_human_ids.add(hid)
            elif aid is not None:
                peer_by_channel[cid] = ("agent", aid)
                other_agent_ids.add(aid)
        human_names: dict[int, str] = {}
        if other_human_ids:
            for hid, dn, em in session.exec(
                select(HumanUser.id, HumanUser.display_name, HumanUser.email)
                .where(HumanUser.id.in_(other_human_ids))
            ).all():
                human_names[hid] = dn or em
        agent_names: dict[str, str] = {
            aid: TableRead.resolve_agent_display(session, aid)
            for aid in other_agent_ids
        }
        for d in channels:
            if d.get("channel_type") != "direct":
                continue
            peer = peer_by_channel.get(d["channel_id"])
            if peer is None:
                continue
            kind, peer_id = peer
            name = human_names.get(peer_id) if kind == "human" else agent_names.get(peer_id)
            if name:
                d["display_name"] = name
            # Surface the peer id so the sidebar can look up presence
            # (humans) and the command palette can dedupe a DM against its
            # People/Agents entry — both without refetching members per row.
            if kind == "human":
                d["dm_peer_human_id"] = peer_id
            else:
                d["dm_peer_agent_id"] = peer_id

    @staticmethod
    def get_discoverable_mm_channels(
        session: Session, org_id: str, human_id: int
    ) -> list[dict]:
        """Public channels in ``org_id`` that ``human_id`` has not yet joined.

        Returns each channel with a ``member_count`` so the UI can show how
        active each one is. Private and direct channels are excluded.
        """
        # Channels the user is already in (so we can exclude them).
        member_of = (
            select(MmChannelMember.channel_id)
            .where(MmChannelMember.human_id == human_id)
            .subquery()
        )
        # Total member count per channel for the public-ones-they-don't-have.
        member_count_sq = (
            select(func.count(MmChannelMember.channel_id))
            .where(MmChannelMember.channel_id == MmChannel.channel_id)
            .correlate(MmChannel)
            .scalar_subquery()
        )
        rows = session.exec(
            select(MmChannel, member_count_sq.label("member_count"))
            .where(MmChannel.org_id == org_id)
            .where(MmChannel.channel_type == "public")
            .where(~MmChannel.channel_id.in_(select(member_of.c.channel_id)))
            .order_by(MmChannel.created_at.desc())
        ).all()
        out = []
        for c, member_count in rows:
            d = TableRead._channel_to_dict(c, session)
            d["member_count"] = int(member_count or 0)
            out.append(d)
        return out

    @staticmethod
    def list_all_mm_channels_in_org(
        session: Session, org_id: str, viewer_human_id: int
    ) -> list[dict]:
        """Admin view: every public + private channel in ``org_id``.

        Direct channels are excluded - DMs are person-to-person and owners
        shouldn't see/moderate them. Each row carries ``member_count`` and
        ``last_message_at`` for the channel-management list.

        Privacy: an owner may enumerate private channels (how many exist,
        their size/activity), but must not learn the identity or content of
        ones they don't belong to. For any private channel
        ``viewer_human_id`` is not a member of, the name is replaced with a
        stable opaque id (a short hash of the channel_id - distinguishable
        for moderation but revealing nothing), the display name and avatar
        are dropped, and the message content (``last_message_*`` preview +
        author) is hidden. Only non-identifying metadata survives - member
        count, last-activity timestamp, channel type. Public
        channels are readable by any org member, so they're left intact.
        (Content redaction mirrors Slack, where admin access doesn't grant
        message access; hiding name/avatar is stricter than Slack's admin
        dashboard, which does surface private-channel names.)
        """
        member_count_sq = (
            select(func.count(MmChannelMember.channel_id))
            .where(MmChannelMember.channel_id == MmChannel.channel_id)
            .correlate(MmChannel)
            .scalar_subquery()
        )
        last_message_at_sq = (
            select(func.max(MmPost.created_at))
            .where(MmPost.channel_id == MmChannel.channel_id)
            .where(MmPost.status == "published")
            .correlate(MmChannel)
            .scalar_subquery()
        )
        rows = session.exec(
            select(
                MmChannel,
                member_count_sq.label("member_count"),
                last_message_at_sq.label("last_message_at"),
            )
            .where(MmChannel.org_id == org_id)
            .where(MmChannel.channel_type.in_(("public", "private")))
            .order_by(
                func.coalesce(last_message_at_sq, MmChannel.created_at).desc()
            )
        ).all()
        # Channels the viewer actually belongs to - gates the message-content
        # preview below. ``channel_id`` is globally unique, so not scoping
        # this to ``org_id`` is harmless and avoids a join.
        viewer_member_ids = set(
            session.exec(
                select(MmChannelMember.channel_id)
                .where(MmChannelMember.human_id == viewer_human_id)
            ).all()
        )
        out = []
        for c, member_count, last_message_at in rows:
            d = TableRead._channel_to_dict(c, session)
            d["member_count"] = int(member_count or 0)
            d["last_message_at"] = _iso(last_message_at)
            # Allowlist state for the Settings → LobsterTalk approval UI.
            # Set here, not in _channel_to_dict — the flag is org governance,
            # scoped to this owner-only listing rather than every channel
            # payload. Always false on private rows (the PUT refuses them).
            d["lobstertalk_approved"] = bool(c.lobstertalk_approved)
            # Redact private channels the viewer isn't in: hide identity
            # (name, display name, avatar) AND content (preview + author).
            # Only non-identifying metadata stays - member count,
            # last_message_at timestamp, channel type.
            if (
                c.channel_type != "public"
                and c.channel_id not in viewer_member_ids
            ):
                # Stable opaque label - lets the owner tell private
                # channels apart (and target one for deletion) without
                # learning the name. Deterministic hash of the random-UUID
                # channel_id: stable across calls, reveals nothing.
                opaque = hashlib.sha256(c.channel_id.encode()).hexdigest()[:6]
                d["name"] = f"Private channel {opaque}"
                d["display_name"] = None
                d["avatar"] = None
                d["last_message_text"] = None
                d["last_message_author_human_id"] = None
                d["last_message_author_agent_id"] = None
                d["last_message_author_display_name"] = None
                d["last_message_author_avatar"] = None
            out.append(d)
        return out

    @staticmethod
    def get_mm_channel_latest_published_post_id(
        session: Session, channel_id: str
    ) -> int | None:
        """Return the highest published post_id in a channel, or None if empty."""
        return session.exec(
            select(func.max(MmPost.post_id))
            .where(MmPost.channel_id == channel_id)
            .where(MmPost.status == "published")
        ).first()

    @staticmethod
    def get_mm_channel_ids_for_human(
        session: Session, human_id: int
    ) -> list[str]:
        """Return every channel_id where ``human_id`` is a member.

        Used to fan out global presence updates to channel topics so any
        viewer currently looking at one of those channels sees the dot
        change without re-fetching the member list."""
        return list(session.exec(
            select(MmChannelMember.channel_id)
            .where(MmChannelMember.human_id == human_id)
        ).all())

    @staticmethod
    def get_fellow_human_ids(
        session: Session, human_id: int
    ) -> list[int]:
        """Return every other ``human_id`` who shares at least one
        channel with ``human_id``.

        Used by the global-presence fan-out so a viewer sitting on the
        home page (subscribed only to their own per-user topic) still
        sees a peer's dot flip in real time — the peer's `user.status`
        event is published to each fellow's per-user topic in addition
        to the shared channels' topics."""
        shared = (
            select(MmChannelMember.channel_id)
            .where(MmChannelMember.human_id == human_id)
            .subquery()
        )
        rows = session.exec(
            select(MmChannelMember.human_id)
            .where(MmChannelMember.channel_id.in_(select(shared.c.channel_id)))
            .where(MmChannelMember.human_id.is_not(None))
            .where(MmChannelMember.human_id != human_id)
            .distinct()
        ).all()
        return [hid for hid in rows if hid is not None]

    @staticmethod
    def get_mm_channel_human_member_ids(
        session: Session, channel_id: str
    ) -> list[int]:
        """Return human_ids of all human members of a channel (for fan-out)."""
        return [
            hid
            for hid in session.exec(
                select(MmChannelMember.human_id)
                .where(MmChannelMember.channel_id == channel_id)
                .where(MmChannelMember.human_id.is_not(None))
            ).all()
            if hid is not None
        ]

    @staticmethod
    def get_mm_channel_ids_for_agent(
        session: Session, agent_id: str
    ) -> list[str]:
        """Return every channel_id where ``agent_id`` is a member.

        The agent analogue of :meth:`get_mm_channel_ids_for_human` — used to fan
        an agent's liveness change out to channel topics so any viewer looking
        at one of those member lists sees the dot flip without re-fetching."""
        return list(session.exec(
            select(MmChannelMember.channel_id)
            .where(MmChannelMember.agent_id == agent_id)
        ).all())

    @staticmethod
    def get_human_ids_sharing_channel_with_agent(
        session: Session, agent_id: str
    ) -> list[int]:
        """Return every human_id who shares at least one channel with
        ``agent_id``.

        The agent analogue of :meth:`get_fellow_human_ids` — so a human sitting
        on the home page (subscribed only to their own per-user topic) still
        sees the agent's dot flip on their sidebar / DM row when it comes
        online, without having the channel open."""
        shared = (
            select(MmChannelMember.channel_id)
            .where(MmChannelMember.agent_id == agent_id)
            .subquery()
        )
        rows = session.exec(
            select(MmChannelMember.human_id)
            .where(MmChannelMember.channel_id.in_(select(shared.c.channel_id)))
            .where(MmChannelMember.human_id.is_not(None))
            .distinct()
        ).all()
        return [hid for hid in rows if hid is not None]

    # ---------------- push notifications ----------------

    @staticmethod
    def get_webpush_devices_for_humans(
        session: Session, human_ids: list[int]
    ) -> list[dict]:
        """Enabled web-push subscriptions for the given humans.

        Returns exactly what the dispatcher needs to POST a push — the
        endpoint + encryption keys — plus the row ``id`` so a dead endpoint
        can be pruned. Empty list when there are no targets."""
        if not human_ids:
            return []
        rows = session.exec(
            select(PushDevice)
            .where(PushDevice.human_id.in_(human_ids))
            .where(PushDevice.transport == "webpush")
            .where(PushDevice.enabled.is_(True))
        ).all()
        return [
            {
                "id": r.id,
                "human_id": r.human_id,
                "token": r.token,
                "p256dh": r.p256dh,
                "auth": r.auth,
            }
            for r in rows
        ]

    @staticmethod
    def get_muted_human_ids(
        session: Session, channel_id: str, human_ids: list[int]
    ) -> set[int]:
        """Subset of ``human_ids`` who have muted ``channel_id``.

        Used to skip push for members who muted the channel — they still
        get the in-app unread badge over SSE, just no notification."""
        if not human_ids:
            return set()
        rows = session.exec(
            select(HumanChannelState.human_id)
            .where(HumanChannelState.channel_id == channel_id)
            .where(HumanChannelState.human_id.in_(human_ids))
            .where(HumanChannelState.muted_at.is_not(None))
        ).all()
        return {hid for hid in rows if hid is not None}

    @staticmethod
    def get_channel_notification_meta(
        session: Session, channel_id: str
    ) -> dict | None:
        """Minimal channel info for composing a push notification title."""
        row = session.get(MmChannel, channel_id)
        if row is None:
            return None
        return {
            "channel_id": row.channel_id,
            "name": row.name,
            "display_name": row.display_name,
            "channel_type": row.channel_type,
        }

    @staticmethod
    def find_dm_channel_human_agent(
        session: Session, human_id: int, agent_id: str, org_id: str
    ) -> dict | None:
        sub_h = (
            select(MmChannelMember.channel_id)
            .where(MmChannelMember.human_id == human_id)
            .subquery()
        )
        sub_a = (
            select(MmChannelMember.channel_id)
            .where(MmChannelMember.agent_id == agent_id)
            .subquery()
        )
        member_count = (
            select(MmChannelMember.channel_id, func.count().label("cnt"))
            .group_by(MmChannelMember.channel_id)
            .subquery()
        )
        row = session.exec(
            select(MmChannel)
            .where(MmChannel.channel_type == "direct")
            .where(MmChannel.org_id == org_id)
            .where(MmChannel.channel_id.in_(select(sub_h.c.channel_id)))
            .where(MmChannel.channel_id.in_(select(sub_a.c.channel_id)))
            .where(
                MmChannel.channel_id.in_(
                    select(member_count.c.channel_id).where(member_count.c.cnt == 2)
                )
            )
        ).first()
        return TableRead._channel_to_dict(row, session) if row else None

    @staticmethod
    def find_dm_channel_human_human(
        session: Session, human_a: int, human_b: int, org_id: str
    ) -> dict | None:
        sub_a = (
            select(MmChannelMember.channel_id)
            .where(MmChannelMember.human_id == human_a)
            .subquery()
        )
        sub_b = (
            select(MmChannelMember.channel_id)
            .where(MmChannelMember.human_id == human_b)
            .subquery()
        )
        member_count = (
            select(MmChannelMember.channel_id, func.count().label("cnt"))
            .group_by(MmChannelMember.channel_id)
            .subquery()
        )
        row = session.exec(
            select(MmChannel)
            .where(MmChannel.channel_type == "direct")
            .where(MmChannel.org_id == org_id)
            .where(MmChannel.channel_id.in_(select(sub_a.c.channel_id)))
            .where(MmChannel.channel_id.in_(select(sub_b.c.channel_id)))
            .where(
                MmChannel.channel_id.in_(
                    select(member_count.c.channel_id).where(member_count.c.cnt == 2)
                )
            )
        ).first()
        return TableRead._channel_to_dict(row, session) if row else None

    # ---------------- agent actions ----------------

    @staticmethod
    def get_agent_action(
        session: Session, agent_id: str, action_id: str
    ) -> dict | None:
        row = session.get(AgentAction, (agent_id, action_id))
        if row is None:
            return None
        return {
            "agent_id": row.agent_id,
            "action_id": row.action_id,
            "action_md": row.action_md,
            "updated_at": _iso(row.updated_at),
        }

    @staticmethod
    def get_agent_actions(
        session: Session, agent_id: str, limit: int = 100, offset: int = 0
    ) -> list[dict]:
        rows = session.exec(
            select(AgentAction)
            .where(AgentAction.agent_id == agent_id)
            .order_by(AgentAction.updated_at.desc())
            .limit(limit)
            .offset(offset)
        ).all()
        return [
            {
                "agent_id": r.agent_id,
                "action_id": r.action_id,
                "updated_at": _iso(r.updated_at),
            }
            for r in rows
        ]

    @staticmethod
    def count_agent_actions_for_agent(session: Session, agent_id: str) -> int:
        count = session.exec(
            select(func.count())
            .select_from(AgentAction)
            .where(AgentAction.agent_id == agent_id)
        ).one()
        return int(count or 0)

    @staticmethod
    def list_agent_actions(
        session: Session, limit: int = 100, offset: int = 0
    ) -> list[dict]:
        rows = session.exec(
            select(AgentAction)
            .order_by(AgentAction.updated_at.desc())
            .limit(limit)
            .offset(offset)
        ).all()
        return [
            {
                "agent_id": r.agent_id,
                "action_id": r.action_id,
                "updated_at": _iso(r.updated_at),
            }
            for r in rows
        ]

    @staticmethod
    def count_agent_actions(session: Session) -> int:
        count = session.exec(select(func.count()).select_from(AgentAction)).one()
        return int(count or 0)

    @staticmethod
    def get_agents_owned_by_org(session: Session, org_id: str) -> list[str]:
        from clawbits.db.table_write import DELETED_AGENT_ID

        # Belt-and-suspenders with the ``org_id=None`` placeholder invariant:
        # never enumerate the shared "Deleted agent" in any org's agent list.
        rows = session.exec(
            select(Agent)
            .where(Agent.org_id == org_id)
            .where(Agent.agent_id != DELETED_AGENT_ID)
            .order_by(Agent.creation_time)
        ).all()
        return [r.agent_id for r in rows]

    # ---------------- agent AI-usage (self-reported telemetry) ----------------

    @staticmethod
    def usage_range_start(range_key: str) -> date | None:
        """First UTC calendar day of a trailing usage window; ``None`` = all.

        Buckets in ``agent_usage_daily`` are UTC days, so "day" is *today in
        UTC*, "week"/"month" are trailing 7/30-day windows inclusive of today.
        """
        today = datetime.now(UTC).date()
        if range_key == "day":
            return today
        if range_key == "week":
            return today - timedelta(days=6)
        if range_key == "month":
            return today - timedelta(days=29)
        return None

    @staticmethod
    def _usage_rows(session: Session, where_clauses) -> list[dict]:
        """SUM the daily rollup grouped by (agent, model, provider).

        ``SUM(cost_usd)`` skips NULLs and returns NULL only when every bucket
        is NULL — exactly the "no cost data" passthrough semantics we want.
        """
        q = (
            select(
                AgentUsageDaily.agent_id,
                AgentUsageDaily.model,
                AgentUsageDaily.provider,
                func.sum(AgentUsageDaily.input_tokens).label("input_tokens"),
                func.sum(AgentUsageDaily.output_tokens).label("output_tokens"),
                func.sum(AgentUsageDaily.cache_read_tokens).label(
                    "cache_read_tokens"
                ),
                func.sum(AgentUsageDaily.cache_write_tokens).label(
                    "cache_write_tokens"
                ),
                func.sum(AgentUsageDaily.cost_usd).label("cost_usd"),
                func.sum(AgentUsageDaily.call_count).label("call_count"),
            )
            .group_by(
                AgentUsageDaily.agent_id,
                AgentUsageDaily.model,
                AgentUsageDaily.provider,
            )
        )
        for clause in where_clauses:
            q = q.where(clause)
        return [
            {
                "agent_id": r.agent_id,
                "model": r.model,
                "provider": r.provider,
                "input_tokens": int(r.input_tokens or 0),
                "output_tokens": int(r.output_tokens or 0),
                "cache_read_tokens": int(r.cache_read_tokens or 0),
                "cache_write_tokens": int(r.cache_write_tokens or 0),
                "cost_usd": float(r.cost_usd) if r.cost_usd is not None else None,
                "call_count": int(r.call_count or 0),
            }
            for r in session.execute(q).all()
        ]

    @staticmethod
    def get_org_usage_rows(
        session: Session, org_id: str, since: date | None
    ) -> list[dict]:
        """Per-(agent, model, provider) usage sums for an org's window."""
        from clawbits.db.table_write import DELETED_AGENT_ID

        clauses = [
            AgentUsageDaily.org_id == org_id,
            AgentUsageDaily.agent_id != DELETED_AGENT_ID,
        ]
        if since is not None:
            clauses.append(AgentUsageDaily.usage_date >= since)
        return TableRead._usage_rows(session, clauses)

    @staticmethod
    def get_agent_usage_rows(
        session: Session, agent_id: str, since: date | None
    ) -> list[dict]:
        """Per-(model, provider) usage sums for one agent's window."""
        clauses = [AgentUsageDaily.agent_id == agent_id]
        if since is not None:
            clauses.append(AgentUsageDaily.usage_date >= since)
        return TableRead._usage_rows(session, clauses)

    @staticmethod
    def get_org_usage_daily_rows(
        session: Session, org_id: str, since: date | None
    ) -> list[dict]:
        """Per-(day, agent) usage sums for the dashboard's trend chart and
        sparklines. Flat rows, oldest day first; the endpoint decides how much
        of the agent dimension the caller's role may see."""
        from clawbits.db.table_write import DELETED_AGENT_ID

        q = (
            select(
                AgentUsageDaily.usage_date,
                AgentUsageDaily.agent_id,
                func.sum(AgentUsageDaily.input_tokens).label("input_tokens"),
                func.sum(AgentUsageDaily.output_tokens).label("output_tokens"),
                func.sum(AgentUsageDaily.cache_read_tokens).label(
                    "cache_read_tokens"
                ),
                func.sum(AgentUsageDaily.cache_write_tokens).label(
                    "cache_write_tokens"
                ),
                func.sum(AgentUsageDaily.cost_usd).label("cost_usd"),
                func.sum(AgentUsageDaily.call_count).label("call_count"),
            )
            .where(AgentUsageDaily.org_id == org_id)
            .where(AgentUsageDaily.agent_id != DELETED_AGENT_ID)
            .group_by(AgentUsageDaily.usage_date, AgentUsageDaily.agent_id)
            .order_by(AgentUsageDaily.usage_date)
        )
        if since is not None:
            q = q.where(AgentUsageDaily.usage_date >= since)
        return [
            {
                "date": r.usage_date.isoformat(),
                "agent_id": r.agent_id,
                "input_tokens": int(r.input_tokens or 0),
                "output_tokens": int(r.output_tokens or 0),
                "cache_read_tokens": int(r.cache_read_tokens or 0),
                "cache_write_tokens": int(r.cache_write_tokens or 0),
                "cost_usd": float(r.cost_usd) if r.cost_usd is not None else None,
                "call_count": int(r.call_count or 0),
            }
            for r in session.execute(q).all()
        ]

    @staticmethod
    def get_reporting_agent_ids(session: Session, org_id: str) -> set[str]:
        """Agents with *any* usage ever reported (all-time, not the window) —
        drives the honest "not reporting yet" state on the roster join."""
        rows = session.exec(
            select(AgentUsageDaily.agent_id)
            .where(AgentUsageDaily.org_id == org_id)
            .distinct()
        ).all()
        return set(rows)

    # ---------------- agent profiles ----------------

    @staticmethod
    def get_agent_profile(session: Session, agent_id: str) -> dict | None:
        row = session.get(AgentProfile, agent_id)
        if row is None:
            return None
        return {
            "agent_id": row.agent_id,
            "display_name": row.display_name,
            "bio": row.bio,
            "location": row.location,
            "website": row.website,
            "avatar_url": row.avatar_url,
            "header_url": row.header_url,
            "description": row.description,
            "description_generated_at": _iso(row.description_generated_at),
            "description_source": row.description_source,
            "description_regen_requested_at": _iso(row.description_regen_requested_at),
            "updated_at": _iso(row.updated_at),
        }

    # ---------------- agent signup requests ----------------

    @staticmethod
    def get_signup_request(session: Session, request_id: str) -> dict | None:
        row = session.get(AgentSignupRequest, request_id)
        if row is None:
            return None
        return {
            "request_id": row.request_id,
            "agent_id": row.agent_id,
            "org_id": row.org_id,
            "status": row.status,
            "created_at": _iso(row.created_at),
            "reviewed_by": row.reviewed_by,
            "reviewed_at": _iso(row.reviewed_at),
        }

    @staticmethod
    def get_pending_signup_requests_for_org(
        session: Session, org_id: str
    ) -> list[dict]:
        rows = session.exec(
            select(AgentSignupRequest)
            .where(AgentSignupRequest.org_id == org_id)
            .where(AgentSignupRequest.status == "pending_approval")
            .order_by(AgentSignupRequest.created_at.asc())
        ).all()
        return [
            {
                "request_id": r.request_id,
                "agent_id": r.agent_id,
                "org_id": r.org_id,
                "status": r.status,
                "created_at": _iso(r.created_at),
            }
            for r in rows
        ]

    # ---------------- mm_files (chat attachments) ----------------

    @staticmethod
    def get_mm_file(session: Session, file_id: str) -> MmFile | None:
        """Fetch one file row. Returns ``None`` if missing or soft-deleted —
        the endpoint surface treats deleted files as if they don't exist."""
        row = session.get(MmFile, file_id)
        if row is None or row.status == "deleted":
            return None
        return row

    @staticmethod
    def _apply_attachment_kind_filter(stmt, kind: str | None, content_type: str | None):
        """Narrow an ``mm_files`` query by either an explicit ``content_type``
        match (exact, or prefix when the value ends with ``"/"``) or one of
        the named kinds. ``content_type`` wins when both are passed —
        callers can pass ``kind`` as a default and override with a more
        specific MIME for narrow filters (e.g. "application/pdf" only).
        Returns the updated statement; raises :class:`ValueError` for an
        unknown kind so the endpoint can surface a 422.
        """
        if content_type is not None:
            value = content_type.strip()
            if not value:
                raise ValueError("content_type must be non-empty when provided")
            if value.endswith("/"):
                return stmt.where(MmFile.content_type.startswith(value))
            return stmt.where(MmFile.content_type == value)
        if kind is None or kind == "all":
            return stmt
        if kind == "image":
            return stmt.where(MmFile.content_type.startswith("image/"))
        if kind == "video":
            return stmt.where(MmFile.content_type.startswith("video/"))
        if kind == "media":
            # Images + videos in one bucket — drives the unified "Media"
            # tab in chat-details, ordered chronologically across both
            # types so a video posted between two images stays in place.
            return stmt.where(
                or_(
                    MmFile.content_type.startswith("image/"),
                    MmFile.content_type.startswith("video/"),
                )
            )
        if kind == "file":
            return stmt.where(
                not_(MmFile.content_type.startswith("image/"))
            ).where(
                not_(MmFile.content_type.startswith("video/"))
            )
        raise ValueError(f"unknown attachment kind: {kind!r}")

    @staticmethod
    def get_mm_files_for_channel(
        session: Session,
        channel_id: str,
        *,
        kind: str | None = "media",
        content_type: str | None = None,
        limit: int,
        offset: int = 0,
        before_cursor: tuple[datetime, str] | None = None,
    ) -> list[MmFile]:
        """Channel-wide uploaded attachments, newest first.

        Two pagination modes:

          - **cursor** (preferred): pass ``before_cursor`` as the
            ``(created_at, file_id)`` of the last item the caller has
            already seen. Stays correct under concurrent inserts and
            is O(limit) at any depth — backed by
            ``ix_mm_files_channel_listing``.
          - **offset**: pass ``offset=N`` to skip the first N rows.
            Useful for "jump to page" UIs; slower past a few thousand
            rows because Postgres has to walk those skipped rows.

        ``kind`` and ``content_type`` interact as described in
        :meth:`_apply_attachment_kind_filter` — pass either, with
        ``content_type`` taking precedence.

        Only files attached to a *published* post are returned —
        pending uploads in someone else's composer and files orphaned
        by a deleted post are filtered out. Soft-deleted files are
        excluded for the same reason as :meth:`get_mm_file`.
        """
        stmt = (
            select(MmFile)
            .join(MmPost, MmPost.post_id == MmFile.post_id)
            .where(MmFile.channel_id == channel_id)
            .where(MmFile.status == "uploaded")
            .where(MmFile.post_id.is_not(None))
            .where(MmPost.status == "published")
        )
        stmt = TableRead._apply_attachment_kind_filter(stmt, kind, content_type)
        if before_cursor is not None:
            cur_created_at, cur_file_id = before_cursor
            # Row-constructor comparison: ``(a, b) < (c, d)`` is
            # ``a < c OR (a = c AND b < d)``. Postgres supports the
            # tuple form directly but spelling it out keeps the query
            # plan readable and works on any backend the project
            # might add for tests. The DESC ordering means "older
            # than the cursor" is what we want, which is exactly the
            # ``<`` comparison here.
            stmt = stmt.where(
                or_(
                    MmFile.created_at < cur_created_at,
                    and_(
                        MmFile.created_at == cur_created_at,
                        MmFile.file_id < cur_file_id,
                    ),
                )
            )
        stmt = stmt.order_by(MmFile.created_at.desc(), MmFile.file_id.desc())
        if offset:
            stmt = stmt.offset(offset)
        # Fetch ``limit + 1`` so the caller can detect ``has_more``
        # without a second COUNT query. The endpoint trims back to
        # ``limit`` before returning to the client.
        stmt = stmt.limit(limit + 1)
        return list(session.exec(stmt).all())

    @staticmethod
    def count_mm_files_for_channel(
        session: Session,
        channel_id: str,
        *,
        kind: str | None = "media",
        content_type: str | None = None,
    ) -> int:
        """Mirror of :meth:`get_mm_files_for_channel` that returns just
        the total count of *matching* rows. Only called when the caller
        opts in via ``include_total=true`` — the underlying ``COUNT(*)``
        is O(matching_rows) and isn't free at scale.
        """
        stmt = (
            select(func.count(MmFile.file_id))
            .join(MmPost, MmPost.post_id == MmFile.post_id)
            .where(MmFile.channel_id == channel_id)
            .where(MmFile.status == "uploaded")
            .where(MmFile.post_id.is_not(None))
            .where(MmPost.status == "published")
        )
        stmt = TableRead._apply_attachment_kind_filter(stmt, kind, content_type)
        return int(session.exec(stmt).one())

    @staticmethod
    def get_mm_posts_with_text_for_channel(
        session: Session,
        channel_id: str,
        *,
        limit: int,
        offset: int = 0,
        before_post_id: int | None = None,
    ) -> list[MmPost]:
        """Recent published posts with a non-empty message body, newest first.

        Used by the chat-details "Links" tab: the endpoint scans this
        window and runs :func:`extract_urls` on each ``message`` to harvest
        URLs. Drafts/rejected posts are excluded — only what's actually
        visible to the channel.

        Pagination accepts both ``offset`` and ``before_post_id`` — the
        latter is preferred (cursor-style; consistent with
        ``GET /channels/{id}/posts``) but offset stays available for
        callers that haven't migrated yet.
        """
        stmt = (
            select(MmPost)
            .where(MmPost.channel_id == channel_id)
            .where(MmPost.status == "published")
            .where(func.length(MmPost.message) > 0)
        )
        if before_post_id is not None:
            stmt = stmt.where(MmPost.post_id < before_post_id)
        stmt = stmt.order_by(MmPost.created_at.desc(), MmPost.post_id.desc())
        if offset:
            stmt = stmt.offset(offset)
        stmt = stmt.limit(limit)
        return list(session.exec(stmt).all())


    # ------------------------------------------------------------------
    # Skills catalog
    # ------------------------------------------------------------------

    @staticmethod
    def _skill_to_dict(row: Skill, latest: SkillVersion | None = None) -> dict:
        """Operator/UI projection of a catalog row."""
        return {
            "skill_id": row.skill_id,
            "org_id": row.org_id,
            "slug": row.slug,
            "display_name": row.display_name,
            "summary": row.summary,
            "icon_emoji": row.icon_emoji,
            "visibility": row.visibility,
            "origin": row.origin,
            "runtimes": row.runtimes or ["openclaw"],
            "forked_from_skill_id": row.forked_from_skill_id,
            "forked_from_version_id": row.forked_from_version_id,
            "latest_version_id": row.latest_version_id,
            "latest_version": latest.version if latest is not None else None,
            "content_hash": latest.content_hash if latest is not None else None,
            "has_executable": bool(latest.has_executable) if latest is not None else False,
            "is_draft": row.latest_version_id is None,
            "archived_at": _iso(row.archived_at),
            "created_by": row.created_by,
            "created_at": _iso(row.created_at),
            "updated_at": _iso(row.updated_at),
        }

    @staticmethod
    def _skill_version_to_dict(row: SkillVersion, *, include_content: bool = False) -> dict:
        """One version. ``include_content`` is off for timeline listings."""
        out = {
            "version_id": row.version_id,
            "skill_id": row.skill_id,
            "version": row.version,
            "content_hash": row.content_hash,
            "total_bytes": row.total_bytes,
            "has_executable": bool(row.has_executable),
            "changelog": row.changelog,
            "schema_version": row.schema_version,
            "published_by": row.published_by,
            "created_at": _iso(row.created_at),
        }
        if include_content:
            out["manifest"] = row.manifest
            out["body_md"] = row.body_md
            out["files"] = row.files or []
        return out

    @staticmethod
    def list_org_skills(session: Session, org_id: str) -> list[dict]:
        """Every live skill in the org's library, newest first.

        Gated on org membership by the caller, not agent operatorship: an owner
        who operates no agents must still see the shared library.
        """
        rows = session.exec(
            select(Skill)
            .where(Skill.org_id == org_id, Skill.deleted_at.is_(None))
            .order_by(Skill.updated_at.desc())
        ).all()
        if not rows:
            return []
        version_ids = [r.latest_version_id for r in rows if r.latest_version_id]
        latest_by_id: dict[str, SkillVersion] = {}
        if version_ids:
            latest_by_id = {
                v.version_id: v
                for v in session.exec(
                    select(SkillVersion).where(SkillVersion.version_id.in_(version_ids))
                ).all()
            }
        return [
            TableRead._skill_to_dict(r, latest_by_id.get(r.latest_version_id or ""))
            for r in rows
        ]

    @staticmethod
    def get_skill_for_org(session: Session, skill_id: str, org_id: str) -> Skill | None:
        """A live skill, re-deriving org from the row itself.

        Every by-id route must use this rather than a bare ``session.get`` —
        org isolation here is convention, not row-level security.
        """
        row = session.get(Skill, skill_id)
        if row is None or row.deleted_at is not None or row.org_id != org_id:
            return None
        return row

    @staticmethod
    def get_skill_detail(session: Session, skill_id: str, org_id: str) -> dict | None:
        """Full projection of one skill, including its current version content."""
        row = TableRead.get_skill_for_org(session, skill_id, org_id)
        if row is None:
            return None
        latest = (
            session.get(SkillVersion, row.latest_version_id)
            if row.latest_version_id
            else None
        )
        out = TableRead._skill_to_dict(row, latest)
        out["current_version"] = (
            TableRead._skill_version_to_dict(latest, include_content=True)
            if latest is not None
            else None
        )
        return out

    @staticmethod
    def list_skill_versions(session: Session, skill_id: str) -> list[dict]:
        """The version timeline, newest first. Spine only — no bodies."""
        rows = session.exec(
            select(SkillVersion)
            .where(SkillVersion.skill_id == skill_id)
            .order_by(SkillVersion.created_at.desc())
        ).all()
        return [TableRead._skill_version_to_dict(r) for r in rows]

    @staticmethod
    def get_skill_version(
        session: Session, version_id: str, skill_id: str
    ) -> SkillVersion | None:
        """One version, asserting it belongs to ``skill_id``.

        ``skill_versions`` carries no ``org_id``, so this scoping IS the check.
        """
        row = session.get(SkillVersion, version_id)
        if row is None or row.skill_id != skill_id:
            return None
        return row

    @staticmethod
    def get_org_skill_slugs(session: Session, org_id: str) -> set[str]:
        """Live slugs already taken in this org (for fork slug derivation)."""
        rows = session.exec(
            select(Skill.slug).where(Skill.org_id == org_id, Skill.deleted_at.is_(None))
        ).all()
        return {r for r in rows}

    @staticmethod
    def _install_to_dict(row: AgentSkillInstall) -> dict:
        state = row.reported_state or {}
        manifest = row.reported_manifest or {}
        return {
            "install_id": row.install_id,
            "agent_id": row.agent_id,
            "skill_id": row.skill_id,
            "slug": row.slug,
            "managed_by": row.managed_by,
            "name": manifest.get("name") or row.slug,
            "description": manifest.get("description"),
            "sync_status": row.sync_status,
            "sync_error": row.sync_error,
            "enabled": row.enabled,
            "reported_version": row.reported_version,
            "reported_path": row.reported_path,
            "reported_root": row.reported_root,
            "reported_source": row.reported_source,
            # A skill can be present and still unused (missing requirement).
            "eligible": state.get("eligible"),
            "model_visible": state.get("modelVisible"),
            "missing": state.get("missing"),
            "last_seen_at": _iso(row.last_seen_at),
            "updated_at": _iso(row.updated_at),
        }

    @staticmethod
    def list_agent_skills(session: Session, agent_id: str) -> dict:
        # Tombstones stay visible on purpose: a removal is not done until the
        # agent confirms the directory is gone, and hiding the row immediately
        # would paint success we cannot vouch for.
        rows = session.exec(
            select(AgentSkillInstall)
            .where(
                AgentSkillInstall.agent_id == agent_id,
                or_(
                    AgentSkillInstall.deleted_at.is_(None),
                    AgentSkillInstall.sync_status == "removing",
                ),
            )
            .order_by(AgentSkillInstall.slug)
        ).all()
        state = session.get(AgentSkillSyncState, agent_id)
        return {
            "skills": [TableRead._install_to_dict(r) for r in rows],
            "sync": {
                "report_mode": state.report_mode if state else None,
                "skills_root": state.skills_root if state else None,
                "scanned_roots": state.scanned_roots if state else None,
                "apply_mode": state.apply_mode if state else None,
                "prompt_chars_observed": state.prompt_chars_observed if state else None,
                "prompt_budget_observed": state.prompt_budget_observed if state else None,
                "truncated": state.report_truncated if state else False,
                "plugin_version": state.plugin_version if state else None,
                "last_reported_at": _iso(state.last_reported_at) if state else None,
            },
        }

    @staticmethod
    def _resolve_install_version(
        session: Session, row: AgentSkillInstall
    ) -> SkillVersion | None:
        """The version this install should be on, resolved live.

        Deliberately not stored. 'latest' reads the skill's current pointer at
        feed time, so publishing a new version needs no fan-out write across
        every install — the content hash simply changes and the plugin's drift
        gate picks it up on its next pass.
        """
        if row.channel == "pinned" and row.pinned_version_id:
            return session.get(SkillVersion, row.pinned_version_id)
        if row.skill_id is None:
            return None
        skill = session.get(Skill, row.skill_id)
        if skill is None or skill.latest_version_id is None:
            return None
        return session.get(SkillVersion, skill.latest_version_id)

    @staticmethod
    def get_desired_skills(session: Session, agent_id: str) -> dict:
        """The desired set the plugin reconciles to. Index only, never bodies."""
        state = session.get(AgentSkillSyncState, agent_id)
        rows = session.exec(
            select(AgentSkillInstall).where(
                AgentSkillInstall.agent_id == agent_id,
                AgentSkillInstall.managed_by == "clawbits",
            )
        ).all()

        items = []
        for row in rows:
            absent = row.deleted_at is not None or not row.enabled
            version = None if absent else TableRead._resolve_install_version(session, row)
            # A managed row whose skill has no published version yet has nothing
            # to apply; skip rather than emit an item the client cannot satisfy.
            if not absent and version is None:
                continue
            items.append(
                {
                    "install_id": row.install_id,
                    "slug": row.slug,
                    "intent": "absent" if absent else "present",
                    "desired_generation": row.desired_generation,
                    "version_id": version.version_id if version else None,
                    "version": version.version if version else None,
                    "content_hash": version.content_hash if version else None,
                }
            )
        return {
            "schema_version": SKILL_SCHEMA_VERSION,
            "paused": bool(state.paused) if state else False,
            "desired_generation": state.desired_generation if state else 0,
            "skills": items,
        }

    @staticmethod
    def get_agent_skill_version(
        session: Session, agent_id: str, version_id: str
    ) -> SkillVersion | None:
        """A version the agent is entitled to fetch.

        Entitlement is having a live managed install that resolves to it — the
        agent can never pull arbitrary catalog content by guessing an id.
        """
        rows = session.exec(
            select(AgentSkillInstall).where(
                AgentSkillInstall.agent_id == agent_id,
                AgentSkillInstall.managed_by == "clawbits",
                AgentSkillInstall.deleted_at.is_(None),
            )
        ).all()
        for row in rows:
            version = TableRead._resolve_install_version(session, row)
            if version is not None and version.version_id == version_id:
                return version
        return None
