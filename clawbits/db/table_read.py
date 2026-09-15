"""Read-side database accessors. Every method takes an open ``Session`` first."""
from __future__ import annotations

import hashlib
import re
from collections.abc import Collection, Sequence
from datetime import UTC, date, datetime, timedelta
from typing import TypedDict, Unpack

from eth_account import Account
from sqlalchemy import (
    ColumnElement,
    ScalarSelect,
    and_,
    case,
    func,
    literal,
    not_,
    or_,
    text,
    true,
)
from sqlalchemy.orm import InstrumentedAttribute, aliased
from sqlmodel import Session, select

from clawbits.agent_marks import Mark
from clawbits.avatars.payloads import (
    avatar_ref_for_agent,
    avatar_ref_for_channel,
    avatar_ref_for_org,
    avatar_ref_for_user,
)
from clawbits.datastructures.agent import Agent as AgentDS
from clawbits.datastructures.agent_id import AgentId
from clawbits.datastructures.mm_models import agent_liveness_status
from clawbits.db.models import (
    SKILL_SCHEMA_VERSION,
    Agent,
    AgentAction,
    AgentChannelState,
    AgentContactPermission,
    AgentMark,
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

# Clients render past 99 as "99+", so counting stops here: 100 means "at least 100".
UNREAD_COUNT_CAP = 100

type MemberRow = tuple[
    MmChannelMember,
    HumanUser | None,
    HumanChannelState | None,
    Agent | None,
    AgentProfile | None,
    AgentChannelState | None,
]


class SearchOperators(TypedDict, total=False):
    from_human_id: int | None
    from_agent_id: str | None
    before: datetime | None
    after: datetime | None
    has_link: bool
    has_file: bool


def _privacy_last_seen(row: HumanUser) -> str | None:
    return _iso(row.last_seen_at) if row.last_seen_visible else None


def _connector_row(row: HumanConnector) -> dict:
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


class TableRead:

    @staticmethod
    def get_cb_tokens(session: Session, agent_id: AgentId) -> int:
        row = session.get(Agent, agent_id.value)
        if row is None:
            return 0
        return int(row.cb_tokens)

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
            "reef_host": row.reef_host,
            "reef_name": row.reef_name,
            "agent_id": row.agent_id,
            "nickname": row.nickname,
        }

    @staticmethod
    def is_agent_id_taken(session: Session, agent_id: str) -> bool:
        """Held by an agent or by any signup session still on file: the rule the
        unique index on ``challenge_sessions.agent_id`` enforces, so an id that
        passes can only lose to a concurrent mint."""
        return session.get(Agent, agent_id) is not None or session.exec(
            select(ChallengeSession.session_token).where(ChallengeSession.agent_id == agent_id)
        ).first() is not None

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
        session: Session, org_ids: list[str], limit: int = 50, offset: int = 0
    ) -> list[dict]:
        """Recent shared files, restricted to agents in ``org_ids``.

        ``org_ids`` is required, not optional: this feed used to select every
        row in the table, so a caller that forgets to scope it is the bug.
        The join also excludes the cross-org ``deleted-agent`` placeholder,
        which has no org by construction.
        """
        if not org_ids:
            return []
        rows = session.exec(
            select(ShareRecord)
            .join(Agent, Agent.agent_id == ShareRecord.agent_id)
            .where(Agent.org_id.in_(org_ids))
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
        org_ids: list[str],
        limit: int = 50,
        offset: int = 0,
        current_human_id: int | None = None,
        current_agent_id: str | None = None,
    ) -> list[dict]:
        """Recent agent posts, restricted to agents in ``org_ids``.

        See :meth:`get_recent_shared_content` for why the scope is required.
        """
        if not org_ids:
            return []
        rows = session.exec(
            select(AgentPost)
            .join(Agent, Agent.agent_id == AgentPost.agent_id)
            .where(Agent.org_id.in_(org_ids))
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
        """May this principal ``@``-tag ``agent_id``? See :meth:`taggable_agent_ids`."""
        return agent_id in TableRead.taggable_agent_ids(
            session, [agent_id], human_id=human_id, principal_agent_id=principal_agent_id
        )

    @staticmethod
    def taggable_agent_ids(
        session: Session,
        agent_ids: Collection[str],
        *,
        human_id: int | None = None,
        principal_agent_id: str | None = None,
    ) -> set[str]:
        """Which of ``agent_ids`` this principal may ``@``-tag in a channel (or add to one),
        in one statement. Operator always may; everyone else needs ``can_tag``. A human
        principal wins when both are given; neither yields nothing."""
        if not agent_ids or (human_id is None and principal_agent_id is None):
            return set()
        grants = select(AgentContactPermission.id).where(
            AgentContactPermission.agent_id == Agent.agent_id,
            AgentContactPermission.can_tag.is_(True),
        )
        allowed = (
            or_(
                Agent.operator_id == human_id,
                grants.where(AgentContactPermission.human_id == human_id).exists(),
            )
            if human_id is not None
            else grants.where(
                AgentContactPermission.principal_agent_id == principal_agent_id
            ).exists()
        )
        return set(
            session.exec(select(Agent.agent_id).where(Agent.agent_id.in_(agent_ids), allowed)).all()
        )

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
            "avatar": avatar_ref_for_org(org_id=o.org_id, version=o.avatar_version) if o.avatar_version else None,
            "is_personal": bool(o.is_personal),
            "created_by": o.created_by,
            "created_at": _iso(o.created_at),
            "attention_enabled": bool(o.attention_enabled),
            # Whether a reef repository is usable, never which one: the repo
            # and its token stay on the server.
            "reef_connected": bool(o.reef_repo and o.reef_repo_token),
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
    def get_org_reef(session: Session, org_id: str) -> tuple[str, str] | None:
        """``(repo, sealed_token)`` for the org's reef repository, or ``None``
        when the org has none. The token stays sealed here: only
        :mod:`clawbits.reef_repo`'s caller unseals it, per request."""
        row = session.get(Organization, org_id)
        if row is None or not row.reef_repo or not row.reef_repo_token:
            return None
        return row.reef_repo, row.reef_repo_token

    @staticmethod
    def get_org_reef_agent_operators(
        session: Session, org_id: str, host: str, name: str
    ) -> set[int]:
        """Who operates the org's agent declared as ``host``/``name``: the
        operator of the agent that enrolled under that pair, plus whoever
        declared it while its signup token is unspent, since enrolling makes
        that person its operator."""
        enrolled = session.exec(
            select(Agent.operator_id)
            .where(
                Agent.org_id == org_id,
                Agent.reef_host == host,
                Agent.reef_name == name,
            )
            .order_by(Agent.creation_time.desc())
        ).first()
        declared = session.exec(
            select(ChallengeSession.human_id).where(
                ChallengeSession.org_id == org_id,
                ChallengeSession.reef_host == host,
                ChallengeSession.reef_name == name,
                ChallengeSession.used == False,  # noqa: E712
            )
        ).all()
        return {human for human in (enrolled, *declared) if human is not None}

    @staticmethod
    def get_org_reef_agents(
        session: Session, org_id: str, host: str
    ) -> dict[str, tuple[str, str]]:
        """``{fleet name: (agent_id, nickname)}`` for the org's agents that
        enrolled on ``host``, the newest under each name. Removing a fleet file
        keeps the VM's volumes and so its key: declaring that name again brings
        this agent back."""
        rows = session.exec(
            select(Agent.reef_name, Agent.agent_id, Agent.nickname)
            .where(Agent.org_id == org_id, Agent.reef_host == host)
            .order_by(Agent.creation_time)
        ).all()
        return {name: (agent_id, nickname) for name, agent_id, nickname in rows if name}

    @staticmethod
    def get_reef_placement(
        session: Session, org_id: str, agent_id: str
    ) -> tuple[str, str] | None:
        """``(host, name)`` of the fleet file this agent owns, or ``None`` when
        it is self-hosted, or an older row under a name a second agent enrolled
        against since: the pair is not unique, and the newest row is the live
        one, the rule :meth:`get_org_reef_agent_operators` reads ownership by."""
        row = session.get(Agent, agent_id)
        if row is None or row.org_id != org_id or not row.reef_host or not row.reef_name:
            return None
        newest = session.exec(
            select(Agent.agent_id)
            .where(
                Agent.org_id == org_id,
                Agent.reef_host == row.reef_host,
                Agent.reef_name == row.reef_name,
            )
            .order_by(Agent.creation_time.desc())
        ).first()
        return (row.reef_host, row.reef_name) if newest == agent_id else None

    @staticmethod
    def list_declared_reef_agents(
        session: Session, org_id: str, now: datetime
    ) -> list[dict]:
        """Agents declared on a reef host whose signup token is still unspent:
        the fleet file is written but the VM has not enrolled yet."""
        rows = session.exec(
            select(ChallengeSession).where(
                ChallengeSession.org_id == org_id,
                ChallengeSession.reef_host.is_not(None),
                ChallengeSession.used == False,  # noqa: E712
                ChallengeSession.expires_at > now,
            )
        ).all()
        return [
            {"host": r.reef_host, "name": r.reef_name, "expires_at": r.expires_at}
            for r in rows
        ]

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
        # Capped like the sidebar: this also runs on boot, so org totals sum capped counts.
        per_channel = (
            select(
                MmChannel.org_id.label("org_id"),
                TableRead._unread_count(HumanChannelState, MmPost.human_id, human_id).label("cnt"),
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
    def get_org_ids_for_human(session: Session, human_id: int) -> list[str]:
        """Org ids this human belongs to.

        Deliberately minimal: the org-scoped read paths only need the ids, and
        ``get_orgs_for_human`` computes per-org unread aggregates that would be
        pure waste on those routes.
        """
        return list(
            session.exec(
                select(OrgMember.org_id).where(OrgMember.human_id == human_id)
            ).all()
        )

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
            "last_message_author_avatar": (
                TableRead._avatar_for_member(
                    session, c.last_message_author_human_id, None, c.last_message_author_agent_id
                )
                if session is not None
                else None
            ),
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
        """The agent's channels with its read pointer, latest post and unread counts, so a
        reconnecting agent drains only the channels that moved. A ``None`` pointer means first
        boot. DMs the agent may no longer access are dropped."""
        latest_post = (
            select(MmPost.post_id.label("post_id"))
            .where(MmPost.channel_id == MmChannel.channel_id)
            .where(MmPost.status == "published")
            .order_by(MmPost.post_id.desc())
            .limit(1)
            .correlate(MmChannel)
            .lateral("latest_post")
        )
        # Exactly the plugins' own mention predicate, so the count matches what the agent answers.
        mention_regex = rf"@({re.escape(agent_id)})([^a-z0-9_.-]|$)"
        rows = session.exec(
            select(
                MmChannel,
                latest_post.c.post_id.label("latest_post_id"),
                AgentChannelState.last_read_post_id,
                TableRead._unread_count(AgentChannelState, MmPost.agent_id, agent_id).label(
                    "unread_count"
                ),
                TableRead._unread_count(
                    AgentChannelState, MmPost.agent_id, agent_id, mention_regex
                ).label("unread_mention_count"),
            )
            .join(MmChannelMember, MmChannelMember.channel_id == MmChannel.channel_id)
            .join(
                AgentChannelState,
                (AgentChannelState.channel_id == MmChannel.channel_id)
                & (AgentChannelState.agent_id == agent_id),
                isouter=True,
            )
            .join(latest_post, true(), isouter=True)
            .where(MmChannelMember.agent_id == agent_id)
            .order_by(MmChannel.created_at.desc())
        ).all()
        return [
            {
                **TableRead._channel_to_dict(c, session),
                "latest_post_id": latest_post_id,
                "last_read_post_id": last_read_post_id,
                "unread_count": unread_count,
                "unread_mention_count": unread_mention_count,
            }
            for c, latest_post_id, last_read_post_id, unread_count, unread_mention_count in rows
            if c.channel_type != "direct"
            or TableRead.can_agent_access_dm(session, c.channel_id, agent_id)
        ]

    @staticmethod
    def get_mm_channel_members(session: Session, channel_id: str) -> list[dict]:
        return [
            TableRead._member_to_dict(*row)
            for row in TableRead._member_rows(session, MmChannelMember.channel_id == channel_id)
        ]

    @staticmethod
    def _member_rows(session: Session, *criteria: ColumnElement[bool]) -> Sequence[MemberRow]:
        return session.exec(
            select(
                MmChannelMember,
                HumanUser,
                HumanChannelState,
                Agent,
                AgentProfile,
                AgentChannelState,
            )
            .join(HumanUser, HumanUser.id == MmChannelMember.human_id, isouter=True)
            .join(
                HumanChannelState,
                (HumanChannelState.human_id == MmChannelMember.human_id)
                & (HumanChannelState.channel_id == MmChannelMember.channel_id),
                isouter=True,
            )
            .join(Agent, Agent.agent_id == MmChannelMember.agent_id, isouter=True)
            .join(AgentProfile, AgentProfile.agent_id == MmChannelMember.agent_id, isouter=True)
            .join(
                AgentChannelState,
                (AgentChannelState.agent_id == MmChannelMember.agent_id)
                & (AgentChannelState.channel_id == MmChannelMember.channel_id),
                isouter=True,
            )
            .where(*criteria)
            .order_by(MmChannelMember.joined_at)
        ).all()

    @staticmethod
    def _member_to_dict(
        m: MmChannelMember,
        u: HumanUser | None,
        s: HumanChannelState | None,
        a: Agent | None,
        p: AgentProfile | None,
        ags: AgentChannelState | None,
    ) -> dict:
        """A member row with the raw last-seen and privacy toggles; the endpoint applies the
        privacy view and Redis presence."""
        return {
            "agent_id": m.agent_id,
            "human_id": m.human_id,
            "joined_at": _iso(m.joined_at),
            "display_name": (u.display_name if u else None) or (
                ((p.display_name if p else None) or (a.nickname if a else None) or m.agent_id)
                if m.agent_id
                else None
            ),
            "last_seen_at": _iso(u.last_seen_at) if u else None,
            "privacy_mode_enabled": u.privacy_mode_enabled if u else False,
            "last_seen_visible": u.last_seen_visible if u else True,
            "online_status_visible": u.online_status_visible if u else True,
            "read_receipts_enabled": u.read_receipts_enabled if u else True,
            "typing_indicators_enabled": u.typing_indicators_enabled if u else True,
            "avatar": (
                avatar_ref_for_user(
                    user_id=u.id, version=u.avatar_version, kind=u.avatar_kind
                ).model_dump()
                if u
                else avatar_ref_for_agent(
                    agent_id=a.agent_id, version=a.avatar_version, kind=a.avatar_kind
                ).model_dump()
                if a
                else None
            ),
            "last_read_post_id": (
                s.last_read_post_id if s else (ags.last_read_post_id if ags else None)
            ),
            "agent_status": agent_liveness_status(a.last_alive_at) if a else None,
            "last_alive_at": _iso(a.last_alive_at) if a else None,
        }

    @staticmethod
    def _avatar_for_member(
        session: Session,
        human_id: int | None,
        human_row: HumanUser | None,
        agent_id: str | None,
    ) -> dict | None:
        """Avatar payload for a human or agent; pass ``human_row`` when already loaded."""
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
        return session.exec(
            select(MmChannelMember)
            .where(MmChannelMember.channel_id == channel_id)
            .where(MmChannelMember.agent_id == agent_id)
        ).first() is not None

    @staticmethod
    def is_mm_channel_member_human(
        session: Session, channel_id: str, human_id: int
    ) -> bool:
        return session.exec(
            select(MmChannelMember)
            .where(MmChannelMember.channel_id == channel_id)
            .where(MmChannelMember.human_id == human_id)
        ).first() is not None

    _PARENT_EXCERPT_LIMIT = 140

    @staticmethod
    def hydrate_mm_posts(session: Session, posts: Sequence[MmPost]) -> list[dict]:
        """Response dicts for ``posts`` in order. Each relation loads for the whole batch in
        one statement, so a page costs the same at any size. File URLs are the endpoint's."""
        if not posts:
            return []
        parent_ids = {p.parent_post_id for p in posts if p.parent_post_id is not None}
        parents = {
            p.post_id: p
            for p in session.exec(select(MmPost).where(MmPost.post_id.in_(parent_ids))).all()
        } if parent_ids else {}
        authors = [*posts, *parents.values()]
        human_ids = {p.human_id for p in authors if p.human_id is not None}
        agent_ids = {p.agent_id for p in authors if p.agent_id is not None}
        humans = {
            h.id: {
                "poster_display_name": h.display_name,
                "avatar": avatar_ref_for_user(
                    user_id=h.id, version=h.avatar_version, kind=h.avatar_kind
                ).model_dump(),
            }
            for h in session.exec(select(HumanUser).where(HumanUser.id.in_(human_ids))).all()
        } if human_ids else {}
        agents = {
            a.agent_id: {
                "poster_display_name": (profile.display_name if profile else None)
                or a.nickname
                or a.agent_id,
                "avatar": avatar_ref_for_agent(
                    agent_id=a.agent_id, version=a.avatar_version, kind=a.avatar_kind
                ).model_dump(),
            }
            for a, profile in session.exec(
                select(Agent, AgentProfile)
                .join(AgentProfile, AgentProfile.agent_id == Agent.agent_id, isouter=True)
                .where(Agent.agent_id.in_(agent_ids))
            ).all()
        } if agent_ids else {}
        reactions: dict[int, dict[str, dict]] = {}
        for r in session.exec(
            select(MmPostReaction)
            .where(MmPostReaction.post_id.in_([p.post_id for p in posts]))
            .order_by(MmPostReaction.id)
        ).all():
            bucket = reactions.setdefault(r.post_id, {}).setdefault(
                r.emoji, {"emoji": r.emoji, "count": 0, "human_ids": [], "agent_ids": []}
            )
            bucket["count"] += 1
            if r.human_id is not None:
                bucket["human_ids"].append(r.human_id)
            if r.agent_id is not None:
                bucket["agent_ids"].append(r.agent_id)
        files: dict[int, list[dict]] = {}
        for f in session.exec(
            select(MmFile)
            .where(MmFile.post_id.in_([p.post_id for p in authors]))
            .where(MmFile.status == "uploaded")
            .order_by(MmFile.file_id)
        ).all():
            files.setdefault(f.post_id, []).append({
                "file_id": f.file_id,
                "channel_id": f.channel_id,
                "filename": f.filename,
                "content_type": f.content_type,
                "size_bytes": f.size_bytes,
                "status": f.status,
                "width": f.width,
                "height": f.height,
                "duration_ms": f.duration_ms,
                "created_at": _iso(f.created_at),
                "uploaded_at": _iso(f.uploaded_at),
                "download_url": None,
                "thumbnail_url": None,
                "_object_key": f.object_key,
                "_thumbnail_object_key": f.thumbnail_object_key,
            })

        def identity(p: MmPost) -> dict:
            if p.human_id is not None:
                return humans.get(p.human_id, {"poster_display_name": None, "avatar": None})
            if p.agent_id is not None:
                return agents.get(p.agent_id, {"poster_display_name": p.agent_id, "avatar": None})
            return {"poster_display_name": None, "avatar": None}

        def parent_preview(parent: MmPost | None) -> dict | None:
            if parent is None:
                return None
            excerpt = (parent.message or "").strip()
            if len(excerpt) > TableRead._PARENT_EXCERPT_LIMIT:
                excerpt = excerpt[: TableRead._PARENT_EXCERPT_LIMIT - 1].rstrip() + "…"
            return {
                "post_id": parent.post_id,
                "agent_id": parent.agent_id,
                "human_id": parent.human_id,
                "poster_display_name": identity(parent)["poster_display_name"],
                "message_excerpt": excerpt,
                "status": parent.status,
                "attachment_count": len(files.get(parent.post_id, ())),
            }

        return [
            {
                "post_id": p.post_id,
                "channel_id": p.channel_id,
                "agent_id": p.agent_id,
                "human_id": p.human_id,
                "message": p.message,
                "created_at": _iso(p.created_at),
                **identity(p),
                "status": p.status,
                "updated_at": _iso(p.updated_at),
                "edited_at": _iso(p.edited_at),
                "pinned_at": _iso(p.pinned_at),
                "pinned_by_human_id": p.pinned_by_human_id,
                "parent_post_id": p.parent_post_id,
                "parent_preview": parent_preview(
                    parents.get(p.parent_post_id) if p.parent_post_id is not None else None
                ),
                "link_preview": p.link_preview,
                "trace_id": p.trace_id,
                "reactions": list(reactions.get(p.post_id, {}).values()),
                "files": files.get(p.post_id, []),
                "_raw_created_at": p.created_at,
            }
            for p in posts
        ]

    @staticmethod
    def _resolve_identity(
        session: Session, human_id: int | None, agent_id: str | None
    ) -> tuple[str | None, dict | None]:
        """``(display_name, avatar)`` for an event actor or subject."""
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
            "_raw_created_at": e.created_at,
        }

    @staticmethod
    def get_mm_channel_event_by_id(
        session: Session, event_id: int
    ) -> dict | None:
        row = session.get(MmChannelEvent, event_id)
        return TableRead._mm_channel_event_to_dict(session, row) if row else None

    @staticmethod
    def get_mm_channel_events(
        session: Session,
        channel_id: str,
        limit: int = 50,
        before_created_at: datetime | None = None,
    ) -> list[dict]:
        """Channel events, newest first; ``before_created_at`` keeps only older ones, the
        merged timeline's cursor exactly as :meth:`get_mm_posts_for_human` applies it."""
        stmt = (
            select(MmChannelEvent)
            .where(MmChannelEvent.channel_id == channel_id)
        )
        if before_created_at is not None:
            stmt = stmt.where(MmChannelEvent.created_at < before_created_at)
        stmt = stmt.order_by(
            MmChannelEvent.created_at.desc(), MmChannelEvent.event_id.desc()
        ).limit(limit)
        return [
            TableRead._mm_channel_event_to_dict(session, e) for e in session.exec(stmt).all()
        ]

    @staticmethod
    def _human_can_view_restricted_mm_post(
        session: Session, post: MmPost, human_id: int
    ) -> bool:
        """A draft or rejected post shows to its human author, to the approval authority of
        its agent author, or to that of any agent it tags."""
        if post.human_id == human_id:
            return True
        if post.agent_id:
            return TableRead.is_agent_approval_authority(session, post.agent_id, human_id)
        return any(
            TableRead.is_agent_approval_authority(session, agent_id, human_id)
            for agent_id in TableRead.find_tagged_agents_in_channel(
                session, post.channel_id, post.message
            )
        )

    @staticmethod
    def get_mm_posts(
        session: Session,
        channel_id: str,
        limit: int = 50,
        offset: int = 0,
        before_post_id: int | None = None,
        after_post_id: int | None = None,
    ) -> list[dict]:
        """Streaming and published posts, newest first; ``after_post_id`` pages oldest-first."""
        stmt = (
            select(MmPost)
            .where(MmPost.channel_id == channel_id)
            .where(MmPost.status.in_(("streaming", "published")))
        )
        if after_post_id is not None:
            # Ascending: a DESC page over a wide gap returns the newest and drops what a
            # resuming reader still owes a reply to. Offsets are ignored with a cursor.
            stmt = (
                stmt.where(MmPost.post_id > after_post_id)
                .order_by(MmPost.post_id.asc())
                .limit(limit)
            )
        elif before_post_id is not None:
            stmt = stmt.where(MmPost.post_id < before_post_id).order_by(
                MmPost.post_id.desc()
            ).limit(limit)
        else:
            stmt = stmt.order_by(MmPost.post_id.desc()).limit(limit).offset(offset)
        return TableRead.hydrate_mm_posts(session, session.exec(stmt).all())

    @staticmethod
    def list_pinned_mm_posts(
        session: Session, channel_id: str
    ) -> list[dict]:
        """Pinned published posts in a channel, newest pin first."""
        stmt = (
            select(MmPost)
            .where(MmPost.channel_id == channel_id)
            .where(MmPost.pinned_at.is_not(None))
            .where(MmPost.status == "published")
            .order_by(MmPost.pinned_at.desc())
        )
        return TableRead.hydrate_mm_posts(session, session.exec(stmt).all())

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
        """Channel posts newest first, with drafts and rejected posts only where the human may
        see them. Pick one cursor: ``before_post_id`` (older), ``before_created_at`` (the
        merged timeline) or ``after_post_id`` (newer, from an anchored window); none means
        offset paging. Over-scans, then filters, since restricted posts are rare."""
        scan_limit = max(limit + offset, limit) * 3
        stmt = select(MmPost).where(MmPost.channel_id == channel_id)
        if after_post_id is not None:
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
        visible = [
            p
            for p in session.exec(stmt).all()
            if p.status in {"streaming", "published"}
            or TableRead._human_can_view_restricted_mm_post(session, p, human_id)
        ]
        if after_post_id is not None:
            page = list(reversed(visible[:limit]))
        elif before_post_id is not None or before_created_at is not None:
            page = visible[:limit]
        else:
            page = visible[offset:offset + limit]
        return TableRead.hydrate_mm_posts(session, page)

    # ------------------------------------------------------------------
    # Message content search: docs/protocol/SEARCH_SPEC.md
    # ------------------------------------------------------------------

    @staticmethod
    def _search_acl_filters(
        human_id: int, org_id: str | None, channel_id: str | None
    ) -> list:
        """The one source of content-search visibility for a human: published posts in their
        channels, optionally one org or channel, minus agent DMs they may no longer contact
        (a revoked human keeps the membership row). Encrypted channels live in another table."""
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
    def _search_acl_filters_agent(agent_id: str, channel_ids: list[str]) -> list:
        """Membership is the boundary; ``channel_ids`` (already free of revoked DMs) is only
        the context-derived scope."""
        return [
            MmChannelMember.agent_id == agent_id,
            MmPost.status == "published",
            MmPost.channel_id.in_(channel_ids),
        ]

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
            # A Python None is stored as JSON null, not SQL NULL, so test for an object.
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
        **operators: Unpack[SearchOperators],
    ) -> tuple[list[dict], dict | None]:
        return TableRead._search_mm_posts(
            session,
            TableRead._search_acl_filters(human_id, org_id, channel_id),
            query, sort, limit, cursor, operators,
        )

    @staticmethod
    def search_mm_posts_for_agent(
        session: Session,
        agent_id: str,
        query: str,
        channel_ids: list[str],
        sort: str = "recent",
        limit: int = 25,
        cursor: dict | None = None,
        **operators: Unpack[SearchOperators],
    ) -> tuple[list[dict], dict | None]:
        """Search within an agent's context-derived allowlist (see :meth:`agent_search_scope`)."""
        if not channel_ids:
            return [], None
        return TableRead._search_mm_posts(
            session,
            TableRead._search_acl_filters_agent(agent_id, channel_ids),
            query, sort, limit, cursor, operators,
        )

    @staticmethod
    def _search_mm_posts(
        session: Session,
        acl: list,
        query: str,
        sort: str,
        limit: int,
        cursor: dict | None,
        operators: SearchOperators,
    ) -> tuple[list[dict], dict | None]:
        """Full-text search under ``acl``, as ``(results, next_cursor)``.

        ``recent`` pages newest-first on a ``post_id`` keyset, ``relevant`` by ``ts_rank_cd``
        with an offset. A blank query with operator filters lists newest-first; a fresh
        single-term query that matches nothing falls back to trigram similarity."""
        q = (query or "").strip()
        limit = max(1, min(limit, 50))
        op_filters = TableRead._search_operator_filters(**operators)
        has_text = bool(q)
        if not has_text and not op_filters:
            return [], None

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
        else:
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

        if has_text and not results and cursor is None and len(q.split()) == 1:
            results = TableRead._search_trigram_fallback(
                session, q, limit, acl, op_filters
            )

        return results, next_cursor

    @staticmethod
    def _search_trigram_fallback(
        session: Session,
        term: str,
        limit: int,
        acl_filters: list,
        op_filters: list | None = None,
    ) -> list[dict]:
        """Misspelling-tolerant fallback on the trigram GIN index, under the caller's ACL.
        ``word_similarity`` (``%>``) matches a typo'd word inside a longer message, and the
        default 0.6 threshold is lowered for this transaction only."""
        session.execute(text("SET LOCAL pg_trgm.word_similarity_threshold = 0.3"))
        sim = func.word_similarity(term, MmPost.message)
        stmt = (
            select(MmPost, HumanUser, MmChannel, sim.label("rank"))
            .join(MmChannelMember, MmChannelMember.channel_id == MmPost.channel_id)
            .join(MmChannel, MmChannel.channel_id == MmPost.channel_id)
            .join(HumanUser, HumanUser.id == MmPost.human_id, isouter=True)
            .where(*acl_filters, *(op_filters or []))
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
    def agent_search_scope(
        session: Session, agent_id: str, context_channel_id: str
    ) -> tuple[str, list[str]]:
        """``(scope, channel allowlist)`` for an agent searching from the channel it is
        responding in, whose membership the caller already enforced.

        The operator DM unlocks all the agent's channels (``all_channels``), a public context
        its public channels (``public_channels``), anything else the context plus public ones
        (``context_and_public``). The operator DM is found by membership, never by its name,
        which squatter reconciliation makes unreliable."""
        channels = TableRead.get_mm_channels_for_agent(session, agent_id)
        all_ids = [c["channel_id"] for c in channels]
        public_ids = [
            c["channel_id"] for c in channels if c.get("channel_type") == "public"
        ]

        agent = session.get(Agent, agent_id)
        if (
            agent is not None
            and agent.operator_id is not None
            and agent.org_id is not None
        ):
            dm = TableRead.find_dm_channel_human_agent(
                session, int(agent.operator_id), agent_id, agent.org_id
            )
            if dm is not None and dm["channel_id"] == context_channel_id:
                return "all_channels", all_ids

        context = next(
            (c for c in channels if c["channel_id"] == context_channel_id), None
        )
        if context is not None and context.get("channel_type") == "public":
            return "public_channels", public_ids
        return "context_and_public", (
            public_ids if context_channel_id in public_ids else [context_channel_id, *public_ids]
        )

    @staticmethod
    def get_mm_posts_around_for_human(
        session: Session,
        channel_id: str,
        human_id: int,
        around_post_id: int,
        radius: int = 25,
    ) -> list[dict]:
        """Up to ``radius`` visible posts either side of ``around_post_id`` (inclusive),
        newest first, under the history read path's rules."""
        scan = radius * 3

        def _side(predicate, order):
            return session.exec(
                select(MmPost)
                .where(MmPost.channel_id == channel_id)
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

        older_v = [p for p in older if _visible(p)][: radius + 1]
        newer_v = [p for p in newer if _visible(p)][:radius]
        combined = older_v + newer_v
        combined.sort(key=lambda p: p.post_id, reverse=True)
        return TableRead.hydrate_mm_posts(session, combined)

    @staticmethod
    def get_mm_posts_around_for_agent(
        session: Session,
        channel_id: str,
        around_post_id: int,
        radius: int = 25,
    ) -> list[dict]:
        """Agent twin of :meth:`get_mm_posts_around_for_human`: agents see exactly streaming
        and published posts, so the filter is SQL and nothing is over-scanned."""
        radius = max(1, min(radius, 50))
        statuses = ("streaming", "published")

        def _side(predicate, order, cap: int):
            return session.exec(
                select(MmPost)
                .where(MmPost.channel_id == channel_id)
                .where(MmPost.status.in_(statuses))
                .where(predicate)
                .order_by(order)
                .limit(cap)
            ).all()

        older = _side(
            MmPost.post_id <= around_post_id, MmPost.post_id.desc(), radius + 1
        )
        newer = _side(MmPost.post_id > around_post_id, MmPost.post_id.asc(), radius)
        combined = list(older) + list(newer)
        combined.sort(key=lambda p: p.post_id, reverse=True)
        return TableRead.hydrate_mm_posts(session, combined)

    @staticmethod
    def _find_direct_channel(
        session: Session, org_id: str | None, *members: ColumnElement[bool]
    ) -> dict | None:
        """The direct channel with exactly two members, each matching one of ``members``."""
        stmt = select(MmChannel).where(
            MmChannel.channel_type == "direct",
            MmChannel.channel_id.in_(
                select(MmChannelMember.channel_id)
                .group_by(MmChannelMember.channel_id)
                .having(func.count() == 2)
            ),
            *(
                MmChannel.channel_id.in_(select(MmChannelMember.channel_id).where(member))
                for member in members
            ),
        )
        if org_id is not None:
            stmt = stmt.where(MmChannel.org_id == org_id)
        row = session.exec(stmt).first()
        return TableRead._channel_to_dict(row, session) if row else None

    @staticmethod
    def find_dm_channel(session: Session, agent_a: str, agent_b: str) -> dict | None:
        return TableRead._find_direct_channel(
            session, None, MmChannelMember.agent_id == agent_a, MmChannelMember.agent_id == agent_b
        )

    @staticmethod
    def find_dm_channel_human_agent(
        session: Session, human_id: int, agent_id: str, org_id: str
    ) -> dict | None:
        return TableRead._find_direct_channel(
            session, org_id, MmChannelMember.human_id == human_id, MmChannelMember.agent_id == agent_id
        )

    @staticmethod
    def find_dm_channel_human_human(
        session: Session, human_a: int, human_b: int, org_id: str
    ) -> dict | None:
        return TableRead._find_direct_channel(
            session, org_id, MmChannelMember.human_id == human_a, MmChannelMember.human_id == human_b
        )

    @staticmethod
    def _unread_count(
        state: type[HumanChannelState] | type[AgentChannelState],
        author: InstrumentedAttribute,
        reader_id: int | str,
        mention_regex: str | None = None,
    ) -> ScalarSelect[int]:
        """Correlated count of the reader's unread posts in the outer ``MmChannel``: published,
        past the reader's pointer in ``state``, not authored by them, and capped at
        :data:`UNREAD_COUNT_CAP`. The ``IS NULL`` arm keeps the other kind's posts, whose
        author column is NULL and would otherwise compare as unknown."""
        window = (
            select(literal(1))
            .where(MmPost.channel_id == MmChannel.channel_id)
            .where(MmPost.status == "published")
            .where(MmPost.post_id > func.coalesce(state.last_read_post_id, 0))
            .where((author != reader_id) | author.is_(None))
        )
        if mention_regex is not None:
            window = window.where(MmPost.message.op("~*")(mention_regex))
        return (
            select(func.count())
            .select_from(window.limit(UNREAD_COUNT_CAP).correlate(MmChannel, state).subquery())
            .scalar_subquery()
        )

    @staticmethod
    def get_mm_channels_for_human(
        session: Session,
        human_id: int,
        org_id: str | None = None,
    ) -> list[dict]:
        """The sidebar query: every conversation of the viewer with its latest post, read
        state, unread and mention counts, attachment count, author avatar and DM peer, in a
        fixed number of statements. Agent DMs the viewer may no longer contact are dropped."""
        # LATERAL, not GROUP BY: the aggregate scans every post in the deployment, this seeks
        # ix_mm_posts_channel_post once per channel, and both values come from one row.
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
        mention_regex = TableRead._human_mention_match_regex(session, human_id)
        stmt = (
            select(
                MmChannel,
                latest_post.c.created_at.label("last_message_at"),
                latest_post.c.post_id.label("latest_post_id"),
                HumanChannelState.last_read_post_id,
                HumanChannelState.muted_at,
                HumanChannelState.pinned_at,
                TableRead._unread_count(HumanChannelState, MmPost.human_id, human_id).label(
                    "unread_count"
                ),
                TableRead._unread_count(
                    HumanChannelState, MmPost.human_id, human_id, mention_regex
                ).label("unread_mention_count"),
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

        latest_post_ids = [row[2] for row in rows if row[2] is not None]
        attachment_counts = dict(
            session.exec(
                select(MmFile.post_id, func.count(MmFile.file_id))
                .where(MmFile.post_id.in_(latest_post_ids))
                .where(MmFile.status == "uploaded")
                .group_by(MmFile.post_id)
            ).all()
        ) if latest_post_ids else {}
        out = [
            {
                **TableRead._channel_to_dict(c),
                "last_message_at": _iso(last_message_at),
                "latest_post_id": latest_post_id,
                "last_read_post_id": last_read_post_id,
                "muted": muted_at is not None,
                "pinned": pinned_at is not None,
                "unread_count": unread_count,
                "unread_mention_count": unread_mention_count,
                "last_message_attachment_count": attachment_counts.get(latest_post_id, 0),
            }
            for (
                c, last_message_at, latest_post_id, last_read_post_id,
                muted_at, pinned_at, unread_count, unread_mention_count,
            ) in rows
        ]

        uncontactable = TableRead.apply_dm_peers(session, out, human_id)
        author_human_ids = {d["last_message_author_human_id"] for d in out} - {None}
        author_agent_ids = {d["last_message_author_agent_id"] for d in out} - {None}
        human_avatars = {
            hid: avatar_ref_for_user(user_id=hid, version=version, kind=kind).model_dump()
            for hid, version, kind in session.exec(
                select(HumanUser.id, HumanUser.avatar_version, HumanUser.avatar_kind)
                .where(HumanUser.id.in_(author_human_ids))
            ).all()
        } if author_human_ids else {}
        agent_avatars = {
            aid: avatar_ref_for_agent(agent_id=aid, version=version, kind=kind).model_dump()
            for aid, version, kind in session.exec(
                select(Agent.agent_id, Agent.avatar_version, Agent.avatar_kind)
                .where(Agent.agent_id.in_(author_agent_ids))
            ).all()
        } if author_agent_ids else {}
        for d in out:
            d["last_message_author_avatar"] = (
                human_avatars.get(d["last_message_author_human_id"])
                if d["last_message_author_human_id"] is not None
                else agent_avatars.get(d["last_message_author_agent_id"])
            )
        return [d for d in out if d["channel_id"] not in uncontactable]

    @staticmethod
    def apply_dm_peers(
        session: Session, channels: list[dict], viewer_human_id: int
    ) -> set[str]:
        """Resolve each direct channel's other participant in-place, from the
        viewer's side: ``display_name`` becomes the peer's name, ``dm_peer`` the
        peer as :meth:`get_mm_channel_members` returns it (``can_tag`` included
        for an agent), and ``dm_peer_human_id`` or ``dm_peer_agent_id`` its id.
        Presence is the endpoint's to apply. Returns the agent DMs the viewer
        may no longer contact. Two statements for the whole list."""
        direct_ids = [d["channel_id"] for d in channels if d["channel_type"] == "direct"]
        if not direct_ids:
            return set()
        peers: dict[str, MemberRow] = {}
        for row in TableRead._member_rows(
            session,
            MmChannelMember.channel_id.in_(direct_ids),
            MmChannelMember.human_id.is_distinct_from(viewer_human_id),
        ):
            peers.setdefault(row[0].channel_id, row)
        agent_ids = {m.agent_id for m, *_ in peers.values() if m.agent_id is not None}
        grants = {
            g.agent_id: g
            for g in session.exec(
                select(AgentContactPermission)
                .where(AgentContactPermission.agent_id.in_(agent_ids))
                .where(AgentContactPermission.human_id == viewer_human_id)
            ).all()
        } if agent_ids else {}
        uncontactable: set[str] = set()
        for d in channels:
            row = peers.get(d["channel_id"])
            if row is None:
                continue
            m, u, _, a, _, _ = row
            peer = TableRead._member_to_dict(*row)
            name = (u.display_name or u.email) if u else peer["display_name"]
            if name:
                d["display_name"] = name
            if m.agent_id is None:
                d["dm_peer_human_id"] = m.human_id
            else:
                grant = grants.get(m.agent_id)
                operates = a is not None and a.operator_id == viewer_human_id
                peer["can_tag"] = operates or bool(grant and grant.can_tag)
                if not (operates or (grant and grant.can_dm)):
                    uncontactable.add(d["channel_id"])
                d["dm_peer_agent_id"] = m.agent_id
            d["dm_peer"] = peer
        return uncontactable

    @staticmethod
    def get_discoverable_mm_channels(
        session: Session, org_id: str, human_id: int
    ) -> list[dict]:
        """Public channels in ``org_id`` the human has not joined, with ``member_count``."""
        member_of = (
            select(MmChannelMember.channel_id)
            .where(MmChannelMember.human_id == human_id)
            .subquery()
        )
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
        return [
            {**TableRead._channel_to_dict(c, session), "member_count": member_count}
            for c, member_count in rows
        ]

    @staticmethod
    def list_all_mm_channels_in_org(
        session: Session, org_id: str, viewer_human_id: int
    ) -> list[dict]:
        """Every public and private channel in ``org_id``, for the owner's management list.

        A private channel the viewer is not in keeps only non-identifying metadata (member
        count, last activity, type) under a stable opaque name: owners may count and
        moderate private channels, never read their identity or content."""
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
        viewer_member_ids = set(
            session.exec(
                select(MmChannelMember.channel_id)
                .where(MmChannelMember.human_id == viewer_human_id)
            ).all()
        )
        out = []
        for c, member_count, last_message_at in rows:
            d = TableRead._channel_to_dict(c, session)
            d["member_count"] = member_count
            d["last_message_at"] = _iso(last_message_at)
            d["lobstertalk_approved"] = bool(c.lobstertalk_approved)
            if c.channel_type != "public" and c.channel_id not in viewer_member_ids:
                d.update(
                    name=f"Private channel {hashlib.sha256(c.channel_id.encode()).hexdigest()[:6]}",
                    display_name=None,
                    avatar=None,
                    last_message_text=None,
                    last_message_author_human_id=None,
                    last_message_author_agent_id=None,
                    last_message_author_display_name=None,
                    last_message_author_avatar=None,
                )
            out.append(d)
        return out

    @staticmethod
    def get_mm_channel_latest_published_post_id(
        session: Session, channel_id: str
    ) -> int | None:
        return session.exec(
            select(func.max(MmPost.post_id))
            .where(MmPost.channel_id == channel_id)
            .where(MmPost.status == "published")
        ).first()

    @staticmethod
    def get_agent_channel_last_read(
        session: Session, channel_id: str, agent_id: str
    ) -> int | None:
        return session.exec(
            select(AgentChannelState.last_read_post_id)
            .where(AgentChannelState.channel_id == channel_id)
            .where(AgentChannelState.agent_id == agent_id)
        ).first()

    @staticmethod
    def get_mm_channel_post_id_at_or_below(
        session: Session, channel_id: str, post_id: int
    ) -> int | None:
        """Newest existing post id in the channel ``<= post_id``, of any status: resolves a
        read ack whose post was deleted to an id the ``last_read_post_id`` FK accepts."""
        return session.exec(
            select(func.max(MmPost.post_id))
            .where(MmPost.channel_id == channel_id)
            .where(MmPost.post_id <= post_id)
        ).first()

    @staticmethod
    def get_mm_channel_ids_for_human(
        session: Session, human_id: int
    ) -> list[str]:
        return list(session.exec(
            select(MmChannelMember.channel_id)
            .where(MmChannelMember.human_id == human_id)
        ).all())

    @staticmethod
    def get_fellow_human_ids(
        session: Session, human_id: int
    ) -> list[int]:
        """Every other human sharing a channel with ``human_id``, for presence fan-out."""
        shared = (
            select(MmChannelMember.channel_id)
            .where(MmChannelMember.human_id == human_id)
            .subquery()
        )
        return list(session.exec(
            select(MmChannelMember.human_id)
            .where(MmChannelMember.channel_id.in_(select(shared.c.channel_id)))
            .where(MmChannelMember.human_id.is_not(None))
            .where(MmChannelMember.human_id != human_id)
            .distinct()
        ).all())

    @staticmethod
    def get_mm_channel_human_member_ids(
        session: Session, channel_id: str
    ) -> list[int]:
        return list(session.exec(
            select(MmChannelMember.human_id)
            .where(MmChannelMember.channel_id == channel_id)
            .where(MmChannelMember.human_id.is_not(None))
        ).all())

    @staticmethod
    def get_mm_channel_ids_for_agent(
        session: Session, agent_id: str
    ) -> list[str]:
        return list(session.exec(
            select(MmChannelMember.channel_id)
            .where(MmChannelMember.agent_id == agent_id)
        ).all())

    @staticmethod
    def get_human_ids_sharing_channel_with_agent(
        session: Session, agent_id: str
    ) -> list[int]:
        """Every human sharing a channel with ``agent_id``, for liveness fan-out."""
        shared = (
            select(MmChannelMember.channel_id)
            .where(MmChannelMember.agent_id == agent_id)
            .subquery()
        )
        return list(session.exec(
            select(MmChannelMember.human_id)
            .where(MmChannelMember.channel_id.in_(select(shared.c.channel_id)))
            .where(MmChannelMember.human_id.is_not(None))
            .distinct()
        ).all())

    # ---------------- push notifications ----------------

    @staticmethod
    def get_webpush_devices_for_humans(
        session: Session, human_ids: list[int]
    ) -> list[dict]:
        """Enabled web-push subscriptions: endpoint, keys, and the row id for pruning."""
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
    def get_apns_devices_for_humans(
        session: Session, human_ids: list[int]
    ) -> list[dict]:
        if not human_ids:
            return []
        rows = session.exec(
            select(PushDevice)
            .where(PushDevice.human_id.in_(human_ids))
            .where(PushDevice.transport == "apns")
            .where(PushDevice.enabled.is_(True))
        ).all()
        return [
            {"id": r.id, "human_id": r.human_id, "token": r.token}
            for r in rows
        ]

    @staticmethod
    def get_muted_human_ids(
        session: Session, channel_id: str, human_ids: list[int]
    ) -> set[int]:
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
        row = session.get(MmChannel, channel_id)
        if row is None:
            return None
        return {
            "channel_id": row.channel_id,
            "name": row.name,
            "display_name": row.display_name,
            "channel_type": row.channel_type,
        }

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
        session: Session, org_ids: list[str], limit: int = 100, offset: int = 0
    ) -> list[dict]:
        """Action-document metadata, restricted to agents in ``org_ids``.

        See :meth:`get_recent_shared_content` for why the scope is required.
        """
        if not org_ids:
            return []
        rows = session.exec(
            select(AgentAction)
            .join(Agent, Agent.agent_id == AgentAction.agent_id)
            .where(Agent.org_id.in_(org_ids))
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
    def count_agent_actions(session: Session, org_ids: list[str]) -> int:
        """Total actions visible to ``org_ids``.

        Must match :meth:`list_agent_actions`' scope, or pagination reports
        rows the caller cannot read.
        """
        if not org_ids:
            return 0
        count = session.exec(
            select(func.count())
            .select_from(AgentAction)
            .join(Agent, Agent.agent_id == AgentAction.agent_id)
            .where(Agent.org_id.in_(org_ids))
        ).one()
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

    # ---------------- agent marks ----------------

    @staticmethod
    def get_agent_marks(session: Session, agent_id: str) -> list[Mark]:
        """Earned marks, oldest first, each ``detail`` resolved to an org-safe label or None."""
        rows = session.exec(
            select(AgentMark).where(AgentMark.agent_id == agent_id).order_by(AgentMark.earned_at)
        ).all()
        return [
            {
                "kind": row.kind,
                "earned_at": _iso(row.earned_at),
                "detail": TableRead._mark_label(session, row.detail or {}),
            }
            for row in rows
        ]

    @staticmethod
    def _mark_label(session: Session, detail: dict) -> str | None:
        """The human's display name, a public channel's name, or the peer agent's name. Never an
        id, and never a private channel's name."""
        if human_id := detail.get("human_id"):
            return session.exec(
                select(HumanUser.display_name).where(HumanUser.id == human_id)
            ).first()
        if channel_id := detail.get("channel_id"):
            channel = session.get(MmChannel, channel_id)
            if channel is None or channel.channel_type != "public":
                return None
            return channel.display_name or channel.name
        if peer_agent_id := detail.get("peer_agent_id"):
            return session.exec(
                select(func.coalesce(func.nullif(AgentProfile.display_name, ""), Agent.nickname))
                .select_from(Agent)
                .outerjoin(AgentProfile, AgentProfile.agent_id == Agent.agent_id)
                .where(Agent.agent_id == peer_agent_id)
            ).first()
        return None

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
    def _install_counts_by_skill(
        session: Session, skill_ids: list[str]
    ) -> dict[str, tuple[int, int]]:
        """``skill_id -> (agents that have it, agents still moving)``.

        One grouped read for a whole page of skills. ``applied`` is the only
        status that means the agent confirmed the file is on disk, so it is the
        only one that counts as installed; ``requested``/``removing`` are the
        in-flight states and are reported separately rather than folded in. A
        library row must never claim a skill is live somewhere the agent has
        not confirmed.
        """
        if not skill_ids:
            return {}
        # COUNT(DISTINCT CASE ...) rather than a FILTER clause: both back ends
        # we run on understand it, and SQLite only learned FILTER in 3.30.
        def _distinct_when(*statuses: str):
            return func.count(
                func.distinct(
                    case(
                        (
                            AgentSkillInstall.sync_status.in_(statuses),
                            AgentSkillInstall.agent_id,
                        ),
                        else_=None,
                    )
                )
            )

        rows = session.exec(
            select(
                AgentSkillInstall.skill_id,
                _distinct_when("applied"),
                _distinct_when("requested", "removing"),
            )
            .where(
                AgentSkillInstall.skill_id.in_(skill_ids),
                # Same visibility rule as list_agent_skills: an uninstall
                # soft-deletes the row but leaves it 'removing' until the agent
                # confirms, and that pending work has to stay countable.
                or_(
                    AgentSkillInstall.deleted_at.is_(None),
                    AgentSkillInstall.sync_status == "removing",
                ),
            )
            .group_by(AgentSkillInstall.skill_id)
        ).all()
        return {r[0]: (int(r[1] or 0), int(r[2] or 0)) for r in rows}

    @staticmethod
    def _skill_to_dict(
        row: Skill,
        latest: SkillVersion | None = None,
        counts: tuple[int, int] = (0, 0),
    ) -> dict:
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
            # Agents that have CONFIRMED the skill on disk, and agents with an
            # install/removal still in flight. See _install_counts_by_skill.
            "installed_agent_count": counts[0],
            "pending_agent_count": counts[1],
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
        counts = TableRead._install_counts_by_skill(session, [r.skill_id for r in rows])
        return [
            TableRead._skill_to_dict(
                r,
                latest_by_id.get(r.latest_version_id or ""),
                counts.get(r.skill_id, (0, 0)),
            )
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
        counts = TableRead._install_counts_by_skill(session, [row.skill_id])
        out = TableRead._skill_to_dict(row, latest, counts.get(row.skill_id, (0, 0)))
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
            skill = session.get(Skill, row.skill_id) if row.skill_id is not None else None
            absent = (
                row.deleted_at is not None
                or not row.enabled
                # Belt and braces. ``delete_skill`` tombstones its installs, so a
                # live row pointing at a deleted skill means it raced that fan-out.
                # The invariant is that a deleted skill has no desired version -
                # and it has to land here rather than in the resolver, because a
                # resolver miss `continue`s the item, which would leave the
                # directory on the agent forever instead of removing it.
                # KEEP IN STEP with TableWrite._wants_absent.
                or (skill is not None and skill.deleted_at is not None)
            )
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
