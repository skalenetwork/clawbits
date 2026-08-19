import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  THINKING_TAIL_MAX_CHARS,
  TOOL_SUMMARY_MAX_CHARS,
  sanitizeThinkingTail,
  sanitizeToolDetail,
  sanitizeToolResultDescriptor,
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

  it("never shows an unclassified Codex web_search action as the query", () => {
    // OpenClaw's Codex projector shape for a search whose action the app-server
    // could not classify. `other` is the enum's junk drawer, not a query.
    assert.equal(
      sanitizeToolSummary("web_search", { action: "other", queryUnavailable: true }),
      "web_search",
    );
    // Same guard without the marker — older projectors may omit it.
    assert.equal(sanitizeToolSummary("web_search", { action: "other" }), "web_search");
    // ...and the marker alone suppresses whatever bookkeeping rides along.
    assert.equal(
      sanitizeToolSummary("web_search", { queryUnavailable: true, status: "completed" }),
      "web_search",
    );
  });

  it("qualifies the primary arg with the action that produced it", () => {
    assert.equal(
      sanitizeToolSummary("web_search", { action: "open_page", url: "https://example.com/a" }),
      "web_search: open_page 'https://example.com/a'",
    );
    assert.equal(
      sanitizeToolSummary("browser", { action: "click", text: "Sign in" }),
      "browser: click 'Sign in'",
    );
    // A real search carries no action field — unchanged single-quoted form.
    assert.equal(
      sanitizeToolSummary("web_search", { query: "skale gas price", queries: ["skale gas price"] }),
      "web_search: 'skale gas price'",
    );
    // The action still stands alone when it is all there is.
    assert.equal(sanitizeToolSummary("browser", { action: "screenshot" }), "browser: 'screenshot'");
  });

  it("ignores an action that is not an enum-shaped token", () => {
    assert.equal(
      sanitizeToolSummary("agent", { action: "go and do the thing", url: "https://example.com" }),
      "agent: 'https://example.com'",
    );
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

describe("sanitizeToolDetail", () => {
  it("reports the query a Codex web_search only reveals on completion", () => {
    // OpenClaw formats the completed item's query into `meta`; the start event
    // for the same call carried nothing but `action: "other"`.
    assert.equal(
      sanitizeToolDetail("web_search", '"skale gas price"'),
      "web_search: 'skale gas price'",
    );
    // Multi-query and unquoted details pass through in OpenClaw's own form.
    assert.equal(
      sanitizeToolDetail("web_search", '"skale gas price", "skale rpc"'),
      'web_search: "skale gas price", "skale rpc"',
    );
  });

  it("CANARY: a credential-shaped detail never becomes a label", () => {
    const canary = "EXAMPLEFAKECREDENTIALFORTESTS0000";
    assert.equal(sanitizeToolDetail("mystery", canary), undefined);
  });

  it("is absent when the harness reports no detail", () => {
    assert.equal(sanitizeToolDetail("web_search", undefined), undefined);
    assert.equal(sanitizeToolDetail("web_search", ""), undefined);
    assert.equal(sanitizeToolDetail("web_search", "   "), undefined);
    assert.equal(sanitizeToolDetail("web_search", 42), undefined);
    assert.equal(sanitizeToolDetail("web_search", "web_search"), undefined);
  });

  it("clamps at the same cap as an argument summary", () => {
    const out = sanitizeToolDetail("web_search", `"${"x".repeat(TOOL_SUMMARY_MAX_CHARS * 2)}"`);
    assert.ok(out);
    assert.ok(out.length <= "web_search: ''".length + TOOL_SUMMARY_MAX_CHARS);
    assert.ok(out.endsWith("…'"));
  });
});

describe("sanitizeToolResultDescriptor", () => {
  it("reports the page a Codex web_search opened", () => {
    // OpenClaw's completed-item shape for an `openPage` action. `meta` has no
    // formatter for URLs, so this payload is the only report of it.
    assert.equal(
      sanitizeToolResultDescriptor("web_search", {
        status: "completed",
        durationMs: 812,
        action: "openPage",
        url: "https://example.com/docs",
      }),
      "web_search: openPage 'https://example.com/docs'",
    );
    assert.equal(
      sanitizeToolResultDescriptor("web_search", {
        status: "completed",
        query: "skale gas price",
      }),
      "web_search: 'skale gas price'",
    );
  });

  it("CANARY: reads descriptors only — never a tool's output", () => {
    const canary = "PAGE BODY THAT MUST NOT LEAVE THE VM";
    const out = sanitizeToolResultDescriptor("web_search", {
      status: "completed",
      url: "https://example.com",
      content: canary,
      text: canary,
      output: canary,
      body: canary,
      results: [{ title: canary, url: "https://leak.example.com", snippet: canary }],
    });
    assert.ok(!out?.includes(canary), `descriptor leaked output: ${out ?? ""}`);
    assert.ok(!out?.includes("leak.example.com"), `descriptor leaked a hit URL: ${out ?? ""}`);
    assert.equal(out, "web_search: 'https://example.com'");
  });

  it("is absent when the result describes no call", () => {
    assert.equal(
      sanitizeToolResultDescriptor("exec", { status: "completed", exitCode: 0, durationMs: 4 }),
      undefined,
    );
    assert.equal(sanitizeToolResultDescriptor("web_search", { action: "other" }), undefined);
    assert.equal(sanitizeToolResultDescriptor("web_search", null), undefined);
    assert.equal(sanitizeToolResultDescriptor("web_search", "done"), undefined);
    assert.equal(sanitizeToolResultDescriptor("web_search", []), undefined);
  });

  it("CANARY: descriptor values still go through secret redaction", () => {
    const canary = "EXAMPLEFAKECREDENTIALFORTESTS0000";
    assert.equal(sanitizeToolResultDescriptor("fetch", { query: canary }), undefined);
  });
});
