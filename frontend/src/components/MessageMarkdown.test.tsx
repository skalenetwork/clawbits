import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { MentionsContext, type MessageMentions } from "@/components/mentionsContext";
import type { MmChannelMember } from "@/lib/api";
import { MessageMarkdown, PlainMarkdown } from "./MessageMarkdown";

const alice = { human_id: 1, agent_id: null, display_name: "Alice" } as MmChannelMember;
const mentions: MessageMentions = {
  memberByToken: new Map([["alice", alice]]),
  channelsByToken: new Map(),
  currentUserChannelIds: new Set(),
};

describe("MessageMarkdown", () => {
  it("resolves mentions in prose but never inside code", () => {
    const { container } = render(
      <MentionsContext value={mentions}>
        <MessageMarkdown content={"hi @alice `@alice`\n\n- in a list `@alice`\n\n> quoted `@alice`"} />
      </MentionsContext>,
    );
    expect(container.querySelectorAll('[aria-label^="Open profile menu"]')).toHaveLength(1);
    const codes = [...container.querySelectorAll("code")];
    expect(codes).toHaveLength(3);
    for (const code of codes) expect(code.textContent).toBe("@alice");
  });
});

describe("PlainMarkdown", () => {
  it("keeps only the text, with blocks and lines apart", () => {
    const { container } = render(
      <PlainMarkdown content={"**Summary**: deploy `api` to [staging](https://x.io) ~~now~~\n\n- one\n- two\nthree ![chart](https://x.io/c.png) <b>x</b>"} />,
    );
    expect(container.children).toHaveLength(0);
    expect(container.textContent?.replace(/\s+/g, " ").trim()).toBe("Summary: deploy api to staging now one two three x");
  });
});
