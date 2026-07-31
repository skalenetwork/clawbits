import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ClawBitsClient } from "../src/client.js";
import {
  deriveFilename,
  uploadOutboundMedia,
  OUTBOUND_MEDIA_MAX_BYTES,
} from "../src/outbound-media.js";

const CHANNEL = "chan-42";
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const R2_URL = "https://r2.example.invalid/mm/files/2026/07/abc/original/gen.png?sig=1";

function client(): ClawBitsClient {
  return new ClawBitsClient({ endpoint: "http://fc", apiKey: "k" });
}

/** Known answers so withChallenge resolves on the first challenge fetch. */
const ANSWERS = { "What is the capital of France?": "Paris" };

interface StubOptions {
  directStatus?: number; // default 200
  mediaStatus?: number; // default 200 for the https media fetch
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

function installFetchStub(opts: StubOptions = {}): {
  restore: () => void;
  requests: RecordedRequest[];
  byPath: (fragment: string) => RecordedRequest[];
} {
  const original = globalThis.fetch;
  const requests: RecordedRequest[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k] = v;
    }
    let body: Uint8Array | undefined;
    const raw = init?.body;
    if (raw instanceof Uint8Array) body = raw;
    else if (typeof raw === "string") body = new TextEncoder().encode(raw);
    requests.push({ url, method, headers, ...(body ? { body } : {}) });

    if (url.includes("/api/agentic/auth/challenge")) {
      return new Response(
        JSON.stringify({ challenge: "What is the capital of France?", session_token: "tok" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/files/direct")) {
      const status = opts.directStatus ?? 200;
      if (status !== 200) {
        return new Response(JSON.stringify({ detail: "nope" }), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ file_id: "direct-file-1", status: "uploaded" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (method === "POST" && url.includes("/files") && !url.includes("/confirm")) {
      return new Response(
        JSON.stringify({
          file_id: "presigned-file-1",
          upload_url: R2_URL,
          upload_headers: { "Content-Type": "image/png" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.startsWith("https://r2.example.invalid/")) {
      return new Response(null, { status: 200 });
    }
    if (url.includes("/confirm")) {
      return new Response(
        JSON.stringify({ file_id: "presigned-file-1", status: "uploaded" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.startsWith("https://media.example.invalid/")) {
      const status = opts.mediaStatus ?? 200;
      return new Response(status === 200 ? PNG_BYTES : null, {
        status,
        headers: { "Content-Type": "image/png" },
      });
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    requests,
    byPath: (fragment: string) => requests.filter((r) => r.url.includes(fragment)),
  };
}

describe("deriveFilename", () => {
  it("prefers the loader-reported filename", () => {
    assert.equal(
      deriveFilename("https://x/y/z.bin", { fileName: "photo.png" }),
      "photo.png",
    );
  });

  it("falls back to the URL basename, stripping query strings", () => {
    assert.equal(
      deriveFilename("https://x/y/gen.png?sig=abc", {}),
      "gen.png",
    );
  });

  it("appends a content-type extension to extension-less basenames", () => {
    assert.equal(
      deriveFilename("/media/store/abc123", { contentType: "image/png" }),
      "abc123.png",
    );
  });
});

describe("uploadOutboundMedia — direct route", () => {
  it("POSTs raw bytes with Content-Type + filename query and returns file_id", async () => {
    const stub = installFetchStub();
    try {
      const fileId = await uploadOutboundMedia({
        client: client(),
        answers: ANSWERS,
        channelId: CHANNEL,
        ctx: { mediaUrl: "https://media.example.invalid/gen.png" },
      });
      assert.equal(fileId, "direct-file-1");
      const direct = stub.byPath("/files/direct");
      assert.equal(direct.length, 1);
      assert.match(direct[0]!.url, /filename=gen\.png/);
      assert.equal(direct[0]!.headers["Content-Type"], "image/png");
      assert.deepEqual([...direct[0]!.body!], [...PNG_BYTES]);
      // Challenge headers rode along (write auth).
      assert.equal(direct[0]!.headers["challenge-RESPONSE"], "Paris");
      // No presigned fallback traffic.
      assert.equal(stub.byPath("r2.example.invalid").length, 0);
    } finally {
      stub.restore();
    }
  });

  it("loads local media through the provided mediaReadFile", async () => {
    const stub = installFetchStub();
    try {
      const fileId = await uploadOutboundMedia({
        client: client(),
        answers: ANSWERS,
        channelId: CHANNEL,
        ctx: {
          mediaUrl: "/approved/media/pic.webp",
          mediaReadFile: async () => Buffer.from(PNG_BYTES),
        },
      });
      assert.equal(fileId, "direct-file-1");
      const direct = stub.byPath("/files/direct");
      assert.match(direct[0]!.url, /filename=pic\.webp/);
    } finally {
      stub.restore();
    }
  });
});

describe("uploadOutboundMedia — presigned fallback", () => {
  it("falls back on 404: reserve → verbatim-header PUT → confirm", async () => {
    const stub = installFetchStub({ directStatus: 404 });
    try {
      const fileId = await uploadOutboundMedia({
        client: client(),
        answers: ANSWERS,
        channelId: CHANNEL,
        ctx: { mediaUrl: "https://media.example.invalid/gen.png" },
      });
      assert.equal(fileId, "presigned-file-1");

      // The PUT went to the presigned R2 URL with the reserve response's
      // headers verbatim (Content-Type is signed) and the raw bytes.
      const puts = stub.requests.filter((r) => r.method === "PUT");
      assert.equal(puts.length, 1);
      assert.equal(puts[0]!.url, R2_URL);
      assert.deepEqual(puts[0]!.headers, { "Content-Type": "image/png" });
      assert.deepEqual([...puts[0]!.body!], [...PNG_BYTES]);
      // Presigned URLs are for the R2 host — no API auth header may leak.
      assert.equal(puts[0]!.headers["Authorization"], undefined);

      // Confirm ran, without dims (server-side probe backfills them).
      const confirms = stub.byPath("/confirm");
      assert.equal(confirms.length, 1);
      const confirmBody = JSON.parse(new TextDecoder().decode(confirms[0]!.body!));
      assert.equal(confirmBody.thumbnail_uploaded, false);
      assert.equal(confirmBody.width, undefined);
    } finally {
      stub.restore();
    }
  });

  it("does NOT fall back on non-404 errors (413 oversize surfaces)", async () => {
    const stub = installFetchStub({ directStatus: 413 });
    try {
      await assert.rejects(
        uploadOutboundMedia({
          client: client(),
          answers: ANSWERS,
          channelId: CHANNEL,
          ctx: { mediaUrl: "https://media.example.invalid/gen.png" },
        }),
        /413/,
      );
      // The presigned path would just 413 again — it must not have run.
      assert.equal(stub.requests.filter((r) => r.method === "PUT").length, 0);
    } finally {
      stub.restore();
    }
  });
});

describe("uploadOutboundMedia — size cap", () => {
  it("exports the server-aligned 15 MiB cap", () => {
    assert.equal(OUTBOUND_MEDIA_MAX_BYTES, 15 * 1024 * 1024);
  });
});
