import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ClawBitsClient } from "../src/client.js";
import { ClawBitsError } from "../src/errors.js";
import * as agents from "../src/tools/agents.js";
import * as auth from "../src/tools/auth.js";
import * as mattermost from "../src/tools/mattermost.js";
import type { ChallengeAnswer } from "../src/types.js";

const ANSWER: ChallengeAnswer = { sessionToken: "test-session", response: "test-resp" };

function okFetch(body: unknown = {}): typeof fetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
}

function errFetch(status: number, detail: unknown): typeof fetch {
  return async () =>
    new Response(JSON.stringify({ status_code: status, detail, path: "/test" }), { status });
}

function clientWith(fetchImpl: typeof fetch, apiKey = "test-key"): ClawBitsClient {
  return new ClawBitsClient({ endpoint: "http://h", apiKey, fetchImpl });
}

async function assertThrowsClawBitsError(fn: () => Promise<unknown>, expectedStatus: number): Promise<void> {
  try {
    await fn();
    assert.fail("should have thrown ClawBitsError");
  } catch (err) {
    assert.ok(err instanceof ClawBitsError, `expected ClawBitsError, got ${err}`);
    assert.equal(err.statusCode, expectedStatus);
  }
}

// ---- Agents ----
describe("agents.signup", () => {
  it("POSTs /api/agentic/agents/signup without Authorization", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    const fakeFetch: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ session_token: "s", challenge: "q" }), { status: 200 });
    };
    const c = clientWith(fakeFetch);
    await agents.signup(c, { owner_email: "x@y" });
    assert.ok(capturedUrl.endsWith("/api/agentic/agents/signup"));
    assert.equal(capturedHeaders["Authorization"], undefined);
  });

  it("propagates ClawBitsError on 422", async () => {
    const c = clientWith(errFetch(422, "invalid"));
    await assertThrowsClawBitsError(() => agents.signup(c), 422);
  });
});

describe("agents.commitSignup", () => {
  it("POSTs /api/agentic/signup-commit without Authorization", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    const fakeFetch: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ agent_id: "a1", api_key: "k1" }), { status: 200 });
    };
    const c = clientWith(fakeFetch);
    const result = await agents.commitSignup(c, ANSWER);
    assert.ok(capturedUrl.endsWith("/api/agentic/signup-commit"));
    assert.equal(capturedHeaders["Authorization"], undefined);
    assert.equal(result.agent_id, "a1");
  });

  it("propagates ClawBitsError on 401", async () => {
    const c = clientWith(errFetch(401, "unauthorized"));
    await assertThrowsClawBitsError(() => agents.commitSignup(c, ANSWER), 401);
  });
});

// ---- Auth ----
describe("auth.rotateKey", () => {
  it("POSTs /api/agentic/auth/rotate-key with challenge headers", async () => {
    let capturedHeaders: Record<string, string> = {};
    const fakeFetch: typeof fetch = async (_url, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ new_api_key: "nk" }), { status: 200 });
    };
    const c = clientWith(fakeFetch);
    await auth.rotateKey(c, ANSWER);
    assert.equal(capturedHeaders["session_token"], "test-session");
    assert.equal(capturedHeaders["challenge-RESPONSE"], "test-resp");
  });

  it("error path", async () => {
    const c = clientWith(errFetch(403, "forbidden"));
    await assertThrowsClawBitsError(() => auth.rotateKey(c, ANSWER), 403);
  });
});

describe("auth.commitRotateKey", () => {
  it("happy path", async () => {
    const c = clientWith(okFetch({ committed: true }));
    const result = await auth.commitRotateKey(c, ANSWER, { new_api_key: "nk" });
    assert.deepEqual(result, { committed: true });
  });

  it("error path", async () => {
    const c = clientWith(errFetch(409, "conflict"));
    await assertThrowsClawBitsError(
      () => auth.commitRotateKey(c, ANSWER, { new_api_key: "x" }),
      409
    );
  });
});

// ---- Mattermost (kept — backs the human-channel tools) ----
describe("mattermost.getDefaultChannel", () => {
  it("GETs /api/agentic/mm/teams/{agent}/default-channel", async () => {
    let capturedUrl = "";
    const fakeFetch: typeof fetch = async (url) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ channel_id: "ch1" }), { status: 200 });
    };
    const c = clientWith(fakeFetch);
    await mattermost.getDefaultChannel(c, "agent 1");
    assert.ok(capturedUrl.includes("/api/agentic/mm/teams/agent%201/default-channel"));
  });

  it("error path", async () => {
    const c = clientWith(errFetch(404, "not found"));
    await assertThrowsClawBitsError(() => mattermost.getDefaultChannel(c, "x"), 404);
  });
});

describe("mattermost.postToChannel", () => {
  it("POSTs to channel with challenge", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    const fakeFetch: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ post_id: 1 }), { status: 200 });
    };
    const c = clientWith(fakeFetch);
    await mattermost.postToChannel(c, "ch 1", { message: "hi" }, ANSWER);
    assert.ok(capturedUrl.includes("/api/agentic/mm/channels/ch%201/posts"));
    assert.equal(capturedHeaders["session_token"], "test-session");
  });

  it("error path", async () => {
    const c = clientWith(errFetch(403, "forbidden"));
    await assertThrowsClawBitsError(
      () => mattermost.postToChannel(c, "x", { message: "" }, ANSWER),
      403
    );
  });
});

describe("mattermost.getChannelPosts", () => {
  it("GETs /api/agentic/mm/channels/{id}/posts", async () => {
    let capturedUrl = "";
    const fakeFetch: typeof fetch = async (url) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ posts: [] }), { status: 200 });
    };
    const c = clientWith(fakeFetch);
    await mattermost.getChannelPosts(c, "ch-1");
    assert.ok(capturedUrl.endsWith("/api/agentic/mm/channels/ch-1/posts"));
  });

  it("error path", async () => {
    const c = clientWith(errFetch(404, "not found"));
    await assertThrowsClawBitsError(() => mattermost.getChannelPosts(c, "x"), 404);
  });
});

describe("mattermost.toggleReaction", () => {
  it("POSTs /api/agentic/mm/posts/{id}/reactions with emoji + challenge", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";
    const fakeFetch: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedMethod = init?.method ?? "";
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return new Response(
        JSON.stringify({
          post_id: 42,
          channel_id: "ch1",
          message: "hi",
          reactions: [
            { emoji: "🎉", count: 1, agent_ids: ["a1"], human_ids: [] },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const c = clientWith(fakeFetch);
    await mattermost.toggleReaction(c, 42, "🎉", ANSWER);
    assert.equal(capturedMethod, "POST");
    assert.ok(capturedUrl.endsWith("/api/agentic/mm/posts/42/reactions"));
    assert.equal(capturedHeaders["session_token"], "test-session");
    assert.equal(capturedHeaders["challenge-RESPONSE"], "test-resp");
    assert.deepEqual(JSON.parse(capturedBody), { emoji: "🎉" });
  });

  it("encodes string post ids", async () => {
    let capturedUrl = "";
    const fakeFetch: typeof fetch = async (url) => {
      capturedUrl = String(url);
      return new Response("{}", { status: 200 });
    };
    const c = clientWith(fakeFetch);
    await mattermost.toggleReaction(c, "post 7", "👍", ANSWER);
    assert.ok(capturedUrl.includes("/api/agentic/mm/posts/post%207/reactions"));
  });

  it("propagates ClawBitsError on 403 (non-member)", async () => {
    const c = clientWith(errFetch(403, "not a member"));
    await assertThrowsClawBitsError(
      () => mattermost.toggleReaction(c, 1, "🎉", ANSWER),
      403,
    );
  });

  it("propagates ClawBitsError on 404 (post not found)", async () => {
    const c = clientWith(errFetch(404, "post not found"));
    await assertThrowsClawBitsError(
      () => mattermost.toggleReaction(c, 999, "🎉", ANSWER),
      404,
    );
  });
});

describe("mattermost.createChannel", () => {
  it("happy path", async () => {
    const c = clientWith(okFetch({ channel_id: "new-ch" }));
    await mattermost.createChannel(
      c,
      { name: "ch", display_name: "Ch", channel_type: "public" },
      ANSWER
    );
  });

  it("error path", async () => {
    const c = clientWith(errFetch(422, "invalid"));
    await assertThrowsClawBitsError(
      () =>
        mattermost.createChannel(
          c,
          { name: "", display_name: "", channel_type: "" },
          ANSWER
        ),
      422
    );
  });
});

describe("mattermost.listChannels / listMembers / addMember / removeMember", () => {
  it("listChannels happy path", async () => {
    const c = clientWith(okFetch([]));
    await mattermost.listChannels(c);
  });

  it("listMembers happy path", async () => {
    const c = clientWith(okFetch([]));
    await mattermost.listMembers(c, "ch1");
  });

  it("addMember happy path", async () => {
    const c = clientWith(okFetch({}));
    await mattermost.addMember(c, "ch1", { agent_id: "a1" }, ANSWER);
  });

  it("removeMember encodes both path segments", async () => {
    let capturedUrl = "";
    const fakeFetch: typeof fetch = async (url) => {
      capturedUrl = String(url);
      return new Response("{}", { status: 200 });
    };
    const c = clientWith(fakeFetch);
    await mattermost.removeMember(c, "ch 1", "agent 2", ANSWER);
    assert.ok(capturedUrl.includes("ch%201"));
    assert.ok(capturedUrl.includes("agent%202"));
  });
});

// ---- Realtime (Phase 4/5 channel-status + draft streaming) ----
import * as realtime from "../src/tools/realtime.js";

describe("realtime.setAgentStatus", () => {
  it("POSTs /api/agentic/mm/channels/{id}/status with bearer and no challenge", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";
    const fakeFetch: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedMethod = init?.method ?? "";
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return new Response(null, { status: 204 });
    };
    const c = clientWith(fakeFetch);
    await realtime.setAgentStatus(c, "ch 1", "generating");
    assert.equal(capturedMethod, "POST");
    assert.ok(capturedUrl.endsWith("/api/agentic/mm/channels/ch%201/status"));
    assert.equal(capturedHeaders["Authorization"], "Bearer test-key");
    assert.equal(capturedHeaders["session_token"], undefined);
    assert.deepEqual(JSON.parse(capturedBody), { status: "generating" });
  });

  it("propagates ClawBitsError on 403", async () => {
    const c = clientWith(errFetch(403, "forbidden"));
    await assertThrowsClawBitsError(
      () => realtime.setAgentStatus(c, "ch", "online"),
      403,
    );
  });
});

describe("realtime.createDraftPost", () => {
  it("POSTs streaming body and returns post metadata", async () => {
    let capturedBody = "";
    const fakeFetch: typeof fetch = async (_url, init) => {
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return new Response(
        JSON.stringify({ post_id: 42, channel_id: "ch1", message: "", status: "streaming" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const c = clientWith(fakeFetch);
    const draft = await realtime.createDraftPost(c, "ch1");
    assert.deepEqual(JSON.parse(capturedBody), { message: "", status: "streaming" });
    assert.equal(draft.post_id, 42);
    assert.equal(draft.status, "streaming");
  });
});

describe("realtime.patchDraftPost", () => {
  it("PATCHes /posts/{id} with append", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody = "";
    const fakeFetch: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedMethod = init?.method ?? "";
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return new Response(
        JSON.stringify({ post_id: 42, channel_id: "ch1", message: "hi", status: "streaming" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const c = clientWith(fakeFetch);
    await realtime.patchDraftPost(c, "ch1", 42, { append: "hi" });
    assert.equal(capturedMethod, "PATCH");
    assert.ok(capturedUrl.endsWith("/api/agentic/mm/channels/ch1/posts/42"));
    assert.deepEqual(JSON.parse(capturedBody), { append: "hi" });
  });

  it("supports replace + done in one call", async () => {
    let capturedBody = "";
    const fakeFetch: typeof fetch = async (_url, init) => {
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return new Response(
        JSON.stringify({ post_id: 7, channel_id: "c", message: "final", status: "published" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const c = clientWith(fakeFetch);
    const res = await realtime.patchDraftPost(c, "c", 7, { replace: "final", done: true });
    assert.deepEqual(JSON.parse(capturedBody), { replace: "final", done: true });
    assert.equal(res.status, "published");
  });

  it("propagates ClawBitsError on 409 (post not a draft)", async () => {
    const c = clientWith(errFetch(409, "post is not a draft"));
    await assertThrowsClawBitsError(
      () => realtime.patchDraftPost(c, "c", 1, { done: true }),
      409,
    );
  });
});
