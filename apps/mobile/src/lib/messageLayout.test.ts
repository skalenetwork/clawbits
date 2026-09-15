import { describe, expect, test } from "bun:test";
import {
  backUnreadTitle,
  inboxUnread,
  samePerson,
  showStamp,
  stampLabel,
} from "./messageLayout";
import type { Post } from "./models";

const now = new Date(2026, 8, 15, 16, 0, 0);

const post = (created: Date, extra: Partial<Post> = {}): Post => ({
  post_id: 1,
  channel_id: "chat",
  human_id: 1,
  agent_id: null,
  poster_display_name: "Alex",
  message: "hi",
  status: "published",
  created_at: created.toISOString(),
  updated_at: created.toISOString(),
  files: [],
  ...extra,
});

describe("stampLabel", () => {
  test("today and yesterday prefixes", () => {
    expect(stampLabel(new Date(2026, 8, 15, 13, 47).toISOString(), now)).toMatch(
      /^Today /,
    );
    expect(stampLabel(new Date(2026, 8, 14, 10, 0).toISOString(), now)).toMatch(
      /^Yesterday /,
    );
  });

  test("weekday for the last few days", () => {
    const label = stampLabel(new Date(2026, 8, 12, 10, 0).toISOString(), now);
    expect(label.startsWith("Today") || label.startsWith("Yesterday")).toBe(
      false,
    );
    expect(label).toMatch(/^\w+ /);
  });
});

describe("showStamp", () => {
  test("first message always stamps", () => {
    expect(showStamp(post(now))).toBe(true);
  });

  test("short gaps stay grouped, hour+ or a new day stamp", () => {
    const first = post(new Date(2026, 8, 15, 12, 0));
    expect(showStamp(post(new Date(2026, 8, 15, 12, 20)), first)).toBe(false);
    expect(showStamp(post(new Date(2026, 8, 15, 13, 5)), first)).toBe(true);
    expect(showStamp(post(new Date(2026, 8, 16, 9, 0)), first)).toBe(true);
  });
});

describe("samePerson", () => {
  test("human vs agent are distinct even with empty ids", () => {
    const human = post(now, { human_id: 1, agent_id: null });
    const agent = post(now, { human_id: null, agent_id: "atlas" });
    expect(samePerson(human, { ...human, post_id: 2 })).toBe(true);
    expect(samePerson(human, agent)).toBe(false);
  });
});

describe("inboxUnread", () => {
  test("sums counts and formats the back title", () => {
    expect(inboxUnread([{ unread_count: 3 }, { unread_count: 0 }])).toBe(3);
    expect(backUnreadTitle(0)).toBeUndefined();
    expect(backUnreadTitle(12)).toBe("12");
    expect(backUnreadTitle(196)).toBe("196");
  });
});
