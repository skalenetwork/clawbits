// §3.5 multi-payload deliver guard (LIVE_AGENT_ACTIVITY_PLAN): an identical
// re-delivered payload is a queue retry and is dropped; a DISTINCT second
// payload is content (block-streaming host) and must post as a follow-up
// instead of being silently swallowed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  ChannelGatewayContext,
} from "openclaw/plugin-sdk/core";
import { ClawBitsClient } from "../src/client.js";
import type { ResolvedClawBitsAccount } from "../src/types.js";
import { dispatchInboundMessage } from "../src/gateway-adapter.js";
import type { InboundMessage } from "../src/inbound-poller.js";
import { __resetDraftRegistryForTest, stopTurn } from "../src/draft-registry.js";
import { __resetTurnRegistryForTest } from "../src/activity/turn-registry.js";
import { routeAgentEvent } from "../src/activity/subscription.js";
import { postSurface } from "../src/outbound-adapter.js";
import { type PluginRuntime, setRuntime } from "../src/runtime.js";
import { memoryState } from "./runtime-state.js";

interface RecordedCall {
  method: string;
  path: string;
  json: Record<string, unknown>;
}

/** Answers every route the dispatch touches: challenge GETs, the draft
 *  create, draft PATCHes, status POSTs and message POSTs. */
function installServer(finalError?: Error): { calls: RecordedCall[]; restore: () => void } {
  const calls: RecordedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const { pathname: path } = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const respond = (body: unknown) => new Response(JSON.stringify(body ?? {}), { status: 200 });
    if (method === "GET" && path.endsWith("/auth/challenge")) return respond({ challenge: "2+2", session_token: "sess" });
    const json = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
    if (finalError && (method === "PATCH" || (path.endsWith("/posts") && json.status !== "streaming"))) throw finalError;
    calls.push({ method, path, json });
    if (method === "POST" && path.endsWith("/posts")) {
      return respond(
        json.status === "streaming"
          ? { post_id: 5, channel_id: "chan-1", message: "", status: "streaming" }
          : { post_id: 99 },
      );
    }
    if (method === "PATCH") return respond({ post_id: 5, channel_id: "chan-1", message: "", status: "published" });
    return respond({});
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function makeAccount(): ResolvedClawBitsAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    endpoint: "http://fc",
    orgId: "user-1",
    agentId: "bot-agent",
    apiKey: "k1",
    channelId: "chan-1",
    knownAnswers: {},
    allowFrom: [],
    interAgentMode: false,
    interAgentMessageLimit: 10,
    groupChannelShimmer: true,
    channelContextBacklog: 100,
    alivePingMs: 0,
    emailEnabled: false,
    emailPollIntervalMs: 60000,
    streaming: true,
    liveActivity: true,
    config: {},
  };
}

function makeCtx(
  reply: (params: {
    ctx: Record<string, unknown>;
    deliver?: (payload: unknown) => Promise<unknown>;
  }) => Promise<void>,
): ChannelGatewayContext<ResolvedClawBitsAccount> {
  const ac = new AbortController();
  return {
    cfg: { channels: { clawbits: { endpoint: "http://fc", orgId: "user-1", agentId: "bot-agent", apiKey: "k1", channelId: "chan-1", knownAnswers: { "2+2": "4" } } } },
    accountId: "default",
    account: makeAccount(),
    abortSignal: ac.signal,
    channelRuntime: {
      routing: {},
      session: {},
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: reply,
      },
    },
  } as unknown as ChannelGatewayContext<ResolvedClawBitsAccount>;
}

const MSG: InboundMessage = {
  accountId: "default",
  channelId: "chan-1",
  postId: "post-1",
  senderId: "owner",
  text: "hi",
  createAt: 1,
  channelType: "direct",
};

/** Dispatches MSG through a stub runtime and returns what reached the server. */
async function run(reply: Parameters<typeof makeCtx>[0], msg = MSG, finalError?: Error): Promise<RecordedCall[]> {
  __resetDraftRegistryForTest();
  __resetTurnRegistryForTest();
  const server = installServer(finalError);
  try {
    await dispatchInboundMessage(makeCtx(reply), msg, {
      client: new ClawBitsClient({ endpoint: "http://fc", apiKey: "k1" }),
      answers: { "2+2": "4" },
    });
  } finally {
    server.restore();
  }
  return server.calls;
}

const lastPatch = (calls: RecordedCall[]) => calls.filter((c) => c.method === "PATCH").at(-1)?.json;

describe("deliver multi-payload guard", () => {
  it("finalizes the draft once, drops identical retries, posts distinct continuations", async () => {
    const calls = await run(async ({ deliver }) => {
      assert.ok(deliver, "stub must forward the deliver callback");
      await deliver!({ text: "block one" });
      await deliver!({ text: "block one" }); // queue retry — dropped
      await deliver!({ text: "block two" }); // distinct — follow-up post
    });

    // First deliver finalized the pre-opened draft in place.
    const patches = calls.filter((c) => c.method === "PATCH");
    assert.equal(patches.length, 1);
    const { client_key: finalKey, ...finalized } = patches[0]!.json;
    assert.deepEqual(finalized, { replace: "block one", done: true });

    // The identical retry minted nothing; the distinct payload posted once.
    // (The draft create also POSTs /posts but carries status:"streaming".)
    const messagePosts = calls.filter(
      (c) =>
        c.method === "POST" &&
        c.path.endsWith("/posts") &&
        "message" in c.json &&
        c.json.status !== "streaming",
    );
    assert.equal(messagePosts.length, 1);
    assert.equal(messagePosts[0]!.json.message, "block two");
    assert.match(String(finalKey), /:0$/);
    assert.notEqual(messagePosts[0]!.json.client_key, finalKey, "each durable send carries its own intent key");
  });
});

describe("a final the backend did not take", () => {
  const offline = (code: string, syscall: string) =>
    new TypeError("fetch failed", { cause: Object.assign(new Error(`${syscall} ${code}`), { code, syscall }) });

  it("counts as delivered when the queue holds it and it never left", async () => {
    let outcome: unknown = "pending";
    await run(async ({ deliver }) => {
      outcome = await deliver!({ text: "later" }).then(() => "delivered", (error: unknown) => error);
    }, MSG, offline("ECONNREFUSED", "connect"));
    assert.equal(outcome, "delivered");
  });

  it("fails when it may have reached the chat", async () => {
    let outcome: unknown = "pending";
    await run(async ({ deliver }) => {
      outcome = await deliver!({ text: "maybe" }).then(() => "delivered", (error: unknown) => error);
    }, MSG, offline("ECONNRESET", "read"));
    assert.ok(outcome instanceof Error);
  });
});

describe("turn steps", () => {
  it("keeps the turn's tool and narration steps on the finished reply", async () => {
    const calls = await run(async ({ deliver }) => {
      routeAgentEvent({ runId: "run-s", stream: "lifecycle", data: { phase: "start" } });
      routeAgentEvent({ runId: "run-s", stream: "item", data: { kind: "preamble", itemId: "m1", progressText: "Listing issues." } });
      routeAgentEvent({ runId: "run-s", stream: "tool", data: { phase: "start", name: "exec", toolCallId: "c1", args: { command: "gh issue list" } } });
      routeAgentEvent({ runId: "run-s", stream: "tool", data: { phase: "result", name: "exec", toolCallId: "c1", isError: false } });
      await deliver!({ text: "Here they are." });
    });
    const steps = lastPatch(calls)?.steps as Record<string, unknown>[];
    assert.deepEqual(
      steps.map(({ kind, id, label, ok }) => ({ kind, id, label, ok })),
      [
        { kind: "note", id: "m1", label: "Listing issues.", ok: undefined },
        { kind: "tool", id: "c1", label: "exec: 'gh issue list'", ok: true },
      ],
    );
  });
});

describe("a block mid-turn", () => {
  it("keeps the steps before it on the reply above and starts the rest afresh below", async () => {
    const { cfg } = makeCtx(async () => {});
    setRuntime({ config: { current: () => cfg }, state: memoryState() } as unknown as PluginRuntime);
    const tool = (id: string, command: string) => {
      routeAgentEvent({ runId: "run-b", stream: "tool", data: { phase: "start", name: "exec", toolCallId: id, args: { command } } });
      routeAgentEvent({ runId: "run-b", stream: "tool", data: { phase: "result", name: "exec", toolCallId: id, isError: false } });
    };
    const calls = await run(async ({ deliver }) => {
      routeAgentEvent({ runId: "run-b", stream: "lifecycle", data: { phase: "start" } });
      tool("c1", "gh run list");
      routeAgentEvent({ runId: "run-b", stream: "assistant", data: { text: "Here is the week:" } });
      await postSurface("default", "chan-1", { components: [{ id: "root", component: "Text", text: "Deploys" }] });
      tool("c2", "date");
      await deliver!({ text: "That is all." });
    });
    const ended = calls.filter((c) => c.method === "PATCH" && c.json.done === true).map((c) => ({
      replace: c.json.replace,
      steps: (c.json.steps as { id: string }[] | undefined)?.map((step) => step.id),
    }));
    assert.deepEqual(ended, [
      { replace: "Here is the week:", steps: ["c1"] },
      { replace: "That is all.", steps: ["c2"] },
    ]);
  });
});

describe("a click in the operator DM", () => {
  it("never runs its text as a command", async () => {
    const turns: Record<string, unknown>[] = [];
    const uiAction = { name: "go", sourceComponentId: "go", context: {}, surfacePostId: 812 };
    for (const extra of [{}, { uiAction }]) {
      await run(async ({ ctx: turn }) => {
        turns.push(turn);
      }, { ...MSG, text: "/reset", ...extra });
    }
    assert.deepEqual(
      turns.map((turn) => [turn.CommandAuthorized, turn.CommandSource]),
      [[true, "text"], [false, undefined]],
    );
  });
});

describe("turn context", () => {
  it("names the Clawbits channel as the turn's native channel, which plugin tools read", async () => {
    const turns: Record<string, unknown>[] = [];
    await run(async ({ ctx: turn }) => {
      turns.push(turn);
    });
    assert.equal(turns[0]?.NativeChannelId, MSG.channelId);
  });

  it("offers only real posts to clawbits_react, not a sign-in wake", async () => {
    const bodies: unknown[] = [];
    for (const postId of ["538", "mcp-oauth-s1"]) {
      await run(async ({ ctx: turn }) => {
        bodies.push(turn.BodyForAgent);
      }, { ...MSG, postId });
    }
    assert.match(String(bodies[0]), /Clawbits post 538\./);
    assert.doesNotMatch(String(bodies[1]), /Clawbits post/);
  });
});

describe("turn stop", () => {
  it("aborts with one authorized /stop on the turn's route and keeps the streamed text", async () => {
    const stops: Record<string, unknown>[] = [];
    const calls = await run(async ({ ctx: turn }) => {
      if (turn.CommandBody === "/stop") {
        stops.push(turn);
        return;
      }
      routeAgentEvent({ runId: "run-1", stream: "lifecycle", data: { phase: "start" } });
      routeAgentEvent({ runId: "run-1", stream: "assistant", data: { text: "partial answer" } });
      await stopTurn("default", "chan-1");
      await stopTurn("default", "chan-1");
      routeAgentEvent({ runId: "run-1", stream: "lifecycle", data: { phase: "error" } });
    });
    await stopTurn("default", "chan-1");

    assert.equal(stops.length, 1);
    assert.deepEqual(
      [stops[0]!.CommandAuthorized, stops[0]!.CommandSource, stops[0]!.MessageId, stops[0]!.Timestamp],
      [true, "text", "stop-post-1", MSG.createAt],
    );
    assert.deepEqual(lastPatch(calls), { replace: "partial answer\n\n_(stopped)_", done: true });
  });

  it("cancels the draft when the stopped turn streamed nothing", async () => {
    const calls = await run(async ({ ctx: turn }) => {
      if (turn.CommandBody !== "/stop") await stopTurn("default", "chan-1");
    });
    assert.deepEqual(lastPatch(calls), { cancel: true });
  });

  it("tombstones the draft when an unstopped dispatch throws", async () => {
    const calls = await run(async () => {
      throw new Error("model died");
    });
    assert.deepEqual(lastPatch(calls), { replace: "_(reply failed to generate)_", done: true });
  });
});
