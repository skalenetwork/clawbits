import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  ChannelGatewayContext,
  ChannelSetupConfigureContext,
  OpenClawConfig,
  WizardPrompter,
} from "openclaw/plugin-sdk/core";
import {
  buildAgentBody,
  clawbitsSessionId,
  dispatchInboundMessage,
  tagReplyBody,
  clawbitsChannelPlugin,
} from "../src/plugin.js";
import { ClawBitsClient } from "../src/client.js";
import { ClawBitsError } from "../src/errors.js";
import type { InboundFile, InboundMessage } from "../src/inbound-poller.js";
import type { ResolvedClawBitsAccount } from "../src/types.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function cfgWith(section: Record<string, unknown>): OpenClawConfig {
  return { channels: { clawbits: section } };
}

function configuredSection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    endpoint: "http://h",
    orgId: "user-1",
    agentId: "a1",
    apiKey: "k1",
    channelId: "ch1",
    ...overrides,
  };
}

/** Minimal WizardPrompter stub with scripted replies. */
function makePrompter(opts: {
  textReplies: string[];
  confirmReplies: boolean[];
  onNote?: (message: string, title?: string) => void;
}): WizardPrompter {
  const text = [...opts.textReplies];
  const confirm = [...opts.confirmReplies];
  return {
    text: async () => text.shift() ?? "",
    confirm: async () => confirm.shift() ?? false,
    note: async (msg, title) => {
      opts.onNote?.(msg, title);
    },
    log: { info: () => {}, warn: () => {} },
  };
}

// ---------------------------------------------------------------------------
// configAdapter
// ---------------------------------------------------------------------------

describe("configAdapter", () => {
  const { config } = clawbitsChannelPlugin;

  it("listAccountIds + defaultAccountId match accounts.ts helpers", () => {
    assert.deepEqual(config.listAccountIds({}), ["default"]);
    assert.equal(config.defaultAccountId?.({}), "default");
  });

  it("resolveAccount returns the ResolvedClawBitsAccount shape", () => {
    const acct = config.resolveAccount(cfgWith(configuredSection()));
    assert.equal(acct.accountId, "default");
    assert.equal(acct.configured, true);
    assert.equal(acct.apiKey, "k1");
    assert.equal(acct.interAgentMode, false);
  });

  it("isConfigured reflects the resolved account", () => {
    const ok = config.resolveAccount(cfgWith(configuredSection()));
    const empty = config.resolveAccount({});
    assert.equal(config.isConfigured?.(ok, cfgWith(configuredSection())), true);
    assert.equal(config.isConfigured?.(empty, {}), false);
  });

  it("unconfiguredReason lists the missing fields by name", () => {
    const partial = config.resolveAccount(cfgWith({ endpoint: "http://h", orgId: "user-1" }));
    const reason = config.unconfiguredReason?.(partial, cfgWith({})) ?? "";
    assert.ok(reason.includes("agentId"), `reason mentions agentId: ${reason}`);
    assert.ok(reason.includes("apiKey"), `reason mentions apiKey: ${reason}`);
    assert.ok(reason.includes("channelId"), `reason mentions channelId: ${reason}`);
    assert.ok(!reason.includes("orgId"), `reason omits orgId when present: ${reason}`);
  });
});

// ---------------------------------------------------------------------------
// setupAdapter
// ---------------------------------------------------------------------------

describe("setupAdapter.applyAccountConfig", () => {
  const { setup } = clawbitsChannelPlugin;
  if (!setup) throw new Error("setup adapter missing");

  it("writes the default account to the top-level section (flat shape)", () => {
    const next = setup.applyAccountConfig({
      cfg: {},
      accountId: "default",
      input: {
        endpoint: "http://h",
        orgId: "user-1",
        agentId: "a1",
        apiKey: "k1",
        channelId: "ch1",
      },
    }) as { channels: { clawbits: Record<string, unknown> } };
    const section = next.channels.clawbits;
    assert.equal(section["endpoint"], "http://h");
    assert.equal(section["orgId"], "user-1");
    assert.equal(section["agentId"], "a1");
    assert.equal(section["apiKey"], "k1");
    assert.equal(section["channelId"], "ch1");
    assert.equal(section["accounts"], undefined);
  });

  it("writes named accounts under accounts.<id>", () => {
    const next = setup.applyAccountConfig({
      cfg: {},
      accountId: "alice",
      input: {
        endpoint: "http://h",
        orgId: "org-alice",
        agentId: "a2",
        apiKey: "k2",
        channelId: "ch2",
      },
    }) as { channels: { clawbits: { accounts?: Record<string, Record<string, unknown>> } } };
    const acct = next.channels.clawbits.accounts?.["alice"];
    assert.ok(acct, "accounts.alice exists");
    assert.equal(acct!["endpoint"], "http://h");
    assert.equal(acct!["orgId"], "org-alice");
    assert.equal(acct!["agentId"], "a2");
  });

  it("does not mutate the input config", () => {
    const cfg: OpenClawConfig = { channels: { clawbits: { endpoint: "http://old" } } };
    const snapshot = JSON.stringify(cfg);
    setup.applyAccountConfig({
      cfg,
      accountId: "default",
      input: { endpoint: "http://new" },
    });
    assert.equal(JSON.stringify(cfg), snapshot, "original cfg object untouched");
  });

  it("ignores non-string fields and empty knownAnswers", () => {
    const next = setup.applyAccountConfig({
      cfg: {},
      accountId: "default",
      input: {
        endpoint: 123 as unknown as string,
        orgId: null as unknown as string,
        agentId: "a1",
        knownAnswers: { mixed: 5, ok: "yes" } as unknown as Record<string, string>,
      },
    }) as { channels: { clawbits: Record<string, unknown> } };
    const section = next.channels.clawbits;
    assert.equal(section["endpoint"], undefined);
    assert.equal(section["orgId"], undefined);
    assert.equal(section["agentId"], "a1");
    assert.deepEqual(section["knownAnswers"], { ok: "yes" });
  });
});

describe("setupAdapter.validateInput", () => {
  const { setup } = clawbitsChannelPlugin;
  if (!setup?.validateInput) throw new Error("validateInput missing");

  it("returns null when orgId is omitted", () => {
    assert.equal(setup.validateInput!({ cfg: {}, accountId: "default", input: {} }), null);
  });

  it("accepts a non-empty orgId", () => {
    assert.equal(
      setup.validateInput!({ cfg: {}, accountId: "default", input: { orgId: "user-1" } }),
      null,
    );
  });

  it("rejects a blank orgId", () => {
    const msg = setup.validateInput!({
      cfg: {},
      accountId: "default",
      input: { orgId: "   " },
    });
    assert.ok(typeof msg === "string" && msg.length > 0);
  });
});

// ---------------------------------------------------------------------------
// setupWizard
// ---------------------------------------------------------------------------

describe("setupWizard.getStatus", () => {
  const { setupWizard } = clawbitsChannelPlugin;
  if (!setupWizard) throw new Error("setupWizard missing");

  it("reports configured=true and surfaces identifying lines", async () => {
    const status = await setupWizard.getStatus({ cfg: cfgWith(configuredSection()) });
    assert.equal(status.channel, "clawbits");
    assert.equal(status.configured, true);
    const joined = status.statusLines.join("\n");
    assert.ok(joined.includes("http://h"));
    assert.ok(joined.includes("a1"));
    assert.ok(joined.includes("ch1"));
  });

  it("reports configured=false for an empty config", async () => {
    const status = await setupWizard.getStatus({ cfg: {} });
    assert.equal(status.configured, false);
    assert.ok(status.statusLines.length > 0);
  });
});

describe("setupWizard.configure (reuse branch)", () => {
  const { setupWizard } = clawbitsChannelPlugin;
  if (!setupWizard) throw new Error("setupWizard missing");

  it("reuses existing credentials without calling the Clawbits API", async () => {
    const existing = configuredSection({
      endpoint: "http://existing",
      orgId: "old-org",
      agentId: "agent-123",
      apiKey: "key-abc",
      channelId: "ch-old",
    });
    const ctx: ChannelSetupConfigureContext = {
      cfg: cfgWith(existing),
      prompter: makePrompter({
        textReplies: ["http://new", "new-org"],
        confirmReplies: [true],
      }),
    };

    // Guard: if the wizard touches fetch here it means the reuse branch
    // wasn't taken. Fail loud instead of silently hitting the network.
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error("unexpected network call in reuse branch");
    }) as typeof fetch;
    let result: { cfg: OpenClawConfig; accountId?: string };
    try {
      result = await setupWizard.configure(ctx);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(fetchCalls, 0, "reuse path must not hit the network");

    const section = (result.cfg as { channels: { clawbits: Record<string, unknown> } }).channels
      .clawbits;
    assert.equal(section["endpoint"], "http://new", "endpoint from prompter wins");
    assert.equal(section["orgId"], "new-org", "orgId from prompter wins");
    assert.equal(section["agentId"], "agent-123", "agentId reused");
    assert.equal(section["apiKey"], "key-abc", "apiKey reused");
    assert.equal(section["channelId"], "ch-old", "channelId reused");
    assert.equal(result.accountId, "default");
  });
});

// ---------------------------------------------------------------------------
// outbound adapter
// ---------------------------------------------------------------------------

describe("outboundAdapter.sendText", () => {
  const { outbound } = clawbitsChannelPlugin;
  if (!outbound?.sendText) throw new Error("outbound.sendText missing");

  it("throws when the account is disabled", async () => {
    await assert.rejects(
      () =>
        outbound.sendText!({
          cfg: cfgWith({ ...configuredSection(), enabled: false }),
          to: "default",
          text: "hi",
        }),
      (err: unknown) => err instanceof ClawBitsError && /disabled/.test(err.detail as string),
    );
  });

  it("throws when the account has no apiKey (not yet set up)", async () => {
    await assert.rejects(
      () =>
        outbound.sendText!({
          cfg: cfgWith({ endpoint: "http://h", orgId: "user-1" }),
          to: "default",
          text: "hi",
        }),
      (err: unknown) => err instanceof ClawBitsError && /apiKey/.test(err.detail as string),
    );
  });

  it("throws when neither ctx.to nor account.channelId resolves to a channel", async () => {
    const section = {
      endpoint: "http://h",
      orgId: "user-1",
      agentId: "a1",
      apiKey: "k1",
      // no channelId
    };
    await assert.rejects(
      () =>
        outbound.sendText!({
          cfg: cfgWith(section),
          to: "default",
          text: "hi",
        }),
      (err: unknown) =>
        err instanceof ClawBitsError && /channelId/.test(err.detail as string),
    );
  });

  it("posts to the configured channel and returns the new message id", async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    const methods: string[] = [];
    globalThis.fetch = (async (url, init) => {
      const u = String(url);
      urls.push(u);
      methods.push(init?.method ?? "GET");
      if (u.endsWith("/api/agentic/auth/challenge")) {
        return new Response(
          JSON.stringify({
            session_token: "sess-1",
            challenge: "What is the capital of France?",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.endsWith("/api/agentic/mm/channels/ch1/posts")) {
        return new Response(JSON.stringify({ id: "post-xyz" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(`unexpected: ${u}`, { status: 500 });
    }) as typeof fetch;

    try {
      const result = await outbound.sendText!({
        cfg: cfgWith(configuredSection()),
        to: "default",
        text: "hello human",
      });
      assert.equal(result.channel, "clawbits");
      assert.equal(result.messageId, "post-xyz");
      assert.equal(result.channelId, "ch1");
      assert.equal(methods[0], "GET"); // challenge
      assert.equal(methods[1], "POST"); // post
      assert.ok(
        urls[1]!.includes("/api/agentic/mm/channels/ch1/posts"),
        `posted to configured channel: ${urls[1]}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("prefers ctx.to over account.channelId when ctx.to is not the 'default' sentinel", async () => {
    const originalFetch = globalThis.fetch;
    const postUrls: string[] = [];
    globalThis.fetch = (async (url) => {
      const u = String(url);
      if (u.endsWith("/api/agentic/auth/challenge")) {
        return new Response(
          JSON.stringify({
            session_token: "sess-2",
            challenge: "What is the capital of France?",
          }),
          { status: 200 },
        );
      }
      if (u.includes("/posts")) {
        postUrls.push(u);
        return new Response(JSON.stringify({ id: "post-2" }), { status: 200 });
      }
      return new Response("nope", { status: 500 });
    }) as typeof fetch;

    try {
      const result = await outbound.sendText!({
        cfg: cfgWith(configuredSection()),
        to: "ch-explicit",
        text: "hi",
      });
      assert.equal(result.channelId, "ch-explicit");
      assert.ok(
        postUrls[0]!.endsWith("/api/agentic/mm/channels/ch-explicit/posts"),
        `posted to override: ${postUrls[0]}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// gateway adapter — inbound ingestion
// ---------------------------------------------------------------------------

function makeResolvedAccount(
  overrides: Partial<ResolvedClawBitsAccount> = {},
): ResolvedClawBitsAccount {
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
    interAgentMode: false,
    config: {},
    ...overrides,
  };
}

function makeGatewayCtx(
  overrides: Partial<ChannelGatewayContext<ResolvedClawBitsAccount>> = {},
): ChannelGatewayContext<ResolvedClawBitsAccount> {
  const ac = new AbortController();
  return {
    cfg: {},
    accountId: "default",
    account: makeResolvedAccount(),
    abortSignal: ac.signal,
    ...overrides,
  };
}

describe("tagReplyBody", () => {
  it("prefixes replies with the sender tag without duplicating it", () => {
    assert.equal(tagReplyBody("hello", "@Stan-Lee"), "@Stan-Lee hello");
    assert.equal(tagReplyBody("@Stan-Lee hello", "@Stan-Lee"), "@Stan-Lee hello");
    assert.equal(tagReplyBody("  hello", "helper-agent"), "  @helper-agent hello");
    assert.equal(tagReplyBody("hello", undefined), "hello");
  });
});

describe("dispatchInboundMessage", () => {
  it("calls channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher with a finalized ctx", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const ctx = makeGatewayCtx({
      channelRuntime: {
        routing: {},
        session: {},
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async (params) => {
            calls.push(params as unknown as Record<string, unknown>);
          },
        },
      },
    });
    const msg: InboundMessage = {
      accountId: "default",
      channelId: "chan-1",
      postId: "post-42",
      senderId: "owner-user-id",
      text: "hello bot",
      createAt: 12345,
      raw: { id: "post-42", create_at: 12345 },
    };
    await dispatchInboundMessage(ctx, msg);
    assert.equal(calls.length, 1);
    const dispatched = calls[0]! as {
      ctx: Record<string, unknown>;
      cfg: unknown;
    };
    assert.equal(dispatched.ctx.Channel, "clawbits");
    assert.equal(dispatched.ctx.Body, "hello bot");
    assert.ok(String(dispatched.ctx.BodyForAgent).includes("hello bot"));
    assert.ok(
      /sess_[0-9a-f]{12}/.test(String(dispatched.ctx.BodyForAgent)),
      "gateway injects the hashed per-chat session id into the prompt",
    );
    assert.equal(dispatched.ctx.From, "clawbits:user:owner-user-id");
    assert.equal(dispatched.ctx.To, "channel:chan-1");
    assert.equal(dispatched.ctx.AccountId, "default");
    assert.equal(dispatched.ctx.ChatType, "direct");
    assert.equal(dispatched.ctx.ConversationId, "chan-1");
    assert.equal(dispatched.ctx.SessionKey, "clawbits:default:chan-1");
  });

  it("authorizes /usage in the operator DM as a text command so the host doesn't swallow it", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const ctx = makeGatewayCtx({
      channelRuntime: {
        routing: {},
        session: {},
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async (params) => {
            calls.push(params as unknown as Record<string, unknown>);
          },
        },
      },
    });
    // chan-1 is the configured operator DM channel (see makeResolvedAccount).
    await dispatchInboundMessage(ctx, {
      accountId: "default",
      channelId: "chan-1",
      postId: "u1",
      senderId: "owner-user-id",
      text: "/usage",
      createAt: 1,
      channelType: "direct",
      raw: { id: "u1", create_at: 1 },
    });
    const dispatched = calls[0]! as { ctx: Record<string, unknown> };
    // Both are required: without CommandSource:"text" the host treats it as a
    // normal message, and without CommandAuthorized the command is swallowed.
    assert.equal(dispatched.ctx.CommandAuthorized, true);
    assert.equal(dispatched.ctx.CommandSource, "text");
    // Bare /usage is remapped to `/usage cost` so it prints a one-shot
    // token/cost summary instead of toggling the per-reply footer.
    assert.equal(dispatched.ctx.CommandBody, "/usage cost");
  });

  it("passes through an explicit /usage mode without remapping to cost", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const ctx = makeGatewayCtx({
      channelRuntime: {
        routing: {},
        session: {},
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async (params) => {
            calls.push(params as unknown as Record<string, unknown>);
          },
        },
      },
    });
    await dispatchInboundMessage(ctx, {
      accountId: "default",
      channelId: "chan-1",
      postId: "u1b",
      senderId: "owner-user-id",
      text: "/usage tokens",
      createAt: 1,
      channelType: "direct",
      raw: { id: "u1b", create_at: 1 },
    });
    const dispatched = calls[0]! as { ctx: Record<string, unknown> };
    assert.equal(dispatched.ctx.CommandAuthorized, true);
    assert.equal(dispatched.ctx.CommandBody, "/usage tokens");
  });

  it("does not authorize a normal operator-DM message as a command", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const ctx = makeGatewayCtx({
      channelRuntime: {
        routing: {},
        session: {},
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async (params) => {
            calls.push(params as unknown as Record<string, unknown>);
          },
        },
      },
    });
    await dispatchInboundMessage(ctx, {
      accountId: "default",
      channelId: "chan-1",
      postId: "u2",
      senderId: "owner-user-id",
      text: "just chatting",
      createAt: 1,
      channelType: "direct",
      raw: { id: "u2", create_at: 1 },
    });
    const dispatched = calls[0]! as { ctx: Record<string, unknown> };
    assert.equal(dispatched.ctx.CommandAuthorized, false);
    assert.equal(dispatched.ctx.CommandSource, undefined);
  });

  it("does not authorize /usage outside the operator DM", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const ctx = makeGatewayCtx({
      channelRuntime: {
        routing: {},
        session: {},
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async (params) => {
            calls.push(params as unknown as Record<string, unknown>);
          },
        },
      },
    });
    await dispatchInboundMessage(ctx, {
      accountId: "default",
      channelId: "other-chan",
      postId: "u3",
      senderId: "someone",
      text: "/usage",
      createAt: 1,
      channelType: "direct",
      raw: { id: "u3", create_at: 1 },
    });
    const dispatched = calls[0]! as { ctx: Record<string, unknown> };
    assert.equal(dispatched.ctx.CommandAuthorized, false);
    assert.equal(dispatched.ctx.CommandSource, undefined);
  });

  it("renders prior untagged channel posts into the agent body (not capped InboundHistory)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const ctx = makeGatewayCtx({
      channelRuntime: {
        routing: {},
        session: {},
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async (params) => {
            calls.push(params as unknown as Record<string, unknown>);
          },
        },
      },
    });
    await dispatchInboundMessage(ctx, {
      accountId: "default",
      channelId: "chan-1",
      postId: "tagged",
      senderId: "human:1",
      text: "@bot answer now",
      createAt: 300,
      channelType: "public",
      priorContext: [
        { postId: "u1", senderId: "human:2", text: "untagged one", createAt: 100, isSelf: false },
        { postId: "a1", senderId: "agent:bot", text: "prior bot reply", createAt: 200, isSelf: true },
      ],
      raw: { id: "tagged", create_at: 300 },
    });
    const dispatched = calls[0]! as { ctx: Record<string, unknown> };
    const body = String(dispatched.ctx.BodyForAgent);
    // Prior context must land in the agent's actual input (the body), not the
    // structured InboundHistory field — core caps that at 20 entries and frames
    // it as untrusted background the agent ignores.
    assert.ok(body.includes("[Channel history"), "history block rendered into the body");
    assert.ok(body.includes("untagged one"), "prior untagged message is in the body");
    assert.ok(body.includes("prior bot reply"), "agent's own prior reply is in the body");
    assert.equal(
      dispatched.ctx.InboundHistory,
      undefined,
      "history is in the body, not the capped/untrusted InboundHistory field",
    );
  });

  it("routes DM posts as a direct peer (keeps the agent's DM/main session)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const ctx = makeGatewayCtx({
      channelRuntime: {
        routing: {},
        session: {},
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async (params) => {
            calls.push(params as unknown as Record<string, unknown>);
          },
        },
      },
    });
    const msg: InboundMessage = {
      accountId: "default",
      channelId: "dm-chan",
      postId: "p-dm",
      senderId: "human-7",
      text: "hi",
      createAt: 1,
      channelType: "direct",
      raw: { id: "p-dm", create_at: 1 },
    };
    await dispatchInboundMessage(ctx, msg);
    const dispatched = calls[0]! as { ctx: Record<string, unknown> };
    assert.deepEqual(dispatched.ctx.Peer, { kind: "direct", id: "human-7" });
    assert.equal(dispatched.ctx.ChatType, "direct");
    assert.equal(dispatched.ctx.SenderId, "human-7");
  });

  it("authorizes /new only in the configured operator DM", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const ctx = makeGatewayCtx({
      channelRuntime: {
        routing: {},
        session: {},
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async (params) => {
            calls.push(params as unknown as Record<string, unknown>);
          },
        },
      },
    });
    await dispatchInboundMessage(ctx, {
      accountId: "default",
      channelId: "chan-1",
      postId: "p-operator-dm-new",
      senderId: "human-7",
      text: "/new",
      createAt: 1,
      channelType: "direct",
      raw: { id: "p-operator-dm-new", create_at: 1 },
    });
    await dispatchInboundMessage(ctx, {
      accountId: "default",
      channelId: "other-dm",
      postId: "p-other-dm-new",
      senderId: "human-8",
      text: "/new",
      createAt: 2,
      channelType: "direct",
      raw: { id: "p-other-dm-new", create_at: 2 },
    });
    await dispatchInboundMessage(ctx, {
      accountId: "default",
      channelId: "private-room",
      postId: "p-private-new",
      senderId: "human-7",
      text: "/new",
      createAt: 3,
      channelType: "private",
      raw: { id: "p-private-new", create_at: 3 },
    });

    const operatorDm = calls[0]! as { ctx: Record<string, unknown> };
    const otherDm = calls[1]! as { ctx: Record<string, unknown> };
    const privateRoom = calls[2]! as { ctx: Record<string, unknown> };
    assert.equal(operatorDm.ctx.CommandAuthorized, true);
    assert.equal(operatorDm.ctx.CommandSource, "text");
    assert.equal(otherDm.ctx.CommandAuthorized, false);
    assert.equal(otherDm.ctx.CommandSource, undefined);
    assert.equal(privateRoom.ctx.CommandAuthorized, false);
    assert.equal(privateRoom.ctx.CommandSource, undefined);
  });

  it("authorizes /reset, /start, and /clear only in the configured operator DM", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const ctx = makeGatewayCtx({
      channelRuntime: {
        routing: {},
        session: {},
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async (params) => {
            calls.push(params as unknown as Record<string, unknown>);
          },
        },
      },
    });

    for (const [postId, text] of [
      ["p-reset", "/reset"],
      ["p-start", "/start continue"],
      ["p-clear", "/clear"],
    ] as const) {
      await dispatchInboundMessage(ctx, {
        accountId: "default",
        channelId: "chan-1",
        postId,
        senderId: "human-7",
        text,
        createAt: 1,
        channelType: "direct",
        raw: { id: postId, create_at: 1 },
      });
    }

    const reset = calls[0]! as { ctx: Record<string, unknown> };
    const start = calls[1]! as { ctx: Record<string, unknown> };
    const clear = calls[2]! as { ctx: Record<string, unknown> };
    assert.equal(reset.ctx.CommandAuthorized, true);
    assert.equal(reset.ctx.CommandSource, "text");
    assert.match(String(reset.ctx.BodyForAgent), /\/reset/);
    assert.equal(start.ctx.CommandAuthorized, true);
    assert.equal(start.ctx.CommandSource, "text");
    assert.match(String(start.ctx.BodyForAgent), /\/new continue/);
    assert.equal(clear.ctx.CommandAuthorized, true);
    assert.equal(clear.ctx.CommandSource, "text");
    assert.match(String(clear.ctx.BodyForAgent), /\/reset/);

    calls.length = 0;
    await dispatchInboundMessage(ctx, {
      accountId: "default",
      channelId: "other-dm",
      postId: "p-other-clear",
      senderId: "human-8",
      text: "/clear",
      createAt: 2,
      channelType: "direct",
      raw: { id: "p-other-clear", create_at: 2 },
    });
    const other = calls[0]! as { ctx: Record<string, unknown> };
    assert.equal(other.ctx.CommandAuthorized, false);
    assert.equal(other.ctx.CommandSource, undefined);
    assert.match(String(other.ctx.BodyForAgent), /\/clear/);
  });

  it("handles /help in the configured operator DM without starting an agent turn", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    const client = new ClawBitsClient({
      endpoint: "http://clawbits.test",
      apiKey: "k1",
      fetchImpl: (async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/agentic/auth/challenge") {
          return new Response(
            JSON.stringify({ challenge: "test-question", session_token: "s1" }),
            { status: 200 },
          );
        }
        if (url.pathname === "/api/agentic/mm/channels/chan-1/posts") {
          posts.push({
            path: url.pathname,
            body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
          });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ detail: "unexpected path" }), { status: 404 });
      }) as typeof fetch,
    });
    const ctx = makeGatewayCtx({
      channelRuntime: {
        routing: {},
        session: {},
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async (params) => {
            calls.push(params as unknown as Record<string, unknown>);
          },
        },
      },
    });

    await dispatchInboundMessage(ctx, {
      accountId: "default",
      channelId: "chan-1",
      postId: "p-help",
      senderId: "human-7",
      text: "/help",
      createAt: 1,
      channelType: "direct",
      raw: { id: "p-help", create_at: 1 },
    }, { client, answers: { "test-question": "test-answer" } });

    assert.equal(calls.length, 0);
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.path, "/api/agentic/mm/channels/chan-1/posts");
    assert.match(String(posts[0]!.body.message), /\/help/);
    assert.match(String(posts[0]!.body.message), /\/new \[message\]/);
    assert.match(String(posts[0]!.body.message), /\/start \[message\]/);
    assert.match(String(posts[0]!.body.message), /\/reset \[message\]/);
    assert.match(String(posts[0]!.body.message), /\/clear \[message\]/);
  });

  it("does not treat /help as an admin command outside the configured operator DM", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const ctx = makeGatewayCtx({
      channelRuntime: {
        routing: {},
        session: {},
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async (params) => {
            calls.push(params as unknown as Record<string, unknown>);
          },
        },
      },
    });
    await dispatchInboundMessage(ctx, {
      accountId: "default",
      channelId: "other-dm",
      postId: "p-other-dm-help",
      senderId: "human-8",
      text: "/help",
      createAt: 2,
      channelType: "direct",
      raw: { id: "p-other-dm-help", create_at: 2 },
    });
    await dispatchInboundMessage(ctx, {
      accountId: "default",
      channelId: "private-room",
      postId: "p-private-help",
      senderId: "human-7",
      text: "/help",
      createAt: 3,
      channelType: "private",
      raw: { id: "p-private-help", create_at: 3 },
    });

    const otherDm = calls[0]! as { ctx: Record<string, unknown> };
    const privateRoom = calls[1]! as { ctx: Record<string, unknown> };
    assert.equal(otherDm.ctx.CommandAuthorized, false);
    assert.equal(otherDm.ctx.CommandSource, undefined);
    assert.equal(privateRoom.ctx.CommandAuthorized, false);
    assert.equal(privateRoom.ctx.CommandSource, undefined);
  });

  it("routes non-DM channel posts as a channel peer for per-chat isolation", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const ctx = makeGatewayCtx({
      channelRuntime: {
        routing: {},
        session: {},
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async (params) => {
            calls.push(params as unknown as Record<string, unknown>);
          },
        },
      },
    });
    const msg: InboundMessage = {
      accountId: "default",
      channelId: "room-9",
      postId: "p-room",
      senderId: "human-7",
      text: "hi room",
      createAt: 1,
      channelType: "public",
      raw: { id: "p-room", create_at: 1 },
    };
    await dispatchInboundMessage(ctx, msg);
    const dispatched = calls[0]! as { ctx: Record<string, unknown> };
    // The session/route peer is the CHANNEL (per-chat isolation), not the human.
    assert.deepEqual(dispatched.ctx.Peer, { kind: "channel", id: "room-9" });
    assert.equal(dispatched.ctx.ChatType, "channel");
    // Human identity is still carried for attribution inside the shared room.
    assert.equal(dispatched.ctx.SenderId, "human-7");
  });

  it("isolates two different channels into distinct route peers", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const ctx = makeGatewayCtx({
      channelRuntime: {
        routing: {},
        session: {},
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async (params) => {
            calls.push(params as unknown as Record<string, unknown>);
          },
        },
      },
    });
    await dispatchInboundMessage(ctx, {
      accountId: "default",
      channelId: "room-A",
      postId: "a",
      senderId: "human-7",
      text: "x",
      createAt: 1,
      channelType: "private",
      raw: { id: "a", create_at: 1 },
    });
    await dispatchInboundMessage(ctx, {
      accountId: "default",
      channelId: "room-B",
      postId: "b",
      senderId: "human-7",
      text: "y",
      createAt: 2,
      channelType: "private",
      raw: { id: "b", create_at: 2 },
    });
    const peerA = (calls[0]! as { ctx: Record<string, unknown> }).ctx.Peer;
    const peerB = (calls[1]! as { ctx: Record<string, unknown> }).ctx.Peer;
    assert.deepEqual(peerA, { kind: "channel", id: "room-A" });
    assert.deepEqual(peerB, { kind: "channel", id: "room-B" });
    assert.notDeepEqual(peerA, peerB);
  });

  it("downloads inbound attachments into OpenClaw media context", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<Record<string, unknown>> = [];
    const saved: Array<{ bytes: Uint8Array; contentType: string; filename: string }> = [];
    globalThis.fetch = (async (url) => {
      assert.equal(String(url), "https://signed.example/shot.png");
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "Content-Type": "image/png", "Content-Length": "3" },
      });
    }) as typeof fetch;
    try {
      const ctx = makeGatewayCtx({
        channelRuntime: {
          routing: {},
          session: {},
          media: {
            saveMediaBuffer: async (
              bytes: Uint8Array,
              contentType: string,
              subdir: string,
              maxBytes: number,
              filename: string,
            ) => {
              assert.equal(subdir, "inbound");
              assert.ok(maxBytes > 0);
              saved.push({ bytes, contentType, filename });
              return { path: "/tmp/openclaw-media/shot.png", contentType };
            },
          },
          reply: {
            dispatchReplyWithBufferedBlockDispatcher: async (params) => {
              calls.push(params as unknown as Record<string, unknown>);
            },
          },
        },
      });
      const msg: InboundMessage = {
        accountId: "default",
        channelId: "chan-1",
        postId: "post-with-file",
        senderId: "owner-user-id",
        text: "look",
        createAt: 12345,
        files: [makeFile()],
        raw: { id: "post-with-file", create_at: 12345 },
      };
      await dispatchInboundMessage(ctx, msg);
      assert.equal(saved.length, 1);
      assert.deepEqual([...saved[0]!.bytes], [1, 2, 3]);
      assert.equal(saved[0]!.contentType, "image/png");
      assert.equal(saved[0]!.filename, "shot.png");
      const dispatched = calls[0]! as { ctx: Record<string, unknown> };
      assert.equal(dispatched.ctx.MediaPath, "/tmp/openclaw-media/shot.png");
      assert.equal(dispatched.ctx.MediaType, "image/png");
      assert.deepEqual(dispatched.ctx.MediaPaths, ["/tmp/openclaw-media/shot.png"]);
      assert.deepEqual(dispatched.ctx.MediaTypes, ["image/png"]);
      assert.ok(
        String(dispatched.ctx.BodyForAgent).includes("shot.png [id=f1] (image/png, 2KB): saved as inbound media"),
        "agent prompt points at staged media context, not a stale local markdown path",
      );
      assert.ok(
        !String(dispatched.ctx.BodyForAgent).includes("/tmp/openclaw-media/shot.png"),
        "agent prompt does not embed pre-staged host path",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to channel label when sender id is missing", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const ctx = makeGatewayCtx({
      channelRuntime: {
        routing: {},
        session: {},
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async (params) => {
            calls.push(params as unknown as Record<string, unknown>);
          },
        },
      },
    });
    const msg: InboundMessage = {
      accountId: "default",
      channelId: "chan-1",
      postId: "p1",
      senderId: "",
      text: "anon",
      createAt: 1,
      raw: { id: "p1", create_at: 1 },
    };
    await dispatchInboundMessage(ctx, msg);
    const dispatched = calls[0]! as { ctx: Record<string, unknown> };
    assert.equal(dispatched.ctx.From, "clawbits:channel:chan-1");
  });

  it("logs a warning and drops the message when channelRuntime.reply is unavailable", async () => {
    const warns: string[] = [];
    const ctx = makeGatewayCtx({
      log: { warn: (m) => warns.push(m) },
      // no channelRuntime
    });
    const msg: InboundMessage = {
      accountId: "default",
      channelId: "chan-1",
      postId: "dropped",
      senderId: "u1",
      text: "oops",
      createAt: 1,
      raw: { id: "dropped", create_at: 1 },
    };
    await dispatchInboundMessage(ctx, msg);
    assert.ok(warns.some((l) => l.includes("dropped") && l.includes("channel runtime incomplete")));
  });
});

describe("gateway.startAccount", () => {
  const gateway = clawbitsChannelPlugin.gateway;
  if (!gateway?.startAccount) throw new Error("gateway.startAccount missing");

  it("idles without polling when the account is disabled", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const info: string[] = [];
    const ac = new AbortController();
    try {
      await gateway.startAccount!({
        cfg: {},
        accountId: "default",
        account: makeResolvedAccount({ enabled: false }),
        abortSignal: ac.signal,
        log: { info: (m) => info.push(m) },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(fetchCalls, 0, "disabled account must not hit the network");
    assert.ok(info.some((l) => l.includes("disabled")));
  });

  it("idles without polling when account.configured is false", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const info: string[] = [];
    try {
      await gateway.startAccount!({
        cfg: {},
        accountId: "default",
        account: makeResolvedAccount({ configured: false, apiKey: undefined }),
        abortSignal: new AbortController().signal,
        log: { info: (m) => info.push(m) },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(fetchCalls, 0);
    assert.ok(info.some((l) => l.includes("not fully configured")));
  });

  it("polls for posts and forwards new ones through channelRuntime.reply", async () => {
    const originalFetch = globalThis.fetch;
    const dispatched: Array<{ Body: string; PostId: string }> = [];
    // Use a post timestamp comfortably in the future so the default
    // `now()-lookback` cursor the poller seeds cannot filter it out.
    const createAt = Date.now() + 60_000;
    const postsResponse = {
      order: ["p1"],
      posts: {
        p1: { id: "p1", create_at: createAt, user_id: "owner", message: "wake up" },
      },
    };
    globalThis.fetch = (async (url) => {
      const u = String(url);
      if (u.endsWith("/api/agentic/mm/channels/chan-1/posts")) {
        return new Response(JSON.stringify(postsResponse), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const ac = new AbortController();
    try {
      await gateway.startAccount!({
        cfg: {},
        accountId: "default",
        account: makeResolvedAccount(),
        abortSignal: ac.signal,
        channelRuntime: {
          routing: {},
          session: {},
          reply: {
            dispatchReplyWithBufferedBlockDispatcher: async (params) => {
              const c = params.ctx as Record<string, unknown>;
              dispatched.push({ Body: String(c.Body), PostId: "p1" });
              ac.abort();
            },
          },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.deepEqual(dispatched, [{ Body: "wake up", PostId: "p1" }]);
  });
});

// ---------------------------------------------------------------------------
// buildAgentBody — attachment summarisation
// ---------------------------------------------------------------------------

function makeFile(overrides: Partial<InboundFile> = {}): InboundFile {
  return {
    fileId: "f1",
    filename: "shot.png",
    contentType: "image/png",
    sizeBytes: 2048,
    downloadUrl: "https://signed.example/shot.png",
    thumbnailUrl: null,
    width: 800,
    height: 600,
    durationMs: null,
    ...overrides,
  };
}

describe("clawbitsSessionId", () => {
  it("is deterministic and namespaced per chat", () => {
    const a = clawbitsSessionId("chan-1");
    assert.equal(a, clawbitsSessionId("chan-1"), "same chat → same id");
    assert.match(a, /^sess_[0-9a-f]{12}$/, "sess_ + 12 hex chars");
  });
  it("distinguishes different chats", () => {
    assert.notEqual(clawbitsSessionId("chan-1"), clawbitsSessionId("chan-2"));
  });
  it("hides the raw chat id (opaque hash)", () => {
    assert.ok(!clawbitsSessionId("secret-channel-uuid").includes("secret-channel-uuid"));
  });
});

describe("buildAgentBody (session id)", () => {
  it("weaves a provided session id into context and keeps user text trailing", () => {
    const sid = clawbitsSessionId("room-9");
    const out = buildAgentBody("hello", undefined, undefined, sid);
    assert.ok(out.includes(sid), "hashed session id present");
    assert.ok(out.includes("session id for this chat"), "labelled for the model");
    assert.ok(out.includes("[end Clawbits context]"), "stays inside the context block");
    assert.ok(out.endsWith("\n\nhello"), "user text still trails the prompt");
    assert.ok(!out.includes("room-9"), "raw chat id is not leaked");
  });
  it("omits the session line when no id is given (prompt unchanged)", () => {
    const out = buildAgentBody("hello");
    assert.ok(!out.includes("session id for this chat"));
    assert.ok(out.endsWith("\n\nhello"));
  });
});

describe("buildAgentBody (channel history)", () => {
  const ctx = [
    { postId: "a", senderId: "human:7", text: "we shipped the build", createAt: 1700000000000, isSelf: false },
    { postId: "b", senderId: "agent:bot", text: "nice, on it", createAt: 1700000001000, isSelf: true },
  ];

  it("renders a read-only history block before the tagged message", () => {
    const out = buildAgentBody("@bot what's left?", undefined, undefined, undefined, ctx);
    const historyIdx = out.indexOf("[Channel history");
    const bodyIdx = out.indexOf("@bot what's left?");
    assert.ok(historyIdx !== -1, "history header present");
    assert.ok(out.includes("[end Channel history]"), "history block closed");
    assert.ok(historyIdx < bodyIdx, "history precedes the current message");
    assert.ok(out.includes("we shipped the build"), "prior text surfaced");
    assert.ok(out.includes("you ["), "self-authored line labelled 'you'");
    assert.ok(out.includes("human:7 ["), "other sender attributed");
    assert.ok(out.endsWith("@bot what's left?"), "current message trails the prompt");
  });

  it("leaves the prompt unchanged when there is no prior context", () => {
    const out = buildAgentBody("hello", undefined, undefined, undefined, []);
    assert.ok(!out.includes("[Channel history"), "no history block when empty");
    assert.ok(out.endsWith("\n\nhello"));
  });

  it("adds reply-tagging instructions when a sender tag is supplied", () => {
    const out = buildAgentBody("hello", undefined, undefined, undefined, [], "@Stan-Lee");
    assert.ok(out.includes("[Reply tagging]"));
    assert.ok(out.includes("Start your reply to the current message with @Stan-Lee."));
    assert.ok(out.endsWith("\n\nhello"));
  });
});

describe("buildAgentBody", () => {
  it("emits no attachments block for plain text messages (prompt stable)", () => {
    const out = buildAgentBody("hello");
    assert.ok(!out.includes("[Attachments]"), "no attachments header");
    assert.ok(out.endsWith("\n\nhello"), "user text trails the prompt");
  });

  it("summarizes saved image attachments without embedding local markdown paths", () => {
    const out = buildAgentBody(
      "look",
      [makeFile()],
      new Map([["f1", { fileId: "f1", path: "/tmp/openclaw-media/shot.png", contentType: "image/png" }]]),
    );
    assert.ok(out.includes("[Attachments]"), "attachments header present");
    assert.ok(!out.includes("![shot.png]"), "no markdown image syntax with stale host path");
    assert.ok(!out.includes("/tmp/openclaw-media/shot.png"), "no pre-staged host path in prompt text");
    assert.ok(
      out.includes("shot.png [id=f1] (image/png, 2KB): saved as inbound media"),
      "id + MIME + size hint",
    );
    assert.ok(out.includes("[end Attachments]"), "closing tag");
  });

  it("renders non-image files as labelled links", () => {
    const out = buildAgentBody("here is a doc", [
      makeFile({
        filename: "notes.pdf",
        contentType: "application/pdf",
        sizeBytes: 1500000,
        downloadUrl: "https://signed.example/notes.pdf",
        width: null,
        height: null,
      }),
    ]);
    assert.ok(out.includes("- notes.pdf [id=f1] (application/pdf, 1.4MB)"));
    assert.ok(out.includes("attachment download unavailable"));
    assert.ok(
      !out.includes("![notes.pdf]"),
      "non-image must NOT use image markdown",
    );
  });

  it("handles attachment-only posts (no caption text)", () => {
    const out = buildAgentBody("", [makeFile()]);
    assert.ok(
      out.includes("(no message text — see attachments)"),
      "user body placeholder keeps prompt grammatical",
    );
    assert.ok(out.includes("[Attachments]"));
  });

  it("uses unavailable placeholder when attachment was not saved", () => {
    const out = buildAgentBody("hi", [
      makeFile({
        filename: "data.zip",
        contentType: "application/zip",
        downloadUrl: null,
      }),
    ]);
    assert.ok(
      out.includes("<attachment download unavailable; ask the user to re-upload if visual access is required>"),
      "does not expose expiring/private URLs to the model",
    );
  });

  it("does not double-render multiple attachments", () => {
    const out = buildAgentBody("multi", [
      makeFile({ fileId: "a", filename: "a.png" }),
      makeFile({ fileId: "b", filename: "b.jpg", contentType: "image/jpeg" }),
    ]);
    const headerCount = (out.match(/\[Attachments\]/g) ?? []).length;
    assert.equal(headerCount, 1);
    assert.ok(out.includes("a.png") && out.includes("b.jpg"));
  });
});
