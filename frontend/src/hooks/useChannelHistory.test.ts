import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MmChannelPost } from "@/lib/api";
import { useChannelHistory } from "./useChannelHistory";

const api = vi.hoisted(() => ({ listMmChannelPosts: vi.fn(), listMmPostsAround: vi.fn() }));
vi.mock("@/lib/api", () => api);
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn(), info: vi.fn() } }));

const post = (post_id: number) => ({ post_id }) as MmChannelPost;
const page = (newest: number, count: number) => ({
  posts: Array.from({ length: count }, (_, i) => post(newest - i)),
  total: 0,
  limit: 50,
  offset: 0,
});
const latestPosts = page(200, 50).posts;

const setup = () =>
  renderHook(() => useChannelHistory({ channelId: "c", latestPosts, refetchPosts: vi.fn(), scrollToBottom: vi.fn() })).result;

beforeEach(() => {
  vi.resetAllMocks();
});

describe("useChannelHistory", () => {
  it("never refetches a page from a stale closure, then advances the cursor", async () => {
    api.listMmChannelPosts.mockResolvedValueOnce(page(150, 50)).mockResolvedValueOnce(page(100, 50));
    const result = setup();
    const stale = result.current.loadMoreOlder;
    await act(() => stale());
    await act(() => stale());
    expect(api.listMmChannelPosts.mock.calls).toEqual([["c", 50, 0, 151]]);
    await act(() => result.current.loadMoreOlder());
    expect(api.listMmChannelPosts).toHaveBeenLastCalledWith("c", 50, 0, 101);
    expect(result.current.posts).toHaveLength(150);
  });

  it("retries the same cursor after a failed fetch", async () => {
    api.listMmChannelPosts.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(page(150, 50));
    const result = setup();
    await act(() => expect(result.current.loadMoreOlder()).rejects.toThrow("offline"));
    await act(() => result.current.loadMoreOlder());
    expect(api.listMmChannelPosts.mock.calls).toEqual([["c", 50, 0, 151], ["c", 50, 0, 151]]);
  });

  it("reopens the first older page after returning from an anchored jump", async () => {
    api.listMmChannelPosts.mockResolvedValue(page(150, 50));
    api.listMmPostsAround.mockResolvedValue(page(90, 51));
    const result = setup();
    await act(() => result.current.loadMoreOlder());
    await act(() => result.current.anchorAround(65));
    act(() => { result.current.returnToPresent(); });
    await act(() => result.current.loadMoreOlder());
    expect(api.listMmChannelPosts.mock.calls).toEqual([["c", 50, 0, 151], ["c", 50, 0, 151]]);
  });
});
