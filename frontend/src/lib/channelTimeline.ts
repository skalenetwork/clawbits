import type { MmChannelEvent, MmChannelMember, MmChannelPost } from "@/lib/api";
import { parseUtcTimestamp } from "@/lib/formatting";
import type { PresenceMap } from "@/hooks/useChannelEvents";

const STALE_STREAMING_MS = 60 * 60 * 1000;
const GROUP_WINDOW_MS = 5 * 60 * 1000;

type TimelineItem =
  | { kind: "post"; post: MmChannelPost; ts: number }
  | { kind: "event"; event: MmChannelEvent; ts: number };

interface GeneratingAgent {
  agentId: string;
  member: MmChannelMember | null;
}

type DecoratedRow =
  | {
      kind: "post";
      post: MmChannelPost;
      isGroupStart: boolean;
      newDay: boolean;
      showUnreadDivider: boolean;
      queued: boolean;
    }
  | { kind: "event"; event: MmChannelEvent; newDay: boolean }
  | ({ kind: "generating" } & GeneratingAgent);

export function dedupePostsById(posts: MmChannelPost[]): MmChannelPost[] {
  const seen = new Set<number>();
  return posts.filter((p) => !seen.has(p.post_id) && seen.add(p.post_id));
}

export function mergePosts(
  anchorPosts: MmChannelPost[] | null,
  olderPosts: MmChannelPost[],
  latestPosts: MmChannelPost[],
): MmChannelPost[] {
  return dedupePostsById(anchorPosts ?? [...olderPosts, ...latestPosts.toReversed()]);
}

// Drops dead reply placeholders: stale empty streams, and ones the same agent already overtook with a published post.
export function buildTimeline(posts: MmChannelPost[], events: MmChannelEvent[]): TimelineItem[] {
  const staleCutoff = Date.now() - STALE_STREAMING_MS;
  const latestPublishedByAgent = new Map<string, number>();
  for (const p of posts) {
    if (p.agent_id && p.status === "published" && p.post_id > (latestPublishedByAgent.get(p.agent_id) ?? 0)) {
      latestPublishedByAgent.set(p.agent_id, p.post_id);
    }
  }
  const items: TimelineItem[] = [];
  for (const p of posts) {
    const ts = parseUtcTimestamp(p.created_at).getTime();
    const deadPlaceholder =
      p.status === "streaming"
      && p.message.trim() === ""
      && !p.files?.length
      && (ts < staleCutoff
        || (p.post_id > 0 && p.agent_id != null && (latestPublishedByAgent.get(p.agent_id) ?? 0) > p.post_id));
    if (!deadPlaceholder) items.push({ kind: "post", post: p, ts });
  }
  for (const e of events) items.push({ kind: "event", event: e, ts: parseUtcTimestamp(e.created_at).getTime() });
  const idOf = (item: TimelineItem) => (item.kind === "post" ? item.post.post_id : item.event.event_id);
  return items.sort((a, b) => (a.ts !== b.ts ? a.ts - b.ts : idOf(a) - idOf(b)));
}

export function postsOf(timeline: TimelineItem[]): MmChannelPost[] {
  return timeline.flatMap((item) => (item.kind === "post" ? [item.post] : []));
}

export function generatingAgentsOf(
  presence: PresenceMap,
  posts: MmChannelPost[],
  members: MmChannelMember[],
): GeneratingAgent[] {
  return Object.entries(presence).flatMap(([key, status]) => {
    const [kind, id] = key.split(":", 2);
    if (status !== "generating" || kind !== "agent" || !id) return [];
    if (posts.some((p) => p.agent_id === id && p.status === "streaming")) return [];
    return [{ agentId: id, member: members.find((m) => m.agent_id === id) ?? null }];
  });
}

// Own messages sent after the last agent post while it is still replying, minus the first one it is working on.
export function queuedOwnPostIdsOf(
  posts: MmChannelPost[],
  anyGenerating: boolean,
  currentUserId: number | null | undefined,
): Set<number> {
  if (!anyGenerating || currentUserId == null) return new Set();
  const own = posts
    .slice(posts.findLastIndex((p) => p.agent_id) + 1)
    .filter((p) => p.agent_id == null && p.human_id === currentUserId);
  return new Set(own.slice(1).map((p) => p.post_id));
}

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

export function decorateRows({
  timeline,
  firstUnreadPostId,
  generatingAgents,
  queuedOwnPostIds,
}: {
  timeline: TimelineItem[];
  firstUnreadPostId: number | null;
  generatingAgents: GeneratingAgent[];
  queuedOwnPostIds: Set<number>;
}): DecoratedRow[] {
  const rows = timeline.map((row, i): DecoratedRow => {
    const prev = timeline[i - 1];
    const newDay = !prev || !sameDay(prev.ts, row.ts);
    if (row.kind === "event") return { kind: "event", event: row.event, newDay };
    const { post } = row;
    const continuation =
      prev?.kind === "post"
      && !newDay
      && prev.post.agent_id === post.agent_id
      && prev.post.human_id === post.human_id
      && row.ts - prev.ts < GROUP_WINDOW_MS
      && post.parent_post_id == null
      && post.pinned_at == null
      && post.edited_at == null;
    return {
      kind: "post",
      post,
      isGroupStart: !continuation,
      newDay,
      showUnreadDivider: post.post_id === firstUnreadPostId,
      queued: queuedOwnPostIds.has(post.post_id),
    };
  });
  return [...rows, ...generatingAgents.map((g) => ({ kind: "generating" as const, ...g }))];
}
