import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import {
  createClawBitsActions,
  describeClawBitsMessageTool,
} from "../src/channel-actions.js";
import { ClawBitsError } from "../src/errors.js";

// ---------------------------------------------------------------------------
// helpers — same shape as plugin.test.ts, intentionally duplicated to keep
// this test file standalone.
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

const CHALLENGE_QUESTION = "What is the capital of France?";

function challengeResponse(): Response {
  return new Response(
    JSON.stringify({ session_token: "sess-1", challenge: CHALLENGE_QUESTION }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// describeMessageTool
// ---------------------------------------------------------------------------

describe("describeClawBitsMessageTool", () => {
  it("advertises react, reactions, update_description, and send_email actions", () => {
    const out = describeClawBitsMessageTool({
      cfg: cfgWith(configuredSection()),
      accountId: null,
    });
    assert.deepEqual(out.actions, [
      "react",
      "reactions",
      "update_description",
      "send_email",
    ]);
  });

  it("exposes a schema fragment scoped to send_email", () => {
    const out = describeClawBitsMessageTool({
      cfg: cfgWith(configuredSection()),
      accountId: null,
    });
    const schema = out.schema as Array<{
      actions?: readonly string[] | null;
      properties: Record<string, unknown>;
    }>;
    const frag = schema.find(
      (s) => Array.isArray(s.actions) && s.actions.includes("send_email"),
    );
    assert.ok(frag, "schema contains a send_email fragment");
    assert.ok(frag!.properties.subject, "subject field exposed");
    assert.ok(frag!.properties.message, "message field exposed");
  });

  it("returns a schema fragment scoped to the reaction actions", () => {
    const out = describeClawBitsMessageTool({
      cfg: cfgWith(configuredSection()),
      accountId: null,
    });
    const schema = out.schema;
    assert.ok(Array.isArray(schema), "schema is an array of contributions");
    const reactionFragment = schema.find(
      (s: { actions?: readonly string[] | null }) =>
        Array.isArray(s.actions) && s.actions.includes("react"),
    );
    assert.ok(reactionFragment, "schema contains a fragment scoped to react");
    assert.deepEqual(reactionFragment.actions, ["react", "reactions"]);
    assert.ok(
      reactionFragment.properties.messageId,
      "messageId field is exposed for the reaction actions",
    );
    assert.ok(
      reactionFragment.properties.emoji,
      "emoji field is exposed for the react action",
    );

    const descriptionFragment = schema.find(
      (s: { actions?: readonly string[] | null }) =>
        Array.isArray(s.actions) && s.actions.includes("update_description"),
    );
    assert.ok(descriptionFragment, "schema contains a fragment scoped to update_description");
    assert.ok(
      descriptionFragment.properties.description,
      "description field is exposed for the update_description action",
    );
  });
});

// ---------------------------------------------------------------------------
// createClawBitsActions().handleAction — react
// ---------------------------------------------------------------------------

describe("clawbitsActions.handleAction react", () => {
  const adapter = createClawBitsActions();
  if (!adapter.handleAction) throw new Error("handleAction missing");
  const handleAction = adapter.handleAction as (ctx: unknown) => Promise<unknown>;

  it("calls /api/agentic/mm/posts/{id}/reactions with the supplied emoji", async () => {
    const originalFetch = globalThis.fetch;
    const captured: { url: string; method: string; body: string }[] = [];
    globalThis.fetch = (async (url, init) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : "";
      if (u.endsWith("/api/agentic/auth/challenge")) {
        return challengeResponse();
      }
      if (u.endsWith("/api/agentic/mm/posts/42/reactions")) {
        captured.push({ url: u, method, body });
        return jsonResponse({
          post_id: 42,
          reactions: [
            { emoji: "🎉", count: 1, agent_ids: ["a1"], human_ids: [] },
          ],
        });
      }
      return new Response(`unexpected: ${u}`, { status: 500 });
    }) as typeof fetch;

    try {
      const result = (await handleAction({
        channel: "clawbits",
        action: "react",
        cfg: cfgWith(configuredSection()),
        params: { messageId: "42", emoji: "🎉" },
      })) as { ok: boolean; data: Record<string, unknown> };

      assert.equal(captured.length, 1, "exactly one POST to /reactions");
      assert.equal(captured[0]!.method, "POST");
      assert.deepEqual(JSON.parse(captured[0]!.body), { emoji: "🎉" });
      assert.equal(result.ok, true);
      assert.equal(result.data.action, "react");
      assert.equal(result.data.messageId, "42");
      // After the toggle our agent is in the bucket → "added".
      assert.equal((result.data as { added?: string }).added, "🎉");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accepts message_id (snake_case) as an alias for messageId", async () => {
    const originalFetch = globalThis.fetch;
    let postedTo = "";
    globalThis.fetch = (async (url, init) => {
      const u = String(url);
      if (u.endsWith("/api/agentic/auth/challenge")) {
        return challengeResponse();
      }
      if (u.includes("/api/agentic/mm/posts/") && u.endsWith("/reactions")) {
        postedTo = u;
        return jsonResponse({ reactions: [] });
      }
      return new Response(`unexpected: ${u}`, { status: 500 });
    }) as typeof fetch;

    try {
      await handleAction({
        channel: "clawbits",
        action: "react",
        cfg: cfgWith(configuredSection()),
        params: { message_id: "99", emoji: "👍" },
      });
      assert.ok(
        postedTo.endsWith("/api/agentic/mm/posts/99/reactions"),
        `posted to id-99 endpoint: ${postedTo}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects when messageId is missing", async () => {
    await assert.rejects(
      () =>
        handleAction({
          channel: "clawbits",
          action: "react",
          cfg: cfgWith(configuredSection()),
          params: { emoji: "🎉" },
        }),
      (err: unknown) =>
        err instanceof ClawBitsError && /messageId/.test(err.detail as string),
    );
  });

  it("rejects when emoji is missing", async () => {
    await assert.rejects(
      () =>
        handleAction({
          channel: "clawbits",
          action: "react",
          cfg: cfgWith(configuredSection()),
          params: { messageId: "42" },
        }),
      (err: unknown) =>
        err instanceof ClawBitsError && /Emoji/.test(err.detail as string),
    );
  });

  it("rejects when the account is disabled", async () => {
    await assert.rejects(
      () =>
        handleAction({
          channel: "clawbits",
          action: "react",
          cfg: cfgWith({ ...configuredSection(), enabled: false }),
          params: { messageId: "42", emoji: "🎉" },
        }),
      (err: unknown) =>
        err instanceof ClawBitsError && /disabled/.test(err.detail as string),
    );
  });

  it("issues a second toggle when remove=true and the agent is still present", async () => {
    const originalFetch = globalThis.fetch;
    let toggleCalls = 0;
    globalThis.fetch = (async (url) => {
      const u = String(url);
      if (u.endsWith("/api/agentic/auth/challenge")) {
        return challengeResponse();
      }
      if (u.endsWith("/api/agentic/mm/posts/42/reactions")) {
        toggleCalls += 1;
        // First call: agent now appears in the bucket. Second call:
        // agent is gone (toggled off again).
        if (toggleCalls === 1) {
          return jsonResponse({
            reactions: [
              { emoji: "🎉", count: 1, agent_ids: ["a1"], human_ids: [] },
            ],
          });
        }
        return jsonResponse({
          reactions: [
            { emoji: "🎉", count: 0, agent_ids: [], human_ids: [] },
          ],
        });
      }
      return new Response(`unexpected: ${u}`, { status: 500 });
    }) as typeof fetch;

    try {
      const result = (await handleAction({
        channel: "clawbits",
        action: "react",
        cfg: cfgWith(configuredSection()),
        params: { messageId: "42", emoji: "🎉", remove: true },
      })) as { data: Record<string, unknown> };
      assert.equal(toggleCalls, 2, "remove=true triggers a second toggle");
      assert.equal(result.data.removed, "🎉");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// createClawBitsActions().handleAction — update_description
// ---------------------------------------------------------------------------

describe("clawbitsActions.handleAction update_description", () => {
  const adapter = createClawBitsActions();
  if (!adapter.handleAction) throw new Error("handleAction missing");
  const handleAction = adapter.handleAction as (ctx: unknown) => Promise<unknown>;

  it("updates the agent profile description through the Clawbits API", async () => {
    const originalFetch = globalThis.fetch;
    const captured: { url: string; method: string; body: string; authorization?: string }[] = [];
    globalThis.fetch = (async (url, init) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : "";
      const headers = init?.headers as Record<string, string> | undefined;
      if (u.endsWith("/api/agentic/agents/a1/description")) {
        captured.push({
          url: u,
          method,
          body,
          authorization: headers?.Authorization,
        });
        return jsonResponse({
          agent_id: "a1",
          description: "I help review code.",
          description_source: "auto",
          description_generated_at: "2026-06-10T12:00:00Z",
        });
      }
      return new Response(`unexpected: ${u}`, { status: 500 });
    }) as typeof fetch;

    try {
      const result = (await handleAction({
        channel: "clawbits",
        action: "update_description",
        cfg: cfgWith(configuredSection()),
        params: { description: "I help review code." },
      })) as { ok: boolean; data: Record<string, unknown> };

      assert.equal(captured.length, 1, "exactly one PUT to /description");
      assert.equal(captured[0]!.method, "PUT");
      assert.equal(captured[0]!.authorization, "Bearer k1");
      assert.deepEqual(JSON.parse(captured[0]!.body), { description: "I help review code." });
      assert.equal(result.ok, true);
      assert.equal(result.data.action, "update_description");
      assert.equal(result.data.agentId, "a1");
      assert.equal(result.data.description, "I help review code.");
      assert.equal(result.data.description_source, "auto");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects when description is missing", async () => {
    await assert.rejects(
      () =>
        handleAction({
          channel: "clawbits",
          action: "update_description",
          cfg: cfgWith(configuredSection()),
          params: {},
        }),
      (err: unknown) =>
        err instanceof ClawBitsError && /description/.test(err.detail as string),
    );
  });
});

// ---------------------------------------------------------------------------
// createClawBitsActions().handleAction — reactions
// ---------------------------------------------------------------------------

describe("clawbitsActions.handleAction reactions", () => {
  const adapter = createClawBitsActions();
  if (!adapter.handleAction) throw new Error("handleAction missing");
  const handleAction = adapter.handleAction as (ctx: unknown) => Promise<unknown>;

  it("returns the reaction aggregate from the post listing", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      const u = String(url);
      if (u.endsWith("/api/agentic/mm/channels/ch1/posts")) {
        return jsonResponse({
          posts: [
            {
              post_id: 41,
              reactions: [{ emoji: "✨", count: 2, agent_ids: ["x"] }],
            },
            {
              post_id: 42,
              reactions: [{ emoji: "🎉", count: 1, agent_ids: ["a1"] }],
            },
          ],
        });
      }
      return new Response(`unexpected: ${u}`, { status: 500 });
    }) as typeof fetch;

    try {
      const result = (await handleAction({
        channel: "clawbits",
        action: "reactions",
        cfg: cfgWith(configuredSection()),
        params: { messageId: "42" },
      })) as { ok: boolean; data: { reactions: Array<{ emoji: string }> } };
      assert.equal(result.ok, true);
      assert.equal(result.data.reactions.length, 1);
      assert.equal(result.data.reactions[0]!.emoji, "🎉");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns an empty list when the post id is not in the listing", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      const u = String(url);
      if (u.endsWith("/api/agentic/mm/channels/ch1/posts")) {
        return jsonResponse({ posts: [] });
      }
      return new Response(`unexpected: ${u}`, { status: 500 });
    }) as typeof fetch;

    try {
      const result = (await handleAction({
        channel: "clawbits",
        action: "reactions",
        cfg: cfgWith(configuredSection()),
        params: { messageId: "999" },
      })) as { data: { reactions: unknown[] } };
      assert.deepEqual(result.data.reactions, []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects when no channelId is configured", async () => {
    await assert.rejects(
      () =>
        handleAction({
          channel: "clawbits",
          action: "reactions",
          cfg: cfgWith({
            endpoint: "http://h",
            orgId: "user-1",
            agentId: "a1",
            apiKey: "k1",
            // no channelId
          }),
          params: { messageId: "42" },
        }),
      (err: unknown) =>
        err instanceof ClawBitsError && /channelId/.test(err.detail as string),
    );
  });
});

// ---------------------------------------------------------------------------
// supportsAction
// ---------------------------------------------------------------------------

describe("clawbitsActions.supportsAction", () => {
  const adapter = createClawBitsActions();
  if (!adapter.supportsAction) throw new Error("supportsAction missing");
  const supports = adapter.supportsAction as (params: { action: string }) => boolean;

  it("returns true for react / reactions / update_description", () => {
    assert.equal(supports({ action: "react" }), true);
    assert.equal(supports({ action: "reactions" }), true);
    assert.equal(supports({ action: "update_description" }), true);
  });

  it("returns false for unrelated actions", () => {
    assert.equal(supports({ action: "send" }), false);
    assert.equal(supports({ action: "edit" }), false);
    assert.equal(supports({ action: "delete" }), false);
  });
});

// ---------------------------------------------------------------------------
// channelPlugin wiring
// ---------------------------------------------------------------------------

describe("clawbitsChannelPlugin.actions", () => {
  it("is registered on the channel plugin", async () => {
    const { clawbitsChannelPlugin } = await import("../src/plugin.js");
    const actions = (clawbitsChannelPlugin as unknown as { actions?: unknown }).actions;
    assert.ok(actions, "actions slot is populated");
    assert.equal(typeof (actions as { describeMessageTool?: unknown }).describeMessageTool, "function");
    assert.equal(typeof (actions as { handleAction?: unknown }).handleAction, "function");
  });
});

// ---------------------------------------------------------------------------
// createClawBitsActions().handleAction — send_email
// ---------------------------------------------------------------------------

describe("clawbitsActions.handleAction send_email", () => {
  const adapter = createClawBitsActions();
  if (!adapter.handleAction) throw new Error("handleAction missing");
  const handleAction = adapter.handleAction as (ctx: unknown) => Promise<unknown>;

  it("POSTs subject/message (+attachments) to /email/send with a challenge", async () => {
    const originalFetch = globalThis.fetch;
    const captured: { url: string; method: string; body: string; headers: Record<string, string> }[] = [];
    globalThis.fetch = (async (url, init) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : "";
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (u.endsWith("/api/agentic/auth/challenge")) {
        return challengeResponse();
      }
      if (u.endsWith("/api/agentic/agents/a1/email/send")) {
        captured.push({ url: u, method, body, headers });
        return jsonResponse({
          status: "sent",
          from_addr: "a1@clawbits.ai",
          to_addr: "owner@example.com",
          subject: "Hello",
        });
      }
      return new Response(`unexpected: ${u}`, { status: 500 });
    }) as typeof fetch;

    try {
      const result = (await handleAction({
        channel: "clawbits",
        action: "send_email",
        cfg: cfgWith(configuredSection()),
        params: {
          subject: "Hello",
          message: "Body text",
          attachments: [{ filename: "a.txt", content_b64: "aGk=" }],
        },
      })) as { ok: boolean; data: Record<string, unknown> };

      assert.equal(captured.length, 1, "exactly one POST to /email/send");
      assert.equal(captured[0]!.method, "POST");
      const sent = JSON.parse(captured[0]!.body);
      assert.equal(sent.subject, "Hello");
      assert.equal(sent.message, "Body text");
      assert.deepEqual(sent.attachments, [{ filename: "a.txt", content_b64: "aGk=" }]);
      // Challenge headers ride the paid send.
      assert.ok(captured[0]!.headers["session_token"], "session_token header present");
      assert.equal(result.ok, true);
      assert.equal(result.data.action, "send_email");
      assert.equal(result.data.status, "sent");
      assert.equal(result.data.to_addr, "owner@example.com");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("mirrors the sent email into the operator DM channel (temporary)", async () => {
    const originalFetch = globalThis.fetch;
    const posts: { url: string; message: string }[] = [];
    globalThis.fetch = (async (url, init) => {
      const u = String(url);
      const body = typeof init?.body === "string" ? init.body : "";
      if (u.endsWith("/api/agentic/auth/challenge")) {
        return challengeResponse();
      }
      if (u.endsWith("/api/agentic/agents/a1/email/send")) {
        return jsonResponse({
          status: "sent",
          from_addr: "a1@clawbits.ai",
          to_addr: "owner@example.com",
          subject: "Hello",
        });
      }
      if (u.endsWith("/api/agentic/mm/channels/ch1/posts")) {
        const parsed = body ? JSON.parse(body) : {};
        posts.push({ url: u, message: String(parsed.message ?? "") });
        return jsonResponse({ id: "p1" });
      }
      return new Response(`unexpected: ${u}`, { status: 500 });
    }) as typeof fetch;

    try {
      const result = (await handleAction({
        channel: "clawbits",
        action: "send_email",
        cfg: cfgWith(configuredSection()),
        params: { subject: "Hello", message: "Body text" },
      })) as { ok: boolean; data: Record<string, unknown> };

      assert.equal(result.ok, true);
      assert.equal(posts.length, 1, "exactly one DM mirror post for the sent email");
      assert.match(posts[0]!.url, /\/mm\/channels\/ch1\/posts$/, "mirror goes to the operator DM channel");
      assert.match(posts[0]!.message, /Email · sent/, "mirror is labelled as a sent email");
      assert.match(posts[0]!.message, /Hello/, "mirror carries the subject");
      assert.match(posts[0]!.message, /Body text/, "mirror carries the message body");
      assert.match(posts[0]!.message, /^> /m, "mirror is blockquoted to set it apart from chat");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("still succeeds when the DM mirror fails (best-effort)", async () => {
    const originalFetch = globalThis.fetch;
    let sendCount = 0;
    globalThis.fetch = (async (url) => {
      const u = String(url);
      if (u.endsWith("/api/agentic/auth/challenge")) {
        return challengeResponse();
      }
      if (u.endsWith("/api/agentic/agents/a1/email/send")) {
        sendCount += 1;
        return jsonResponse({ status: "sent", to_addr: "owner@example.com", subject: "Hello" });
      }
      if (u.endsWith("/api/agentic/mm/channels/ch1/posts")) {
        return new Response("mirror boom", { status: 500 });
      }
      return new Response(`unexpected: ${u}`, { status: 500 });
    }) as typeof fetch;

    try {
      const result = (await handleAction({
        channel: "clawbits",
        action: "send_email",
        cfg: cfgWith(configuredSection()),
        params: { subject: "Hello", message: "Body text" },
      })) as { ok: boolean; data: Record<string, unknown> };

      assert.equal(sendCount, 1, "the email was sent");
      assert.equal(result.ok, true, "send_email still succeeds even though the DM mirror failed");
      assert.equal(result.data.status, "sent");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects when subject or message is missing", async () => {
    await assert.rejects(
      () =>
        handleAction({
          channel: "clawbits",
          action: "send_email",
          cfg: cfgWith(configuredSection()),
          params: { subject: "no body" },
        }),
      (err: unknown) =>
        err instanceof ClawBitsError && /message is required/.test(String(err.detail)),
    );
  });
});
