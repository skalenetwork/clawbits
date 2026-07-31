import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ClawBitsClient } from "../src/client.js";
import { ClawBitsError } from "../src/errors.js";
import { getChallenge, answerChallenge, withChallenge } from "../src/challenge.js";
import type { Challenge } from "../src/types.js";

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("getChallenge", () => {
  it("calls GET /api/agentic/auth/challenge with bearer", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return makeJsonResponse({ session_token: "sess1", challenge: "What is 2+2?" });
    };
    const c = new ClawBitsClient({ endpoint: "http://h", apiKey: "test-key", fetchImpl: fakeFetch });
    const ch = await getChallenge(c);
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.url.endsWith("/api/agentic/auth/challenge"));
    assert.equal(calls[0]!.headers["Authorization"], "Bearer test-key");
    assert.equal(ch.session_token, "sess1");
    assert.equal(ch.challenge, "What is 2+2?");
  });
});

describe("answerChallenge", () => {
  it("returns ChallengeAnswer when known answer matches", () => {
    const challenge: Challenge = { session_token: "sess1", challenge: "color?" };
    const answer = answerChallenge(challenge, { "color?": "blue" });
    assert.equal(answer.sessionToken, "sess1");
    assert.equal(answer.response, "blue");
  });

  it("throws ClawBitsError with status_code 0 for unknown challenge", () => {
    const challenge: Challenge = { session_token: "sess1", challenge: "unknown?" };
    try {
      answerChallenge(challenge, { "other?": "value" });
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof ClawBitsError);
      assert.equal(err.statusCode, 0);
      assert.equal(err.detail, "unknown challenge - ask the user");
      assert.equal(err.path, "/api/agentic/auth/challenge");
    }
  });
});

describe("withChallenge", () => {
  it("fetches challenge, answers it, and invokes fn", async () => {
    let fetchCount = 0;
    const fakeFetch = async (): Promise<Response> => {
      fetchCount++;
      return new Response(
        JSON.stringify({ session_token: `sess${fetchCount}`, challenge: "q?" }),
        { status: 200 }
      );
    };
    const c = new ClawBitsClient({ endpoint: "http://h", apiKey: "test-key", fetchImpl: fakeFetch });
    const results: string[] = [];
    await withChallenge(c, { "q?": "ans" }, async (answer) => {
      results.push(`${answer.sessionToken}:${answer.response}`);
    });
    assert.equal(results[0], "sess1:ans");
  });

  it("does not reuse cached answers between calls", async () => {
    let callNum = 0;
    const fakeFetch = async (): Promise<Response> => {
      callNum++;
      return new Response(
        JSON.stringify({ session_token: `sess${callNum}`, challenge: "q?" }),
        { status: 200 }
      );
    };
    const c = new ClawBitsClient({ endpoint: "http://h", apiKey: "test-key", fetchImpl: fakeFetch });
    const sessions: string[] = [];
    await withChallenge(c, { "q?": "ans" }, async (answer) => {
      sessions.push(answer.sessionToken);
    });
    await withChallenge(c, { "q?": "ans" }, async (answer) => {
      sessions.push(answer.sessionToken);
    });
    assert.equal(sessions[0], "sess1");
    assert.equal(sessions[1], "sess2");
    assert.notEqual(sessions[0], sessions[1]);
  });
});
