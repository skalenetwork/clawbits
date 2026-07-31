import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DraftStore, type DraftInput } from "./messageDrafts";
import type { MmChannelPost } from "./api";

const USER = 7;
const OTHER_USER = 8;
const KEY = `fc_message_drafts_${String(USER)}`;

const input = (text: string, extra?: Partial<DraftInput>): DraftInput => ({
  text,
  reply: null,
  targetAgentId: null,
  ...extra,
});

const post = (overrides?: Partial<MmChannelPost>): MmChannelPost => ({
  post_id: 42,
  channel_id: "ch-1",
  agent_id: null,
  human_id: 3,
  poster_display_name: "Anna",
  message: "the post being replied to",
  created_at: "2026-06-12T10:00:00Z",
  status: "published",
  ...overrides,
});

beforeEach(() => {
  localStorage.clear();
  // Keep each store's 400 ms persist debounce from firing into a later
  // test — flushes in these tests are always explicit.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DraftStore", () => {
  it("returns the latest in-memory draft before any flush", () => {
    const store = new DraftStore();
    store.set(USER, "ch-1", input("hel"));
    store.set(USER, "ch-1", input("hello"));
    expect(store.get(USER, "ch-1")?.text).toBe("hello");
  });

  it("round-trips a draft through localStorage", () => {
    const store = new DraftStore();
    store.set(USER, "ch-1", input("unsent message", { targetAgentId: "clawd" }));
    store.flush();

    const fresh = new DraftStore(); // simulates an app restart
    const restored = fresh.get(USER, "ch-1");
    expect(restored?.text).toBe("unsent message");
    expect(restored?.targetAgentId).toBe("clawd");
  });

  it("preserves the reply snapshot, slimmed of bulky fields", () => {
    const store = new DraftStore();
    store.set(
      USER,
      "ch-1",
      input("replying…", {
        reply: post({
          reactions: [{ emoji: "x", count: 1, reacted: false }] as never,
          files: [{ file_id: "f" }] as never,
        }),
      }),
    );
    store.flush();

    const restored = new DraftStore().get(USER, "ch-1");
    expect(restored?.reply?.post_id).toBe(42);
    expect(restored?.reply?.message).toBe("the post being replied to");
    expect(restored?.reply?.reactions).toEqual([]);
    expect(restored?.reply?.files).toEqual([]);
  });

  it("keeps a reply-only draft (no text yet) but drops whitespace-only text", () => {
    const store = new DraftStore();
    store.set(USER, "ch-reply", input("", { reply: post() }));
    store.set(USER, "ch-blank", input("   \n "));
    store.flush();

    const fresh = new DraftStore();
    expect(fresh.get(USER, "ch-reply")?.reply?.post_id).toBe(42);
    expect(fresh.get(USER, "ch-blank")).toBeNull();
  });

  it("clearing the text deletes the stored entry (send = no draft)", () => {
    const store = new DraftStore();
    store.set(USER, "ch-1", input("about to send"));
    store.flush();
    store.set(USER, "ch-1", input(""));
    store.flush();

    expect(new DraftStore().get(USER, "ch-1")).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull(); // empty map removes the key
  });

  it("namespaces drafts per user", () => {
    const store = new DraftStore();
    store.set(USER, "ch-1", input("mine"));
    store.flush();

    const fresh = new DraftStore();
    expect(fresh.get(OTHER_USER, "ch-1")).toBeNull();
    expect(fresh.get(USER, "ch-1")?.text).toBe("mine");
  });

  it("prunes the oldest entries beyond the cap on flush", () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now++);
    const store = new DraftStore();
    for (let i = 0; i < 55; i++) {
      store.set(USER, `ch-${String(i)}`, input(`draft ${String(i)}`));
    }
    store.flush();

    const fresh = new DraftStore();
    expect(fresh.get(USER, "ch-0")).toBeNull(); // oldest pruned
    expect(fresh.get(USER, "ch-4")).toBeNull();
    expect(fresh.get(USER, "ch-5")?.text).toBe("draft 5");
    expect(fresh.get(USER, "ch-54")?.text).toBe("draft 54");
  });

  it("survives corrupted storage payloads", () => {
    localStorage.setItem(KEY, "{definitely not json");
    const store = new DraftStore();
    expect(store.get(USER, "ch-1")).toBeNull();
    store.set(USER, "ch-1", input("recovered"));
    store.flush();
    expect(new DraftStore().get(USER, "ch-1")?.text).toBe("recovered");
  });

  it("notifies subscribers on flush with a fresh snapshot identity", () => {
    const store = new DraftStore();
    const before = store.getSnapshot(USER);
    const listener = vi.fn();
    store.subscribe(listener);

    store.set(USER, "ch-1", input("typing"));
    expect(store.getSnapshot(USER)).toBe(before); // debounced — not yet

    store.flush();
    expect(listener).toHaveBeenCalled();
    const after = store.getSnapshot(USER);
    expect(after).not.toBe(before);
    expect(after.get("ch-1")?.text).toBe("typing");
  });

  it("merges cross-tab writes, keeping the newer side per channel", () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const store = new DraftStore();
    store.set(USER, "ch-local", input("local pending")); // dirty, unflushed

    now = 2_000;
    const incoming = {
      "ch-remote": { text: "from other tab", reply: null, targetAgentId: null, updatedAt: now },
    };
    window.dispatchEvent(
      new StorageEvent("storage", { key: KEY, newValue: JSON.stringify(incoming) }),
    );

    expect(store.get(USER, "ch-remote")?.text).toBe("from other tab");
    expect(store.get(USER, "ch-local")?.text).toBe("local pending");
  });
});
