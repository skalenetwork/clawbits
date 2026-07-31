import { describe, expect, it } from "vitest";

import { rankJumpBackIn } from "./jumpBackIn";
import { frecencyKey, type FrecencyStore } from "./frecency";
import type { MmChannel } from "./api";

const NOW = new Date("2026-06-18T12:00:00Z").getTime();
const HOUR = 3_600_000;

const channel = (
  overrides: Partial<MmChannel> & { channel_id: string },
): MmChannel => ({
  name: overrides.channel_id,
  channel_type: "public",
  created_at: "2026-06-01T00:00:00Z",
  ...overrides,
});

/** A frecency store with the given channels marked as heavily-used recently. */
const frecencyFor = (...channelIds: string[]): FrecencyStore => {
  const store: FrecencyStore = {};
  for (const id of channelIds) {
    store[frecencyKey("channel", id)] = { count: 20, visits: [NOW - HOUR] };
  }
  return store;
};

const noDrafts = new Map<string, { text: string }>();
const ids = (items: { channel: MmChannel }[]) =>
  items.map((it) => it.channel.channel_id);

describe("rankJumpBackIn", () => {
  it("returns nothing for an empty channel list", () => {
    expect(
      rankJumpBackIn({
        channels: [],
        frecency: {},
        drafts: noDrafts,
        now: NOW,
        currentUserId: 1,
      }),
    ).toEqual([]);
  });

  it("ranks an incoming agent reply above a more-frequent but quiet chat", () => {
    // `quiet` is the habitual chat (high frecency) with nothing new; `replied`
    // is rarely visited but an agent just answered there.
    const quiet = channel({ channel_id: "quiet", last_message_at: "2026-06-17T00:00:00Z" });
    const replied = channel({
      channel_id: "replied",
      last_message_at: "2026-06-18T11:59:00Z",
      unread_count: 1,
      last_message_author_agent_id: "agent-ada",
    });

    const ranked = rankJumpBackIn({
      channels: [quiet, replied],
      frecency: frecencyFor("quiet"),
      drafts: noDrafts,
      now: NOW,
      currentUserId: 1,
    });

    expect(ids(ranked)).toEqual(["replied", "quiet"]);
    expect(ranked.map((r) => r.reason)).toEqual(["agent-reply", "recent"]);
  });

  it("surfaces a draft with its text, and flags the reason", () => {
    const plain = channel({ channel_id: "plain", last_message_at: "2026-06-18T11:00:00Z" });
    const drafting = channel({ channel_id: "drafting", last_message_at: "2026-06-10T00:00:00Z" });

    const ranked = rankJumpBackIn({
      channels: [plain, drafting],
      frecency: {},
      drafts: new Map([["drafting", { text: "  half a\n\n  thought  " }]]),
      now: NOW,
      currentUserId: 1,
    });

    expect(ids(ranked)).toEqual(["drafting", "plain"]);
    expect(ranked.map((r) => r.reason)).toEqual(["draft", "recent"]);
    // Whitespace/newlines collapse to a single-line preview; non-drafts carry none.
    expect(ranked.map((r) => r.draftText)).toEqual(["half a thought", null]);
  });

  it("does not boost unread on your own trailing message", () => {
    // Both equally (un)used; `mine` shows unread but the last post is the
    // user's own, so it's not 'your turn' — `theirs` should win.
    const mine = channel({
      channel_id: "mine",
      last_message_at: "2026-06-18T11:59:00Z",
      unread_count: 3,
      last_message_author_human_id: 1,
    });
    const theirs = channel({
      channel_id: "theirs",
      last_message_at: "2026-06-18T11:00:00Z",
      unread_count: 1,
      last_message_author_human_id: 2,
    });

    const ranked = rankJumpBackIn({
      channels: [mine, theirs],
      frecency: {},
      drafts: noDrafts,
      now: NOW,
      currentUserId: 1,
    });

    expect(ids(ranked)).toEqual(["theirs", "mine"]);
    expect(ranked.map((r) => r.reason)).toEqual(["unread", "recent"]);
  });

  it("heavily demotes muted chats even when they have unread", () => {
    const muted = channel({
      channel_id: "muted",
      last_message_at: "2026-06-18T11:59:00Z",
      unread_count: 50,
      muted: true,
      last_message_author_human_id: 2,
    });
    const recent = channel({ channel_id: "recent", last_message_at: "2026-06-18T09:00:00Z" });

    const ranked = rankJumpBackIn({
      channels: [muted, recent],
      frecency: frecencyFor("recent"),
      drafts: noDrafts,
      now: NOW,
      currentUserId: 1,
    });

    // Muted never earns the incoming-unread boost, so it sinks below the plain
    // recent chat and its reason stays "recent".
    expect(ids(ranked)).toEqual(["recent", "muted"]);
    expect(ranked.map((r) => r.reason)).toEqual(["recent", "recent"]);
  });

  it("respects the limit (default 4)", () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      channel({ channel_id: `c${String(i)}`, last_message_at: `2026-06-${String(11 + i)}T00:00:00Z` }),
    );
    expect(rankJumpBackIn({ channels: many, frecency: {}, drafts: noDrafts, now: NOW, currentUserId: 1 })).toHaveLength(4);
    expect(
      rankJumpBackIn({ channels: many, frecency: {}, drafts: noDrafts, now: NOW, currentUserId: 1, limit: 2 }),
    ).toHaveLength(2);
  });
});
