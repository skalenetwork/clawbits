// Tests for the AI-usage collector + reporter (the "hook" source).
//
// The invariants these guard: token-field normalization survives spelling
// drift (camelCase hook shape vs snake_case JSONL shape); a run counted
// per-call (`llm_output`) never ALSO counts its turn aggregate; a
// multi-payload turn queues one aggregate, not one per payload; and the
// reporter only removes a batch from the queue after a 2xx, so a failed POST
// retries the same event ids (the server dedups them).
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ClawBitsClient } from "../src/client.js";
import {
  ackUsageEvents,
  claimUsageReporter,
  normalizeUsageTokens,
  peekUsageEvents,
  pendingUsageCount,
  recordLlmOutput,
  recordReplyPayloadSending,
  registerUsageHooks,
  releaseUsageReporter,
  resetUsageCollectorForTests,
} from "../src/usage/collector.js";
import { reportUsageOnce, runUsageReporter } from "../src/usage/reporter.js";

const HOOK_USAGE = { input: 5321, output: 812, cacheRead: 40000, cacheWrite: 0 };

function llmOutputEvent(runId: string, overrides: Record<string, unknown> = {}) {
  return {
    runId,
    sessionId: "sess-1",
    provider: "anthropic",
    model: "claude-opus-4-8",
    usage: HOOK_USAGE,
    ...overrides,
  };
}

function payloadEvent(runId: string, overrides: Record<string, unknown> = {}) {
  return {
    payload: { text: "hi" },
    kind: "final",
    runId,
    usageState: {
      provider: "openai",
      model: "gpt-5.4",
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
      turnUsd: 0.0125,
      ...((overrides.usageState as Record<string, unknown> | undefined) ?? {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "usageState")),
  };
}

beforeEach(() => {
  resetUsageCollectorForTests();
});

describe("normalizeUsageTokens", () => {
  it("reads the 2026.6.10 camelCase hook shape", () => {
    assert.deepEqual(normalizeUsageTokens(HOOK_USAGE), {
      input_tokens: 5321,
      output_tokens: 812,
      cache_read_tokens: 40000,
      cache_write_tokens: 0,
    });
  });

  it("reads snake_case and raw provider spellings", () => {
    assert.deepEqual(
      normalizeUsageTokens({ input_tokens: 1, output_tokens: 2, cache_read_tokens: 3 }),
      { input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 0 },
    );
    assert.deepEqual(
      normalizeUsageTokens({
        prompt_tokens: 7,
        completion_tokens: 8,
        cache_creation_input_tokens: 9,
      }),
      { input_tokens: 7, output_tokens: 8, cache_read_tokens: 0, cache_write_tokens: 9 },
    );
  });

  it("rejects zero rows, negatives, and garbage", () => {
    assert.equal(normalizeUsageTokens({ input: 0, output: 0 }), null);
    assert.equal(normalizeUsageTokens({ input: -5 }), null);
    assert.equal(normalizeUsageTokens("nope"), null);
    assert.equal(normalizeUsageTokens(undefined), null);
    // NaN/Infinity clamp to 0, so an all-invalid row is rejected too.
    assert.equal(normalizeUsageTokens({ input: Number.NaN, output: Infinity }), null);
  });
});

describe("collector", () => {
  it("queues one event per llm_output call with distinct ids", () => {
    recordLlmOutput(llmOutputEvent("run-a"));
    recordLlmOutput(llmOutputEvent("run-a", { usage: { input: 10, output: 1 } }));
    const events = peekUsageEvents(10);
    assert.equal(events.length, 2);
    assert.notEqual(events[0]?.event_id, events[1]?.event_id);
    assert.match(events[0]?.event_id ?? "", /^call:run-a:/);
    assert.equal(events[0]?.model, "claude-opus-4-8");
    assert.equal(events[0]?.provider, "anthropic");
    assert.equal(events[0]?.input_tokens, 5321);
    assert.equal(events[0]?.cost_usd, undefined);
  });

  it("drops llm_output events without model or usable usage", () => {
    recordLlmOutput(llmOutputEvent("run-a", { model: "" }));
    recordLlmOutput(llmOutputEvent("run-a", { usage: undefined }));
    recordLlmOutput(llmOutputEvent("run-a", { usage: { input: 0, output: 0 } }));
    recordLlmOutput("not-an-object");
    assert.equal(pendingUsageCount(), 0);
  });

  it("queues one turn aggregate per run, with turnUsd as cost passthrough", () => {
    recordReplyPayloadSending(payloadEvent("run-b"));
    // Same run delivers a second payload (block streaming) — no second event.
    recordReplyPayloadSending(payloadEvent("run-b"));
    const events = peekUsageEvents(10);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event_id, "turn:run-b");
    assert.equal(events[0]?.model, "gpt-5.4");
    assert.equal(events[0]?.cost_usd, 0.0125);
    assert.equal(events[0]?.currency, "USD");
  });

  it("keeps only cost from the turn aggregate when the run was counted per-call", () => {
    recordLlmOutput(llmOutputEvent("run-c"));
    recordReplyPayloadSending(payloadEvent("run-c"));
    const events = peekUsageEvents(10);
    assert.equal(events.length, 2);
    assert.match(events[0]?.event_id ?? "", /^call:run-c:/);
    // The dispatch snapshot's tokens are dropped (already counted per-call),
    // but its turnUsd — the only cost source at 2026.6.11 — rides a
    // zero-token event the server folds without counting a call.
    const costOnly = events[1];
    assert.equal(costOnly?.event_id, "turn:run-c");
    assert.equal(
      (costOnly?.input_tokens ?? -1) + (costOnly?.output_tokens ?? -1) +
        (costOnly?.cache_read_tokens ?? -1) + (costOnly?.cache_write_tokens ?? -1),
      0,
    );
    assert.equal(costOnly?.cost_usd, 0.0125);
    // Re-dispatch of the same run adds nothing; a costless aggregate after
    // per-call counting adds nothing either.
    recordReplyPayloadSending(payloadEvent("run-c"));
    assert.equal(pendingUsageCount(), 2);
    recordLlmOutput(llmOutputEvent("run-d"));
    recordReplyPayloadSending(payloadEvent("run-d", {usageState: {turnUsd: undefined}}));
    assert.equal(pendingUsageCount(), 3); // only run-d's call event joined
  });

  it("ignores payload sends without usageState (durable/replay paths)", () => {
    recordReplyPayloadSending({ payload: { text: "hi" }, kind: "final", runId: "run-d" });
    recordReplyPayloadSending(payloadEvent("run-e", { usageState: { usage: undefined } }));
    assert.equal(pendingUsageCount(), 0);
  });

  it("registers both hook legs as observers", () => {
    const hooks = new Map<string, (event: unknown) => unknown>();
    registerUsageHooks({
      on: (hook, handler) => {
        hooks.set(hook, handler);
      },
    });
    assert.deepEqual([...hooks.keys()].sort(), ["llm_output", "reply_payload_sending"]);
    // Observer contract: handlers return undefined (never rewrite/cancel).
    assert.equal(hooks.get("reply_payload_sending")?.(payloadEvent("run-f")), undefined);
    assert.equal(hooks.get("llm_output")?.(llmOutputEvent("run-g")), undefined);
    assert.equal(pendingUsageCount(), 2);
  });

  it("peek does not remove; ack removes exactly the acked ids", () => {
    recordLlmOutput(llmOutputEvent("run-h"));
    recordLlmOutput(llmOutputEvent("run-i"));
    const first = peekUsageEvents(1);
    assert.equal(first.length, 1);
    assert.equal(pendingUsageCount(), 2);
    ackUsageEvents(first);
    assert.equal(pendingUsageCount(), 1);
    assert.match(peekUsageEvents(1)[0]?.event_id ?? "", /^call:run-i:/);
  });
});

function fakeClient(behavior: {
  fail?: boolean;
}): ClawBitsClient & { reports: unknown[] } {
  const reports: unknown[] = [];
  const client = {
    reports,
    hasApiKey: () => true,
    request: async (method: string, path: string, opts?: { json?: unknown }) => {
      assert.equal(method, "POST");
      assert.ok(path.includes("/usage/report"));
      if (behavior.fail) throw new Error("boom");
      reports.push(opts?.json);
      return { ok: true, ingested: 1, duplicates: 0, rejected: 0 };
    },
  };
  return client as unknown as ClawBitsClient & { reports: unknown[] };
}

describe("reporter", () => {
  it("acks the batch only after a 2xx", async () => {
    recordLlmOutput(llmOutputEvent("run-j"));
    const failing = fakeClient({ fail: true });
    await assert.rejects(reportUsageOnce({ client: failing }));
    assert.equal(pendingUsageCount(), 1); // kept for retry

    const ok = fakeClient({});
    assert.equal(await reportUsageOnce({ client: ok }), 1);
    assert.equal(pendingUsageCount(), 0);
    const body = ok.reports[0] as { source: string; events: { event_id: string }[] };
    assert.equal(body.source, "hook");
    assert.equal(body.events.length, 1);
  });

  it("no-ops with an empty queue", async () => {
    const ok = fakeClient({});
    assert.equal(await reportUsageOnce({ client: ok }), 0);
    assert.equal(ok.reports.length, 0);
  });

  it("only one account claims the shared queue", () => {
    assert.equal(claimUsageReporter("acct-1"), true);
    assert.equal(claimUsageReporter("acct-1"), true); // re-entrant for the owner
    assert.equal(claimUsageReporter("acct-2"), false);
    releaseUsageReporter("acct-1");
    assert.equal(claimUsageReporter("acct-2"), true);
  });

  it("the loop reports queued events and stops on abort", async () => {
    recordLlmOutput(llmOutputEvent("run-k"));
    const ok = fakeClient({});
    const ctrl = new AbortController();
    const done = runUsageReporter({
      client: ok,
      abortSignal: ctrl.signal,
      accountId: "acct-loop",
      intervalMs: 5,
    });
    // Give the loop a few ticks to send, then shut it down.
    await new Promise((r) => setTimeout(r, 30));
    ctrl.abort();
    await done;
    assert.equal(pendingUsageCount(), 0);
    assert.ok(ok.reports.length >= 1);
  });
});
