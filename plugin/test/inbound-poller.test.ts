import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import { ClawBitsClient } from "../src/client.js";
import { registerOpenDraft, unregisterOpenDraft } from "../src/draft-registry.js";
import {
  buildPriorContext,
  collapseSelfMentions,
  isServerHandledCommand,
  isUserAuthoredPost,
  parsePostsResponse,
  runInboundPoller,
  senderIdForPost,
  senderTagForPost,
  type InboundMessage,
  type InboundPollerOptions,
  type InboundTurn,
  type MattermostPost,
} from "../src/inbound-poller.js";
import { __resetQuestionsForTest, bindQuestion, markQuestionWaiting, questionFinalizing, questionWaiting } from "../src/questions.js";
import { setRuntime, type PluginRuntime } from "../src/runtime.js";
import { type ClawBitsServiceHandoff, registerSlimChannelHandoff } from "../src/service-handoff.js";
import type { ResolvedClawBitsAccount } from "../src/types.js";
import { memoryState, memoryStore } from "./runtime-state.js";

function makeAccount(overrides: Partial<ResolvedClawBitsAccount> = {}): ResolvedClawBitsAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    endpoint: "http://fc.example",
    ownerEmail: "owner@example.com",
    agentId: "bot-agent",
    apiKey: "test-key",
    channelId: "chan-123",
    knownAnswers: {},
    allowFrom: [],
    interAgentMode: false,
    interAgentMessageLimit: 10,
    config: { websocketEnabled: false },
    ...overrides,
  };
}

const ROOM = "chan-123";

function post(id: number, fields: Partial<MattermostPost> = {}): MattermostPost {
  return { id: String(id), create_at: id * 1000, human_id: 1, message: `msg ${id}`, channel_id: ROOM, ...fields };
}

function agentPost(id: number, fields: Partial<MattermostPost> = {}): MattermostPost {
  return post(id, { human_id: undefined, agent_id: "helper-agent", ...fields });
}

function row(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { channel_id: ROOM, channel_type: "direct", last_read_post_id: 100, latest_post_id: 100, ...fields };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function postsBody(posts: MattermostPost[]): unknown {
  return { order: posts.map((p) => p.id), posts: Object.fromEntries(posts.map((p) => [p.id, p])) };
}

let socket: MockWebSocket | undefined;
const opened: Array<{ url: string; auth?: string }> = [];

class MockWebSocket {
  static events: unknown[] = [];
  #listeners = new Map<string, Set<(event: unknown) => void>>();
  constructor(url: string, init?: { headers?: Record<string, string> }) {
    opened.push({ url, auth: init?.headers?.Authorization });
    socket = this;
    queueMicrotask(() => {
      this.emit("open", {});
      for (const event of MockWebSocket.events) this.push(event);
    });
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.#listeners.set(type, (this.#listeners.get(type) ?? new Set()).add(listener));
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }
  push(event: unknown): void {
    this.emit("message", { data: JSON.stringify(event) });
  }
  close(): void {
    this.emit("close", { code: 1000, reason: "" });
  }
  emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

interface Run {
  received: InboundMessage[];
  calls: string[];
  acks: Array<[string, number]>;
  sent: unknown[];
}

interface Scenario {
  listing?: (call: number) => unknown;
  posts?: MattermostPost[];
  route?: (url: string, init?: RequestInit) => Response | void;
  ws?: unknown[];
  account?: Partial<ResolvedClawBitsAccount>;
  poller?: Partial<InboundPollerOptions>;
  onMessage?: (msg: InboundMessage, turn: InboundTurn | undefined, run: Run) => unknown;
  until?: (run: Run) => boolean;
  ms?: number;
}

const hits = (calls: string[], suffix: string): number => calls.filter((url) => url.endsWith(suffix)).length;
const dispatched = (n: number) => ({ received }: Run): boolean => received.length >= n;
const ticks = (n: number) => ({ calls }: Run): boolean => hits(calls, "/api/agentic/mm/channels") > n;

async function waitFor(done: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !done(); i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
}

/** Runs the poller against a fake server until `until` holds (default: one dispatch). */
async function run(s: Scenario = {}): Promise<Run> {
  const out: Run = { received: [], calls: [], acks: [], sent: [] };
  const ac = new AbortController();
  const check = (): void => {
    if ((s.until ?? dispatched(1))(out)) ac.abort();
  };
  let listings = 0;
  const serve = (url: string, init?: RequestInit): Response => {
    const { pathname, searchParams } = new URL(url);
    const match = /\/api\/agentic\/mm\/channels(?:\/([^/]+)\/(\w+))?$/.exec(pathname);
    if (!match) return json(pathname.endsWith("/auth/challenge") ? { session_token: "s1", challenge: "known" } : {});
    const [, channelId = "", leaf] = match;
    if (!leaf) return json((s.listing ?? (() => ({ channels: [row()] })))(++listings));
    if (leaf === "read") out.acks.push([channelId, (JSON.parse(String(init?.body)) as { post_id: number }).post_id]);
    else if (leaf === "posts" && init?.method === "POST") out.sent.push(JSON.parse(String(init.body)));
    else if (leaf === "posts") {
      const after = Number(searchParams.get("after_post_id") ?? 0);
      return json(postsBody((s.posts ?? []).filter((p) => p.channel_id === channelId && Number(p.id) > after)));
    }
    return json({});
  };
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    out.calls.push(url);
    try {
      const routed = s.route?.(url, init);
      return routed instanceof Response ? routed : serve(url, init);
    } finally {
      check();
    }
  }) as typeof fetch;
  if (s.ws) {
    MockWebSocket.events = s.ws;
    opened.length = 0;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  }
  const account = makeAccount({ ...(s.ws ? { config: { websocketEnabled: true } } : {}), ...s.account });
  const timer = setTimeout(() => ac.abort(), s.ms ?? 2000);
  try {
    await runInboundPoller({
      client: new ClawBitsClient({ endpoint: account.endpoint, apiKey: "test-key" }),
      account,
      abortSignal: ac.signal,
      queue: () => ({}) as never,
      pollIntervalMs: 1,
      onInboundMessage: async (msg, turn) => {
        await s.onMessage?.(msg, turn, out);
        out.received.push(msg);
        check();
      },
      ...s.poller,
    });
  } finally {
    clearTimeout(timer);
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
    socket = undefined;
  }
  return out;
}

describe("parsePostsResponse", () => {
  it("returns posts in create_at ascending order using `order` when present", () => {
    const raw = {
      order: ["p2", "p1"],
      posts: {
        p1: { id: "p1", create_at: 1000, message: "first" },
        p2: { id: "p2", create_at: 2000, message: "second" },
      },
    };
    const posts = parsePostsResponse(raw);
    assert.deepEqual(
      posts.map((p) => p.id),
      ["p1", "p2"],
    );
  });

  it("falls back to object key order when `order` is missing", () => {
    const raw = {
      posts: {
        p1: { id: "p1", create_at: 10 },
        p2: { id: "p2", create_at: 20 },
      },
    };
    const posts = parsePostsResponse(raw);
    assert.equal(posts.length, 2);
  });

  it("ignores malformed posts and non-object input", () => {
    assert.deepEqual(parsePostsResponse(null), []);
    assert.deepEqual(parsePostsResponse("nope"), []);
    assert.deepEqual(
      parsePostsResponse({ posts: { bad: null, good: { id: "good", create_at: 1 } } }),
      [{ id: "good", create_at: 1 }],
    );
  });
});

describe("isUserAuthoredPost", () => {
  it("accepts regular posts with no type", () => {
    assert.equal(isUserAuthoredPost({ id: "p1", create_at: 1, message: "hello" }), true);
    assert.equal(isUserAuthoredPost({ id: "p1", create_at: 1, type: "", message: "hello" }), true);
    assert.equal(isUserAuthoredPost({ id: "p1", create_at: 1 }), false);
  });
  it("rejects system messages with a non-empty type", () => {
    assert.equal(
      isUserAuthoredPost({ id: "p1", create_at: 1, type: "system_join_channel" }),
      false,
    );
  });
  it("accepts attachment-only posts (image dropped without a caption)", () => {
    // Empty/whitespace body but with files → still a user-authored event
    // that the agent should respond to.
    assert.equal(
      isUserAuthoredPost({
        id: "p1",
        create_at: 1,
        message: "",
        files: [
          {
            fileId: "f1",
            filename: "shot.png",
            contentType: "image/png",
            sizeBytes: 1024,
            downloadUrl: null,
            thumbnailUrl: null,
            width: null,
            height: null,
            durationMs: null,
          },
        ],
      }),
      true,
    );
  });
  it("rejects empty posts with neither text nor files", () => {
    assert.equal(
      isUserAuthoredPost({ id: "p1", create_at: 1, message: "   ", files: [] }),
      false,
    );
  });
});

describe("parsePostsResponse with files", () => {
  it("carries the files array (and field-mapping) through normalization", () => {
    const posts = parsePostsResponse({
      posts: {
        p1: {
          id: "p1",
          create_at: 100,
          message: "look",
          files: [
            {
              file_id: "f1",
              filename: "shot.png",
              content_type: "image/png",
              size_bytes: 2048,
              download_url: "https://signed.example/shot.png",
              thumbnail_url: "https://signed.example/shot.thumb.jpg",
              width: 640,
              height: 480,
              status: "uploaded",
            },
          ],
        },
      },
    });
    assert.equal(posts.length, 1);
    const files = posts[0]!.files;
    assert.ok(files && files.length === 1, "files survived normalize");
    assert.equal(files[0]!.fileId, "f1");
    assert.equal(files[0]!.contentType, "image/png");
    assert.equal(files[0]!.sizeBytes, 2048);
    assert.equal(files[0]!.downloadUrl, "https://signed.example/shot.png");
    assert.equal(files[0]!.width, 640);
    assert.equal(files[0]!.height, 480);
  });

  it("omits files array when the server returned none", () => {
    const posts = parsePostsResponse({
      posts: { p1: { id: "p1", create_at: 100, message: "plain text" } },
    });
    assert.equal(posts[0]!.files, undefined);
  });

  it("skips file entries missing a file_id", () => {
    const posts = parsePostsResponse({
      posts: {
        p1: {
          id: "p1",
          create_at: 100,
          message: "with one good and one bad",
          files: [
            { filename: "missing-id.png", content_type: "image/png", size_bytes: 1 },
            { file_id: "f2", filename: "ok.png", content_type: "image/png", size_bytes: 2 },
          ],
        },
      },
    });
    assert.equal(posts[0]!.files?.length, 1);
    assert.equal(posts[0]!.files?.[0]!.fileId, "f2");
  });
});

describe("isServerHandledCommand", () => {
  it("matches a bare `/cb-usage` regardless of case/whitespace", () => {
    assert.equal(isServerHandledCommand("/cb-usage"), true);
    assert.equal(isServerHandledCommand("  /CB-USAGE  "), true);
  });

  it("does not match normal messages that merely mention /cb-usage", () => {
    assert.equal(isServerHandledCommand("what does /cb-usage do?"), false);
    assert.equal(isServerHandledCommand("/cb-usages"), false);
    assert.equal(isServerHandledCommand(undefined), false);
  });
});

describe("runInboundPoller", () => {
  it("dispatches each user post above the channel's read pointer once", async () => {
    const { received } = await run({
      posts: [post(99), post(100), post(101, { message: "hi" }), post(102)],
      until: dispatched(2),
    });
    assert.deepEqual(received.map((m) => m.postId), ["101", "102"]);
    assert.equal(received[0]?.text, "hi");
    assert.equal(received[0]?.senderId, "human:1");
    assert.equal(received[0]?.accountId, "default");
  });

  it("filters posts authored by the bot agentId (self-echoes)", async () => {
    const { received } = await run({ posts: [agentPost(101, { agent_id: "bot-agent" }), post(102)] });
    assert.deepEqual(received.map((m) => m.postId), ["102"]);
  });

  it("defaults to human-authored requests only", async () => {
    const { received } = await run({ posts: [agentPost(101), post(102)] });
    assert.deepEqual(received.map((m) => m.postId), ["102"]);
    assert.equal(received[0]?.senderTag, undefined);
  });

  it("does not dispatch a `/cb-usage` command (answered server-side) but dispatches the next message", async () => {
    const { received } = await run({ posts: [post(101, { message: "/cb-usage" }), post(102)] });
    assert.deepEqual(received.map((m) => m.postId), ["102"]);
  });

  it("dispatches `/cb-usage` normally outside a DM (DM-only command)", async () => {
    const { received } = await run({
      listing: () => ({ channels: [row({ channel_type: "public" })] }),
      posts: [post(101, { message: "@bot-agent /cb-usage" })],
    });
    assert.deepEqual(received.map((m) => m.postId), ["101"]);
  });

  it("dispatches other agents and sets senderTag in a shared (non-direct) channel when inter-agent mode is enabled", async () => {
    const { received } = await run({
      listing: () => ({ channels: [row({ channel_type: "public" })], inter_agent_mode_enabled: true }),
      posts: [agentPost(101, { message: "@bot-agent bot to bot" })],
    });
    assert.deepEqual(received.map((m) => m.postId), ["101"]);
    assert.equal(received[0]?.senderId, "agent:helper-agent");
    assert.equal(received[0]?.senderTag, "@helper-agent");
  });

  it("does NOT set senderTag (no reply-tag) in a 1:1 DM, even when inter-agent mode is enabled", async () => {
    const { received } = await run({
      listing: () => ({ channels: [row()], inter_agent_mode_enabled: true }),
      posts: [post(101, { poster_display_name: "Dmytro Tkachuk", message: "why are you tagging me" })],
    });
    assert.deepEqual(received.map((m) => m.postId), ["101"]);
    assert.equal(received[0]?.senderTag, undefined);
  });

  it("does not poll posts or open SSE while the agent is snoozed", async () => {
    const { received, calls } = await run({
      listing: () => ({ channels: [row()], snoozed: true }),
      posts: [post(101)],
      until: ticks(2),
    });
    assert.deepEqual(received, []);
    assert.equal(calls.some((url) => url.includes("/chan-123/posts") || url.includes("/chan-123/events")), false);
  });

  it("skips what arrived while snoozed once unsnoozed, moving the baseline to latest and acking it", async () => {
    const posts: MattermostPost[] = [];
    const { received, acks } = await run({
      posts,
      listing: (call) => {
        if (call === 2) posts.push(post(101), post(102));
        if (call === 4) posts.push(post(103));
        return { channels: [row({ latest_post_id: call < 3 ? 100 : 102 })], snoozed: call === 2 };
      },
    });
    assert.deepEqual(received.map((m) => m.postId), ["103"]);
    assert.deepEqual(acks[0], [ROOM, 102]);
  });

  it("pauses inter-agent replies after 5 consecutive agent-authored turns", async () => {
    const { received, sent } = await run({
      listing: () => ({ channels: [row()], inter_agent_mode_enabled: true, inter_agent_message_limit: 5 }),
      posts: Array.from({ length: 7 }, (_, i) => agentPost(101 + i)),
      account: { knownAnswers: { known: "answer" } },
      until: ({ sent }) => sent.length > 0,
    });
    assert.deepEqual(received.map((m) => m.postId), ["101", "102", "103", "104", "105"]);
    assert.deepEqual(sent, [{ message: "@helper-agent Nice, but need human guidance to proceed." }]);
  });

  it("does not reset the inter-agent pause counter for an untagged human message", async () => {
    const { received, sent } = await run({
      listing: () => ({ channels: [row()], inter_agent_mode_enabled: true, inter_agent_message_limit: 5 }),
      posts: [
        ...Array.from({ length: 5 }, (_, i) => agentPost(101 + i)),
        post(106, { message: "please continue" }),
        agentPost(107),
      ],
      account: { knownAnswers: { known: "answer" } },
      until: ({ sent }) => sent.length > 0,
    });
    assert.deepEqual(received.map((m) => m.postId), ["101", "102", "103", "104", "105", "106"]);
    assert.deepEqual(sent, [{ message: "@helper-agent Nice, but need human guidance to proceed." }]);
  });

  it("resets the inter-agent pause counter only when a human tags this agent", async () => {
    const { received } = await run({
      listing: () => ({ channels: [row()], inter_agent_mode_enabled: true, inter_agent_message_limit: 5 }),
      posts: [
        ...Array.from({ length: 5 }, (_, i) => agentPost(101 + i)),
        post(106, { message: "@bot-agent please continue" }),
        agentPost(107),
      ],
      until: dispatched(7),
    });
    assert.deepEqual(received.map((m) => m.postId), ["101", "102", "103", "104", "105", "106", "107"]);
  });

  it("filters system messages (non-empty type)", async () => {
    const { received } = await run({ posts: [post(101, { type: "system_join_channel" }), post(102)] });
    assert.deepEqual(received.map((m) => m.postId), ["102"]);
  });

  it("skips deleted posts", async () => {
    const { received } = await run({ posts: [post(101, { delete_at: 101_500 }), post(102)] });
    assert.deepEqual(received.map((m) => m.postId), ["102"]);
  });

  it("does not re-dispatch the same post on repeated poll passes", async () => {
    const { received } = await run({
      posts: [post(101)],
      until: ({ calls }) => hits(calls, "/chan-123/posts") >= 3,
    });
    assert.deepEqual(received.map((m) => m.postId), ["101"]);
  });

  it("keeps running after a transient network error and logs it", async () => {
    const warns: string[] = [];
    let flaps = 0;
    const { received } = await run({
      posts: [post(101)],
      route: () => {
        if (flaps++ === 0) throw new Error("network flap");
      },
      poller: { log: { warn: (msg) => warns.push(msg) } },
    });
    assert.ok(warns.some((msg) => msg.includes("listChannels failed")));
    assert.deepEqual(received.map((m) => m.postId), ["101"]);
  });

  it("auto-dispatches in a discovered direct channel without an @mention", async () => {
    const { received } = await run({
      listing: () => ({ channels: [row({ channel_id: "dm-with-bot" })] }),
      posts: [post(101, { channel_id: "dm-with-bot", message: "hey" })],
    });
    assert.deepEqual(received.map((m) => m.postId), ["101"]);
    assert.equal(received[0]?.channelId, "dm-with-bot");
  });

  it("auto-dispatches in a named agent chat without an @mention", async () => {
    const { received } = await run({
      listing: () => ({ channels: [row({ channel_id: "named-chat", channel_type: "agent_chat" })] }),
      posts: [post(101, { channel_id: "named-chat", message: "hey" })],
    });
    assert.deepEqual(received.map((m) => m.postId), ["101"]);
    assert.equal(received[0]?.channelType, "agent_chat");
  });

  it("blocks addressed inbound posts from senders outside non-empty allowFrom", async () => {
    const warns: string[] = [];
    const { received } = await run({
      posts: [post(101), post(102, { human_id: 2 })],
      account: { allowFrom: ["human:2"] },
      poller: { log: { warn: (msg) => warns.push(msg) } },
    });
    assert.deepEqual(received.map((m) => m.postId), ["102"]);
    assert.ok(warns.some((msg) => msg.includes("inbound blocked by allowFrom sender=human:1")), "blocked sender is logged");
  });

  it("treats empty allowFrom as allow-all", async () => {
    const { received } = await run({ posts: [post(101)], account: { allowFrom: [] } });
    assert.deepEqual(received.map((m) => m.postId), ["101"]);
  });

  it('treats a "*" entry in allowFrom as allow-all, not as a literal sender id', async () => {
    const warns: string[] = [];
    const { received } = await run({
      posts: [post(101), post(102, { human_id: 9 })],
      account: { allowFrom: ["*"] },
      poller: { log: { warn: (msg) => warns.push(msg) } },
      until: dispatched(2),
    });
    assert.deepEqual(received.map((m) => m.postId), ["101", "102"], "every sender is admitted under a wildcard allowlist");
    assert.ok(!warns.some((msg) => msg.includes("inbound blocked by allowFrom")), "no sender is blocked under a wildcard allowlist");
  });

  it("requires an @mention in non-direct channels discovered via listChannels", async () => {
    const { received } = await run({
      listing: () => ({ channels: [row({ channel_id: "team-room", channel_type: "public" })] }),
      posts: [
        post(101, { channel_id: "team-room", message: "general chatter" }),
        post(102, { channel_id: "team-room", message: "@bot-agent @bot-agent please help" }),
      ],
    });
    assert.deepEqual(received.map((m) => m.postId), ["102"]);
    assert.equal(received[0]?.text, "@bot-agent please help");
  });

  it("aborts cleanly on abortSignal mid-sleep without pending dispatches", async () => {
    const { received } = await run({ poller: { pollIntervalMs: 100_000 }, ms: 20 });
    assert.deepEqual(received, []);
  });
});

describe("runInboundPoller — durable inbound", () => {
  it("acks the admitted post's serial while its turn is still running", async () => {
    let ackedMidTurn = false;
    const { acks } = await run({
      posts: [post(100), post(101)],
      onMessage: async (_msg, _turn, { acks }) => {
        await waitFor(() => acks.length > 0);
        ackedMidTurn = acks.length > 0;
      },
    });
    assert.equal(ackedMidTurn, true, "the ack does not wait for the turn to settle");
    assert.deepEqual(acks, [[ROOM, 101]]);
  });

  it("never acks the agent's own posts or anyone's unsettled draft", async () => {
    const { received, acks } = await run({
      posts: [
        post(100),
        agentPost(101, { agent_id: "bot-agent", status: "streaming", message: "" }),
        agentPost(102, { agent_id: "other-agent", status: "streaming", message: "" }),
        post(103),
      ],
    });
    assert.deepEqual(received.map((m) => m.postId), ["103"]);
    assert.deepEqual(acks, [[ROOM, 103]]);
  });

  it("dispatches a post seen by the WebSocket, a reconcile and a fallback poll once", async () => {
    const posts = [post(101)];
    let polls = 0;
    const { received, calls } = await run({
      ws: [{ type: "post.created", channel_id: ROOM, data: posts[0] }],
      posts,
      route: (url) => {
        if (!url.endsWith("/chan-123/posts")) return;
        polls += 1;
        if (polls === 1) socket?.close();
        if (polls === 2) posts.push(post(102));
      },
      until: dispatched(2),
    });
    assert.deepEqual(received.map((m) => m.postId), ["101", "102"]);
    assert.equal(hits(calls, "/chan-123/posts"), 2, "one reconcile over the socket, one poll after it dropped");
  });

  it("turns a lobstertalk.consider nudge for an already-seen, un-mentioned post into one attention turn", async () => {
    const seen = post(101, { message: "anyone know how to reset the widget?" });
    const nudge = { type: "lobstertalk.consider", channel_id: ROOM, data: seen };
    const { received } = await run({
      listing: () => ({ channels: [row({ channel_type: "public" })] }),
      ws: [
        { type: "post.created", channel_id: ROOM, data: seen },
        nudge,
        nudge,
        { type: "post.created", channel_id: ROOM, data: post(102, { message: "@bot-agent thanks" }) },
      ],
      until: dispatched(2),
    });
    assert.deepEqual(received.map((m) => [m.postId, m.attention]), [["101", true], ["102", undefined]]);
  });

  it("does not replay history for a channel with no read pointer, and acks its latest post", async () => {
    const { received, acks, calls } = await run({
      listing: () => ({ channels: [row({ last_read_post_id: null, latest_post_id: 102 })] }),
      posts: [post(101), post(102), post(103)],
    });
    assert.deepEqual(received.map((m) => m.postId), ["103"]);
    assert.deepEqual(acks[0], [ROOM, 102]);
    assert.equal(calls.some((url) => url.includes("after_post_id")), false);
  });

  it("seeds a channel with no read pointer and no latest post from its first page", async () => {
    const posts = [post(101), post(102)];
    let polls = 0;
    const { received, acks } = await run({
      listing: () => ({ channels: [{ channel_id: ROOM, channel_type: "direct" }] }),
      posts,
      route: (url) => {
        if (url.endsWith("/chan-123/posts") && ++polls === 2) posts.push(post(103));
      },
    });
    assert.deepEqual(received.map((m) => m.postId), ["103"]);
    assert.deepEqual(acks, [[ROOM, 103]]);
  });

  it("retries a delivery that throws before adoption, flagging the last attempt", async () => {
    const attempts: Array<boolean | undefined> = [];
    const { received } = await run({
      posts: [post(101)],
      onMessage: (_msg, turn) => {
        attempts.push(turn?.lastAttempt);
        if (attempts.length < 3) throw new Error("gateway busy");
      },
    });
    assert.deepEqual(attempts, [false, false, true]);
    assert.deepEqual(received.map((m) => m.postId), ["101"]);
  });

  it("reaches stopTurn for the running turn when turn.stop arrives", async () => {
    let stopped = false;
    const { received } = await run({
      ws: [{ type: "post.created", channel_id: ROOM, data: post(101) }],
      onMessage: async () => {
        const ref = { id: 1, stop: async () => void (stopped = true) };
        registerOpenDraft("default", ROOM, ref);
        socket?.push({ type: "turn.stop", channel_id: ROOM });
        await waitFor(() => stopped);
        unregisterOpenDraft("default", ROOM, ref);
      },
    });
    assert.equal(stopped, true, "the stop is not queued behind the turn it stops");
    assert.deepEqual(received.map((m) => m.postId), ["101"]);
  });
});

describe("senderIdForPost", () => {
  it("prefers human, then agent, then raw user id", () => {
    assert.equal(senderIdForPost({ id: "p", create_at: 1, human_id: 7 }), "human:7");
    assert.equal(senderIdForPost({ id: "p", create_at: 1, agent_id: "bot" }), "agent:bot");
    assert.equal(senderIdForPost({ id: "p", create_at: 1, user_id: "u9" }), "u9");
    assert.equal(senderIdForPost({ id: "p", create_at: 1 }), "");
  });
});

describe("collapseSelfMentions", () => {
  it("collapses repeated tags to the configured agent into one visible tag", () => {
    assert.equal(
      collapseSelfMentions("@bot-agent @bot-agent help", "bot-agent"),
      "@bot-agent help",
    );
    assert.equal(
      collapseSelfMentions("please @bot-agent and @bot-agent help", "bot-agent"),
      "please @bot-agent and help",
    );
    assert.equal(
      collapseSelfMentions("@bot-agent @bot-agent, can you check?", "bot-agent"),
      "@bot-agent, can you check?",
    );
  });

  it("leaves other agents and substring lookalikes alone", () => {
    assert.equal(
      collapseSelfMentions("@bot-agent-2 @bot-agent-2 help", "bot-agent"),
      "@bot-agent-2 @bot-agent-2 help",
    );
    assert.equal(collapseSelfMentions("@other @other help", "bot-agent"), "@other @other help");
  });
});

describe("senderTagForPost", () => {
  it("builds @mention tags for agents and humans", () => {
    assert.equal(senderTagForPost({ id: "p", create_at: 1, agent_id: "helper" }), "@helper");
    assert.equal(
      senderTagForPost({ id: "p", create_at: 1, human_id: 7, poster_display_name: "Stan Lee!" }),
      "@Stan-Lee",
    );
    assert.equal(senderTagForPost({ id: "p", create_at: 1, human_id: 8 }), "@user-8");
    assert.equal(senderTagForPost({ id: "p", create_at: 1, user_id: "legacy" }), undefined);
  });
});

describe("buildPriorContext", () => {
  const history: MattermostPost[] = [
    { id: "h1", create_at: 100, human_id: 7, message: "morning" },
    { id: "sys", create_at: 150, type: "system_join_channel", message: "joined" },
    { id: "h2", create_at: 200, agent_id: "bot-agent", message: "earlier reply" },
    { id: "trigger", create_at: 300, human_id: 7, message: "@bot-agent help" },
    { id: "future", create_at: 400, human_id: 7, message: "after the tag" },
  ];

  it("returns user-authored posts strictly before the trigger, oldest first", () => {
    const ctx = buildPriorContext(history, "trigger", 300, 100, "bot-agent");
    assert.deepEqual(
      ctx.map((p) => p.postId),
      ["h1", "h2"],
    );
    assert.equal(ctx[0]?.senderId, "human:7");
    assert.equal(ctx[1]?.isSelf, true, "agent's own prior post flagged as self");
  });

  it("excludes system posts, the trigger itself, and anything newer", () => {
    const ctx = buildPriorContext(history, "trigger", 300, 100, "bot-agent");
    const ids = ctx.map((p) => p.postId);
    assert.ok(!ids.includes("sys"));
    assert.ok(!ids.includes("trigger"));
    assert.ok(!ids.includes("future"));
  });

  it("caps to the most recent `limit` posts", () => {
    const ctx = buildPriorContext(history, "trigger", 300, 1, "bot-agent");
    assert.deepEqual(
      ctx.map((p) => p.postId),
      ["h2"],
      "keeps the newest one before the trigger",
    );
  });

  it("returns nothing when limit is zero", () => {
    assert.deepEqual(buildPriorContext(history, "trigger", 300, 0, "bot-agent"), []);
  });

  it("skips posts at or below the watermark (already shown)", () => {
    // Watermark at 150 → h1 (100) excluded, h2 (200) kept.
    const ctx = buildPriorContext(history, "trigger", 300, 100, "bot-agent", 150);
    assert.deepEqual(
      ctx.map((p) => p.postId),
      ["h2"],
    );
    // Watermark at/after the newest prior post → nothing new to surface.
    assert.deepEqual(buildPriorContext(history, "trigger", 300, 100, "bot-agent", 200), []);
  });

  it("can exclude agent-authored context when inter-agent mode is off", () => {
    const ctx = buildPriorContext(history, "trigger", 300, 100, "bot-agent", 0, false);
    assert.deepEqual(
      ctx.map((p) => p.postId),
      ["h1"],
    );
  });
});

describe("runInboundPoller — pre-tag channel backlog", () => {
  const TEAM = "team-room";
  const chatter = [
    post(101, { channel_id: TEAM, message: "anyone around?" }),
    post(102, { channel_id: TEAM, human_id: 2, message: "deploy is green" }),
    post(103, { channel_id: TEAM, message: "@bot-agent status?" }),
  ];
  const later = [
    post(104, { channel_id: TEAM, human_id: 2, message: "build finished" }),
    post(105, { channel_id: TEAM, message: "@bot-agent and now?" }),
  ];
  const inRoom = (posts: MattermostPost[], s: Scenario = {}): Promise<Run> =>
    run({
      listing: () => ({ channels: [row({ channel_id: TEAM, channel_type: "public" })] }),
      posts,
      account: { channelContextBacklog: 50 },
      ...s,
    });

  it("catches up on new messages on every mention (watermark dedupes)", async () => {
    const { received } = await inRoom([...chatter, ...later], {
      poller: { contextWatermarks: memoryStore() },
      until: dispatched(2),
    });
    assert.deepEqual(received.map((m) => m.postId), ["103", "105"]);
    assert.deepEqual(received[0]?.priorContext?.map((p) => p.postId), ["101", "102"], "first tag catches up on prior chatter");
    assert.deepEqual(received[1]?.priorContext?.map((p) => p.postId), ["104"], "second tag surfaces only what is new since the first");
  });

  it("gathers backlog regardless of the agent's response-approval flag", async () => {
    const { received } = await inRoom(chatter, {
      listing: () => ({ channels: [row({ channel_id: TEAM, channel_type: "public" })], require_response_approval: true }),
    });
    assert.equal(received[0]?.postId, "103");
    assert.deepEqual(received[0]?.priorContext?.map((p) => p.postId), ["101", "102"]);
  });

  it("does not gather backlog when the budget is zero", async () => {
    const { received } = await inRoom(chatter, { account: { channelContextBacklog: 0 } });
    assert.equal(received[0]?.postId, "103");
    assert.equal(received[0]?.priorContext, undefined, "backlog disabled → no context");
  });

  it("gathers backlog for the configured fallback channel when discovery says it is public", async () => {
    const { received } = await inRoom(chatter, { account: { channelId: TEAM, channelContextBacklog: 50 } });
    assert.equal(received[0]?.postId, "103");
    assert.deepEqual(received[0]?.priorContext?.map((p) => p.postId), ["101", "102"], "configured public channel is not treated as fallback operator DM");
  });

  it("does not re-read history across a restart (shared context watermark store)", async () => {
    const store = memoryStore<number>();
    const first = await inRoom(chatter, { poller: { contextWatermarks: store } });
    assert.deepEqual(first.received[0]?.priorContext?.map((p) => p.postId), ["101", "102"]);

    const second = await inRoom([...chatter, ...later], {
      listing: () => ({ channels: [row({ channel_id: TEAM, channel_type: "public", last_read_post_id: 103, latest_post_id: 103 })] }),
      poller: { contextWatermarks: store },
    });
    assert.equal(second.received[0]?.postId, "105");
    assert.deepEqual(second.received[0]?.priorContext?.map((p) => p.postId), ["104"], "only what arrived since the last shown post");
    assert.equal(store.rows.get(`default:${TEAM}`), 105_000);
  });
});

describe("runInboundPoller — agent WebSocket and SSE", () => {
  it("finishes an MCP sign-in from the agent WebSocket, reports it, then wakes the agent", async () => {
    setRuntime({
      system: { runCommandWithTimeout: async () => ({ code: 0, stdout: "", stderr: "" }) },
    } as unknown as PluginRuntime);
    const reported: unknown[] = [];
    const turns: Array<InboundTurn | undefined> = [];
    const { received } = await run({
      ws: [
        { type: "snapshot", data: { channels: [{ channel_id: "room-1", channel_type: "public" }] } },
        {
          type: "mcp.oauth.code",
          data: { server: "agentpit", code: "c1", state: "s1", channel_id: "room-1", human_id: 7 },
        },
      ],
      route: (url, init) => {
        if (url.endsWith("/api/agentic/mcp-oauth/result")) reported.push(JSON.parse(String(init?.body)));
      },
      onMessage: (_msg, turn) => void turns.push(turn),
    });
    assert.deepEqual(reported, [{ state: "s1", connected: true }]);
    assert.deepEqual(received.map((m) => [m.postId, m.channelId, m.senderId]), [["mcp-oauth-s1", "room-1", "human:7"]]);
    assert.match(received[0]?.text ?? "", /Signed in to MCP server "agentpit"/);
    assert.equal(turns[0]?.lastAttempt, false, "the wake runs as a durable turn");
  });

  it("forwards skills.sync and automation.sync to the companion's loops", async () => {
    let handoff: ClawBitsServiceHandoff | undefined;
    registerSlimChannelHandoff(
      {
        channel: {
          runtimeContexts: {
            register: ({ context }) => {
              handoff = context;
              return { dispose() {} };
            },
            get: () => undefined,
          },
        },
      },
      "0.17.0",
    );
    const woken: string[] = [];
    const unsubscribe = handoff?.onCompanionWake?.((nudge, accountId) => woken.push(`${nudge}:${accountId}`));
    try {
      await run({
        ws: [{ type: "skills.sync" }, { type: "automation.sync" }, { type: "post.created", channel_id: ROOM, data: post(101) }],
      });
    } finally {
      unsubscribe?.();
    }
    assert.deepEqual(woken, ["skills.sync:default", "automation.sync:default"]);
  });

  it("dispatches post.created over the agent WebSocket without per-channel SSE or post polling", async () => {
    const { received, calls } = await run({
      ws: [{ type: "post.created", channel_id: ROOM, data: post(101, { message: "hello over ws" }) }],
      account: { endpoint: "http://fc.example/base" },
      poller: { pollIntervalMs: 10_000 },
    });
    assert.deepEqual(received.map((m) => m.postId), ["101"]);
    assert.deepEqual(opened, [{ url: "ws://fc.example/base/api/agentic/mm/events/ws", auth: "Bearer test-key" }]);
    assert.equal(calls.some((url) => url.includes("/chan-123/events") || url.includes("/chan-123/posts")), false);
  });

  it("learns WebSocket-pushed channels, seeding a baseline only from their latest_post_id", async () => {
    const { received } = await run({
      ws: [
        { type: "channel.added", channel_id: "chan-new", data: { channel_id: "chan-new", channel_type: "direct" } },
        {
          type: "channel.added",
          channel_id: "chan-seeded",
          data: { channel_id: "chan-seeded", channel_type: "direct", latest_post_id: 300 },
        },
        { type: "post.created", channel_id: "chan-seeded", data: post(300, { channel_id: "chan-seeded" }) },
        { type: "post.created", channel_id: "chan-new", data: post(7, { channel_id: "chan-new" }) },
        { type: "post.created", channel_id: "chan-seeded", data: post(301, { channel_id: "chan-seeded" }) },
      ],
      poller: { pollIntervalMs: 10_000 },
      until: dispatched(2),
    });
    assert.deepEqual(received.map((m) => [m.channelId, m.postId]), [["chan-new", "7"], ["chan-seeded", "301"]]);
  });

  it("does not refresh channel control on every fallback tick while WebSocket is healthy", async () => {
    const { calls } = await run({
      ws: [],
      poller: { websocketReconcileIntervalMs: 60_000, websocketControlRefreshIntervalMs: 60_000 },
      until: () => false,
      ms: 25,
    });
    assert.equal(hits(calls, "/api/agentic/mm/channels"), 1);
    assert.ok(hits(calls, "/chan-123/posts") <= 1, "post reconcile should not run on every fallback tick either");
  });

  it("uses rare WebSocket reconcile to recover an unseen post below the acked read pointer", async () => {
    const missed = post(101, { message: "@bot-agent missed this" });
    const later = post(102);
    let polls = 0;
    const { received, acks, calls } = await run({
      ws: [],
      route: (url) => {
        if (!url.endsWith("/chan-123/posts")) return;
        if (++polls > 1) return json(postsBody([missed, later]));
        socket?.push({ type: "post.created", channel_id: ROOM, data: later });
        socket?.push({ type: "resync_required" });
        return json(postsBody([]));
      },
      poller: { websocketReconcileIntervalMs: 60_000 },
      until: dispatched(2),
    });
    assert.deepEqual(received.map((m) => m.postId), ["102", "101"]);
    assert.deepEqual(acks, [[ROOM, 102]], "the recovered post never moves the pointer back");
    assert.equal(hits(calls, "/chan-123/posts"), 2);
  });

  it("dispatches SSE posts without waiting for a poll, one agent turn at a time", async () => {
    const frames = [post(101), post(102)]
      .map((p) => `data: ${JSON.stringify({ type: "post.created", channel_id: ROOM, data: p })}\n\n`)
      .join("");
    let active = 0;
    let maxActive = 0;
    const { received } = await run({
      route: (url) =>
        url.endsWith("/chan-123/events")
          ? new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode(frames)) }))
          : undefined,
      poller: { pollIntervalMs: 10_000 },
      onMessage: async (msg) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (msg.postId === "101") await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
      },
      until: dispatched(2),
    });
    assert.deepEqual(received.map((m) => m.postId), ["101", "102"]);
    assert.equal(maxActive, 1);
  });
});

describe("runInboundPoller — server-cursor catch-up", () => {
  it("admits the newest addressed gap post as one turn with the rest as context, acking the newest serial", async () => {
    const { received, calls, acks } = await run({
      listing: () => ({ channels: [row({ latest_post_id: 106 })] }),
      posts: [post(101), post(102), post(103), post(104), post(105), post(106, { type: "system_join_channel" })],
      until: ticks(2),
    });
    assert.deepEqual(received.map((m) => [m.postId, m.catchUp]), [["105", true]], "exactly one catch-up turn");
    assert.deepEqual(received[0]?.priorContext?.map((p) => p.postId), ["101", "102", "103", "104"]);
    assert.ok(calls.some((url) => url.includes("after_post_id=100")), "the drain resumes from the server pointer");
    assert.deepEqual(acks, [[ROOM, 106]]);
  });

  it("skips the drain entirely when the pointer already covers the newest post", async () => {
    const { received, calls } = await run({
      listing: () => ({ channels: [row({ last_read_post_id: 120, latest_post_id: 120 })] }),
      until: ticks(2),
    });
    assert.deepEqual(received, []);
    assert.equal(calls.some((url) => url.includes("after_post_id=")), false, "a quiet channel costs zero cursor reads");
  });

  it("catch-up auto-dispatches named agent chats without an @mention", async () => {
    const { received } = await run({
      listing: () => ({ channels: [row({ channel_type: "agent_chat", latest_post_id: 102 })] }),
      posts: [post(101), post(102)],
    });
    assert.deepEqual(received.map((m) => [m.postId, m.channelType, m.catchUp]), [["102", "agent_chat", true]]);
  });

  it("acks past an examined gap that never addresses the agent", async () => {
    const { received, acks } = await run({
      listing: () => ({ channels: [row({ channel_type: "public", latest_post_id: 105 })] }),
      posts: [post(101), post(102), post(103), post(104), post(105)],
      account: { channelId: "another-chan" },
      until: ticks(2),
    });
    assert.deepEqual(received, [], "nothing addressed → no turn");
    assert.deepEqual(acks, [[ROOM, 105]], "the gap is not re-drained every boot");
  });

  it("does not replay history when catchUpEnabled is false", async () => {
    const { received, calls } = await run({
      listing: () => ({ channels: [row({ latest_post_id: 102 })] }),
      posts: [post(101), post(102)],
      poller: { catchUpEnabled: false },
      until: ticks(2),
    });
    assert.deepEqual(received, []);
    assert.equal(calls.some((url) => url.includes("after_post_id=")), false);
  });

  it("runs catch-up at unsnooze when the agent booted snoozed", async () => {
    const { received } = await run({
      listing: (call) => ({ channels: [row({ latest_post_id: 102 })], snoozed: call === 1 }),
      posts: [post(101), post(102)],
    });
    assert.deepEqual(received.map((m) => [m.postId, m.catchUp]), [["102", true]]);
  });

  it("falls back to the configured channel without replaying it when the control fetch keeps failing", async () => {
    const posts = [post(101), post(102)];
    let polls = 0;
    const { received } = await run({
      posts,
      route: (url) => {
        if (url.endsWith("/api/agentic/mm/channels")) return json({ detail: "boom" }, 500);
        if (url.endsWith("/chan-123/posts") && ++polls === 2) posts.push(post(103));
      },
    });
    assert.deepEqual(received.map((m) => [m.postId, m.channelType, m.catchUp]), [["103", null, undefined]]);
  });
});

describe("runInboundPoller — UI actions", () => {
  const TEAM = "team-room";
  const DEPLOY = { name: "deploy", sourceComponentId: "go", context: { target: ["staging"] } };
  const team = (fields: Record<string, unknown> = {}) => () => ({ channels: [row({ channel_id: TEAM, channel_type: "public", ...fields })] });
  const surface = (id: number, agentId: string) => agentPost(id, { channel_id: TEAM, agent_id: agentId, message: "Deploy where?" });
  const click = (id: number, surfaceId: number, agentId: string) =>
    post(id, { channel_id: TEAM, message: "Deploy: Staging", ui_action: DEPLOY, parent_preview: { post_id: surfaceId, agent_id: agentId } });

  it("dispatches a click on this agent's own UI block in a group chat, carrying its action", async () => {
    const { received } = await run({ listing: team(), posts: [surface(101, "bot-agent"), click(102, 101, "bot-agent")] });
    assert.deepEqual(received.map((m) => [m.postId, m.text, m.uiAction]), [["102", "Deploy: Staging", { ...DEPLOY, surfacePostId: 101 }]]);
  });

  it("leaves a click on another agent's UI block to that agent", async () => {
    const { received } = await run({
      listing: team(),
      posts: [surface(101, "helper-agent"), click(102, 101, "helper-agent"), post(103, { channel_id: TEAM, message: "@bot-agent hi" })],
    });
    assert.deepEqual(received.map((m) => [m.postId, m.uiAction]), [["103", undefined]]);
  });

  it("replays a click on this agent's UI block that arrived while it was down", async () => {
    const { received } = await run({ listing: team({ latest_post_id: 102 }), posts: [surface(101, "bot-agent"), click(102, 101, "bot-agent")] });
    assert.deepEqual(received.map((m) => [m.postId, m.catchUp, m.uiAction?.surfacePostId]), [["102", true, 101]]);
  });
});

describe("runInboundPoller — questions", () => {
  const QID = `ask_${"b".repeat(32)}`;
  const PICK = { name: "oc.question", sourceComponentId: "c3", context: { optionValue: "staging" } };
  const card = (id: number) => agentPost(id, { agent_id: "bot-agent", message: "Deploy where?" });
  const pick = (id: number, cardId: number) =>
    post(id, { message: "Staging", ui_action: PICK, parent_preview: { post_id: cardId, agent_id: "bot-agent" } });
  const { resolveOption } = questionGatewayRuntime;
  const resolved: Array<Parameters<typeof resolveOption>[0]> = [];
  const closes: unknown[] = [];
  const route = (url: string, init?: RequestInit): void => {
    if (url.endsWith("/ui/close")) closes.push([new URL(url).pathname, JSON.parse(String(init?.body))]);
  };
  const answering = (status: string) => {
    questionGatewayRuntime.resolveOption = async (params) => {
      resolved.push(params);
      return { status };
    };
  };

  beforeEach(() => {
    setRuntime({ config: { current: () => ({}) }, state: memoryState() } as unknown as PluginRuntime);
    __resetQuestionsForTest();
    resolved.length = 0;
    closes.length = 0;
  });

  afterEach(() => {
    questionGatewayRuntime.resolveOption = resolveOption;
  });

  it("answers the card's question with the clicked option, stops waiting at once and starts no turn", async () => {
    await bindQuestion("default", "101", { channelId: ROOM, questionId: QID });
    markQuestionWaiting("default", ROOM, QID);
    answering("answered");
    const { received } = await run({ posts: [card(101), pick(102, 101)], route, until: () => resolved.length > 0 });
    assert.deepEqual(received, []);
    const params = resolved[0]!;
    assert.deepEqual([params.questionId, params.optionValue, params.senderId], [QID, "staging", "human:1"]);
    assert.equal(questionWaiting("default", ROOM), false);
    assert.deepEqual(closes, [], "core's finalize closes an answered card");
  });

  it("closes a card no question is bound to", async () => {
    answering("answered");
    const { received } = await run({ posts: [card(101), pick(102, 101)], route, until: () => closes.length > 0 });
    assert.deepEqual(received, []);
    assert.deepEqual(resolved, []);
    assert.deepEqual(closes, [["/api/agentic/mm/posts/101/ui/close", { text: "No longer open" }]]);
  });

  it("leaves a card core is about to close to core", async () => {
    await bindQuestion("default", "101", { channelId: ROOM, questionId: QID });
    questionFinalizing("default", "101", true);
    answering("already-terminal");
    const { received } = await run({ posts: [card(101), pick(102, 101)], route, until: () => resolved.length > 0 });
    assert.deepEqual(received, []);
    assert.deepEqual(closes, []);
  });

  it("closes a card whose question is no longer pending", async () => {
    await bindQuestion("default", "101", { channelId: ROOM, questionId: QID });
    answering("already-terminal");
    const { received } = await run({ posts: [card(101), pick(102, 101)], route, until: () => closes.length > 0 });
    assert.deepEqual(received, []);
    assert.equal(resolved.length, 1);
    assert.deepEqual(closes, [["/api/agentic/mm/posts/101/ui/close", { text: "No longer open" }]]);
  });

  it("hands a typed post in a chat waiting on a question to core at once, past the asking turn", async () => {
    const posts = [post(101, { message: "deploy it" })];
    const { received } = await run({
      posts,
      until: dispatched(2),
      onMessage: async (msg, _turn, out) => {
        if (msg.postId !== "101") return;
        markQuestionWaiting("default", ROOM, QID);
        posts.push(post(102, { message: "@bot-agent, staging" }));
        await waitFor(() => out.received.length > 0);
      },
    });
    assert.deepEqual(
      received.map((m) => [m.postId, m.text, m.questionAnswer]),
      [
        ["102", "staging", true],
        ["101", "deploy it", undefined],
      ],
    );
  });

  it("moves a typed answer whose question ended before it was delivered to an ordinary turn", async () => {
    await bindQuestion("default", "101", { channelId: ROOM, questionId: QID });
    markQuestionWaiting("default", ROOM, QID);
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    questionGatewayRuntime.resolveOption = async (params) => {
      resolved.push(params);
      await gate;
      return { status: "answered" };
    };
    const posts = [card(101), pick(102, 101), post(103, { message: "@bot-agent staging" })];
    setTimeout(release, 50);
    const { received } = await run({ posts, route, until: dispatched(1) });
    assert.deepEqual(received.map((m) => [m.postId, m.questionAnswer]), [["103", undefined]]);
  });

  it("leaves a post in a chat waiting on nothing to an ordinary turn", async () => {
    markQuestionWaiting("default", "other-room", QID);
    const { received } = await run({ posts: [post(101, { message: "@bot-agent staging" })] });
    assert.deepEqual(received.map((m) => [m.postId, m.text, m.questionAnswer]), [["101", "@bot-agent staging", undefined]]);
  });

  it("leaves a command in a waiting chat to an ordinary turn", async () => {
    markQuestionWaiting("default", ROOM, QID);
    const { received } = await run({ posts: [post(101, { message: "/new" })] });
    assert.deepEqual(received.map((m) => [m.postId, m.text, m.questionAnswer]), [["101", "/new", undefined]]);
  });
});
