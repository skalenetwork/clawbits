import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { startTransition, useCallback, useEffect, useRef, useState } from 'react';

import { channelMembersQueryKey } from '@/hooks/use-channel-members';
import { useSseConnection, type SseStreamCallbacks } from '@/hooks/use-sse-connection';
import {
  listMmChannelEvents,
  listMmPosts,
  type MmChannelEvent,
  type MmChannelEventListPayload,
  type MmChannelMember,
  type MmPost,
} from '@/lib/api';
import { preloadSvgs } from '@/lib/avatar-cache';
import {
  openChannelEvents,
  type MemberReadEvent,
  type MemberStatusEvent,
  type MmEvent,
} from '@/lib/sse';
import { useAuth } from '@/providers/auth-provider';

export const POSTS_PAGE_SIZE = 50;

interface PostsPage {
  posts: MmPost[];
  total: number;
}

export type PostsQueryData = InfiniteData<PostsPage, number | null>;

export function postsQueryKey(channelId: string) {
  return ['mm-posts', channelId] as const;
}

export function channelEventsQueryKey(channelId: string) {
  return ['mm-channel-events', channelId] as const;
}

/** Fetch the channel's inline timeline events (member.added /
 *  member.removed today) as a parallel stream to ``useChannelPosts``.
 *  ``buildChatRows`` interleaves the two by ``created_at`` at render
 *  time so the user sees one chronological list. */
export function useChannelEvents(channelId: string) {
  const { token } = useAuth();
  return useQuery({
    queryKey: channelEventsQueryKey(channelId),
    enabled: token != null,
    queryFn: () => listMmChannelEvents(token, channelId, 100),
    staleTime: 60_000,
  });
}

export function useChannelPosts(channelId: string) {
  const { token } = useAuth();
  return useInfiniteQuery({
    queryKey: postsQueryKey(channelId),
    enabled: token != null,
    initialPageParam: null as number | null,
    queryFn: async ({ pageParam }) => {
      const result = await listMmPosts(token, channelId, {
        limit: POSTS_PAGE_SIZE,
        beforePostId: pageParam ?? undefined,
      });
      // Warm the avatar disk cache for every post author on this page
      // before they hit the screen — by the time the user scrolls to
      // an older message its avatar is already on disk.
      void preloadSvgs(collectPostAvatarUrls(result.posts));
      return { posts: result.posts, total: result.total } satisfies PostsPage;
    },
    getNextPageParam: (lastPage) => {
      if (lastPage.posts.length < POSTS_PAGE_SIZE) return undefined;
      const oldest = lastPage.posts[lastPage.posts.length - 1];
      return oldest?.post_id ?? undefined;
    },
    staleTime: 60_000,
  });
}

export interface TypingMember {
  kind: 'human' | 'agent';
  id: string;
}

const TYPING_TTL_MS = 6000;

export function useChannelSse(channelId: string): { typing: TypingMember[] } {
  const { token, user } = useAuth();
  const queryClient = useQueryClient();
  const [typing, setTyping] = useState<TypingMember[]>([]);
  // Per-member typing auto-clear timers — the TTL covers the case where the
  // server's typing entry expires and no explicit "stop" event arrives.
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Pending ``post.updated`` patches, keyed by post_id. SSE delivers
  // token-by-token during agent replies (20-30 events/sec); writing each to
  // React Query immediately triggers a bubble re-render + markdown re-parse.
  // Coalescing into one setQueryData per animation frame caps the write rate
  // at ~60 Hz and collapses multiple patches for the same post. Refs (not
  // effect-closure locals) so the stable ``onEvent`` can reach them and they
  // survive reconnects within the same channel; reset on channel switch below.
  const pendingUpdatesRef = useRef<Map<number, MmPost>>(new Map());
  const flushRafRef = useRef<number | null>(null);

  const onEvent = useCallback(
    (event: MmEvent) => {
      const viewerHumanId = user?.id ?? null;
      const timers = timersRef.current;

      const scheduleFlush = () => {
        if (flushRafRef.current !== null) return;
        flushRafRef.current = requestAnimationFrame(() => {
          flushRafRef.current = null;
          const pending = pendingUpdatesRef.current;
          if (pending.size === 0) return;
          const patches = Array.from(pending.values());
          pending.clear();
          // Low-priority so a burst can't pre-empt composer typing.
          startTransition(() => {
            applyBufferedPostUpdates(queryClient, channelId, patches);
          });
        });
      };

      if (event.type === 'member.read') {
        const data = event.data as MemberReadEvent;
        startTransition(() => applyMemberReadToCache(queryClient, channelId, data));
        return;
      }
      if (event.type === 'member.status') {
        const data = event.data as MemberStatusEvent;
        // Suppress the viewer's own typing event so we don't see our own bubble.
        if (
          data.member_kind === 'human' &&
          viewerHumanId != null &&
          String(viewerHumanId) === String(data.member_id)
        ) {
          return;
        }
        const key = `${data.member_kind}:${data.member_id}`;
        const existing = timers.get(key);
        if (existing) clearTimeout(existing);
        if (data.status === 'typing') {
          setTyping((prev) =>
            prev.some((m) => m.kind === data.member_kind && m.id === data.member_id)
              ? prev
              : [...prev, { kind: data.member_kind, id: data.member_id }],
          );
          const timer = setTimeout(() => {
            timers.delete(key);
            setTyping((prev) =>
              prev.filter((m) => !(m.kind === data.member_kind && m.id === data.member_id)),
            );
          }, TYPING_TTL_MS);
          timers.set(key, timer);
        } else {
          timers.delete(key);
          setTyping((prev) =>
            prev.filter((m) => !(m.kind === data.member_kind && m.id === data.member_id)),
          );
        }
        return;
      }
      // Coalesce streaming-token patches. ``post.created`` / ``post.deleted``
      // stay on the eager path — they're rare and the optimistic-insert dedupe
      // depends on synchronous ordering relative to the local cache write.
      if (event.type === 'post.updated') {
        const post = event.data as MmPost;
        pendingUpdatesRef.current.set(post.post_id, post);
        scheduleFlush();
        return;
      }
      // Defer cache mutations so SSE bursts don't pre-empt composer typing.
      startTransition(() => applyEventToCache(queryClient, channelId, event));
    },
    [queryClient, channelId, user?.id],
  );

  const open = useCallback(
    (cb: SseStreamCallbacks) => {
      if (!token) return () => {};
      return openChannelEvents({ token, channelId, ...cb });
    },
    [token, channelId],
  );

  const onReconnect = useCallback(() => {
    // Revalidate the loaded window — catches posts/edits/deletes/inline events
    // that arrived while the per-channel stream was disconnected.
    void queryClient.invalidateQueries({ queryKey: postsQueryKey(channelId) });
    void queryClient.invalidateQueries({ queryKey: channelEventsQueryKey(channelId) });
    void queryClient.invalidateQueries({ queryKey: channelMembersQueryKey(channelId) });
  }, [queryClient, channelId]);

  // The per-channel stream now runs on the same resilient connection machine
  // as the global one — reconnect with backoff, background teardown, and a
  // fast reconnect (+ gap revalidation) on the network back-online edge. A
  // single blip no longer silently kills live messages in the open channel.
  useSseConnection({ enabled: token != null, open, onEvent, onReconnect });

  // Reset per-channel transient state on channel switch / unmount. The
  // connection itself is owned by ``useSseConnection``.
  useEffect(() => {
    // Capture the (stable, never-reassigned) refs so the cleanup uses locals
    // rather than reading ``ref.current`` at teardown time.
    const timers = timersRef.current;
    const pending = pendingUpdatesRef.current;
    const flushRaf = flushRafRef;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
      if (flushRaf.current !== null) {
        cancelAnimationFrame(flushRaf.current);
        flushRaf.current = null;
      }
      pending.clear();
      setTyping([]);
    };
  }, [channelId]);

  return { typing };
}

/** Insert a newly-created post into the channel's posts cache (front of
 *  page[0]), deduped by ``post_id`` (the server may re-fan the same post) and
 *  by ``client_msg_uuid`` (replaces this client's optimistic temp). Idempotent
 *  and side-effect-light, so it's safe to call from BOTH the per-channel SSE
 *  consumer and the global stream handler — whichever socket delivers the post
 *  first wins; the other call is a no-op. A no-op when the channel's posts
 *  cache isn't loaded (``prev`` undefined), so calling it for a non-open
 *  channel from the global stream costs nothing. */
export function insertCreatedPost(
  queryClient: QueryClient,
  channelId: string,
  post: MmPost,
): void {
  // Warm the avatar disk cache for the new post's author before the bubble
  // paints, so we never flash an initial-letter chip when a message arrives.
  const url = post.avatar?.url;
  if (url && url.toLowerCase().endsWith('.svg')) {
    void preloadSvgs([url]);
  }
  queryClient.setQueryData<PostsQueryData>(postsQueryKey(channelId), (prev) => {
    if (!prev) return prev;
    const firstPage = prev.pages[0];
    if (!firstPage) return prev;
    if (firstPage.posts.some((p) => p.post_id === post.post_id)) return prev;
    const filteredFirst = post.client_msg_uuid
      ? firstPage.posts.filter((p) => p.client_msg_uuid !== post.client_msg_uuid)
      : firstPage.posts;
    const updatedFirst = { ...firstPage, posts: [post, ...filteredFirst] };
    return { ...prev, pages: [updatedFirst, ...prev.pages.slice(1)] };
  });
}

function applyEventToCache(
  queryClient: ReturnType<typeof useQueryClient>,
  channelId: string,
  event: MmEvent,
) {
  const key = postsQueryKey(channelId);

  if (event.type === 'post.created') {
    insertCreatedPost(queryClient, channelId, event.data as MmPost);
    return;
  }

  if (event.type === 'post.updated') {
    // Single-event ``post.updated`` path. Kept for backward compatibility
    // with any caller that bypasses the rAF coalescing in
    // :func:`useChannelSse`. The streaming hot path uses
    // :func:`applyBufferedPostUpdates` below instead.
    const post = event.data as MmPost;
    queryClient.setQueryData<PostsQueryData>(key, (prev) => {
      if (!prev) return prev;
      const pages = prev.pages.map((page) => ({
        ...page,
        posts: page.posts.map((p) => (p.post_id === post.post_id ? post : p)),
      }));
      return { ...prev, pages };
    });
    return;
  }

  if (event.type === 'post.deleted') {
    const { post_id } = event.data as { post_id: number };
    queryClient.setQueryData<PostsQueryData>(key, (prev) => {
      if (!prev) return prev;
      const pages = prev.pages.map((page) => ({
        ...page,
        posts: page.posts.filter((p) => p.post_id !== post_id),
      }));
      return { ...prev, pages };
    });
    return;
  }

  if (event.type === 'channel.event') {
    // Inline channel timeline event (member.added / member.removed
    // today). Lives in a separate cache from posts; ``buildChatRows``
    // merges both streams at render time. Prepend newest-first;
    // dedupe on event_id in case SSE replays after a reconnect.
    const incoming = event.data as MmChannelEvent;
    queryClient.setQueryData<MmChannelEventListPayload>(
      channelEventsQueryKey(channelId),
      (prev) => {
        if (!prev) return { events: [incoming], total: 1 };
        if (prev.events.some((e) => e.event_id === incoming.event_id)) return prev;
        return {
          events: [incoming, ...prev.events],
          total: prev.total + 1,
        };
      },
    );
    // The channel-members roster moves on every event; invalidate so
    // the chat-info screen and avatar gutter re-fetch to reflect.
    void queryClient.invalidateQueries({
      queryKey: channelMembersQueryKey(channelId),
    });
  }
}

/** Apply a frame's worth of coalesced ``post.updated`` patches in one
 *  ``setQueryData`` pass. Each patch is the full post payload (server sends the
 *  canonical row, not a diff), so the merge is a positional swap by
 *  ``post_id``. A patch whose post isn't in the loaded cache is UPSERTED into
 *  page[0] rather than dropped: ``post.updated`` is rAF-buffered while
 *  ``post.created`` is eager, so a fast agent reply's first streaming token can
 *  flush before its create lands — dropping it (the old behavior) made the
 *  message start mid-stream. The later ``post.created`` dedups by ``post_id``. */
function applyBufferedPostUpdates(
  queryClient: ReturnType<typeof useQueryClient>,
  channelId: string,
  patches: MmPost[],
) {
  if (patches.length === 0) return;
  const key = postsQueryKey(channelId);
  queryClient.setQueryData<PostsQueryData>(key, (prev) => {
    if (!prev) return prev;
    let mutated = false;
    const applied = new Set<number>();
    const pages = prev.pages.map((page) => {
      let posts = page.posts;
      for (const patch of patches) {
        const idx = posts.findIndex((p) => p.post_id === patch.post_id);
        if (idx < 0) continue;
        if (posts === page.posts) posts = posts.slice();
        posts[idx] = patch;
        applied.add(patch.post_id);
        mutated = true;
      }
      return posts === page.posts ? page : { ...page, posts };
    });
    // Upsert any patch that raced ahead of its ``post.created`` — keep the
    // last patch per id and prepend newest-first to page[0].
    const missing = new Map<number, MmPost>();
    for (const patch of patches) {
      if (!applied.has(patch.post_id)) missing.set(patch.post_id, patch);
    }
    if (missing.size > 0 && pages[0]) {
      pages[0] = {
        ...pages[0],
        posts: [...missing.values(), ...pages[0].posts],
      };
      mutated = true;
    }
    return mutated ? { ...prev, pages } : prev;
  });
}

function collectPostAvatarUrls(posts: MmPost[]): string[] {
  const urls: string[] = [];
  for (const p of posts) {
    const url = p.avatar?.url;
    if (url && url.toLowerCase().endsWith('.svg')) urls.push(url);
  }
  return urls;
}

/** Bump the ``last_read_post_id`` for one member in the cached members
 *  list — monotonic, so an out-of-order event can't roll the pointer
 *  back. */
function applyMemberReadToCache(
  queryClient: ReturnType<typeof useQueryClient>,
  channelId: string,
  data: MemberReadEvent,
) {
  queryClient.setQueryData<MmChannelMember[]>(
    channelMembersQueryKey(channelId),
    (prev) => {
      if (!prev) return prev;
      let changed = false;
      const next = prev.map((m) => {
        if (m.human_id !== data.human_id) return m;
        const current = m.last_read_post_id ?? 0;
        if (data.last_read_post_id <= current) return m;
        changed = true;
        return { ...m, last_read_post_id: data.last_read_post_id };
      });
      return changed ? next : prev;
    },
  );
}
