import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelWatermarkStore } from "../src/channel-watermarks.js";

async function withTempFile(fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "clawbits-wm-"));
  try {
    await fn(join(dir, "state.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("ChannelWatermarkStore", () => {
  it("advances monotonically and ignores stale/non-finite values", () => {
    const store = ChannelWatermarkStore.inMemory();
    assert.equal(store.get("acct", "chan"), undefined);
    store.set("acct", "chan", 100);
    assert.equal(store.get("acct", "chan"), 100);
    store.set("acct", "chan", 50); // older → ignored
    assert.equal(store.get("acct", "chan"), 100);
    store.set("acct", "chan", 200); // newer → wins
    assert.equal(store.get("acct", "chan"), 200);
    store.set("acct", "chan", Number.NaN); // junk → ignored
    assert.equal(store.get("acct", "chan"), 200);
  });

  it("keeps accounts and channels independent", () => {
    const store = ChannelWatermarkStore.inMemory();
    store.set("a1", "c1", 10);
    store.set("a1", "c2", 20);
    store.set("a2", "c1", 30);
    assert.equal(store.get("a1", "c1"), 10);
    assert.equal(store.get("a1", "c2"), 20);
    assert.equal(store.get("a2", "c1"), 30);
  });

  it("persists across instances via the backing file", async () => {
    await withTempFile(async (path) => {
      const a = new ChannelWatermarkStore(path);
      await a.load();
      a.set("acct", "team-room", 1700000000000);
      a.set("acct", "dm-9", 1700000005000);
      await a.flush();

      // Fresh instance pointed at the same file recovers the watermarks.
      const b = new ChannelWatermarkStore(path);
      await b.load();
      assert.equal(b.get("acct", "team-room"), 1700000000000);
      assert.equal(b.get("acct", "dm-9"), 1700000005000);

      // The on-disk shape is the documented nested object.
      const onDisk = JSON.parse(await readFile(path, "utf8"));
      assert.equal(onDisk["acct"]["team-room"], 1700000000000);
    });
  });

  it("starts empty when the file is missing or corrupt", async () => {
    await withTempFile(async (path) => {
      const missing = new ChannelWatermarkStore(path);
      await missing.load(); // file doesn't exist yet
      assert.equal(missing.get("acct", "chan"), undefined);

      await missing.flush(); // nothing dirty → no write
      // Write garbage, then a new instance should tolerate it.
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path, "{not json", "utf8");
      const corrupt = new ChannelWatermarkStore(path);
      await corrupt.load();
      assert.equal(corrupt.get("acct", "chan"), undefined);
    });
  });

  it("load is idempotent (only the first call reads)", async () => {
    await withTempFile(async (path) => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path, JSON.stringify({ acct: { chan: 42 } }), "utf8");
      const store = new ChannelWatermarkStore(path);
      await store.load();
      assert.equal(store.get("acct", "chan"), 42);
      // Mutate the file, load again — guard means we keep the first snapshot.
      await writeFile(path, JSON.stringify({ acct: { chan: 999 } }), "utf8");
      await store.load();
      assert.equal(store.get("acct", "chan"), 42);
    });
  });
});
