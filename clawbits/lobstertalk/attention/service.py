"""Post-creation attention pass: gather eligible agents, run the gate once,
then per-agent apply the native-handling gates and a Redis cooldown before
(v1) logging the nudge.

Called fire-and-forget from the post-create path. All DB work happens up front
in :func:`build_attention_context` (in the request's session); the async pass
itself touches the gate (CPU, via a thread) and Redis — plus, in cascade mode,
a short-lived session of its own (opened in a thread against the engine the
call site passes) to pull the channel transcript for the LLM confirm stage —
so it can outlive the request without holding the request's session.
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass

from sqlalchemy import Engine
from sqlmodel import Session

from clawbits.db.models import Agent, AgentProfile, MmChannel
from clawbits.db.table_read import TableRead
from clawbits.lobstertalk.attention.crypto import decrypt_secret
from clawbits.lobstertalk.attention.gate import cooldown_seconds, evaluate_text
from clawbits.lobstertalk.attention.triage import (
    TRANSCRIPT_POST_LIMIT,
    LlmTriageConfig,
    triage_decide,
)
from clawbits.realtime import get_bus, publish_attention_nudge

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AttentionCandidate:
    agent_id: str
    snoozed: bool
    inter_agent_mode: bool
    # AgentProfile.description, fed to the triage prompt as the agent's
    # identity. Only fetched in cascade mode; None keeps the embedding
    # path's cost unchanged.
    description: str | None = None


@dataclass(frozen=True)
class AttentionContext:
    channel_type: str
    candidates: tuple[AttentionCandidate, ...]
    # Cascade-mode extras, all defaulted so embedding-mode constructors (and
    # pre-cascade tests) stay valid. ``llm`` is None in embedding mode — and
    # in cascade mode when the org's LLM config is unusable (missing
    # base_url/model, undecryptable key); consider_post then fails open per
    # post instead of this snapshot silently downgrading the mode.
    channel_label: str = ""
    mode: str = "embedding"
    llm: LlmTriageConfig | None = None


def build_attention_context(session: Session, channel_id: str) -> AttentionContext | None:
    """Snapshot the channel's LobsterTalk-enabled agent members for the pass.

    Returns None (skip) when the channel is a DM, its org hasn't armed the
    attention gate, or it has no agent member with LobsterTalk enabled — cheap
    early-outs that avoid scheduling a pass with nothing to do. The org's
    LobsterTalk config (one PK get, carrying the enabled flag plus the
    mode/LLM settings) is the product switch (owner-toggled; it replaced the
    old ``CLAWBITS_ATTENTION_ENABLED`` env flag); the per-agent
    ``lobstertalk_enabled`` flag is the operator's opt-in, so both must be on for an
    agent to be nudged. This is the sole product gate — call sites no longer guard
    it with an env check — so the org lookup is ordered first to keep
    the cost near-zero for channels whose org hasn't opted in.

    In cascade mode the LLM config is resolved (key decrypted) here, while we
    hold a session; an unusable config warns and leaves ``llm=None`` rather
    than downgrading the mode, so consider_post fails open per post and the
    misconfig stays visible next to every nudge it affected.
    """
    channel = session.get(MmChannel, channel_id)
    if channel is None or channel.channel_type == "direct":
        return None
    # Org opt-in gate: cheap PK lookup, bail before the member enumeration.
    # org_id is nullable (legacy/org-less channels) — treat missing as disabled.
    if not channel.org_id:
        return None
    config = TableRead.get_org_lobstertalk_config(session, channel.org_id)
    if config is None or not config["enabled"]:
        return None
    mode = config["mode"]
    llm: LlmTriageConfig | None = None
    if mode == "cascade":
        if not config["base_url"] or not config["model"]:
            logger.warning(
                "attention: org %s is in cascade mode without an LLM base_url/model; "
                "triage will fail open to the gate verdict",
                channel.org_id,
            )
        else:
            token = config["api_key_encrypted"]
            api_key = decrypt_secret(token) if token else None
            if token and api_key is None:
                # decrypt_secret already warned about the token itself; add the
                # org so the operator knows whose key to re-enter. A stored-but-
                # unusable key means the endpoint likely requires auth, so don't
                # call it key-less — leave llm unset (fail open) instead.
                logger.warning(
                    "attention: org %s has an undecryptable LLM API key; "
                    "triage will fail open to the gate verdict",
                    channel.org_id,
                )
            else:
                llm = LlmTriageConfig(
                    base_url=config["base_url"], model=config["model"], api_key=api_key
                )
    candidates: list[AttentionCandidate] = []
    for member in TableRead.get_mm_channel_members(session, channel_id):
        agent_id = member.get("agent_id")
        if not agent_id:
            continue
        row = session.get(Agent, agent_id)
        # Skip agents whose operator hasn't opted in — the UI toggle
        # (lobstertalk_enabled) is what makes this gate act on the agent.
        if row is None or not row.lobstertalk_enabled:
            continue
        # The profile description personalises the triage prompt; skip the
        # extra PK get entirely in embedding mode (no LLM to feed it to).
        description = None
        if mode == "cascade":
            profile = session.get(AgentProfile, agent_id)
            description = profile.description if profile else None
        candidates.append(
            AttentionCandidate(
                agent_id=agent_id,
                snoozed=bool(row.snoozed),
                inter_agent_mode=bool(row.inter_agent_mode_enabled),
                description=description,
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
    )


def _mentions(text: str, agent_id: str) -> bool:
    return re.search(rf"@{re.escape(agent_id)}\b", text, re.IGNORECASE) is not None


def _cooldown_key(agent_id: str, channel_id: str) -> str:
    return f"lobstertalk:cd:{agent_id}:{channel_id}"


async def _claim_cooldown(agent_id: str, channel_id: str) -> bool:
    """Atomically check+set the per-(agent, channel) cooldown. Returns True when
    we claimed it (proceed to nudge), False when it was already held (skip)."""
    try:
        client = await get_bus().redis_client()
        claimed = await client.set(
            _cooldown_key(agent_id, channel_id), "1", ex=cooldown_seconds(), nx=True
        )
        return bool(claimed)
    except Exception as e:  # Redis hiccup: don't silently nudge in a loop
        logger.warning("attention cooldown check failed (%s); skipping nudge", e)
        return False


async def _release_cooldown(agent_id: str, channel_id: str) -> None:
    """Refund a claimed cooldown after a nudge that didn't land (publish failed
    or no live agent socket), so the next qualifying post can nudge as soon as
    the agent is back instead of waiting out the full window. Best-effort: if
    the DEL fails the cooldown just expires on its own."""
    try:
        client = await get_bus().redis_client()
        await client.delete(_cooldown_key(agent_id, channel_id))
    except Exception as e:
        logger.warning("attention cooldown refund failed (%s); will expire on TTL", e)


def _load_transcript(
    engine: Engine, channel_id: str, through_post_id: int | None = None
) -> list[dict] | None:
    """Recent channel transcript for the triage prompt, oldest-first.

    Runs in a thread (sync DB work) with its own short-lived session — the
    pass has outlived the request's session by the time cascade needs this.
    Rows are mapped to the dict shape :func:`triage.format_transcript`
    expects; ``who`` is the agent_id or the human's display name (the same
    display_name → email fallback the rest of the app uses). None on any
    failure — the caller treats it as "fail open to the gate verdict".

    ``through_post_id`` ends the window at the post that tripped the gate.
    Without it a burst of new messages between the commit and this (async)
    read could push the triggering post out of the window entirely, and the
    model would then judge a conversation the gate never looked at."""
    try:
        with Session(engine) as session:
            rows = TableRead.get_mm_posts_with_text_for_channel(
                session,
                channel_id,
                limit=TRANSCRIPT_POST_LIMIT,
                # The reader's cursor is exclusive and post_id is an integer
                # PK, so +1 means "this post and everything before it".
                before_post_id=None if through_post_id is None else through_post_id + 1,
            )
            # Memoise per-human name lookups — a 20-post window in a lively
            # channel repeats authors far more than it introduces them.
            names: dict[int, str | None] = {}
            posts: list[dict] = []
            for row in reversed(rows):  # newest-first query → oldest-first prompt
                if row.human_id is not None and row.human_id not in names:
                    names[row.human_id] = TableRead.resolve_human_display(
                        session, row.human_id
                    )
                posts.append(
                    {
                        "post_id": row.post_id,
                        "agent_id": row.agent_id,
                        "human_id": row.human_id,
                        "who": row.agent_id or names.get(row.human_id),
                        "message": row.message,
                        "created_at": row.created_at.isoformat() if row.created_at else None,
                    }
                )
            return posts
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
) -> None:
    """Evaluate one new post and nudge the agents that should look at it.

    ``author_agent_id`` is the posting agent, or None for a human post. The gate
    runs once (the attention route is agent-agnostic in v1); the per-agent loop
    applies the cheap native-handling gates + cooldown, then — in cascade mode —
    one LLM triage call per surviving candidate. ``engine`` is only used for the
    cascade transcript fetch; call sites always pass it, but it defaults to None
    so embedding-mode callers and tests need not care.
    """
    text = (post.get("message") or "").strip()
    if not text:
        return
    verdict = await asyncio.to_thread(evaluate_text, text)
    if verdict is None:  # gate unavailable
        return
    if not verdict.escalate:
        # INFO on purpose: this line is the tuning telemetry the README points
        # at — at DEBUG you can't tell "gate never fires" from "scores land
        # below threshold / route to the decoy". One line per gated post, and
        # the gate only runs for posts in LobsterTalk-enabled channels, so the
        # volume stays proportional to opted-in traffic.
        logger.info(
            "attention: no escalation in %s (route=%s score=%.2f)",
            channel_id, verdict.route or "none", verdict.score or 0.0,
        )
        return

    # Cascade confirm-stage state, shared across the candidate loop. The
    # preconditions warn once per escalated post (not per candidate), and the
    # transcript — including a failed fetch — is cached so the DB is hit at
    # most once per post no matter how many candidates survive the gates.
    cascade = context.mode == "cascade"
    if cascade and (context.llm is None or engine is None):
        logger.warning(
            "attention: cascade mode in %s but %s; failing open to the gate verdict",
            channel_id,
            "the LLM config is missing/unusable" if context.llm is None
            else "no engine was passed",
        )
        cascade = False
    transcript: list[dict] | None = None
    transcript_failed = False
    trigger_post_id = post.get("post_id")

    for c in context.candidates:
        if c.agent_id == author_agent_id:
            continue  # own post
        if author_agent_id is not None and not c.inter_agent_mode:
            continue  # agent-authored, and this agent doesn't do inter-agent
        if c.snoozed:
            continue
        if _mentions(text, c.agent_id):
            continue  # native @mention handling already covers it
        if not await _claim_cooldown(c.agent_id, channel_id):
            # INFO like the other verdict lines: a cooldown skip is otherwise
            # indistinguishable from "gate didn't fire" when testing/tuning.
            logger.info(
                "attention: cooldown active for %s in %s; skipping nudge",
                c.agent_id, channel_id,
            )
            continue
        # LLM confirm stage, deliberately *after* the cooldown claim: a triage
        # "no" (below) keeps the cooldown consumed, bounding LLM spend to one
        # call per (agent, channel) window — the sidecar's watermark semantics.
        paid_triage = False
        if cascade:
            if transcript is None and not transcript_failed:
                transcript = await asyncio.to_thread(
                    _load_transcript, engine, channel_id, trigger_post_id
                )
                if transcript is None:  # _load_transcript logged the cause
                    transcript_failed = True
                    logger.warning(
                        "attention: no transcript for %s; failing open to the gate verdict",
                        channel_id,
                    )
            if transcript is not None:
                # Only claim a focus post the transcript actually contains —
                # the reader orders by created_at while the cursor is on
                # post_id, so the anchor can in principle fall outside the
                # window. Promising a marker that isn't there would leave the
                # model hunting for a line that was never rendered.
                focus_id = trigger_post_id if any(
                    p.get("post_id") == trigger_post_id for p in transcript
                ) else None
                decision = await triage_decide(
                    config=context.llm,
                    agent_id=c.agent_id,
                    description=c.description,
                    channel_id=channel_id,
                    channel_label=context.channel_label,
                    posts=transcript,
                    focus_post_id=focus_id,
                )
                paid_triage = True
                # None = "could not decide" (triage already warned) → fall
                # through to the gate verdict and deliver anyway (fail open).
                # Stop asking for the rest of this post, too: candidates are
                # handled in sequence, so an endpoint that's down would cost
                # another full timeout each, delaying every remaining
                # fail-open nudge. A model that answered unparseably will
                # answer the next identical request the same way, so there's
                # nothing to gain by re-asking either.
                if decision is None:
                    cascade = False
                    logger.warning(
                        "attention: triage unavailable in %s; skipping the confirm "
                        "stage for the remaining candidates on this post",
                        channel_id,
                    )
                elif not decision.needs_input:
                    # INFO like the other verdict lines — this is the cascade's
                    # tuning telemetry, one line per suppressed nudge.
                    logger.info(
                        "attention: triage declined nudge for %s in %s: %s",
                        c.agent_id, channel_id, decision.reason or "(no reason)",
                    )
                    continue
        if not await _deliver(c.agent_id, channel_id, post, verdict):
            if paid_triage:
                # Normally we refund here (below), but we've already paid for
                # a triage call on this post. Refunding would let the next
                # qualifying post pay again, and again, for as long as the
                # agent stays offline — exactly the unbounded spend the
                # cooldown exists to prevent. Holding it costs the agent one
                # cooldown window (30s in the shipped envs) of re-entry delay.
                logger.info(
                    "attention: nudge for %s didn't land; keeping the cooldown "
                    "because triage was already paid for",
                    c.agent_id,
                )
                continue
            # Nudge didn't land (publish failed / agent socket down) — refund
            # so the agent isn't locked out of the next qualifying post for
            # the full cooldown over a nudge it never saw. Nudges are
            # time-sensitive, so we deliberately don't queue or replay them.
            await _release_cooldown(c.agent_id, channel_id)


async def _deliver(agent_id: str, channel_id: str, post: dict, verdict) -> bool:
    """Publish a targeted "consider this post" nudge on the agent's control
    topic, which the plugin turns into an agent turn (framed reply-only-if-
    useful). Also logs, so the decision stays visible even when no agent is
    connected or realtime is down.

    Returns True when at least one live subscriber (the agent's WS control
    pump on some worker) received the event; False on a failed publish or
    zero receivers, so the caller can refund the cooldown."""
    preview = (post.get("message") or "")[:120]
    logger.info(
        "attention: NUDGE agent=%s channel=%s post=%s (route=%s score=%.2f): %r",
        agent_id, channel_id, post.get("post_id"),
        verdict.route or "none", verdict.score or 0.0, preview,
    )
    try:
        receivers = await publish_attention_nudge(get_bus(), agent_id, channel_id, post)
    except Exception as e:  # realtime hiccup: the log line above still records it
        logger.warning("attention: nudge publish failed for %s: %s", agent_id, e)
        return False
    if not receivers:  # None (publish failed) or 0 (no live agent socket)
        logger.info(
            "attention: nudge for %s had no live subscriber; refunding cooldown",
            agent_id,
        )
        return False
    return True
