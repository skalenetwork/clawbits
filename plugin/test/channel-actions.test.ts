import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import {
  createClawBitsActions,
  describeClawBitsMessageTool,
} from "../src/channel-actions.js";
import { ClawBitsError } from "../src/errors.js";

function cfgWith(section: Record<string, unknown>): OpenClawConfig {
  return { channels: { clawbits: section } };
}

function configuredSection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    endpoint: "http://h",
    orgId: "org-1",
    agentId: "a1",
    apiKey: "k1",
    channelId: "ch1",
    knownAnswers: { "What is the capital of France?": "Paris" },
    ...overrides,
  };
}

function challengeResponse(): Response {
  return new Response(
    JSON.stringify({
      session_token: "sess-1",
      challenge: "What is the capital of France?",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("describeClawBitsMessageTool", () => {
  it("advertises only channel-owned reaction actions", () => {
    const out = describeClawBitsMessageTool({
      cfg: cfgWith(configuredSection()),
      accountId: null,
    });
    assert.deepEqual(out.actions, ["react", "reactions"]);
    assert.equal(out.schema?.length, 1);
    assert.deepEqual(out.schema?.[0]?.actions, ["react", "reactions"]);
    assert.ok(out.schema?.[0]?.properties.messageId);
    assert.ok(out.schema?.[0]?.properties.emoji);
  });
});

describe("clawbits channel reactions", () => {
  const adapter = createClawBitsActions();
  if (!adapter.handleAction) throw new Error("handleAction missing");
  const handleAction = adapter.handleAction as (ctx: unknown) => Promise<unknown>;

  it("toggles a reaction", async () => {
    const originalFetch = globalThis.fetch;
    const captured: Array<{ method: string; body: string }> = [];
    globalThis.fetch = (async (url, init) => {
      const target = String(url);
      if (target.endsWith("/api/agentic/auth/challenge")) return challengeResponse();
      if (target.endsWith("/api/agentic/mm/posts/42/reactions")) {
        captured.push({
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : "",
        });
        return jsonResponse({
          reactions: [{ emoji: "🎉", count: 1, agent_ids: ["a1"], human_ids: [] }],
        });
      }
      return new Response(`unexpected: ${target}`, { status: 500 });
    }) as typeof fetch;

    try {
      const result = (await handleAction({
        channel: "clawbits",
        action: "react",
        cfg: cfgWith(configuredSection()),
        params: { messageId: "42", emoji: "🎉" },
      })) as { ok: boolean; data: Record<string, unknown> };
      assert.equal(captured.length, 1);
      assert.equal(captured[0]?.method, "POST");
      assert.deepEqual(JSON.parse(captured[0]?.body ?? "{}"), { emoji: "🎉" });
      assert.equal(result.ok, true);
      assert.equal(result.data.added, "🎉");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses a second toggle for remove=true when needed", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (url) => {
      const target = String(url);
      if (target.endsWith("/api/agentic/auth/challenge")) return challengeResponse();
      if (target.endsWith("/api/agentic/mm/posts/42/reactions")) {
        calls += 1;
        return jsonResponse({
          reactions: [
            {
              emoji: "🎉",
              count: calls === 1 ? 1 : 0,
              agent_ids: calls === 1 ? ["a1"] : [],
              human_ids: [],
            },
          ],
        });
      }
      return new Response(`unexpected: ${target}`, { status: 500 });
    }) as typeof fetch;

    try {
      const result = (await handleAction({
        channel: "clawbits",
        action: "react",
        cfg: cfgWith(configuredSection()),
        params: { messageId: "42", emoji: "🎉", remove: true },
      })) as { data: Record<string, unknown> };
      assert.equal(calls, 2);
      assert.equal(result.data.removed, "🎉");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reads reactions from the configured channel", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      const target = String(url);
      assert.ok(target.endsWith("/api/agentic/mm/channels/ch1/posts"));
      return jsonResponse({
        posts: [{ post_id: 42, reactions: [{ emoji: "👍", count: 2 }] }],
      });
    }) as typeof fetch;
    try {
      const result = (await handleAction({
        channel: "clawbits",
        action: "reactions",
        cfg: cfgWith(configuredSection()),
        params: { messageId: "42" },
      })) as { data: Record<string, unknown> };
      assert.deepEqual(result.data.reactions, [{ emoji: "👍", count: 2 }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects missing params and disabled accounts", async () => {
    await assert.rejects(
      () =>
        handleAction({
          channel: "clawbits",
          action: "react",
          cfg: cfgWith(configuredSection()),
          params: { emoji: "🎉" },
        }),
      (error: unknown) => error instanceof ClawBitsError && /messageId/.test(error.detail),
    );
    await assert.rejects(
      () =>
        handleAction({
          channel: "clawbits",
          action: "react",
          cfg: cfgWith(configuredSection({ enabled: false })),
          params: { messageId: "42", emoji: "🎉" },
        }),
      (error: unknown) => error instanceof ClawBitsError && /disabled/.test(error.detail),
    );
  });

  it("supports only react and reactions", () => {
    assert.equal(adapter.supportsAction?.({ action: "react" }), true);
    assert.equal(adapter.supportsAction?.({ action: "reactions" }), true);
    assert.equal(adapter.supportsAction?.({ action: "send_email" }), false);
    assert.equal(adapter.supportsAction?.({ action: "update_description" }), false);
  });
});
