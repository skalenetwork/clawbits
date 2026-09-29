import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";

import { useChannelEvents } from "./useChannelEvents";
import { toggleTrace, useTraceOpen } from "@/hooks/useTraceState";
import type { MmChannelPost } from "@/lib/api";
import { openSseStream } from "@/lib/sse";

vi.mock("@/lib/sse", () => ({ openSseStream: vi.fn(() => ({ close: vi.fn() })) }));

const draft: MmChannelPost = {
  post_id: 9,
  channel_id: "c",
  agent_id: "a",
  human_id: null,
  poster_display_name: "Agent",
  message: "",
  created_at: "2026-09-28T10:00:00Z",
  status: "streaming",
};

const published: MmChannelPost = { ...draft, status: "published", message: "Two bugs.", updated_at: "2026-09-28T10:00:20Z" };

const status = (activity: object) => ({
  type: "member.status",
  data: { member_kind: "agent", member_id: "a", status: "generating", activity },
});

function follow() {
  const client = new QueryClient();
  const hook = renderHook(() => useChannelEvents("c"), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  const handler = vi.mocked(openSseStream).mock.lastCall![1];
  return {
    hook,
    emit: (event: unknown) => {
      act(() => { handler(event); });
    },
  };
}

afterEach(() => {
  vi.mocked(openSseStream).mockClear();
});

describe("useChannelEvents", () => {
  it("keeps a watched turn's thinking with the reply it published, anchored to the steps that followed it", async () => {
    const { hook, emit } = follow();
    emit(status({ kind: "thinking", label: "The user wants the bugs." }));
    emit(status({ kind: "tool", id: "c1", tool: "exec", label: "gh issue list" }));
    emit(status({ kind: "thinking", label: "Two are bugs." }));
    emit({ type: "post.created", data: draft });
    emit({
      type: "post.updated",
      data: {
        ...published,
        steps: [{ kind: "tool", id: "c1", label: "gh issue list", tool: "exec", ok: true, duration_ms: 900 }],
      },
    });
    await waitFor(() => {
      expect(hook.result.current.finishedTurns[9]?.thoughts).toEqual([
        { before: "c1", text: "The user wants the bugs." },
        { before: undefined, text: "Two are bugs." },
      ]);
    });
    expect(hook.result.current.turns).toEqual({});
  });

  it("ends the turn at its reply when the agent's next status arrives right behind it", async () => {
    const { hook, emit } = follow();
    const open = renderHook(() => useTraceOpen("9"));
    emit(status({ kind: "thinking", label: "The user wants the bugs." }));
    emit({ type: "post.created", data: draft });
    await waitFor(() => {
      expect(hook.result.current.turns["agent:a"]).toBeDefined();
    });
    act(() => { toggleTrace("turn:c:agent:a"); });
    emit({ type: "post.updated", data: published });
    emit({ type: "member.status", data: { member_kind: "agent", member_id: "a", status: "online" } });
    await waitFor(() => {
      expect(hook.result.current.finishedTurns[9]?.thoughts).toEqual([
        { before: undefined, text: "The user wants the bugs." },
      ]);
    });
    expect(open.result.current).toBe(true);
  });
});
