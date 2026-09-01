/**
 * The chat timeline, derived. Everything the channel renders below the
 * header is a pure function of four inputs — the post pages, the channel
 * events, presence, and the unread anchor — so it lives here rather than
 * inside ``ChannelPage``: the page keeps the state machine, this module
 * turns that state into rows.
 *
 * The pipeline is three stages, in order:
 *
 *   mergePosts    → one deduped, oldest-first post list
 *   buildTimeline → posts + events interleaved chronologically
 *   decorateRows  → per-row grouping / day / unread / generating flags
 */
import type { MmChannelEvent, MmChannelMember, MmChannelPost } from "@/lib/api";
import { parseUtcTimestamp } from "@/lib/formatting";
import { GROUP_WINDOW_MS, isSameDay, samePoster } from "@/lib/messageHelpers";
import type { PresenceMap } from "@/hooks/useChannelEvents";

/** How long an empty ``streaming`` post may sit before the timeline drops it.
 *  An agent that died mid-reply never finalizes its placeholder, and without
 *  this the shimmer would stay forever. */
const STALE_STREAMING_MS = 60 * 60 * 1000;

export type TimelineItem =
  | { kind: "post"; post: MmChannelPost; ts: number }
  | { kind: "event"; event: MmChannelEvent; ts: number };

export type DecoratedRow =
  | {
      kind: "post";
      post: MmChannelPost;
      isGroupStart: boolean;
      /** Last post of a consecutive same-author run — the row that carries the
       *  avatar in bubble mode (Telegram anchors it to the bottom of a group). */
      isGroupEnd: boolean;
      isLatest: boolean;
      newDay: boolean;
      showUnreadDivider: boolean;
      queued: boolean;
    }
  | {
      kind: "event";
      event: MmChannelEvent;
      isLatest: boolean;
      newDay: boolean;
    }
  | ({ kind: "generating" } & GeneratingAgent);

/** An agent whose reply is in flight, rendered as an ephemeral bottom row. */
export interface GeneratingAgent {
  agentId: string;
  member: MmChannelMember | null;
}

/** Dedupe a post list by id, preserving order — a cheap guard against the
 *  seam where two contiguous fetches share a boundary post. */
export function dedupePostsById(posts: MmChannelPost[]): MmChannelPost[] {
  const seen = new Set<number>();
  const out: MmChannelPost[] = [];
  for (const p of posts) {
    if (!seen.has(p.post_id)) { seen.add(p.post_id); out.push(p); }
  }
  return out;
}

/**
 * One oldest-first post list out of the two sources the page pages
 * independently: the history it has loaded upward (``olderPosts``) and the
 * live page the query owns (``latestPosts``, newest-first from the server).
 *
 * An anchored window supersedes both: while the reader is parked on a slice
 * of history, live polling is suspended and that segment — already contiguous
 * and oldest-first — is the sole source of truth.
 */
export function mergePosts(
  anchorPosts: MmChannelPost[] | null,
  olderPosts: MmChannelPost[],
  latestPosts: MmChannelPost[],
): MmChannelPost[] {
  if (anchorPosts) return dedupePostsById(anchorPosts);
  return dedupePostsById([...olderPosts, ...[...latestPosts].reverse()]);
}

/**
 * Merge posts and channel events into a single chronologically-ordered
 * stream (oldest → newest). The two arrive on separate queries with their
 * own pagination, so merging at render time keeps them decoupled — a
 * regression in either source can't accidentally hide the other. Stable
 * sort by created_at, then by id within kind so ties resolve
 * deterministically.
 *
 * Two classes of dead placeholder are dropped here: an empty streaming post
 * older than {@link STALE_STREAMING_MS} (its agent died mid-reply), and one
 * the same agent has already overtaken with a published post — older plugin
 * builds deliver a message-tool reply as a *fresh* post and only cancel the
 * shimmer draft when the turn settles a second or two later.
 */
export function buildTimeline(
  posts: MmChannelPost[],
  events: MmChannelEvent[],
): TimelineItem[] {
  const items: TimelineItem[] = [];
  const staleStreamingCutoff = Date.now() - STALE_STREAMING_MS;
  // Newest published post id per agent — drives the obsolete-draft skip.
  // post_id is a server-side sequence, so a higher id means "created later".
  const latestPublishedByAgent = new Map<string, number>();
  for (const p of posts) {
    if (p.agent_id && p.status === "published" && p.post_id > 0) {
      const prev = latestPublishedByAgent.get(p.agent_id) ?? 0;
      if (p.post_id > prev) latestPublishedByAgent.set(p.agent_id, p.post_id);
    }
  }
  for (const p of posts) {
    const ts = parseUtcTimestamp(p.created_at).getTime();
    // An empty ``streaming`` post is an agent's in-flight reply placeholder
    // (renders as the generating shimmer).
    const isEmptyStreaming =
      p.status === "streaming"
      && p.message.trim() === ""
      && (p.files?.length ?? 0) === 0;
    if (isEmptyStreaming && ts < staleStreamingCutoff) continue;
    if (
      isEmptyStreaming
      && p.post_id > 0
      && p.agent_id != null
      && (latestPublishedByAgent.get(p.agent_id) ?? 0) > p.post_id
    ) {
      continue;
    }
    items.push({ kind: "post", post: p, ts });
  }
  for (const e of events) {
    items.push({ kind: "event", event: e, ts: parseUtcTimestamp(e.created_at).getTime() });
  }
  items.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    // Tiebreaker: same-second post and event use their numeric id (post_id and
    // event_id are from independent sequences, but the sort is stable and
    // within a single kind preserves emit order).
    const aId = a.kind === "post" ? a.post.post_id : a.event.event_id;
    const bId = b.kind === "post" ? b.post.post_id : b.event.event_id;
    return aId - bId;
  });
  return items;
}

/** When a timeline item happened, as the raw stored timestamp. */
function tsOf(item: TimelineItem): string {
  return item.kind === "post" ? item.post.created_at : item.event.created_at;
}

/** Post-only projection of a timeline, for the unread-anchor math — unread
 *  tracking is post-id-based on the server, so events neither count toward
 *  the cursor nor host the divider. */
export function postsOf(timeline: TimelineItem[]): MmChannelPost[] {
  return timeline
    .filter((r): r is TimelineItem & { kind: "post" } => r.kind === "post")
    .map((r) => r.post);
}

/**
 * Agents currently "generating", surfaced as an ephemeral indicator row
 * pinned to the bottom of the timeline. Derived purely from presence (which
 * self-expires via its TTL and is cleared the instant a finished post lands),
 * so it can never get stranded the way a fabricated placeholder post could.
 * An agent already showing a live streaming post is skipped — that post
 * renders its own shimmer, no need to double up.
 */
export function generatingAgentsOf(
  presence: PresenceMap,
  posts: MmChannelPost[],
  members: MmChannelMember[],
): GeneratingAgent[] {
  const out: GeneratingAgent[] = [];
  for (const [key, status] of Object.entries(presence)) {
    if (status !== "generating") continue;
    const [kind, id] = key.split(":", 2) as ["agent" | "human", string];
    if (kind !== "agent" || !id) continue;
    if (posts.some((p) => p.agent_id === id && p.status === "streaming")) continue;
    out.push({ agentId: id, member: members.find((m) => m.agent_id === id) ?? null });
  }
  return out;
}

/**
 * Multi-message acknowledgement: the viewer's own messages fired while an
 * agent is mid-reply and not answered yet. Every such trailing own-message is
 * marked EXCEPT the earliest in the run — that one is what the agent is
 * presumably already working on (the generating row covers it), and the
 * *extra* ones are the gap with no acknowledgement they were even received.
 * Pure derivation from positions, so it survives the optimistic→canonical
 * swap and clears the instant the agent posts anything newer.
 */
export function queuedOwnPostIdsOf(
  posts: MmChannelPost[],
  anyGenerating: boolean,
  currentUserId: number | null | undefined,
): Set<number> {
  const set = new Set<number>();
  if (!anyGenerating || currentUserId == null) return set;
  let lastAgentIdx = -1;
  for (let i = posts.length - 1; i >= 0; i--) {
    if (posts[i]?.agent_id) { lastAgentIdx = i; break; }
  }
  const ownAfter: number[] = [];
  for (let i = lastAgentIdx + 1; i < posts.length; i++) {
    const p = posts[i];
    if (p && p.agent_id == null && p.human_id === currentUserId) ownAfter.push(p.post_id);
  }
  for (let i = 1; i < ownAfter.length; i++) set.add(ownAfter[i]!);
  return set;
}

export interface DecorateInput {
  timeline: TimelineItem[];
  /** Unread count captured on entering the channel; 0 disables the divider. */
  enteredAtUnread: number;
  /** Locked divider anchor, once the first render has picked one. */
  firstUnreadPostId: number | null;
  generatingAgents: GeneratingAgent[];
  queuedOwnPostIds: Set<number>;
}

/**
 * Pre-compute per-row decoration flags (grouping, new day, unread boundary)
 * so the virtualizer can render each item in isolation — virtualized items
 * don't render in sequence, so a row can't peek at its predecessor.
 */
export function decorateRows({
  timeline,
  enteredAtUnread,
  firstUnreadPostId,
  generatingAgents,
  queuedOwnPostIds,
}: DecorateInput): DecoratedRow[] {
  // The unread divider attaches to the first unread *post* — events never
  // anchor it — so locate that post inside the merged array.
  const unreadDividerIndex = (() => {
    if (enteredAtUnread <= 0 || timeline.length === 0) return -1;
    const posts = postsOf(timeline);
    const targetPostId =
      firstUnreadPostId ?? posts[Math.max(0, posts.length - enteredAtUnread)]?.post_id;
    if (targetPostId == null) return -1;
    return timeline.findIndex((r) => r.kind === "post" && r.post.post_id === targetPostId);
  })();

  const decorated = timeline.map((row, i): DecoratedRow => {
    const prev = timeline[i - 1] ?? null;
    const currTs = tsOf(row);
    const newDay = !prev || !isSameDay(tsOf(prev), currTs);
    const isLatest = i === timeline.length - 1;
    if (row.kind === "event") {
      return { kind: "event", event: row.event, isLatest, newDay };
    }
    const post = row.post;
    // Events break post grouping — sameAuthor only fires when the previous
    // row is also a post.
    const sameAuthor = prev?.kind === "post" && samePoster(prev.post, post);
    const withinWindow =
      prev != null
      && parseUtcTimestamp(currTs).getTime() - parseUtcTimestamp(tsOf(prev)).getTime()
        < GROUP_WINDOW_MS;
    const isReply = post.parent_post_id != null;
    return {
      kind: "post",
      post,
      isGroupStart: !prev || newDay || !sameAuthor || !withinWindow || isReply,
      isGroupEnd: true, // provisional; resolved by the look-ahead pass below
      isLatest,
      newDay,
      showUnreadDivider: i === unreadDividerIndex,
      queued: queuedOwnPostIds.has(post.post_id),
    };
  });

  // Second pass: a post is a group-end unless the row right after it is a
  // same-author continuation. Events and the generating indicator break a run,
  // so they leave the current post as an end.
  for (let i = 0; i < decorated.length; i++) {
    const r = decorated[i];
    if (r?.kind !== "post") continue;
    const next = decorated[i + 1];
    r.isGroupEnd = !(next?.kind === "post" && !next.isGroupStart);
  }

  // "Agent is replying" indicators always sit at the very bottom, regardless
  // of timestamp.
  return [...decorated, ...generatingAgents.map((g) => ({ kind: "generating" as const, ...g }))];
}
