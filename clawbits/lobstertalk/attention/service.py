"""Post-creation attention pass: gather eligible agents, run the gate once,
then per-agent apply the native-handling gates and a Redis cooldown before
(v1) logging the nudge.

Called fire-and-forget from the post-create path. All DB work happens up front
in :func:`build_attention_context` (in the request's session); the async pass
itself only touches the gate (CPU, via a thread) and Redis, so it can outlive
the request without holding a session.
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass

from sqlmodel import Session

from clawbits.db.models import Agent, MmChannel
from clawbits.db.table_read import TableRead
from clawbits.lobstertalk.attention.gate import cooldown_seconds, evaluate_text
from clawbits.realtime import get_bus, publish_attention_nudge

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AttentionCandidate:
    agent_id: str
    snoozed: bool
    inter_agent_mode: bool


@dataclass(frozen=True)
class AttentionContext:
    channel_type: str
    candidates: tuple[AttentionCandidate, ...]


def build_attention_context(session: Session, channel_id: str) -> AttentionContext | None:
    """Snapshot the channel's LobsterTalk-enabled agent members for the pass.

    Returns None (skip) when the channel is a DM, its org hasn't armed the
    attention gate, or it has no agent member with LobsterTalk enabled — cheap
    early-outs that avoid scheduling a pass with nothing to do. The org-level
    ``Organization.attention_enabled`` flag is the product switch (owner-toggled;
    it replaced the old ``CLAWBITS_ATTENTION_ENABLED`` env flag); the per-agent
    ``lobstertalk_enabled`` flag is the operator's opt-in, so both must be on for an
    agent to be nudged. This is the sole product gate — call sites no longer guard
    it with an env check — so the org lookup is ordered first (one PK get) to keep
    the cost near-zero for channels whose org hasn't opted in.
    """
    channel = session.get(MmChannel, channel_id)
    if channel is None or channel.channel_type == "direct":
        return None
    # Org opt-in gate: cheap PK lookup, bail before the member enumeration.
    # org_id is nullable (legacy/org-less channels) — treat missing as disabled.
    if not channel.org_id or not TableRead.get_org_attention_enabled(session, channel.org_id):
        return None
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
        candidates.append(
            AttentionCandidate(
                agent_id=agent_id,
                snoozed=bool(row.snoozed),
                inter_agent_mode=bool(row.inter_agent_mode_enabled),
            )
        )
    if not candidates:
        return None
    return AttentionContext(channel_type=channel.channel_type, candidates=tuple(candidates))


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


async def consider_post(
    *,
    post: dict,
    channel_id: str,
    context: AttentionContext,
    author_agent_id: str | None,
) -> None:
    """Evaluate one new post and nudge the agents that should look at it.

    ``author_agent_id`` is the posting agent, or None for a human post. The gate
    runs once (the attention route is agent-agnostic in v1); the per-agent loop
    only applies the cheap native-handling gates + cooldown.
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
        if not await _deliver(c.agent_id, channel_id, post, verdict):
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
