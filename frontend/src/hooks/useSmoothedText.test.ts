import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useSmoothedText } from "./useSmoothedText";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSmoothedText", () => {
  it("shows the full target immediately when not streaming (finalize snap)", () => {
    const { result } = renderHook(() => useSmoothedText("hello world", false));
    expect(result.current).toBe("hello world");
  });

  it("shows the current text immediately on mount, metering only later growth", () => {
    // Init length = target length, so a virtualizer re-mount of an in-progress
    // reply shows what's there rather than replaying it.
    const { result } = renderHook(() => useSmoothedText("already here", true));
    expect(result.current).toBe("already here");
  });

  it("meters newly-appended characters across animation frames", () => {
    const cbs: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cbs.push(cb);
      return cbs.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const flushFrame = () => {
      const pending = cbs.splice(0);
      act(() => { pending.forEach((cb) => { cb(0); }); });
    };

    const { result, rerender } = renderHook(
      ({ t }) => useSmoothedText(t, true),
      { initialProps: { t: "" } },
    );
    expect(result.current).toBe("");

    // Append 10 chars at once (a coalesced burst). Metering reveals a prefix,
    // not the whole thing, on the first frame.
    rerender({ t: "abcdefghij" });
    flushFrame();
    expect(result.current.length).toBeGreaterThan(0);
    expect(result.current.length).toBeLessThan(10);

    // Subsequent frames drain the backlog to completion.
    for (let i = 0; i < 10 && result.current.length < 10; i++) flushFrame();
    expect(result.current).toBe("abcdefghij");
  });

  it("snaps to the full target under reduced motion (no metering)", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const { result, rerender } = renderHook(
      ({ t }) => useSmoothedText(t, true),
      { initialProps: { t: "" } },
    );
    rerender({ t: "full text at once" });
    expect(result.current).toBe("full text at once");
  });
});
