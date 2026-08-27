"""Write-side database accessors — SQLModel edition.

Transaction ownership stays with the caller: these methods never call
``session.commit()`` unless the previous sqlite implementation did (which
only happens in a couple of legacy paths).
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import secrets
import uuid as _uuid
from collections.abc import Callable
from datetime import datetime

from eth_account import Account
from eth_account.signers.local import LocalAccount
from eth_utils import to_hex
from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import aliased
from sqlmodel import Session, delete, select, update

from clawbits.avatars.config import CURRENT_AVATAR_VERSION
from clawbits.datastructures.agent_id import AgentId
from clawbits.datastructures.api_key import ApiKey
from clawbits.datastructures.long_name import LongName
from clawbits.datastructures.mm_models import agent_dm_channel_name
from clawbits.datastructures.nickname import NickName
from clawbits.db.models import (
    UNKNOWN_PROVIDER,
    Agent,
    AgentAction,
    AgentChannelState,
    AgentClaim,
    AgentContactPermission,
    AgentPost,
    AgentProfile,
    AgentSignupRequest,
    AgentSkillInstall,
    AgentSkillSyncState,
    AgentUsageDaily,
    AgentUsageEvent,
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


def _as_str(value: object, *, limit: int = 1000) -> str | None:
    """Bounded coercion for agent-reported fields (untrusted, UI-rendered)."""
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value[:limit] if value else None


class UserDeletionBlocked(Exception):
    """Raised when a human account can't be deleted yet because the user still
    holds resources that deletion would orphan — they operate one or more
    agents, or they're the sole owner of an organization that has other
    members. The caller (the account-delete endpoint) maps this to a 409 with
    the message text so the user knows what to clean up first."""


class _Sentinel:
    """Marker for "argument not provided" — distinguishes "leave value
    alone" from "set value to None" in optional-update APIs. Used in
    :meth:`TableWrite.edit_mm_post_human` where ``link_preview`` is
    tri-state (skip / clear / replace)."""
    _instance: _Sentinel | None = None

    def __new__(cls) -> _Sentinel:
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance


_UNSET = _Sentinel()


# Shared placeholder agent that inherits authored content from hard-deleted
# agents whose operator chose to keep their messages (see
# :meth:`TableWrite.delete_agent`). The hyphen makes this id one the
# :class:`~clawbits.datastructures.agent_id.AgentId` validator (alphanumeric
# and underscore only) can never mint, so it can't collide with a real agent.
DELETED_AGENT_ID = "deleted-agent"


# Accepted time window for self-reported usage events. Events older than the
# retention horizon are rejected at ingest — the dedup ledger is pruned past
# it, so re-accepting an old event would double-count. Events beyond the
# future-skew bound are rejected too: ``occurred_at`` is client-supplied, and
# a skewed clock (or hostile client) must not write into future daily buckets
# of the permanent rollup. See ``docs/protocol/AGENT_USAGE_TRACKING_PLAN.md``.
USAGE_EVENT_RETENTION_DAYS = 45
USAGE_EVENT_MAX_FUTURE_SKEW = _dt.timedelta(minutes=10)

# Model-name prefix -> provider, used when a usage report omits the provider.
# Best-effort display dimension only (falls back to ``UNKNOWN_PROVIDER``).
_MODEL_PREFIX_PROVIDERS = (
    ("claude", "anthropic"),
    ("gpt", "openai"),
    ("o1", "openai"),
    ("o3", "openai"),
    ("o4", "openai"),
    ("codex", "openai"),
    ("gemini", "google"),
    ("llama", "meta"),
    ("mistral", "mistral"),
    ("deepseek", "deepseek"),
    ("grok", "xai"),
    ("qwen", "alibaba"),
)


class TableWrite:
    # ---------------- CB tokens ----------------

    @staticmethod
    def mint_cb_tokens(
        session: Session,
        agent_id: AgentId,
        ceiling: int,
        *,
        window_budget: int | None = None,
        window_seconds: int = 86_400,
        now: datetime | None = None,
    ) -> tuple[int, int]:
        """Top the agent's balance up *to* ``ceiling``. Never above, never additive.

        Deliberately idempotent: the proof-of-cognition handshake that calls this
        is repeatable — an agent can ask for a fresh challenge as often as it
        likes, both legs are free (the challenge is a GET, the response is
        billing-exempt) and the answers ship to clients in
        ``clawbits/datastructures/known_answers.py``. An additive mint would
        therefore let any authenticated agent accumulate an unbounded balance and
        opt itself out of the CB_TOKENS write charge entirely. Topping up to a
        fixed ceiling makes repeat handshakes converge instead of stack, so the
        balance is bounded by construction rather than by a counter someone has
        to remember to check.

        The ceiling alone bounds what an agent can *hold*, not what it can
        *spend*: since the handshake is free, an agent could otherwise alternate
        write -> handshake -> refill forever and mint without limit over time.
        So minting is also metered — at most ``window_budget`` tokens may be
        added per rolling ``window_seconds``, tracked on the agent row and
        updated in this same locked transaction. ``window_budget`` defaults to
        ``ceiling``, i.e. one full tank per window, which no well-behaved client
        ever approaches (they mint once at signup and would have to burn the
        entire balance to notice).

        Exhausting the budget is deliberately *not* an error: the mint simply
        adds nothing and reports ``minted == 0``. Returning a new failure status
        here would break every client — none of them handle 402 on this route
        and all three retry the challenge 16x with no backoff — whereas an
        agent that has genuinely burned its budget just runs out of tokens and
        gets the ordinary 402 on its next write, which is the intended economics.

        Writing a constant (rather than a computed delta) is also what makes this
        race-safe: two concurrent handshakes both land on ``ceiling``. The row
        lock is for consistency with :meth:`charge_cb_tokens`, not correctness.

        Returns ``(new_balance, minted)``. ``minted`` is computed here, while
        the row lock is held, rather than by the caller diffing against a
        balance it read beforehand: that read would sit outside the lock, so
        two concurrent handshakes could both report the full amount when only
        one of them actually added anything.
        """
        if ceiling <= 0:
            raise ValueError("Mint ceiling must be positive")
        if window_budget is None:
            window_budget = ceiling
        if window_budget <= 0:
            raise ValueError("Mint window budget must be positive")
        if window_seconds <= 0:
            raise ValueError("Mint window must be positive")
        now = now or datetime.now(_dt.UTC)

        row = session.get(Agent, agent_id.value, with_for_update=True)
        if row is None:
            raise ValueError(f"Agent '{agent_id.value}' not found")

        # Reset the window when it has elapsed (or never opened). A NULL start
        # means this agent has never minted, so it starts a fresh window here.
        start = row.cb_tokens_minted_window_start
        if start is None or (now - start).total_seconds() >= window_seconds:
            start, spent = now, 0
        else:
            spent = row.cb_tokens_minted_in_window

        # Top up toward the ceiling, but never by more than the window allows.
        previous = row.cb_tokens
        headroom = max(0, window_budget - spent)
        target = min(ceiling, previous + headroom)
        if target > previous:
            row.cb_tokens = target
        minted = row.cb_tokens - previous

        row.cb_tokens_minted_window_start = start
        row.cb_tokens_minted_in_window = spent + minted
        session.flush()
        return row.cb_tokens, minted

    @staticmethod
    def charge_cb_tokens(session: Session, agent_id: AgentId, amount: int) -> int:
        if amount <= 0:
            raise ValueError("Charge amount must be positive")

        # FOR UPDATE before the sufficiency check: the flush below emits
        # ``SET cb_tokens = <computed literal>``, not ``cb_tokens - :n``, so
        # under READ COMMITTED two concurrent debits would both read the same
        # balance, both pass the check, and the second UPDATE would clobber the
        # first — N operations performed for one paid. Each billing site opens
        # its own session on a separate pooled connection, so agent requests do
        # genuinely run in parallel. Locking the row serialises them.
        row = session.get(Agent, agent_id.value, with_for_update=True)
        if row is None:
            raise ValueError(f"Agent '{agent_id.value}' not found")

        if row.cb_tokens < amount:
            raise ValueError(f"Insufficient CB_TOKENS: have {row.cb_tokens}, need {amount}")

        row.cb_tokens -= amount
        session.flush()
        return row.cb_tokens

    # ---------------- agents ----------------

    @staticmethod
    def create_agent(
        session: Session,
        agent_id: AgentId,
        nickname: NickName,
        long_name: LongName = LongName(""),
    ) -> str:
        acct: LocalAccount = Account.create()
        key_hex: str = to_hex(acct.key)
        api_key: str = ApiKey.generate().value

        api_key_hash = hashlib.sha256(api_key.encode()).hexdigest()
        creation_time = _dt.datetime.now(_dt.UTC)

        session.add(
            Agent(
                agent_id=agent_id.value,
                api_key_hash=api_key_hash,
                eth_private_key=key_hex,
                nickname=nickname.value,
                long_name=long_name.value,
                creation_time=creation_time,
                # Start new rows at the current avatar generation so the
                # URL the response returns points at the bytes the
                # creation-hook is about to upload. (The column default
                # is still 1 in the DB; this overrides it.)
                avatar_version=CURRENT_AVATAR_VERSION,
            )
        )
        session.flush()
        # Seed a friendly placeholder description so a brand-new agent has
        # something on its card until it generates a real one agent-side.
        # Deterministic per agent_id so it's stable across re-reads/tests.
        _placeholders = (
            "A fresh Clawbot, still finding its specialty.",
            "Newly hatched — learning what it does best.",
            "A brand-new agent, yet to discover its calling.",
            "Just arrived. Still figuring out its niche.",
            "A new Clawbot warming up — description coming soon.",
        )
        _idx = int(hashlib.sha256(agent_id.value.encode()).hexdigest(), 16) % len(
            _placeholders
        )
        session.add(
            AgentProfile(
                agent_id=agent_id.value,
                description=_placeholders[_idx],
                description_source="default",
                updated_at=creation_time,
            )
        )
        session.flush()
        return api_key

    @staticmethod
    def set_agent_reef_sandbox(
        session: Session, agent_id: str, sandbox_id: str
    ) -> None:
        """Record the reef VM an agent runs in (set at signup-commit for the
        'Run on Reef' flow). Best-effort: a missing row is a no-op."""
        row = session.get(Agent, agent_id)
        if row is not None:
            row.reef_sandbox_id = sandbox_id
            session.flush()

    @staticmethod
    def rotate_api_key(session: Session, old_api_key: str) -> tuple[str, str]:
        old_api_key_hash = hashlib.sha256(old_api_key.encode()).hexdigest()

        row = session.exec(
            select(Agent).where(Agent.api_key_hash == old_api_key_hash)
        ).first()
        if row is None:
            raise ValueError("Invalid API key")
        agent_id = row.agent_id

        new_api_key = ApiKey.generate().value
        new_api_key_hash = hashlib.sha256(new_api_key.encode()).hexdigest()
        row.api_key_hash = new_api_key_hash
        session.flush()
        return agent_id, new_api_key

    # ---------------- share records ----------------

    @staticmethod
    def create_share_record(
        session: Session,
        agent_id: AgentId,
        filename: str,
        object_key: str,
        url: str,
        content_type: str | None = None,
        size: int | None = None,
    ) -> None:
        session.add(
            ShareRecord(
                agent_id=agent_id.value,
                filename=filename,
                object_key=object_key,
                url=url,
                content_type=content_type,
                size=size,
            )
        )
        session.flush()

    @staticmethod
    def mark_share_deleted(
        session: Session, agent_id: AgentId, filename: str
    ) -> None:
        now = _dt.datetime.now(_dt.UTC)
        rows = session.exec(
            select(ShareRecord)
            .where(ShareRecord.agent_id == agent_id.value)
            .where(ShareRecord.filename == filename)
            .where(ShareRecord.deleted_at.is_(None))
        ).all()
        for row in rows:
            row.deleted_at = now
        session.flush()

    # ---------------- challenge sessions ----------------

    @staticmethod
    def create_challenge_session(
        session: Session,
        session_token: str,
        question: str,
        answer: str,
        expires_at: datetime,
        owner_email: str | None = None,
        org_id: str | None = None,
        human_id: int | None = None,
    ) -> None:
        session.add(
            ChallengeSession(
                session_token=session_token,
                question=question,
                answer=answer,
                expires_at=expires_at,
                used=False,
                owner_email=owner_email,
                org_id=org_id,
                human_id=human_id,
            )
        )
        session.flush()

    @staticmethod
    def mark_challenge_session_used(session: Session, session_token: str) -> None:
        row = session.get(ChallengeSession, session_token)
        if row is not None:
            row.used = True
            session.flush()

    @staticmethod
    def set_challenge_reef_sandbox(
        session: Session, session_token: str, sandbox_id: str
    ) -> bool:
        """Record which reef VM a pending signup session provisioned, so
        signup-commit can copy it onto the resulting agent. Returns False when
        the session doesn't exist (the caller 404s)."""
        row = session.get(ChallengeSession, session_token)
        if row is None:
            return False
        row.reef_sandbox_id = sandbox_id
        session.flush()
        return True

    @staticmethod
    def cleanup_expired_challenge_sessions(session: Session, now: datetime) -> None:
        session.exec(
            delete(ChallengeSession).where(ChallengeSession.expires_at < now)
        )
        session.flush()

    @staticmethod
    def delete_challenge_session(session: Session, session_token: str) -> None:
        row = session.get(ChallengeSession, session_token)
        if row is not None:
            session.delete(row)
            session.flush()

    # ---------------- human users ----------------

    @staticmethod
    def create_human_user(
        session: Session,
        email: str,
        workos_user_id: str,
        display_name: str | None = None,
    ) -> int:
        user = HumanUser(
            email=email,
            workos_user_id=workos_user_id,
            display_name=display_name,
            avatar_version=CURRENT_AVATAR_VERSION,
        )
        session.add(user)
        session.flush()
        return user.id

    # ---------------- human api tokens (PATs) ----------------

    # Ceiling on live tokens per user. High enough that nobody legitimate
    # hits it, low enough that a leaked minting credential can't spray
    # thousands of durable footholds.
    HUMAN_API_TOKEN_CAP = 25

    @staticmethod
    def create_human_api_token(
        session: Session,
        human_id: int,
        label: str,
        expires_at: _dt.datetime | None = None,
    ) -> tuple[int, str]:
        """Mint a personal access token. Returns ``(token_id, plaintext)``.

        The plaintext exists only in this return value — the row keeps the
        SHA-256 and a display hint. ``cbp_`` (ClawBits Personal) is the
        namespace: agent keys are ``fc_`` + 16 alnum, and the human auth
        resolver only consults this table for bearers carrying this prefix,
        so neither credential is ever looked up in the other's table.
        """
        count = len(
            session.exec(
                select(HumanApiToken.id).where(HumanApiToken.human_id == human_id)
            ).all()
        )
        if count >= TableWrite.HUMAN_API_TOKEN_CAP:
            raise ValueError(
                f"Token limit reached ({TableWrite.HUMAN_API_TOKEN_CAP}). "
                "Revoke one you no longer use first."
            )

        plaintext = "cbp_" + secrets.token_urlsafe(32)
        row = HumanApiToken(
            human_id=human_id,
            token_hash=hashlib.sha256(plaintext.encode()).hexdigest(),
            token_hint=plaintext[:8],
            label=label,
            expires_at=expires_at,
        )
        session.add(row)
        session.flush()
        return row.id, plaintext

    @staticmethod
    def delete_human_api_token(session: Session, human_id: int, token_id: int) -> bool:
        """Revoke one of the caller's own tokens. False if it isn't theirs —
        the endpoint turns that into a 404, indistinguishable from
        "no such token" so ids can't be probed across accounts."""
        row = session.get(HumanApiToken, token_id)
        if row is None or row.human_id != human_id:
            return False
        session.delete(row)
        session.flush()
        return True

    @staticmethod
    def touch_human_api_token_last_used(session: Session, token_id: int) -> None:
        """Stamp ``last_used_at``, at most once a minute (the resolver runs on
        every request; a write per request would be pure amplification)."""
        row = session.get(HumanApiToken, token_id)
        if row is None:
            return
        now = _dt.datetime.now(_dt.UTC)
        if row.last_used_at is not None and (now - row.last_used_at).total_seconds() < 60:
            return
        row.last_used_at = now
        session.add(row)
        session.flush()

    # ---------------- push devices ----------------

    @staticmethod
    def upsert_push_device(
        session: Session,
        human_id: int,
        token: str,
        transport: str,
        p256dh: str | None = None,
        auth: str | None = None,
        user_agent: str | None = None,
        app: str = "web",
    ) -> int:
        """Insert or refresh a push subscription, keyed on ``token``.

        ``transport`` is "webpush" (browser subscription endpoint; the
        p256dh/auth keys are required) or "apns" (iOS device token; key
        columns stay NULL). Re-subscribing yields the same token, so we
        update the existing row in place — re-enabling it, refreshing the
        keys + last_seen — rather than accumulating duplicates. Caller owns
        the commit.

        An existing row belonging to *someone else* is deleted and replaced
        rather than re-bound, so a caller never takes over a row it did not
        register. Rebinding used to be unconditional.

        Read the limit of that honestly: because ``uq_push_devices_token``
        keys on the token alone, only one row can exist per endpoint, so the
        *end state* is the same either way — whoever subscribed last owns the
        endpoint and the previous owner has nothing. Someone who learns a
        victim's endpoint URL (a shared device, a client log, a proxy) can
        therefore still evict them. What changes here is only that the row is
        destroyed rather than repurposed. Closing the eviction itself needs
        the natural key to become ``(human_id, token)``, which is a migration
        and is not done here."""
        now = datetime.now(_dt.UTC)
        existing = session.exec(
            select(PushDevice).where(PushDevice.token == token)
        ).first()
        if existing is not None and existing.human_id != human_id:
            # Not ours to refresh — drop it and fall through to a fresh insert.
            session.delete(existing)
            session.flush()
            existing = None
        if existing is not None:
            existing.transport = transport
            existing.p256dh = p256dh
            existing.auth = auth
            existing.app = app
            existing.user_agent = user_agent
            existing.enabled = True
            existing.last_seen_at = now
            session.add(existing)
            session.flush()
            return existing.id
        device = PushDevice(
            human_id=human_id,
            transport=transport,
            token=token,
            p256dh=p256dh,
            auth=auth,
            app=app,
            user_agent=user_agent,
            enabled=True,
            last_seen_at=now,
        )
        session.add(device)
        session.flush()
        return device.id

    @staticmethod
    def delete_push_device_by_token(
        session: Session, token: str, human_id: int | None = None
    ) -> int:
        """Remove a subscription on unsubscribe. Scoped to ``human_id`` when
        given so one user can't delete another's device. Returns the number
        of rows removed. Caller owns the commit."""
        stmt = select(PushDevice).where(PushDevice.token == token)
        if human_id is not None:
            stmt = stmt.where(PushDevice.human_id == human_id)
        rows = session.exec(stmt).all()
        for row in rows:
            session.delete(row)
        return len(rows)

    @staticmethod
    def prune_push_devices(session: Session, device_ids: list[int]) -> int:
        """Delete devices whose push service reported the subscription gone
        (HTTP 404/410). Returns the number removed. Caller owns the commit."""
        if not device_ids:
            return 0
        rows = session.exec(
            select(PushDevice).where(PushDevice.id.in_(device_ids))
        ).all()
        for row in rows:
            session.delete(row)
        return len(rows)

    @staticmethod
    def update_human_display_name(
        session: Session, human_id: int, display_name: str | None
    ) -> None:
        row = session.get(HumanUser, human_id)
        if row is not None:
            row.display_name = display_name
            session.flush()

    @staticmethod
    def touch_human_last_seen(
        session: Session, human_id: int, when: datetime | None = None
    ) -> None:
        """Bump ``last_seen_at`` to ``when`` (defaults to now). Used by the
        presence endpoint on status transitions and every ~5 min while
        the user is online — see the throttle in
        ``presence_user_heartbeat``.

        Privacy is enforced at the *read* boundary now (see the
        bucketed ``last_seen_label`` on presence responses), so this
        always advances ``last_seen_at`` regardless of the user's
        privacy settings — the bucketing logic just hides precision
        from peers.
        """
        row = session.get(HumanUser, human_id)
        if row is not None:
            row.last_seen_at = when or datetime.now(_dt.UTC)
            session.flush()

    @staticmethod
    def touch_agent_last_alive(
        session: Session,
        agent_id: str,
        when: datetime | None = None,
        *,
        agent_type: str | None = None,
        plugin_version: str | None = None,
    ) -> datetime:
        """Bump an agent's ``last_alive_at`` to ``when`` (defaults to now) and
        return the stored value. Called by ``POST /api/agentic/alive`` on every
        liveness ping from the agent's plugin.

        Also folds in the agent's self-reported metadata when the ping carries
        it: ``agent_type`` (runtime kind, from the body) and ``plugin_version``
        (from the ``X-Clawbits-Plugin-Version`` header). Each is written only
        when non-None, so an older plugin that pings with no body never wipes a
        previously-reported value.

        Unlike the human heartbeat (every 30-60s, hence Redis-throttled) the
        plugin pings on the order of minutes, so one unconditional row update
        per ping is cheap — no throttle needed. Returns the timestamp so the
        endpoint can echo it without a re-read.
        """
        ts = when or datetime.now(_dt.UTC)
        row = session.get(Agent, agent_id)
        if row is not None:
            row.last_alive_at = ts
            if agent_type is not None:
                row.agent_type = agent_type
            if plugin_version is not None:
                row.plugin_version = plugin_version
            session.flush()
        return ts

    @staticmethod
    def set_human_privacy_mode(
        session: Session,
        human_id: int,
        enabled: bool,
        when: datetime | None = None,
    ) -> HumanUser:
        """Legacy single-toggle privacy. Flips all four granular flags
        atomically (everything hidden / everything visible) so older
        clients calling ``POST /api/human/privacy-mode`` still see the
        same coarse behaviour. New clients should use
        :py:meth:`set_human_privacy_settings`.
        """
        del when  # the freeze target is no longer used; signature kept for ABI
        row = session.get(HumanUser, human_id)
        if row is None:
            raise ValueError(f"Human user '{human_id}' not found")
        row.privacy_mode_enabled = enabled
        visible = not enabled
        row.last_seen_visible = visible
        row.online_status_visible = visible
        row.read_receipts_enabled = visible
        row.typing_indicators_enabled = visible
        session.flush()
        return row

    @staticmethod
    def set_human_privacy_settings(
        session: Session,
        human_id: int,
        *,
        last_seen_visible: bool | None = None,
        online_status_visible: bool | None = None,
        read_receipts_enabled: bool | None = None,
        typing_indicators_enabled: bool | None = None,
    ) -> HumanUser:
        """Apply a partial update to the four granular privacy flags.

        Only the keyword arguments explicitly set (non-None) are
        written, so callers can flip one flag without racing concurrent
        edits of the others. ``privacy_mode_enabled`` is kept in sync
        as a derived "all four hidden" flag so the legacy endpoint
        keeps reporting the right thing.
        """
        row = session.get(HumanUser, human_id)
        if row is None:
            raise ValueError(f"Human user '{human_id}' not found")
        if last_seen_visible is not None:
            row.last_seen_visible = last_seen_visible
        if online_status_visible is not None:
            row.online_status_visible = online_status_visible
        if read_receipts_enabled is not None:
            row.read_receipts_enabled = read_receipts_enabled
        if typing_indicators_enabled is not None:
            row.typing_indicators_enabled = typing_indicators_enabled
        # ``privacy_mode_enabled`` mirrors the legacy single-toggle
        # semantics: True only when *every* per-signal flag is hidden
        # (the equivalent of having called ``set_human_privacy_mode(True)``).
        # Hiding a single signal leaves it False — the user still has
        # most signals visible.
        row.privacy_mode_enabled = not (
            row.last_seen_visible
            or row.online_status_visible
            or row.read_receipts_enabled
            or row.typing_indicators_enabled
        )
        session.flush()
        return row

    @staticmethod
    def upsert_human_connector(
        session: Session,
        *,
        human_id: int,
        provider: str,
        external_id: str,
        handle: str | None = None,
        display_name: str | None = None,
        avatar_url: str | None = None,
        provider_metadata: dict | None = None,
    ) -> HumanConnector:
        """Insert or update a connector row for ``(human_id, provider)``.

        Raises :class:`ValueError` with a stable code prefix when another
        human already owns ``(provider, external_id)``.
        """
        conflict = session.exec(
            select(HumanConnector).where(
                HumanConnector.provider == provider,
                HumanConnector.external_id == external_id,
                HumanConnector.human_id != human_id,
            )
        ).first()
        if conflict is not None:
            raise ValueError(
                "connector_external_id_taken:"
                f"{provider}:{external_id}"
            )

        row = session.exec(
            select(HumanConnector).where(
                HumanConnector.human_id == human_id,
                HumanConnector.provider == provider,
            )
        ).first()
        if row is None:
            row = HumanConnector(
                human_id=human_id,
                provider=provider,
                external_id=external_id,
                handle=handle,
                display_name=display_name,
                avatar_url=avatar_url,
                provider_metadata=provider_metadata,
            )
            session.add(row)
        else:
            row.external_id = external_id
            row.handle = handle
            row.display_name = display_name
            row.avatar_url = avatar_url
            row.provider_metadata = provider_metadata
        session.flush()
        return row

    @staticmethod
    def delete_human_connector(
        session: Session, *, human_id: int, provider: str,
    ) -> bool:
        """Delete a connector row. Returns True if a row was removed."""
        row = session.exec(
            select(HumanConnector).where(
                HumanConnector.human_id == human_id,
                HumanConnector.provider == provider,
            )
        ).first()
        if row is None:
            return False
        session.delete(row)
        session.flush()
        return True

    @staticmethod
    def rebind_human_workos_id(
        session: Session, human_id: int, workos_user_id: str
    ) -> None:
        """Update the WorkOS id on an existing local user.

        Used by the WorkOS provisioning path when a row already exists for
        the same email (e.g. originally created by dev-auth with a
        ``dev:`` placeholder id). Identity is the email; the WorkOS id is
        late-bound on first real sign-in.
        """
        row = session.get(HumanUser, human_id)
        if row is not None:
            row.workos_user_id = workos_user_id
            session.flush()

    # ---------------- agent posts / likes / comments ----------------

    @staticmethod
    def create_agent_post(
        session: Session, agent_id: AgentId, message_type: str, message: str
    ) -> int:
        post = AgentPost(
            agent_id=agent_id.value, message_type=message_type, message=message
        )
        session.add(post)
        session.flush()
        return post.post_id

    @staticmethod
    def create_post_like(
        session: Session,
        post_id: int,
        human_id: int | None = None,
        agent_id: str | None = None,
    ) -> None:
        if human_id is not None:
            existing = session.exec(
                select(PostLike)
                .where(PostLike.post_id == post_id)
                .where(PostLike.human_id == human_id)
            ).first()
        elif agent_id is not None:
            existing = session.exec(
                select(PostLike)
                .where(PostLike.post_id == post_id)
                .where(PostLike.agent_id == agent_id)
            ).first()
        else:
            return

        if existing is None:
            session.add(PostLike(post_id=post_id, human_id=human_id, agent_id=agent_id))
            session.flush()

    @staticmethod
    def delete_post_like(
        session: Session,
        post_id: int,
        human_id: int | None = None,
        agent_id: str | None = None,
    ) -> None:
        if human_id is not None:
            session.exec(
                delete(PostLike)
                .where(PostLike.post_id == post_id)
                .where(PostLike.human_id == human_id)
            )
        elif agent_id is not None:
            session.exec(
                delete(PostLike)
                .where(PostLike.post_id == post_id)
                .where(PostLike.agent_id == agent_id)
            )
        session.flush()

    @staticmethod
    def create_post_comment(
        session: Session,
        post_id: int,
        message: str,
        human_id: int | None = None,
        agent_id: str | None = None,
    ) -> int:
        comment = PostComment(
            post_id=post_id, human_id=human_id, agent_id=agent_id, message=message
        )
        session.add(comment)
        session.flush()
        return comment.id

    # ---------------- agent org / operator ----------------

    @staticmethod
    def set_agent_org_and_operator(
        session: Session, agent_id: str, org_id: str, operator_id: int
    ) -> None:
        """Bind the agent to its single org and record the human operator.

        Called once at signup approval. Idempotent: re-running with the
        same values is a no-op.
        """
        agent = session.get(Agent, agent_id)
        if agent is None:
            raise ValueError(f"Agent '{agent_id}' not found")
        agent.org_id = org_id
        agent.operator_id = operator_id
        session.flush()

    @staticmethod
    def delete_agent(
        session: Session,
        agent_id: str,
        *,
        keep_content: bool = False,
        actor_human_id: int | None = None,
    ) -> list[dict]:
        """Hard-delete an agent and every row that references it.

        Returns the "left the channel" timeline events emitted on the way out
        (see :meth:`_emit_agent_departure_events`), one per group channel the
        agent belonged to, each as
        ``{"channel_id", "event", "member_human_ids"}`` so the caller can fan
        them out over SSE after it commits. Empty when the agent didn't exist.

        FK constraints on child tables are NOT ON DELETE CASCADE, so we
        clear them manually in dependency order before dropping the
        ``agents`` row itself.

        When ``keep_content`` is true the agent's *authored content* —
        channel/DM messages, social posts, files, reactions, comments, and
        likes — is re-pointed to the shared ``deleted-agent`` placeholder
        rather than deleted, so conversation history survives (attributed to
        "Deleted agent") for the other members who shared those channels. The
        agent's identity, membership, audit, and ownership rows are still
        removed. The default (false) deletes everything, as before.

        DM (direct) channels the agent took part in are treated as a unit:
        kept and re-homed to the placeholder when ``keep_content`` is true,
        and torn down entirely (the whole two-party conversation) when it is
        false.
        """
        agent = session.get(Agent, agent_id)
        if agent is None:
            return []

        # Leave the departure line behind first: it needs the memberships and
        # the agent's display name, both of which are gone by the end of this
        # method.
        departures = TableWrite._emit_agent_departure_events(
            session, agent, actor_human_id
        )

        # Contact grants referencing this agent — as the contacted agent
        # (``agent_id``) or as a principal in someone else's allowlist
        # (``principal_agent_id``) — have no ON DELETE cascade, so clear them
        # before the ``agents`` row goes. Runs on both the keep-content and
        # full-delete paths (both end in ``session.delete(agent)``).
        session.exec(
            delete(AgentContactPermission).where(
                AgentContactPermission.agent_id == agent_id
            )
        )
        session.exec(
            delete(AgentContactPermission).where(
                AgentContactPermission.principal_agent_id == agent_id
            )
        )

        # Automations and their run history reference the agent through NOT
        # NULL ``agent_id`` FKs with no ON DELETE cascade, so they block the
        # ``agents`` delete if left behind. Clear them here (before the
        # keep-content branch) so both paths are covered: an automation is the
        # agent's own control-plane state, not authored content to re-home.
        # Runs go first — ``automation_runs.automation_id`` references
        # ``automations``, so the child rows must precede their parent.
        session.exec(
            delete(AutomationRun).where(AutomationRun.agent_id == agent_id)
        )
        session.exec(delete(Automation).where(Automation.agent_id == agent_id))

        # Usage telemetry rows carry the same NOT NULL ``agent_id`` FK with no
        # cascade; like automations they're the agent's own control-plane
        # state, not authored content, so both delete paths drop them.
        session.exec(
            delete(AgentUsageEvent).where(AgentUsageEvent.agent_id == agent_id)
        )
        session.exec(
            delete(AgentUsageDaily).where(AgentUsageDaily.agent_id == agent_id)
        )

        # The skills sync plane (mirrored installs + the per-agent sync state
        # every self-report writes) FKs the agent with no cascade either. Like
        # automations and usage it's control-plane state rather than authored
        # content, so both delete paths drop it -- and because the sync-state
        # row exists for every agent whose plugin ever reported, leaving it
        # behind makes essentially every agent undeletable.
        session.exec(
            delete(AgentSkillInstall).where(AgentSkillInstall.agent_id == agent_id)
        )
        session.exec(
            delete(AgentSkillSyncState).where(AgentSkillSyncState.agent_id == agent_id)
        )

        if keep_content:
            TableWrite._delete_agent_keep_content(session, agent)
            return departures

        # DMs are private two-party conversations; on a full delete the whole
        # channel goes (its posts, members, files, events, and read state),
        # not just the agent's half — there's no one left to keep it for.
        for dm_id in TableWrite._agent_dm_channel_ids(session, agent_id):
            TableWrite.delete_mm_channel(session, dm_id)

        # Channel posts → reactions → files → posts → memberships → channels
        # the agent created live in a graph too dense to delete piecemeal
        # here; for now we restrict cleanup to the directly-attached rows
        # the FK actually forbids leaving dangling. (Channel-side artifacts
        # remain readable to other org members until a separate sweep.)
        session.exec(
            delete(MmPostReaction).where(MmPostReaction.agent_id == agent_id)
        )
        # Two FKs to mm_posts.post_id have neither CASCADE nor SET NULL on
        # them, so the agent's mm_posts can't be deleted while either still
        # references them. Clear those first:
        #   - human_channel_state.last_read_post_id (read-pointer cursors)
        #   - mm_posts.parent_post_id (reply chains anchored on this post)
        agent_post_ids_subq = select(MmPost.post_id).where(MmPost.agent_id == agent_id)
        # Read pointers parked on one of the agent's posts get *rewound* to
        # the newest surviving post before it, not nulled: NULL reads as
        # "never read anything" (``coalesce(last_read_post_id, 0)`` in the
        # unread query), which would re-mark the entire history unread for
        # every member whose last read happened to be the agent's message —
        # a phantom unread badge in every channel the agent talked in, with
        # nothing new in it to explain the badge.
        stale_pointers = session.exec(
            select(HumanChannelState).where(
                HumanChannelState.last_read_post_id.in_(agent_post_ids_subq)
            )
        ).all()
        for state in stale_pointers:
            state.last_read_post_id = session.exec(
                select(func.max(MmPost.post_id))
                .where(MmPost.channel_id == state.channel_id)
                .where(MmPost.post_id < state.last_read_post_id)
                # Skip the agent's own earlier posts — they're about to go
                # too, and the FK would reject the pointer.
                .where(MmPost.agent_id.is_distinct_from(agent_id))
            ).one()
            session.add(state)
        # Same rewind for OTHER agents' read pointers (same FK, same phantom-
        # unread hazard: a nulled pointer would replay the whole channel as a
        # restart backlog for every agent whose last settled turn answered
        # this agent).
        stale_agent_pointers = session.exec(
            select(AgentChannelState)
            .where(AgentChannelState.last_read_post_id.in_(agent_post_ids_subq))
            # The agent's own rows are bulk-deleted just below — rewinding
            # them too would leave dirty ORM instances behind a bulk DELETE,
            # which explodes at flush with a zero-row UPDATE.
            .where(AgentChannelState.agent_id != agent_id)
        ).all()
        for state in stale_agent_pointers:
            state.last_read_post_id = session.exec(
                select(func.max(MmPost.post_id))
                .where(MmPost.channel_id == state.channel_id)
                .where(MmPost.post_id < state.last_read_post_id)
                .where(MmPost.agent_id.is_distinct_from(agent_id))
            ).one()
            session.add(state)
        # The deleted agent's own read pointers go outright (FK on agent_id).
        session.exec(
            delete(AgentChannelState).where(AgentChannelState.agent_id == agent_id)
        )
        session.exec(
            update(MmPost)
            .where(MmPost.parent_post_id.in_(agent_post_ids_subq))
            .values(parent_post_id=None)
        )
        session.exec(delete(MmPost).where(MmPost.agent_id == agent_id))
        session.exec(
            delete(MmChannelMember).where(MmChannelMember.agent_id == agent_id)
        )
        # The channel event log (member.added / member.removed) references the
        # agent twice — as the actor who performed the change and as the
        # subject it was performed on. Both FKs are plain NO ACTION, so either
        # one left dangling blocks the agent delete. Drop the rows rather than
        # null them: an actor-only agent row can't be nulled (it would break
        # the actor_human_id IS NOT NULL OR actor_agent_id IS NOT NULL check),
        # and a subject-less membership event carries no meaning once the agent
        # is gone — these are pure history about the agent being removed.
        session.exec(
            delete(MmChannelEvent).where(MmChannelEvent.subject_agent_id == agent_id)
        )
        session.exec(
            delete(MmChannelEvent).where(MmChannelEvent.actor_agent_id == agent_id)
        )
        session.exec(
            delete(MmFile).where(MmFile.uploader_agent_id == agent_id)
        )
        # Channels the agent created — and channels where the agent
        # authored the most recent post (denormalised sidebar preview) —
        # both reference the agent. Null both rather than cascade-delete
        # the channel itself, which would yank it out from under any
        # other members.
        rows = session.exec(
            select(MmChannel).where(MmChannel.created_by_agent == agent_id)
        ).all()
        for row in rows:
            row.created_by_agent = None
        # Channels whose sidebar preview pointed at one of this agent's
        # (now-deleted) posts: rebuild the preview from whatever published
        # post survives, so the row doesn't show a dangling message. Runs
        # after the agent's mm_posts were deleted above, so the recompute
        # can't re-pick them.
        preview_channel_ids = list(session.exec(
            select(MmChannel.channel_id).where(
                MmChannel.last_message_author_agent_id == agent_id
            )
        ).all())
        for cid in preview_channel_ids:
            TableWrite._recompute_channel_preview(session, cid)
        session.exec(
            delete(PostComment).where(PostComment.agent_id == agent_id)
        )
        session.exec(delete(PostLike).where(PostLike.agent_id == agent_id))
        session.exec(delete(AgentPost).where(AgentPost.agent_id == agent_id))
        session.exec(delete(ShareRecord).where(ShareRecord.agent_id == agent_id))
        session.exec(
            delete(Repository).where(Repository.created_by_agent == agent_id)
        )
        session.exec(delete(AgentAction).where(AgentAction.agent_id == agent_id))
        session.exec(delete(AgentProfile).where(AgentProfile.agent_id == agent_id))
        session.exec(
            delete(AgentSignupRequest).where(AgentSignupRequest.agent_id == agent_id)
        )
        session.exec(delete(AgentClaim).where(AgentClaim.agent_id == agent_id))

        session.delete(agent)
        session.flush()
        return departures

    @staticmethod
    def _emit_agent_departure_events(
        session: Session, agent: Agent, actor_human_id: int | None
    ) -> list[dict]:
        """Leave a "X left the channel" line in every group channel the agent
        belonged to, before its memberships and identity rows are dropped.

        The point is that a deleted agent shouldn't just evaporate out of
        other people's channels: without this the only trace of the departure
        is a member disappearing from the roster, which reads as "something
        happened, no idea what".

        The event can't name the agent through ``subject_agent_id`` — that FK
        is plain NO ACTION and the row is about to be deleted, so the event
        would be deleted right along with it. The id and display name ride in
        ``payload`` instead (the "carry data an FK can't outlive" slot the
        column was reserved for), and the renderer prefers it over the
        subject columns. The actor is the human who asked for the deletion
        (falling back to the agent's operator) so the row still satisfies the
        actor NOT NULL check; with neither we skip the line rather than write
        a row that violates it.

        DMs are skipped by :meth:`create_mm_channel_event` (1:1s carry no
        membership chrome) — on the default delete path they're torn down
        whole anyway, and on the keep-content path the conversation survives
        under the "Deleted agent" placeholder.

        Returns one ``{"channel_id", "event", "member_human_ids"}`` dict per
        emitted event, hydrated for the SSE fan-out the caller performs after
        it commits.
        """
        from clawbits.db.table_read import TableRead

        actor = actor_human_id if actor_human_id is not None else agent.operator_id
        if actor is None:
            return []
        display = TableRead.resolve_agent_display(session, agent.agent_id)
        channel_ids = list(
            session.exec(
                select(MmChannelMember.channel_id).where(
                    MmChannelMember.agent_id == agent.agent_id
                )
            ).all()
        )
        emitted: list[dict] = []
        for channel_id in channel_ids:
            event_id = TableWrite.create_mm_channel_event(
                session,
                channel_id,
                "member.removed",
                actor_human_id=actor,
                payload={
                    "subject_kind": "agent",
                    "subject_agent_id": agent.agent_id,
                    "subject_display_name": display,
                    "reason": "agent_deleted",
                },
            )
            if not event_id:  # DM — events suppressed there
                continue
            event = TableRead.get_mm_channel_event_by_id(session, event_id)
            if event is None:
                continue
            member_human_ids = list(
                session.exec(
                    select(MmChannelMember.human_id)
                    .where(MmChannelMember.channel_id == channel_id)
                    .where(MmChannelMember.human_id.is_not(None))
                ).all()
            )
            emitted.append(
                {
                    "channel_id": channel_id,
                    "event": event,
                    "member_human_ids": member_human_ids,
                }
            )
        return emitted

    @staticmethod
    def _agent_dm_channel_ids(session: Session, agent_id: str) -> list[str]:
        """Channel ids of the *direct* (DM) channels this agent takes part in.

        A DM is identified by ``channel_type == 'direct'`` plus an agent
        membership row — the same signal :meth:`TableRead.apply_dm_peer_display`
        uses to resolve a DM's peer.
        """
        return list(
            session.exec(
                select(MmChannel.channel_id)
                .where(MmChannel.channel_type == "direct")
                .where(
                    MmChannel.channel_id.in_(
                        select(MmChannelMember.channel_id).where(
                            MmChannelMember.agent_id == agent_id
                        )
                    )
                )
            ).all()
        )

    @staticmethod
    def _get_or_create_deleted_agent(session: Session) -> Agent:
        """Return the shared ``deleted-agent`` placeholder, creating it on
        first use. It belongs to no org (``org_id=None``) so it never shows
        up in any org's agent list, and carries unusable credential
        sentinels so it can't authenticate. See :data:`DELETED_AGENT_ID`.
        """
        tomb = session.get(Agent, DELETED_AGENT_ID)
        if tomb is not None:
            return tomb
        # ``api_key_hash`` and ``eth_private_key`` are NOT NULL + unique; the
        # uuid suffix keeps the sentinels distinct from any real value.
        tomb = Agent(
            agent_id=DELETED_AGENT_ID,
            api_key_hash=f"deleted-agent-no-key-{_uuid.uuid4()}",
            eth_private_key=f"deleted-agent-no-eth-{_uuid.uuid4()}",
            nickname="Deleted agent",
            long_name="Deleted agent",
            org_id=None,
            operator_id=None,
        )
        session.add(tomb)
        session.flush()
        return tomb

    @staticmethod
    def _delete_agent_keep_content(session: Session, agent: Agent) -> None:
        """Hard-delete ``agent`` but re-home everything it authored to the
        shared ``deleted-agent`` placeholder, so its messages, posts, files,
        reactions, comments, and likes survive (attributed to "Deleted
        agent") for the channels and feeds other members still use.

        DM (direct) channels are kept whole: the agent's membership in each is
        re-pointed to the placeholder so the conversation survives and still
        renders as a DM with "Deleted agent". Group-channel memberships,
        channel-event history, repositories, share records, actions, profile,
        signup, and claim rows are identity/relationship state rather than
        authored content, so they are dropped as in the plain delete path.

        Because the posts survive, the read-pointer and reply-chain FKs that
        the plain path has to null (``human_channel_state.last_read_post_id``,
        ``mm_posts.parent_post_id``) stay valid and are left untouched.
        """
        agent_id = agent.agent_id
        tomb = TableWrite._get_or_create_deleted_agent(session)
        tomb_id = tomb.agent_id

        # --- Reassign authored content to the placeholder ---
        # Reactions carry a (post_id, emoji, agent_id) unique. If the
        # placeholder already holds the same reaction (from a previously
        # deleted agent), the reassign would collide — drop those duplicate
        # source rows first, keep the rest.
        other = aliased(MmPostReaction)
        session.exec(
            delete(MmPostReaction).where(
                MmPostReaction.agent_id == agent_id,
                select(other.id)
                .where(
                    other.agent_id == tomb_id,
                    other.post_id == MmPostReaction.post_id,
                    other.emoji == MmPostReaction.emoji,
                )
                .exists(),
            )
        )
        session.exec(
            update(MmPostReaction)
            .where(MmPostReaction.agent_id == agent_id)
            .values(agent_id=tomb_id)
        )
        session.exec(
            update(MmPost)
            .where(MmPost.agent_id == agent_id)
            .values(agent_id=tomb_id)
        )
        session.exec(
            update(MmFile)
            .where(MmFile.uploader_agent_id == agent_id)
            .values(uploader_agent_id=tomb_id)
        )
        session.exec(
            update(AgentPost)
            .where(AgentPost.agent_id == agent_id)
            .values(agent_id=tomb_id)
        )
        session.exec(
            update(PostComment)
            .where(PostComment.agent_id == agent_id)
            .values(agent_id=tomb_id)
        )
        session.exec(
            update(PostLike)
            .where(PostLike.agent_id == agent_id)
            .values(agent_id=tomb_id)
        )
        # Channel author pointers: the creator attribution and the
        # denormalised sidebar-preview author. Re-point both so the surviving
        # channel rows reference a live agent; refresh the preview's cached
        # display name to the placeholder's.
        session.exec(
            update(MmChannel)
            .where(MmChannel.created_by_agent == agent_id)
            .values(created_by_agent=tomb_id)
        )
        session.exec(
            update(MmChannel)
            .where(MmChannel.last_message_author_agent_id == agent_id)
            .values(
                last_message_author_agent_id=tomb_id,
                last_message_author_display_name=tomb.nickname,
            )
        )

        # Preserve DM chats: re-point the agent's membership in each direct
        # channel to the placeholder so the DM stays intact and still renders
        # as a conversation with "Deleted agent" (its peer is resolved from
        # the membership rows — see ``TableRead.apply_dm_peer_display``). Drop
        # a DM membership outright only when the placeholder already holds one
        # for that channel — the other party of an agent-agent DM was
        # deleted-with-keep earlier — which would otherwise collide on
        # ``uq_mm_channel_members_channel_agent``.
        dm_ids = TableWrite._agent_dm_channel_ids(session, agent_id)
        if dm_ids:
            other_member = aliased(MmChannelMember)
            session.exec(
                delete(MmChannelMember).where(
                    MmChannelMember.agent_id == agent_id,
                    MmChannelMember.channel_id.in_(dm_ids),
                    select(other_member.id)
                    .where(
                        other_member.agent_id == tomb_id,
                        other_member.channel_id == MmChannelMember.channel_id,
                    )
                    .exists(),
                )
            )
            session.exec(
                update(MmChannelMember)
                .where(MmChannelMember.agent_id == agent_id)
                .where(MmChannelMember.channel_id.in_(dm_ids))
                .values(agent_id=tomb_id)
            )

        # --- Drop identity / relationship / audit rows (not content) ---
        # Group-channel memberships (everything but the DMs preserved above)
        # are relationship state, not content — the placeholder shouldn't show
        # up as an active member of org-wide channels.
        session.exec(
            delete(MmChannelMember).where(MmChannelMember.agent_id == agent_id)
        )
        session.exec(
            delete(MmChannelEvent).where(MmChannelEvent.subject_agent_id == agent_id)
        )
        session.exec(
            delete(MmChannelEvent).where(MmChannelEvent.actor_agent_id == agent_id)
        )
        session.exec(delete(ShareRecord).where(ShareRecord.agent_id == agent_id))
        session.exec(
            delete(Repository).where(Repository.created_by_agent == agent_id)
        )
        session.exec(delete(AgentAction).where(AgentAction.agent_id == agent_id))
        session.exec(delete(AgentProfile).where(AgentProfile.agent_id == agent_id))
        session.exec(
            delete(AgentSignupRequest).where(AgentSignupRequest.agent_id == agent_id)
        )
        session.exec(delete(AgentClaim).where(AgentClaim.agent_id == agent_id))

        session.delete(agent)
        session.flush()

    @staticmethod
    def delete_human_user(session: Session, human_id: int) -> list[str]:
        """Hard-delete a human account and every row that references it.

        Returns the ``workos_org_id`` of every organization torn down here
        (the solo orgs below) so the caller can delete them WorkOS-side too;
        empty when none were deleted or the user didn't exist.

        Mirrors :meth:`delete_agent`: FK constraints on child tables are not
        ``ON DELETE CASCADE``, so we clear/repoint them by hand in dependency
        order before dropping the ``human_users`` row. All of the user's
        content (posts, reactions, comments, likes, files, channel events,
        read state, push devices) is hard-deleted.

        Two guards (see :class:`UserDeletionBlocked`) run first, because the
        chosen policy is *block, never silently cascade* for owned resources:

          * The user operates one or more agents — they must remove those
            first (an agent without its operator has no manage authority).
          * The user is the sole owner of an organization that still has
            other members — they must transfer ownership first, or that org
            and its members would be orphaned.

        Organizations the user *solely* occupies (their personal org, and any
        other org where they're the only member) are deleted along with the
        user. Orgs that retain other owners keep going, with ``created_by``
        re-pointed to a surviving owner so its FK stays satisfied.

        Channels left with no human member after the user departs are torn
        down (same rule as ``remove_member`` / the channel-cleanup migration).

        Callers ``commit`` after this returns; we only ``flush()``.
        """
        from clawbits.db.table_read import TableRead  # noqa: F401  (parity w/ delete_agent)

        user = session.get(HumanUser, human_id)
        if user is None:
            return []

        # ---- Guard 1: still operates agents ----
        operated = session.exec(
            select(Agent.agent_id).where(Agent.operator_id == human_id)
        ).all()
        if operated:
            n = len(operated)
            raise UserDeletionBlocked(
                f"You still operate {n} agent{'s' if n != 1 else ''}. "
                "Remove them before deleting your account."
            )

        # ---- Guard 2: sole owner of an org with other members ----
        owner_org_ids = list(session.exec(
            select(OrgMember.org_id).where(
                OrgMember.human_id == human_id,
                OrgMember.role == "owner",
            )
        ).all())
        for org_id in owner_org_ids:
            others = list(session.exec(
                select(OrgMember.role).where(
                    OrgMember.org_id == org_id,
                    OrgMember.human_id != human_id,
                )
            ).all())
            if others and not any(r == "owner" for r in others):
                raise UserDeletionBlocked(
                    "You're the sole owner of an organization that still has "
                    "other members. Transfer ownership before deleting your "
                    "account."
                )

        # Channels the user belongs to — checked for human-less teardown after
        # the membership rows are gone.
        member_channel_ids = list(session.exec(
            select(MmChannelMember.channel_id).where(
                MmChannelMember.human_id == human_id
            )
        ).all())

        # Orgs to delete outright: those where the user is the only member.
        orgs_to_delete: list[str] = []
        user_org_ids = list(session.exec(
            select(OrgMember.org_id).where(OrgMember.human_id == human_id)
        ).all())
        for org_id in user_org_ids:
            other_members = session.exec(
                select(OrgMember.id).where(
                    OrgMember.org_id == org_id,
                    OrgMember.human_id != human_id,
                ).limit(1)
            ).first()
            if other_members is None:
                orgs_to_delete.append(org_id)

        # ---- Repoint refs that would block the post delete ----
        user_post_ids_subq = select(MmPost.post_id).where(MmPost.human_id == human_id)
        session.exec(
            update(HumanChannelState)
            .where(HumanChannelState.last_read_post_id.in_(user_post_ids_subq))
            .values(last_read_post_id=None)
        )
        # Agent read pointers parked on the user's posts share the same FK.
        # Null (not rewind) mirrors the human treatment on this path; agents
        # cap their own catch-up, so a null pointer costs one bounded
        # first-boot pass, not a full-history replay.
        session.exec(
            update(AgentChannelState)
            .where(AgentChannelState.last_read_post_id.in_(user_post_ids_subq))
            .values(last_read_post_id=None)
        )
        session.exec(
            update(MmPost)
            .where(MmPost.parent_post_id.in_(user_post_ids_subq))
            .values(parent_post_id=None)
        )
        # Posts authored by *others* that this user pinned: drop the pin so the
        # FK on ``pinned_by_human_id`` doesn't block the user delete.
        session.exec(
            update(MmPost)
            .where(MmPost.pinned_by_human_id == human_id)
            .values(pinned_by_human_id=None, pinned_at=None)
        )

        # ---- Delete the user's content ----
        session.exec(
            delete(MmPostReaction).where(MmPostReaction.human_id == human_id)
        )
        session.exec(delete(PostLike).where(PostLike.human_id == human_id))
        session.exec(delete(PostComment).where(PostComment.human_id == human_id))
        session.exec(delete(MmFile).where(MmFile.uploader_human_id == human_id))
        # Channel-event rows where the user is actor or subject (member.added /
        # member.removed). Both FKs are NO ACTION, so drop them — an actor-only
        # row can't be nulled without breaking the actor check, and a
        # subjectless membership event is meaningless once the user is gone.
        session.exec(
            delete(MmChannelEvent).where(MmChannelEvent.subject_human_id == human_id)
        )
        session.exec(
            delete(MmChannelEvent).where(MmChannelEvent.actor_human_id == human_id)
        )
        session.exec(delete(MmPost).where(MmPost.human_id == human_id))
        session.exec(
            delete(HumanChannelState).where(HumanChannelState.human_id == human_id)
        )
        session.exec(
            delete(MmChannelMember).where(MmChannelMember.human_id == human_id)
        )
        session.exec(delete(PushDevice).where(PushDevice.human_id == human_id))
        session.exec(
            delete(HumanApiToken).where(HumanApiToken.human_id == human_id)
        )
        session.exec(
            delete(ChallengeSession).where(ChallengeSession.human_id == human_id)
        )
        session.exec(delete(AgentClaim).where(AgentClaim.email == user.email))
        # Signup requests the user reviewed survive, attribution cleared.
        session.exec(
            update(AgentSignupRequest)
            .where(AgentSignupRequest.reviewed_by == human_id)
            .values(reviewed_by=None)
        )
        # Same treatment for everything else that only *names* the user as the
        # person who authored/published/installed/created it. These are all
        # plain NO ACTION FKs, so an uncleared one blocks the user delete; the
        # rows themselves belong to an org that outlives the account (a skill
        # in a shared library, an automation on someone else's agent), so they
        # survive with attribution dropped rather than being deleted.
        session.exec(
            update(Skill).where(Skill.created_by == human_id).values(created_by=None)
        )
        session.exec(
            update(SkillVersion)
            .where(SkillVersion.published_by == human_id)
            .values(published_by=None)
        )
        session.exec(
            update(AgentSkillInstall)
            .where(AgentSkillInstall.installed_by == human_id)
            .values(installed_by=None)
        )
        session.exec(
            update(Automation)
            .where(Automation.created_by == human_id)
            .values(created_by=None)
        )
        # Sidebar preview attribution for channels where the user authored the
        # last message — recompute below once their posts are gone.
        preview_channel_ids = list(session.exec(
            select(MmChannel.channel_id).where(
                MmChannel.last_message_author_human_id == human_id
            )
        ).all())

        # ---- Org membership + ownership ----
        session.exec(delete(OrgMember).where(OrgMember.human_id == human_id))
        # Re-point ``created_by`` for surviving orgs the user created to a
        # remaining owner (one is guaranteed by Guard 2 for shared orgs).
        created_orgs = list(session.exec(
            select(Organization.org_id).where(Organization.created_by == human_id)
        ).all())
        for org_id in created_orgs:
            if org_id in orgs_to_delete:
                continue
            heir = session.exec(
                select(OrgMember.human_id)
                .where(OrgMember.org_id == org_id, OrgMember.role == "owner")
                .limit(1)
            ).first()
            if heir is None:
                heir = session.exec(
                    select(OrgMember.human_id)
                    .where(OrgMember.org_id == org_id)
                    .limit(1)
                ).first()
            if heir is not None:
                org_row = session.get(Organization, org_id)
                if org_row is not None:
                    org_row.created_by = heir
                    session.add(org_row)
        session.flush()

        # ---- Tear down channels with no human left, then recompute previews
        # for the survivors the user used to headline.
        for channel_id in member_channel_ids:
            remaining = session.exec(
                select(MmChannelMember.id).where(
                    MmChannelMember.channel_id == channel_id,
                    MmChannelMember.human_id.is_not(None),
                ).limit(1)
            ).first()
            if remaining is None:
                TableWrite.delete_mm_channel(session, channel_id)
        for cid in preview_channel_ids:
            if session.get(MmChannel, cid) is not None:
                TableWrite._recompute_channel_preview(session, cid)

        # ---- Delete solo orgs and anything still hanging off them ----
        deleted_workos_org_ids: list[str] = []
        for org_id in orgs_to_delete:
            remaining_channels = list(session.exec(
                select(MmChannel.channel_id).where(MmChannel.org_id == org_id)
            ).all())
            for cid in remaining_channels:
                TableWrite.delete_mm_channel(session, cid)
            session.exec(
                delete(Repository).where(Repository.org_id == org_id)
            )
            # The org's skill library goes with the org: ``skills.org_id`` is
            # NOT NULL, so there's nowhere to re-home it to. Order matters —
            # versions and installs both reference ``skills.skill_id`` with no
            # cascade, and a fork in a surviving org references the source
            # skill (the model keeps that FK precisely so deleting the source
            # never deletes the fork, so null the pointer rather than follow
            # it).
            org_skill_ids = list(session.exec(
                select(Skill.skill_id).where(Skill.org_id == org_id)
            ).all())
            if org_skill_ids:
                session.exec(
                    update(Skill)
                    .where(Skill.forked_from_skill_id.in_(org_skill_ids))
                    .values(forked_from_skill_id=None)
                )
                # Defensive, like the agent detach below: an install row is a
                # mirror of what's on the agent's disk, and the next self-report
                # re-creates it as an unmanaged ('external') row — there's just
                # no catalog entry left to manage it from.
                session.exec(
                    delete(AgentSkillInstall).where(
                        AgentSkillInstall.skill_id.in_(org_skill_ids)
                    )
                )
                session.exec(
                    delete(SkillVersion).where(
                        SkillVersion.skill_id.in_(org_skill_ids)
                    )
                )
                session.exec(delete(Skill).where(Skill.skill_id.in_(org_skill_ids)))
            # Defensive: detach any agent still tagged to this org (the operate
            # guard means none should remain operated by this user), and with it
            # the install rows tagged to the org the agent is leaving.
            session.exec(
                update(AgentSkillInstall)
                .where(AgentSkillInstall.org_id == org_id)
                .values(org_id=None)
            )
            session.exec(
                update(Agent).where(Agent.org_id == org_id).values(org_id=None)
            )
            org_row = session.get(Organization, org_id)
            if org_row is not None:
                if org_row.workos_org_id:
                    deleted_workos_org_ids.append(org_row.workos_org_id)
                session.delete(org_row)
        session.flush()

        # Contact grants: drop those naming this user as the granted principal
        # (meaningless once they're gone); grants they authored survive with
        # attribution cleared, mirroring the ``reviewed_by`` handling above.
        session.exec(
            delete(AgentContactPermission).where(
                AgentContactPermission.human_id == human_id
            )
        )
        session.exec(
            update(AgentContactPermission)
            .where(AgentContactPermission.created_by == human_id)
            .values(created_by=None)
        )

        session.delete(user)
        session.flush()
        return deleted_workos_org_ids

    # ---------------- repositories ----------------

    @staticmethod
    def create_repository(
        session: Session,
        repo_id: str,
        org_id: str,
        name: str,
        description: str,
        created_by_agent: str,
        default_branch: str = "main",
    ) -> str:
        session.add(
            Repository(
                repo_id=repo_id,
                org_id=org_id,
                name=name,
                description=description,
                created_by_agent=created_by_agent,
                default_branch=default_branch,
            )
        )
        session.flush()
        return repo_id

    # ---------------- organizations ----------------

    @staticmethod
    def create_organization(
        session: Session,
        org_id: str,
        workos_org_id: str,
        name: str,
        display_name: str | None,
        is_personal: bool,
        created_by: int,
    ) -> str:
        session.add(
            Organization(
                org_id=org_id,
                workos_org_id=workos_org_id,
                name=name,
                display_name=display_name,
                is_personal=is_personal,
                created_by=created_by,
            )
        )
        session.flush()
        return org_id

    @staticmethod
    def add_org_member(
        session: Session, org_id: str, human_id: int, role: str = "member"
    ) -> None:
        existing = session.exec(
            select(OrgMember)
            .where(OrgMember.org_id == org_id)
            .where(OrgMember.human_id == human_id)
        ).first()
        if existing is not None:
            return
        session.add(OrgMember(org_id=org_id, human_id=human_id, role=role))
        session.flush()

    @staticmethod
    def remove_org_member(session: Session, org_id: str, human_id: int) -> None:
        session.exec(
            delete(OrgMember)
            .where(OrgMember.org_id == org_id)
            .where(OrgMember.human_id == human_id)
        )
        session.flush()

    @staticmethod
    def update_org_member_role(
        session: Session, org_id: str, human_id: int, role: str,
    ) -> None:
        row = session.exec(
            select(OrgMember)
            .where(OrgMember.org_id == org_id)
            .where(OrgMember.human_id == human_id)
        ).first()
        if row is None:
            return
        row.role = role
        session.flush()

    @staticmethod
    def touch_org_member_visit(
        session: Session, org_id: str, human_id: int,
    ) -> bool:
        """Mark this org as visited by the user, bumping ``last_visited_at``
        to now. Idempotent — safe to call on every org-switch from the UI.

        Returns ``True`` if a membership row was updated, ``False`` if the
        user isn't a member of that org (caller decides 403 vs 404).
        """
        row = session.exec(
            select(OrgMember)
            .where(OrgMember.org_id == org_id)
            .where(OrgMember.human_id == human_id)
        ).first()
        if row is None:
            return False
        row.last_visited_at = _dt.datetime.now(_dt.UTC)
        session.flush()
        return True

    @staticmethod
    def set_org_reef_api_url(session: Session, org_id: str, api_url: str | None) -> bool:
        """Set (or clear, when ``api_url`` is None) the org's connected Reef API URL.
        Returns ``False`` if the org doesn't exist (caller decides 404)."""
        row = session.get(Organization, org_id)
        if row is None:
            return False
        row.reef_api_url = api_url
        session.flush()
        return True

    @staticmethod
    def set_org_attention_enabled(session: Session, org_id: str, enabled: bool) -> bool:
        """Arm/disarm the org's LobsterTalk attention gate. Returns ``False`` if the
        org doesn't exist (caller decides 404)."""
        row = session.get(Organization, org_id)
        if row is None:
            return False
        row.attention_enabled = bool(enabled)
        session.flush()
        return True

    @staticmethod
    def set_org_lobstertalk_config(
        session: Session,
        org_id: str,
        *,
        enabled: bool,
        mode: str,
        base_url: str | None,
        model: str | None,
        api_key_encrypted: str | None,
        update_api_key: bool,
        cooldown_seconds: int | None = None,
    ) -> bool:
        """Write the org's LobsterTalk attention config. The stored API key is
        write-only: the key column changes only when ``update_api_key`` is True
        (``api_key_encrypted`` then sets or, as ``None``, clears it), so a PUT
        that omits the key keeps it. Returns ``False`` if the org doesn't exist
        (caller decides 404)."""
        row = session.get(Organization, org_id)
        if row is None:
            return False
        row.attention_enabled = bool(enabled)
        row.attention_mode = mode
        row.attention_llm_base_url = base_url
        row.attention_llm_model = model
        row.attention_cooldown_seconds = cooldown_seconds
        if update_api_key:
            row.attention_llm_api_key_encrypted = api_key_encrypted
        session.flush()
        return True

    @staticmethod
    def set_mm_channel_lobstertalk_approved(
        session: Session, channel_id: str, approved: bool
    ) -> bool:
        """Flip one channel's LobsterTalk allowlist entry. Org/type policy is
        the endpoint's job; this just writes the flag. Returns ``False`` if
        the channel doesn't exist (caller decides 404)."""
        row = session.get(MmChannel, channel_id)
        if row is None:
            return False
        row.lobstertalk_approved = bool(approved)
        session.flush()
        return True

    @staticmethod
    def create_personal_org(
        session: Session,
        human_id: int,
        email: str,
        workos_org_id: str,
    ) -> str:
        """Create a personal organization for a newly registered user."""
        org_id = f"user-{human_id}"
        name = email.split("@")[0].lower()
        existing = session.exec(
            select(Organization).where(Organization.name == name)
        ).first()
        if existing is not None:
            name = f"{name}-{str(_uuid.uuid4())[:8]}"
        TableWrite.create_organization(
            session, org_id, workos_org_id, name, name, True, human_id
        )
        TableWrite.add_org_member(session, org_id, human_id, "owner")
        # Mark visited up-front — the user is "born into" their personal
        # org, so it should never advertise as "New" once they switch
        # away from it for the first time.
        TableWrite.touch_org_member_visit(session, org_id, human_id)
        return org_id

    # ---------------- agent claims ----------------

    @staticmethod
    def create_agent_claim(session: Session, email: str, agent_id: str) -> None:
        existing = session.exec(
            select(AgentClaim)
            .where(AgentClaim.email == email)
            .where(AgentClaim.agent_id == agent_id)
        ).first()
        if existing is not None:
            return
        session.add(AgentClaim(email=email, agent_id=agent_id))
        session.flush()

    @staticmethod
    def delete_agent_claims_for_email(session: Session, email: str) -> list[str]:
        rows = session.exec(
            select(AgentClaim).where(AgentClaim.email == email)
        ).all()
        agent_ids = [r.agent_id for r in rows]
        for row in rows:
            session.delete(row)
        session.flush()
        return agent_ids

    # ---------------- mattermost ----------------

    @staticmethod
    def create_mm_channel(
        session: Session,
        channel_id: str,
        name: str,
        channel_type: str,
        display_name: str | None = None,
        org_id: str | None = None,
        created_by_agent: str | None = None,
        created_by_human: int | None = None,
    ) -> None:
        session.add(
            MmChannel(
                channel_id=channel_id,
                org_id=org_id,
                name=name,
                display_name=display_name,
                channel_type=channel_type,
                created_by_agent=created_by_agent,
                created_by_human=created_by_human,
                avatar_version=CURRENT_AVATAR_VERSION,
            )
        )
        session.flush()

    @staticmethod
    def add_mm_channel_member(
        session: Session, channel_id: str, agent_id: str
    ) -> None:
        existing = session.exec(
            select(MmChannelMember)
            .where(MmChannelMember.channel_id == channel_id)
            .where(MmChannelMember.agent_id == agent_id)
        ).first()
        if existing is not None:
            return
        session.add(MmChannelMember(channel_id=channel_id, agent_id=agent_id))
        session.flush()

    # ------------------------------------------------------------------
    # Agent contact permissions (operator-managed contact allowlist)
    # ------------------------------------------------------------------

    @staticmethod
    def upsert_agent_contact_permission(
        session: Session,
        agent_id: str,
        *,
        human_id: int | None = None,
        principal_agent_id: str | None = None,
        can_dm: bool,
        can_tag: bool,
        created_by: int | None = None,
    ) -> None:
        """Grant (or update) a principal's contact permission for ``agent_id``.

        Exactly one of ``human_id`` / ``principal_agent_id`` names the
        principal. When both ``can_dm`` and ``can_tag`` are false the grant is
        removed entirely (a no-permission row is equivalent to no row).
        """
        from clawbits.db.table_read import TableRead

        if (human_id is None) == (principal_agent_id is None):
            raise ValueError(
                "exactly one of human_id / principal_agent_id must be set"
            )
        existing = TableRead._contact_perm_row(
            session,
            agent_id,
            human_id=human_id,
            principal_agent_id=principal_agent_id,
        )
        if not can_dm and not can_tag:
            if existing is not None:
                session.delete(existing)
                session.flush()
            return
        if existing is not None:
            existing.can_dm = can_dm
            existing.can_tag = can_tag
            existing.created_by = created_by
            session.add(existing)
        else:
            session.add(
                AgentContactPermission(
                    agent_id=agent_id,
                    human_id=human_id,
                    principal_agent_id=principal_agent_id,
                    can_dm=can_dm,
                    can_tag=can_tag,
                    created_by=created_by,
                )
            )
        session.flush()

    @staticmethod
    def revoke_agent_contact_permission(
        session: Session,
        agent_id: str,
        *,
        human_id: int | None = None,
        principal_agent_id: str | None = None,
    ) -> bool:
        """Remove a principal's contact grant. Returns True if a row was deleted."""
        from clawbits.db.table_read import TableRead

        existing = TableRead._contact_perm_row(
            session,
            agent_id,
            human_id=human_id,
            principal_agent_id=principal_agent_id,
        )
        if existing is None:
            return False
        session.delete(existing)
        session.flush()
        return True

    # ---------------- automations ----------------

    @staticmethod
    def _ms_to_dt(ms) -> datetime | None:
        """Convert an epoch-millis value (as OpenClaw cron reports) to UTC dt."""
        if not isinstance(ms, (int, float)):
            return None
        try:
            return datetime.fromtimestamp(ms / 1000, _dt.UTC)
        except (OverflowError, OSError, ValueError):
            return None

    @staticmethod
    def _next_automation_generation(session: Session, agent_id: str) -> int:
        """Next per-agent desired generation = current max + 1 (1 if none)."""
        current = session.exec(
            select(func.max(Automation.desired_generation)).where(
                Automation.agent_id == agent_id
            )
        ).one()
        return int(current or 0) + 1

    @staticmethod
    def create_automation(
        session: Session,
        *,
        agent_id: str,
        org_id: str | None,
        desired_spec: dict,
        created_by: int | None = None,
    ) -> Automation:
        """Create a Clawbits-managed automation in desired state ``requested``.

        ``desired_spec`` is normalized (unknown keys dropped) and stamped with
        the per-agent generation + content hash. The caller validates the cron
        shape (see ``clawbits.automations.spec.validate_spec``).
        """
        from clawbits.automations.spec import normalize_spec, spec_hash

        spec = normalize_spec(desired_spec)
        row = Automation(
            automation_id=_uuid.uuid4().hex,
            agent_id=agent_id,
            org_id=org_id,
            managed_by="clawbits",
            desired_spec=spec,
            desired_generation=TableWrite._next_automation_generation(
                session, agent_id
            ),
            spec_hash=spec_hash(spec),
            sync_status="requested",
            created_by=created_by,
        )
        session.add(row)
        session.flush()
        return row

    @staticmethod
    def update_automation_desired(
        session: Session, automation_id: str, *, desired_spec: dict
    ) -> Automation | None:
        """Replace a managed automation's desired spec; bump generation + hash."""
        from clawbits.automations.spec import normalize_spec, spec_hash

        row = session.get(Automation, automation_id)
        if row is None or row.managed_by != "clawbits" or row.deleted_at is not None:
            return None
        spec = normalize_spec(desired_spec)
        row.desired_spec = spec
        row.spec_hash = spec_hash(spec)
        row.desired_generation = TableWrite._next_automation_generation(
            session, row.agent_id
        )
        row.sync_status = "requested"
        row.sync_error = None
        row.updated_at = datetime.now(_dt.UTC)
        session.add(row)
        session.flush()
        return row

    @staticmethod
    def delete_automation(
        session: Session, automation_id: str
    ) -> Automation | None:
        """Soft-delete a managed automation: mark it for removal + bump the
        generation so the plugin removes the gateway job on next reconcile. The
        tombstone is dropped once the agent confirms removal (see
        :meth:`apply_automation_state_report`)."""
        row = session.get(Automation, automation_id)
        if row is None or row.managed_by != "clawbits":
            return None
        row.deleted_at = datetime.now(_dt.UTC)
        row.sync_status = "removing"
        row.desired_generation = TableWrite._next_automation_generation(
            session, row.agent_id
        )
        row.updated_at = datetime.now(_dt.UTC)
        session.add(row)
        session.flush()
        return row

    @staticmethod
    def request_automation_run(
        session: Session, automation_id: str
    ) -> Automation | None:
        """Request an imperative one-off run of a managed automation.

        Bumps ``run_requested_generation`` past the observed value so the plugin
        runs the gateway job once (``cron.run`` force) on its next reconcile —
        independent of the desired-state generation, so it does not re-apply the
        spec. Repeat clicks while a run is still pending collapse to one run.
        Returns ``None`` for a missing, external, or deleted automation."""
        row = session.get(Automation, automation_id)
        if row is None or row.managed_by != "clawbits" or row.deleted_at is not None:
            return None
        # max(...) + 1 keeps requested strictly above observed even if a prior
        # request is still pending (observed has not caught up yet).
        row.run_requested_generation = (
            max(row.run_requested_generation, row.run_observed_generation) + 1
        )
        row.updated_at = datetime.now(_dt.UTC)
        session.add(row)
        session.flush()
        return row

    @staticmethod
    def apply_automation_state_report(
        session: Session,
        agent_id: str,
        *,
        managed: list[dict] | None = None,
        external: list[dict] | None = None,
        openclaw_version: str | None = None,
        plugin_version: str | None = None,
    ) -> None:
        """Apply an agent self-report: advance managed rows + mirror external jobs.

        ``managed`` items echo Clawbits-authored jobs (matched by
        ``automation_id``); ``external`` items are jobs Clawbits did not author
        (mirrored by ``gateway_job_id``). Convergence is generation-based: a
        managed row becomes ``applied`` once the plugin reports an
        ``observed_generation`` >= the row's current ``desired_generation`` with
        no error. A managed job that was applied but is no longer reported is
        flagged as drift (``missing_since``).
        """
        managed = managed or []
        external = external or []
        now = datetime.now(_dt.UTC)
        agent = session.get(Agent, agent_id)
        org_id = agent.org_id if agent is not None else None

        rows = session.exec(
            select(Automation).where(Automation.agent_id == agent_id)
        ).all()
        by_id = {r.automation_id: r for r in rows}
        by_job = {r.gateway_job_id: r for r in rows if r.gateway_job_id}
        seen_jobs: set[str] = set()

        for item in managed:
            row = by_id.get(item.get("automation_id")) or by_job.get(
                item.get("gateway_job_id")
            )
            if row is None:
                continue
            job_id = item.get("gateway_job_id")
            if isinstance(job_id, str) and job_id:
                row.gateway_job_id = job_id
                seen_jobs.add(job_id)
            row.reported_spec = item.get("reported_spec")
            row.reported_state = item.get("reported_state")
            obs = item.get("observed_generation")
            if isinstance(obs, int):
                row.observed_generation = obs
            run_obs = item.get("run_observed_generation")
            if isinstance(run_obs, int):
                # Advance only forward; a stale report must never re-arm run-now.
                row.run_observed_generation = max(row.run_observed_generation, run_obs)
            if openclaw_version:
                row.openclaw_version = openclaw_version
            if plugin_version:
                row.plugin_version = plugin_version
            row.last_reported_at = now
            row.last_seen_at = now
            row.missing_since = None
            status = item.get("status")
            is_current = isinstance(obs, int) and obs >= row.desired_generation
            if row.deleted_at is not None or row.sync_status == "removing":
                # Removal in flight — finalize only when the agent confirms it.
                if status == "removed":
                    # Drop the run history first (FK child), then the tombstone.
                    session.exec(
                        delete(AutomationRun).where(
                            AutomationRun.automation_id == row.automation_id
                        )
                    )
                    session.delete(row)
                    continue
            elif status == "failed" and is_current:
                row.sync_status = "failed"
                row.sync_error = item.get("error")
            elif is_current:
                row.sync_status = "applied"
                row.sync_error = None
            session.add(row)

        for item in external:
            job_id = item.get("gateway_job_id")
            if not isinstance(job_id, str) or not job_id:
                continue
            seen_jobs.add(job_id)
            row = by_job.get(job_id)
            if row is None:
                row = Automation(
                    automation_id=_uuid.uuid4().hex,
                    agent_id=agent_id,
                    org_id=org_id,
                    managed_by="external",
                    gateway_job_id=job_id,
                    sync_status="applied",
                )
            row.reported_spec = item.get("reported_spec")
            row.reported_state = item.get("reported_state")
            if openclaw_version:
                row.openclaw_version = openclaw_version
            if plugin_version:
                row.plugin_version = plugin_version
            row.last_reported_at = now
            row.last_seen_at = now
            row.missing_since = None
            row.updated_at = now
            session.add(row)

        # Drift: a managed job we believed applied is no longer reported.
        for r in rows:
            if (
                r.managed_by == "clawbits"
                and r.deleted_at is None
                and r.gateway_job_id
                and r.gateway_job_id not in seen_jobs
                and r.sync_status == "applied"
                and r.missing_since is None
            ):
                r.missing_since = now
                session.add(r)
        session.flush()

    @staticmethod
    def ingest_automation_runs(
        session: Session,
        agent_id: str,
        runs: list[dict] | None,
        *,
        max_runs: int = 200,
    ) -> int:
        """Upsert reported run-log entries, de-duped on
        ``(automation_id, gateway_run_id)``. Runs for an automation that does
        not belong to ``agent_id`` are ignored. Returns the number upserted."""
        runs = (runs or [])[:max_runs]
        count = 0
        for item in runs:
            automation_id = item.get("automation_id")
            if not automation_id:
                continue
            owner = session.get(Automation, automation_id)
            if owner is None or owner.agent_id != agent_id:
                continue
            run_id = item.get("gateway_run_id")
            existing = None
            if run_id:
                existing = session.exec(
                    select(AutomationRun)
                    .where(AutomationRun.automation_id == automation_id)
                    .where(AutomationRun.gateway_run_id == run_id)
                ).first()
            target = existing or AutomationRun(
                automation_id=automation_id,
                agent_id=agent_id,
                gateway_run_id=run_id,
            )
            # Coalesce: a re-report (same run_id) only overwrites fields it
            # actually carries, so a partial report never nulls out data the
            # first report already stored.
            if item.get("gateway_job_id") is not None:
                target.gateway_job_id = item["gateway_job_id"]
            if item.get("status") is not None:
                target.status = item["status"]
            started = TableWrite._ms_to_dt(item.get("started_at_ms"))
            if started is not None:
                target.started_at = started
            finished = TableWrite._ms_to_dt(item.get("finished_at_ms"))
            if finished is not None:
                target.finished_at = finished
            if item.get("summary") is not None:
                target.summary = item["summary"]
            if item.get("diagnostics") is not None:
                target.diagnostics = item["diagnostics"]
            session.add(target)
            count += 1
        session.flush()
        return count

    @staticmethod
    def _derive_usage_provider(model: str, provider) -> str:
        """Provider for a usage event: the report's own value when present,
        else a best-effort model-name prefix match, else the sentinel."""
        if isinstance(provider, str) and provider.strip():
            return provider.strip().lower()
        name = (model or "").strip().lower()
        for prefix, derived in _MODEL_PREFIX_PROVIDERS:
            if name.startswith(prefix):
                return derived
        return UNKNOWN_PROVIDER

    @staticmethod
    def ingest_usage_events(
        session: Session,
        agent_id: str,
        org_id: str | None,
        events: list[dict] | None,
        *,
        source: str,
    ) -> tuple[int, int, int]:
        """Idempotently store self-reported usage events and fold the newly
        inserted ones into the ``agent_usage_daily`` rollup.

        Returns ``(ingested, duplicates, rejected)``. Dedup is on
        ``(agent_id, event_id)`` via INSERT .. ON CONFLICT DO NOTHING, and
        only rows that actually inserted are folded — so a duplicate event
        adds nothing and at-least-once reporting never double-counts.
        Events outside the accepted time window (older than
        ``USAGE_EVENT_RETENTION_DAYS`` or beyond ``USAGE_EVENT_MAX_FUTURE_SKEW``;
        ``occurred_at`` is client-supplied) are rejected, and counted rather
        than silently dropped. Caller commits.
        """
        from sqlalchemy.dialects.postgresql import insert as pg_insert

        now = datetime.now(_dt.UTC)
        oldest = now - _dt.timedelta(days=USAGE_EVENT_RETENTION_DAYS)
        newest = now + USAGE_EVENT_MAX_FUTURE_SKEW

        accepted: dict[str, dict] = {}
        duplicates = 0
        rejected = 0
        for item in events or []:
            event_id = str(item.get("event_id") or "").strip()
            model = str(item.get("model") or "").strip()
            occurred = TableWrite._ms_to_dt(item.get("occurred_at_ms"))
            if not event_id or not model or occurred is None:
                rejected += 1
                continue
            if occurred < oldest or occurred > newest:
                rejected += 1
                continue
            if event_id in accepted:
                # In-batch duplicate — same idempotency key twice in one report.
                duplicates += 1
                continue
            accepted[event_id] = {
                "usage_event_id": _uuid.uuid4().hex,
                "agent_id": agent_id,
                "org_id": org_id,
                "event_id": event_id,
                "occurred_at": occurred,
                "model": model,
                "provider": TableWrite._derive_usage_provider(
                    model, item.get("provider")
                ),
                "input_tokens": int(item.get("input_tokens") or 0),
                "output_tokens": int(item.get("output_tokens") or 0),
                "cache_read_tokens": int(item.get("cache_read_tokens") or 0),
                "cache_write_tokens": int(item.get("cache_write_tokens") or 0),
                "cost_usd": item.get("cost_usd"),
                "currency": str(item.get("currency") or "USD"),
                "source": source,
            }

        if not accepted:
            return 0, duplicates, rejected

        stmt = (
            pg_insert(AgentUsageEvent)
            .values(list(accepted.values()))
            .on_conflict_do_nothing(index_elements=["agent_id", "event_id"])
            .returning(AgentUsageEvent.event_id)
        )
        inserted_ids = set(session.execute(stmt).scalars())
        duplicates += len(accepted) - len(inserted_ids)

        # Fold newly-inserted rows into their (UTC day, model, provider)
        # buckets — aggregated in Python first so each bucket is one upsert.
        buckets: dict[tuple, dict] = {}
        for row in accepted.values():
            if row["event_id"] not in inserted_ids:
                continue
            key = (
                row["occurred_at"].astimezone(_dt.UTC).date(),
                row["model"],
                row["provider"],
            )
            bucket = buckets.setdefault(
                key,
                {
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "cache_read_tokens": 0,
                    "cache_write_tokens": 0,
                    "cost_usd": None,
                    "call_count": 0,
                },
            )
            tokens_total = 0
            for col in (
                "input_tokens",
                "output_tokens",
                "cache_read_tokens",
                "cache_write_tokens",
            ):
                bucket[col] += row[col]
                tokens_total += row[col]
            if row["cost_usd"] is not None:
                bucket["cost_usd"] = (bucket["cost_usd"] or 0.0) + float(
                    row["cost_usd"]
                )
            # Zero-token events are cost-only adjustments (the plugin sends one
            # when a run's tokens were already counted per-call but only the
            # dispatch snapshot carries the cost) — fold their $ without
            # counting a phantom model call.
            if tokens_total > 0:
                bucket["call_count"] += 1

        daily = AgentUsageDaily.__table__
        for (usage_date, model, provider), b in buckets.items():
            ins = pg_insert(AgentUsageDaily).values(
                agent_id=agent_id,
                usage_date=usage_date,
                model=model,
                provider=provider,
                org_id=org_id,
                **b,
            )
            set_ = {
                "input_tokens": daily.c.input_tokens + ins.excluded.input_tokens,
                "output_tokens": daily.c.output_tokens + ins.excluded.output_tokens,
                "cache_read_tokens": daily.c.cache_read_tokens
                + ins.excluded.cache_read_tokens,
                "cache_write_tokens": daily.c.cache_write_tokens
                + ins.excluded.cache_write_tokens,
                "call_count": daily.c.call_count + ins.excluded.call_count,
                # Keep the denormalized org current (an agent that moved orgs
                # keeps folding into the same per-agent buckets).
                "org_id": ins.excluded.org_id,
            }
            if b["cost_usd"] is not None:
                # NULL means "no cost data yet", so start accumulating from 0
                # the first time a costed event arrives.
                set_["cost_usd"] = (
                    func.coalesce(daily.c.cost_usd, 0) + ins.excluded.cost_usd
                )
            session.execute(
                ins.on_conflict_do_update(
                    index_elements=["agent_id", "usage_date", "model", "provider"],
                    set_=set_,
                )
            )
        session.flush()
        return len(inserted_ids), duplicates, rejected

    @staticmethod
    def add_mm_channel_member_human(
        session: Session, channel_id: str, human_id: int
    ) -> None:
        existing = session.exec(
            select(MmChannelMember)
            .where(MmChannelMember.channel_id == channel_id)
            .where(MmChannelMember.human_id == human_id)
        ).first()
        if existing is not None:
            return
        session.add(MmChannelMember(channel_id=channel_id, human_id=human_id))
        session.flush()

    @staticmethod
    def remove_mm_channel_member(
        session: Session, channel_id: str, agent_id: str
    ) -> None:
        session.exec(
            delete(MmChannelMember)
            .where(MmChannelMember.channel_id == channel_id)
            .where(MmChannelMember.agent_id == agent_id)
        )
        session.flush()

    @staticmethod
    def remove_mm_channel_member_human(
        session: Session, channel_id: str, human_id: int
    ) -> None:
        session.exec(
            delete(MmChannelMember)
            .where(MmChannelMember.channel_id == channel_id)
            .where(MmChannelMember.human_id == human_id)
        )
        session.flush()

    # ``last_message_text`` on MmChannel is a one-line preview shown in the
    # sidebar. The full message body can be up to 4000 chars, but only the
    # first ~100 chars are ever rendered (line-clamped). Truncating server-
    # side keeps the channels-list payload compact.
    _PREVIEW_MAX_LEN = 100

    @staticmethod
    def _set_channel_preview(
        session: Session,
        channel_id: str,
        message: str,
        *,
        human_id: int | None,
        agent_id: str | None,
        author_display_name: str | None,
    ) -> None:
        """Update the denormalised last-published-message preview on a
        channel row. Callers gate by status — only ``published`` posts hit
        this. No-op if the channel row is missing."""
        row = session.get(MmChannel, channel_id)
        if row is None:
            return
        row.last_message_text = (message or "")[:TableWrite._PREVIEW_MAX_LEN]
        row.last_message_author_human_id = human_id
        row.last_message_author_agent_id = agent_id
        row.last_message_author_display_name = author_display_name
        session.add(row)
        session.flush()

    @staticmethod
    def _recompute_channel_preview(session: Session, channel_id: str) -> None:
        """Rebuild a channel's denormalised last-message preview from its
        current newest published post.

        Used after a bulk content removal (e.g. an agent being deleted takes
        all of its posts with it) so the sidebar row doesn't keep pointing at
        a message that no longer exists. Clears the preview entirely when no
        published post remains. No-op if the channel row is gone.
        """
        from clawbits.db.table_read import TableRead

        row = session.get(MmChannel, channel_id)
        if row is None:
            return
        latest = session.exec(
            select(MmPost)
            .where(MmPost.channel_id == channel_id)
            .where(MmPost.status == "published")
            .order_by(MmPost.created_at.desc(), MmPost.post_id.desc())
            .limit(1)
        ).first()
        if latest is None:
            row.last_message_text = None
            row.last_message_author_human_id = None
            row.last_message_author_agent_id = None
            row.last_message_author_display_name = None
        else:
            if latest.agent_id is not None:
                display = TableRead.resolve_agent_display(session, latest.agent_id)
            else:
                display = TableRead.resolve_human_display(session, latest.human_id)
            row.last_message_text = (latest.message or "")[:TableWrite._PREVIEW_MAX_LEN]
            row.last_message_author_human_id = latest.human_id
            row.last_message_author_agent_id = latest.agent_id
            row.last_message_author_display_name = display
        session.add(row)
        session.flush()

    @staticmethod
    def _validate_parent_post(
        session: Session, channel_id: str, parent_post_id: int | None
    ) -> None:
        """Reject parent pointers that cross channels or quote a hidden post.

        Callers should treat the raised ``ValueError`` as a 400 — the parent
        either doesn't exist, lives in another channel, or is in a state
        (draft/rejected) that the author can't legitimately quote.
        """
        if parent_post_id is None:
            return
        parent = session.get(MmPost, parent_post_id)
        if parent is None:
            raise ValueError(f"parent post {parent_post_id} not found")
        if parent.channel_id != channel_id:
            raise ValueError(f"parent post {parent_post_id} is in a different channel")
        if parent.status not in ("published", "streaming"):
            raise ValueError(
                f"parent post {parent_post_id} is not visible (status={parent.status})"
            )

    @staticmethod
    def create_mm_post(
        session: Session,
        channel_id: str,
        agent_id: str,
        message: str,
        status: str = "published",
        parent_post_id: int | None = None,
        trace_id: str | None = None,
    ) -> int:
        from clawbits.db.table_read import TableRead

        TableWrite._validate_parent_post(session, channel_id, parent_post_id)
        # Response approval was removed in favour of contact permissions, so an
        # agent reply is never held: a ``draft`` requested by an older plugin
        # publishes immediately. (``streaming`` is a separate, still-valid state.)
        effective_status = "published" if status == "draft" else status
        post = MmPost(
            channel_id=channel_id,
            agent_id=agent_id,
            message=message,
            status=effective_status,
            parent_post_id=parent_post_id,
            trace_id=trace_id,
        )
        session.add(post)
        session.flush()
        if effective_status == "published":
            TableWrite._set_channel_preview(
                session, channel_id, message,
                human_id=None, agent_id=agent_id,
                author_display_name=TableRead.resolve_agent_display(session, agent_id),
            )
        return post.post_id

    @staticmethod
    def create_mm_post_human(
        session: Session,
        channel_id: str,
        human_id: int,
        message: str,
        status: str = "published",
        parent_post_id: int | None = None,
        link_preview: dict | None = None,
        trace_id: str | None = None,
    ) -> int:
        from clawbits.db.table_read import TableRead

        TableWrite._validate_parent_post(session, channel_id, parent_post_id)
        post = MmPost(
            channel_id=channel_id,
            human_id=human_id,
            message=message,
            status=status,
            parent_post_id=parent_post_id,
            link_preview=link_preview,
            trace_id=trace_id,
        )
        session.add(post)
        session.flush()
        if status == "published":
            TableWrite._set_channel_preview(
                session, channel_id, message,
                human_id=human_id, agent_id=None,
                author_display_name=TableRead.resolve_human_display(session, human_id),
            )
        return post.post_id

    @staticmethod
    def create_mm_channel_event(
        session: Session,
        channel_id: str,
        event_type: str,
        *,
        actor_human_id: int | None = None,
        actor_agent_id: str | None = None,
        subject_human_id: int | None = None,
        subject_agent_id: str | None = None,
        payload: dict | None = None,
    ) -> int:
        """Create a channel timeline event. Returns ``event_id``, or ``0``
        when the channel is a DM (events are suppressed for 1:1s).

        Centralizes two policy rules so the call sites can stay dumb:

        * **DM suppression** — direct channels never accumulate
          ``"X added Y"`` lines; the 1:1 case is meaningless.
        * **Self-action normalization** — when ``actor`` equals
          ``subject`` the subject is nulled out so the renderer picks
          "joined" / "left" over "added X" / "removed X". The check is
          per identity kind: an agent acting on a human (or vice versa)
          is always rendered as a delegated action even if the IDs
          coincidentally match across namespaces."""
        ch = session.get(MmChannel, channel_id)
        if ch is None or ch.channel_type == "direct":
            return 0
        # Self-action: null the subject so renderer picks "joined"/"left"
        if (
            actor_human_id is not None
            and actor_human_id == subject_human_id
        ):
            subject_human_id = None
        if (
            actor_agent_id is not None
            and actor_agent_id == subject_agent_id
        ):
            subject_agent_id = None
        row = MmChannelEvent(
            channel_id=channel_id,
            event_type=event_type,
            actor_human_id=actor_human_id,
            actor_agent_id=actor_agent_id,
            subject_human_id=subject_human_id,
            subject_agent_id=subject_agent_id,
            payload=payload,
        )
        session.add(row)
        session.flush()
        return row.event_id

    @staticmethod
    def _upsert_human_channel_state(
        session: Session,
        human_id: int,
        channel_id: str,
        mutate: Callable[[HumanChannelState], None],
    ) -> HumanChannelState:
        """Find-or-create a (human, channel) state row and apply ``mutate``.

        Used by :meth:`mark_mm_channel_read` and :meth:`set_mm_channel_muted`
        — both of which read the row, possibly modify it, and stamp
        ``updated_at``. The shape factored out here keeps each public
        helper to ~5 lines of intent.
        """
        row = session.exec(
            select(HumanChannelState)
            .where(HumanChannelState.human_id == human_id)
            .where(HumanChannelState.channel_id == channel_id)
        ).first()
        if row is None:
            row = HumanChannelState(human_id=human_id, channel_id=channel_id)
        mutate(row)
        row.updated_at = _dt.datetime.now(_dt.UTC)
        session.add(row)
        session.flush()
        return row

    @staticmethod
    def mark_mm_channel_read(
        session: Session, channel_id: str, human_id: int, post_id: int
    ) -> int:
        """Upsert read pointer for (human, channel). Monotonic — caller may
        pass any seen post_id; the pointer never moves backwards.

        Returns the new effective ``last_read_post_id``.
        """
        def advance(row: HumanChannelState) -> None:
            if row.last_read_post_id is None or post_id > row.last_read_post_id:
                row.last_read_post_id = post_id

        row = TableWrite._upsert_human_channel_state(
            session, human_id, channel_id, advance
        )
        return row.last_read_post_id or 0

    @staticmethod
    def mark_mm_channel_read_agent(
        session: Session, channel_id: str, agent_id: str, post_id: int
    ) -> int:
        """Upsert the agent read pointer for (agent, channel). Monotonic —
        the pointer never moves backwards, so replays and out-of-order acks
        are harmless. The caller clamps ``post_id`` to a real post in the
        channel; this helper only enforces forward motion.

        Returns the new effective ``last_read_post_id``.
        """
        row = session.exec(
            select(AgentChannelState)
            .where(AgentChannelState.agent_id == agent_id)
            .where(AgentChannelState.channel_id == channel_id)
        ).first()
        if row is None:
            row = AgentChannelState(agent_id=agent_id, channel_id=channel_id)
        if row.last_read_post_id is None or post_id > row.last_read_post_id:
            row.last_read_post_id = post_id
        row.updated_at = _dt.datetime.now(_dt.UTC)
        session.add(row)
        session.flush()
        return row.last_read_post_id or 0

    @staticmethod
    def set_mm_channel_muted(
        session: Session, channel_id: str, human_id: int, muted: bool
    ) -> bool:
        """Toggle ``muted_at`` on the (human, channel) state row. Returns
        the resulting muted bool."""
        now = _dt.datetime.now(_dt.UTC)
        row = TableWrite._upsert_human_channel_state(
            session,
            human_id,
            channel_id,
            lambda r: setattr(r, "muted_at", now if muted else None),
        )
        return row.muted_at is not None

    @staticmethod
    def set_mm_channel_pinned(
        session: Session, channel_id: str, human_id: int, pinned: bool
    ) -> bool:
        """Toggle ``pinned_at`` on the (human, channel) state row. Returns
        the resulting pinned bool."""
        now = _dt.datetime.now(_dt.UTC)
        row = TableWrite._upsert_human_channel_state(
            session,
            human_id,
            channel_id,
            lambda r: setattr(r, "pinned_at", now if pinned else None),
        )
        return row.pinned_at is not None

    @staticmethod
    def delete_mm_channel(session: Session, channel_id: str) -> dict | None:
        """Hard-delete a channel and everything attached to it.

        Returns ``{"channel": <dict>, "human_member_ids": [...]}`` so the
        caller can fan out ``channel.removed`` to each former member's
        personal SSE topic. Returns ``None`` if the channel doesn't exist.

        Deletion order matters because not every FK has ``ondelete``:
          1. ``human_channel_state`` and ``agent_channel_state`` — both
             reference ``mm_channels`` and ``mm_posts`` (the
             ``last_read_post_id`` pointer). Clear first so the post delete
             below isn't blocked.
          2. ``mm_channel_members`` — direct FK to ``mm_channels``.
          3. ``mm_files`` (channel scope) — direct FK to ``mm_channels``.
             ``mm_files.post_id`` is ``ON DELETE SET NULL`` so order versus
             posts doesn't matter, but we clear them outright here.
          4. ``mm_posts`` — cascades reactions automatically; the
             self-referential ``parent_post_id`` resolves at statement end
             because Postgres validates the FK once per statement, not
             per row.
          5. ``mm_channel_events`` - member.added/removed timeline rows;
             direct FK to ``mm_channels`` with no ``ondelete``, so they
             must be cleared or the channel delete is blocked (older agent
             channels that accumulated events couldn't be deleted).
          6. ``mm_channels`` — the row itself.

        Callers are expected to ``session.commit()`` after this returns;
        we only ``flush()``.
        """
        from clawbits.db.table_read import TableRead

        channel = session.get(MmChannel, channel_id)
        if channel is None:
            return None

        # Snapshot of who used to receive events for this channel —
        # needed so the endpoint can publish ``channel.removed`` to each
        # person's personal SSE topic AFTER the transaction commits.
        member_rows = session.exec(
            select(MmChannelMember.human_id).where(
                MmChannelMember.channel_id == channel_id
            )
        ).all()
        human_member_ids = [int(h) for h in member_rows if h is not None]

        channel_snapshot = TableRead._channel_to_dict(channel, session)

        session.exec(
            delete(HumanChannelState).where(
                HumanChannelState.channel_id == channel_id
            )
        )
        session.exec(
            delete(AgentChannelState).where(
                AgentChannelState.channel_id == channel_id
            )
        )
        session.exec(
            delete(MmChannelMember).where(
                MmChannelMember.channel_id == channel_id
            )
        )
        session.exec(
            delete(MmFile).where(MmFile.channel_id == channel_id)
        )
        session.exec(
            delete(MmPost).where(MmPost.channel_id == channel_id)
        )
        session.exec(
            delete(MmChannelEvent).where(
                MmChannelEvent.channel_id == channel_id
            )
        )
        session.delete(channel)
        session.flush()

        return {
            "channel": channel_snapshot,
            "human_member_ids": human_member_ids,
        }

    @staticmethod
    def update_agent_settings(
        session: Session,
        agent_id: str,
        *,
        inter_agent_mode_enabled: bool | None = None,
        snoozed: bool | None = None,
        inter_agent_message_limit: int | None = None,
        lobstertalk_enabled: bool | None = None,
        lobstertalk_ollama_host: str | None = None,
        clear_lobstertalk_ollama_host: bool = False,
        lobstertalk_ollama_model: str | None = None,
        clear_lobstertalk_ollama_model: bool = False,
        lobstertalk_interval_seconds: int | None = None,
        lobstertalk_message_limit: int | None = None,
    ) -> Agent | None:
        agent = session.get(Agent, agent_id)
        if agent is None:
            return None
        if inter_agent_mode_enabled is not None:
            agent.inter_agent_mode_enabled = inter_agent_mode_enabled
        if snoozed is not None:
            agent.snoozed = snoozed
        if inter_agent_message_limit is not None:
            if inter_agent_message_limit < 1 or inter_agent_message_limit > 50:
                raise ValueError("inter_agent_message_limit must be between 1 and 50")
            agent.inter_agent_message_limit = inter_agent_message_limit
        if lobstertalk_enabled is not None:
            agent.lobstertalk_enabled = lobstertalk_enabled
        # host/model are nullable: None normally means "not provided", so
        # clearing needs an explicit flag from the endpoint layer.
        if clear_lobstertalk_ollama_host:
            agent.lobstertalk_ollama_host = None
        elif lobstertalk_ollama_host is not None:
            agent.lobstertalk_ollama_host = lobstertalk_ollama_host
        if clear_lobstertalk_ollama_model:
            agent.lobstertalk_ollama_model = None
        elif lobstertalk_ollama_model is not None:
            agent.lobstertalk_ollama_model = lobstertalk_ollama_model
        if lobstertalk_interval_seconds is not None:
            if lobstertalk_interval_seconds < 15 or lobstertalk_interval_seconds > 3600:
                raise ValueError("lobstertalk_interval_seconds must be between 15 and 3600")
            agent.lobstertalk_interval_seconds = lobstertalk_interval_seconds
        if lobstertalk_message_limit is not None:
            if lobstertalk_message_limit < 10 or lobstertalk_message_limit > 200:
                raise ValueError("lobstertalk_message_limit must be between 10 and 200")
            agent.lobstertalk_message_limit = lobstertalk_message_limit
        session.add(agent)
        session.flush()
        return agent

    @staticmethod
    def rename_agent(session: Session, agent_id: str, nickname: str) -> Agent | None:
        """Replace the agent's nickname (the generated default name).

        Also clears any agent-set ``AgentProfile.display_name``: display
        resolution prefers it over the nickname, so leaving it in place would
        silently mask the rename.
        """
        agent = session.get(Agent, agent_id)
        if agent is None:
            return None
        agent.nickname = nickname
        session.add(agent)
        profile = session.get(AgentProfile, agent_id)
        if profile is not None and profile.display_name is not None:
            profile.display_name = None
            profile.updated_at = _dt.datetime.now(_dt.UTC)
            session.add(profile)
        session.flush()
        return agent

    @staticmethod
    def edit_mm_post_human(
        session: Session,
        post_id: int,
        human_id: int,
        new_message: str,
        link_preview: dict | None | _Sentinel = _UNSET,
    ) -> MmPost:
        """Rewrite the text of a human-authored published post.

        Validation lives here (not the endpoint) so the agent-side path can
        share it cleanly if/when we add agent edits:

        * post must exist
        * post must be human-authored by ``human_id``
        * post must be ``published`` (drafts/streaming/rejected are out of scope)
        * ``new_message`` must be non-empty

        Raises ``LookupError`` if missing, ``PermissionError`` for wrong author,
        ``ValueError`` for status or empty-message violations. Stamps ``edited_at``
        so the UI can render the "(edited)" marker.

        ``link_preview`` is a tri-state: ``_Sentinel`` (the default) means
        "leave the existing embedded card alone"; ``None`` means "clear it";
        a ``dict`` means "replace it". Callers resolve the new embed
        before opening the DB session and pass the result here.
        """
        post = session.get(MmPost, post_id)
        if post is None:
            raise LookupError(f"post {post_id} not found")
        if post.human_id != human_id or post.agent_id is not None:
            raise PermissionError("only the author can edit this post")
        if post.status != "published":
            raise ValueError(f"post {post_id} is not editable (status={post.status})")
        if not new_message.strip():
            raise ValueError("edited message must contain text")

        post.message = new_message
        post.edited_at = _dt.datetime.now(_dt.UTC)
        if not isinstance(link_preview, _Sentinel):
            post.link_preview = link_preview
        session.add(post)
        session.flush()
        # Keep the channel's denormalised sidebar preview honest: editing
        # the newest message would otherwise leave the pre-edit text in the
        # chats list forever. A no-op for older posts.
        TableWrite._recompute_channel_preview(session, post.channel_id)
        return post

    @staticmethod
    def delete_mm_post_human(
        session: Session,
        post_id: int,
        human_id: int,
    ) -> MmPost:
        """Hard-delete a post. Returns the deleted row (detached) so the
        caller can fan out a ``post.deleted`` event with channel_id intact.

        Authorization: the caller must be either the post's author or the
        channel's creator (``MmChannel.created_by_human``). Agent-authored
        posts can be deleted by humans too — channel creators moderate
        agent posts, and an author-only rule would otherwise leave them
        with no moderation handle.

        Behavior:
          * Replies pointing at this post (``parent_post_id = post_id``)
            are detached (set to NULL) so the thread tail survives.
          * Reactions cascade automatically (FK ``ON DELETE CASCADE``).
          * Attached files unbind automatically (FK ``ON DELETE SET NULL``).
          * Drafts/streaming/rejected posts are all deletable — there's no
            visibility reason to gate this like edits do.

        Raises ``LookupError`` if the post doesn't exist, ``PermissionError``
        if the caller is neither author nor channel creator.
        """
        post = session.get(MmPost, post_id)
        if post is None:
            raise LookupError(f"post {post_id} not found")

        is_author = post.human_id == human_id and post.agent_id is None
        if not is_author:
            channel = session.get(MmChannel, post.channel_id)
            is_channel_creator = (
                channel is not None and channel.created_by_human == human_id
            )
            if not is_channel_creator:
                raise PermissionError(
                    "only the author or channel creator can delete this post"
                )

        snapshot = MmPost(
            post_id=post.post_id,
            channel_id=post.channel_id,
            agent_id=post.agent_id,
            human_id=post.human_id,
            message=post.message,
            parent_post_id=post.parent_post_id,
            status=post.status,
        )

        children = session.exec(
            select(MmPost).where(MmPost.parent_post_id == post_id)
        ).all()
        for child in children:
            child.parent_post_id = None
            session.add(child)

        # ``human_channel_state.last_read_post_id`` has no ON DELETE cascade
        # configured — Postgres would block the row delete with an FK
        # violation if any human had this exact post as their read pointer.
        #
        # Repoint rather than clear. ``NULL`` doesn't mean "unknown" to the
        # unread query, it means "nothing read in this channel" (it reads as
        # ``coalesce(last_read_post_id, 0)``), so nulling re-marks the entire
        # history unread. That isn't a rare blip: deleting your own newest
        # message is the common case, and the newest post is exactly the one
        # every caught-up reader's pointer sits on — one delete relights the
        # whole channel and the app badge for all of them. The newest
        # surviving post older than this one preserves what those readers
        # had actually seen. ``None`` only when nothing older exists, which
        # is the honest answer there.
        predecessor_id = session.exec(
            select(func.max(MmPost.post_id))
            .where(MmPost.channel_id == post.channel_id)
            .where(MmPost.post_id < post_id)
        ).first()
        stale_states = session.exec(
            select(HumanChannelState).where(
                HumanChannelState.last_read_post_id == post_id
            )
        ).all()
        for state in stale_states:
            state.last_read_post_id = predecessor_id
            session.add(state)
        # Agent read pointers share the FK and the same repoint-don't-null
        # rationale: a nulled agent pointer replays the channel as restart
        # backlog on the agent's next boot.
        stale_agent_states = session.exec(
            select(AgentChannelState).where(
                AgentChannelState.last_read_post_id == post_id
            )
        ).all()
        for state in stale_agent_states:
            state.last_read_post_id = predecessor_id
            session.add(state)

        session.delete(post)
        session.flush()
        # The channel's denormalised sidebar preview may have been pointing
        # at this exact row — rebuild it from what's left so the snippet
        # doesn't outlive the message it came from. Unconditional rather
        # than gated on "was this the latest post?": one indexed lookup on
        # a rare, user-initiated action is cheaper than the bug class where
        # the guard and the read path's notion of "latest" drift apart.
        TableWrite._recompute_channel_preview(session, snapshot.channel_id)
        return snapshot

    @staticmethod
    def toggle_mm_post_reaction(
        session: Session,
        post_id: int,
        emoji: str,
        *,
        human_id: int | None = None,
        agent_id: str | None = None,
    ) -> bool:
        """Toggle a reaction. Returns ``True`` if the reaction was added, ``False``
        if it was removed.

        Raises ``ValueError`` if the post doesn't exist or is in a state where
        reactions don't make sense (draft / rejected) — those messages are
        hidden from most viewers, so allowing reactions would create signal
        the author can't see.
        """
        if (human_id is None) == (agent_id is None):
            raise ValueError("exactly one of human_id or agent_id is required")

        post = session.get(MmPost, post_id)
        if post is None:
            raise ValueError(f"post {post_id} not found")
        if post.status not in ("published", "streaming"):
            raise ValueError(
                f"post {post_id} is not visible (status={post.status})"
            )

        stmt = select(MmPostReaction).where(
            MmPostReaction.post_id == post_id,
            MmPostReaction.emoji == emoji,
        )
        if human_id is not None:
            stmt = stmt.where(MmPostReaction.human_id == human_id)
        else:
            stmt = stmt.where(MmPostReaction.agent_id == agent_id)
        existing = session.exec(stmt).first()

        if existing is not None:
            session.delete(existing)
            session.flush()
            return False

        row = MmPostReaction(
            post_id=post_id,
            emoji=emoji,
            human_id=human_id,
            agent_id=agent_id,
        )
        session.add(row)
        session.flush()
        return True

    @staticmethod
    def pin_mm_post_human(
        session: Session,
        post_id: int,
        human_id: int,
    ) -> MmPost:
        """Pin a channel post. Any channel member can pin; idempotent.

        Stamps ``pinned_at`` with the current UTC time and records the
        actor in ``pinned_by_human_id``. If the post is already pinned,
        the existing timestamp/actor are preserved so re-pinning doesn't
        bump its position in the popover.

        Raises ``LookupError`` if the post doesn't exist, ``ValueError``
        for posts in a non-visible state (drafts / rejected / streaming).
        """
        post = session.get(MmPost, post_id)
        if post is None:
            raise LookupError(f"post {post_id} not found")
        if post.status != "published":
            raise ValueError(
                f"post {post_id} is not pinnable (status={post.status})"
            )
        if post.pinned_at is None:
            post.pinned_at = _dt.datetime.now(_dt.UTC)
            post.pinned_by_human_id = human_id
            session.add(post)
            session.flush()
        return post

    @staticmethod
    def unpin_mm_post_human(
        session: Session,
        post_id: int,
    ) -> MmPost:
        """Unpin a channel post. Any channel member can unpin; idempotent.

        Clears ``pinned_at`` and ``pinned_by_human_id``. No-op if the
        post is already unpinned.

        Raises ``LookupError`` if the post doesn't exist.
        """
        post = session.get(MmPost, post_id)
        if post is None:
            raise LookupError(f"post {post_id} not found")
        if post.pinned_at is not None:
            post.pinned_at = None
            post.pinned_by_human_id = None
            session.add(post)
            session.flush()
        return post

    @staticmethod
    def patch_mm_post(
        session: Session,
        post_id: int,
        channel_id: str,
        agent_id: str,
        *,
        append: str | None = None,
        replace: str | None = None,
        finalise: bool = False,
        cancel: bool = False,
    ) -> MmPost | None:
        """Patch a streaming post in place (agent-streamed reply).

        Enforces ownership + streaming state in the same GET used for the
        mutation so the endpoint doesn't need a separate pre-check. Raises
        ``LookupError`` when the post is missing / not in the channel,
        ``PermissionError`` when the caller is not the post owner, and
        ``ValueError`` when the post is no longer streaming.

        On ``finalise``, always transitions ``streaming`` to ``published``.
        Approval gating now applies to inbound human messages, not to the
        agent's reply.

        On ``cancel``, the row is deleted outright. Used by the plugin
        when the runner produced no reply for an inbound — without this,
        the channel UI would render an empty post placeholder where the
        shimmer used to be.
        """
        from datetime import UTC, datetime

        post = session.get(MmPost, post_id)
        if post is None or post.channel_id != channel_id:
            raise LookupError("post not found")
        if post.agent_id != agent_id:
            raise PermissionError("not the post owner")
        if post.status != "streaming":
            raise ValueError("post is not streaming")
        if cancel:
            session.delete(post)
            session.flush()
            return None
        if append is not None:
            post.message = (post.message or "") + append
        elif replace is not None:
            post.message = replace
        if finalise:
            # Agent replies always publish immediately. The owner-approval
            # gate now applies to *inbound* human messages (see
            # ``human_mm_endpoints.create_post``), not to the agent's
            # outbound — a user opted in to receiving the reply by
            # tagging the agent in the first place.
            post.status = "published"
        post.updated_at = datetime.now(UTC)
        session.add(post)
        session.flush()
        if finalise:
            from clawbits.db.table_read import TableRead

            TableWrite._set_channel_preview(
                session, channel_id, post.message or "",
                human_id=None, agent_id=agent_id,
                author_display_name=TableRead.resolve_agent_display(session, agent_id),
            )
        return post

    @staticmethod
    def reap_stale_streaming_posts(
        session: Session, *, older_than: datetime
    ) -> list[dict]:
        """Delete streaming posts abandoned before ``older_than``.

        A ``streaming`` row only leaves that state through the owning agent's
        PATCH (``done`` → published, ``cancel`` → deleted). An agent that
        crashes mid-stream leaves the row ``streaming`` forever, which (a)
        pins its presence pill on "generating…" and (b) blocks the delivery
        watermark of every polling consumer (the IronClaw channel refuses to
        advance past a non-published post) — the channel looks frozen. The
        streaming PATCH path stamps ``updated_at`` on every append, so a
        stale ``updated_at`` is a reliable abandonment signal.

        Returns one dict per reaped post: ``post_id``, ``channel_id``,
        ``agent_id``, and ``agent_still_streaming`` — whether the same agent
        still has another (fresher) streaming post in that channel, in which
        case its "generating…" presence is still legitimate and must not be
        flipped back to online.
        """
        stale = session.exec(
            select(MmPost).where(
                MmPost.status == "streaming",
                MmPost.updated_at < older_than,  # type: ignore[operator]
            )
        ).all()
        for post in stale:
            session.delete(post)
        session.flush()

        reaped: list[dict] = []
        for post in stale:
            still_streaming = (
                session.exec(
                    select(MmPost.post_id).where(
                        MmPost.channel_id == post.channel_id,
                        MmPost.agent_id == post.agent_id,
                        MmPost.status == "streaming",
                    )
                ).first()
                is not None
            )
            reaped.append(
                {
                    "post_id": post.post_id,
                    "channel_id": post.channel_id,
                    "agent_id": post.agent_id,
                    "agent_still_streaming": still_streaming,
                }
            )
        return reaped

    @staticmethod
    def ensure_agent_default_mm_channel(session: Session, agent_id: str) -> dict:
        from clawbits.db.table_read import TableRead

        org_id = TableRead.get_agent_org_id(session, agent_id)
        if org_id is None:
            raise ValueError(f"Agent '{agent_id}' has no organization")

        channel_name = f"agent-{agent_id}"
        channel = TableRead.get_mm_channel_by_org_and_name(session, org_id, channel_name)
        if channel is None:
            TableWrite.create_mm_channel(
                session,
                channel_id=str(_uuid.uuid4()),
                name=channel_name,
                channel_type="public",
                display_name=agent_id,
                org_id=org_id,
            )
            channel = TableRead.get_mm_channel_by_org_and_name(
                session, org_id, channel_name
            )

        TableWrite.add_mm_channel_member(session, channel["channel_id"], agent_id)
        return channel

    @staticmethod
    def ensure_owner_agent_comm_channel(
        session: Session, agent_id: str
    ) -> tuple[dict, bool]:
        """Get-or-create the operator↔agent DM. Returns ``(channel, created)``.

        ``created`` is True only when this call inserted the row, so callers
        can fire one-time hooks (e.g. ``fire_channel_avatar``) without
        re-running them on every approval / fetch.

        Two lookup strategies are tried in order:
          1. By membership — find a direct channel where both parties are
             members. This is the canonical resolver and works for any DM
             regardless of its name.
          2. By canonical name — ``dm-human-{operator}-agent-{agent}`` in
             the agent's org. Used as a fallback so we never blow up on
             the ``uq_mm_channels_org_name`` unique constraint when an
             orphan channel (e.g. left over from a previous partially-
             committed write, or a re-used agent_id after deletion)
             already squats the name. If found, we reconcile membership
             so future membership-based lookups succeed.
        """
        from clawbits.db.table_read import TableRead

        agent = session.get(Agent, agent_id)
        if agent is None:
            raise ValueError(f"Agent '{agent_id}' not found")
        org_id = agent.org_id
        human_id = agent.operator_id
        if org_id is None or human_id is None:
            raise ValueError(f"Agent '{agent_id}' has no operator or organization")

        existing = TableRead.find_dm_channel_human_agent(
            session, int(human_id), agent_id, org_id
        )
        if existing is not None:
            return existing, False

        dm_name = agent_dm_channel_name(int(human_id), agent_id)
        display_name = f"DM: {agent_id}"

        # Fallback: a row with the canonical name already exists but
        # membership has drifted (orphan from a previous failed write or
        # an agent_id that was re-used after deletion). Reuse it —
        # creating a new one would 409 on uq_mm_channels_org_name.
        squatter = TableRead.get_mm_channel_by_org_and_name(session, org_id, dm_name)
        if squatter is not None:
            squatter_channel_id = squatter["channel_id"]
            if not TableRead.is_mm_channel_member_human(
                session, squatter_channel_id, int(human_id)
            ):
                TableWrite.add_mm_channel_member_human(
                    session, squatter_channel_id, int(human_id)
                )
            if not TableRead.is_mm_channel_member(session, squatter_channel_id, agent_id):
                TableWrite.add_mm_channel_member(
                    session, squatter_channel_id, agent_id
                )
            channel = TableRead.get_mm_channel(session, squatter_channel_id)
            if channel is None:
                raise ValueError(
                    "Failed to load reused operator-agent communication channel"
                )
            return channel, False

        channel_id = str(_uuid.uuid4())
        # Keep DM titles tight: just the agent's name. The operator side is implicit
        # (the human is always one party in their own DM with the agent).
        TableWrite.create_mm_channel(
            session,
            channel_id=channel_id,
            name=dm_name,
            channel_type="direct",
            display_name=display_name,
            org_id=org_id,
            created_by_agent=agent_id,
            created_by_human=int(human_id),
        )
        TableWrite.add_mm_channel_member_human(session, channel_id, int(human_id))
        TableWrite.add_mm_channel_member(session, channel_id, agent_id)
        channel = TableRead.get_mm_channel(session, channel_id)
        if channel is None:
            raise ValueError("Failed to load created operator-agent communication channel")
        return channel, True

    # ---------------- agent actions ----------------

    @staticmethod
    def upsert_agent_action(
        session: Session, agent_id: str, action_id: str, action_md: str
    ) -> None:
        row = session.get(AgentAction, (agent_id, action_id))
        if row is None:
            session.add(
                AgentAction(
                    agent_id=agent_id,
                    action_id=action_id,
                    action_md=action_md,
                    updated_at=_dt.datetime.now(_dt.UTC),
                )
            )
        else:
            row.action_md = action_md
            row.updated_at = _dt.datetime.now(_dt.UTC)
        session.flush()

    @staticmethod
    def delete_agent_action(
        session: Session, agent_id: str, action_id: str
    ) -> bool:
        row = session.get(AgentAction, (agent_id, action_id))
        if row is None:
            return False
        session.delete(row)
        session.flush()
        return True

    # ---------------- agent profiles ----------------

    @staticmethod
    def upsert_agent_profile(
        session: Session,
        agent_id: str,
        display_name: str | None = None,
        bio: str | None = None,
        location: str | None = None,
        website: str | None = None,
        avatar_url: str | None = None,
        header_url: str | None = None,
    ) -> None:
        row = session.get(AgentProfile, agent_id)
        now = _dt.datetime.now(_dt.UTC)
        if row is None:
            session.add(
                AgentProfile(
                    agent_id=agent_id,
                    display_name=display_name,
                    bio=bio,
                    location=location,
                    website=website,
                    avatar_url=avatar_url,
                    header_url=header_url,
                    updated_at=now,
                )
            )
        else:
            row.display_name = display_name
            row.bio = bio
            row.location = location
            row.website = website
            row.avatar_url = avatar_url
            row.header_url = header_url
            row.updated_at = now
        session.flush()

    @staticmethod
    def set_agent_description(
        session: Session,
        agent_id: str,
        description: str,
        *,
        source: str = "auto",
    ) -> None:
        """Store a freshly (agent-)generated description, stamp it, and clear
        any pending owner regenerate request. Leaves the rest of the profile
        (display_name/bio/…) untouched."""
        now = _dt.datetime.now(_dt.UTC)
        text = (description or "").strip()[:280]
        row = session.get(AgentProfile, agent_id)
        if row is None:
            session.add(
                AgentProfile(
                    agent_id=agent_id,
                    description=text,
                    description_generated_at=now,
                    description_source=source,
                    description_regen_requested_at=None,
                    updated_at=now,
                )
            )
        else:
            row.description = text
            row.description_generated_at = now
            row.description_source = source
            row.description_regen_requested_at = None
            row.updated_at = now
        session.flush()

    @staticmethod
    def request_agent_description_regen(session: Session, agent_id: str) -> None:
        """Flag the agent to regenerate its description on its next check-in.
        The agent sees this via ``GET /info`` and clears it by pushing a new
        description. Generation happens agent-side; the server only relays."""
        now = _dt.datetime.now(_dt.UTC)
        row = session.get(AgentProfile, agent_id)
        if row is None:
            session.add(
                AgentProfile(
                    agent_id=agent_id,
                    description_regen_requested_at=now,
                    updated_at=now,
                )
            )
        else:
            row.description_regen_requested_at = now
            row.updated_at = now
        session.flush()

    # ---------------- agent signup requests ----------------

    @staticmethod
    def create_signup_request(
        session: Session,
        request_id: str,
        agent_id: str,
        org_id: str,
    ) -> None:
        session.add(
            AgentSignupRequest(
                request_id=request_id,
                agent_id=agent_id,
                org_id=org_id,
                status="pending_approval",
            )
        )
        session.flush()

    @staticmethod
    def approve_signup_request(
        session: Session, request_id: str, reviewed_by: int
    ) -> None:
        row = session.get(AgentSignupRequest, request_id)
        if row is not None and row.status == "pending_approval":
            row.status = "approved"
            row.reviewed_by = reviewed_by
            row.reviewed_at = _dt.datetime.now(_dt.UTC)
            session.flush()

    @staticmethod
    def approve_pending_signup_requests_for_agent(
        session: Session, agent_id: str, reviewer_human_id: int
    ) -> int:
        """Auto-approve all pending requests for one agent. Used by the
        claim resolver when a human first signs in via WorkOS and we link
        the agents they'd been pre-claimed for. Returns the count approved."""
        rows = session.exec(
            select(AgentSignupRequest)
            .where(AgentSignupRequest.agent_id == agent_id)
            .where(AgentSignupRequest.status == "pending_approval")
        ).all()
        for row in rows:
            row.status = "approved"
            row.reviewed_by = reviewer_human_id
            row.reviewed_at = _dt.datetime.now(_dt.UTC)
        session.flush()
        return len(rows)

    @staticmethod
    def reject_signup_request(
        session: Session, request_id: str, reviewed_by: int
    ) -> None:
        row = session.get(AgentSignupRequest, request_id)
        if row is not None and row.status == "pending_approval":
            row.status = "rejected"
            row.reviewed_by = reviewed_by
            row.reviewed_at = _dt.datetime.now(_dt.UTC)
            session.flush()

    # ---------------- mm_files (chat attachments) ----------------

    @staticmethod
    def create_mm_file(
        session: Session,
        *,
        file_id: str,
        channel_id: str,
        filename: str,
        content_type: str,
        size_bytes: int,
        object_key: str,
        uploader_human_id: int | None = None,
        uploader_agent_id: str | None = None,
        sha256: str | None = None,
        thumbnail_object_key: str | None = None,
    ) -> str:
        """Insert a new ``mm_files`` row in ``pending`` state.

        The caller provides ``file_id`` so the R2 object key (which embeds
        the id) and the row stay in sync. Use
        :func:`clawbits.fastapi.mm_file_helpers.new_file_id` to mint one.
        Returns the same ``file_id`` for chainability. Caller is expected
        to commit; this just adds + flushes.
        """
        if (uploader_human_id is None) == (uploader_agent_id is None):
            raise ValueError(
                "exactly one of uploader_human_id / uploader_agent_id required"
            )
        row = MmFile(
            file_id=file_id,
            channel_id=channel_id,
            uploader_human_id=uploader_human_id,
            uploader_agent_id=uploader_agent_id,
            object_key=object_key,
            thumbnail_object_key=thumbnail_object_key,
            filename=filename,
            content_type=content_type,
            size_bytes=size_bytes,
            sha256=sha256,
            status="pending",
        )
        session.add(row)
        session.flush()
        return file_id

    @staticmethod
    def confirm_mm_file(
        session: Session,
        file_id: str,
        *,
        uploader_human_id: int | None = None,
        uploader_agent_id: str | None = None,
        width: int | None = None,
        height: int | None = None,
        duration_ms: int | None = None,
        sha256: str | None = None,
        thumbnail_uploaded: bool | None = None,
    ) -> MmFile:
        """Flip a file from ``pending`` → ``uploaded`` and record metadata.

        Idempotent on an already-``uploaded`` row owned by the same caller
        (re-confirm is a no-op so retries from a flaky client are safe).
        Raises ``ValueError`` for missing row, wrong uploader, or wrong
        starting state.

        ``thumbnail_uploaded`` is tri-state: ``True`` keeps the reserved
        thumbnail key, ``False`` (the client reporting a failed thumbnail
        PUT) drops it, and ``None`` — a metadata-only re-confirm such as
        the server's dimension-probe write-back — leaves it untouched.
        """
        row = session.get(MmFile, file_id)
        if row is None:
            raise ValueError(f"file {file_id} not found")
        if uploader_human_id is not None and row.uploader_human_id != uploader_human_id:
            raise ValueError(f"file {file_id} not owned by caller")
        if uploader_agent_id is not None and row.uploader_agent_id != uploader_agent_id:
            raise ValueError(f"file {file_id} not owned by caller")
        if row.status not in ("pending", "uploaded"):
            raise ValueError(f"file {file_id} not confirmable (status={row.status})")

        if row.status == "pending":
            row.status = "uploaded"
            row.uploaded_at = _dt.datetime.now(_dt.UTC)
        # Metadata may arrive on the confirm even if status was already
        # ``uploaded`` (e.g. client retried after a network blip).
        if width is not None:
            row.width = width
        if height is not None:
            row.height = height
        if duration_ms is not None:
            row.duration_ms = duration_ms
        if sha256 is not None:
            row.sha256 = sha256
        if thumbnail_uploaded is False:
            # Client said "thumbnail upload failed" — drop the key so we
            # don't surface a broken URL later. (``None`` means the caller
            # isn't speaking about the thumbnail at all — don't touch it.)
            row.thumbnail_object_key = None
        session.flush()
        return row

    @staticmethod
    def attach_files_to_post(
        session: Session,
        post_id: int,
        file_ids: list[str],
        channel_id: str,
        *,
        uploader_human_id: int | None = None,
        uploader_agent_id: str | None = None,
    ) -> None:
        """Atomically bind ``file_ids`` to ``post_id``.

        Validates each file is uploaded, in the same channel, owned by the
        caller, and not yet attached. Raises ``ValueError`` on the first
        violation — caller rolls back the surrounding transaction.
        """
        if not file_ids:
            return
        if len(file_ids) != len(set(file_ids)):
            raise ValueError("file_ids contains duplicates")

        rows = session.exec(
            select(MmFile).where(MmFile.file_id.in_(file_ids))
        ).all()
        by_id = {r.file_id: r for r in rows}
        for fid in file_ids:
            r = by_id.get(fid)
            if r is None:
                raise ValueError(f"file {fid} not found")
            if r.deleted_at is not None or r.status == "deleted":
                raise ValueError(f"file {fid} is deleted")
            if r.status != "uploaded":
                raise ValueError(
                    f"file {fid} not uploaded (status={r.status})"
                )
            if r.post_id is not None:
                raise ValueError(
                    f"file {fid} already attached to post {r.post_id}"
                )
            if r.channel_id != channel_id:
                raise ValueError(f"file {fid} not in this channel")
            if (
                uploader_human_id is not None
                and r.uploader_human_id != uploader_human_id
            ):
                raise ValueError(f"file {fid} not owned by caller")
            if (
                uploader_agent_id is not None
                and r.uploader_agent_id != uploader_agent_id
            ):
                raise ValueError(f"file {fid} not owned by caller")
            r.post_id = post_id
        session.flush()

    @staticmethod
    def soft_delete_mm_file(
        session: Session,
        file_id: str,
        *,
        uploader_human_id: int | None = None,
        uploader_agent_id: str | None = None,
    ) -> MmFile | None:
        """Mark a file ``deleted``. Returns the row or ``None`` if the file
        doesn't exist or is owned by someone else (so the endpoint can 404
        without leaking ownership info)."""
        row = session.get(MmFile, file_id)
        if row is None:
            return None
        if uploader_human_id is not None and row.uploader_human_id != uploader_human_id:
            return None
        if uploader_agent_id is not None and row.uploader_agent_id != uploader_agent_id:
            return None
        if row.status == "deleted":
            return row
        row.status = "deleted"
        row.deleted_at = _dt.datetime.now(_dt.UTC)
        session.flush()
        return row

    # ------------------------------------------------------------------
    # Skills catalog
    # ------------------------------------------------------------------

    @staticmethod
    def _publish_version(
        session: Session,
        *,
        skill: Skill,
        manifest: dict,
        body_md: str,
        files: list[dict],
        changelog: str | None,
        published_by: int | None,
    ) -> SkillVersion:
        """Insert an immutable version and point the skill at it.

        Callers pass already-normalized manifest + files. The hash is recomputed
        here rather than trusted from the caller.
        """
        from clawbits.skills.spec import content_hash, next_patch_version

        current = (
            session.get(SkillVersion, skill.latest_version_id)
            if skill.latest_version_id
            else None
        )
        version = next_patch_version(current.version if current is not None else None)
        row = SkillVersion(
            version_id=f"skillver-{_uuid.uuid4().hex}",
            skill_id=skill.skill_id,
            version=version,
            content_hash=content_hash(manifest, body_md, files),
            manifest=manifest,
            body_md=body_md,
            files=files,
            total_bytes=len(body_md.encode("utf-8"))
            + sum(f["size_bytes"] for f in files),
            # v1 stores markdown references only; the column exists so the
            # install-time affordance is ready before executables are allowed.
            has_executable=False,
            changelog=changelog,
            published_by=published_by,
        )
        session.add(row)
        session.flush()

        skill.latest_version_id = row.version_id
        # Keep the card fields in step with the manifest that is actually live,
        # so a list view never disagrees with the published content.
        skill.summary = manifest["description"]
        if emoji := manifest.get("emoji"):
            skill.icon_emoji = emoji
        skill.runtimes = manifest.get("runtimes") or ["openclaw"]
        skill.updated_at = _dt.datetime.now(_dt.UTC)
        session.add(skill)
        session.flush()
        return row

    @staticmethod
    def create_skill(
        session: Session,
        *,
        org_id: str,
        slug: str,
        display_name: str,
        manifest: dict,
        body_md: str,
        files: list[dict] | None = None,
        created_by: int | None = None,
    ) -> Skill:
        """Create a skill and publish its first version. Assumes normalized input."""
        skill = Skill(
            skill_id=f"skill-{_uuid.uuid4().hex}",
            org_id=org_id,
            slug=slug,
            display_name=display_name,
            summary=manifest["description"],
            icon_emoji=manifest.get("emoji"),
            visibility="org",
            origin="authored",
            runtimes=manifest.get("runtimes") or ["openclaw"],
            created_by=created_by,
        )
        session.add(skill)
        session.flush()
        TableWrite._publish_version(
            session,
            skill=skill,
            manifest=manifest,
            body_md=body_md,
            files=files or [],
            changelog=None,
            published_by=created_by,
        )
        return skill

    @staticmethod
    def publish_skill_version(
        session: Session,
        *,
        skill: Skill,
        manifest: dict,
        body_md: str,
        files: list[dict] | None = None,
        changelog: str | None = None,
        published_by: int | None = None,
    ) -> SkillVersion:
        """Publish an edit as a new immutable version (implicit patch bump)."""
        return TableWrite._publish_version(
            session,
            skill=skill,
            manifest=manifest,
            body_md=body_md,
            files=files or [],
            changelog=changelog,
            published_by=published_by,
        )

    @staticmethod
    def update_skill_meta(
        session: Session,
        *,
        skill: Skill,
        display_name: str | None = None,
        visibility: str | None = None,
    ) -> Skill:
        """Edit catalog metadata. ``slug`` is not editable: it is the on-disk
        directory name every installed agent already uses."""
        if display_name is not None:
            skill.display_name = display_name
        if visibility is not None:
            skill.visibility = visibility
        skill.updated_at = _dt.datetime.now(_dt.UTC)
        session.add(skill)
        session.flush()
        return skill

    @staticmethod
    def fork_skill(
        session: Session,
        *,
        source: Skill,
        source_version: SkillVersion,
        target_org_id: str,
        slug: str,
        display_name: str,
        created_by: int | None = None,
    ) -> Skill:
        """Copy a skill into ``target_org_id``, recording lineage.

        The fork starts its own timeline at 1.0.0. ``name`` is rewritten to the
        new slug, since OpenClaw requires it to equal the directory name.
        """
        manifest = dict(source_version.manifest or {})
        manifest["name"] = slug

        fork = Skill(
            skill_id=f"skill-{_uuid.uuid4().hex}",
            org_id=target_org_id,
            slug=slug,
            display_name=display_name,
            summary=manifest["description"],
            icon_emoji=manifest.get("emoji"),
            visibility="org",
            origin="forked",
            runtimes=manifest.get("runtimes") or ["openclaw"],
            forked_from_skill_id=source.skill_id,
            forked_from_version_id=source_version.version_id,
            created_by=created_by,
        )
        session.add(fork)
        session.flush()
        TableWrite._publish_version(
            session,
            skill=fork,
            manifest=manifest,
            body_md=source_version.body_md,
            files=list(source_version.files or []),
            changelog=f"Forked from {source.slug} v{source_version.version}",
            published_by=created_by,
        )
        return fork

    @staticmethod
    def delete_skill(session: Session, *, skill: Skill) -> Skill:
        """Soft-delete a catalog row, and uninstall it from every agent that has
        it. Versions stay: forks reference them.

        The fan-out is the point. A soft delete leaves ``latest_version_id``
        intact, so a live install would keep resolving to a version and the
        desired feed would keep saying ``present`` forever - the org sees the
        skill gone from the library while every agent keeps running it, and a
        later publish on this same row would still propagate to all of them.
        Deletes are rare, so paying for a fan-out here is affordable in a way
        the per-publish one deliberately is not.
        """
        skill.deleted_at = _dt.datetime.now(_dt.UTC)
        skill.updated_at = skill.deleted_at
        session.add(skill)
        installs = session.exec(
            select(AgentSkillInstall).where(
                AgentSkillInstall.skill_id == skill.skill_id,
                AgentSkillInstall.managed_by == "clawbits",
                AgentSkillInstall.deleted_at.is_(None),
            )
        ).all()
        for row in installs:
            # Same tombstone path as an explicit uninstall: the row stays visible
            # as "Removing..." until the agent confirms the directory is gone.
            TableWrite.uninstall_skill(session, row=row)
        session.flush()
        return skill

    # ------------------------------------------------------------------
    # Skills sync plane (agent self-report)
    # ------------------------------------------------------------------

    # The server truncates past this and says so in the ack.
    SKILL_REPORT_MAX_ITEMS = 500

    @staticmethod
    def _wants_absent(session: Session, row: AgentSkillInstall) -> bool:
        """Whether a LIVE (non-tombstoned) managed install is desired absent.

        Mirrors the rule in ``TableRead.get_desired_skills``: disabled, or its
        catalog skill has been deleted. Keep the two in step - if the feed asks
        for a removal the report handler will not settle, the install never
        converges.
        """
        if not row.enabled:
            return True
        if row.skill_id is None:
            return False
        skill = session.get(Skill, row.skill_id)
        return skill is not None and skill.deleted_at is not None

    @staticmethod
    def apply_skill_state_report(
        session: Session,
        agent_id: str,
        *,
        skills: list[dict] | None = None,
        report_mode: str | None = None,
        skills_root: str | None = None,
        scanned_roots: list[str] | None = None,
        apply_mode: str | None = None,
        prompt_chars_observed: int | None = None,
        prompt_budget_observed: int | None = None,
        truncated: bool = False,
        plugin_version: str | None = None,
        agent_runtime_version: str | None = None,
    ) -> tuple[int, int]:
        """Apply an agent's skills self-report. Returns ``(seen, mirrored)``.

        Items are keyed by slug. Anything not matching a managed row is
        materialized as ``managed_by='external'`` so skills that arrived some
        other way are still visible.

        ``report_mode='observe'`` updates the mirror only: an observing client
        has no write path, so it cannot have applied anything.

        Everything in ``reported_*`` is agent-controlled display text, never an
        authorization input.
        """
        items = (skills or [])[: TableWrite.SKILL_REPORT_MAX_ITEMS]
        now = _dt.datetime.now(_dt.UTC)
        agent = session.get(Agent, agent_id)
        org_id = agent.org_id if agent is not None else None
        observing = report_mode == "observe"

        rows = session.exec(
            select(AgentSkillInstall).where(AgentSkillInstall.agent_id == agent_id)
        ).all()
        by_slug = {r.slug: r for r in rows}
        seen_slugs: set[str] = set()
        removed_slugs: set[str] = set()
        mirrored = 0

        for item in items:
            slug = item.get("slug")
            if not isinstance(slug, str) or not slug.strip():
                continue
            slug = slug.strip()
            row = by_slug.get(slug)

            # A verified removal: the client deleted the directory and stat'd to
            # confirm. It is NOT on disk, so it must not count as seen.
            if item.get("status") == "removed":
                if row is not None and not observing:
                    if row.deleted_at is not None:
                        removed_slugs.add(slug)
                    elif row.managed_by == "clawbits" and TableWrite._wants_absent(session, row):
                        # A disable (and a deleted catalog skill) is an 'absent'
                        # intent, NOT a delete: the row has to survive so it can be
                        # re-enabled. It still has to CONVERGE - discarding this
                        # report leaves it at 'requested' with observed_generation
                        # permanently behind desired, so the UI shows a spinner
                        # forever and the plugin re-removes an already-absent
                        # directory on every pass. Settled on the same terms as the
                        # present-path below.
                        obs = item.get("observed_generation")
                        if isinstance(obs, int):
                            row.observed_generation = obs
                        if isinstance(obs, int) and obs >= row.desired_generation:
                            if error := item.get("error"):
                                row.sync_status = "failed"
                                row.sync_error = str(error)[:2000]
                            else:
                                row.sync_status = "applied"
                                row.sync_error = None
                        row.last_reported_at = now
                        row.updated_at = now
                continue

            seen_slugs.add(slug)

            if row is None:
                row = AgentSkillInstall(
                    install_id=f"install-{_uuid.uuid4().hex}",
                    agent_id=agent_id,
                    org_id=org_id,
                    skill_id=None,
                    slug=slug,
                    managed_by="external",
                    sync_status="applied",
                )
                session.add(row)
                by_slug[slug] = row
                mirrored += 1

            row.reported_version = _as_str(item.get("version"))
            row.reported_content_hash = _as_str(item.get("content_hash"))
            row.reported_path = _as_str(item.get("path"))
            row.reported_root = _as_str(item.get("root"))
            # openclaw-bundled / -extra / -workspace / clawhub, computed by
            # OpenClaw itself rather than inferred from the path.
            row.reported_source = _as_str(item.get("source"))
            manifest = item.get("manifest")
            row.reported_manifest = manifest if isinstance(manifest, dict) else None
            state = item.get("state")
            row.reported_state = state if isinstance(state, dict) else None
            row.apply_mode = apply_mode
            row.plugin_version = plugin_version
            row.agent_runtime_version = agent_runtime_version
            row.last_seen_at = now
            row.last_reported_at = now
            row.missing_since = None
            row.missing_streak = 0
            row.updated_at = now

            if row.managed_by == "clawbits" and not observing:
                obs = item.get("observed_generation")
                error = item.get("error")
                is_current = isinstance(obs, int) and obs >= row.desired_generation
                if isinstance(obs, int):
                    row.observed_generation = obs
                if is_current:
                    if error:
                        row.sync_status = "failed"
                        row.sync_error = str(error)[:2000]
                    else:
                        row.sync_status = "applied"
                        row.sync_error = None

        # Drift only means something from a client that can write.
        if not observing:
            for row in rows:
                if row.slug in seen_slugs or row.deleted_at is not None:
                    continue
                if row.managed_by != "clawbits" or row.sync_status != "applied":
                    continue
                row.missing_streak = (row.missing_streak or 0) + 1
                if row.missing_since is None:
                    row.missing_since = now
                # Actionable, unlike automations: re-request rather than nag.
                if row.missing_streak >= 3:
                    row.sync_status = "requested"
                row.updated_at = now

        # The agent is the source of truth for skills we do not manage.
        for row in rows:
            if (
                row.managed_by == "external"
                and row.slug not in seen_slugs
                and row.last_reported_at is not None
            ):
                session.delete(row)

        # Tombstones the agent confirmed gone.
        for row in rows:
            if row.slug in removed_slugs and row.deleted_at is not None:
                session.delete(row)

        state_row = session.get(AgentSkillSyncState, agent_id)
        if state_row is None:
            state_row = AgentSkillSyncState(agent_id=agent_id)
            session.add(state_row)
        state_row.report_mode = report_mode
        state_row.skills_root = skills_root
        state_row.scanned_roots = scanned_roots
        state_row.apply_mode = apply_mode
        state_row.prompt_chars_observed = prompt_chars_observed
        state_row.prompt_budget_observed = prompt_budget_observed
        state_row.report_truncated = bool(truncated) or len(skills or []) > len(items)
        state_row.plugin_version = plugin_version
        state_row.agent_runtime_version = agent_runtime_version
        state_row.last_reported_at = now
        state_row.updated_at = now

        session.flush()
        return len(items), mirrored

    @staticmethod
    def _bump_skill_generation(session: Session, agent_id: str) -> int:
        """Raise the agent-wide desired generation and return it.

        Atomic UPDATE ... RETURNING rather than SELECT max()+1: two concurrent
        installs would otherwise read the same value and both stamp it.
        """
        session.execute(
            pg_insert(AgentSkillSyncState)
            .values(agent_id=agent_id, desired_generation=1)
            .on_conflict_do_update(
                index_elements=["agent_id"],
                set_={
                    "desired_generation": AgentSkillSyncState.__table__.c.desired_generation
                    + 1
                },
            )
        )
        row = session.get(AgentSkillSyncState, agent_id)
        if row is not None:
            session.refresh(row)
            return row.desired_generation
        return 1

    @staticmethod
    def install_skill(
        session: Session,
        *,
        agent_id: str,
        org_id: str | None,
        skill: Skill,
        installed_by: int | None = None,
    ) -> AgentSkillInstall:
        """Install a catalog skill onto an agent, or revive a removed one.

        Reviving rather than inserting matters: UNIQUE(agent_id, slug) is not
        partial, so a tombstone still occupies the slug.
        """
        row = session.exec(
            select(AgentSkillInstall).where(
                AgentSkillInstall.agent_id == agent_id,
                AgentSkillInstall.slug == skill.slug,
            )
        ).first()
        now = _dt.datetime.now(_dt.UTC)
        generation = TableWrite._bump_skill_generation(session, agent_id)

        if row is None:
            row = AgentSkillInstall(
                install_id=f"install-{_uuid.uuid4().hex}",
                agent_id=agent_id,
                org_id=org_id,
                skill_id=skill.skill_id,
                slug=skill.slug,
                managed_by="clawbits",
                installed_by=installed_by,
            )
            session.add(row)
        row.skill_id = skill.skill_id
        row.managed_by = "clawbits"
        row.enabled = True
        row.deleted_at = None
        row.desired_generation = generation
        row.sync_status = "requested"
        row.sync_error = None
        row.missing_streak = 0
        row.missing_since = None
        row.updated_at = now
        session.flush()
        return row

    @staticmethod
    def set_skill_install_enabled(
        session: Session, *, row: AgentSkillInstall, enabled: bool
    ) -> AgentSkillInstall:
        """Enable/disable. Presence of the directory is the mechanism, so a
        disable is an ordinary 'absent' intent rather than a config toggle."""
        row.enabled = enabled
        row.desired_generation = TableWrite._bump_skill_generation(session, row.agent_id)
        row.sync_status = "requested"
        row.sync_error = None
        row.updated_at = _dt.datetime.now(_dt.UTC)
        session.add(row)
        session.flush()
        return row

    @staticmethod
    def uninstall_skill(
        session: Session, *, row: AgentSkillInstall
    ) -> AgentSkillInstall:
        """Soft-delete: the row survives as a tombstone until the agent confirms
        the directory is gone, then the report handler removes it."""
        now = _dt.datetime.now(_dt.UTC)
        row.deleted_at = now
        row.sync_status = "removing"
        row.desired_generation = TableWrite._bump_skill_generation(session, row.agent_id)
        row.updated_at = now
        session.add(row)
        session.flush()
        return row

    @staticmethod
    def forget_skill_install(session: Session, *, row: AgentSkillInstall) -> None:
        """Operator escape hatch: drop the row without agent confirmation.

        Needed because the unique constraint is not partial — a permanently
        offline agent would otherwise lock its slug forever.
        """
        session.delete(row)
        session.flush()
