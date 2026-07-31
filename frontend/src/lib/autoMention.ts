// Decides whether the composer should pre-fill an @mention for an agent
// based on the recent conversational turn.
//
// Lives outside the component so it can be unit-tested without React.
//
// Triggers (highest priority first):
//   1. Replying to an agent post — explicit user intent.
//   2. Agent's most recent published post addressed the current user
//      (reply to my post OR @-mentioned me) within the time window.
//   3. My most recent published post addressed an agent within the
//      window — I'm following up before they've replied.
//
// Stickiness: when the newest live post is an agent's that does NOT
// address me, we walk back to the most recent in-window post that
// would have fired Trigger 2 or 3 and keep the chip latched onto it.
// This makes the auto-mention survive an agent's continuation or
// "no @mention" reply, which would otherwise wipe the user's still-
// active intent. Stickiness only kicks in for agent posts; the user's
// own non-addressing post and other humans' posts still clear the chip.
//
// Suppressed in direct channels (server-side auto-reply already covers
// those) and in any channel without an agent member.

import type { MmChannelMember, MmChannelPost } from "@/lib/api";

// The server returns SQLite naive UTC timestamps like "2026-05-14 12:00:02"
// (no `Z`, no offset). ``Date.parse`` interprets that shape as **local
// time**, so a post that's seconds old reads as hours old in any
// non-UTC browser. Treat the bare DATETIME shape as UTC explicitly;
// fall through for ISO strings.
const NAIVE_SQLITE_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/u;

function parsePostTimestamp(raw: string | null | undefined): number {
  if (!raw) return NaN;
  if (NAIVE_SQLITE_DATETIME_RE.test(raw)) {
    return Date.parse(raw.replace(" ", "T") + "Z");
  }
  return Date.parse(raw);
}

export type AutoMentionReason = "reply" | "agent-to-me" | "me-to-agent";

export interface PendingAutoMention {
  agentId: string;
  handle: string;
  displayName: string;
  /** Identity of the triggering event. Dismissal is keyed by this so a
   *  newer trigger (different post id) re-shows the chip naturally. */
  triggerKey: string;
  reason: AutoMentionReason;
}

export interface ComputePendingAutoMentionInput {
  currentUserId: number | null | undefined;
  isDirectChannel: boolean;
  members: MmChannelMember[];
  /** Posts as returned by the API — newest first. */
  posts: MmChannelPost[];
  replyingTo: MmChannelPost | null;
  handleFor: (member: MmChannelMember) => string;
  labelFor: (member: MmChannelMember) => string;
  /** Tokens that match the current user in inbound `@mention` regex
   *  (lowercased, whitespace stripped). */
  myMentionTokens: ReadonlySet<string>;
  /** Wall-clock instant; injectable so tests don't flake. */
  nowMs: number;
  windowMs: number;
  /** When the viewer joined this channel (component mount / channel
   *  switch). Posts created at or before this instant are treated as
   *  "history I'm catching up on" — they don't fire time-based triggers
   *  (only the explicit Reply trigger bypasses this floor). Pass 0 to
   *  disable the check (used by older tests).*/
  channelEnteredAtMs: number;
}

export function computePendingAutoMention(
  input: ComputePendingAutoMentionInput,
): PendingAutoMention | null {
  const {
    currentUserId, isDirectChannel, members, posts, replyingTo,
    handleFor, labelFor, myMentionTokens, nowMs, windowMs,
    channelEnteredAtMs,
  } = input;

  if (currentUserId == null) return null;
  if (isDirectChannel) return null;
  // Only consider agents the viewer may tag — contact is closed by default, so
  // auto-mentioning an agent the user can't tag would just bounce off the API.
  // ``can_tag == null`` (not computed) is treated as allowed for back-compat.
  const agentMembers = members.filter(
    (m): m is MmChannelMember & { agent_id: string } =>
      m.agent_id != null && m.can_tag !== false,
  );
  if (agentMembers.length === 0) return null;

  // (1) Explicit reply to an agent post — always wins.
  if (replyingTo?.agent_id) {
    const agent = agentMembers.find((m) => m.agent_id === replyingTo.agent_id);
    if (agent) {
      return {
        agentId: agent.agent_id,
        handle: handleFor(agent),
        displayName: labelFor(agent),
        triggerKey: `reply:${String(replyingTo.post_id)}`,
        reason: "reply",
      };
    }
  }

  // A post is "live" in my feed if it's published OR it's my own draft/
  // rejected post. Drafts from other authors are visibility-restricted
  // server-side, so they shouldn't influence the chip; my own drafts
  // matter because the approval-gated `@agent` case ships posts as
  // drafts and trigger 3 needs to fire on them.
  const isLive = (p: MmChannelPost): boolean =>
    p.status === "published" || p.human_id === currentUserId;

  // Active-turn window: post must be young enough AND have arrived
  // after I entered the channel (pre-existing history is "catching up",
  // not an active turn).
  const isInWindow = (p: MmChannelPost): boolean => {
    const ms = parsePostTimestamp(p.created_at);
    if (!Number.isFinite(ms)) return false;
    if (nowMs - ms > windowMs) return false;
    if (channelEnteredAtMs > 0 && ms < channelEnteredAtMs) return false;
    return true;
  };

  // Trigger 2 evaluated against a single post. Returns null if the post
  // isn't from a known agent or doesn't address me.
  const tryAgentToMe = (p: MmChannelPost): PendingAutoMention | null => {
    if (!p.agent_id) return null;
    const agent = agentMembers.find((m) => m.agent_id === p.agent_id);
    if (!agent) return null;
    const parentIsMine =
      p.parent_post_id != null &&
      posts.some(
        (q) => q.post_id === p.parent_post_id && q.human_id === currentUserId,
      );
    const msg = (p.message ?? "").toLowerCase();
    const mentionsMe =
      myMentionTokens.size > 0 &&
      [...myMentionTokens].some((t) => msg.includes(`@${t}`));
    if (!parentIsMine && !mentionsMe) return null;
    return {
      agentId: agent.agent_id,
      handle: handleFor(agent),
      displayName: labelFor(agent),
      triggerKey: `a2m:${String(p.post_id)}`,
      reason: "agent-to-me",
    };
  };

  // Trigger 3 evaluated against a single post. Returns null if the post
  // isn't mine or doesn't @-mention a known agent.
  const tryMeToAgent = (p: MmChannelPost): PendingAutoMention | null => {
    if (p.human_id !== currentUserId) return null;
    const msg = (p.message ?? "").toLowerCase();
    let matched: typeof agentMembers[number] | null = null;
    for (const a of agentMembers) {
      if (msg.includes(`@${a.agent_id.toLowerCase()}`)) matched = a;
    }
    if (!matched) return null;
    return {
      agentId: matched.agent_id,
      handle: handleFor(matched),
      displayName: labelFor(matched),
      triggerKey: `m2a:${String(p.post_id)}`,
      reason: "me-to-agent",
    };
  };

  const newest = posts.find(isLive);
  if (!newest) return null;
  if (!isInWindow(newest)) return null;

  // (2) Agent's last post — either addressed to me, or fall back to the
  // prior turn so the chip stays latched through continuation replies.
  if (newest.agent_id) {
    const direct = tryAgentToMe(newest);
    if (direct) return direct;
    // Fallback: agent posted but didn't address me. Walk back to the
    // most recent in-window post that DOES qualify (either an earlier
    // a2m or a still-fresh m2a). Preserves the original triggerKey so
    // dismissal and window-expiry continue to work without extra state.
    for (const p of posts) {
      if (p === newest) continue;
      if (!isLive(p)) continue;
      if (!isInWindow(p)) continue;
      const hit = tryAgentToMe(p) ?? tryMeToAgent(p);
      if (hit) return hit;
    }
    return null;
  }

  // (3) My last post addressed an agent. No fallback here: if my newest
  // post doesn't @-mention an agent, that's a deliberate signal I've
  // moved on from the prior turn, so the chip should clear.
  return tryMeToAgent(newest);
}
