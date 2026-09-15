import { describe, expect, test } from "bun:test";
import { filterChannelsByTab, glyphKind, previewText } from "./chatFilters";
import type { Channel } from "./models";

const channel = (
  overrides: Partial<Channel> & Pick<Channel, "channel_id" | "channel_type">,
): Channel => ({
  org_id: "org",
  name: overrides.channel_id,
  display_name: null,
  dm_peer: null,
  dm_peer_agent_id: null,
  avatar: null,
  last_message_at: null,
  last_message_text: null,
  last_message_attachment_count: 0,
  unread_count: 0,
  ...overrides,
});

const pub = channel({ channel_id: "pub", channel_type: "public" });
const priv = channel({ channel_id: "priv", channel_type: "private" });
const dm = channel({ channel_id: "dm", channel_type: "direct" });
const agent = channel({
  channel_id: "agent",
  channel_type: "direct",
  dm_peer_agent_id: "atlas",
});

describe("filterChannelsByTab", () => {
  const all = [pub, priv, dm, agent];

  test("all keeps every conversation", () => {
    expect(filterChannelsByTab(all, "all")).toEqual(all);
  });

  test("channels keeps public and private rooms", () => {
    expect(filterChannelsByTab(all, "channels")).toEqual([pub, priv]);
  });

  test("dms keeps human and agent directs", () => {
    expect(filterChannelsByTab(all, "dms")).toEqual([dm, agent]);
  });

  test("agents keeps only agent directs", () => {
    expect(filterChannelsByTab(all, "agents")).toEqual([agent]);
  });
});

describe("previewText", () => {
  test("prefixes own direct messages with You", () => {
    expect(
      previewText(
        channel({
          channel_id: "dm",
          channel_type: "direct",
          last_message_text: "hey",
          last_message_author_human_id: 7,
        }),
        7,
      ),
    ).toBe("You: hey");
  });

  test("prefixes channel messages with the author first name", () => {
    expect(
      previewText(
        channel({
          channel_id: "pub",
          channel_type: "public",
          last_message_text: "shipped",
          last_message_author_display_name: "Kai Chen",
        }),
        1,
      ),
    ).toBe("Kai: shipped");
  });
});

describe("glyphKind", () => {
  test("rooms are channel tiles", () => {
    expect(glyphKind(pub)).toBe("channel");
    expect(glyphKind(priv)).toBe("channel");
  });

  test("directs pick human vs agent", () => {
    expect(glyphKind(dm)).toBe("human");
    expect(glyphKind(agent)).toBe("agent");
  });
});
