import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractFeatures, murmurhash3_x86_32 } from "../src/index.js";
import type { ChatContext } from "../src/index.js";

const FEATURE_DIM = 64;

describe("extractFeatures: shape & basics", () => {
  it("returns Float32Array of length 64", () => {
    const v = extractFeatures("hello");
    assert.ok(v instanceof Float32Array);
    assert.equal(v.length, FEATURE_DIM);
  });

  it("throws on null/undefined message", () => {
    // @ts-expect-error testing runtime guard
    assert.throws(() => extractFeatures(null), TypeError);
    // @ts-expect-error testing runtime guard
    assert.throws(() => extractFeatures(undefined), TypeError);
  });

  it("padding region X[51..63] is zero", () => {
    const v = extractFeatures("hi", { sender: "a", activeUsers: ["a"] });
    for (let i = 51; i < 64; i++) assert.equal(v[i], 0, `X[${i}] expected 0`);
  });
});

describe("extractFeatures: sender one-hot X[0..7]", () => {
  it("maps no-context sender to 'other' index 7", () => {
    const v = extractFeatures("hi");
    assert.equal(v[7], 1.0);
    for (let i = 0; i < 7; i++) assert.equal(v[i], 0);
  });

  it("maps active-user sender to its index 0..6", () => {
    const ctx: ChatContext = { sender: "bob", activeUsers: ["alice", "bob", "carol"] };
    const v = extractFeatures("hi", ctx);
    assert.equal(v[1], 1.0);
    for (let i = 0; i < 8; i++) if (i !== 1) assert.equal(v[i], 0);
  });

  it("maps overflow sender (index >= 7) to 'other' bucket 7", () => {
    const active = ["u0", "u1", "u2", "u3", "u4", "u5", "u6", "u7"];
    const v = extractFeatures("hi", { sender: "u7", activeUsers: active });
    assert.equal(v[7], 1.0);
  });
});

describe("extractFeatures: previous sender one-hot X[8..15]", () => {
  it("is all zero when no previousSender provided", () => {
    const v = extractFeatures("hi", { sender: "a", activeUsers: ["a"] });
    for (let i = 8; i < 16; i++) assert.equal(v[i], 0);
  });

  it("maps previous sender index correctly", () => {
    const v = extractFeatures("hi", {
      sender: "alice",
      previousSender: "carol",
      activeUsers: ["alice", "bob", "carol"],
    });
    assert.equal(v[8 + 2], 1.0);
  });
});

describe("extractFeatures: time delta X[16]", () => {
  it("is 1.0 (saturated) for cold-start (no context)", () => {
    const v = extractFeatures("hi");
    assert.equal(v[16], 1.0);
  });

  it("is ~0 for very recent timestamp", () => {
    const v = extractFeatures("hi", { lastMessageTimestamp: Date.now() });
    assert.ok(v[16] < 0.05, `expected near-zero, got ${v[16]}`);
  });

  it("saturates at 1.0 for timestamps older than 1 hour", () => {
    const v = extractFeatures("hi", { lastMessageTimestamp: Date.now() - 2 * 3600 * 1000 });
    assert.equal(v[16], 1.0);
  });

  it("is monotonic non-decreasing in age", () => {
    const now = Date.now();
    const a = extractFeatures("hi", { lastMessageTimestamp: now - 1_000 })[16];
    const b = extractFeatures("hi", { lastMessageTimestamp: now - 60_000 })[16];
    const c = extractFeatures("hi", { lastMessageTimestamp: now - 600_000 })[16];
    assert.ok(a <= b && b <= c, `not monotonic: ${a}, ${b}, ${c}`);
  });
});

describe("extractFeatures: message length X[17]", () => {
  it("normalizes by 256", () => {
    const v = extractFeatures("a".repeat(64));
    assert.ok(Math.abs(v[17] - 64 / 256) < 1e-6);
  });

  it("saturates at 1.0 for >=256 chars", () => {
    const v = extractFeatures("a".repeat(1024));
    assert.equal(v[17], 1.0);
  });
});

describe("extractFeatures: keyword hashing X[18..49]", () => {
  it("activates exactly the buckets matching token hashes", () => {
    const tokens = ["help", "please"];
    const expected = new Set(tokens.map((t) => murmurhash3_x86_32(t, 0) % 32));
    const v = extractFeatures("Help, please!");
    for (let b = 0; b < 32; b++) {
      const idx = 18 + b;
      if (expected.has(b)) assert.equal(v[idx], 1.0, `bucket ${b} should be 1`);
      else assert.equal(v[idx], 0, `bucket ${b} should be 0`);
    }
  });

  it("is case-insensitive and strips punctuation", () => {
    const a = extractFeatures("Hello, World!");
    const b = extractFeatures("hello world");
    assert.deepEqual(Array.from(a.slice(18, 50)), Array.from(b.slice(18, 50)));
  });
});

describe("extractFeatures: mention flag X[50]", () => {
  it("is 0 when no mention", () => {
    const v = extractFeatures("hi there", { activeUsers: ["alice"] });
    assert.equal(v[50], 0);
  });

  it("is 1 when message mentions an active user", () => {
    const v = extractFeatures("hi @Alice", { activeUsers: ["alice"] });
    assert.equal(v[50], 1.0);
  });

  it("is 0 when mention is not an active user", () => {
    const v = extractFeatures("hi @stranger", { activeUsers: ["alice"] });
    assert.equal(v[50], 0);
  });

  it("requires activeUsers to be non-empty", () => {
    const v = extractFeatures("hi @alice");
    assert.equal(v[50], 0);
  });
});

