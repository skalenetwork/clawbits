import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ChannelOutboundContext } from "openclaw/plugin-sdk/core";
import {
  __resetDraftRegistryForTest,
  registerOpenDraft,
  type OpenDraftRef,
} from "../src/draft-registry.js";
import { __resetOutboundDedupeForTest, outboundAdapter } from "../src/outbound-adapter.js";

const CHANNEL = "916abcc5-5eb2-4bb9-9ff6-b3b5b7070b4d";

/** Minimal cfg the account resolver accepts: enabled, configured, has apiKey. */
function cfg() {
  return {
    channels: {
      clawbits: {
        accounts: {
          default: {
            endpoint: "http://fc",
            orgId: "org-1",
            agentId: "bot",
            apiKey: "k",
            channelId: CHANNEL,
          },
        },
      },
    },
  } as unknown as ChannelOutboundContext["cfg"];
}

/**
 * Stub `globalThis.fetch` for the challenge + post flow and count POSTs /
 * PATCHes to the posts endpoints. The challenge GET returns a bundled known
 * answer so `withChallenge` resolves on the first try; each post returns a
 * fresh id. Set `failPatches` to make draft-finalize PATCHes 404 (draft
 * already cancelled server-side).
 */
function installFetchStub(opts: { failPatches?: boolean } = {}): {
  restore: () => void;
  postCount: () => number;
  patchCount: () => number;
  lastPatchBody: () => unknown;
} {
  const original = globalThis.fetch;
  let posts = 0;
  let patches = 0;
  let lastPatchBody: unknown;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/api/agentic/auth/challenge")) {
      return new Response(
        JSON.stringify({ challenge: "What is the capital of France?", session_token: "tok" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (method === "PATCH" && url.includes("/posts/")) {
      patches += 1;
      lastPatchBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (opts.failPatches) {
        return new Response(JSON.stringify({ detail: "Post not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ post_id: 777, channel_id: CHANNEL, message: "", status: "published" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (method === "POST" && url.includes("/posts")) {
      posts += 1;
      // Mirror the real create-post response: MmPostResponse carries a
      // NUMERIC ``post_id`` and no ``id`` field. Keeping the stub honest is
      // what guards the String() coercion in the adapter (OpenClaw's receipt
      // code calls .trim() on message ids, so a leaked number fails the send).
      return new Response(
        JSON.stringify({
          post_id: 1000 + posts,
          channel_id: CHANNEL,
          message: "",
          status: "published",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    postCount: () => posts,
    patchCount: () => patches,
    lastPatchBody: () => lastPatchBody,
  };
}

function send(text: string, extra: Partial<ChannelOutboundContext> = {}) {
  return outboundAdapter.sendText!({
    cfg: cfg(),
    to: CHANNEL,
    text,
    ...extra,
  } as ChannelOutboundContext);
}

describe("outboundAdapter.sendText idempotency", () => {
  beforeEach(() => {
    __resetOutboundDedupeForTest();
  });

  it("collapses an identical re-send into one post (best-effort retry)", async () => {
    const stub = installFetchStub();
    try {
      const first = await send("y = 11");
      const second = await send("y = 11");
      assert.equal(stub.postCount(), 1, "the duplicate re-send must not mint a second post");
      // The retry reuses the original post id so the delivery layer acks it.
      assert.equal(second.messageId, first.messageId);
      assert.equal(second.channelId, CHANNEL);
    } finally {
      stub.restore();
    }
  });

  it("does not collapse two genuinely different replies", async () => {
    const stub = installFetchStub();
    try {
      await send("first answer");
      await send("second answer");
      assert.equal(stub.postCount(), 2, "distinct bodies must each post");
    } finally {
      stub.restore();
    }
  });

  it("keys on replyToId so identical text for different turns both post", async () => {
    const stub = installFetchStub();
    try {
      await send("ok", { replyToId: "100" });
      await send("ok", { replyToId: "200" });
      assert.equal(stub.postCount(), 2, "same text but different reply target must both post");
    } finally {
      stub.restore();
    }
  });

  it("posts again after the dedup cache is cleared", async () => {
    const stub = installFetchStub();
    try {
      await send("again");
      __resetOutboundDedupeForTest();
      await send("again");
      assert.equal(stub.postCount(), 2);
    } finally {
      stub.restore();
    }
  });
});

describe("outboundAdapter.sendText result shape", () => {
  beforeEach(() => {
    __resetOutboundDedupeForTest();
    __resetDraftRegistryForTest();
  });

  // Regression: the server returns post_id as an int; leaking it as a number
  // made OpenClaw's receipt normalization throw "value?.trim is not a
  // function" AFTER the post landed, so every cron announce delivered its
  // message and then reported the run as failed.
  it("stringifies the server's numeric post_id", async () => {
    const stub = installFetchStub();
    try {
      const result = await send("cron announce body");
      assert.equal(typeof result.messageId, "string");
      assert.equal(result.messageId, "1001");
      assert.equal(result.channelId, CHANNEL);
    } finally {
      stub.restore();
    }
  });
});

describe("outboundAdapter.sendText draft takeover", () => {
  beforeEach(() => {
    __resetOutboundDedupeForTest();
    __resetDraftRegistryForTest();
  });

  it("finalizes the turn's open shimmer draft in place instead of minting a post", async () => {
    const stub = installFetchStub();
    const ref: OpenDraftRef = { id: 777 };
    registerOpenDraft("default", CHANNEL, ref);
    try {
      const result = await send("the actual reply");
      assert.equal(stub.patchCount(), 1, "reply must land as a PATCH on the draft");
      assert.equal(stub.postCount(), 0, "no separate post may be minted");
      assert.deepEqual(stub.lastPatchBody(), { replace: "the actual reply", done: true });
      assert.equal(result.messageId, "777");
      // Ref emptied so the gateway's turn-end cleanup skips the cancel.
      assert.equal(ref.id, undefined);
    } finally {
      stub.restore();
    }
  });

  it("only the first send of a turn takes the draft; later sends post normally", async () => {
    const stub = installFetchStub();
    registerOpenDraft("default", CHANNEL, { id: 777 });
    try {
      await send("first message");
      await send("second message");
      assert.equal(stub.patchCount(), 1);
      assert.equal(stub.postCount(), 1, "the second reply mints its own post");
    } finally {
      stub.restore();
    }
  });

  it("falls back to minting a post when the draft PATCH fails", async () => {
    const stub = installFetchStub({ failPatches: true });
    registerOpenDraft("default", CHANNEL, { id: 777 });
    try {
      const result = await send("reply after draft vanished");
      assert.equal(stub.patchCount(), 1, "the takeover was attempted");
      assert.equal(stub.postCount(), 1, "the reply still lands as a fresh post");
      assert.equal(result.messageId, "1001");
    } finally {
      stub.restore();
    }
  });

  it("ignores drafts registered for other channels", async () => {
    const stub = installFetchStub();
    registerOpenDraft("default", "another-channel", { id: 555 });
    try {
      await send("unrelated reply");
      assert.equal(stub.patchCount(), 0);
      assert.equal(stub.postCount(), 1);
    } finally {
      stub.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// sendMedia
// ---------------------------------------------------------------------------

const MEDIA_URL = "https://media.example.invalid/gen.png";
const MEDIA_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]);

/**
 * Fetch stub for the media path: serves the https media bytes, accepts the
 * direct upload, and mints post ids. `failUploads` makes the direct route
 * (and the presigned reserve) 500 so the upload-failure fallbacks kick in.
 */
function installMediaFetchStub(opts: { failUploads?: boolean } = {}): {
  restore: () => void;
  postBodies: () => unknown[];
  directCount: () => number;
  patchBodies: () => unknown[];
} {
  const original = globalThis.fetch;
  const postBodies: unknown[] = [];
  const patchBodies: unknown[] = [];
  let directs = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/api/agentic/auth/challenge")) {
      return new Response(
        JSON.stringify({ challenge: "What is the capital of France?", session_token: "tok" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (method === "PATCH" && url.includes("/posts/")) {
      // Draft cancel/finalize; the cancel path returns 204 with no body.
      patchBodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
      return new Response(null, { status: 204 });
    }
    if (url.startsWith("https://media.example.invalid/")) {
      return new Response(MEDIA_BYTES, {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }
    if (url.includes("/files/direct")) {
      directs += 1;
      if (opts.failUploads) {
        return new Response(JSON.stringify({ detail: "boom" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ file_id: "media-file-1", status: "uploaded" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (method === "POST" && url.includes("/files")) {
      // Presigned reserve — only reachable when the direct route 404s,
      // which this stub never does; fail loudly if hit.
      return new Response(JSON.stringify({ detail: "unexpected reserve" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (method === "POST" && url.includes("/posts")) {
      postBodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
      return new Response(
        JSON.stringify({
          post_id: 2000 + postBodies.length,
          channel_id: CHANNEL,
          message: "",
          status: "published",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    postBodies: () => postBodies,
    directCount: () => directs,
    patchBodies: () => patchBodies,
  };
}

function sendMedia(extra: Partial<ChannelOutboundContext> = {}) {
  return outboundAdapter.sendMedia!({
    cfg: cfg(),
    to: CHANNEL,
    text: "here is your image",
    mediaUrl: MEDIA_URL,
    ...extra,
  } as ChannelOutboundContext);
}

describe("outboundAdapter.sendMedia", () => {
  beforeEach(() => {
    __resetOutboundDedupeForTest();
    __resetDraftRegistryForTest();
  });

  it("uploads the media and posts caption + file_ids in one post", async () => {
    const stub = installMediaFetchStub();
    try {
      const result = await sendMedia();
      assert.equal(stub.directCount(), 1);
      assert.equal(stub.postBodies().length, 1);
      const body = stub.postBodies()[0] as { message: string; file_ids: string[] };
      assert.equal(body.message, "here is your image");
      assert.deepEqual(body.file_ids, ["media-file-1"]);
      assert.equal(result.channelId, CHANNEL);
      assert.equal(typeof result.messageId, "string");
    } finally {
      stub.restore();
    }
  });

  it("cancels an open shimmer draft before minting the media post", async () => {
    const stub = installMediaFetchStub();
    const ref: OpenDraftRef = { id: 777 };
    registerOpenDraft("default", CHANNEL, ref);
    try {
      const result = await sendMedia();
      // The draft PATCH API can't carry file_ids, so the takeover is
      // cancel-then-mint: one cancel PATCH, then the real media post.
      assert.deepEqual(stub.patchBodies(), [{ cancel: true }]);
      assert.equal(stub.postBodies().length, 1);
      const body = stub.postBodies()[0] as { file_ids: string[] };
      assert.deepEqual(body.file_ids, ["media-file-1"]);
      // The shared ref was emptied synchronously, so the gateway's
      // turn-end cleanup won't double-cancel.
      assert.equal(ref.id, undefined);
      assert.equal(result.channelId, CHANNEL);
    } finally {
      stub.restore();
    }
  });

  it("still delivers the media post when the draft cancel fails", async () => {
    const stub = installMediaFetchStub();
    // Make only the PATCH fail: wrap the stubbed fetch after install.
    const stubbedFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "PATCH") {
        return new Response(JSON.stringify({ detail: "Post not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      return stubbedFetch(input as Parameters<typeof fetch>[0], init);
    }) as typeof fetch;
    const ref: OpenDraftRef = { id: 777 };
    registerOpenDraft("default", CHANNEL, ref);
    try {
      await sendMedia();
      assert.equal(stub.postBodies().length, 1, "media post must land despite cancel failure");
      assert.equal(ref.id, undefined);
    } finally {
      stub.restore();
    }
  });

  it("collapses an identical media re-send into one post", async () => {
    const stub = installMediaFetchStub();
    try {
      const first = await sendMedia();
      const second = await sendMedia();
      assert.equal(stub.postBodies().length, 1, "the retry must not mint a second post");
      assert.equal(second.messageId, first.messageId);
    } finally {
      stub.restore();
    }
  });

  it("does not collide with a text-only send of the same caption", async () => {
    const stub = installMediaFetchStub();
    try {
      await sendMedia();
      await outboundAdapter.sendText!({
        cfg: cfg(),
        to: CHANNEL,
        text: "here is your image",
      } as ChannelOutboundContext);
      assert.equal(stub.postBodies().length, 2, "media and text sends are distinct payloads");
    } finally {
      stub.restore();
    }
  });

  it("falls back to text + URL when the upload fails for an https media URL", async () => {
    const stub = installMediaFetchStub({ failUploads: true });
    try {
      const result = await sendMedia();
      const bodies = stub.postBodies() as Array<{ message: string; file_ids?: string[] }>;
      assert.equal(bodies.length, 1);
      assert.equal(bodies[0]!.message, `here is your image\n${MEDIA_URL}`);
      assert.equal(bodies[0]!.file_ids, undefined);
      assert.equal(result.channelId, CHANNEL);
    } finally {
      stub.restore();
    }
  });

  it("never leaks a local media path into chat when the upload fails", async () => {
    const stub = installMediaFetchStub({ failUploads: true });
    try {
      await assert.rejects(
        sendMedia({
          mediaUrl: "/home/user/.openclaw/media/gen.png",
          mediaReadFile: async () => Buffer.from(MEDIA_BYTES),
        } as Partial<ChannelOutboundContext>),
      );
      assert.equal(stub.postBodies().length, 0, "no post may carry the host path");
    } finally {
      stub.restore();
    }
  });
});
