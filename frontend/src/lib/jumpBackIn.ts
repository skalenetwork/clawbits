/**
 * "Jump back in" ranking for the home launchpad. Blends habit (frecency) with
 * where things are happening (recency) using rank-normalised, scale-free
 * signals, then boosts the conversations that actually want the user's
 * attention right now: an unsent draft (you were mid-reply) or unread that came
 * *in* to you (someone — often an agent — replied). Muted chats are heavily
 * demoted rather than excluded, so a muted firehose never crowds out a real
 * reply but still surfaces when it's all you have.
 *
 * This replaces the old `frecencyScore * 1e13 + activityTime` formula, whose
 * giant multiplier existed only to paper over the two signals living on wildly
 * different scales (frecency ~0..thousands vs activity in epoch ms) — it made
 * recency a hair-thin tiebreaker and ignored unread/drafts entirely.
 *
 * Pure and deterministic: callers pass `now` (no Date.now() here) so the home
 * page's memo stays stable across re-renders. See AgentHomePage.tsx and
 * docs/protocol/SEARCH_SPEC.md (Tier 1, frecency).
 */
import type {MmChannel} from "./api";
import {activityTime} from "./chatFilters";
import {frecencyKey, frecencyScore, type FrecencyStore} from "./frecency";

/** Why a conversation surfaced — drives the per-card hint (and which preview
 *  line to show: draft text vs the last message). */
export type JumpReason = "draft" | "agent-reply" | "unread" | "recent";

export interface JumpItem {
  channel: MmChannel;
  reason: JumpReason;
  /** Trimmed, single-line draft text when `reason === "draft"`; else null. */
  draftText: string | null;
}

export interface RankJumpBackInInput {
  channels: MmChannel[];
  frecency: FrecencyStore;
  /** channel_id → unsent draft (the live map from useMessageDrafts). */
  drafts: ReadonlyMap<string, {text: string}>;
  /** Epoch-ms snapshot; passed in so this stays pure. */
  now: number;
  /** Signed-in human id — used to tell incoming replies from your own posts. */
  currentUserId: number | null | undefined;
  /** Max items to return (default 4 — one launchpad row). */
  limit?: number;
}

// Habit vs recency weights for the base score. Both signals are rank-normalised
// to 0..1, so these are directly comparable. Habit still leads (matching the
// old frecency-first ordering), but recency now genuinely contributes.
const W_FRECENCY = 0.45;
const W_RECENCY = 0.25;
// Attention boosts, added on top of the 0..0.70 base.
const B_DRAFT = 0.6; // you were mid-reply — the strongest "resume" signal
const B_INCOMING_UNREAD = 0.35; // it's your turn (someone replied)
const B_AGENT = 0.15; // …and the replier was an agent (core to this product)
const B_DM = 0.1; // …in a direct message (higher-signal than a busy channel)
// Muted chats keep a sliver of their score so they appear only as a last
// resort, never as a prompt to re-engage.
const MUTE_FACTOR = 0.2;

/**
 * Rank-normalise values to 0..1 (highest → 1). Robust to the wildly different
 * scales of frecency and last-activity and to outliers, which a min-max would
 * let dominate. Each value scores `1 - (#strictly-greater)/(n-1)`, so equal
 * values share a rank — crucially, when a signal is flat (e.g. nobody has any
 * frecency yet) every channel gets 1 and the term cancels out of the ordering
 * instead of fabricating a gradient from input order. n is small (the channel
 * list), so the O(n²) pass is negligible and runs once per memo.
 */
function rankNorm(values: number[]): number[] {
  const n = values.length;
  if (n <= 1) return values.map(() => 1);
  return values.map((v) => {
    const greater = values.reduce((acc, other) => (other > v ? acc + 1 : acc), 0);
    return 1 - greater / (n - 1);
  });
}

export function rankJumpBackIn(input: RankJumpBackInInput): JumpItem[] {
  const {channels, frecency, drafts, now, currentUserId, limit = 4} = input;
  if (channels.length === 0) return [];

  const frecNorm = rankNorm(
    channels.map((c) =>
      frecencyScore(frecencyKey("channel", c.channel_id), frecency, now),
    ),
  );
  const recNorm = rankNorm(channels.map((c) => activityTime(c)));

  const scored = channels.map((c, i) => {
    const draftText = drafts.get(c.channel_id)?.text.trim() ?? "";
    const hasDraft = draftText.length > 0;
    const unread = c.unread_count ?? 0;
    const muted = Boolean(c.muted);
    const lastWasMine =
      currentUserId != null && c.last_message_author_human_id === currentUserId;
    const lastWasAgent = c.last_message_author_agent_id != null;
    const isDm = c.channel_type === "direct";
    // Unread that came *in* to you (not your own trailing message). Muted chats
    // forgo the boost — being muted is an explicit "don't nudge me".
    const incomingUnread = unread > 0 && !lastWasMine && !muted;

    let score = W_FRECENCY * (frecNorm[i] ?? 0) + W_RECENCY * (recNorm[i] ?? 0);
    if (hasDraft) score += B_DRAFT;
    if (incomingUnread) {
      score += B_INCOMING_UNREAD;
      if (lastWasAgent) score += B_AGENT;
      if (isDm) score += B_DM;
    }
    if (muted) score *= MUTE_FACTOR;

    const reason: JumpReason = hasDraft
      ? "draft"
      : incomingUnread && lastWasAgent
        ? "agent-reply"
        : incomingUnread
          ? "unread"
          : "recent";

    return {
      channel: c,
      reason,
      draftText: hasDraft ? draftText.replace(/\s+/g, " ") : null,
      score,
      activity: activityTime(c),
    };
  });

  return scored
    .sort((a, b) => b.score - a.score || b.activity - a.activity)
    .slice(0, limit)
    .map(({channel, reason, draftText}) => ({channel, reason, draftText}));
}
