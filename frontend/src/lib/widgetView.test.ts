import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { setWidgetView, useWidgetView } from "@/lib/widgetView";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("widgetView", () => {
  it("reads the view this device kept for a game, and keeps a new one", () => {
    const storage = {
      getItem: vi.fn((key: string) => (key === "fc_widget_view_kept-1" ? "collapsed" : null)),
      setItem: vi.fn(),
    };
    vi.stubGlobal("localStorage", storage);
    const { result } = renderHook(() => useWidgetView("kept-1"));
    expect(result.current).toBe("collapsed");
    act(() => { setWidgetView("kept-1", "open"); });
    expect(result.current).toBe("open");
    expect(storage.setItem).toHaveBeenCalledWith("fc_widget_view_kept-1", "open");
  });

  it("keeps a choice for the session where storage throws", () => {
    const blocked = () => { throw new DOMException("blocked", "SecurityError"); };
    const storage = { getItem: vi.fn(blocked), setItem: vi.fn(blocked) };
    vi.stubGlobal("localStorage", storage);
    const { result } = renderHook(() => useWidgetView("blocked-1"));
    expect(result.current).toBeNull();
    act(() => { setWidgetView("blocked-1", "collapsed"); });
    expect(storage.setItem).toHaveBeenCalled();
    expect(result.current).toBe("collapsed");
  });
});
