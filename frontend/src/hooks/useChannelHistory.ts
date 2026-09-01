/**
 * Which slice of a channel's history is on screen, and how it grows.
 *
 * Two modes, one state machine:
 *
 *  - **Live tail** (default): the query owns the newest page; scrolling up
 *    stacks older pages into ``olderPosts``.
 *  - **Anchored window**: the viewer jumped to a message outside the tail (a
 *    pinned post, a search hit, a reply quote), so a self-managed contiguous
 *    segment — seeded by ``/posts/around``, extended both ways by the
 *    directional loaders — replaces it. Live polling and stick-to-bottom stay
 *    suspended until {@link ChannelHistory.returnToPresent}.
 *
 * Everything resets when ``channelId`` changes, so a window left open in one
 * channel can never leak into the next.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import { listMmChannelPosts, listMmPostsAround, type MmChannelPost } from "@/lib/api";
import { dedupePostsById, mergePosts } from "@/lib/channelTimeline";
import { toast } from "@/lib/toast";

const PAGE_SIZE = 50;
/** Half-width of the window fetched when jumping to an off-screen message. */
const AROUND_RADIUS = 25;

interface AnchoredWindow {
  posts: MmChannelPost[];
  hasOlder: boolean;
  hasNewer: boolean;
}

export interface ChannelHistoryOptions {
  channelId: string;
  /** The live newest-first page, straight off the posts query. */
  latestPosts: MmChannelPost[];
  refetchPosts: () => void;
  /** Snap the list to the newest message — used when leaving a window. */
  scrollToBottom: () => void;
}

export interface ChannelHistory {
  /** Everything the timeline should render, oldest-first and deduped. */
  posts: MmChannelPost[];
  /** Parked on a history window rather than the live tail. */
  isAnchored: boolean;
  hasMoreOlder: boolean;
  hasMoreNewer: boolean;
  isLoadingMore: boolean;
  /** True for exactly the render that commits a prepend, so the virtualizer
   *  can hold the visible top message in place. Read during render — a ref,
   *  not state, so the flag is set synchronously before the state update that
   *  produces that render (virtua's canonical chat pattern). */
  prependShift: RefObject<boolean>;
  loadMoreOlder: () => Promise<boolean>;
  loadMoreNewer: () => Promise<boolean>;
  /** Re-anchor the timeline on ``postId``'s neighbourhood. */
  anchorAround: (postId: number) => Promise<void>;
  returnToPresent: () => void;
}

export function useChannelHistory({
  channelId,
  latestPosts,
  refetchPosts,
  scrollToBottom,
}: ChannelHistoryOptions): ChannelHistory {
  const [olderPosts, setOlderPosts] = useState<MmChannelPost[]>([]);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [anchor, setAnchor] = useState<AnchoredWindow | null>(null);
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const prependShift = useRef(false);

  // The latch lives for exactly one render: set synchronously before the
  // state update that prepends, cleared after that render commits.
  useLayoutEffect(() => {
    prependShift.current = false;
  });

  useEffect(() => {
    setOlderPosts([]);
    setHasMoreHistory(true);
    setIsLoadingMore(false);
    setAnchor(null);
    loadingOlderRef.current = false;
    loadingNewerRef.current = false;
  }, [channelId]);

  const loadMoreOlder = useCallback(async (): Promise<boolean> => {
    if (loadingOlderRef.current) return false;
    if (anchor ? !anchor.hasOlder : !hasMoreHistory) return false;
    // Oldest post we hold: the window's first, else the top of the stacked
    // history, else the last row of the (newest-first) live page.
    const oldestId = anchor
      ? anchor.posts[0]?.post_id
      : (olderPosts[0] ?? latestPosts.at(-1))?.post_id;
    if (oldestId == null) return false;

    loadingOlderRef.current = true;
    setIsLoadingMore(true);
    try {
      const resp = await listMmChannelPosts(channelId, PAGE_SIZE, 0, oldestId);
      // Backend returns newest-first; history is stored oldest-first.
      const chunk = [...resp.posts].reverse();
      if (!anchor && chunk.length === 0) {
        setHasMoreHistory(false);
        return false;
      }
      // Flip the latch *before* the state update so the render it produces
      // reads ``prependShift === true``; otherwise the scroll position drifts
      // up by the height of the new chunk.
      prependShift.current = true;
      if (anchor) {
        setAnchor((prev) =>
          prev
            ? {
                ...prev,
                posts: dedupePostsById([...chunk, ...prev.posts]),
                hasOlder: resp.posts.length >= PAGE_SIZE,
              }
            : prev,
        );
      } else {
        setOlderPosts((prev) => [...chunk, ...prev]);
        if (resp.posts.length < PAGE_SIZE) setHasMoreHistory(false);
      }
      return resp.posts.length > 0;
    } finally {
      loadingOlderRef.current = false;
      setIsLoadingMore(false);
    }
  }, [anchor, channelId, hasMoreHistory, latestPosts, olderPosts]);

  // Only meaningful while anchored: appends the posts immediately newer than
  // the segment's newest. Appending below the viewport shifts no existing
  // rows, so there is no prepend latch; a short page means the live tail is
  // in reach.
  const loadMoreNewer = useCallback(async (): Promise<boolean> => {
    if (!anchor || loadingNewerRef.current || !anchor.hasNewer) return false;
    const newestId = anchor.posts.at(-1)?.post_id;
    if (newestId == null) return false;
    loadingNewerRef.current = true;
    try {
      const resp = await listMmChannelPosts(channelId, PAGE_SIZE, 0, undefined, newestId);
      const chunk = [...resp.posts].reverse();
      setAnchor((prev) =>
        prev
          ? {
              ...prev,
              posts: dedupePostsById([...prev.posts, ...chunk]),
              hasNewer: resp.posts.length >= PAGE_SIZE,
            }
          : prev,
      );
      return resp.posts.length > 0;
    } finally {
      loadingNewerRef.current = false;
    }
  }, [anchor, channelId]);

  // One bounded fetch regardless of how far back the message is, instead of
  // walking every page from the live tail (which couldn't reach old pins at
  // all).
  const anchorAround = useCallback(async (postId: number): Promise<void> => {
    let windowPosts: MmChannelPost[];
    try {
      const resp = await listMmPostsAround(channelId, postId, AROUND_RADIUS);
      windowPosts = [...resp.posts].reverse();
    } catch {
      toast.error("Couldn't load that message.");
      return;
    }
    if (!windowPosts.some((p) => p.post_id === postId)) {
      toast.info("Couldn't find that message - it may have been deleted.");
      return;
    }
    // The endpoint over-scans then trims to ``radius`` per side, so a full
    // radius on a side means "maybe more" (the directional loader confirms
    // with a short page) and fewer means "that's the end".
    prependShift.current = false; // full replace, not a prepend
    setAnchor({
      posts: windowPosts,
      hasOlder: windowPosts.filter((p) => p.post_id < postId).length >= AROUND_RADIUS,
      hasNewer: windowPosts.filter((p) => p.post_id > postId).length >= AROUND_RADIUS,
    });
  }, [channelId]);

  const returnToPresent = useCallback(() => {
    if (anchor == null) return;
    setAnchor(null);
    setOlderPosts([]);
    setHasMoreHistory(true);
    refetchPosts();
    requestAnimationFrame(scrollToBottom);
  }, [anchor, refetchPosts, scrollToBottom]);

  // Memoised: the merged array is the virtualizer's row identity, so a fresh
  // one every render would re-run every downstream derivation.
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
    prependShift,
    loadMoreOlder,
    loadMoreNewer,
    anchorAround,
    returnToPresent,
  };
}
