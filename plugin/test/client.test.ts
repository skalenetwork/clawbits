import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ClawBitsClient } from "../src/client.js";
import { ClawBitsError } from "../src/errors.js";
import type { ChallengeAnswer } from "../src/types.js";
import {
  __setCaptureThrows,
  capturedHttpExchanges,
  resetCapturedHttpExchanges,
} from "openclaw/plugin-sdk/proxy-capture";

function makeResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ClawBitsClient constructor", () => {
  it("strips trailing slash from endpoint", () => {
    const calls: string[] = [];
    const fakeFetch = async (url: string | URL | Request): Promise<Response> => {
      calls.push(String(url));
      return makeResponse("{}");
    };
    const c = new ClawBitsClient({ endpoint: "http://localhost:8000/", fetchImpl: fakeFetch });
    return c.request("GET", "/api/status").then(() => {
      assert.equal(calls[0], "http://localhost:8000/api/status");
    });
  });
});

describe("ClawBitsClient.request Content-Type", () => {
  it("sets Content-Type application/json when json body provided", async () => {
    let capturedHeaders: HeadersInit | undefined;
    const fakeFetch = async (_url: unknown, init?: RequestInit): Promise<Response> => {
      capturedHeaders = init?.headers;
      return makeResponse("{}");
    };
    const c = new ClawBitsClient({ endpoint: "http://h", fetchImpl: fakeFetch });
    await c.request("POST", "/test", { json: { foo: 1 } });
    const h = capturedHeaders as Record<string, string>;
    assert.equal(h["Content-Type"], "application/json");
  });

  it("does not set Content-Type for binary body", async () => {
    let capturedHeaders: HeadersInit | undefined;
    const fakeFetch = async (_url: unknown, init?: RequestInit): Promise<Response> => {
      capturedHeaders = init?.headers;
      return makeResponse("{}");
    };
    const c = new ClawBitsClient({ endpoint: "http://h", fetchImpl: fakeFetch });
    await c.request("PUT", "/test", {
      body: new Uint8Array([1, 2, 3]),
      headers: { "Content-Type": "application/octet-stream" },
    });
    const h = capturedHeaders as Record<string, string>;
    assert.equal(h["Content-Type"], "application/octet-stream");
  });
});

describe("ClawBitsClient.request Authorization header", () => {
  it("adds Bearer token when apiKey is set and auth is not false", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fakeFetch = async (_url: unknown, init?: RequestInit): Promise<Response> => {
      capturedHeaders = init?.headers as Record<string, string>;
      return makeResponse("{}");
    };
    const c = new ClawBitsClient({ endpoint: "http://h", apiKey: "test-key", fetchImpl: fakeFetch });
    await c.request("GET", "/test");
    assert.equal(capturedHeaders?.["Authorization"], "Bearer test-key");
  });

  it("omits Authorization when auth: false", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fakeFetch = async (_url: unknown, init?: RequestInit): Promise<Response> => {
      capturedHeaders = init?.headers as Record<string, string>;
      return makeResponse("{}");
    };
    const c = new ClawBitsClient({ endpoint: "http://h", apiKey: "test-key", fetchImpl: fakeFetch });
    await c.request("POST", "/test", { auth: false });
    assert.equal(capturedHeaders?.["Authorization"], undefined);
  });

  it("omits Authorization when no apiKey set", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fakeFetch = async (_url: unknown, init?: RequestInit): Promise<Response> => {
      capturedHeaders = init?.headers as Record<string, string>;
      return makeResponse("{}");
    };
    const c = new ClawBitsClient({ endpoint: "http://h", fetchImpl: fakeFetch });
    await c.request("GET", "/test");
    assert.equal(capturedHeaders?.["Authorization"], undefined);
  });
});

describe("ClawBitsClient.request challenge headers", () => {
  it("attaches session_token and challenge-RESPONSE when challenge provided", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fakeFetch = async (_url: unknown, init?: RequestInit): Promise<Response> => {
      capturedHeaders = init?.headers as Record<string, string>;
      return makeResponse("{}");
    };
    const c = new ClawBitsClient({ endpoint: "http://h", fetchImpl: fakeFetch });
    const answer: ChallengeAnswer = { sessionToken: "test-session", response: "test-resp" };
    await c.request("POST", "/test", { challenge: answer });
    assert.equal(capturedHeaders?.["session_token"], "test-session");
    assert.equal(capturedHeaders?.["challenge-RESPONSE"], "test-resp");
  });
});

describe("ClawBitsClient.request error handling", () => {
  it("throws ClawBitsError with status, detail, path from JSON error body", async () => {
    const errorBody = JSON.stringify({ status_code: 403, detail: "Forbidden", path: "/test" });
    const fakeFetch = async (): Promise<Response> => makeResponse(errorBody, 403);
    const c = new ClawBitsClient({ endpoint: "http://h", fetchImpl: fakeFetch });
    try {
      await c.request("GET", "/test");
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof ClawBitsError);
      assert.equal(err.statusCode, 403);
      // client.ts stringifies structured error bodies via formatDetail().
      assert.equal(
        err.detail,
        JSON.stringify({ status_code: 403, detail: "Forbidden", path: "/test" }),
      );
      assert.equal(err.path, "/test");
    }
  });

  it("falls back to raw text when error body is not JSON", async () => {
    const fakeFetch = async (): Promise<Response> => new Response("Internal Server Error", { status: 500 });
    const c = new ClawBitsClient({ endpoint: "http://h", fetchImpl: fakeFetch });
    try {
      await c.request("GET", "/test");
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof ClawBitsError);
      assert.equal(err.statusCode, 500);
      assert.equal(err.detail, "Internal Server Error");
    }
  });

  it("wraps network errors into ClawBitsError with status_code 0", async () => {
    const fakeFetch = async (): Promise<Response> => { throw new Error("network failure"); };
    const c = new ClawBitsClient({ endpoint: "http://h", fetchImpl: fakeFetch });
    try {
      await c.request("GET", "/test");
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof ClawBitsError);
      assert.equal(err.statusCode, 0);
    }
  });
});

describe("ClawBitsClient.request binary upload", () => {
  it("forwards Uint8Array body and Content-Type without JSON-encoding", async () => {
    let capturedBody: BodyInit | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    const fakeFetch = async (_url: unknown, init?: RequestInit): Promise<Response> => {
      capturedBody = init?.body as BodyInit;
      capturedHeaders = init?.headers as Record<string, string>;
      return makeResponse("{}");
    };
    const c = new ClawBitsClient({ endpoint: "http://h", fetchImpl: fakeFetch });
    const bytes = new Uint8Array([10, 20, 30]);
    await c.request("PUT", "/api/agentic/shared_content/myfile.bin", {
      body: bytes,
      headers: { "Content-Type": "image/png" },
    });
    assert.ok(capturedBody instanceof Uint8Array);
    assert.deepEqual(capturedBody, bytes);
    assert.equal(capturedHeaders?.["Content-Type"], "image/png");
  });
});

describe("ClawBitsClient.encodePath", () => {
  it("URL-encodes segments with slashes, spaces, and unicode", () => {
    const c = new ClawBitsClient({ endpoint: "http://h" });
    const encoded = c.encodePath("dir/My File.txt");
    assert.equal(encoded, "dir%2FMy%20File.txt");
  });

  it("joins multiple segments with /", () => {
    const c = new ClawBitsClient({ endpoint: "http://h" });
    const encoded = c.encodePath("agent id", "my repo");
    assert.equal(encoded, "agent%20id/my%20repo");
  });
});

describe("ClawBitsClient.request unsubstituted placeholder guard", () => {
  it("throws ClawBitsError when path contains {}", async () => {
    const c = new ClawBitsClient({ endpoint: "http://h" });
    try {
      await c.request("GET", "/api/agents/{agent_id}");
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof ClawBitsError);
      assert.equal(err.statusCode, 0);
    }
  });
});

describe("ClawBitsClient debug proxy capture", () => {
  // The stub stores captures in a module-global array; reset between
  // tests so accumulation from earlier assertions doesn't leak into the
  // next test's count check.
  beforeEach(resetCapturedHttpExchanges);

  it("captures request and response metadata at the client fetch seam", async () => {
    const fakeFetch = async (): Promise<Response> => makeResponse(JSON.stringify({ ok: true }), 200);
    const c = new ClawBitsClient({ endpoint: "http://h", apiKey: "test-key", fetchImpl: fakeFetch });
    await c.request("POST", "/api/agentic/mm/channels/ch1/posts", {
      json: { message: "hello" },
    });
    assert.equal(capturedHttpExchanges.length, 1);
    const capture = capturedHttpExchanges[0]!;
    assert.equal(capture.url, "http://h/api/agentic/mm/channels/ch1/posts");
    assert.equal(capture.method, "POST");
    assert.equal(capture.transport, "http");
    assert.deepEqual(capture.meta, {
      subsystem: "clawbits-fetch",
      path: "/api/agentic/mm/channels/ch1/posts",
    });
    assert.equal((capture.requestHeaders as Record<string, string>)["Authorization"], "Bearer test-key");
    assert.equal(capture.requestBody, JSON.stringify({ message: "hello" }));
    assert.equal(capture.response.status, 200);
  });

  it("captures a synthetic 599 response when fetch throws", async () => {
    const fakeFetch = async (): Promise<Response> => {
      throw new Error("ECONNREFUSED 127.0.0.1:8000");
    };
    const c = new ClawBitsClient({ endpoint: "http://h", apiKey: "test-key", fetchImpl: fakeFetch });
    await assert.rejects(
      c.request("POST", "/api/agentic/mm/channels/ch1/posts", { json: { x: 1 } }),
      ClawBitsError,
    );
    assert.equal(capturedHttpExchanges.length, 1);
    const capture = capturedHttpExchanges[0]!;
    assert.equal(capture.response.status, 599);
    assert.equal(capture.response.statusText, "ECONNREFUSED 127.0.0.1:8000");
    assert.equal(capture.meta?.errorType, "fetch-failed");
    assert.equal(capture.meta?.error, "ECONNREFUSED 127.0.0.1:8000");
  });

  it("does NOT fail a successful request when debug capture throws", async () => {
    // Regression: a capture-store error (e.g. proxy DB contention) used to be
    // caught by the network-error handler and reported as statusCode 0, making
    // a POST the server had already accepted look failed — so the delivery
    // layer retried and duplicated the reply. Capture must stay best-effort.
    __setCaptureThrows(new Error("capture store is locked"));
    const fakeFetch = async (): Promise<Response> =>
      makeResponse(JSON.stringify({ id: "post-1" }), 200);
    const c = new ClawBitsClient({ endpoint: "http://h", apiKey: "test-key", fetchImpl: fakeFetch });
    const result = await c.request<{ id: string }>(
      "POST",
      "/api/agentic/mm/channels/ch1/posts",
      { json: { message: "hi" } },
    );
    // The request resolves with the server's body — not a thrown ClawBitsError.
    assert.deepEqual(result, { id: "post-1" });
  });

  it("does NOT mask a real network error when the failure-path capture throws", async () => {
    __setCaptureThrows(new Error("capture store is locked"));
    const fakeFetch = async (): Promise<Response> => {
      throw new Error("ECONNREFUSED 127.0.0.1:8000");
    };
    const c = new ClawBitsClient({ endpoint: "http://h", apiKey: "test-key", fetchImpl: fakeFetch });
    // Still surfaces the genuine network failure as a ClawBitsError, not the
    // capture error.
    await assert.rejects(
      c.request("POST", "/api/agentic/mm/channels/ch1/posts", { json: { x: 1 } }),
      (err: unknown) =>
        err instanceof ClawBitsError &&
        err.statusCode === 0 &&
        /ECONNREFUSED/.test(String(err.detail)),
    );
  });
});

describe("ClawBitsClient request metrics", () => {
  it("emits a success metric with method/path/status/duration", async () => {
    const metrics: Array<Record<string, unknown>> = [];
    const fakeFetch = async (): Promise<Response> => makeResponse("{}", 200);
    const c = new ClawBitsClient({
      endpoint: "http://h",
      fetchImpl: fakeFetch,
      onRequestMetric: (metric) => metrics.push(metric as unknown as Record<string, unknown>),
    });
    await c.request("GET", "/api/agentic/mm/channels/ch1/posts");
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0]?.method, "GET");
    assert.equal(metrics[0]?.path, "/api/agentic/mm/channels/ch1/posts");
    assert.equal(metrics[0]?.statusCode, 200);
    assert.equal(metrics[0]?.ok, true);
    assert.equal(typeof metrics[0]?.durationMs, "number");
  });

  it("emits a network-error metric when fetch throws", async () => {
    const metrics: Array<Record<string, unknown>> = [];
    const fakeFetch = async (): Promise<Response> => {
      throw new Error("boom");
    };
    const c = new ClawBitsClient({
      endpoint: "http://h",
      fetchImpl: fakeFetch,
      onRequestMetric: (metric) => metrics.push(metric as unknown as Record<string, unknown>),
    });
    await assert.rejects(() => c.request("GET", "/api/test"), ClawBitsError);
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0]?.statusCode, 0);
    assert.equal(metrics[0]?.ok, false);
    assert.equal(metrics[0]?.errorType, "network");
  });
});

describe("ClawBitsClient logger redaction", () => {
  it("never logs bearer token, session token, or challenge response", async () => {
    const logRecords: Array<{ msg: string; meta?: object }> = [];
    const spyLogger = {
      debug: (msg: string, meta?: object) => {
        logRecords.push({ msg, meta });
      },
    };
    const fakeFetch = async (): Promise<Response> => makeResponse("{}");
    const c = new ClawBitsClient({
      endpoint: "http://h",
      apiKey: "super-secret-key",
      fetchImpl: fakeFetch,
      logger: spyLogger,
    });
    const answer: ChallengeAnswer = { sessionToken: "secret-session", response: "secret-resp" };
    await c.request("POST", "/api/test", { json: { x: 1 }, challenge: answer });

    const allLogText = JSON.stringify(logRecords);
    assert.ok(!allLogText.includes("super-secret-key"), "apiKey must not appear in logs");
    assert.ok(!allLogText.includes("secret-session"), "sessionToken must not appear in logs");
    assert.ok(!allLogText.includes("secret-resp"), "challenge response must not appear in logs");
    assert.ok(!allLogText.includes("Bearer"), "Bearer prefix must not appear in logs");
  });
});

describe("ClawBitsError.message never contains detail", () => {
  it("message built from statusCode and path only", () => {
    const err = new ClawBitsError({
      statusCode: 422,
      detail: "sensitive validation data",
      path: "/api/test",
    });
    assert.ok(!err.message.includes("sensitive validation data"));
    assert.ok(err.message.includes("422"));
    assert.ok(err.message.includes("/api/test"));
  });
});
