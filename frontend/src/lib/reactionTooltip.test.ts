import { describe, it, expect } from "vitest";
import { formatReactors } from "@/lib/reactionTooltip";
import type { MmChannelMember, MmPostReaction } from "@/lib/api";

const ME = 14;

function member(over: Partial<MmChannelMember>): MmChannelMember {
  return {
    agent_id: null,
    human_id: null,
    display_name: null,
    joined_at: "2026-05-14",
    status: null,
    last_seen_at: null,
    ...over,
  } as MmChannelMember;
}

function reaction(over: Partial<MmPostReaction>): MmPostReaction {
  return {
    emoji: "👍",
    count: 0,
    human_ids: [],
    agent_ids: [],
    ...over,
  };
}

const members: MmChannelMember[] = [
  member({ human_id: ME, display_name: "Alice" }),
  member({ human_id: 99, display_name: "Bob" }),
  member({ agent_id: "PartyLava", display_name: "PartyLava" }),
  member({ agent_id: "Scout",     display_name: "Scout" }),
];

describe("formatReactors", () => {
  it("returns null when no one reacted", () => {
    expect(formatReactors(reaction({}), members, ME)).toBeNull();
  });

  it("puts 'You' first when the current user reacted", () => {
    const r = reaction({ count: 2, human_ids: [99, ME] });
    expect(formatReactors(r, members, ME)).toBe("You and Bob reacted with 👍");
  });

  it("resolves human display_name (falls back to ``User <id>`` if missing)", () => {
    const r = reaction({ count: 2, human_ids: [99, 12345] });
    expect(formatReactors(r, members, ME)).toBe(
      "Bob and User 12345 reacted with 👍",
    );
  });

  it("includes agents in the list, after humans", () => {
    const r = reaction({ count: 3, human_ids: [99], agent_ids: ["PartyLava", "Scout"] });
    expect(formatReactors(r, members, ME)).toBe(
      "Bob, PartyLava and Scout reacted with 👍",
    );
  });

  it("uses commas + 'and' for 3–6 reactors", () => {
    const r = reaction({
      count: 4,
      human_ids: [99, 100, 101, 102],
    });
    const out = formatReactors(r, [
      ...members,
      member({ human_id: 100, display_name: "Carol" }),
      member({ human_id: 101, display_name: "Dan" }),
      member({ human_id: 102, display_name: "Eve" }),
    ], ME);
    expect(out).toBe("Bob, Carol, Dan and Eve reacted with 👍");
  });

  it("truncates with 'N others' past 6 reactors", () => {
    const ids = [99, 100, 101, 102, 103, 104, 105]; // 7 unique
    const all = [
      ...members,
      member({ human_id: 100, display_name: "Carol" }),
      member({ human_id: 101, display_name: "Dan" }),
      member({ human_id: 102, display_name: "Eve" }),
      member({ human_id: 103, display_name: "Faye" }),
      member({ human_id: 104, display_name: "Greg" }),
      member({ human_id: 105, display_name: "Hank" }),
    ];
    const r = reaction({ count: 7, human_ids: ids });
    expect(formatReactors(r, all, ME)).toBe(
      "Bob, Carol, Dan, Eve, Faye and 2 others reacted with 👍",
    );
  });

  it("handles 'You' counting against the truncation budget", () => {
    // 6 humans total including me — fits without truncation.
    const ids = [ME, 99, 100, 101, 102, 103];
    const all = [
      ...members,
      member({ human_id: 100, display_name: "Carol" }),
      member({ human_id: 101, display_name: "Dan" }),
      member({ human_id: 102, display_name: "Eve" }),
      member({ human_id: 103, display_name: "Faye" }),
    ];
    const r = reaction({ count: 6, human_ids: ids });
    expect(formatReactors(r, all, ME)).toBe(
      "You, Bob, Carol, Dan, Eve and Faye reacted with 👍",
    );
  });

  it("agent-only reaction renders the agent name correctly", () => {
    const r = reaction({ count: 1, agent_ids: ["PartyLava"] });
    expect(formatReactors(r, members, ME)).toBe("PartyLava reacted with 👍");
  });

  it("'You' alone renders without 'and'", () => {
    const r = reaction({ count: 1, human_ids: [ME] });
    expect(formatReactors(r, members, ME)).toBe("You reacted with 👍");
  });
});
