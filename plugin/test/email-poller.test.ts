import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ClawBitsClient } from "../src/client.js";
import { ChannelWatermarkStore } from "../src/channel-watermarks.js";
import {
  runEmailPoller,
  EMAIL_WATERMARK_CHANNEL,
  type EmailInboundMessage,
} from "../src/email-poller.js";
import type { ResolvedClawBitsAccount } from "../src/types.js";

const ACCOUNT_ID = "default";
const AGENT_ID = "a1";

function makeAccount(overrides: Partial<ResolvedClawBitsAccount> = {}): ResolvedClawBitsAccount {
  return {
    accountId: ACCOUNT_ID,
    enabled: true,
    configured: true,
    endpoint: "http://h.example",
    agentId: AGENT_ID,
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

function makeClient(): ClawBitsClient {
  return new ClawBitsClient({ endpoint: "http://h.example", apiKey: "k1" });
}

/** Route a fetch by URL to a body/status. */
function installFetchStub(
  handler: (url: string) => { body?: unknown; status?: number },
): { restore: () => void; calls: string[] } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push(url);
    const { body, status } = handler(url);
    return new Response(JSON.stringify(body ?? {}), {
      status: status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = original; }, calls };
}

describe("runEmailPoller", () => {
  it("seeds the watermark to the max existing uid without injecting on first run", async () => {
    const wm = ChannelWatermarkStore.inMemory();
    const seen: EmailInboundMessage[] = [];
    const controller = new AbortController();
    const stub = installFetchStub((url) => {
      if (url.includes("/email/count")) return { body: { total: 3, unread: 0 } };
      if (url.includes("/email/inbox")) {
        return { body: { emails: [{ uid: 1 }, { uid: 2 }, { uid: 3 }], total: 3, unread_count: 0 } };
      }
      return { body: {}, status: 500 };
    });
    try {
      const run = runEmailPoller({
        client: makeClient(),
        account: makeAccount(),
        abortSignal: controller.signal,
        watermarkStore: wm,
        onEmailMessage: (m) => { seen.push(m); },
      });
      await new Promise((r) => setTimeout(r, 40));
      controller.abort();
      await run;
      assert.equal(seen.length, 0, "no email injected on first observation");
      assert.equal(wm.get(ACCOUNT_ID, EMAIL_WATERMARK_CHANNEL), 3, "watermark seeded to max uid");
    } finally {
      stub.restore();
    }
  });

  it("injects only uids beyond the watermark, in ascending order, and advances it", async () => {
    const wm = ChannelWatermarkStore.inMemory();
    wm.set(ACCOUNT_ID, EMAIL_WATERMARK_CHANNEL, 0); // already-seeded, watermark 0
    const seen: EmailInboundMessage[] = [];
    const controller = new AbortController();
    const stub = installFetchStub((url) => {
      if (url.includes("/email/count")) return { body: { total: 3, unread: 3 } };
      if (url.includes("/email/inbox")) {
        return { body: { emails: [{ uid: 3 }, { uid: 1 }, { uid: 2 }], total: 3, unread_count: 3 } };
      }
      const m = /\/email\/(\d+)$/.exec(url);
      if (m) {
        const uid = Number(m[1]);
        return { body: { uid, from_addr: "owner@x", to_addr: "a1@clawbits.ai", subject: `s${uid}`, date: "d", body_text: `b${uid}`, attachments: [], headers: {} } };
      }
      return { body: {}, status: 500 };
    });
    try {
      const run = runEmailPoller({
        client: makeClient(),
        account: makeAccount(),
        abortSignal: controller.signal,
        watermarkStore: wm,
        onEmailMessage: (m) => { seen.push(m); },
      });
      await new Promise((r) => setTimeout(r, 60));
      controller.abort();
      await run;
      assert.deepEqual(seen.map((m) => m.uid), [1, 2, 3], "injected in ascending uid order");
      assert.equal(seen[0]!.bodyText, "b1");
      assert.equal(wm.get(ACCOUNT_ID, EMAIL_WATERMARK_CHANNEL), 3, "watermark advanced to newest uid");
    } finally {
      stub.restore();
    }
  });

  it("skips a uid that 404s on fetch but still advances past it", async () => {
    const wm = ChannelWatermarkStore.inMemory();
    wm.set(ACCOUNT_ID, EMAIL_WATERMARK_CHANNEL, 0);
    const seen: EmailInboundMessage[] = [];
    const controller = new AbortController();
    const stub = installFetchStub((url) => {
      if (url.includes("/email/count")) return { body: { total: 2, unread: 2 } };
      if (url.includes("/email/inbox")) return { body: { emails: [{ uid: 1 }, { uid: 2 }], total: 2, unread_count: 2 } };
      if (url.endsWith("/email/1")) return { body: { detail: "gone" }, status: 404 };
      if (url.endsWith("/email/2")) return { body: { uid: 2, from_addr: "o", subject: "s2", date: "d", body_text: "b2", attachments: [], headers: {} } };
      return { body: {}, status: 500 };
    });
    try {
      const run = runEmailPoller({
        client: makeClient(),
        account: makeAccount(),
        abortSignal: controller.signal,
        watermarkStore: wm,
        onEmailMessage: (m) => { seen.push(m); },
      });
      await new Promise((r) => setTimeout(r, 60));
      controller.abort();
      await run;
      assert.deepEqual(seen.map((m) => m.uid), [2], "only the fetchable email is injected");
      assert.equal(wm.get(ACCOUNT_ID, EMAIL_WATERMARK_CHANNEL), 2, "watermark advanced past the missing uid");
    } finally {
      stub.restore();
    }
  });

  it("stops cleanly when the server reports email is not configured (503)", async () => {
    const wm = ChannelWatermarkStore.inMemory();
    const seen: EmailInboundMessage[] = [];
    const controller = new AbortController();
    let inboxCalls = 0;
    const stub = installFetchStub((url) => {
      if (url.includes("/email/count")) return { body: { detail: "not configured" }, status: 503 };
      if (url.includes("/email/inbox")) { inboxCalls += 1; return { body: { emails: [] } }; }
      return { body: {}, status: 500 };
    });
    try {
      // Should resolve on its own (returns on 503) before we ever abort.
      await runEmailPoller({
        client: makeClient(),
        account: makeAccount(),
        abortSignal: controller.signal,
        watermarkStore: wm,
        onEmailMessage: (m) => { seen.push(m); },
      });
      assert.equal(seen.length, 0, "no email injected");
      assert.equal(inboxCalls, 0, "never reached the inbox listing");
    } finally {
      stub.restore();
      controller.abort();
    }
  });

  it("pages past the first window so a burst larger than the page size isn't skipped", async () => {
    const wm = ChannelWatermarkStore.inMemory();
    wm.set(ACCOUNT_ID, EMAIL_WATERMARK_CHANNEL, 0); // seeded, watermark 0
    const seen: EmailInboundMessage[] = [];
    const controller = new AbortController();
    // 60 messages, newest-first, served in pages of 50 keyed by offset.
    const allDesc = Array.from({ length: 60 }, (_, i) => 60 - i); // [60..1]
    const stub = installFetchStub((url) => {
      if (url.includes("/email/count")) return { body: { total: 60, unread: 60 } };
      if (url.includes("/email/inbox")) {
        const m = /offset=(\d+)/.exec(url);
        const offset = m ? Number(m[1]) : 0;
        const slice = allDesc.slice(offset, offset + 50).map((uid) => ({ uid }));
        return { body: { emails: slice, total: 60, unread_count: 60 } };
      }
      const mm = /\/email\/(\d+)$/.exec(url);
      if (mm) {
        const uid = Number(mm[1]);
        return { body: { uid, from_addr: "o", to_addr: "a1@clawbits.ai", subject: `s${uid}`, date: "d", body_text: `b${uid}`, attachments: [], headers: {} } };
      }
      return { body: {}, status: 500 };
    });
    try {
      const run = runEmailPoller({
        client: makeClient(),
        account: makeAccount(),
        abortSignal: controller.signal,
        watermarkStore: wm,
        onEmailMessage: (m) => { seen.push(m); },
      });
      await new Promise((r) => setTimeout(r, 120));
      controller.abort();
      await run;
      assert.deepEqual(seen.map((m) => m.uid), Array.from({ length: 60 }, (_, i) => i + 1), "all 60 injected in ascending order");
      assert.equal(wm.get(ACCOUNT_ID, EMAIL_WATERMARK_CHANNEL), 60, "watermark advanced to newest uid");
    } finally {
      stub.restore();
    }
  });

  it("falls back to stripped HTML when there is no plain-text body", async () => {
    const wm = ChannelWatermarkStore.inMemory();
    wm.set(ACCOUNT_ID, EMAIL_WATERMARK_CHANNEL, 0);
    const seen: EmailInboundMessage[] = [];
    const controller = new AbortController();
    const stub = installFetchStub((url) => {
      if (url.includes("/email/count")) return { body: { total: 1, unread: 1 } };
      if (url.includes("/email/inbox")) return { body: { emails: [{ uid: 1 }], total: 1, unread_count: 1 } };
      if (url.endsWith("/email/1")) {
        return { body: { uid: 1, from_addr: "o", to_addr: "a1@clawbits.ai", subject: "s1", date: "d", body_text: "", body_html: "<p>Hello <b>world</b></p>", attachments: [], headers: {} } };
      }
      return { body: {}, status: 500 };
    });
    try {
      const run = runEmailPoller({
        client: makeClient(),
        account: makeAccount(),
        abortSignal: controller.signal,
        watermarkStore: wm,
        onEmailMessage: (m) => { seen.push(m); },
      });
      await new Promise((r) => setTimeout(r, 60));
      controller.abort();
      await run;
      assert.equal(seen.length, 1);
      assert.equal(seen[0]!.bodyText, "Hello world", "HTML body reduced to text");
    } finally {
      stub.restore();
    }
  });

  it("retries a transient fetch failure on the next poll even when counts are unchanged", async () => {
    const wm = ChannelWatermarkStore.inMemory();
    wm.set(ACCOUNT_ID, EMAIL_WATERMARK_CHANNEL, 0);
    const seen: EmailInboundMessage[] = [];
    const controller = new AbortController();
    let attempt = 0;
    const stub = installFetchStub((url) => {
      if (url.includes("/email/count")) return { body: { total: 1, unread: 1 } }; // never changes
      if (url.includes("/email/inbox")) return { body: { emails: [{ uid: 1 }], total: 1, unread_count: 1 } };
      if (url.endsWith("/email/1")) {
        attempt += 1;
        if (attempt === 1) return { body: { detail: "boom" }, status: 500 }; // transient
        return { body: { uid: 1, from_addr: "o", to_addr: "a1@clawbits.ai", subject: "s1", date: "d", body_text: "b1", attachments: [], headers: {} } };
      }
      return { body: {}, status: 500 };
    });
    try {
      // Tiny explicit interval (bypasses the 30s floor) so two cycles run fast.
      const run = runEmailPoller({
        client: makeClient(),
        account: makeAccount(),
        abortSignal: controller.signal,
        watermarkStore: wm,
        pollIntervalMs: 5,
        onEmailMessage: (m) => { seen.push(m); },
      });
      const deadline = Date.now() + 1000;
      while (wm.get(ACCOUNT_ID, EMAIL_WATERMARK_CHANNEL) !== 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      controller.abort();
      await run;
      assert.ok(attempt >= 2, "the failed uid was retried");
      assert.deepEqual(seen.map((m) => m.uid), [1], "delivered exactly once, after the retry");
      assert.equal(wm.get(ACCOUNT_ID, EMAIL_WATERMARK_CHANNEL), 1, "watermark advanced only after success");
    } finally {
      stub.restore();
    }
  });

  it("re-checks the inbox when unread changes but total does not (delete + arrival)", async () => {
    const wm = ChannelWatermarkStore.inMemory();
    wm.set(ACCOUNT_ID, EMAIL_WATERMARK_CHANNEL, 0);
    const seen: EmailInboundMessage[] = [];
    const controller = new AbortController();
    // Phase advances with the watermark: before uid1 is seen the box holds uid1;
    // after, a delete+arrival keeps total at 1 but bumps unread and lists uid2.
    const stub = installFetchStub((url) => {
      const seenFirst = (wm.get(ACCOUNT_ID, EMAIL_WATERMARK_CHANNEL) ?? 0) >= 1;
      if (url.includes("/email/count")) {
        return { body: { total: 1, unread: seenFirst ? 1 : 0 } };
      }
      if (url.includes("/email/inbox")) {
        return { body: { emails: [{ uid: seenFirst ? 2 : 1 }], total: 1, unread_count: seenFirst ? 1 : 0 } };
      }
      const mm = /\/email\/(\d+)$/.exec(url);
      if (mm) {
        const uid = Number(mm[1]);
        return { body: { uid, from_addr: "o", to_addr: "a1@clawbits.ai", subject: `s${uid}`, date: "d", body_text: `b${uid}`, attachments: [], headers: {} } };
      }
      return { body: {}, status: 500 };
    });
    try {
      const run = runEmailPoller({
        client: makeClient(),
        account: makeAccount(),
        abortSignal: controller.signal,
        watermarkStore: wm,
        pollIntervalMs: 5,
        onEmailMessage: (m) => { seen.push(m); },
      });
      const deadline = Date.now() + 1000;
      while (wm.get(ACCOUNT_ID, EMAIL_WATERMARK_CHANNEL) !== 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      controller.abort();
      await run;
      assert.deepEqual(seen.map((m) => m.uid), [1, 2], "both messages delivered despite unchanged total");
      assert.equal(wm.get(ACCOUNT_ID, EMAIL_WATERMARK_CHANNEL), 2);
    } finally {
      stub.restore();
    }
  });
});
