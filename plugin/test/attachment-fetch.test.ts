import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ClawBitsClient } from "../src/client.js";
import type { InboundFile } from "../src/inbound-poller.js";
import { __test } from "../src/plugin.js";

const { fetchAttachmentForFile } = __test;

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeFile(overrides: Partial<InboundFile> = {}): InboundFile {
  return {
    fileId: "file-1",
    filename: "screenshot.png",
    contentType: "image/png",
    sizeBytes: PNG_HEADER.byteLength,
    downloadUrl: "https://r2.example/inline-presigned",
    thumbnailUrl: null,
    width: 100,
    height: 100,
    durationMs: null,
    ...overrides,
  };
}

function pngResponse(): Response {
  return new Response(PNG_HEADER, {
    status: 200,
    headers: { "Content-Type": "image/png" },
  });
}

/**
 * Swap `globalThis.fetch` for the duration of `body` and restore it after.
 * `fetchAttachmentBytes` calls bare `fetch`, not the client's fetchImpl, so
 * tests have to control both surfaces. We point both at the same fake.
 */
async function withFetch<T>(fake: typeof fetch, body: (client: ClawBitsClient) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    const client = new ClawBitsClient({ endpoint: "http://h", apiKey: "k", fetchImpl: fake });
    return await body(client);
  } finally {
    globalThis.fetch = original;
  }
}

describe("fetchAttachmentForFile resilience", () => {
  it("uses inline file.downloadUrl first and skips /files/{id}/url when it succeeds", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith("/inline-presigned")) return pngResponse();
      return new Response("nope", { status: 500 });
    }) as typeof fetch;

    await withFetch(fakeFetch, async (client) => {
      const bytes = await fetchAttachmentForFile(makeFile(), client);
      assert.equal(bytes.byteLength, PNG_HEADER.byteLength);
      // Critical: the broken `/files/{id}/url` endpoint must not be consulted
      // when the inline presigned URL works.
      assert.equal(
        calls.some((u) => u.includes("/api/agentic/mm/files/")),
        false,
        `unexpected calls to URL endpoint: ${JSON.stringify(calls)}`,
      );
    });
  });

  it("falls back to /files/{id}/url when inline downloadUrl is missing", async () => {
    let urlEndpointHit = false;
    const fakeFetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/api/agentic/mm/files/") && u.endsWith("/url")) {
        urlEndpointHit = true;
        return new Response(JSON.stringify({ url: "https://r2.example/fresh" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.endsWith("/fresh")) return pngResponse();
      return new Response("nope", { status: 500 });
    }) as typeof fetch;

    await withFetch(fakeFetch, async (client) => {
      const bytes = await fetchAttachmentForFile(makeFile({ downloadUrl: null }), client);
      assert.equal(bytes.byteLength, PNG_HEADER.byteLength);
      assert.equal(urlEndpointHit, true);
    });
  });

  it("survives a 500 on /files/{id}/url as long as inline downloadUrl works (regression case)", async () => {
    // Reproduces the production failure: inline URL is fine but the URL
    // endpoint returns 500. Before this fix, the 500 propagated and the
    // attachment was dropped even though we had a working URL in hand.
    const fakeFetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/inline-presigned")) return pngResponse();
      if (u.includes("/api/agentic/mm/files/")) return new Response("boom", { status: 500 });
      return new Response("nope", { status: 500 });
    }) as typeof fetch;

    await withFetch(fakeFetch, async (client) => {
      const bytes = await fetchAttachmentForFile(makeFile(), client);
      assert.equal(bytes.byteLength, PNG_HEADER.byteLength);
    });
  });

  it("throws a helpful error when no URL works", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    await withFetch(fakeFetch, async (client) => {
      await assert.rejects(
        fetchAttachmentForFile(makeFile({ downloadUrl: null }), client),
        /no download URL available|HTTP 500|download failed/,
      );
    });
  });
});
