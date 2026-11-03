import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { widgetDismissedKey, widgetOpenKey } from "@/lib/widgets";

// The phone's storage, whose reads wait until a test lets them through.
const disk = new Map<string, string>();
const reads: (() => void)[] = [];
mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    multiGet: (keys: string[]) =>
      new Promise((resolve) => reads.push(() => resolve(keys.map((key) => [key, disk.get(key) ?? null])))),
    setItem: async (key: string, value: string) => {
      disk.set(key, value);
    },
    removeItem: async (key: string) => {
      disk.delete(key);
    },
  },
}));
const bar = await import("./game-bar-state");

async function finishReads() {
  for (const read of reads.splice(0)) read();
  await new Promise<void>((resolve) => setImmediate(() => resolve()));
}

describe("game bar state", () => {
  test("is empty while it loads, then as this phone left it", async () => {
    disk.set(widgetDismissedKey("w-load"), "1");
    bar.loadGameBar("w-load");
    expect(bar.gameBarState("w-load")).toBeNull();
    await finishReads();
    expect(bar.gameBarState("w-load")).toEqual({ open: false, dismissed: true });
  });

  test("a tap while it loads wins over what was kept", async () => {
    disk.set(widgetOpenKey("w-race"), "1");
    bar.loadGameBar("w-race");
    bar.setGameOpen("w-race", false);
    await finishReads();
    expect(bar.gameBarState("w-race")).toEqual({ open: false, dismissed: false });
    expect(disk.has(widgetOpenKey("w-race"))).toBe(false);
  });

  test("a change merges into what was kept", async () => {
    disk.set(widgetOpenKey("w-merge"), "1");
    bar.loadGameBar("w-merge");
    await finishReads();
    bar.dismissGame("w-merge");
    expect(bar.gameBarState("w-merge")).toEqual({ open: true, dismissed: true });
    expect([disk.get(widgetOpenKey("w-merge")), disk.get(widgetDismissedKey("w-merge"))]).toEqual(["1", "1"]);
  });

  test("a tapped message shows its game in its chat's bar, open, its result back", () => {
    bar.dismissGame("w-show");
    bar.showGame("c-show", "w-show");
    expect(bar.shownGame("c-show")).toBe("w-show");
    expect(bar.gameBarState("w-show")).toEqual({ open: true, dismissed: false });
    expect(disk.has(widgetDismissedKey("w-show"))).toBe(false);
  });

  test("the bar goes back to its own game unless the tapped one is kept", () => {
    bar.showGame("c-unshow", "w-a");
    bar.unshowGame("c-unshow", "w-a");
    expect(bar.shownGame("c-unshow")).toBe("w-a");
    bar.unshowGame("c-unshow", "w-b");
    expect(bar.shownGame("c-unshow")).toBeNull();
  });
});

describe("a game seen ending", () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = new Map<number, { ms: number; run: () => void }>();
  let nextTimer = 0;
  const elapse = () => {
    for (const [id, timer] of [...timers]) {
      timers.delete(id);
      timer.run();
    }
  };
  beforeEach(() => {
    globalThis.setTimeout = ((run: () => void, ms: number) => {
      timers.set(++nextTimer, { ms, run });
      return nextTimer;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => {
      timers.delete(id);
    }) as unknown as typeof clearTimeout;
  });
  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    timers.clear();
  });

  test("keeps an open board's result up a moment, then folds it", () => {
    bar.setGameOpen("w-end", true);
    bar.seeGameStatus("w-end", "active");
    bar.seeGameStatus("w-end", "finished");
    expect([...timers.values()].map((timer) => timer.ms)).toEqual([bar.RESULT_HOLD_MS]);
    expect(bar.gameBarState("w-end")?.open).toBe(true);
    elapse();
    expect(bar.gameBarState("w-end")).toEqual({ open: false, dismissed: false });
    expect(disk.has(widgetOpenKey("w-end"))).toBe(false);
  });

  test("leaves it as a tap during the hold says", () => {
    bar.setGameOpen("w-tap", true);
    bar.seeGameStatus("w-tap", "active");
    bar.seeGameStatus("w-tap", "aborted");
    bar.setGameOpen("w-tap", true);
    expect(timers.size).toBe(0);
    elapse();
    expect(bar.gameBarState("w-tap")?.open).toBe(true);
  });

  test("leaves one first seen over, or folded, as it was", () => {
    bar.setGameOpen("w-over", true);
    bar.seeGameStatus("w-over", "finished");
    bar.setGameOpen("w-folded", false);
    bar.seeGameStatus("w-folded", "active");
    bar.seeGameStatus("w-folded", "finished");
    expect(timers.size).toBe(0);
    expect(bar.gameBarState("w-over")?.open).toBe(true);
  });
});
