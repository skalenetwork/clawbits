import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  THINKING_TAIL_MAX_CHARS,
  TOOL_SUMMARY_MAX_CHARS,
  sanitizeThinkingTail,
  sanitizeToolSummary,
} from "../src/activity/sanitize.js";

describe("sanitizeToolSummary", () => {
  it("prefers the allowlisted primary field", () => {
    assert.equal(
      sanitizeToolSummary("web_search", { query: "skale gas price", limit: 5 }),
      "web_search: 'skale gas price'",
    );
    assert.equal(
      sanitizeToolSummary("exec", { command: "ls -la /tmp" }),
      "exec: 'ls -la /tmp'",
    );
  });

  it("CANARY: secrets under secret-shaped keys never appear in the summary", () => {
    const canary = "sk-canary-8f3kq09zj4x7p2m5v1c6b8n0";
    const out = sanitizeToolSummary("http_request", {
      api_key: canary,
      authorization: `Bearer ${canary}`,
      Cookie: canary,
      refresh_token: canary,
      url: "https://example.com/data",
    });
    assert.ok(!out.includes(canary), `summary leaked the canary: ${out}`);
    assert.equal(out, "http_request: 'https://example.com/data'");
  });

  it("CANARY: opaque credential-shaped values are dropped even under innocent keys", () => {
    // Deliberately not shaped like any real provider's key prefix: secret
    // scanners flagged the previous AKIA-prefixed fixture. Still 24+ opaque
    // chars, which is all SECRET_VALUE_RE keys on.
    const canary = "EXAMPLEFAKECREDENTIALFORTESTS0000";
    const out = sanitizeToolSummary("mystery", { note: canary });
    assert.ok(!out.includes(canary), `summary leaked the canary: ${out}`);
    assert.equal(out, "mystery");
  });

  it("falls back to the tool name when nothing safe survives", () => {
    assert.equal(sanitizeToolSummary("read_file", {}), "read_file");
    assert.equal(sanitizeToolSummary("read_file", null), "read_file");
    assert.equal(sanitizeToolSummary("read_file", 42), "read_file");
    assert.equal(sanitizeToolSummary("", {}), "tool");
  });

  it("does not descend into nested objects", () => {
    const out = sanitizeToolSummary("deep", {
      config: { url: "https://inner.example.com" },
    });
    assert.equal(out, "deep");
  });

  it("truncates at the cap and collapses whitespace", () => {
    const long = `do  the\nthing ${"x".repeat(TOOL_SUMMARY_MAX_CHARS * 2)}`;
    const out = sanitizeToolSummary("exec", { command: long });
    const snippet = out.slice("exec: '".length, -1);
    assert.ok(
      snippet.length <= TOOL_SUMMARY_MAX_CHARS,
      `snippet too long: ${snippet.length}`,
    );
    assert.ok(snippet.startsWith("do the thing x"));
    assert.ok(snippet.endsWith("…"));
  });

  // The cap exists to bound the ~1/s status lane, but it must be wide enough
  // that a routine command survives whole - at the old 80 it cut mid-flag.
  it("keeps a realistic long command intact", () => {
    const cmd =
      "find /home/node/.openclaw/workspace/skills/agentpit-reference -maxdepth 2 -type f";
    assert.ok(cmd.length > 80, "fixture must exceed the OLD cap to be meaningful");
    assert.equal(sanitizeToolSummary("exec", { command: cmd }), `exec: '${cmd}'`);
  });

  it("accepts a bare string arg", () => {
    assert.equal(sanitizeToolSummary("say", "hello world"), "say: 'hello world'");
  });
});

describe("sanitizeThinkingTail", () => {
  it("keeps short text intact, flattening markdown", () => {
    assert.equal(
      sanitizeThinkingTail("I should *check* the `config` first"),
      "I should check the config first",
    );
  });

  it("drops fenced code blocks wholesale (they can carry file contents)", () => {
    const secret = "SECRET_CONTENTS_OF_ENV_FILE";
    const out = sanitizeThinkingTail(`Let me look\n\`\`\`\n${secret}\n\`\`\`\nDone reading`);
    assert.ok(!out.includes(secret));
    assert.equal(out, "Let me look Done reading");
  });

  it("tails long text to the cap starting at a word boundary", () => {
    const text = `${"start ".repeat(THINKING_TAIL_MAX_CHARS)}the interesting recent part`;
    const out = sanitizeThinkingTail(text);
    assert.ok(
      out.length <= THINKING_TAIL_MAX_CHARS,
      `tail too long: ${out.length}`,
    );
    assert.ok(out.startsWith("…"));
    assert.ok(out.endsWith("the interesting recent part"));
  });

  it("returns empty for non-strings", () => {
    assert.equal(sanitizeThinkingTail(undefined), "");
    assert.equal(sanitizeThinkingTail({ delta: "x" }), "");
  });
});
