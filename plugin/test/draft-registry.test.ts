import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  __resetDraftRegistryForTest,
  claimDraft,
  claimOpenDraft,
  registerOpenDraft,
  unregisterOpenDraft,
  type OpenDraftRef,
} from "../src/draft-registry.js";
import { type PluginRuntime, setRuntime } from "../src/runtime.js";
import { memoryState } from "./runtime-state.js";

describe("draft-registry", () => {
  beforeEach(() => {
    __resetDraftRegistryForTest();
  });

  it("claim returns the registered draft id and empties the shared ref", () => {
    const ref: OpenDraftRef = { id: 101 };
    registerOpenDraft("default", "chan-1", ref);
    assert.equal(claimOpenDraft("default", "chan-1")?.id, 101);
    // The gateway's cleanup paths key off the ref, not the registry — the
    // claim must have emptied it so the turn-end cancel is skipped.
    assert.equal(ref.id, undefined);
    // A second claim (e.g. a second outbound send in the same turn) gets
    // nothing and falls back to minting a normal post.
    assert.equal(claimOpenDraft("default", "chan-1"), undefined);
  });

  it("misses on unknown (account, channel) pairs and on emptied refs", () => {
    const ref: OpenDraftRef = { id: 7 };
    registerOpenDraft("default", "chan-1", ref);
    assert.equal(claimOpenDraft("default", "other-chan"), undefined);
    assert.equal(claimOpenDraft("acct-2", "chan-1"), undefined);
    ref.id = undefined; // deliver() consumed the draft first
    assert.equal(claimOpenDraft("default", "chan-1"), undefined);
  });

  it("last registration wins when turns overlap in one channel", () => {
    const turn1: OpenDraftRef = { id: 1 };
    const turn2: OpenDraftRef = { id: 2 };
    registerOpenDraft("default", "chan-1", turn1);
    registerOpenDraft("default", "chan-1", turn2);
    assert.equal(claimOpenDraft("default", "chan-1")?.id, 2);
    // Turn 1's draft is untouched — its own finally-block still cancels it.
    assert.equal(turn1.id, 1);
  });

  it("unregister only evicts the caller's own ref", () => {
    const turn1: OpenDraftRef = { id: 1 };
    const turn2: OpenDraftRef = { id: 2 };
    registerOpenDraft("default", "chan-1", turn1);
    registerOpenDraft("default", "chan-1", turn2);
    // Turn 1 finishing late must not evict turn 2's live registration.
    unregisterOpenDraft("default", "chan-1", turn1);
    assert.equal(claimOpenDraft("default", "chan-1")?.id, 2);
    unregisterOpenDraft("default", "chan-1", turn2);
    assert.equal(claimOpenDraft("default", "chan-1"), undefined);
  });

  it("hands a draft left open by a crashed process to the next delivery, once", async () => {
    setRuntime({ state: memoryState() } as unknown as PluginRuntime);
    __resetDraftRegistryForTest();
    registerOpenDraft("default", "chan-1", { id: 712 });
    await Promise.resolve();
    __resetDraftRegistryForTest();
    assert.equal((await claimDraft("default", "chan-1"))?.id, "712");
    assert.equal(await claimDraft("default", "chan-1"), undefined);
  });

  it("forgets the persisted draft when its turn ends", async () => {
    setRuntime({ state: memoryState() } as unknown as PluginRuntime);
    __resetDraftRegistryForTest();
    const ref: OpenDraftRef = { id: 713 };
    registerOpenDraft("default", "chan-1", ref);
    unregisterOpenDraft("default", "chan-1", ref);
    await Promise.resolve();
    __resetDraftRegistryForTest();
    assert.equal(await claimDraft("default", "chan-1"), undefined);
  });

  it("drops the persisted copy when a live send takes the draft", async () => {
    setRuntime({ state: memoryState() } as unknown as PluginRuntime);
    __resetDraftRegistryForTest();
    registerOpenDraft("default", "chan-1", { id: 714 });
    await Promise.resolve();
    assert.equal((await claimDraft("default", "chan-1"))?.id, 714);
    assert.equal(await claimDraft("default", "chan-1"), undefined);
  });
});
