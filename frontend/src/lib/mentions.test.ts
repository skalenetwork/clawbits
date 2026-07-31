import { describe, expect, it } from "vitest";

import {
  HERE_TOKEN,
  isHereToken,
  messageMentionsViewer,
  selfMentionTokens,
} from "./mentions";

describe("selfMentionTokens", () => {
  it("returns an empty set when there is no user", () => {
    expect(selfMentionTokens(null).size).toBe(0);
    expect(selfMentionTokens(undefined).size).toBe(0);
    expect(selfMentionTokens({ id: undefined } as never).size).toBe(0);
  });

  it("emits the user-id, stripped display name, and canonical handle", () => {
    const tokens = selfMentionTokens({ id: 7, display_name: "Stan Lee" });
    expect([...tokens].sort()).toEqual(["stan-lee", "stanlee", "user-7"]);
  });

  it("falls back to just the user-id when no display name", () => {
    expect([...selfMentionTokens({ id: 3 })]).toEqual(["user-3"]);
  });
});

describe("messageMentionsViewer", () => {
  const tokens = selfMentionTokens({ id: 7, display_name: "Stan Lee" });

  it("matches @here regardless of the viewer's tokens", () => {
    expect(messageMentionsViewer("@here standup", new Set())).toBe(true);
    expect(messageMentionsViewer("hey @here!", tokens)).toBe(true);
  });

  it("respects the token boundary (@herring is not @here)", () => {
    expect(messageMentionsViewer("ping @herring now", tokens)).toBe(false);
    expect(messageMentionsViewer("mail bob@here.com", tokens)).toBe(false);
  });

  it("matches every spelling of the viewer's handle", () => {
    expect(messageMentionsViewer("yo @Stan-Lee", tokens)).toBe(true);
    expect(messageMentionsViewer("yo @stanlee", tokens)).toBe(true);
    expect(messageMentionsViewer("@user-7 there", tokens)).toBe(true);
  });

  it("does not match a longer handle or an unrelated user-id", () => {
    expect(messageMentionsViewer("@StanLeexx hi", tokens)).toBe(false);
    expect(messageMentionsViewer("@user-70 hi", tokens)).toBe(false);
  });

  it("ignores plain text and messages without @", () => {
    expect(messageMentionsViewer("here we go, stanlee", tokens)).toBe(false);
    expect(messageMentionsViewer("", tokens)).toBe(false);
  });
});

describe("isHereToken", () => {
  it("recognises the bare here token", () => {
    expect(isHereToken(HERE_TOKEN)).toBe(true);
    expect(isHereToken("here")).toBe(true);
    expect(isHereToken("there")).toBe(false);
  });
});
