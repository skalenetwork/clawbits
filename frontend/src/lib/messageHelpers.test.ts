import { describe, expect, it } from "vitest";

import type { PostUi } from "./api";
import { attachmentOnlyLabel, messageLink, quotedBodyText, quotedMessage } from "./messageHelpers";

describe("attachmentOnlyLabel", () => {
  it("returns null when there are no attachments", () => {
    expect(attachmentOnlyLabel(0)).toBeNull();
    expect(attachmentOnlyLabel(-1)).toBeNull();
  });

  it("matches the channel-list wording", () => {
    expect(attachmentOnlyLabel(1)).toBe("Attachment");
    expect(attachmentOnlyLabel(3)).toBe("3 attachments");
  });
});

describe("quotedBodyText", () => {
  it("prefers the message text", () => {
    expect(quotedBodyText("hello", 2)).toBe("hello");
  });

  it("labels an attachment-only body instead of showing it as empty", () => {
    expect(quotedBodyText("", 1)).toBe("Attachment");
    expect(quotedBodyText("   ", 2)).toBe("2 attachments");
  });

  it("falls back to the placeholder only when there is truly nothing", () => {
    expect(quotedBodyText("", 0)).toBe("(empty message)");
  });
});

describe("quotedMessage", () => {
  it("quotes a message whole and a card by its heading", () => {
    expect(quotedMessage({ message: "one\ntwo" })).toBe("one\ntwo");
    const ui: PostUi = { a2ui: { version: "1.0", createSurface: { surfaceId: "post-1", catalogId: "", components: [], dataModel: {} } }, rev: 0, once: true, closed: null };
    expect(quotedMessage({ message: "\n**Book a table**\nDate\nBook table", ui })).toBe("**Book a table**");
  });
});

describe("messageLink", () => {
  it("points at the channel with the post as the ?msg anchor", () => {
    expect(messageLink("c-1", 42)).toBe(`${window.location.origin}/channels/c-1?msg=42`);
  });
});
