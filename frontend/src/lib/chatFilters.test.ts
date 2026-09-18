import { describe, expect, it } from "vitest";

import {
  activityTime,
  filterChannelsByTab,
  groupAgentChats,
  isPairType,
  sortByRecency,
} from "./chatFilters";
import type { MmChannel } from "./api";

const channel = (overrides: Partial<MmChannel> & { channel_id: string }): MmChannel => ({
  name: overrides.channel_id,
  channel_type: "public",
  created_at: "2026-06-01T00:00:00Z",
  ...overrides,
});

const pub = channel({ channel_id: "pub", channel_type: "public" });
const priv = channel({ channel_id: "priv", channel_type: "private" });
const dm = channel({ channel_id: "dm", channel_type: "direct" });
const chat = channel({
  channel_id: "chat",
  channel_type: "agent_chat",
  dm_peer_agent_id: "atlas",
  display_name: "Fix auth",
});

describe("isPairType", () => {
  it("is true for inbox and named chats", () => {
    expect(isPairType("direct")).toBe(true);
    expect(isPairType("agent_chat")).toBe(true);
    expect(isPairType("public")).toBe(false);
  });
});

describe("filterChannelsByTab", () => {
  const all = [pub, priv, dm, chat];

  it("returns everything for the 'all' tab", () => {
    expect(filterChannelsByTab(all, "all")).toEqual(all);
  });

  it("returns non-direct channels for the 'channels' tab", () => {
    expect(filterChannelsByTab(all, "channels")).toEqual([pub, priv]);
  });

  it("returns only human 1:1s for the 'dms' tab", () => {
    const inbox = channel({ channel_id: "inbox", channel_type: "direct", dm_peer_agent_id: "atlas" });
    expect(filterChannelsByTab([inbox, chat, dm], "dms")).toEqual([dm]);
  });

  it("includes pinned channels in their type's tab (no exclusion)", () => {
    const pinnedDm = channel({ channel_id: "pdm", channel_type: "direct", pinned: true });
    expect(filterChannelsByTab([pinnedDm, dm], "dms")).toEqual([pinnedDm, dm]);
  });

  it("returns agent inbox and named chats for the 'agents' tab", () => {
    const inbox = channel({ channel_id: "inbox", channel_type: "direct", dm_peer_agent_id: "atlas" });
    expect(filterChannelsByTab([inbox, chat, dm], "agents")).toEqual([inbox, chat]);
  });
});

describe("sortByRecency", () => {
  it("orders by last_message_at descending, newest first", () => {
    const older = channel({ channel_id: "older", last_message_at: "2026-06-10T00:00:00Z" });
    const newer = channel({ channel_id: "newer", last_message_at: "2026-06-14T00:00:00Z" });
    expect(sortByRecency([older, newer]).map((c) => c.channel_id)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("falls back to created_at when last_message_at is absent", () => {
    const noMsg = channel({ channel_id: "noMsg", created_at: "2026-06-02T00:00:00Z" });
    const withMsg = channel({ channel_id: "withMsg", last_message_at: "2026-06-01T00:00:00Z" });
    // noMsg's created_at (Jun 2) beats withMsg's last_message_at (Jun 1).
    expect(sortByRecency([withMsg, noMsg]).map((c) => c.channel_id)).toEqual([
      "noMsg",
      "withMsg",
    ]);
  });

  it("does not float pinned channels to the top", () => {
    const pinnedOld = channel({ channel_id: "pinnedOld", pinned: true, last_message_at: "2026-06-01T00:00:00Z" });
    const freshUnpinned = channel({ channel_id: "fresh", last_message_at: "2026-06-14T00:00:00Z" });
    expect(sortByRecency([pinnedOld, freshUnpinned]).map((c) => c.channel_id)).toEqual([
      "fresh",
      "pinnedOld",
    ]);
  });

  it("does not mutate the input array", () => {
    const a = channel({ channel_id: "a", last_message_at: "2026-06-01T00:00:00Z" });
    const b = channel({ channel_id: "b", last_message_at: "2026-06-14T00:00:00Z" });
    const input = [a, b];
    sortByRecency(input);
    expect(input.map((c) => c.channel_id)).toEqual(["a", "b"]);
  });
});

describe("activityTime", () => {
  it("returns 0 when neither timestamp is present", () => {
    const bare = { channel_id: "x", name: "x", channel_type: "public", created_at: "" } as MmChannel;
    expect(activityTime(bare)).toBe(0);
  });
});

describe("groupAgentChats", () => {
  it("clusters inbox first and named chats by recency", () => {
    const inbox = channel({
      channel_id: "inbox",
      channel_type: "direct",
      dm_peer_agent_id: "atlas",
      last_message_at: "2026-06-10T00:00:00Z",
    });
    const older = channel({
      channel_id: "older",
      channel_type: "agent_chat",
      dm_peer_agent_id: "atlas",
      last_message_at: "2026-06-08T00:00:00Z",
    });
    const newer = channel({
      channel_id: "newer",
      channel_type: "agent_chat",
      dm_peer_agent_id: "atlas",
      last_message_at: "2026-06-12T00:00:00Z",
    });
    const other = channel({
      channel_id: "other",
      channel_type: "direct",
      dm_peer_agent_id: "bravo",
      last_message_at: "2026-06-01T00:00:00Z",
    });
    const groups = groupAgentChats([older, other, inbox, newer]);
    expect(groups.map((g) => g.agentId)).toEqual(["atlas", "bravo"]);
    expect(groups[0]?.inbox?.channel_id).toBe("inbox");
    expect(groups[0]?.chats.map((c) => c.channel_id)).toEqual(["newer", "older"]);
    expect(groups[1]?.inbox?.channel_id).toBe("other");
    expect(groups[1]?.chats).toEqual([]);
  });

  it("keeps named chats without an inbox", () => {
    const solo = channel({
      channel_id: "solo",
      channel_type: "agent_chat",
      dm_peer_agent_id: "atlas",
    });
    const groups = groupAgentChats([solo]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.inbox).toBeNull();
    expect(groups[0]?.chats).toEqual([solo]);
  });

  it("skips channels without an agent peer", () => {
    expect(groupAgentChats([dm, pub])).toEqual([]);
  });
});
