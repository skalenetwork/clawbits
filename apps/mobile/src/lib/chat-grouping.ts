import type { MmChannelEvent, MmPost } from '@/lib/api';
import { isAdminCommandText } from '@/lib/admin-commands';

export type OutgoingStatus = 'sending' | 'sent' | 'read';

export interface MessageRow {
  kind: 'message';
  post: MmPost;
  isFirstInStreak: boolean;
  isLastInStreak: boolean;
  /** True for channels' first-in-streak incoming bubbles — drives the
   *  small author label rendered INSIDE the bubble. False in DMs (you
   *  already know who you're talking to). */
  showSenderName: boolean;
  /** True for channels' last-in-streak incoming bubbles — drives the
   *  avatar that sits in the left gutter. False in DMs (no avatar,
   *  no gutter — incoming bubbles flow flush left). */
  showAvatar: boolean;
  isOutgoing: boolean;
  /** True for DMs. The bubble drops its left avatar gutter so the
   *  chat reads as a two-column thread, iMessage-style. */
  isDirect: boolean;
  /** True for operator-DM slash/admin command posts like ``/help`` or ``/new``. */
  isAdminCommand: boolean;
  /** Viewer's own human_id — passed through so reaction pills know if "mine". */
  viewerHumanId: number | null;
  /** Populated only on the very latest outgoing message in a DM. Drives
   *  the inline "Read"/"Sent"/"Sending" indicator below the bubble. */
  outgoingStatus?: OutgoingStatus;
}

export interface SeparatorRow {
  kind: 'separator';
  id: string;
  isoTime: string;
}

export interface TypingRow {
  kind: 'typing';
  id: 'typing-row';
}

export interface EventRow {
  kind: 'event';
  event: MmChannelEvent;
  /** Viewer's own human_id — used by the renderer to pick "You"/"you"
   *  on either side of the actor/subject pair (matches the web
   *  client's first-person rewrite). */
  viewerHumanId: number | null;
}

export type ChatRow = MessageRow | SeparatorRow | TypingRow | EventRow;

const STREAK_GAP_MS = 60_000;
const SEPARATOR_GAP_MS = 30 * 60_000;

interface BuildRowsOptions {
  /** Posts in newest-first order, as the posts API returns them.
   *  ``buildRows`` reverses them into display order (oldest first); the
   *  Legend List renders top-to-bottom and is not inverted. */
  posts: MmPost[];
  /** Inline channel events, in any order. They get interleaved with
   *  ``posts`` chronologically before grouping/separator logic runs.
   *  Empty / undefined → no event rows are produced. DM channels never
   *  receive events (server suppresses emit), so callers can pass the
   *  raw events query result without filtering. */
  events?: MmChannelEvent[];
  /** Current viewer's human id, to decide outgoing vs incoming. */
  viewerHumanId: number | null;
  /** True for DMs — hide channel-style sender name labels. */
  isDirect: boolean;
  /** True when this DM includes an agent peer. Enables admin-command styling. */
  isAgentDirect?: boolean;
  /** Peer's read pointer for DMs — when set, the latest outgoing post
   *  whose ``post_id`` ≤ this value is tagged ``outgoingStatus='read'``. */
  peerLastReadPostId?: number | null;
}

/**
 * Builds inverted (newest-first) row data with iMessage grouping rules:
 *   - same author + within 60s → same streak (no tail on intermediate bubbles)
 *   - gap > 30min from previous → insert a date/time separator
 *   - sender name shown above the first bubble of a streak in channels only
 *   - inline channel events (member.added / member.removed) interleave
 *     by ``created_at`` and always break streaks/separators
 */
export function buildChatRows({
  posts,
  events,
  viewerHumanId,
  isDirect,
  isAgentDirect = false,
  peerLastReadPostId,
}: BuildRowsOptions): ChatRow[] {
  // ``buildChatRows`` operates on a newest-first walk. We interleave
  // events into a parallel newest-first array so an event between two
  // posts breaks streaks naturally (the surrounding posts no longer
  // see each other as the immediate neighbour).
  type WalkItem =
    | { kind: 'post'; post: MmPost; ts: number; id: number }
    | { kind: 'event'; event: MmChannelEvent; ts: number; id: number };
  const walk: WalkItem[] = [];
  for (const p of posts) {
    walk.push({ kind: 'post', post: p, ts: timestamp(p), id: p.post_id });
  }
  if (events) {
    for (const e of events) {
      walk.push({
        kind: 'event',
        event: e,
        ts: Date.parse(e.created_at) || 0,
        id: e.event_id,
      });
    }
  }
  // Newest first (descending). Tiebreak on id within kind (post_id and
  // event_id are independent monotonic sequences).
  walk.sort((a, b) => {
    if (a.ts !== b.ts) return b.ts - a.ts;
    return b.id - a.id;
  });

  const rows: ChatRow[] = [];
  // Tag the FIRST outgoing post encountered (i.e., the newest) with a
  // status badge. Subsequent outgoing posts skip the tag so the chat
  // shows at most one "Read"/"Sent" line, anchored under the latest one.
  let taggedLatestOutgoing = false;

  for (let i = 0; i < walk.length; i++) {
    const item = walk[i];
    if (!item) continue;

    if (item.kind === 'event') {
      rows.push({
        kind: 'event',
        event: item.event,
        viewerHumanId,
      });
      const older = walk[i + 1];
      if (older && Math.abs(item.ts - older.ts) > SEPARATOR_GAP_MS) {
        rows.push({
          kind: 'separator',
          id: `sep-event-${String(item.event.event_id)}`,
          isoTime: item.event.created_at,
        });
      }
      continue;
    }

    const post = item.post;
    const newerItem = walk[i - 1];
    const olderItem = walk[i + 1];
    const newer = newerItem?.kind === 'post' ? newerItem.post : null;
    const older = olderItem?.kind === 'post' ? olderItem.post : null;

    const olderSameAuthor = older && samePoster(post, older);
    const newerSameAuthor = newer && samePoster(post, newer);

    const olderTimeGap = older
      ? Math.abs(timestamp(post) - timestamp(older))
      : Number.POSITIVE_INFINITY;
    const newerTimeGap = newer
      ? Math.abs(timestamp(newer) - timestamp(post))
      : Number.POSITIVE_INFINITY;

    // Events between this post and its prior/next neighbour break the
    // streak — by then ``newer`` / ``older`` already point past them.
    const isFirstInStreak = !olderSameAuthor || olderTimeGap > STREAK_GAP_MS;
    const isLastInStreak = !newerSameAuthor || newerTimeGap > STREAK_GAP_MS;
    const isOutgoing = post.human_id != null && post.human_id === viewerHumanId;

    let outgoingStatus: OutgoingStatus | undefined;
    if (isOutgoing && !taggedLatestOutgoing && isDirect && post._failed !== true) {
      taggedLatestOutgoing = true;
      if (post.post_id < 0 || post.status === 'streaming') {
        outgoingStatus = 'sending';
      } else if (
        peerLastReadPostId != null &&
        peerLastReadPostId >= post.post_id
      ) {
        outgoingStatus = 'read';
      } else {
        outgoingStatus = 'sent';
      }
    }

    rows.push({
      kind: 'message',
      post,
      isFirstInStreak,
      isLastInStreak,
      showSenderName: !isDirect && isFirstInStreak && !isOutgoing,
      // Avatar rides on the same channel-only rule as the name, but on
      // the *last* in streak (anchored to the bottom of the streak so
      // the avatar sits flush with the latest bubble's bottom edge).
      showAvatar: !isDirect && isLastInStreak && !isOutgoing,
      isOutgoing,
      isDirect,
      isAdminCommand: isDirect && isAgentDirect && isOutgoing && isAdminCommandText(post.message),
      viewerHumanId,
      outgoingStatus,
    });

    if (!olderItem) continue;
    const olderGap = Math.abs(item.ts - olderItem.ts);
    if (olderGap > SEPARATOR_GAP_MS) {
      rows.push({
        kind: 'separator',
        id: `sep-${String(post.post_id)}`,
        isoTime: post.created_at,
      });
    }
  }

  return rows;
}

function samePoster(a: MmPost, b: MmPost): boolean {
  if (a.human_id != null || b.human_id != null) return a.human_id === b.human_id;
  return a.agent_id === b.agent_id;
}

function timestamp(post: MmPost): number {
  const t = Date.parse(post.created_at);
  return Number.isNaN(t) ? 0 : t;
}

export function formatSeparator(iso: string, now: number = Date.now()): string {
  const date = new Date(iso);
  const time = date.getTime();
  if (Number.isNaN(time)) return '';

  const today = new Date(now);
  const sameDay =
    today.getFullYear() === date.getFullYear() &&
    today.getMonth() === date.getMonth() &&
    today.getDate() === date.getDate();

  const timeStr = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });

  if (sameDay) return `Today ${timeStr}`;

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    yesterday.getFullYear() === date.getFullYear() &&
    yesterday.getMonth() === date.getMonth() &&
    yesterday.getDate() === date.getDate();
  if (isYesterday) return `Yesterday ${timeStr}`;

  const weekdayMs = 6 * 24 * 60 * 60 * 1000;
  if (now - time < weekdayMs) {
    const weekday = date.toLocaleDateString(undefined, { weekday: 'short' });
    return `${weekday} ${timeStr}`;
  }

  const datePart = date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  return `${datePart} at ${timeStr}`;
}
