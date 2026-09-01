import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MmChannelEvent, MmChannelPost } from "@/lib/api";
import {
  buildTimeline,
  decorateRows,
  generatingAgentsOf,
  mergePosts,
  postsOf,
  queuedOwnPostIdsOf,
} from "./channelTimeline";

const T0 = "2026-09-01T10:00:00";

// buildTimeline drops placeholders by wall-clock age, so pin "now" to T0.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${T0}Z`));
});
afterEach(() => { vi.useRealTimers(); });

function post(id: number, over: Partial<MmChannelPost> = {}): MmChannelPost {
  return {
    post_id: id,
    channel_id: "c1",
    agent_id: null,
    human_id: 1,
    poster_display_name: "Alice",
    message: `m${String(id)}`,
    created_at: T0,
    status: "published",
    ...over,
  };
}

function event(id: number, createdAt = T0): MmChannelEvent {
  return {
    event_id: id,
    channel_id: "c1",
    event_type: "member_joined",
    actor_human_id: 2,
    actor_agent_id: null,
    actor_display_name: "Bob",
    actor_avatar: null,
    subject_human_id: null,
    subject_agent_id: null,
    subject_display_name: null,
    subject_avatar: null,
    payload: null,
    created_at: createdAt,
  };
}

/** ``created_at`` offset by whole minutes from {@link T0}. */
function at(minutes: number): string {
  return new Date(Date.parse(`${T0}Z`) + minutes * 60_000)
    .toISOString()
    .replace("Z", "");
}

describe("mergePosts", () => {
  it("puts loaded history before the live page, oldest first", () => {
    const merged = mergePosts(null, [post(1), post(2)], [post(4), post(3)]);
    expect(merged.map((p) => p.post_id)).toEqual([1, 2, 3, 4]);
  });

  it("dedupes the boundary post two contiguous fetches share", () => {
    const merged = mergePosts(null, [post(1), post(2)], [post(3), post(2)]);
    expect(merged.map((p) => p.post_id)).toEqual([1, 2, 3]);
  });

  it("lets an anchored window supersede both live sources", () => {
    const merged = mergePosts([post(7), post(8)], [post(1)], [post(9)]);
    expect(merged.map((p) => p.post_id)).toEqual([7, 8]);
  });
});

describe("buildTimeline", () => {
  it("interleaves posts and events by timestamp", () => {
    const timeline = buildTimeline(
      [post(1, { created_at: at(0) }), post(2, { created_at: at(2) })],
      [event(5, at(1))],
    );
    expect(timeline.map((i) => i.kind)).toEqual(["post", "event", "post"]);
  });

  it("drops an empty streaming post its agent abandoned an hour ago", () => {
    const stale = post(1, {
      agent_id: "a1",
      human_id: null,
      message: "",
      status: "streaming",
      created_at: at(-120),
    });
    expect(buildTimeline([stale], [])).toEqual([]);
  });

  it("keeps a fresh streaming placeholder", () => {
    const live = post(1, { agent_id: "a1", human_id: null, message: "", status: "streaming" });
    expect(buildTimeline([live], [])).toHaveLength(1);
  });

  it("skips a draft the same agent already overtook with a published post", () => {
    const draft = post(5, { agent_id: "a1", human_id: null, message: "", status: "streaming" });
    const published = post(6, { agent_id: "a1", human_id: null, message: "done" });
    expect(postsOf(buildTimeline([draft, published], [])).map((p) => p.post_id)).toEqual([6]);
  });
});

describe("decorateRows", () => {
  const decorate = (timeline: ReturnType<typeof buildTimeline>, over = {}) =>
    decorateRows({
      timeline,
      enteredAtUnread: 0,
      firstUnreadPostId: null,
      generatingAgents: [],
      queuedOwnPostIds: new Set<number>(),
      ...over,
    });

  it("groups consecutive same-author posts inside the window", () => {
    const rows = decorate(buildTimeline([post(1), post(2, { created_at: at(1) })], []));
    expect(rows.map((r) => r.kind === "post" && r.isGroupStart)).toEqual([true, false]);
  });

  it("breaks a group on a different author, a reply, and a stale gap", () => {
    const rows = decorate(
      buildTimeline(
        [
          post(1),
          post(2, { human_id: 9, created_at: at(1) }),
          post(3, { human_id: 9, created_at: at(30) }),
          post(4, { human_id: 9, created_at: at(30), parent_post_id: 1 }),
        ],
        [],
      ),
    );
    expect(rows.map((r) => r.kind === "post" && r.isGroupStart)).toEqual([true, true, true, true]);
  });

  it("marks the last post of a run as the group end", () => {
    const rows = decorate(buildTimeline([post(1), post(2, { created_at: at(1) })], []));
    expect(rows.map((r) => r.kind === "post" && r.isGroupEnd)).toEqual([false, true]);
  });

  it("anchors the unread divider on the locked post, events ignored", () => {
    const timeline = buildTimeline([post(1), post(2, { created_at: at(1) })], [event(4, at(1))]);
    const rows = decorate(timeline, { enteredAtUnread: 1, firstUnreadPostId: 2 });
    const flagged = rows.filter((r) => r.kind === "post" && r.showUnreadDivider);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ post: { post_id: 2 } });
  });

  it("appends generating indicators after everything else", () => {
    const rows = decorate(buildTimeline([post(1)], []), {
      generatingAgents: [{ agentId: "a1", member: null }],
    });
    expect(rows.at(-1)).toEqual({ kind: "generating", agentId: "a1", member: null });
  });
});

describe("generatingAgentsOf", () => {
  it("skips an agent that is already rendering a streaming post", () => {
    const streaming = post(1, { agent_id: "a1", human_id: null, status: "streaming" });
    expect(generatingAgentsOf({ "agent:a1": "generating" }, [streaming], [])).toEqual([]);
    expect(generatingAgentsOf({ "agent:a1": "generating" }, [], [])).toEqual([
      { agentId: "a1", member: null },
    ]);
  });

  it("ignores humans and non-generating statuses", () => {
    expect(generatingAgentsOf({ "human:1": "generating", "agent:a2": "online" }, [], [])).toEqual([]);
  });
});

describe("queuedOwnPostIdsOf", () => {
  it("marks every unanswered own message except the first", () => {
    const posts = [
      post(1, { agent_id: "a1", human_id: null }),
      post(2),
      post(3),
      post(4),
    ];
    expect([...queuedOwnPostIdsOf(posts, true, 1)]).toEqual([3, 4]);
  });

  it("marks nothing while no agent is generating", () => {
    expect(queuedOwnPostIdsOf([post(1), post(2)], false, 1).size).toBe(0);
  });
});
