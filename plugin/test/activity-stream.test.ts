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
  onThinkingEvent,
  onToolEvent,
} from "../src/activity/reporter.js";
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
