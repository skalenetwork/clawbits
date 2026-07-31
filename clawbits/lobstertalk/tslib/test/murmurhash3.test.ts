import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { murmurhash3_x86_32 } from "../src/index.js";

describe("murmurhash3_x86_32", () => {
  it("hashes empty string with seed 0 to 0", () => {
    assert.equal(murmurhash3_x86_32("", 0), 0);
  });

  it("matches known vector for 'hello' with seed 0", () => {
    // Reference: SMHasher MurmurHash3_x86_32("hello", 0) = 0x248bfa47
    assert.equal(murmurhash3_x86_32("hello", 0), 0x248bfa47);
  });

  it("matches known vector for 'aaaa' with seed 0x9747b28c", () => {
    // Reference: SMHasher MurmurHash3_x86_32("aaaa", 0x9747b28c) = 0x5a97808a
    assert.equal(murmurhash3_x86_32("aaaa", 0x9747b28c), 0x5a97808a);
  });

  it("is deterministic", () => {
    const a = murmurhash3_x86_32("the quick brown fox", 0);
    const b = murmurhash3_x86_32("the quick brown fox", 0);
    assert.equal(a, b);
  });

  it("changes with seed", () => {
    const a = murmurhash3_x86_32("hello", 0);
    const b = murmurhash3_x86_32("hello", 1);
    assert.notEqual(a, b);
  });

  it("returns unsigned 32-bit integer", () => {
    const h = murmurhash3_x86_32("anything", 0);
    assert.ok(Number.isInteger(h));
    assert.ok(h >= 0 && h <= 0xffffffff);
  });

  it("handles tail-length variants (lengths 1..7)", () => {
    for (const s of ["a", "ab", "abc", "abcd", "abcde", "abcdef", "abcdefg"]) {
      const h = murmurhash3_x86_32(s, 0);
      assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff, `bad hash for "${s}"`);
    }
  });
});

