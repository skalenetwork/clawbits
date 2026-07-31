import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ClawBitsClient } from "../src/client.js";
import {
  buildEmailTurnText,
  buildReplyThreadingHeaders,
  dispatchInboundEmail,
  isSelfAddressed,
  replySubject,
} from "../src/email-adapter.js";
import type { EmailInboundMessage } from "../src/email-poller.js";
import type { ResolvedClawBitsAccount } from "../src/types.js";

function makeAccount(overrides: Partial<ResolvedClawBitsAccount> = {}): ResolvedClawBitsAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    endpoint: "http://h.example",
    agentId: "a1",
    apiKey: "k1",
    channelId: "ch1",
    knownAnswers: {},
    interAgentMode: false,
    interAgentMessageLimit: 10,
    groupChannelShimmer: true,
    channelContextBacklog: 100,
    alivePingMs: 0,
    emailEnabled: true,
    emailPollIntervalMs: 30000,
    config: {},
    ...overrides,
  };
}

function makeEmail(overrides: Partial<EmailInboundMessage> = {}): EmailInboundMessage {
  return {
    accountId: "default",
    uid: 7,
    fromAddr: "owner@example.com",
    toAddr: "a1@clawbits.ai",
    subject: "Quarterly numbers",
    date: "Thu, 19 Mar 2026 10:25:00 +0000",
    bodyText: "Please send the latest figures.",
    attachments: [],
    headers: {},
    ...overrides,
  };
}

describe("replySubject", () => {
  it("prefixes Re: and does not double-prefix", () => {
    assert.equal(replySubject("Hello"), "Re: Hello");
    assert.equal(replySubject("Re: Hello"), "Re: Hello");
    assert.equal(replySubject("RE: Hello"), "RE: Hello");
    assert.equal(replySubject(""), "Re: (no subject)");
  });
});

describe("buildEmailTurnText", () => {
  it("renders the email header, body, and attachment lines", () => {
    const text = buildEmailTurnText(makeEmail(), ["- a.pdf (application/pdf, 1KB): saved as inbound media"]);
    assert.match(text, /\[Email received\]/);
    assert.match(text, /From: owner@example\.com/);
    assert.match(text, /Subject: Quarterly numbers/);
    assert.match(text, /Please send the latest figures\./);
    assert.match(text, /\[Attachments\]/);
    assert.match(text, /a\.pdf/);
  });

  it("falls back gracefully on an empty body", () => {
    const text = buildEmailTurnText(makeEmail({ bodyText: "" }), []);
    assert.match(text, /\(no text body\)/);
    assert.doesNotMatch(text, /\[Attachments\]/);
  });
});

describe("dispatchInboundEmail", () => {
  it("dispatches a turn with the email content and saves attachments to media", async () => {
    const dispatchedCtx: Array<Record<string, unknown>> = [];
    const savedCalls: Array<{ len: number; contentType: string; filename: string }> = [];
    const channelRuntime = {
      routing: {},
      session: {},
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: async (p: { ctx: Record<string, unknown> }) => {
          dispatchedCtx.push(p.ctx);
        },
      },
      media: {
        saveMediaBuffer: async (
          buf: Buffer,
          contentType: string,
          _kind: string,
          _max: number,
          filename: string,
        ) => {
          savedCalls.push({ len: buf.byteLength, contentType, filename });
          return { path: `/media/${filename}`, contentType };
        },
      },
    };

    const ctx = {
      cfg: { channels: { clawbits: {} } },
      accountId: "default",
      account: makeAccount(),
      abortSignal: new AbortController().signal,
      channelRuntime,
      setStatus: () => {},
      log: {},
    } as unknown as Parameters<typeof dispatchInboundEmail>[0];

    const email = makeEmail({
      attachments: [{ filename: "report.txt", content_type: "text/plain", size: 2, content_b64: "aGk=" }],
    });

    await dispatchInboundEmail(ctx, email, { client: new ClawBitsClient({ endpoint: "http://h.example", apiKey: "k1" }), answers: {} });

    assert.equal(dispatchedCtx.length, 1, "exactly one reply dispatch");
    const c = dispatchedCtx[0]!;
    assert.equal(c.ConversationId, "ch1", "lands in the owner DM conversation");
    const bodyForAgent = String(c.BodyForAgent ?? "");
    assert.match(bodyForAgent, /Quarterly numbers/, "subject is in the agent body");
    assert.match(bodyForAgent, /Please send the latest figures\./, "body text is in the agent body");
    assert.match(bodyForAgent, /saved as inbound media/, "attachment summary is present");

    assert.equal(savedCalls.length, 1, "attachment saved once");
    assert.equal(savedCalls[0]!.len, 2, "decoded base64 'aGk=' -> 2 bytes");
    assert.equal(savedCalls[0]!.filename, "report.txt");
  });

  it("short-circuits cleanly when the channel runtime is incomplete", async () => {
    const ctx = {
      cfg: { channels: { clawbits: {} } },
      accountId: "default",
      account: makeAccount(),
      abortSignal: new AbortController().signal,
      channelRuntime: {}, // no routing/session/reply
      setStatus: () => {},
      log: {},
    } as unknown as Parameters<typeof dispatchInboundEmail>[0];

    // Should not throw.
    await dispatchInboundEmail(ctx, makeEmail(), {});
  });

  it("consolidates multi-block replies into one threaded email", async () => {
    const sends: Array<Record<string, unknown>> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.endsWith("/api/agentic/auth/challenge")) {
        return new Response(JSON.stringify({ challenge: "q1", session_token: "t1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/email/send")) {
        sends.push(typeof init?.body === "string" ? JSON.parse(init.body) : {});
        return new Response(JSON.stringify({ status: "sent", to_addr: "owner@example.com" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(`unexpected: ${url}`, { status: 500 });
    }) as typeof fetch;

    const channelRuntime = {
      routing: {},
      session: {},
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: async (p: {
          deliver?: (payload: unknown) => Promise<unknown>;
        }) => {
          // Buffered dispatcher fires deliver per block, then a final repeat.
          await p.deliver?.({ text: "First part." });
          await p.deliver?.({ text: "Second part." });
          await p.deliver?.({ text: "First part.\n\nSecond part." });
        },
      },
    };
    const ctx = {
      cfg: { channels: { clawbits: {} } },
      accountId: "default",
      account: makeAccount(),
      abortSignal: new AbortController().signal,
      channelRuntime,
      setStatus: () => {},
      log: {},
    } as unknown as Parameters<typeof dispatchInboundEmail>[0];

    try {
      await dispatchInboundEmail(ctx, makeEmail({ headers: { "Message-ID": "<orig@clawbits.ai>" } }), {
        client: new ClawBitsClient({ endpoint: "http://h.example", apiKey: "k1" }),
        answers: { q1: "a1" },
      });
      assert.equal(sends.length, 1, "exactly one email sent for the whole turn");
      assert.equal(sends[0]!.message, "First part.\n\nSecond part.", "full reply, no truncation/dup");
      assert.equal(sends[0]!.subject, "Re: Quarterly numbers");
      const headers = sends[0]!.headers as Record<string, string> | undefined;
      assert.equal(headers?.["In-Reply-To"], "<orig@clawbits.ai>", "threads to the original");
      assert.equal(headers?.References, "<orig@clawbits.ai>");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("drops self-addressed mail without dispatching or replying", async () => {
    let dispatched = 0;
    const channelRuntime = {
      routing: {},
      session: {},
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: async () => {
          dispatched += 1;
        },
      },
    };
    const ctx = {
      cfg: { channels: { clawbits: {} } },
      accountId: "default",
      account: makeAccount(),
      abortSignal: new AbortController().signal,
      channelRuntime,
      setStatus: () => {},
      log: {},
    } as unknown as Parameters<typeof dispatchInboundEmail>[0];

    // from === to (the agent's own mailbox) -> a loop; never process it.
    await dispatchInboundEmail(
      ctx,
      makeEmail({ fromAddr: "a1@clawbits.ai", toAddr: "a1@clawbits.ai" }),
      {},
    );
    assert.equal(dispatched, 0, "self-addressed mail is not dispatched");
  });

  it("mirrors the inbound email and the reply into the operator DM channel (temporary)", async () => {
    const posts: Array<{ url: string; message: string }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.endsWith("/api/agentic/auth/challenge")) {
        return new Response(JSON.stringify({ challenge: "q1", session_token: "t1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/email/send")) {
        return new Response(JSON.stringify({ status: "sent", to_addr: "owner@example.com" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/mm/channels/") && url.endsWith("/posts")) {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        posts.push({ url, message: String(body.message ?? "") });
        return new Response(JSON.stringify({ id: "p1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(`unexpected: ${url}`, { status: 500 });
    }) as typeof fetch;

    const channelRuntime = {
      routing: {},
      session: {},
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: async (p: {
          deliver?: (payload: unknown) => Promise<unknown>;
        }) => {
          await p.deliver?.({ text: "Here are the figures." });
        },
      },
    };
    const ctx = {
      cfg: { channels: { clawbits: {} } },
      accountId: "default",
      account: makeAccount(),
      abortSignal: new AbortController().signal,
      channelRuntime,
      setStatus: () => {},
      log: {},
    } as unknown as Parameters<typeof dispatchInboundEmail>[0];

    try {
      await dispatchInboundEmail(ctx, makeEmail(), {
        client: new ClawBitsClient({ endpoint: "http://h.example", apiKey: "k1" }),
        answers: { q1: "a1" },
      });
      // The inbound mirror is fire-and-forget; flush pending callbacks before asserting.
      await new Promise((r) => setTimeout(r, 10));

      assert.equal(posts.length, 2, "one DM post for the inbound email, one for the reply");
      for (const p of posts) {
        assert.match(p.url, /\/mm\/channels\/ch1\/posts$/, "posts go to the operator DM channel");
      }
      const inbound = posts.find((p) => /Email · received/.test(p.message));
      const replyPost = posts.find((p) => /Email · reply sent/.test(p.message));
      assert.ok(inbound, "inbound email mirrored to the DM");
      assert.match(inbound!.message, /owner@example\.com/, "inbound mirror shows the sender");
      assert.match(inbound!.message, /Quarterly numbers/, "inbound mirror shows the subject");
      assert.match(inbound!.message, /Please send the latest figures\./, "inbound mirror shows the body");
      assert.match(inbound!.message, /^> /m, "inbound mirror is blockquoted to set it apart from chat");
      assert.ok(replyPost, "reply mirrored to the DM");
      assert.match(replyPost!.message, /Here are the figures\./, "reply mirror shows the agent's response");
      assert.match(replyPost!.message, /Re: Quarterly numbers/, "reply mirror shows the threaded subject");
      assert.match(replyPost!.message, /^> /m, "reply mirror is blockquoted");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("does not mirror self-addressed loop mail to the DM (temporary)", async () => {
    const posts: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.endsWith("/api/agentic/auth/challenge")) {
        return new Response(JSON.stringify({ challenge: "q1", session_token: "t1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/mm/channels/") && url.endsWith("/posts")) {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        posts.push(String(body.message ?? ""));
        return new Response(JSON.stringify({ id: "p1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(`unexpected: ${url}`, { status: 500 });
    }) as typeof fetch;

    const channelRuntime = {
      routing: {},
      session: {},
      reply: { dispatchReplyWithBufferedBlockDispatcher: async () => {} },
    };
    const ctx = {
      cfg: { channels: { clawbits: {} } },
      accountId: "default",
      account: makeAccount(),
      abortSignal: new AbortController().signal,
      channelRuntime,
      setStatus: () => {},
      log: {},
    } as unknown as Parameters<typeof dispatchInboundEmail>[0];

    try {
      await dispatchInboundEmail(
        ctx,
        makeEmail({ fromAddr: "a1@clawbits.ai", toAddr: "a1@clawbits.ai" }),
        {
          client: new ClawBitsClient({ endpoint: "http://h.example", apiKey: "k1" }),
          answers: { q1: "a1" },
        },
      );
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(posts.length, 0, "self-addressed loop mail is not mirrored to the DM");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("does not mirror when no operator DM channel is configured (temporary)", async () => {
    const posts: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.endsWith("/api/agentic/auth/challenge")) {
        return new Response(JSON.stringify({ challenge: "q1", session_token: "t1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/email/send")) {
        return new Response(JSON.stringify({ status: "sent", to_addr: "owner@example.com" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/mm/channels/") && url.endsWith("/posts")) {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        posts.push(String(body.message ?? ""));
        return new Response(JSON.stringify({ id: "p1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(`unexpected: ${url}`, { status: 500 });
    }) as typeof fetch;

    const channelRuntime = {
      routing: {},
      session: {},
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: async (p: {
          deliver?: (payload: unknown) => Promise<unknown>;
        }) => {
          await p.deliver?.({ text: "Here are the figures." });
        },
      },
    };
    const ctx = {
      cfg: { channels: { clawbits: {} } },
      accountId: "default",
      // channelId omitted -> no DM channel to mirror into.
      account: makeAccount({ channelId: undefined }),
      abortSignal: new AbortController().signal,
      channelRuntime,
      setStatus: () => {},
      log: {},
    } as unknown as Parameters<typeof dispatchInboundEmail>[0];

    try {
      await dispatchInboundEmail(ctx, makeEmail(), {
        client: new ClawBitsClient({ endpoint: "http://h.example", apiKey: "k1" }),
        answers: { q1: "a1" },
      });
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(posts.length, 0, "no DM channel -> no mirror");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("isSelfAddressed", () => {
  it("flags from === to (loop) and the agent's own local-part", () => {
    assert.equal(isSelfAddressed(makeEmail({ fromAddr: "a1@clawbits.ai", toAddr: "a1@clawbits.ai" }), "a1"), true);
    assert.equal(isSelfAddressed(makeEmail({ fromAddr: "Agent <a1@clawbits.ai>", toAddr: "" }), "a1"), true);
    assert.equal(isSelfAddressed(makeEmail({ fromAddr: "owner@example.com", toAddr: "a1@clawbits.ai" }), "a1"), false);
    assert.equal(isSelfAddressed(makeEmail({ fromAddr: "" }), "a1"), false);
  });
});

describe("buildReplyThreadingHeaders", () => {
  it("derives In-Reply-To/References from a Message-ID (any header casing)", () => {
    assert.deepEqual(buildReplyThreadingHeaders(makeEmail({ headers: { "message-id": "<x@y>" } })), {
      "In-Reply-To": "<x@y>",
      References: "<x@y>",
    });
    assert.equal(buildReplyThreadingHeaders(makeEmail({ headers: {} })), undefined);
  });
});
