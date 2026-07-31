import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ClawBitsClient } from "../src/client.js";
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
  type MattermostPost,
} from "../src/inbound-poller.js";
import { ChannelWatermarkStore } from "../src/channel-watermarks.js";
import type { ResolvedClawBitsAccount } from "../src/types.js";

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

function makeClient(): ClawBitsClient {
  return new ClawBitsClient({ endpoint: "http://fc.example", apiKey: "test-key" });
}

function installFetchStub(
  handler: (
    url: string,
    init?: RequestInit,
  ) => { body?: unknown; status?: number } | Promise<{ body?: unknown; status?: number }>,
): { restore: () => void; calls: string[] } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input);
    calls.push(url);
    const { body, status } = await handler(url, init);
    return new Response(JSON.stringify(body ?? {}), {
      status: status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    calls,
  };
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
  it("dispatches only new user posts once and advances the cursor", async () => {
    const posts: MattermostPost[] = [
      { id: "p0", create_at: 100, human_id: 1, message: "old", channel_id: "chan-123" },
      { id: "p1", create_at: 200, human_id: 1, message: "hi", channel_id: "chan-123" },
      { id: "p2", create_at: 300, human_id: 1, message: "again", channel_id: "chan-123" },
    ];
    const stub = installFetchStub(() => ({
      body: {
        order: posts.map((p) => p.id),
        posts: Object.fromEntries(posts.map((p) => [p.id, p])),
      },
    }));
    const ac = new AbortController();
    const received: InboundMessage[] = [];
    let polls = 0;
    try {
      await runInboundPoller({
        client: makeClient(),
        account: makeAccount(),
        abortSignal: ac.signal,
        // Start cursor BEFORE p1 so p1/p2 dispatch; p0 should be filtered.
        initialCursor: 150,
        pollIntervalMs: 1,
        ownerHumanIds: new Set([1]),
        onInboundMessage: (msg) => {
          received.push(msg);
          polls += 1;
          if (polls >= 2) ac.abort();
        },
      });
    } finally {
      stub.restore();
    }
    assert.deepEqual(
      received.map((m) => m.postId),
      ["p1", "p2"],
    );
    assert.equal(received[0]?.text, "hi");
    assert.equal(received[0]?.senderId, "human:1");
    assert.equal(received[0]?.accountId, "default");
  });

  it("filters posts authored by the bot agentId (self-echoes)", async () => {
    const posts: MattermostPost[] = [
      { id: "self", create_at: 200, agent_id: "bot-agent", message: "echo", channel_id: "chan-123" },
      { id: "human", create_at: 300, human_id: 1, message: "real", channel_id: "chan-123" },
    ];
    const stub = installFetchStub(() => ({
      body: {
        order: posts.map((p) => p.id),
        posts: Object.fromEntries(posts.map((p) => [p.id, p])),
      },
    }));
    const ac = new AbortController();
    const received: InboundMessage[] = [];
    try {
      await runInboundPoller({
        client: makeClient(),
        account: makeAccount(),
        abortSignal: ac.signal,
        initialCursor: 150,
        pollIntervalMs: 1,
        ownerHumanIds: new Set([1]),
        onInboundMessage: (msg) => {
          received.push(msg);
          ac.abort();
        },
      });
    } finally {
      stub.restore();
    }
    assert.deepEqual(
      received.map((m) => m.postId),
      ["human"],
    );
  });

  it("defaults to human-authored requests only", async () => {
    const posts: MattermostPost[] = [
      { id: "agent", create_at: 200, agent_id: "helper-agent", message: "bot to bot", channel_id: "chan-123" },
      { id: "human", create_at: 300, human_id: 1, message: "real", channel_id: "chan-123" },
    ];
    const stub = installFetchStub((url) => {
      if (url.endsWith("/api/agentic/mm/channels")) {
        return { body: { channels: [{ channel_id: "chan-123", channel_type: "direct" }] } };
      }
      return {
        body: {
          order: posts.map((p) => p.id),
          posts: Object.fromEntries(posts.map((p) => [p.id, p])),
        },
      };
    });
    const ac = new AbortController();
    const received: InboundMessage[] = [];
    try {
      await runInboundPoller({
        client: makeClient(),
        account: makeAccount(),
        abortSignal: ac.signal,
        initialCursor: 150,
        pollIntervalMs: 1,
        onInboundMessage: (msg) => {
          received.push(msg);
          ac.abort();
        },
      });
    } finally {
      stub.restore();
    }
    assert.deepEqual(received.map((m) => m.postId), ["human"]);
    assert.equal(received[0]?.senderTag, undefined);
  });

  it("does not dispatch a `/cb-usage` command (answered server-side) but dispatches the next message", async () => {
    const posts: MattermostPost[] = [
      { id: "usage", create_at: 200, human_id: 1, message: "/cb-usage", channel_id: "chan-123" },
      { id: "real", create_at: 300, human_id: 1, message: "hello", channel_id: "chan-123" },
    ];
    const stub = installFetchStub((url) => {
      if (url.endsWith("/api/agentic/mm/channels")) {
        return { body: { channels: [{ channel_id: "chan-123", channel_type: "direct" }] } };
      }
      return {
        body: {
          order: posts.map((p) => p.id),
          posts: Object.fromEntries(posts.map((p) => [p.id, p])),
        },
      };
    });
    const ac = new AbortController();
    const received: InboundMessage[] = [];
    try {
      await runInboundPoller({
        client: makeClient(),
        account: makeAccount(),
        abortSignal: ac.signal,
        initialCursor: 150,
        pollIntervalMs: 1,
        ownerHumanIds: new Set([1]),
        onInboundMessage: (msg) => {
          received.push(msg);
          ac.abort();
        },
      });
    } finally {
      stub.restore();
    }
    // The `/cb-usage` post is skipped; only the following real message reaches the model.
    assert.deepEqual(received.map((m) => m.postId), ["real"]);
  });

  it("dispatches `/cb-usage` normally outside a DM (DM-only command)", async () => {
    const posts: MattermostPost[] = [
      { id: "usage", create_at: 200, human_id: 1, message: "@bot-agent /cb-usage", channel_id: "chan-123" },
    ];
    const stub = installFetchStub((url) => {
      if (url.endsWith("/api/agentic/mm/channels")) {
        return { body: { channels: [{ channel_id: "chan-123", channel_type: "public" }] } };
      }
      return {
        body: {
          order: posts.map((p) => p.id),
          posts: Object.fromEntries(posts.map((p) => [p.id, p])),
        },
      };
    });
    const ac = new AbortController();
    const received: InboundMessage[] = [];
    try {
      await runInboundPoller({
        client: makeClient(),
        account: makeAccount(),
        abortSignal: ac.signal,
        initialCursor: 150,
        pollIntervalMs: 1,
        ownerHumanIds: new Set([1]),
        onInboundMessage: (msg) => {
          received.push(msg);
          ac.abort();
        },
      });
    } finally {
      stub.restore();
    }
    // Not a DM, but the agent is mentioned → `/cb-usage` reaches the model as text.
    assert.deepEqual(received.map((m) => m.postId), ["usage"]);
  });

  it("dispatches other agents and sets senderTag in a shared (non-direct) channel when inter-agent mode is enabled", async () => {
    // The agent-sender is @-mentioned so it's addressed in a public channel;
    // reply-tagging is load-bearing here (the reply mentions the other agent so
    // ITS poller picks the reply up and the conversation continues).
    const posts: MattermostPost[] = [
      { id: "agent", create_at: 200, agent_id: "helper-agent", message: "@bot-agent bot to bot", channel_id: "chan-123" },
    ];
    const stub = installFetchStub((url) => {
      if (url.endsWith("/api/agentic/mm/channels")) {
        return {
          body: {
            channels: [{ channel_id: "chan-123", channel_type: "public" }],
            inter_agent_mode_enabled: true,
          },
        };
      }
      return {
        body: {
          order: posts.map((p) => p.id),
          posts: Object.fromEntries(posts.map((p) => [p.id, p])),
        },
      };
    });
    const ac = new AbortController();
    const received: InboundMessage[] = [];
    try {
      await runInboundPoller({
        client: makeClient(),
        account: makeAccount(),
        abortSignal: ac.signal,
        initialCursor: 150,
        pollIntervalMs: 1,
        onInboundMessage: (msg) => {
          received.push(msg);
          ac.abort();
        },
      });
    } finally {
      stub.restore();
    }
    assert.deepEqual(received.map((m) => m.postId), ["agent"]);
    assert.equal(received[0]?.senderId, "agent:helper-agent");
    assert.equal(received[0]?.senderTag, "@helper-agent");
  });

  it("does NOT set senderTag (no reply-tag) in a 1:1 DM, even when inter-agent mode is enabled", async () => {
    // Regression for the reported bug: inter-agent (LobsterTalk) reply-tagging
    // must not leak into direct channels. In a DM there's a single counterpart,
    // so no senderTag → buildReplyTagBlock stays empty → the agent doesn't
    // prefix every reply with the human's @handle.
    const posts: MattermostPost[] = [
      { id: "dm", create_at: 200, human_id: 1, poster_display_name: "Dmytro Tkachuk", message: "why are you tagging me", channel_id: "chan-123" },
    ];
    const stub = installFetchStub((url) => {
      if (url.endsWith("/api/agentic/mm/channels")) {
        return {
          body: {
            channels: [{ channel_id: "chan-123", channel_type: "direct" }],
            inter_agent_mode_enabled: true,
          },
        };
      }
      return {
        body: {
          order: posts.map((p) => p.id),
          posts: Object.fromEntries(posts.map((p) => [p.id, p])),
        },
      };
    });
    const ac = new AbortController();
    const received: InboundMessage[] = [];
    try {
      await runInboundPoller({
        client: makeClient(),
        account: makeAccount(),
        abortSignal: ac.signal,
        initialCursor: 150,
        pollIntervalMs: 1,
        onInboundMessage: (msg) => {
          received.push(msg);
          ac.abort();
        },
      });
    } finally {
      stub.restore();
    }
    assert.deepEqual(received.map((m) => m.postId), ["dm"]);
    assert.equal(received[0]?.senderTag, undefined);
  });

  it("does not poll posts or open SSE while the agent is snoozed", async () => {
    const ac = new AbortController();
    let listCalls = 0;
    const stub = installFetchStub((url) => {
      if (url.endsWith("/api/agentic/mm/channels")) {
        listCalls += 1;
        if (listCalls >= 2) queueMicrotask(() => ac.abort());
        return {
          body: {
            channels: [{ channel_id: "chan-123", channel_type: "direct" }],
            inter_agent_mode_enabled: true,
            snoozed: true,
          },
        };
      }
      throw new Error(`unexpected request while snoozed: ${url}`);
    });
    const received: InboundMessage[] = [];
    try {
      await runInboundPoller({
        client: makeClient(),
        account: makeAccount(),
        abortSignal: ac.signal,
        initialCursor: 150,
        pollIntervalMs: 1,
        onInboundMessage: (msg) => {
          received.push(msg);
        },
      });
    } finally {
      stub.restore();
    }
    assert.deepEqual(received, []);
    assert.equal(
      stub.calls.some((url) => url.includes("/api/agentic/mm/channels/chan-123/posts")),
      false,
    );
    assert.equal(
      stub.calls.some((url) => url.includes("/api/agentic/mm/channels/chan-123/events")),
      false,
    );
  });

  it("skips backlog that arrived while snoozed after unsnooze", async () => {
    const posts: MattermostPost[] = [
      { id: "during-snooze", create_at: 200, human_id: 1, message: "help", channel_id: "chan-123" },
    ];
    const ac = new AbortController();
    let listCalls = 0;
    let currentNow = 100;
    const stub = installFetchStub((url) => {
      if (url.endsWith("/api/agentic/mm/channels")) {
        listCalls += 1;
        currentNow = listCalls >= 2 ? 1_000 : 100;
        return {
          body: {
            channels: [{ channel_id: "chan-123", channel_type: "direct" }],
            snoozed: listCalls === 1,
          },
        };
      }
      if (url.endsWith("/api/agentic/mm/channels/chan-123/events")) {
        return { body: {} };
      }
      if (url.endsWith("/api/agentic/mm/channels/chan-123/posts")) {
        queueMicrotask(() => ac.abort());
        return {
          body: {
            order: posts.map((p) => p.id),
            posts: Object.fromEntries(posts.map((p) => [p.id, p])),
          },
        };
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const received: InboundMessage[] = [];
    try {
      await runInboundPoller({
        client: makeClient(),
        account: makeAccount(),
        abortSignal: ac.signal,
        initialCursor: 150,
        pollIntervalMs: 1,
        now: () => currentNow,
        onInboundMessage: (msg) => {
          received.push(msg);
        },
      });
    } finally {
      stub.restore();
    }
    assert.deepEqual(received, []);
  });

  it("pauses inter-agent replies after 5 consecutive agent-authored turns", async () => {
    const posts: MattermostPost[] = Array.from({ length: 7 }, (_, i) => ({
      id: `agent-${i + 1}`,
      create_at: 200 + i,
      agent_id: "helper-agent",
      message: `agent turn ${i + 1}`,
      channel_id: "chan-123",
    }));
    const ac = new AbortController();
    let noticeBody: Record<string, unknown> | undefined;
    const stub = installFetchStub((url, init) => {
      if (url.endsWith("/api/agentic/mm/channels")) {
        return {
          body: {
            channels: [{ channel_id: "chan-123", channel_type: "direct" }],
            inter_agent_mode_enabled: true,
            inter_agent_message_limit: 5,
          },
        };
      }
      if (url.endsWith("/api/agentic/auth/challenge")) {
        return { body: { session_token: "s1", challenge: "known" } };
      }
      if (url.endsWith("/api/agentic/mm/channels/chan-123/posts") && init?.method === "POST") {
        noticeBody = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        ac.abort();
        return { body: { id: "notice" } };
      }
      return {
        body: {
          order: posts.map((p) => p.id),
          posts: Object.fromEntries(posts.map((p) => [p.id, p])),
        },
      };
    });
    const received: InboundMessage[] = [];
    try {
      await runInboundPoller({
        client: makeClient(),
        account: makeAccount({ knownAnswers: { known: "answer" } }),
        abortSignal: ac.signal,
        initialCursor: 150,
        pollIntervalMs: 1,
        onInboundMessage: (msg) => {
          received.push(msg);
        },
      });
    } finally {
      stub.restore();
    }
    assert.equal(received.length, 5);
    assert.equal(received.at(-1)?.postId, "agent-5");
    assert.deepEqual(noticeBody, {
      message: "@helper-agent Nice, but need human guidance to proceed.",
    });
  });

  it("does not reset the inter-agent pause counter for an untagged human message", async () => {
    const agentPosts: MattermostPost[] = Array.from({ length: 5 }, (_, i) => ({
      id: `agent-${i + 1}`,
      create_at: 200 + i,
      agent_id: "helper-agent",
      message: `agent turn ${i + 1}`,
      channel_id: "chan-123",
    }));
    const posts: MattermostPost[] = [
      ...agentPosts,
      {
        id: "human-untagged",
        create_at: 300,
        human_id: 1,
        message: "please continue",
        channel_id: "chan-123",
      },
      {
        id: "agent-after-untagged-human",
        create_at: 301,
        agent_id: "helper-agent",
        message: "agent turn after untagged human",
        channel_id: "chan-123",
      },
    ];
    const ac = new AbortController();
    let noticeBody: Record<string, unknown> | undefined;
    const stub = installFetchStub((url, init) => {
      if (url.endsWith("/api/agentic/mm/channels")) {
        return {
          body: {
            channels: [{ channel_id: "chan-123", channel_type: "direct" }],
            inter_agent_mode_enabled: true,
            inter_agent_message_limit: 5,
          },
        };
      }
      if (url.endsWith("/api/agentic/auth/challenge")) {
        return { body: { session_token: "s1", challenge: "known" } };
      }
      if (url.endsWith("/api/agentic/mm/channels/chan-123/posts") && init?.method === "POST") {
        noticeBody = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        ac.abort();
        return { body: { id: "notice" } };
      }
      return {
        body: {
          order: posts.map((p) => p.id),
          posts: Object.fromEntries(posts.map((p) => [p.id, p])),
        },
      };
    });
    const received: InboundMessage[] = [];
    try {
      await runInboundPoller({
        client: makeClient(),
        account: makeAccount({ knownAnswers: { known: "answer" } }),
        abortSignal: ac.signal,
        initialCursor: 150,
        pollIntervalMs: 1,
        onInboundMessage: (msg) => {
          received.push(msg);
        },
      });
    } finally {
      stub.restore();
    }
    assert.deepEqual(received.map((m) => m.postId), [
      ...agentPosts.map((p) => p.id),
      "human-untagged",
    ]);
    assert.deepEqual(noticeBody, {
      message: "@helper-agent Nice, but need human guidance to proceed.",
    });
  });

  it("resets the inter-agent pause counter only when a human tags this agent", async () => {
    const agentPosts: MattermostPost[] = Array.from({ length: 5 }, (_, i) => ({
      id: `agent-${i + 1}`,
      create_at: 200 + i,
      agent_id: "helper-agent",
      message: `agent turn ${i + 1}`,
      channel_id: "chan-123",
    }));
    const posts: MattermostPost[] = [
      ...agentPosts,
      {
        id: "human-reset",
        create_at: 300,
        human_id: 1,
        message: "@bot-agent please continue",
        channel_id: "chan-123",
      },
      {
        id: "agent-after-reset",
        create_at: 301,
        agent_id: "helper-agent",
        message: "agent turn after reset",
        channel_id: "chan-123",
      },
    ];
    const stub = installFetchStub((url) => {
      if (url.endsWith("/api/agentic/mm/channels")) {
        return {
          body: {
            channels: [{ channel_id: "chan-123", channel_type: "direct" }],
            inter_agent_mode_enabled: true,
            inter_agent_message_limit: 5,
          },
        };
      }
      return {
        body: {
          order: posts.map((p) => p.id),
          posts: Object.fromEntries(posts.map((p) => [p.id, p])),
        },
      };
    });
    const ac = new AbortController();
    const received: InboundMessage[] = [];
    try {
      await runInboundPoller({
        client: makeClient(),
        account: makeAccount(),
        abortSignal: ac.signal,
        initialCursor: 150,
        pollIntervalMs: 1,
        onInboundMessage: (msg) => {
          received.push(msg);
          if (received.length === 7) ac.abort();
        },
      });
    } finally {
      stub.restore();
    }
    assert.deepEqual(
      received.map((m) => m.postId),
      [...agentPosts.map((p) => p.id), "human-reset", "agent-after-reset"],
    );
  });

  it("filters system messages (non-empty type)", async () => {
    const posts: MattermostPost[] = [
      {
        id: "sys",
        create_at: 200,
        human_id: 1,
        message: "joined",
        channel_id: "chan-123",
        type: "system_join_channel",
      },
      { id: "msg", create_at: 300, human_id: 1, message: "yo", channel_id: "chan-123" },
    ];
    const stub = installFetchStub(() => ({
      body: {
        order: posts.map((p) => p.id),
        posts: Object.fromEntries(posts.map((p) => [p.id, p])),
      },
    }));
    const ac = new AbortController();
    const received: InboundMessage[] = [];
    try {
      await runInboundPoller({
        client: makeClient(),
        account: makeAccount(),
        abortSignal: ac.signal,
        initialCursor: 150,
        pollIntervalMs: 1,
        ownerHumanIds: new Set([1]),
        onInboundMessage: (msg) => {
          received.push(msg);
          ac.abort();
        },
      });
    } finally {
      stub.restore();
    }
    assert.deepEqual(
      received.map((m) => m.postId),
      ["msg"],
    );
  });

  it("skips deleted posts", async () => {
    const posts: MattermostPost[] = [
      {
        id: "del",
        create_at: 200,
        human_id: 1,
        message: "gone",
        channel_id: "chan-123",
        delete_at: 210,
      },
      { id: "live", create_at: 300, human_id: 1, message: "stays", channel_id: "chan-123" },
    ];
    const stub = installFetchStub(() => ({
      body: {
        order: posts.map((p) => p.id),
        posts: Object.fromEntries(posts.map((p) => [p.id, p])),
      },
    }));
    const ac = new AbortController();
    const received: InboundMessage[] = [];
    try {
      await runInboundPoller({
        client: makeClient(),
        account: makeAccount(),
        abortSignal: ac.signal,
        initialCursor: 150,
        pollIntervalMs: 1,
        ownerHumanIds: new Set([1]),
        onInboundMessage: (msg) => {
          received.push(msg);
          ac.abort();
        },
      });
    } finally {
      stub.restore();
    }
    assert.deepEqual(
      received.map((m) => m.postId),
      ["live"],
    );
  });

  it("honors seenPostIds to suppress outbound echoes", async () => {
    const posts: MattermostPost[] = [
      { id: "p1", create_at: 200, human_id: 1, message: "seen", channel_id: "chan-123" },
      { id: "p2", create_at: 300, human_id: 1, message: "new", channel_id: "chan-123" },
    ];
    const stub = installFetchStub(() => ({
      body: {
        order: posts.map((p) => p.id),
        posts: Object.fromEntries(posts.map((p) => [p.id, p])),
      },
    }));
    const ac = new AbortController();
    const received: InboundMessage[] = [];
    try {
      await runInboundPoller({
        client: makeClient(),
        account: makeAccount(),
        abortSignal: ac.signal,
        initialCursor: 150,
        pollIntervalMs: 1,
        seenPostIds: new Set(["p1"]),
        ownerHumanIds: new Set([1]),
        onInboundMessage: (msg) => {
          received.push(msg);
          ac.abort();
        },
      });
    } finally {
      stub.restore();
    }
    assert.deepEqual(
      received.map((m) => m.postId),
      ["p2"],
    );
  });

  it("does not re-dispatch the same post on a second poll pass", async () => {
    const posts: MattermostPost[] = [
      { id: "only", create_at: 200, human_id: 1, message: "once", channel_id: "chan-123" },
    ];
    let passes = 0;
    const stub = installFetchStub(() => {
      passes += 1;
      return {
        body: {
          order: posts.map((p) => p.id),
          posts: Object.fromEntries(posts.map((p) => [p.id, p])),
        },
      };
    });
    const ac = new AbortController();
    const received: InboundMessage[] = [];
    const done = runInboundPoller({
      client: makeClient(),
      account: makeAccount(),
      abortSignal: ac.signal,
      initialCursor: 150,
      pollIntervalMs: 1,
      ownerHumanIds: new Set([1]),
        onInboundMessage: (msg) => {
        received.push(msg);
      },
    });
    // Wait until we have at least 3 poll passes so the cursor has definitely
    // advanced past `only` on pass 1 and held through passes 2 and 3.
    while (passes < 3 && !ac.signal.aborted) {
      await new Promise((r) => setTimeout(r, 5));
    }
    ac.abort();
    await done;
    stub.restore();
    assert.deepEqual(
      received.map((m) => m.postId),
      ["only"],
      "same post must not dispatch twice across repeated polls",
    );
    assert.ok(passes >= 3);
  });

  it("keeps running after a transient network error and logs it", async () => {
    let callCount = 0;
    const stub = installFetchStub(() => {
      callCount += 1;
      if (callCount === 1) throw new Error("network flap");
      return {
        body: {
          order: ["p1"],
          posts: {
            p1: { id: "p1", create_at: 300, human_id: 1, message: "recovered", channel_id: "chan-123" },
          },
        },
      };
    });
    const ac = new AbortController();
    const received: InboundMessage[] = [];
    const warns: string[] = [];
    try {
      await runInboundPoller({
        client: makeClient(),
        account: makeAccount(),
        abortSignal: ac.signal,
        initialCursor: 150,
        pollIntervalMs: 1,
        log: { warn: (m) => warns.push(m) },
        ownerHumanIds: new Set([1]),
        onInboundMessage: (msg) => {
          received.push(msg);
          ac.abort();
        },
      });
    } finally {
      stub.restore();
    }
    // Either path can carry the transient error: ``listChannels failed``
    // (the new fan-out path) or ``inbound poll failed`` (the per-channel
    // fetch). We just need proof that the poller noticed and kept going.
    assert.ok(
      warns.some(
        (l) => l.includes("inbound poll failed") || l.includes("listChannels failed"),
      ),
    );
    assert.deepEqual(
      received.map((m) => m.postId),
      ["p1"],
    );
  });

  it("auto-dispatches in a discovered direct channel without an @mention", async () => {
    // listChannels returns a non-fallback direct channel. A plain user post
    // there should be picked up because direct == 1:1 surface; the mention
    // gate is dropped. The fallback chan-123 is NOT in the listing.
    const posts: MattermostPost[] = [
      { id: "p1", create_at: 200, human_id: 1, message: "hey", channel_id: "dm-with-bot" },
    ];
    const stub = installFetchStub((url) => {
      if (url.endsWith("/api/agentic/mm/channels")) {
        return {
          body: {
            channels: [
              { channel_id: "dm-with-bot", channel_type: "direct" },
            ],
          },
        };
      }
      return {
        body: {
          order: posts.map((p) => p.id),
          posts: Object.fromEntries(posts.map((p) => [p.id, p])),
        },
      };
    });
    const ac = new AbortController();
    const received: InboundMessage[] = [];
    try {
      await runInboundPoller({
        client: makeClient(),
        account: makeAccount(),
        abortSignal: ac.signal,
        initialCursor: 150,
        pollIntervalMs: 1,
        ownerHumanIds: new Set([1]),
        onInboundMessage: (msg) => {
          received.push(msg);
          ac.abort();
        },
      });
    } finally {
      stub.restore();
    }
    assert.deepEqual(
      received.map((m) => m.postId),
      ["p1"],
    );
    assert.equal(received[0]?.channelId, "dm-with-bot");
  });

  it("blocks addressed inbound posts from senders outside non-empty allowFrom", async () => {
    const posts: MattermostPost[] = [
      { id: "blocked", create_at: 200, human_id: 1, message: "nope", channel_id: "chan-123" },
      { id: "allowed", create_at: 300, human_id: 2, message: "yes", channel_id: "chan-123" },
    ];
    const stub = installFetchStub((url) => {
      if (url.endsWith("/api/agentic/mm/channels")) {
        return {
          body: {
            channels: [{ channel_id: "chan-123", channel_type: "direct" }],
          },
        };
      }
      return {
        body: {
          order: posts.map((p) => p.id),
          posts: Object.fromEntries(posts.map((p) => [p.id, p])),
        },
      };
    });
    const ac = new AbortController();
    const received: InboundMessage[] = [];
    const warnings: string[] = [];
    try {
      await runInboundPoller({
        client: makeClient(),
        account: makeAccount({ allowFrom: ["human:2"] }),
        abortSignal: ac.signal,
        initialCursor: 150,
        pollIntervalMs: 1,
        log: { warn: (msg) => warnings.push(msg) },
        onInboundMessage: (msg) => {
          received.push(msg);
          ac.abort();
        },
      });
    } finally {
      stub.restore();
    }
    assert.deepEqual(
      received.map((m) => m.postId),
      ["allowed"],
    );
    assert.ok(
      warnings.some((msg) => msg.includes("inbound blocked by allowFrom sender=human:1")),
      "blocked sender is logged",
    );
  });

  it("treats empty allowFrom as allow-all", async () => {
    const posts: MattermostPost[] = [
      { id: "human", create_at: 200, human_id: 1, message: "hello", channel_id: "chan-123" },
    ];
    const stub = installFetchStub((url) => {
      if (url.endsWith("/api/agentic/mm/channels")) {
        return {
          body: {
            channels: [{ channel_id: "chan-123", channel_type: "direct" }],
          },
        };
      }
      return {
        body: {
          order: posts.map((p) => p.id),
          posts: Object.fromEntries(posts.map((p) => [p.id, p])),
        },
      };
    });
    const ac = new AbortController();
    const received: InboundMessage[] = [];
    try {
      await runInboundPoller({
        client: makeClient(),
        account: makeAccount({ allowFrom: [] }),
        abortSignal: ac.signal,
        initialCursor: 150,
        pollIntervalMs: 1,
        onInboundMessage: (msg) => {
          received.push(msg);
          ac.abort();
        },
      });
    } finally {
      stub.restore();
    }
    assert.deepEqual(
      received.map((m) => m.postId),
      ["human"],
    );
  });

  it("requires an @mention in non-direct channels discovered via listChannels", async () => {
    // A public/group channel returned by listChannels. The bot is a member
    // but the post doesn't mention @bot-agent — dispatch must be skipped.
    const posts: MattermostPost[] = [
      { id: "no-mention", create_at: 200, human_id: 1, message: "general chatter", channel_id: "team-room" },
      {
        id: "mentioned",
        create_at: 300,
        human_id: 1,
        message: "@bot-agent @bot-agent please help",
        channel_id: "team-room",
      }
    ];
    const stub = installFetchStub((url) => {
      if (url.endsWith("/api/agentic/mm/channels")) {
        return {
          body: {
            channels: [
              { channel_id: "team-room", channel_type: "public" },
            ],
          },
        };
      }
      return {
        body: {
          order: posts.map((p) => p.id),
          posts: Object.fromEntries(posts.map((p) => [p.id, p])),
        },
      };
    });
    const ac = new AbortController();
    const received: InboundMessage[] = [];
    try {
      await runInboundPoller({
        client: makeClient(),
        account: makeAccount(),
        abortSignal: ac.signal,
        initialCursor: 150,
        pollIntervalMs: 1,
        ownerHumanIds: new Set([1]),
        onInboundMessage: (msg) => {
          received.push(msg);
          ac.abort();
        },
      });
    } finally {
      stub.restore();
    }
    // Only the mentioned post dispatches; the un-mentioned one is filtered.
    assert.deepEqual(
      received.map((m) => m.postId),
      ["mentioned"],
    );
    assert.equal(received[0]?.text, "@bot-agent please help");
  });

  it("aborts cleanly on abortSignal mid-sleep without pending dispatches", async () => {
    const stub = installFetchStub(() => ({ body: { order: [], posts: {} } }));
    const ac = new AbortController();
    let dispatches = 0;
    const done = runInboundPoller({
      client: makeClient(),
      account: makeAccount(),
      abortSignal: ac.signal,
      initialCursor: 1000,
      // Long interval so we spend most time in the sleep.
      pollIntervalMs: 100_000,
      ownerHumanIds: new Set([1]),
      onInboundMessage: () => {
        dispatches += 1;
      },
    });
    // Let the first poll run, then abort mid-sleep.
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await done;
    stub.restore();
    assert.equal(dispatches, 0);
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
  // A public channel where the agent does NOT require response approval and a
  // backlog budget is configured. Two un-mentioned chatter posts precede a
  // mention; the dispatched mention should carry both as read-only context.
  const posts: MattermostPost[] = [
    { id: "c1", create_at: 200, human_id: 1, message: "anyone around?", channel_id: "team-room" },
    { id: "c2", create_at: 250, human_id: 2, message: "deploy is green", channel_id: "team-room" },
    { id: "m1", create_at: 300, human_id: 1, message: "@bot-agent status?", channel_id: "team-room" },
    { id: "m2", create_at: 400, human_id: 1, message: "@bot-agent and now?", channel_id: "team-room" },
  ];

  function stubFor(requireApproval: boolean) {
    return installFetchStub((url) => {
      if (url.endsWith("/api/agentic/mm/channels")) {
        return {
          body: {
            channels: [{ channel_id: "team-room", channel_type: "public" }],
            require_response_approval: requireApproval,
          },
        };
      }
      // Posts endpoint (with or without ?limit) returns the full set.
      return {
        body: {
          order: posts.map((p) => p.id),
          posts: Object.fromEntries(posts.map((p) => [p.id, p])),
        },
      };
    });
  }

  it("catches up on new messages on every mention (watermark dedupes)", async () => {
    // c1/c2 precede the first tag; c3 arrives between the two tags. Each tag
    // should surface only what's new since the agent last looked — never a
    // re-read.
    const set: MattermostPost[] = [
      { id: "c1", create_at: 200, human_id: 1, message: "anyone around?", channel_id: "team-room" },
      { id: "c2", create_at: 250, human_id: 2, message: "deploy is green", channel_id: "team-room" },
      { id: "m1", create_at: 300, human_id: 1, message: "@bot-agent status?", channel_id: "team-room" },
      { id: "c3", create_at: 350, human_id: 2, message: "build finished", channel_id: "team-room" },
      { id: "m2", create_at: 400, human_id: 1, message: "@bot-agent and now?", channel_id: "team-room" },
    ];
    const stub = installFetchStub((url) => {
      if (url.endsWith("/api/agentic/mm/channels")) {
        return {
          body: {
            channels: [{ channel_id: "team-room", channel_type: "public" }],
            require_response_approval: false,
          },
        };
      }
      return {
        body: {
          order: set.map((p) => p.id),
          posts: Object.fromEntries(set.map((p) => [p.id, p])),
        },
      };
    });
    const ac = new AbortController();
    const received: InboundMessage[] = [];
    try {
      await runInboundPoller({
        client: makeClient(),
        account: makeAccount({ channelContextBacklog: 50 }),
        abortSignal: ac.signal,
        initialCursor: 150,
        pollIntervalMs: 1,
        watermarkStore: ChannelWatermarkStore.inMemory(),
        onInboundMessage: (msg) => {
          received.push(msg);
          if (received.length >= 2) ac.abort();
        },
      });
    } finally {
      stub.restore();
    }
    assert.deepEqual(
      received.map((m) => m.postId),
      ["m1", "m2"],
    );
    assert.deepEqual(
      received[0]?.priorContext?.map((p) => p.postId),
      ["c1", "c2"],
      "first tag catches up on prior chatter",
    );
    assert.deepEqual(
      received[1]?.priorContext?.map((p) => p.postId),
      ["c3"],
      "second tag surfaces only the message since the first tag — not re-reading c1/c2/m1",
    );
  });

  it("gathers backlog regardless of the agent's response-approval flag", async () => {
    // `require_response_approval: true` no longer suppresses context ingestion —
    // that flag governs the inbound approval workflow, not the backlog.
    const stub = stubFor(true);
    const ac = new AbortController();
    const received: InboundMessage[] = [];
    try {
      await runInboundPoller({
        client: makeClient(),
        account: makeAccount({ channelContextBacklog: 50 }),
        abortSignal: ac.signal,
        initialCursor: 150,
        pollIntervalMs: 1,
        watermarkStore: ChannelWatermarkStore.inMemory(),
        onInboundMessage: (msg) => {
          received.push(msg);
          ac.abort();
        },
      });
    } finally {
      stub.restore();
    }
    assert.equal(received[0]?.postId, "m1");
    assert.deepEqual(
      received[0]?.priorContext?.map((p) => p.postId),
      ["c1", "c2"],
      "backlog gathered even when require_response_approval is true",
    );
  });

  it("does not gather backlog when the budget is zero", async () => {
    const stub = stubFor(false);
    const ac = new AbortController();
    const received: InboundMessage[] = [];
    try {
      await runInboundPoller({
        client: makeClient(),
        account: makeAccount({ channelContextBacklog: 0 }),
        abortSignal: ac.signal,
        initialCursor: 150,
        pollIntervalMs: 1,
        onInboundMessage: (msg) => {
          received.push(msg);
          ac.abort();
        },
      });
    } finally {
      stub.restore();
    }
    assert.equal(received[0]?.priorContext, undefined, "backlog disabled → no context");
  });

  it("gathers backlog for the configured fallback channel when discovery says it is public", async () => {
    const stub = stubFor(false);
    const ac = new AbortController();
    const received: InboundMessage[] = [];
    try {
      await runInboundPoller({
        client: makeClient(),
        account: makeAccount({ channelId: "team-room", channelContextBacklog: 50 }),
        abortSignal: ac.signal,
        initialCursor: 150,
        pollIntervalMs: 1,
        onInboundMessage: (msg) => {
          received.push(msg);
          ac.abort();
        },
      });
    } finally {
      stub.restore();
    }
    assert.equal(received[0]?.postId, "m1");
    assert.deepEqual(
      received[0]?.priorContext?.map((p) => p.postId),
      ["c1", "c2"],
      "configured public channel is not treated as fallback operator DM",
    );
  });

  it("does not re-read history across a restart (persisted watermark)", async () => {
    // A watermark store shared across two poller lifetimes simulates a
    // gateway restart: the store survives, the in-memory dedupe does not.
    const store = ChannelWatermarkStore.inMemory();

    function runWith(set: MattermostPost[], initialCursor: number) {
      const stub = installFetchStub((url) => {
        if (url.endsWith("/api/agentic/mm/channels")) {
          return {
            body: {
              channels: [{ channel_id: "team-room", channel_type: "public" }],
              require_response_approval: false,
            },
          };
        }
        return {
          body: {
            order: set.map((p) => p.id),
            posts: Object.fromEntries(set.map((p) => [p.id, p])),
          },
        };
      });
      const ac = new AbortController();
      const received: InboundMessage[] = [];
      return runInboundPoller({
        client: makeClient(),
        account: makeAccount({ channelContextBacklog: 50 }),
        abortSignal: ac.signal,
        initialCursor,
        pollIntervalMs: 1,
        watermarkStore: store,
        onInboundMessage: (msg) => {
          received.push(msg);
          ac.abort();
        },
      })
        .then(() => received)
        .finally(() => stub.restore());
    }

    // Run 1: first mention m1 catches up on c1 + c2; watermark advances to 300.
    const run1 = await runWith(
      [
        { id: "c1", create_at: 200, human_id: 1, message: "anyone around?", channel_id: "team-room" },
        { id: "c2", create_at: 250, human_id: 2, message: "deploy is green", channel_id: "team-room" },
        { id: "m1", create_at: 300, human_id: 1, message: "@bot-agent status?", channel_id: "team-room" },
      ],
      150,
    );
    assert.deepEqual(
      run1[0]?.priorContext?.map((p) => p.postId),
      ["c1", "c2"],
    );

    // Run 2 (restart): a new untagged post c3 then a new mention m2. The
    // backlog must contain ONLY c3 — c1/c2/m1 were already shown (<= watermark).
    const run2 = await runWith(
      [
        { id: "c1", create_at: 200, human_id: 1, message: "anyone around?", channel_id: "team-room" },
        { id: "c2", create_at: 250, human_id: 2, message: "deploy is green", channel_id: "team-room" },
        { id: "m1", create_at: 300, human_id: 1, message: "@bot-agent status?", channel_id: "team-room" },
        { id: "c3", create_at: 350, human_id: 2, message: "build finished", channel_id: "team-room" },
        { id: "m2", create_at: 400, human_id: 1, message: "@bot-agent and now?", channel_id: "team-room" },
      ],
      320,
    );
    assert.equal(run2[0]?.postId, "m2");
    assert.deepEqual(
      run2[0]?.priorContext?.map((p) => p.postId),
      ["c3"],
      "only the message that arrived since the last seen post is surfaced",
    );
  });

  it("dispatches post.created over the agent WebSocket without per-channel SSE or post polling", async () => {
    const post = {
      id: "ws-1",
      create_at: 200,
      human_id: 1,
      message: "hello over ws",
      channel_id: "chan-123",
    };
    const event = { type: "post.created", channel_id: "chan-123", data: post };
    const originalWebSocket = globalThis.WebSocket;
    const sockets: Array<{
      url: string;
      emit: (type: string, event: unknown) => void;
      close: () => void;
    }> = [];
    class MockWebSocket {
      url: string;
      #listeners = new Map<string, Set<(event: unknown) => void>>();
      constructor(url: string) {
        this.url = url;
        sockets.push(this);
        queueMicrotask(() => {
          this.emit("open", {});
          this.emit("message", { data: JSON.stringify(event) });
        });
      }
      addEventListener(type: string, listener: (event: unknown) => void): void {
        const listeners = this.#listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.#listeners.set(type, listeners);
      }
      removeEventListener(type: string, listener: (event: unknown) => void): void {
        this.#listeners.get(type)?.delete(listener);
      }
      close(): void {
        this.emit("close", { code: 1000, reason: "" });
      }
      emit(type: string, event: unknown): void {
        for (const listener of this.#listeners.get(type) ?? []) listener(event);
      }
    }
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

    const stub = installFetchStub((url) => {
      if (url.endsWith("/api/agentic/mm/channels")) {
        return {
          body: { channels: [{ channel_id: "chan-123", channel_type: "direct" }] },
        };
      }
      throw new Error(`unexpected fallback request while websocket is primary: ${url}`);
    });

    const ac = new AbortController();
    const received: InboundMessage[] = [];
    try {
      await runInboundPoller({
        client: new ClawBitsClient({ endpoint: "http://fc.example/base", apiKey: "test-key" }),
        account: makeAccount({
          endpoint: "http://fc.example/base",
          config: { websocketEnabled: true },
        }),
        abortSignal: ac.signal,
        initialCursor: 150,
        pollIntervalMs: 10_000,
        onInboundMessage: (msg) => {
          received.push(msg);
          ac.abort();
        },
      });
    } finally {
      stub.restore();
      globalThis.WebSocket = originalWebSocket;
    }

    assert.deepEqual(received.map((m) => m.postId), ["ws-1"]);
    assert.equal(sockets.length, 1);
    assert.ok(sockets[0]!.url.startsWith("ws://fc.example/base/api/agentic/mm/events/ws"));
    assert.equal(
      stub.calls.some((url) => url.includes("/api/agentic/mm/channels/chan-123/events")),
      false,
    );
    assert.equal(
      stub.calls.some((url) => url.includes("/api/agentic/mm/channels/chan-123/posts")),
      false,
    );
  });

  // `mutualist.consider` is the pre-rename name for the same control event and
  // is still accepted, so a server that hasn't been redeployed yet keeps
  // nudging agents on this build. Both names must behave identically.
  for (const eventType of ["lobstertalk.consider", "mutualist.consider"]) {
    it(`dispatches a ${eventType} nudge for an un-mentioned channel post as an attention turn`, async () => {
      // Public channel, no @mention: without the nudge this post would be backlog
      // only. The consider control event must force it to dispatch and
      // flag it `attention` so the agent is framed reply-only-if-useful.
      const post = {
        id: "ws-att-1",
        create_at: 200,
        human_id: 1,
        message: "anyone know how to reset the widget?",
        channel_id: "chan-123",
      };
      const event = { type: eventType, channel_id: "chan-123", data: post };
      const originalWebSocket = globalThis.WebSocket;
      class MockWebSocket {
        url: string;
        #listeners = new Map<string, Set<(event: unknown) => void>>();
        constructor(url: string) {
          this.url = url;
          queueMicrotask(() => {
            this.emit("open", {});
            this.emit("message", { data: JSON.stringify(event) });
          });
        }
        addEventListener(type: string, listener: (event: unknown) => void): void {
          const listeners = this.#listeners.get(type) ?? new Set();
          listeners.add(listener);
          this.#listeners.set(type, listeners);
        }
        removeEventListener(type: string, listener: (event: unknown) => void): void {
          this.#listeners.get(type)?.delete(listener);
        }
        close(): void {
          this.emit("close", { code: 1000, reason: "" });
        }
        emit(type: string, event: unknown): void {
          for (const listener of this.#listeners.get(type) ?? []) listener(event);
        }
      }
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const stub = installFetchStub((url) => {
        if (url.endsWith("/api/agentic/mm/channels")) {
          return { body: { channels: [{ channel_id: "chan-123", channel_type: "public" }] } };
        }
        if (url.includes("/api/agentic/mm/channels/chan-123/posts")) {
          return { body: { posts: [] } };
        }
        return { body: {} };
      });

      const ac = new AbortController();
      const received: InboundMessage[] = [];
      try {
        await runInboundPoller({
          client: new ClawBitsClient({ endpoint: "http://fc.example/base", apiKey: "test-key" }),
          account: makeAccount({
            endpoint: "http://fc.example/base",
            config: { websocketEnabled: true },
          }),
          abortSignal: ac.signal,
          initialCursor: 150,
          pollIntervalMs: 10_000,
          onInboundMessage: (msg) => {
            received.push(msg);
            ac.abort();
          },
        });
      } finally {
        stub.restore();
        globalThis.WebSocket = originalWebSocket;
      }

      assert.deepEqual(received.map((m) => m.postId), ["ws-att-1"]);
      assert.equal(received[0]!.attention, true);
    });
  }

  it("learns a WebSocket-pushed channel.added before dispatching a new-channel post", async () => {
    const addedChannel = {
      channel_id: "chan-new",
      channel_type: "direct",
      display_name: "new dm",
    };
    const post = {
      id: "ws-new-channel",
      create_at: 220,
      human_id: 1,
      message: "hello on new channel",
      channel_id: "chan-new",
    };
    const originalWebSocket = globalThis.WebSocket;
    class MockWebSocket {
      #listeners = new Map<string, Set<(event: unknown) => void>>();
      constructor(_url: string) {
        queueMicrotask(() => {
          this.emit("open", {});
          this.emit("message", {
            data: JSON.stringify({
              type: "channel.added",
              channel_id: "chan-new",
              data: addedChannel,
            }),
          });
          this.emit("message", {
            data: JSON.stringify({ type: "post.created", channel_id: "chan-new", data: post }),
          });
        });
      }
      addEventListener(type: string, listener: (event: unknown) => void): void {
        const listeners = this.#listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.#listeners.set(type, listeners);
      }
      removeEventListener(type: string, listener: (event: unknown) => void): void {
        this.#listeners.get(type)?.delete(listener);
      }
      close(): void {
        this.emit("close", { code: 1000, reason: "" });
      }
      emit(type: string, event: unknown): void {
        for (const listener of this.#listeners.get(type) ?? []) listener(event);
      }
    }
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

    const stub = installFetchStub((url) => {
      if (url.endsWith("/api/agentic/mm/channels")) {
        return { body: { channels: [{ channel_id: "chan-123", channel_type: "direct" }] } };
      }
      throw new Error(`unexpected request while websocket is primary: ${url}`);
    });

    const ac = new AbortController();
    const received: InboundMessage[] = [];
    try {
      await runInboundPoller({
        client: makeClient(),
        account: makeAccount({ config: { websocketEnabled: true } }),
        abortSignal: ac.signal,
        initialCursor: 150,
        pollIntervalMs: 10_000,
        onInboundMessage: (msg) => {
          received.push(msg);
          ac.abort();
        },
      });
    } finally {
      stub.restore();
      globalThis.WebSocket = originalWebSocket;
    }

    assert.deepEqual(received.map((m) => m.postId), ["ws-new-channel"]);
  });

  it("does not refresh channel control on every fallback tick while WebSocket is healthy", async () => {
    const originalWebSocket = globalThis.WebSocket;
    class MockWebSocket {
      #listeners = new Map<string, Set<(event: unknown) => void>>();
      constructor(_url: string) {
        queueMicrotask(() => this.emit("open", {}));
      }
      addEventListener(type: string, listener: (event: unknown) => void): void {
        const listeners = this.#listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.#listeners.set(type, listeners);
      }
      removeEventListener(type: string, listener: (event: unknown) => void): void {
        this.#listeners.get(type)?.delete(listener);
      }
      close(): void {
        this.emit("close", { code: 1000, reason: "" });
      }
      emit(type: string, event: unknown): void {
        for (const listener of this.#listeners.get(type) ?? []) listener(event);
      }
    }
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

    let channelListCalls = 0;
    let postPolls = 0;
    const stub = installFetchStub((url) => {
      if (url.endsWith("/api/agentic/mm/channels")) {
        channelListCalls += 1;
        return {
          body: { channels: [{ channel_id: "chan-123", channel_type: "direct" }] },
        };
      }
      if (url.endsWith("/api/agentic/mm/channels/chan-123/posts")) {
        postPolls += 1;
        return { body: { order: [], posts: {} } };
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 25);
    try {
      await runInboundPoller({
        client: makeClient(),
        account: makeAccount({ config: { websocketEnabled: true } }),
        abortSignal: ac.signal,
        initialCursor: 150,
        pollIntervalMs: 1,
        websocketReconcileIntervalMs: 60_000,
        websocketControlRefreshIntervalMs: 60_000,
        onInboundMessage: () => {},
      });
    } finally {
      clearTimeout(timer);
      stub.restore();
      globalThis.WebSocket = originalWebSocket;
    }

    assert.equal(channelListCalls, 1);
    assert.ok(postPolls <= 1, "post reconcile should not run on every fallback tick either");
  });

  it("uses rare WebSocket reconcile to recover an unseen post older than the cursor", async () => {
    const missed = {
      id: "missed-human",
      create_at: 200,
      human_id: 1,
      message: "@bot-agent missed this",
      channel_id: "chan-123",
    };
    const selfLater = {
      id: "self-later",
      create_at: 300,
      agent_id: "bot-agent",
      message: "self echo",
      channel_id: "chan-123",
    };
    const originalWebSocket = globalThis.WebSocket;
    let socket: { emit: (type: string, event: unknown) => void } | undefined;
    class MockWebSocket {
      #listeners = new Map<string, Set<(event: unknown) => void>>();
      constructor(_url: string) {
        socket = this;
        queueMicrotask(() => this.emit("open", {}));
      }
      addEventListener(type: string, listener: (event: unknown) => void): void {
        const listeners = this.#listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.#listeners.set(type, listeners);
      }
      removeEventListener(type: string, listener: (event: unknown) => void): void {
        this.#listeners.get(type)?.delete(listener);
      }
      close(): void {
        this.emit("close", { code: 1000, reason: "" });
      }
      emit(type: string, event: unknown): void {
        for (const listener of this.#listeners.get(type) ?? []) listener(event);
      }
    }
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

    const ac = new AbortController();
    let postPolls = 0;
    const stub = installFetchStub((url) => {
      if (url.endsWith("/api/agentic/mm/channels")) {
        return {
          body: { channels: [{ channel_id: "chan-123", channel_type: "direct" }] },
        };
      }
      if (url.endsWith("/api/agentic/mm/channels/chan-123/posts")) {
        postPolls += 1;
        if (postPolls === 1) {
          queueMicrotask(() => {
            socket?.emit("message", {
              data: JSON.stringify({ type: "post.created", channel_id: "chan-123", data: selfLater }),
            });
            socket?.emit("message", { data: JSON.stringify({ type: "resync_required" }) });
          });
          return { body: { order: [], posts: {} } };
        }
        return {
          body: {
            order: [missed.id, selfLater.id],
            posts: { [missed.id]: missed, [selfLater.id]: selfLater },
          },
        };
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const received: InboundMessage[] = [];
    try {
      await runInboundPoller({
        client: makeClient(),
        account: makeAccount({ config: { websocketEnabled: true } }),
        abortSignal: ac.signal,
        initialCursor: 150,
        pollIntervalMs: 1,
        websocketReconcileIntervalMs: 60_000,
        onInboundMessage: (msg) => {
          received.push(msg);
          ac.abort();
        },
      });
    } finally {
      stub.restore();
      globalThis.WebSocket = originalWebSocket;
    }

    assert.deepEqual(received.map((m) => m.postId), ["missed-human"]);
    assert.equal(postPolls, 2);
  });

  it("serializes back-to-back SSE dispatches so one agent turn runs at a time", async () => {
    const posts = [
      {
        id: "sse-1",
        create_at: 200,
        human_id: 1,
        message: "first",
        channel_id: "chan-123",
      },
      {
        id: "sse-2",
        create_at: 201,
        human_id: 1,
        message: "second",
        channel_id: "chan-123",
      },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input);
      if (url.endsWith("/api/agentic/mm/channels")) {
        return new Response(
          JSON.stringify({ channels: [{ channel_id: "chan-123", channel_type: "direct" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/agentic/mm/channels/chan-123/events")) {
        const stream = new ReadableStream({
          start(controller) {
            for (const post of posts) {
              const event = { type: "post.created", channel_id: "chan-123", data: post };
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
            }
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ order: [], posts: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const ac = new AbortController();
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    try {
      await runInboundPoller({
        client: makeClient(),
        account: makeAccount(),
        abortSignal: ac.signal,
        initialCursor: 150,
        pollIntervalMs: 10_000,
        websocketEnabled: false,
        onInboundMessage: async (msg) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          order.push(msg.postId);
          if (msg.postId === "sse-1") {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          active -= 1;
          if (order.length >= 2) ac.abort();
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.deepEqual(order, ["sse-1", "sse-2"]);
    assert.equal(maxActive, 1);
  });

  it("expires queued SSE posts that wait past the inbound queue TTL", async () => {
    const posts = [
      {
        id: "sse-1",
        create_at: 200,
        human_id: 1,
        message: "first",
        channel_id: "chan-123",
      },
      {
        id: "sse-2",
        create_at: 201,
        human_id: 1,
        message: "second",
        channel_id: "chan-123",
      },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input);
      if (url.endsWith("/api/agentic/mm/channels")) {
        return new Response(
          JSON.stringify({ channels: [{ channel_id: "chan-123", channel_type: "direct" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/agentic/mm/channels/chan-123/events")) {
        const stream = new ReadableStream({
          start(controller) {
            for (const post of posts) {
              const event = { type: "post.created", channel_id: "chan-123", data: post };
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
            }
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ order: [], posts: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const ac = new AbortController();
    const received: InboundMessage[] = [];
    const warnings: string[] = [];
    let currentNow = 0;
    const failTimer = setTimeout(() => ac.abort(), 500);
    try {
      await runInboundPoller({
        client: makeClient(),
        account: makeAccount(),
        abortSignal: ac.signal,
        initialCursor: 150,
        pollIntervalMs: 10_000,
        websocketEnabled: false,
        inboundQueueTtlMs: 5,
        now: () => currentNow,
        log: {
          warn: (msg) => {
            warnings.push(msg);
            if (msg.includes("inbound queue expired sse-2")) ac.abort();
          },
        },
        onInboundMessage: async (msg) => {
          received.push(msg);
          if (msg.postId === "sse-1") {
            await new Promise((resolve) => setTimeout(resolve, 20));
            currentNow = 20;
          }
        },
      });
    } finally {
      clearTimeout(failTimer);
      globalThis.fetch = originalFetch;
    }

    assert.deepEqual(received.map((m) => m.postId), ["sse-1"]);
    assert.ok(
      warnings.some((msg) => msg.includes("inbound queue expired sse-2")),
      "second SSE post expired in the queue",
    );
  });

  it("dispatches post.created over SSE without waiting for the next poll", async () => {
    const post = {
      id: "sse-1",
      create_at: 200,
      human_id: 1,
      message: "hello over sse",
      channel_id: "chan-123",
    };
    const event = { type: "post.created", channel_id: "chan-123", data: post };
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input);
      calls.push(url);
      if (url.endsWith("/api/agentic/mm/channels")) {
        return new Response(
          JSON.stringify({ channels: [{ channel_id: "chan-123", channel_type: "direct" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/agentic/mm/channels/chan-123/events")) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ order: [], posts: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const ac = new AbortController();
    const received: InboundMessage[] = [];
    try {
      await runInboundPoller({
        client: makeClient(),
        account: makeAccount(),
        abortSignal: ac.signal,
        initialCursor: 150,
        pollIntervalMs: 10_000,
        websocketEnabled: false,
        onInboundMessage: (msg) => {
          received.push(msg);
          ac.abort();
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.deepEqual(received.map((m) => m.postId), ["sse-1"]);
    assert.ok(calls.some((url) => url.endsWith("/api/agentic/mm/channels/chan-123/events")));
  });

});
