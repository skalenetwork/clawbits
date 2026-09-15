import { useMemo, useRef, useState } from "react";

import { listMmChannelPosts, listMmPostsAround, type MmChannelPost } from "@/lib/api";
import { dedupePostsById, mergePosts } from "@/lib/channelTimeline";
import { toast } from "@/lib/toast";

const PAGE_SIZE = 50;
const AROUND_RADIUS = 25;

interface AnchoredWindow {
  posts: MmChannelPost[];
  hasOlder: boolean;
  hasNewer: boolean;
}

export function useChannelHistory({
  channelId,
  latestPosts,
  refetchPosts,
  scrollToBottom,
}: {
  channelId: string;
  latestPosts: MmChannelPost[];
  refetchPosts: () => void;
  scrollToBottom: () => void;
}) {
  const [olderPosts, setOlderPosts] = useState<MmChannelPost[]>([]);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [anchor, setAnchor] = useState<AnchoredWindow | null>(null);
  // One fetch per cursor: a page that adds no visible rows cannot wedge paging, and a stale closure cannot refetch it.
  const olderCursorRef = useRef<number | null>(null);
  const newerCursorRef = useRef<number | null>(null);

  const resetCursors = () => {
    olderCursorRef.current = null;
    newerCursorRef.current = null;
  };

  const loadMoreOlder = async () => {
    const oldestId = (anchor ? anchor.posts[0] : (olderPosts[0] ?? latestPosts.at(-1)))?.post_id;
    if (!(anchor ? anchor.hasOlder : hasMoreHistory) || oldestId == null || olderCursorRef.current === oldestId) return;
    olderCursorRef.current = oldestId;
    setIsLoadingMore(true);
    const { posts } = await listMmChannelPosts(channelId, PAGE_SIZE, 0, oldestId)
      .catch((err: unknown) => {
        olderCursorRef.current = null;
        throw err;
      })
      .finally(() => { setIsLoadingMore(false); });
    const chunk = posts.toReversed();
    const hasOlder = posts.length >= PAGE_SIZE;
    if (anchor) {
      setAnchor((prev) => prev && { ...prev, posts: dedupePostsById([...chunk, ...prev.posts]), hasOlder });
      return;
    }
    if (chunk.length > 0) setOlderPosts((prev) => [...chunk, ...prev]);
    if (!hasOlder) setHasMoreHistory(false);
  };

  const loadMoreNewer = async () => {
    const newestId = anchor?.posts.at(-1)?.post_id;
    if (!anchor?.hasNewer || newestId == null || newerCursorRef.current === newestId) return;
    newerCursorRef.current = newestId;
    const { posts } = await listMmChannelPosts(channelId, PAGE_SIZE, 0, undefined, newestId).catch((err: unknown) => {
      newerCursorRef.current = null;
      throw err;
    });
    setAnchor((prev) => prev && {
      ...prev,
      posts: dedupePostsById([...prev.posts, ...posts.toReversed()]),
      hasNewer: posts.length >= PAGE_SIZE,
    });
  };

  const anchorAround = async (postId: number) => {
    const posts = await listMmPostsAround(channelId, postId, AROUND_RADIUS).then(
      (resp) => resp.posts.toReversed(),
      () => null,
    );
    if (!posts) {
      toast.error("Couldn't load that message.");
      return;
    }
    if (!posts.some((p) => p.post_id === postId)) {
      toast.info("Couldn't find that message - it may have been deleted.");
      return;
    }
    resetCursors();
    setAnchor({
      posts,
      hasOlder: posts.filter((p) => p.post_id < postId).length >= AROUND_RADIUS,
      hasNewer: posts.filter((p) => p.post_id > postId).length >= AROUND_RADIUS,
    });
  };

  const returnToPresent = () => {
    if (!anchor) return;
    resetCursors();
    setAnchor(null);
    setOlderPosts([]);
    setHasMoreHistory(true);
    refetchPosts();
    requestAnimationFrame(scrollToBottom);
  };

  const posts = useMemo(
    () => mergePosts(anchor?.posts ?? null, olderPosts, latestPosts),
    [anchor, olderPosts, latestPosts],
  );

  return {
    posts,
    isAnchored: anchor != null,
    hasMoreOlder: anchor ? anchor.hasOlder : hasMoreHistory,
    hasMoreNewer: anchor?.hasNewer ?? false,
    isLoadingMore,
    loadMoreOlder,
    loadMoreNewer,
    anchorAround,
    returnToPresent,
  };
}
