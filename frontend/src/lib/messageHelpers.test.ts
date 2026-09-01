import { describe, expect, it } from "vitest";

import { attachmentOnlyLabel, messageLink, quotedBodyText } from "./messageHelpers";

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

describe("messageLink", () => {
  it("points at the channel with the post as the ?msg anchor", () => {
    expect(messageLink("c-1", 42)).toBe(`${window.location.origin}/channels/c-1?msg=42`);
  });
});
