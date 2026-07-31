import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ClawBitsClient } from "../src/client.js";
import { runChannelHealthcheck } from "../src/setup-flow.js";
import { PLUGIN_VERSION } from "../src/version.js";

const ANSWERS = { "probe-challenge": "ok" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Build a fake fetch that satisfies the challenge handshake, captures the
 * posted message, and serves channel posts back from `postsFactory`. The
 * factory receives the message that was posted so a test can choose to echo
 * it (healthy) or omit it (unhealthy).
 *
 * ``versionCheck`` defaults to ``supported: true`` so legacy tests keep
 * exercising the probe-roundtrip path. Pass a custom verdict to exercise
 * the version-gate short-circuit.
 */
function makeFakeFetch(opts: {
  postsFactory: (postedMessage: string | undefined) => Array<{ post_id: string; message: string }>;
  postStatus?: number;
  versionCheck?: {
    supported: boolean;
    plugin_version?: string | null;
    min_plugin_version?: string;
    message?: string | null;
  };
}): { fetch: typeof fetch; calls: Array<{ method: string; url: string; headers: Record<string, string> }> } {
  const calls: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
  let postedMessage: string | undefined;
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({ method, url: u, headers: { ...(headers ?? {}) } });
    if (u.endsWith("/api/agentic/version-check")) {
      return jsonResponse(
        opts.versionCheck ?? {
          supported: true,
          plugin_version: PLUGIN_VERSION,
          min_plugin_version: PLUGIN_VERSION,
          message: null,
        },
      );
    }
    if (u.endsWith("/api/agentic/auth/challenge")) {
      return jsonResponse({ challenge: "probe-challenge", session_token: "st-1" });
    }
    if (method === "POST" && u.includes("/posts")) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      postedMessage = typeof body.message === "string" ? body.message : undefined;
      return jsonResponse({ post_id: "srv-1" }, opts.postStatus ?? 200);
    }
    if (method === "GET" && u.includes("/posts")) {
      return jsonResponse({ posts: opts.postsFactory(postedMessage) });
    }
    return jsonResponse({});
  };
  return { fetch: fetchImpl as unknown as typeof fetch, calls };
}

describe("runChannelHealthcheck", () => {
  it("reports ok when the probe is read back from the channel", async () => {
    const { fetch } = makeFakeFetch({
      // Echo the exact message that was posted, so the marker matches.
      postsFactory: (msg) => (msg ? [{ post_id: "srv-1", message: msg }] : []),
    });
    const client = new ClawBitsClient({ endpoint: "http://h", apiKey: "k", fetchImpl: fetch });

    const result = await runChannelHealthcheck({
      client,
      channelId: "chan-1",
      knownAnswersOverride: ANSWERS,
      pollIntervalMs: 0,
      maxAttempts: 3,
    });

    assert.equal(result.ok, true);
    assert.equal(result.channelId, "chan-1");
    assert.equal(result.sentPostId, "srv-1");
    assert.equal(result.observedPostId, "srv-1");
    assert.ok(result.attempts >= 1);
    assert.equal(result.error, undefined);
    assert.equal(result.version?.supported, true);
  });

  it("reports failure when the probe is never read back", async () => {
    const { fetch } = makeFakeFetch({
      // Channel never surfaces the probe (e.g. server accepts but drops it).
      postsFactory: () => [{ post_id: "other", message: "unrelated chatter" }],
    });
    const client = new ClawBitsClient({ endpoint: "http://h", apiKey: "k", fetchImpl: fetch });

    const result = await runChannelHealthcheck({
      client,
      channelId: "chan-1",
      knownAnswersOverride: ANSWERS,
      pollIntervalMs: 0,
      maxAttempts: 2,
    });

    assert.equal(result.ok, false);
    assert.equal(result.attempts, 2);
    assert.equal(result.reason, "timeout");
    assert.match(result.error ?? "", /never read back/);
  });

  it("reports a send failure without attempting reads", async () => {
    const { fetch } = makeFakeFetch({
      postsFactory: () => [],
      postStatus: 500,
    });
    const client = new ClawBitsClient({ endpoint: "http://h", apiKey: "k", fetchImpl: fetch });

    const result = await runChannelHealthcheck({
      client,
      channelId: "chan-1",
      knownAnswersOverride: ANSWERS,
      pollIntervalMs: 0,
      maxAttempts: 3,
    });

    assert.equal(result.ok, false);
    assert.equal(result.attempts, 0);
    assert.equal(result.reason, "send_failed");
    assert.match(result.error ?? "", /send failed/);
  });

  it("does not block — proceeds with the probe when the server reports the plugin outdated", async () => {
    const { fetch, calls } = makeFakeFetch({
      // Probe pathway must still run: an outdated plugin is a warning, not a gate.
      postsFactory: (msg) => (msg ? [{ post_id: "srv-1", message: msg }] : []),
      versionCheck: {
        supported: false,
        plugin_version: "0.0.1",
        min_plugin_version: "9.9.9",
        message: "Plugin 0.0.1 is below the server's minimum supported version 9.9.9.",
      },
    });
    const client = new ClawBitsClient({ endpoint: "http://h", apiKey: "k", fetchImpl: fetch });

    const result = await runChannelHealthcheck({
      client,
      channelId: "chan-1",
      knownAnswersOverride: ANSWERS,
      pollIntervalMs: 0,
      maxAttempts: 3,
    });

    // Setup succeeds despite the outdated verdict, which still rides along
    // so the status surface can surface a "please update" hint.
    assert.equal(result.ok, true);
    assert.equal(result.version?.supported, false);
    assert.equal(result.version?.min_plugin_version, "9.9.9");

    // The probe pathway was exercised — the version check is no longer a gate.
    const probeCalls = calls.filter((c) => !c.url.endsWith("/api/agentic/version-check"));
    assert.ok(
      probeCalls.length > 0,
      "expected the probe pathway to run despite the outdated plugin verdict",
    );
  });

  it("sends X-Clawbits-Plugin-Version on every request", async () => {
    const { fetch, calls } = makeFakeFetch({
      postsFactory: (msg) => (msg ? [{ post_id: "srv-1", message: msg }] : []),
    });
    const client = new ClawBitsClient({ endpoint: "http://h", apiKey: "k", fetchImpl: fetch });

    await runChannelHealthcheck({
      client,
      channelId: "chan-1",
      knownAnswersOverride: ANSWERS,
      pollIntervalMs: 0,
      maxAttempts: 3,
    });

    assert.ok(calls.length > 0, "expected at least one HTTP call");
    for (const c of calls) {
      assert.equal(
        c.headers["X-Clawbits-Plugin-Version"],
        PLUGIN_VERSION,
        `${c.method} ${c.url} missing plugin version header`,
      );
    }
  });
});
