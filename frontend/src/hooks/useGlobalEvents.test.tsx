import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";

import { useGlobalEvents } from "./useGlobalEvents";
import type { MmChannel } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { openSseStream } from "@/lib/sse";

vi.mock("@/lib/sse", () => ({ openSseStream: vi.fn(() => ({ close: vi.fn() })) }));
vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: { id: 1 } }) }));

const chat: MmChannel = { channel_id: "c1", name: "dm", channel_type: "direct", created_at: "2026-10-12T10:00:00Z" };

describe("useGlobalEvents widget.turn", () => {
  it("drops a turn older than the one it applied for the chat's game, or an earlier game's, but takes a new game's and an older server's", () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.mm.channels("o1"), { channels: [chat], total: 1 });
    renderHook(() => { useGlobalEvents(); }, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <MemoryRouter>
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        </MemoryRouter>
      ),
    });
    const [, onEvent] = vi.mocked(openSseStream).mock.lastCall!;
    const turn = (data: Record<string, unknown>) => {
      act(() => { onEvent({ type: "widget.turn", channel_id: "c1", data }); });
      return client.getQueryData<{ channels: MmChannel[] }>(queryKeys.mm.channels("o1"))?.channels[0]?.widget_turn;
    };
    expect(turn({ my_turn: true, widget_id: "w1", rev: 5 })).toBe(true);
    // Rev 4 crossed rev 5 on the way: it says nothing new.
    expect(turn({ my_turn: false, widget_id: "w1", rev: 4 })).toBe(true);
    expect(turn({ my_turn: false, widget_id: "w1", rev: 6 })).toBe(false);
    // A new game counts its revs afresh.
    expect(turn({ my_turn: true, widget_id: "w2", rev: 1 })).toBe(true);
    // The old game's last word, arriving after the new game's first, says nothing now; the new game's revs still count.
    expect(turn({ my_turn: false, widget_id: "w1", rev: 7 })).toBe(true);
    expect(turn({ my_turn: false, widget_id: "w2", rev: 3 })).toBe(false);
    expect(turn({ my_turn: true, widget_id: "w2", rev: 2 })).toBe(false);
    // An older server sends neither id nor rev.
    expect(turn({ my_turn: true })).toBe(true);
  });
});
