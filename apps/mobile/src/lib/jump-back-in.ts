import { type MmChannel } from '@/lib/api';

const LIMIT = 4;

/** Rank the channel list into the top conversations to resume, mirroring
 *  the web home's "Jump back in" intent. The web ranker also folds in
 *  frecency and per-channel drafts (both browser-local) — neither exists on
 *  mobile yet, so this is a faithful, degraded version built only from
 *  fields present on ``MmChannel``: recency as the base signal, with
 *  attention boosts for incoming unread, agent replies, DMs, and pins.
 *  Muted channels are demoted (not excluded). */
export function rankJumpBackIn(
  channels: MmChannel[],
  selfHumanId: number | null,
): MmChannel[] {
  if (channels.length === 0) return [];

  const times = channels.map(activityTime);
  const recencyNorm = rankNorm(times);

  const scored = channels.map((channel, i) => {
    // Recency is the only base signal available on mobile.
    let score = 0.7 * recencyNorm[i]!;

    const unread = channel.unread_count ?? 0;
    const muted = channel.muted ?? false;
    const fromMe =
      selfHumanId != null && channel.last_message_author_human_id === selfHumanId;
    const incomingUnread = unread > 0 && !muted && !fromMe;

    if (incomingUnread) {
      score += 0.35; // something arrived for you
      if (channel.last_message_author_agent_id != null) score += 0.15; // agent reply
      if (channel.channel_type === 'direct') score += 0.1; // a DM
    }
    if (channel.pinned) score += 0.2; // pinned floats up (replaces the old pin tray)
    if (muted) score *= 0.2; // demote, don't hide

    return { channel, score, time: times[i]! };
  });

  scored.sort((a, b) => b.score - a.score || b.time - a.time);
  return scored.slice(0, LIMIT).map((s) => s.channel);
}

/** Rank-normalize to 0..1: each value scores ``1 - (#strictly-greater)/(n-1)``
 *  so a flat signal cancels out and only relative order matters. */
function rankNorm(values: number[]): number[] {
  const n = values.length;
  if (n <= 1) return values.map(() => 0);
  return values.map((v) => {
    const greater = values.reduce((c, o) => (o > v ? c + 1 : c), 0);
    return 1 - greater / (n - 1);
  });
}

function activityTime(channel: MmChannel): number {
  const stamp = channel.last_message_at ?? channel.created_at ?? '';
  const t = Date.parse(stamp);
  return Number.isNaN(t) ? 0 : t;
}
