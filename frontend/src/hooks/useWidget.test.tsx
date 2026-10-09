import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";

import { useWidgetLive } from "./useWidget";
import type { Widget } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { openSseStream } from "@/lib/sse";

vi.mock("@/lib/sse", () => ({ openSseStream: vi.fn(() => ({ close: vi.fn() })) }));

const widget = (rev: number): Widget => ({
  widget_id: "w1",
  channel_id: "c1",
  kind: "chess",
  status: "active",
  rev,
  turn: "white",
  seats: [],
  scene: { v: 1 },
  outcome: null,
  created_by_human_id: 1,
  created_at: "2026-10-08T10:00:00Z",
  updated_at: "2026-10-08T10:00:00Z",
});

describe("useWidgetLive", () => {
  it("follows the chat's stream for widget events, and refetches after a reconnect", () => {
    const client = new QueryClient();
    const refetch = vi.spyOn(client, "invalidateQueries");
    renderHook(() => { useWidgetLive("w1", "c1"); }, {
      wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });
    const [url, onEvent, options] = vi.mocked(openSseStream).mock.lastCall!;
    expect(url).toBe("/api/human/mm/channels/c1/events");
    act(() => { onEvent({ type: "widget.updated", data: widget(4) }); });
    expect(client.getQueryData<Widget>(queryKeys.mm.widget("w1"))?.rev).toBe(4);
    act(() => { onEvent({ type: "post.created", data: {} }); });
    options?.onOpen?.();
    expect(refetch).not.toHaveBeenCalled();
    options?.onOpen?.();
    expect(refetch).toHaveBeenCalledWith({ queryKey: queryKeys.mm.widget("w1") });
  });
});
