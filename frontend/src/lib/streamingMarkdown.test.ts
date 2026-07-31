import { describe, expect, it } from "vitest";

import {
  classifyTail,
  hardenIncompleteMarkdown,
  parseOpenFence,
  splitStreamBlocks,
} from "./streamingMarkdown";

describe("splitStreamBlocks", () => {
  it("splits on blank lines", () => {
    expect(splitStreamBlocks("a\n\nb")).toEqual(["a", "b"]);
  });

  it("keeps a fenced code block whole despite interior blank lines", () => {
    const src = "intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```";
    expect(splitStreamBlocks(src)).toEqual([
      "intro",
      "```ts\nconst a = 1;\n\nconst b = 2;\n```",
    ]);
  });

  it("treats an unterminated fence as the single trailing block", () => {
    const blocks = splitStreamBlocks("before\n\n```py\nprint(1)");
    expect(blocks[blocks.length - 1]).toBe("```py\nprint(1)");
  });

  it("returns the whole source when there are no block boundaries", () => {
    expect(splitStreamBlocks("just one line forming")).toEqual([
      "just one line forming",
    ]);
  });
});

describe("classifyTail", () => {
  it("detects an open code fence", () => {
    expect(classifyTail("```ts\nconst a")).toBe("code");
  });

  it("detects structured blocks (list / heading / table / quote / ordered)", () => {
    expect(classifyTail("- one\n- two")).toBe("structured");
    expect(classifyTail("## Title")).toBe("structured");
    expect(classifyTail("| a | b |")).toBe("structured");
    expect(classifyTail("> quote")).toBe("structured");
    expect(classifyTail("1. first")).toBe("structured");
  });

  it("treats a plain sentence as prose (the per-word-blur path)", () => {
    expect(classifyTail("Just a sentence forming right now")).toBe("prose");
  });
});

describe("parseOpenFence", () => {
  it("extracts language + body from an open fence", () => {
    expect(parseOpenFence("```ts\nconst a = 1;")).toEqual({
      lang: "ts",
      code: "const a = 1;",
    });
  });

  it("returns a null language when none is given", () => {
    expect(parseOpenFence("```\nplain")).toEqual({ lang: null, code: "plain" });
  });

  it("drops a trailing closing fence not yet pushed above the tail", () => {
    expect(parseOpenFence("```js\nx()\n```")).toEqual({ lang: "js", code: "x()" });
  });
});

describe("hardenIncompleteMarkdown", () => {
  it("closes an unterminated fence so it doesn't swallow the tail", () => {
    expect(hardenIncompleteMarkdown("```ts\ncode")).toBe("```ts\ncode\n```");
  });

  it("leaves a balanced fence untouched", () => {
    const balanced = "```ts\ncode\n```";
    expect(hardenIncompleteMarkdown(balanced)).toBe(balanced);
  });

  it("leaves partial inline emphasis alone (self-heals on settle)", () => {
    expect(hardenIncompleteMarkdown("hello **world")).toBe("hello **world");
  });
});
