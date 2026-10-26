import { describe, expect, test } from "bun:test";
import { onlineManager, QueryClient } from "@tanstack/react-query";
import { askAfresh, pingedGameOf, pushTarget, tapKey } from "./push-target";

describe("a push's target", () => {
  const push = (data: Record<string, unknown> | null | undefined, payload?: Record<string, unknown>) => ({
    content: { data },
    trigger: payload ? { type: "push", payload } : { type: "push" },
  });

  test("is read from the push's body, which expo hands over as data", () => {
    expect(pushTarget(push({ channelId: "c1" }))).toEqual({ channelId: "c1" });
    expect(pushTarget(push({ channelId: "c1", widgetId: "w1" }))).toEqual({ channelId: "c1", widgetId: "w1" });
  });

  test("falls back to the top-level copies on the trigger's payload", () => {
    const top = { aps: { alert: { title: "Your move" } }, channelId: "c1", widgetId: "w1" };
    expect(pushTarget(push(undefined, top))).toEqual({ channelId: "c1", widgetId: "w1" });
    expect(pushTarget(push(null, top))).toEqual({ channelId: "c1", widgetId: "w1" });
    expect(pushTarget(push({}, { channelId: "c1" }))).toEqual({ channelId: "c1" });
  });

  test("takes both keys from the same place, data first", () => {
    expect(pushTarget(push({ channelId: "c1" }, { channelId: "c2", widgetId: "w2" }))).toEqual({ channelId: "c1" });
  });

  test("ignores keys that aren't names, and a push that names no chat", () => {
    expect(pushTarget(push({ channelId: "c1", widgetId: 7 }))).toEqual({ channelId: "c1" });
    expect(pushTarget(push({ channelId: "c1", widgetId: "" }))).toEqual({ channelId: "c1" });
    expect(pushTarget(push({ channelId: 7 }))).toBeNull();
    expect(pushTarget(push({ channelId: "" }))).toBeNull();
    expect(pushTarget(push(undefined))).toBeNull();
    expect(pushTarget({ content: {}, trigger: null })).toBeNull();
    expect(pushTarget({ content: {}, trigger: { type: "push", payload: "nope" } })).toBeNull();
  });
});

describe("the game a turn ping's tap opens", () => {
  test("is the chat's running game, even when the ping names one that has since ended", () => {
    expect(pingedGameOf("w-old", "w-new")).toBe("w-new");
    expect(pingedGameOf("w1", "w1")).toBe("w1");
  });

  test("is the pinged game while none runs, to show how it ended", () => {
    expect(pingedGameOf("w1", null)).toBe("w1");
  });
});

describe("what a tap asks afresh", () => {
  // The app's own query defaults (DataProvider): answers fresh for 30 s, one retry.
  const cache = () =>
    new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, gcTime: Infinity, retry: (count) => count < 1 } } });
  const key = ["widgets", "c1"];

  test("is asked even while the cache holds an answer that's still fresh", async () => {
    const client = cache();
    client.setQueryData(key, ["w-old"]);
    expect(await askAfresh(client, key, async () => ["w-new"])).toEqual(["w-new"]);
    expect(client.getQueryData(key)).toEqual(["w-new"]);
  });

  test("falls back to the cache at once when the ask fails, with no retry", async () => {
    const client = cache();
    client.setQueryData(key, ["w-old"], { updatedAt: Date.now() - 60_000 }); // stale: asked under any staleTime
    let asks = 0;
    const failing = async (): Promise<string[]> => {
      asks += 1;
      throw new Error("offline");
    };
    expect(await askAfresh(client, key, failing)).toEqual(["w-old"]);
    expect(asks).toBe(1);
  });

  test("is asked while the device thinks it's offline, instead of waiting to come back", async () => {
    onlineManager.setOnline(false);
    try {
      expect(await askAfresh(cache(), key, async () => ["w1"])).toEqual(["w1"]);
    } finally {
      onlineManager.setOnline(true);
    }
  });
});

describe("a tap's key", () => {
  const tap = (identifier: string, date: number) => ({ notification: { date, request: { identifier } } });

  test("tells apart two pushes iOS gave the same collapse id", () => {
    expect(tapKey(tap("turn:c1", 1_000))).not.toBe(tapKey(tap("turn:c1", 2_000)));
    expect(tapKey(tap("c1", 1_000))).not.toBe(tapKey(tap("c1", 2_000)));
  });

  test("is the same for one tap met at launch and by the listener", () => {
    expect(tapKey(tap("turn:c1", 1_000))).toBe(tapKey(tap("turn:c1", 1_000)));
  });
});
