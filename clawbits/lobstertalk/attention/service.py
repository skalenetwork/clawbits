"""Post-creation attention pass: gather eligible agents, run the gate once, then apply the
per-agent native-handling gates and a Redis cooldown before nudging.

Fire-and-forget from the post-create path. :func:`build_attention_context` does the DB work
in the request's session; the pass itself only touches the gate, Redis and, in the LLM modes,
a short-lived session of its own for the triage transcript, so it can outlive the request.
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass, replace

from sqlalchemy import Engine
from sqlmodel import Session

from clawbits.db.models import Agent, AgentProfile, MmChannel, MmPost
from clawbits.db.table_read import TableRead
from clawbits.lobstertalk.attention.crypto import decrypt_secret
from clawbits.lobstertalk.attention.gate import Verdict, cooldown_seconds, evaluate_text
from clawbits.lobstertalk.attention.triage import (
    TRANSCRIPT_POST_LIMIT,
    LlmTriageConfig,
    triage_decide,
)
from clawbits.realtime import get_bus, publish_attention_nudge

logger = logging.getLogger(__name__)

_LLM_MODES = ("cascade", "llm_only")


@dataclass(frozen=True)
class AttentionCandidate:
    agent_id: str
    snoozed: bool
    inter_agent_mode: bool
    description: str | None = None


@dataclass(frozen=True)
class AttentionContext:
    """``llm`` is None in embedding mode, and in an LLM mode whose org config is unusable:
    the pass then fails per post (open in cascade, closed in llm_only) rather than this
    snapshot silently downgrading the mode. ``cooldown_seconds`` None means the server
    default."""

    channel_type: str
    candidates: tuple[AttentionCandidate, ...]
    channel_label: str = ""
    mode: str = "embedding"
    llm: LlmTriageConfig | None = None
    cooldown_seconds: int | None = None


def build_attention_context(session: Session, channel_id: str) -> AttentionContext | None:
    """Snapshot the channel's LobsterTalk-enabled agents for the pass, or None to skip.

    Every gate must be open: a public channel, approved by the org owner, in an org whose
    LobsterTalk config is enabled, with at least one agent member whose operator opted in.
    Cheapest checks first. In the LLM modes the key is decrypted here, while a session is
    held; an unusable config warns and leaves ``llm`` None."""
    channel = session.get(MmChannel, channel_id)
    # Public only: the LLM modes ship the transcript to an owner-controlled endpoint, and an
    # owner cannot read a private channel they are not in.
    if channel is None or channel.channel_type != "public":
        return None
    if not channel.lobstertalk_approved or not channel.org_id:
        return None
    config = TableRead.get_org_lobstertalk_config(session, channel.org_id)
    if config is None or not config["enabled"]:
        return None
    mode = config["mode"]
    llm: LlmTriageConfig | None = None
    if mode in _LLM_MODES:
        consequence = (
            "triage will fail open to the gate verdict" if mode == "cascade"
            else "llm_only will fail closed (no nudges)"
        )
        if not config["base_url"] or not config["model"]:
            logger.warning(
                "attention: org %s is in %s mode without an LLM base_url/model; %s",
                channel.org_id, mode, consequence,
            )
        else:
            token = config["api_key_encrypted"]
            api_key = decrypt_secret(token) if token else None
            if token and api_key is None:
                logger.warning(
                    "attention: org %s has an undecryptable LLM API key; %s",
                    channel.org_id, consequence,
                )
            else:
                llm = LlmTriageConfig(
                    base_url=config["base_url"], model=config["model"], api_key=api_key
                )
    candidates: list[AttentionCandidate] = []
    for member in TableRead.get_mm_channel_members(session, channel_id):
        agent_id = member["agent_id"]
        if not agent_id:
            continue
        row = session.get(Agent, agent_id)
        if row is None or not row.lobstertalk_enabled:
            continue
        profile = session.get(AgentProfile, agent_id) if mode in _LLM_MODES else None
        candidates.append(
            AttentionCandidate(
                agent_id=agent_id,
                snoozed=bool(row.snoozed),
                inter_agent_mode=bool(row.inter_agent_mode_enabled),
                description=profile.description if profile else None,
            )
        )
    if not candidates:
        return None
    return AttentionContext(
        channel_type=channel.channel_type,
        candidates=tuple(candidates),
        channel_label=channel.display_name or channel.name,
        mode=mode,
        llm=llm,
        cooldown_seconds=config.get("cooldown_seconds"),
    )


def _mentions(text: str, agent_id: str) -> bool:
    return re.search(rf"@{re.escape(agent_id)}\b", text, re.IGNORECASE) is not None


def _effective_cooldown(context: AttentionContext) -> int:
    return context.cooldown_seconds or cooldown_seconds()


def _cooldown_key(agent_id: str, channel_id: str) -> str:
    return f"lobstertalk:cd:{agent_id}:{channel_id}"


def _pending_key(agent_id: str, channel_id: str) -> str:
    return f"lobstertalk:pending:{agent_id}:{channel_id}"


async def _claim_cooldown(agent_id: str, channel_id: str, ttl_seconds: int) -> bool:
    """Atomically claim the per-(agent, channel) cooldown; False when already held."""
    try:
        client = await get_bus().redis_client()
        return bool(
            await client.set(_cooldown_key(agent_id, channel_id), "1", ex=ttl_seconds, nx=True)
        )
    except Exception as e:
        logger.warning("attention cooldown check failed (%s); skipping nudge", e)
        return False


async def _release_cooldown(agent_id: str, channel_id: str) -> None:
    """Refund a claimed cooldown after a nudge that did not land. Best-effort."""
    try:
        client = await get_bus().redis_client()
        await client.delete(_cooldown_key(agent_id, channel_id))
    except Exception as e:
        logger.warning("attention cooldown refund failed (%s); will expire on TTL", e)


def parse_cooldown_key(key: str) -> tuple[str, str] | None:
    """``(agent_id, channel_id)`` from a cooldown key, else None. Split from the right:
    channel ids are UUIDs and never contain ``:``."""
    prefix = "lobstertalk:cd:"
    if not key.startswith(prefix):
        return None
    agent_id, sep, channel_id = key[len(prefix):].rpartition(":")
    if not sep or not agent_id or not channel_id:
        return None
    return agent_id, channel_id


async def _remember_pending(
    agent_id: str, channel_id: str, post_id: object, cooldown_ttl: int
) -> None:
    """Mark ``post_id`` for a catch-up pass when the active cooldown expires; newest wins.

    The marker must outlive the cooldown key that wakes it, so its TTL builds on that key's
    actual remaining TTL (a lowered org cooldown leaves the live key longer than the new
    window), plus slack so an unserviced marker still dies quietly."""
    if not isinstance(post_id, int):
        return
    try:
        client = await get_bus().redis_client()
        remaining = await client.ttl(_cooldown_key(agent_id, channel_id))
        base = remaining if isinstance(remaining, int) and remaining > 0 else cooldown_ttl
        await client.set(
            _pending_key(agent_id, channel_id), str(post_id), ex=base + 2 * cooldown_ttl
        )
    except Exception as e:
        logger.warning("attention pending marker failed (%s); post %s won't be caught up", e, post_id)


def _load_catchup_context(
    engine: Engine, post_id: int, channel_id: str, agent_id: str
) -> tuple[dict, AttentionContext] | None:
    """The post and a context narrowed to the one agent whose cooldown expired, or None when
    the catch-up no longer applies. Other candidates already had their live pass."""
    from clawbits.datastructures.mm_models import MmPostResponse

    with Session(engine) as db:
        row = db.get(MmPost, post_id)
        if row is None or row.channel_id != channel_id:
            return None
        ctx = build_attention_context(db, channel_id)
        if ctx is None:
            return None
        mine = tuple(c for c in ctx.candidates if c.agent_id == agent_id)
        if not mine:
            return None
        post = TableRead.hydrate_mm_posts(db, [row])[0]
        return MmPostResponse(**post).model_dump(), replace(ctx, candidates=mine)


async def _catchup_pending(engine: Engine, agent_id: str, channel_id: str) -> None:
    """Replay the pass for the post the expired window left pending. GETDEL picks exactly
    one worker; ``catchup=True`` stops a lost claim race from re-marking the older post."""
    client = await get_bus().redis_client()
    raw = await client.getdel(_pending_key(agent_id, channel_id))
    if not raw:
        return
    try:
        post_id = int(raw)
    except (TypeError, ValueError):
        return
    loaded = await asyncio.to_thread(_load_catchup_context, engine, post_id, channel_id, agent_id)
    if loaded is None:
        return
    payload, ctx = loaded
    logger.info(
        "attention: catch-up pass for %s in %s (post=%s missed during cooldown)",
        agent_id, channel_id, post_id,
    )
    await consider_post(
        post=payload,
        channel_id=channel_id,
        context=ctx,
        author_agent_id=payload.get("agent_id"),
        engine=engine,
        catchup=True,
    )


async def attention_cooldown_catchup_watcher(engine: Engine) -> None:
    """Bridge cooldown-key expirations to deferred passes, once per worker. Exits quietly
    when keyspace notifications cannot be enabled."""
    bus = get_bus()
    if not await bus.enable_keyspace_notifications():
        logger.warning(
            "attention catch-up watcher: keyspace notifications unavailable; "
            "cooldown-skipped posts will not be replayed"
        )
        return
    logger.info("attention cooldown catch-up watcher: started")
    try:
        async for key in bus.subscribe_expirations():
            parsed = parse_cooldown_key(key)
            if parsed is None:
                continue
            try:
                await _catchup_pending(engine, *parsed)
            except Exception as e:
                logger.warning("attention catch-up failed for %s: %s", key, e)
    except asyncio.CancelledError:
        logger.info("attention cooldown catch-up watcher: stopped")
        raise


def _load_transcript(
    engine: Engine, channel_id: str, through_post_id: int | None = None
) -> list[dict] | None:
    """Recent transcript for the triage prompt, oldest-first, in its own session; None on
    any failure. ``through_post_id`` ends the window at the triggering post, so a burst of
    newer messages cannot push it out."""
    try:
        with Session(engine) as session:
            rows = TableRead.get_mm_posts_with_text_for_channel(
                session,
                channel_id,
                limit=TRANSCRIPT_POST_LIMIT,
                before_post_id=None if through_post_id is None else through_post_id + 1,
            )
            names = {
                human_id: TableRead.resolve_human_display(session, human_id)
                for human_id in {r.human_id for r in rows if r.human_id is not None}
            }
            return [
                {
                    "post_id": row.post_id,
                    "agent_id": row.agent_id,
                    "human_id": row.human_id,
                    "who": row.agent_id or names.get(row.human_id),
                    "message": row.message,
                    "created_at": row.created_at.isoformat() if row.created_at else None,
                }
                for row in reversed(rows)
            ]
    except Exception as e:
        logger.warning("attention: transcript load failed for %s: %s", channel_id, e)
        return None


async def consider_post(
    *,
    post: dict,
    channel_id: str,
    context: AttentionContext,
    author_agent_id: str | None,
    engine: Engine | None = None,
    catchup: bool = False,
) -> None:
    """Evaluate one new post and nudge the agents that should look at it.

    ``author_agent_id`` is None for a human post. The gate runs once, except in ``llm_only``
    and ``all`` modes, which treat every post as escalated. Each candidate then passes the
    native-handling gates and the cooldown and, in the LLM modes, one triage call. Cascade
    fails open to the gate verdict; llm_only has none beneath it and fails closed."""
    text = (post.get("message") or "").strip()
    if not text:
        return
    llm_only = context.mode == "llm_only"
    if llm_only or context.mode == "all":
        verdict = Verdict(escalate=True, route=None, score=None)
    else:
        verdict = await asyncio.to_thread(evaluate_text, text)
        if verdict is None:
            return
    if not verdict.escalate:
        logger.info(
            "attention: no escalation in %s (route=%s score=%.2f)",
            channel_id, verdict.route or "none", verdict.score or 0.0,
        )
        return

    confirm = llm_only or context.mode == "cascade"
    if confirm and (context.llm is None or engine is None):
        reason = (
            "the LLM config is missing/unusable" if context.llm is None
            else "no engine was passed"
        )
        if llm_only:
            logger.warning(
                "attention: llm_only mode in %s but %s; failing closed (no nudges)",
                channel_id, reason,
            )
            return
        logger.warning(
            "attention: cascade mode in %s but %s; failing open to the gate verdict",
            channel_id, reason,
        )
        confirm = False
    transcript: list[dict] | None = None
    transcript_failed = False
    trigger_post_id = post.get("post_id")
    cooldown = _effective_cooldown(context)

    for c in context.candidates:
        if (
            c.agent_id == author_agent_id
            or (author_agent_id is not None and not c.inter_agent_mode)
            or c.snoozed
            or _mentions(text, c.agent_id)
        ):
            continue
        if not await _claim_cooldown(c.agent_id, channel_id, cooldown):
            if not catchup:
                await _remember_pending(c.agent_id, channel_id, trigger_post_id, cooldown)
            logger.info(
                "attention: cooldown active for %s in %s; skipping nudge%s",
                c.agent_id, channel_id,
                "" if catchup else " (will catch up when the cooldown expires)",
            )
            continue
        # Triage runs after the claim, so a "no" keeps the cooldown: one paid call per window.
        paid_triage = False
        if confirm:
            if transcript is None and not transcript_failed:
                transcript = await asyncio.to_thread(
                    _load_transcript, engine, channel_id, trigger_post_id
                )
                if transcript is None:
                    transcript_failed = True
                    if llm_only:
                        logger.warning(
                            "attention: no transcript for %s; failing closed (no nudges)",
                            channel_id,
                        )
                        await _release_cooldown(c.agent_id, channel_id)
                        return
                    logger.warning(
                        "attention: no transcript for %s; failing open to the gate verdict",
                        channel_id,
                    )
            if transcript is not None:
                decision = await triage_decide(
                    config=context.llm,
                    agent_id=c.agent_id,
                    description=c.description,
                    channel_id=channel_id,
                    channel_label=context.channel_label,
                    posts=transcript,
                    focus_post_id=(
                        trigger_post_id
                        if any(p.get("post_id") == trigger_post_id for p in transcript)
                        else None
                    ),
                )
                paid_triage = True
                if decision is None:
                    if llm_only:
                        logger.warning(
                            "attention: triage unavailable in %s; failing closed "
                            "for the remaining candidates on this post",
                            channel_id,
                        )
                        return
                    confirm = False
                    logger.warning(
                        "attention: triage unavailable in %s; skipping the confirm "
                        "stage for the remaining candidates on this post",
                        channel_id,
                    )
                elif not decision.needs_input:
                    logger.info(
                        "attention: triage declined nudge for %s in %s: %s",
                        c.agent_id, channel_id, decision.reason or "(no reason)",
                    )
                    continue
        if await _deliver(c.agent_id, channel_id, post, verdict):
            continue
        if paid_triage:
            # A refund would let every post re-pay triage while the agent stays offline.
            logger.info(
                "attention: nudge for %s didn't land; keeping the cooldown "
                "because triage was already paid for",
                c.agent_id,
            )
            continue
        await _release_cooldown(c.agent_id, channel_id)


async def _deliver(agent_id: str, channel_id: str, post: dict, verdict: Verdict) -> bool:
    """Publish a "consider this post" nudge on the agent's control topic, and log it either
    way. True when at least one live agent socket received it."""
    logger.info(
        "attention: NUDGE agent=%s channel=%s post=%s (route=%s score=%.2f): %r",
        agent_id, channel_id, post.get("post_id"),
        verdict.route or "none", verdict.score or 0.0, (post.get("message") or "")[:120],
    )
    try:
        receivers = await publish_attention_nudge(get_bus(), agent_id, channel_id, post)
    except Exception as e:
        logger.warning("attention: nudge publish failed for %s: %s", agent_id, e)
        return False
    if not receivers:
        logger.info(
            "attention: nudge for %s had no live subscriber; refunding cooldown",
            agent_id,
        )
        return False
    return True
