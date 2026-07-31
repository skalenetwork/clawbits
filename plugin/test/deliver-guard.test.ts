// §3.5 multi-payload deliver guard (LIVE_AGENT_ACTIVITY_PLAN): an identical
// re-delivered payload is a queue retry and is dropped; a DISTINCT second
// payload is content (block-streaming host) and must post as a follow-up
// instead of being silently swallowed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  ChannelGatewayContext,
} from "openclaw/plugin-sdk/core";
import type { ClawBitsClient } from "../src/client.js";
import type { ResolvedClawBitsAccount } from "../src/types.js";
import { dispatchInboundMessage } from "../src/gateway-adapter.js";
import type { InboundMessage } from "../src/inbound-poller.js";
import { __resetDraftRegistryForTest } from "../src/draft-registry.js";
import { __resetTurnRegistryForTest } from "../src/activity/turn-registry.js";

interface RecordedCall {
  method: string;
  path: string;
  json: Record<string, unknown>;
}

/** Answers every route the dispatch touches: challenge GETs, the draft
 *  create, draft PATCHes, status POSTs and message POSTs. */
class FakeClient {
  calls: RecordedCall[] = [];

  encodePath(value: string): string {
    return encodeURIComponent(value);
  }

  async request(
    method: string,
    path: string,
    opts?: { json?: unknown },
  ): Promise<unknown> {
    if (method === "GET" && path.endsWith("/auth/challenge")) {
      return { challenge: "2+2", session_token: "sess" };
    }
    const json = (opts?.json ?? {}) as Record<string, unknown>;
    this.calls.push({ method, path, json });
    if (method === "POST" && path.endsWith("/posts")) {
      return json.status === "streaming"
        ? { post_id: 5, channel_id: "chan-1", message: "", status: "streaming" }
        : { post_id: 99 };
    }
    if (method === "PATCH") {
      return { post_id: 5, channel_id: "chan-1", message: "", status: "published" };
    }
    return undefined;
  }
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
  reply: (params: { deliver?: (payload: unknown) => Promise<unknown> }) => Promise<void>,
): ChannelGatewayContext<ResolvedClawBitsAccount> {
  const ac = new AbortController();
  return {
    cfg: {},
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
  raw: { id: "post-1", create_at: 1 },
};

describe("deliver multi-payload guard", () => {
  it("finalizes the draft once, drops identical retries, posts distinct continuations", async () => {
    __resetDraftRegistryForTest();
    __resetTurnRegistryForTest();
    const client = new FakeClient();
    const ctx = makeCtx(async ({ deliver }) => {
      assert.ok(deliver, "stub must forward the deliver callback");
      await deliver!({ text: "block one" });
      await deliver!({ text: "block one" }); // queue retry — dropped
      await deliver!({ text: "block two" }); // distinct — follow-up post
    });

    await dispatchInboundMessage(ctx, MSG, {
      client: client as unknown as ClawBitsClient,
      answers: { "2+2": "4" },
    });

    // First deliver finalized the pre-opened draft in place.
    const patches = client.calls.filter((c) => c.method === "PATCH");
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0]!.json, { replace: "block one", done: true });

    // The identical retry minted nothing; the distinct payload posted once.
    // (The draft create also POSTs /posts but carries status:"streaming".)
    const messagePosts = client.calls.filter(
      (c) =>
        c.method === "POST" &&
        c.path.endsWith("/posts") &&
        "message" in c.json &&
        c.json.status !== "streaming",
    );
    assert.equal(messagePosts.length, 1);
    assert.equal(messagePosts[0]!.json.message, "block two");
  });
});
