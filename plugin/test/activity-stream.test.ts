import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { ClawBitsClient } from "../src/client.js";
import { ClawBitsError } from "../src/errors.js";
import {
  __resetTurnRegistryForTest,
  registerInFlightTurn,
  type InFlightTurn,
} from "../src/activity/turn-registry.js";
import {
  __streamPatcherInflightForTest,
  finishStreaming,
  onAssistantEvent,
} from "../src/activity/stream-patcher.js";
import {
  __reporterInflightForTest,
  __resetActivityReporterForTest,
  finishReporting,
  lastActivity,
  onCommandOutputEvent,
  onItemEvent,
  onThinkingEvent,
  onToolEvent,
  turnSteps,
} from "../src/activity/reporter.js";
import { registerMcpApps } from "../src/activity/mcp-apps.js";
import { __setGatewayCall } from "openclaw/plugin-sdk/gateway-runtime";
import { routeAgentEvent } from "../src/activity/subscription.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RecordedCall {
  method: string;
  path: string;
  json: Record<string, unknown>;
}

class FakeClient {
  calls: RecordedCall[] = [];
  failWith: Error | null = null;

  encodePath(value: string): string {
    return encodeURIComponent(value);
  }

  async request(
    method: string,
    path: string,
    opts?: { json?: unknown },
  ): Promise<unknown> {
    if (this.failWith) throw this.failWith;
    this.calls.push({
      method,
      path,
      json: (opts?.json ?? {}) as Record<string, unknown>,
    });
    return { post_id: 7, channel_id: "chan-1", message: "", status: "streaming" };
  }
}

function makeTurn(
  client: FakeClient,
  overrides: Partial<Pick<InFlightTurn, "streaming" | "liveActivity">> = {},
  noDraft = false,
): InFlightTurn {
  return registerInFlightTurn({
    accountId: "default",
    channelId: "chan-1",
    draftRef: { id: noDraft ? undefined : 7 },
    client: client as unknown as ClawBitsClient,
    channelKeyedSession: true,
    streaming: overrides.streaming ?? true,
    liveActivity: overrides.liveActivity ?? true,
  });
}

describe("stream patcher (text lane)", () => {
  beforeEach(() => {
    __resetTurnRegistryForTest();
  });

  it("flushes immediately once enough text accumulated, appending in order", async () => {
    const client = new FakeClient();
    const turn = makeTurn(client);
    const big = "a".repeat(130);
    onAssistantEvent(turn, { text: big, delta: big });
    await __streamPatcherInflightForTest(turn);
    assert.equal(client.calls.length, 1);
    assert.deepEqual(client.calls[0]!.json, { append: big });
    // Growth below the size threshold flushes on the idle timer.
    onAssistantEvent(turn, { text: `${big} tail`, delta: " tail" });
    await sleep(250);
    await __streamPatcherInflightForTest(turn);
    assert.equal(client.calls.length, 2);
    assert.deepEqual(client.calls[1]!.json, { append: " tail" });
  });

  it("accumulates deltas when the event carries no cumulative text", async () => {
    const client = new FakeClient();
    const turn = makeTurn(client);
    onAssistantEvent(turn, { delta: "one " });
    onAssistantEvent(turn, { delta: "two" });
    await sleep(250);
    await __streamPatcherInflightForTest(turn);
    assert.equal(client.calls.length, 1);
    assert.deepEqual(client.calls[0]!.json, { append: "one two" });
  });

  it("turns a rewrite of already-sent text into a wire replace", async () => {
    const client = new FakeClient();
    const turn = makeTurn(client);
    const first = "b".repeat(130);
    onAssistantEvent(turn, { text: first, delta: first });
    await __streamPatcherInflightForTest(turn);
    // The runner rewrote visible text (replace: true, different prefix).
    onAssistantEvent(turn, { text: "rewritten!", replace: true });
    await __streamPatcherInflightForTest(turn);
    assert.equal(client.calls.length, 2);
    assert.deepEqual(client.calls[1]!.json, { replace: "rewritten!" });
  });

  it("stops silently on a PATCH failure (finalize race) and stays stopped", async () => {
    const client = new FakeClient();
    const turn = makeTurn(client);
    client.failWith = new ClawBitsError({
      statusCode: 409,
      detail: "not streaming",
      path: "/",
    });
    const big = "c".repeat(130);
    onAssistantEvent(turn, { text: big, delta: big });
    await __streamPatcherInflightForTest(turn);
    assert.equal(client.calls.length, 0);
    client.failWith = null;
    onAssistantEvent(turn, { text: `${big}${big}`, delta: big });
    await sleep(250);
    await __streamPatcherInflightForTest(turn);
    assert.equal(client.calls.length, 0, "lane must stay stopped after an error");
  });

  it("no-ops without an open draft or when streaming is disabled", async () => {
    const client = new FakeClient();
    const noDraft = makeTurn(client, {}, true);
    onAssistantEvent(noDraft, { text: "d".repeat(200), delta: "d".repeat(200) });
    await __streamPatcherInflightForTest(noDraft);
    const off = makeTurn(client, { streaming: false });
    onAssistantEvent(off, { text: "e".repeat(200), delta: "e".repeat(200) });
    await __streamPatcherInflightForTest(off);
    assert.equal(client.calls.length, 0);
  });

  it("finishStreaming drops pending unsent text", async () => {
    const client = new FakeClient();
    const turn = makeTurn(client);
    onAssistantEvent(turn, { delta: "pending tail" });
    finishStreaming(turn);
    await sleep(250);
    await __streamPatcherInflightForTest(turn);
    assert.equal(client.calls.length, 0);
  });
});

describe("activity reporter (status lane)", () => {
  beforeEach(() => {
    __resetTurnRegistryForTest();
    __resetActivityReporterForTest();
  });

  it("reports tool start and done with duration + ok flag", async () => {
    const client = new FakeClient();
    const turn = makeTurn(client);
    onToolEvent(turn, {
      phase: "start",
      name: "web_search",
      toolCallId: "t1",
      args: { query: "skale gas price" },
    });
    await sleep(20);
    onToolEvent(turn, { phase: "result", name: "web_search", toolCallId: "t1", isError: false });
    await __reporterInflightForTest(turn);
    assert.equal(client.calls.length, 2);
    const [start, done] = client.calls;
    assert.ok(start!.path.endsWith("/status"));
    assert.deepEqual(start!.json.status, "generating");
    const startActivity = start!.json.activity as Record<string, unknown>;
    assert.equal(startActivity.kind, "tool");
    assert.equal(startActivity.tool, "web_search");
    assert.equal(startActivity.label, "web_search: 'skale gas price'");
    const doneActivity = done!.json.activity as Record<string, unknown>;
    assert.equal(doneActivity.kind, "tool_done");
    assert.equal(doneActivity.ok, true);
    assert.ok(typeof doneActivity.duration_ms === "number");
    assert.ok((doneActivity.duration_ms as number) >= 10);
  });

  it("keys a tool's start and end by the engine's call id and keeps the step for the reply post", async () => {
    const client = new FakeClient();
    const turn = makeTurn(client);
    onToolEvent(turn, { phase: "start", name: "exec", toolCallId: "c1", args: { command: "gh issue list" } });
    onToolEvent(turn, { phase: "start", name: "exec", toolCallId: "c2", args: { command: "gh pr list" } });
    onToolEvent(turn, { phase: "result", name: "exec", toolCallId: "c1", isError: false });
    onCommandOutputEvent(turn, { phase: "end", status: "failed", toolCallId: "c1", exitCode: 1 });
    await __reporterInflightForTest(turn);
    const activities = client.calls.map((c) => c.json.activity as Record<string, unknown>);
    assert.deepEqual(
      activities.map(({ kind, id, ok }) => ({ kind, id, ok })),
      [
        { kind: "tool", id: "c1", ok: undefined },
        { kind: "tool", id: "c2", ok: undefined },
        { kind: "tool_done", id: "c1", ok: true },
        { kind: "tool_done", id: "c1", ok: false },
      ],
    );
    assert.deepEqual(
      (await turnSteps(turn))?.map(({ id, ok }) => ({ id, ok })),
      [
        { id: "c1", ok: false },
        { id: "c2", ok: undefined },
      ],
    );
    assert.equal(lastActivity(turn)?.ok, false);
  });

  it("fails the step a tool search dispatched when its exec exits nonzero, even before the step's own result", async () => {
    const turn = makeTurn(new FakeClient());
    onToolEvent(turn, { phase: "start", name: "tool_call", toolCallId: "w1", args: { id: "openclaw:core:exec", args: { command: "false" } } });
    const nested = { name: "exec", toolCallId: "tool_search_code:w1:exec:1", parentToolCallId: "w1" };
    onToolEvent(turn, { ...nested, phase: "start" });
    onToolEvent(turn, { ...nested, phase: "result" });
    onCommandOutputEvent(turn, { phase: "end", status: "failed", toolCallId: nested.toolCallId, exitCode: 1 });
    onToolEvent(turn, { phase: "result", name: "tool_call", toolCallId: "w1" });
    await __reporterInflightForTest(turn);
    assert.deepEqual((await turnSteps(turn))?.map(({ id, tool, ok }) => ({ id, tool, ok })), [{ id: "w1", tool: "exec", ok: false }]);
  });

  it("keeps the turn's steps after a failed send stops the live lane", async () => {
    const client = new FakeClient();
    const turn = makeTurn(client);
    client.failWith = new Error("502 Bad Gateway");
    onToolEvent(turn, { phase: "start", name: "exec", toolCallId: "c1", args: { command: "ls" } });
    await __reporterInflightForTest(turn);
    client.failWith = null;
    onToolEvent(turn, { phase: "result", name: "exec", toolCallId: "c1" });
    onItemEvent(turn, { kind: "preamble", itemId: "msg_1", progressText: "Now the tests." });
    await __reporterInflightForTest(turn);
    assert.equal(client.calls.length, 0);
    assert.equal(lastActivity(turn), undefined);
    assert.deepEqual((await turnSteps(turn))?.map(({ id, ok }) => ({ id, ok })), [
      { id: "c1", ok: true },
      { id: "msg_1", ok: undefined },
    ]);
  });

  it("carries the agent's narration as a note, kept for the post, while thinking is never kept", async () => {
    const client = new FakeClient();
    const turn = makeTurn(client);
    onThinkingEvent(turn, { text: "Let me reason about the request privately." });
    await sleep(1_050);
    onItemEvent(turn, { kind: "preamble", itemId: "msg_1", progressText: "Checking the open issues first." });
    await __reporterInflightForTest(turn);
    const activities = client.calls.map((c) => c.json.activity as Record<string, unknown>);
    assert.deepEqual(activities.at(-1), { kind: "note", id: "msg_1", label: "Checking the open issues first." });
    assert.deepEqual(await turnSteps(turn), [{ kind: "note", id: "msg_1", label: "Checking the open issues first." }]);
  });

  it("shows a searched tool's call once, named for the tool it ran", async () => {
    const client = new FakeClient();
    const turn = makeTurn(client);
    onToolEvent(turn, {
      phase: "start",
      name: "tool_call",
      toolCallId: "w1",
      args: { id: "openclaw:clawbits-tools:clawbits_mcp_connect", args: { server: "linear" } },
    });
    const nested = { name: "clawbits_mcp_connect", toolCallId: "tool_search_code:w1:clawbits_mcp_connect:1", parentToolCallId: "w1" };
    onToolEvent(turn, { ...nested, phase: "start", args: { server: "linear" } });
    onToolEvent(turn, { ...nested, phase: "result", isError: true });
    onToolEvent(turn, { phase: "result", name: "tool_call", toolCallId: "w1", isError: true });
    await __reporterInflightForTest(turn);
    const activities = client.calls.map((c) => c.json.activity as Record<string, unknown>);
    assert.deepEqual(
      activities.map(({ kind, tool, ok }) => ({ kind, tool, ok })),
      [
        { kind: "tool", tool: "clawbits_mcp_connect", ok: undefined },
        { kind: "tool_done", tool: "clawbits_mcp_connect", ok: false },
      ],
    );
    assert.equal(activities[0]?.label, "clawbits_mcp_connect: 'linear'");
  });

  it("leaves out tools the host hides from channel progress", async () => {
    const client = new FakeClient();
    const turn = makeTurn(client);
    onToolEvent(turn, { phase: "start", name: "message", toolCallId: "m1", hideFromChannelProgress: true });
    onToolEvent(turn, { phase: "result", name: "message", toolCallId: "m1", hideFromChannelProgress: true });
    await __reporterInflightForTest(turn);
    assert.equal(client.calls.length, 0);
  });

  it("carries the Codex web_search query, which only lands on completion", async () => {
    const client = new FakeClient();
    const turn = makeTurn(client);
    // The app-server's `item/started` shape: no query yet, just the enum.
    onToolEvent(turn, {
      phase: "start",
      name: "web_search",
      toolCallId: "t1",
      args: { action: "other", queryUnavailable: true },
    });
    onToolEvent(turn, {
      phase: "result",
      name: "web_search",
      toolCallId: "t1",
      isError: false,
      meta: '"skale gas price"',
    });
    await __reporterInflightForTest(turn);
    const [start, done] = client.calls;
    // Never "web_search: 'other'" — the enum is not a query.
    assert.equal((start!.json.activity as Record<string, unknown>).label, "web_search");
    assert.equal(
      (done!.json.activity as Record<string, unknown>).label,
      "web_search: 'skale gas price'",
    );
  });

  it("carries the URL a Codex web_search opened, known only at completion", async () => {
    const client = new FakeClient();
    const turn = makeTurn(client);
    onToolEvent(turn, {
      phase: "start",
      name: "web_search",
      toolCallId: "t2",
      args: { action: "other", queryUnavailable: true },
    });
    onToolEvent(turn, {
      phase: "result",
      name: "web_search",
      toolCallId: "t2",
      isError: false,
      // No `meta`: OpenClaw's detail formatter covers queries, not URLs.
      result: { status: "completed", action: "openPage", url: "https://example.com/docs" },
    });
    await __reporterInflightForTest(turn);
    const [, done] = client.calls;
    assert.equal(
      (done!.json.activity as Record<string, unknown>).label,
      "web_search: openPage 'https://example.com/docs'",
    );
  });

  it("throttles thinking to ~1/s, latest-wins, and drops pending on finish", async () => {
    const client = new FakeClient();
    const turn = makeTurn(client);
    onThinkingEvent(turn, { text: "first thought" });
    await __reporterInflightForTest(turn);
    assert.equal(client.calls.length, 1);
    // Within the window: buffered, not sent.
    onThinkingEvent(turn, { text: "second thought" });
    onThinkingEvent(turn, { text: "third thought" });
    await sleep(50);
    assert.equal(client.calls.length, 1);
    // Finishing the turn drops the pending tick entirely.
    finishReporting(turn);
    await sleep(1100);
    await __reporterInflightForTest(turn);
    assert.equal(client.calls.length, 1);
  });

  it("flushes the buffered latest thinking after the window", async () => {
    const client = new FakeClient();
    const turn = makeTurn(client);
    onThinkingEvent(turn, { text: "first" });
    onThinkingEvent(turn, { text: "second" });
    onThinkingEvent(turn, { text: "third" });
    await sleep(1150);
    await __reporterInflightForTest(turn);
    assert.equal(client.calls.length, 2);
    const late = client.calls[1]!.json.activity as Record<string, unknown>;
    assert.equal(late.label, "third");
  });

  it("keeps the MCP App view a tool result rendered on its step, and the bare step once the gateway drops the view", async () => {
    const requests: unknown[] = [];
    __setGatewayCall(async (method, _opts, params) => {
      requests.push([method, params]);
      if ((params as { viewId: string }).viewId === "gone") throw new Error("MCP App view expired");
      return { html: "<p>card</p>", toolInput: {}, toolResult: { structuredContent: { cash: 1 } } };
    });
    registerMcpApps({
      runtime: {
        config: { current: () => ({ mcp: { servers: { agentpit: { url: "https://agentpit.dev/mcp" } } } }) },
      },
    } as unknown as Parameters<typeof registerMcpApps>[0]);
    const turn = makeTurn(new FakeClient());
    const rendered = (viewId: string) => ({
      details: { mcpAppPreview: { mcpApp: { viewId, originSessionKey: "agent:main:clawbits", serverName: "agentpit" } } },
    });
    onToolEvent(turn, { phase: "start", name: "portfolio", toolCallId: "a1", args: {} });
    onToolEvent(turn, { phase: "result", name: "portfolio", toolCallId: "a1", result: rendered("v1") });
    onToolEvent(turn, { phase: "start", name: "portfolio", toolCallId: "a2", args: {} });
    onToolEvent(turn, { phase: "result", name: "portfolio", toolCallId: "a2", result: rendered("gone") });
    const [kept, dropped] = (await turnSteps(turn)) ?? [];
    assert.deepEqual(kept?.app, {
      server: "agentpit",
      host: "agentpit.dev",
      html: "<p>card</p>",
      input: {},
      result: { structuredContent: { cash: 1 } },
    });
    assert.equal(dropped?.app, undefined);
    assert.deepEqual(requests[0], ["mcp.app.view", { sessionKey: "agent:main:clawbits", viewId: "v1" }]);
  });

  it("latches off process-wide when the server rejects activity (422)", async () => {
    const client = new FakeClient();
    const turn = makeTurn(client);
    client.failWith = new ClawBitsError({
      statusCode: 422,
      detail: "unknown field activity",
      path: "/",
    });
    onToolEvent(turn, { phase: "start", name: "exec", toolCallId: "t1", args: {} });
    await __reporterInflightForTest(turn);
    client.failWith = null;
    const turn2 = makeTurn(client);
    onToolEvent(turn2, { phase: "start", name: "exec", toolCallId: "t2", args: {} });
    await __reporterInflightForTest(turn2);
    assert.equal(client.calls.length, 0, "activity lane must latch off after a 422");
    assert.equal(await turnSteps(turn2), undefined, "a server without activity keeps no steps either");
  });
});

describe("subscription routing", () => {
  beforeEach(() => {
    __resetTurnRegistryForTest();
    __resetActivityReporterForTest();
  });

  it("binds on lifecycle:start and routes tool events to the reporter", async () => {
    const client = new FakeClient();
    const turn = makeTurn(client);
    routeAgentEvent({
      runId: "runX",
      stream: "lifecycle",
      sessionKey: "agent:bot:clawbits:channel:chan-1",
      data: { phase: "start" },
    });
    routeAgentEvent({
      runId: "runX",
      stream: "tool",
      data: { phase: "start", name: "exec", toolCallId: "t1", args: { command: "ls" } },
    });
    await __reporterInflightForTest(turn);
    assert.equal(client.calls.length, 1);
    const activity = client.calls[0]!.json.activity as Record<string, unknown>;
    assert.equal(activity.label, "exec: 'ls'");
    // Terminal lifecycle stops the lanes: further tool events are dropped.
    routeAgentEvent({ runId: "runX", stream: "lifecycle", data: { phase: "end" } });
    routeAgentEvent({
      runId: "runX",
      stream: "tool",
      data: { phase: "start", name: "exec", toolCallId: "t2", args: {} },
    });
    await __reporterInflightForTest(turn);
    assert.equal(client.calls.length, 1);
  });

  it("never throws on malformed events", () => {
    routeAgentEvent(null);
    routeAgentEvent("nope");
    routeAgentEvent({ stream: "assistant" });
    routeAgentEvent({ runId: "r", stream: "assistant", data: null });
    routeAgentEvent({ runId: "r", stream: "weird", data: { x: 1 } });
  });
});
