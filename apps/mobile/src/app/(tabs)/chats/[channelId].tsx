import { useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useFocusEffect, useLocalSearchParams, useNavigation } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  type LayoutChangeEvent,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  KeyboardStickyView,
  useKeyboardState,
} from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  useKeyboardChatComposerInset,
  useKeyboardScrollToEnd,
} from '@legendapp/list/keyboard';
import type { LegendListRef } from '@legendapp/list/react-native';

import { ChatHeaderBack, ChatHeaderTitle } from '@/components/chat/chat-header';
import { ImageLightbox } from '@/components/chat/image-lightbox';
import { type BubbleAction } from '@/components/chat/message-bubble-menu';
import { MessageComposer } from '@/components/chat/message-composer';
import { MessageList } from '@/components/chat/message-list';
import { PendingAttachments } from '@/components/chat/pending-attachments';
import { MessageListSkeleton } from '@/components/skeletons/message-list-skeleton';
import {
  useChannelAttachments,
  type PendingAttachmentAsset,
} from '@/hooks/use-channel-attachments';
import { useChannelMembers } from '@/hooks/use-channel-members';
import {
  POSTS_PAGE_SIZE,
  postsQueryKey,
  useChannelEvents,
  useChannelPosts,
  useChannelSse,
  type PostsQueryData,
} from '@/hooks/use-channel-posts';
import { useMarkRead } from '@/hooks/use-mark-read';
import { useSelectedOrg } from '@/hooks/use-selected-org';
import { useTheme } from '@/hooks/use-theme';
import {
  createMmPost,
  deleteMmPost,
  editMmPost,
  listMmPosts,
  listMmPostsAround,
  pinMmPost,
  pingTyping,
  toggleReaction,
  unpinMmPost,
  type MmChannel,
  type MmChannelMember,
  type MmPost,
} from '@/lib/api';
import { buildChatRows, type ChatRow } from '@/lib/chat-grouping';
import { quotedBodyText } from '@/lib/formatting';
import { useAuth } from '@/providers/auth-provider';
import { useRealtime } from '@/providers/realtime-provider';
import { useTabBarVisibility } from '@/providers/tab-bar-visibility';

const DEFAULT_BOTTOM_BAR_HEIGHT = 64;
// Gap between the composer pill and the keyboard top when the keyboard is
// open — gives the inputs a little breathing room above the keys instead
// of letting them sit flush against the top edge.
const COMPOSER_TO_KEYBOARD_GAP = 10;
// Offset of the title block below the status bar. Lands the avatar at
// approximately the same vertical level as the back button so they read
// as a single horizontal row, with the name pill hanging below.
const TITLE_BLOCK_TOP_OFFSET = 4;
// Visual height of the avatar + name pill stack. Used to push the
// message list down so its top edge clears the block.
// Avatar (46) + pill (~28) - overlap (6) + bottom breathing room.
const TITLE_BLOCK_HEIGHT = 78;

// Half-width of the window fetched when jumping to a message outside the
// loaded view — re-anchors the timeline on that island instead of paging back
// from the live tail one screen at a time (see ``jumpToPost``).
const AROUND_RADIUS = 25;

/** Dedupe a post list by id, preserving order — guards the seam where two
 *  contiguous fetches share a boundary post. */
function dedupePostsById(posts: MmPost[]): MmPost[] {
  const seen = new Set<number>();
  const out: MmPost[] = [];
  for (const p of posts) {
    if (!seen.has(p.post_id)) {
      seen.add(p.post_id);
      out.push(p);
    }
  }
  return out;
}

export default function ChannelScreen() {
  const { channelId, jumpToPostId } = useLocalSearchParams<{
    channelId: string;
    jumpToPostId?: string;
  }>();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const { token, user } = useAuth();
  const { selectedOrg } = useSelectedOrg();
  const queryClient = useQueryClient();
  const { requestHidden } = useTabBarVisibility();
  const { registerActiveChannel } = useRealtime();
  const navigation = useNavigation();

  const [bottomBarHeight, setBottomBarHeight] = useState(DEFAULT_BOTTOM_BAR_HEIGHT);
  const [editing, setEditing] = useState<{ postId: number; initialText: string } | null>(
    null,
  );
  const [replyTo, setReplyTo] = useState<MmPost | null>(null);
  const [lightbox, setLightbox] = useState<{ urls: string[]; index: number } | null>(null);
  // Scroll-to-bottom chip state lives here so the chip can render inline
  // inside the composer row (right of the input) rather than floating above
  // the list. ``MessageList`` reports threshold crossings via callback.
  // Programmatic scroll-to-bottom goes through ``scrollMessageToEnd``
  // below — that helper coordinates with the keyboard state so the snap
  // doesn't fight an in-flight keyboard animation.
  const messageListRef = useRef<LegendListRef>(null);
  const composerWrapRef = useRef<View>(null);
  const { contentInsetEndAdjustment, onComposerLayout } = useKeyboardChatComposerInset(
    messageListRef,
    composerWrapRef,
    // Seed the inset with an estimate of the composer height so the very first
    // ``scrollToEnd`` lands ABOVE the composer instead of under it (the precise
    // ``onComposerLayout`` only fine-tunes after). Fixes "chat opens scrolled a
    // bit down with the newest message under the composer."
    DEFAULT_BOTTOM_BAR_HEIGHT,
  );
  const { freeze, scrollMessageToEnd } = useKeyboardScrollToEnd({
    listRef: messageListRef,
  });
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  // Anchored history window: non-null when the viewer jumped to a message
  // outside the live tail. The timeline then renders this self-managed,
  // newest-first segment (seeded by ``/posts/around``, paged both ways) and
  // live stick-to-bottom is suspended until they return to present.
  const [anchor, setAnchor] = useState<{
    posts: MmPost[];
    hasOlder: boolean;
    hasNewer: boolean;
  } | null>(null);
  const anchorSeedRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const loadingOlderAnchorRef = useRef(false);
  const handleScrollToBottom = useCallback(() => {
    // While anchored, the scroll-to-bottom chip means "return to present":
    // drop the window, revalidate the live tail, and snap to it. A still-set
    // ``anchorSeedRef`` keeps any in-flight jump fetch from re-spinning, and a
    // completed jump already cleared ``pendingJumpRef``, so neither needs
    // touching here.
    if (anchor != null) {
      setAnchor(null);
      void queryClient.invalidateQueries({ queryKey: postsQueryKey(channelId) });
      requestAnimationFrame(() => {
        void scrollMessageToEnd({ animated: false, closeKeyboard: false });
      });
      return;
    }
    void scrollMessageToEnd({ animated: true, closeKeyboard: false });
  }, [anchor, queryClient, channelId, scrollMessageToEnd]);

  // Jump-to-message: a search-result tap (?jumpToPostId) or a quoted-reply
  // tap scrolls the target into view and briefly flashes it. The resolution
  // effect (further down, once ``rows`` is known) does the find-or-page-older
  // work; these refs/state drive it. ``jumpTick`` lets a re-tap of the same
  // post re-run the effect even when ``rows`` hasn't changed.
  const [highlightedPostId, setHighlightedPostId] = useState<number | null>(null);
  const [jumpTick, setJumpTick] = useState(0);
  const pendingJumpRef = useRef<number | null>(null);
  const jumpHandledRef = useRef<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashPost = useCallback((postId: number) => {
    setHighlightedPostId(postId);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => setHighlightedPostId(null), 1600);
  }, []);

  const jumpToPost = useCallback((postId: number) => {
    pendingJumpRef.current = postId;
    // Allow a fresh re-anchor for this jump even if a prior one bailed.
    anchorSeedRef.current = false;
    setJumpTick((t) => t + 1);
  }, []);

  useEffect(
    () => () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    },
    [],
  );
  // Keyboard handling lives inside ``MessageList`` now: the Legend List's
  // ``renderScrollComponent`` wraps the inner ScrollView with
  // ``KeyboardChatScrollView`` (react-native-keyboard-controller
  // v1.21), which extends the scrollable area via ``contentInset``
  // when the keyboard rises. That's free at the GPU level — no
  // ``paddingBottom`` mutation, no layout pass per frame, none of
  // the Android ``adjustResize`` double-counting we used to fight.
  // The composer still uses ``KeyboardStickyView`` so its pill
  // tracks the keyboard top with vertical translation.
  //
  // ``keyboardLiftBehavior: 'whenAtEnd'`` on the wrapper handles the
  // "snap to latest on keyboard open" semantics — only when the user
  // is already at the bottom — so the manual ``isKeyboardOpen``
  // ``useEffect`` we used to keep here is no longer needed.
  //
  // ``isKeyboardOpen`` is still read for one thing: the bottom-edge
  // safe-area spacer below the composer collapses to the breathing
  // gap when the keyboard is up (the keyboard already covers the
  // home indicator) and expands to clear the home indicator when the
  // keyboard is down.
  const isKeyboardOpen = useKeyboardState((state) => state.isVisible);

  // Stored so the `transitionStart` listener below can release this
  // screen's hold *before* the cleanup runs (cleanup fires on `blur`,
  // which on the iOS native stack lands ~300ms after the pop animation
  // has already started). Sharing a ref ensures we don't double-release.
  const hiddenReleaseRef = useRef<(() => void) | null>(null);

  useFocusEffect(
    useCallback(() => {
      // Counter-based: chat-details (pushed on top) also holds a request
      // from its own mount effect, so the bar stays hidden across the
      // push/pop handoff without a brief flicker.
      hiddenReleaseRef.current = requestHidden();
      // Tell the realtime provider this channel is in the foreground
      // so its global ``post.created`` handler doesn't bump the unread
      // badge on the very channel the user is reading.
      registerActiveChannel(channelId);
      return () => {
        hiddenReleaseRef.current?.();
        hiddenReleaseRef.current = null;
        registerActiveChannel(null);
      };
    }, [requestHidden, registerActiveChannel, channelId]),
  );

  // Release the hold at the *start* of this screen's pop transition so
  // the tab bar slides in alongside the navigation animation rather
  // than landing after blur fires post-animation. ``transitionStart``
  // with ``data.closing === true`` fires for back-tap pop and the
  // interactive edge-swipe.
  //
  // ``gestureCancel`` (iOS-only) covers the case where the user starts
  // the edge-swipe — which already triggered transitionStart and let
  // the tab bar slide in — but then releases before crossing the
  // threshold. We re-acquire the hold so the tab bar slides back out
  // instead of being stranded over the still-active chat screen.
  useEffect(() => {
    const transitionUnsub = navigation.addListener(
      'transitionStart' as never,
      ((e: { data?: { closing?: boolean } }) => {
        if (!e?.data?.closing) return;
        hiddenReleaseRef.current?.();
        hiddenReleaseRef.current = null;
      }) as never,
    );
    const gestureCancelUnsub = navigation.addListener(
      'gestureCancel' as never,
      (() => {
        if (!hiddenReleaseRef.current) {
          hiddenReleaseRef.current = requestHidden();
        }
      }) as never,
    );
    return () => {
      transitionUnsub();
      gestureCancelUnsub();
    };
  }, [navigation, requestHidden]);

  const channel = useChannelFromCache(channelId, selectedOrg?.org_id ?? null);
  const unreadOther = useUnreadOtherCount(channelId, selectedOrg?.org_id ?? null);

  const postsQuery = useChannelPosts(channelId);
  const eventsQuery = useChannelEvents(channelId);
  const { typing } = useChannelSse(channelId);
  const markRead = useMarkRead(channelId);
  const attachments = useChannelAttachments(channelId);
  const members = useChannelMembers(channelId);

  // For DMs, find the peer's read pointer — drives the "Read" indicator
  // under the latest outgoing message. Member.read SSE events keep this
  // current. For non-DM channels we don't bother (matches iMessage's
  // "no read receipts in group threads").
  const peerLastReadPostId = findPeerLastReadPostId(
    channel?.channel_type,
    members,
    user?.id ?? null,
  );
  const isDirect = channel?.channel_type === 'direct';
  const isAgentDirect = isDirect && members.some((m) => m.agent_id != null);

  const rows = useMemo<ChatRow[]>(() => {
    // While anchored on a jumped-to window, that self-managed segment is the
    // sole source (newest-first, already contiguous); live typing isn't shown
    // and channel events aren't interleaved (they'd sort to the window edges
    // out of context).
    const posts = anchor
      ? anchor.posts
      : (postsQuery.data?.pages.flatMap((page) => page.posts) ?? []);
    const newestFirst = buildChatRows({
      posts,
      events: anchor ? undefined : eventsQuery.data?.events,
      viewerHumanId: user?.id ?? null,
      isDirect,
      isAgentDirect,
      peerLastReadPostId,
    });
    const ordered: ChatRow[] = newestFirst.slice().reverse();
    if (!anchor && typing.length > 0) {
      ordered.push({ kind: 'typing', id: 'typing-row' });
    }
    return ordered;
  }, [
    anchor,
    postsQuery.data,
    eventsQuery.data,
    user?.id,
    isDirect,
    isAgentDirect,
    typing.length,
    peerLastReadPostId,
  ]);
  // ``MessageList`` now owns its own bottom-snap window: an
  // ``onContentSizeChange`` handler re-snaps to ``scrollToEnd`` on every
  // layout pass during the first ~1.5s after mount, disengaging on
  // user touch. That covers initial mount + late image/link-preview
  // reflows, so we no longer need an imperative ``scrollToBottom``
  // here. The deferred-rows hop we used to do was also dropped — it
  // lagged page-load prepends by a frame, producing a visible
  // catch-up jump when older history landed.

  // Warm the history with one background page once the initial page
  // has settled. Combined with ``onStartReachedThreshold = 2`` in
  // ``MessageList``, this means: by the time the user scrolls up at
  // all, the next page is either already loaded or 2 viewports away
  // from being needed. A ref counter prevents the effect from
  // re-firing once ``isFetchingNextPage`` flips back to false —
  // otherwise it would keep prefetching the entire channel history
  // in the background on long channels.
  const prefetchedInitialRef = useRef(false);
  useEffect(() => {
    prefetchedInitialRef.current = false;
  }, [channelId]);
  const isLoading = postsQuery.isLoading;
  const hasNextPage = postsQuery.hasNextPage;
  const isFetchingNextPage = postsQuery.isFetchingNextPage;
  const fetchNextPage = postsQuery.fetchNextPage;
  useEffect(() => {
    if (prefetchedInitialRef.current) return;
    if (isLoading) return;
    if (!hasNextPage) return;
    if (isFetchingNextPage) return;
    const timer = setTimeout(() => {
      prefetchedInitialRef.current = true;
      void fetchNextPage();
    }, 600);
    return () => clearTimeout(timer);
  }, [isLoading, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Deterministic open-at-newest: snap to the latest message exactly once per
  // channel as soon as the first page is loaded — instead of relying solely on
  // MessageList's time-boxed settle window (which late events/older-page
  // prefetch could leave landing short of the newest). Skipped on a jump target
  // or an anchored history window. The seeded composer inset (above) lands it
  // above the composer; the settle window then only absorbs late image/preview
  // reflows.
  const didInitialScrollRef = useRef(false);
  useEffect(() => {
    didInitialScrollRef.current = false;
  }, [channelId]);
  useEffect(() => {
    if (didInitialScrollRef.current) return;
    if (anchor != null || jumpToPostId) return;
    if (!postsQuery.isSuccess || rows.length === 0) return;
    didInitialScrollRef.current = true;
    const id = requestAnimationFrame(() => {
      void scrollMessageToEnd({ animated: false, closeKeyboard: false });
    });
    return () => cancelAnimationFrame(id);
  }, [postsQuery.isSuccess, rows.length, anchor, jumpToPostId, scrollMessageToEnd]);

  // Resolve a pending jump: scroll to + flash the target if it's in the
  // loaded window, otherwise page older history (bounded) until it appears or
  // we hit the top of the channel. Re-runs whenever ``rows`` grows (a fetch
  // landed) or ``jumpTick`` bumps (a fresh jump was requested).
  useEffect(() => {
    const target = pendingJumpRef.current;
    if (target == null) return;
    const idx = rows.findIndex((r) => r.kind === 'message' && r.post.post_id === target);
    if (idx >= 0) {
      pendingJumpRef.current = null;
      anchorSeedRef.current = false;
      // The target may have just landed in a freshly-swapped anchor window
      // whose rows Legend List hasn't measured yet; align instantly and
      // re-issue across a few frames as measurements settle (mirrors web).
      let pass = 0;
      const settle = () => {
        messageListRef.current?.scrollToIndex({ index: idx, animated: false, viewPosition: 0.5 });
        if (++pass < 4) requestAnimationFrame(settle);
      };
      requestAnimationFrame(settle);
      flashPost(target);
      return;
    }
    // Target isn't in the loaded view — re-anchor on a window centred on it
    // (one bounded fetch). When the segment swaps in, ``rows`` changes and this
    // effect re-runs to do the scroll. Guarded so we fetch at most once.
    if (anchorSeedRef.current || !token) return;
    anchorSeedRef.current = true;
    void (async () => {
      try {
        const resp = await listMmPostsAround(token, channelId, target, AROUND_RADIUS);
        const windowPosts = resp.posts; // newest-first
        if (windowPosts.some((p) => p.post_id === target)) {
          const olderCount = windowPosts.filter((p) => p.post_id < target).length;
          const newerCount = windowPosts.filter((p) => p.post_id > target).length;
          setAnchor({
            posts: windowPosts,
            hasOlder: olderCount >= AROUND_RADIUS,
            hasNewer: newerCount >= AROUND_RADIUS,
          });
        }
        // Not found (deleted / not visible): leave the seed guard set so we
        // don't spin; the jump just doesn't land. A retry only comes from a
        // fresh ``jumpToPost`` (which clears the guard).
      } catch {
        // Swallow — same "don't spin" behavior.
      }
    })();
  }, [rows, jumpTick, token, channelId, flashPost]);

  // Older/newer loaders for the anchored window. The live tail keeps using the
  // infinite query (``fetchNextPage``); these only run while ``anchor`` is set,
  // extending the segment in place via the before/after cursors. A short page
  // flips the matching ``has*`` flag, which stops the directional trigger.
  const loadOlderAnchor = useCallback(() => {
    if (!anchor || loadingOlderAnchorRef.current || !anchor.hasOlder || !token) return;
    const oldestId = anchor.posts[anchor.posts.length - 1]?.post_id;
    if (oldestId == null) return;
    loadingOlderAnchorRef.current = true;
    void (async () => {
      try {
        const resp = await listMmPosts(token, channelId, {
          limit: POSTS_PAGE_SIZE,
          beforePostId: oldestId,
        });
        setAnchor((prev) =>
          prev
            ? {
                ...prev,
                // newest-first segment: older posts append at the end.
                posts: dedupePostsById([...prev.posts, ...resp.posts]),
                hasOlder: resp.posts.length >= POSTS_PAGE_SIZE,
              }
            : prev,
        );
      } finally {
        loadingOlderAnchorRef.current = false;
      }
    })();
  }, [anchor, token, channelId]);

  const loadNewerAnchor = useCallback(() => {
    if (!anchor || loadingNewerRef.current || !anchor.hasNewer || !token) return;
    const newestId = anchor.posts[0]?.post_id;
    if (newestId == null) return;
    loadingNewerRef.current = true;
    void (async () => {
      try {
        const resp = await listMmPosts(token, channelId, {
          limit: POSTS_PAGE_SIZE,
          afterPostId: newestId,
        });
        setAnchor((prev) =>
          prev
            ? {
                ...prev,
                // newest-first segment: newer posts prepend at the front.
                posts: dedupePostsById([...resp.posts, ...prev.posts]),
                hasNewer: resp.posts.length >= POSTS_PAGE_SIZE,
              }
            : prev,
        );
      } finally {
        loadingNewerRef.current = false;
      }
    })();
  }, [anchor, token, channelId]);

  const handleLoadOlder = useCallback(() => {
    if (anchor) {
      loadOlderAnchor();
      return;
    }
    if (postsQuery.hasNextPage && !postsQuery.isFetchingNextPage) {
      if (process.env.EXPO_OS === 'ios') {
        void Haptics.selectionAsync();
      }
      void postsQuery.fetchNextPage();
    }
  }, [anchor, loadOlderAnchor, postsQuery]);

  // A search result was tapped — it routes here with ?jumpToPostId. Kick the
  // jump once the first page is loaded; the ref guards it to once per value so
  // it doesn't re-fire on every render.
  useEffect(() => {
    if (!jumpToPostId) return;
    if (jumpHandledRef.current === jumpToPostId) return;
    if (isLoading) return;
    const n = Number(jumpToPostId);
    if (!Number.isFinite(n)) return;
    jumpHandledRef.current = jumpToPostId;
    // Defer a frame so the kick (which sets state) lands outside the effect
    // body and the first page has painted before we start scrolling/paging.
    const id = requestAnimationFrame(() => jumpToPost(n));
    return () => cancelAnimationFrame(id);
  }, [jumpToPostId, isLoading, jumpToPost]);

  // Optimistic send pipeline shared by a new send and a failed-message
  // resend: insert a negative-id temp post, fire the create, then either
  // reconcile against the server post (filtering by tempId so a racing
  // SSE-inserted copy survives) or mark the temp ``_failed`` for retry.
  const performSend = useCallback(
    (opts: {
      message: string;
      clientMsgUuid: string;
      parentPostId: number | null;
      parentPreview: MmPost['parent_preview'];
      fileIds: string[];
    }) => {
      if (!token || !user) return;
      const { message, clientMsgUuid, parentPostId, parentPreview, fileIds } = opts;
      const tempId = -Date.now();
      const tempPost: MmPost = {
        post_id: tempId,
        channel_id: channelId,
        agent_id: null,
        human_id: user.id,
        poster_display_name: user.display_name ?? user.email,
        message,
        created_at: new Date().toISOString(),
        status: 'streaming',
        client_msg_uuid: clientMsgUuid,
        parent_post_id: parentPostId,
        parent_preview: parentPreview ?? null,
        _pendingFileIds: fileIds.length > 0 ? fileIds : undefined,
      };

      queryClient.setQueryData<PostsQueryData>(postsQueryKey(channelId), (prev) => {
        if (!prev) return prev;
        const firstPage = prev.pages[0];
        if (!firstPage) return prev;
        const updatedFirst = { ...firstPage, posts: [tempPost, ...firstPage.posts] };
        return { ...prev, pages: [updatedFirst, ...prev.pages.slice(1)] };
      });

      // Keyboard-aware scroll-to-bottom — coordinates with in-flight keyboard
      // frames via the ``freeze`` shared value; keeps the composer focused.
      void scrollMessageToEnd({ animated: true, closeKeyboard: false });

      void (async () => {
        try {
          const post = await createMmPost(token, channelId, {
            message,
            client_msg_uuid: clientMsgUuid,
            parent_post_id: parentPostId ?? undefined,
            file_ids: fileIds.length > 0 ? fileIds : undefined,
          });
          queryClient.setQueryData<PostsQueryData>(postsQueryKey(channelId), (prev) => {
            if (!prev) return prev;
            const realExists = prev.pages.some((p) =>
              p.posts.some((x) => x.post_id === post.post_id),
            );
            const pages = prev.pages.map((page, idx) => {
              if (idx !== 0) return page;
              // Filter by tempId (negative), NOT client_msg_uuid — the server
              // echoes the same uuid on the real post, so filtering by uuid
              // would also strip the real post that SSE may have inserted.
              const withoutTemp = page.posts.filter((p) => p.post_id !== tempId);
              return realExists
                ? { ...page, posts: withoutTemp }
                : { ...page, posts: [post, ...withoutTemp] };
            });
            return { ...prev, pages };
          });
        } catch {
          queryClient.setQueryData<PostsQueryData>(postsQueryKey(channelId), (prev) => {
            if (!prev) return prev;
            const pages = prev.pages.map((page) => ({
              ...page,
              posts: page.posts.map((p) =>
                p.client_msg_uuid === clientMsgUuid ? { ...p, _failed: true } : p,
              ),
            }));
            return { ...prev, pages };
          });
          if (process.env.EXPO_OS === 'ios') {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          }
        }
      })();
    },
    [channelId, queryClient, token, user, scrollMessageToEnd],
  );

  const handleSend = async (message: string) => {
    if (!token || !user) return;
    if (editing) {
      const editingPostId = editing.postId;
      setEditing(null);
      try {
        const updated = await editMmPost(token, editingPostId, message);
        queryClient.setQueryData<PostsQueryData>(postsQueryKey(channelId), (prev) => {
          if (!prev) return prev;
          const pages = prev.pages.map((page) => ({
            ...page,
            posts: page.posts.map((p) => (p.post_id === editingPostId ? updated : p)),
          }));
          return { ...prev, pages };
        });
      } catch (err) {
        Alert.alert('Edit failed', err instanceof Error ? err.message : 'Try again.');
      }
      return;
    }
    // Sending a new message from an anchored history window returns to the live
    // tail so the message is actually visible — it lands in the live cache,
    // which the anchored view doesn't render.
    if (anchor != null) setAnchor(null);
    const fileIds = attachments.readyFileIds;
    attachments.reset();
    const replyParent = replyTo;
    setReplyTo(null);
    performSend({
      message,
      clientMsgUuid: newClientMsgUuid(),
      parentPostId: replyParent?.post_id ?? null,
      parentPreview: replyParent
        ? {
            post_id: replyParent.post_id,
            agent_id: replyParent.agent_id,
            human_id: replyParent.human_id,
            poster_display_name: replyParent.poster_display_name,
            message_excerpt: replyParent.message.slice(0, 140),
            status: replyParent.status,
            attachment_count: replyParent.files?.length ?? 0,
          }
        : null,
      fileIds,
    });
  };

  const onBottomBarLayout = (event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.height;
    if (Math.abs(next - bottomBarHeight) > 1) {
      setBottomBarHeight(next);
    }
  };

  const handleBubbleAction = useCallback(
    (action: BubbleAction, postId: number) => {
      if (!token) return;
      const findPost = (): MmPost | undefined => {
        const data = queryClient.getQueryData<PostsQueryData>(postsQueryKey(channelId));
        return data?.pages.flatMap((p) => p.posts).find((p) => p.post_id === postId);
      };
      const patchPost = (next: MmPost) => {
        queryClient.setQueryData<PostsQueryData>(postsQueryKey(channelId), (prev) => {
          if (!prev) return prev;
          const pages = prev.pages.map((page) => ({
            ...page,
            posts: page.posts.map((p) => (p.post_id === postId ? next : p)),
          }));
          return { ...prev, pages };
        });
      };
      const removePost = () => {
        queryClient.setQueryData<PostsQueryData>(postsQueryKey(channelId), (prev) => {
          if (!prev) return prev;
          const pages = prev.pages.map((page) => ({
            ...page,
            posts: page.posts.filter((p) => p.post_id !== postId),
          }));
          return { ...prev, pages };
        });
      };

      const post = findPost();
      if (!post) return;

      if (action === 'copy') {
        void Clipboard.setStringAsync(post.message);
        if (process.env.EXPO_OS === 'ios') {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        }
        return;
      }
      if (action === 'pin') {
        void pinMmPost(token, postId).then(patchPost).catch(() => {});
        return;
      }
      if (action === 'unpin') {
        void unpinMmPost(token, postId).then(patchPost).catch(() => {});
        return;
      }
      if (action === 'edit') {
        setEditing({ postId, initialText: post.message });
        return;
      }
      if (action === 'reply') {
        setEditing(null);
        setReplyTo(post);
        return;
      }
      if (action === 'retry') {
        // Failed optimistic post (negative id). Offer resend — reusing the
        // same client_msg_uuid so the server dedupes if the original POST
        // actually landed, and the stashed attachment ids — or discard.
        Alert.alert('Message not sent', undefined, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: removePost },
          {
            text: 'Try Again',
            onPress: () => {
              removePost();
              performSend({
                message: post.message,
                clientMsgUuid: post.client_msg_uuid ?? newClientMsgUuid(),
                parentPostId: post.parent_post_id ?? null,
                parentPreview: post.parent_preview ?? null,
                fileIds: post._pendingFileIds ?? [],
              });
            },
          },
        ]);
        return;
      }
      if (action === 'delete') {
        Alert.alert('Delete message', 'This cannot be undone.', [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              removePost();
              void deleteMmPost(token, postId).catch(() => {
                // Server rejected — let SSE/refetch restore. Best-effort UX.
              });
            },
          },
        ]);
      }
    },
    [channelId, performSend, queryClient, token],
  );

  const handlePickPhotos = useCallback(async () => {
    try {
      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.All,
        allowsMultipleSelection: true,
        quality: 0.85,
        selectionLimit: 10,
      });
      if (picked.canceled) return;
      attachments.addFiles(picked.assets.map(assetFromImagePick));
    } catch (err) {
      Alert.alert(
        'Could not attach',
        err instanceof Error ? err.message : 'Try again.',
      );
    }
  }, [attachments]);

  const handlePickFiles = useCallback(async () => {
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (picked.canceled) return;
      attachments.addFiles(picked.assets.map(assetFromDocumentPick));
    } catch (err) {
      Alert.alert(
        'Could not attach',
        err instanceof Error ? err.message : 'Try again.',
      );
    }
  }, [attachments]);

  const handleBubbleReact = useCallback(
    (postId: number, emoji: string) => {
      if (!token) return;
      if (process.env.EXPO_OS === 'ios') {
        void Haptics.selectionAsync();
      }
      void toggleReaction(token, postId, emoji)
        .then((updated) => {
          queryClient.setQueryData<PostsQueryData>(postsQueryKey(channelId), (prev) => {
            if (!prev) return prev;
            const pages = prev.pages.map((page) => ({
              ...page,
              posts: page.posts.map((p) => (p.post_id === postId ? updated : p)),
            }));
            return { ...prev, pages };
          });
        })
        .catch(() => {});
    },
    [channelId, queryClient, token],
  );

  return (
    <View
      style={[
        styles.screen,
        {
          backgroundColor: theme.background,
          // Inset the screen from horizontal gesture / cutout areas so
          // the title block, message list, and composer stay inside the
          // safe box when the device is rotated to landscape or unfolded
          // onto a display with side cutouts. Absolutely-positioned
          // children with ``left: 0`` / ``right: 0`` resolve against the
          // padded box, so this propagates without per-child changes.
          paddingLeft: insets.left,
          paddingRight: insets.right,
        },
      ]}>
      <Stack.Screen
        options={{
          // Avatar + name pill render below the nav header (see TitleBlock
          // further down). The native iOS title slot is a fixed 44pt and
          // doesn't accept a height override, so a tall stacked title
          // gets clipped + jitters horizontally during the push/pop slide.
          // Empty headerTitle keeps the back button + scrollEdgeEffects
          // working while the visual title lives in normal screen space.
          // Empty *string* (not `() => null`) — a function returning null
          // makes native-stack fall back to the layout-level ``title``
          // ("Chat"), which would then re-appear in the slot.
          headerTitle: '',
          headerLeft: () => <ChatHeaderBack unreadOtherCount={unreadOther} />,
          headerBackVisible: false,
          headerTitleAlign: 'center',
          headerTransparent: true,
          headerShadowVisible: false,
          // iOS 26 progressive liquid-glass blur — content fades behind the translucent header & composer.
          scrollEdgeEffects: { top: 'soft', bottom: 'soft' },
        }}
      />

      <View
        style={[styles.titleBlock, { top: insets.top + TITLE_BLOCK_TOP_OFFSET }]}
        pointerEvents="box-none">
        <ChatHeaderTitle channel={channel} fallbackTitle={channelId} />
      </View>

      <View style={styles.kavWrap}>
        {postsQuery.isLoading ? (
          <MessageListSkeleton
            topPadding={Math.max(
              headerHeight,
              insets.top + TITLE_BLOCK_TOP_OFFSET + TITLE_BLOCK_HEIGHT,
            )}
            bottomPadding={bottomBarHeight}
          />
        ) : postsQuery.error ? (
          <View style={styles.center}>
            <Text style={[styles.errorText, { color: theme.text }]} selectable>
              {postsQuery.error.message}
            </Text>
          </View>
        ) : (
          <MessageList
            ref={messageListRef}
            rows={rows}
            onLoadOlder={handleLoadOlder}
            onLoadNewer={loadNewerAnchor}
            autoStickToBottom={anchor == null}
            loadingOlder={postsQuery.isFetchingNextPage}
            topPadding={Math.max(
              headerHeight,
              insets.top + TITLE_BLOCK_TOP_OFFSET + TITLE_BLOCK_HEIGHT,
            )}
            // Composer height feeds into the list as a SharedValue —
            // measured by ``useKeyboardChatComposerInset`` from the
            // composerWrapRef below — so the last message is never
            // covered by the composer pill (at rest or when the
            // keyboard rises). ``freeze`` lets ``scrollMessageToEnd``
            // suppress keyboard layout churn while we programmatically
            // snap to the bottom.
            contentInsetEndAdjustment={contentInsetEndAdjustment}
            freeze={freeze}
            onViewableItemsChanged={markRead.onViewableItemsChanged}
            viewabilityConfig={markRead.viewabilityConfig}
            onBubbleAction={handleBubbleAction}
            onBubbleReact={handleBubbleReact}
            onBubbleImagePress={(index, urls) => setLightbox({ index, urls })}
            onBubbleParentPress={jumpToPost}
            highlightedPostId={highlightedPostId}
            onShowScrollToBottomChange={setShowScrollToBottom}
            // Opening on a search-jump target? Don't let the open-at-bottom
            // settle snap fight the jump's scroll-to-message.
            enableInitialBottomSnap={!jumpToPostId}
          />
        )}
      </View>

      <KeyboardStickyView
        style={styles.composer}
        offset={{ closed: 0, opened: 0 }}>
        <View
          ref={composerWrapRef}
          onLayout={(event) => {
            // Two listeners: ``onComposerLayout`` feeds the measured
            // height into ``useKeyboardChatComposerInset``'s SharedValue
            // (drives the list's ``contentInsetEndAdjustment``);
            // ``onBottomBarLayout`` keeps the local ``bottomBarHeight``
            // state in sync for the skeleton's static ``bottomPadding``.
            onComposerLayout(event);
            onBottomBarLayout(event);
          }}>
          <PendingAttachments
            attachments={attachments.attachments}
            onRemove={attachments.removeFile}
          />
          <MessageComposer
            key={editing ? `edit-${editing.postId}` : 'new'}
            onSend={handleSend}
            onPickPhotos={() => void handlePickPhotos()}
            onPickFiles={() => void handlePickFiles()}
            onTyping={() => {
              if (token) void pingTyping(token, channelId).catch(() => {});
            }}
            editing={
              editing
                ? {
                    initialText: editing.initialText,
                    onCancel: () => setEditing(null),
                  }
                : undefined
            }
            replyingTo={
              replyTo
                ? {
                    authorName: replyTo.poster_display_name ?? 'Unknown',
                    // Attachment-only parents carry no text — the banner
                    // labels them from the file count instead of blank.
                    excerpt: quotedBodyText(replyTo.message, replyTo.files?.length ?? 0),
                    onCancel: () => setReplyTo(null),
                  }
                : undefined
            }
            mentionableMembers={members}
            hasAttachments={attachments.allReady}
            sendBlocked={attachments.hasInFlight}
            showScrollToBottom={anchor != null || showScrollToBottom}
            onScrollToBottom={handleScrollToBottom}
          />
          <View
            style={{
              // With the keyboard up, the home indicator is covered by the
              // keys — collapse the safe-area spacer to a small breathing
              // gap above the keyboard. With the keyboard down, respect the
              // home indicator but never less than the breathing gap (so
              // pre-iPhone-X devices still get a touchable margin). On
              // Android with edge-to-edge the gesture indicator is only a
              // thin line at the very bottom — reserving the full bottom
              // inset above it leaves a visible dark band, so use just the
              // breathing gap.
              height:
                Platform.OS === 'android' || isKeyboardOpen
                  ? COMPOSER_TO_KEYBOARD_GAP
                  : Math.max(COMPOSER_TO_KEYBOARD_GAP, insets.bottom - 10),
            }}
          />
        </View>
      </KeyboardStickyView>
      <ImageLightbox
        visible={lightbox != null}
        imageUrls={lightbox?.urls ?? []}
        initialIndex={lightbox?.index ?? 0}
        onClose={() => setLightbox(null)}
      />
    </View>
  );
}

function newClientMsgUuid(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Defensive helper — the cached members list comes from a query that
 *  may briefly be missing (initial render, fast-refresh), so we treat
 *  anything that isn't an array as "no peer yet" instead of crashing
 *  the render. Returns the DM peer's last_read_post_id, or null when
 *  the channel isn't a DM, the viewer is unknown, or no peer is
 *  cached yet. */
function findPeerLastReadPostId(
  channelType: MmChannel['channel_type'] | undefined,
  members: unknown,
  viewerHumanId: number | null,
): number | null {
  if (channelType !== 'direct') return null;
  if (viewerHumanId == null) return null;
  if (!Array.isArray(members)) return null;
  for (const m of members as MmChannelMember[]) {
    if (m?.human_id != null && m.human_id !== viewerHumanId) {
      return m.last_read_post_id ?? null;
    }
  }
  return null;
}

// The presigner pins ``Content-Length`` from ``size_bytes`` (see
// ``presign_put`` in ``clawbits/cloudflare/r2_presign.py``), so a wrong
// size at presign time produces an opaque R2 ``403 SignatureDoesNotMatch``
// at PUT time. ImagePicker omits ``fileSize`` for some PhotoKit assets
// (HEIC originals, certain videos) and DocumentPicker can omit ``size``
// for cloud-provider documents — fall back to reading the actual on-disk
// size off the local cache copy the picker handed us.
function statSize(uri: string): number {
  try {
    return new File(uri).size ?? 0;
  } catch {
    return 0;
  }
}

function assetFromImagePick(
  asset: ImagePicker.ImagePickerAsset,
): PendingAttachmentAsset {
  const filename =
    asset.fileName ?? asset.uri.split('/').pop() ?? `image-${Date.now()}.jpg`;
  return {
    uri: asset.uri,
    filename,
    contentType: asset.mimeType ?? guessContentType(filename),
    sizeBytes: asset.fileSize ?? statSize(asset.uri),
    width: asset.width,
    height: asset.height,
    durationMs: asset.duration ?? undefined,
  };
}

function assetFromDocumentPick(
  asset: DocumentPicker.DocumentPickerAsset,
): PendingAttachmentAsset {
  const filename = asset.name ?? asset.uri.split('/').pop() ?? `file-${Date.now()}`;
  return {
    uri: asset.uri,
    filename,
    contentType: asset.mimeType ?? guessContentType(filename),
    sizeBytes: asset.size ?? statSize(asset.uri),
  };
}

function guessContentType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'heic') return 'image/heic';
  if (ext === 'mp4' || ext === 'm4v') return 'video/mp4';
  if (ext === 'mov') return 'video/quicktime';
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'm4a') return 'audio/mp4';
  if (ext === 'pdf') return 'application/pdf';
  return 'application/octet-stream';
}

function useChannelFromCache(channelId: string, orgId: string | null): MmChannel | null {
  const queryClient = useQueryClient();
  const data = queryClient.getQueryData<{ channels: MmChannel[]; total: number }>([
    'channels',
    orgId,
  ]);
  return data?.channels.find((c) => c.channel_id === channelId) ?? null;
}

function useUnreadOtherCount(channelId: string, orgId: string | null): number {
  const queryClient = useQueryClient();
  const data = queryClient.getQueryData<{ channels: MmChannel[]; total: number }>([
    'channels',
    orgId,
  ]);
  if (!data) return 0;
  return data.channels
    .filter((c) => c.channel_id !== channelId)
    .reduce((sum, c) => sum + (c.unread_count ?? 0), 0);
}

const styles = StyleSheet.create({
  center: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
  composer: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
  },
  errorText: {
    fontSize: 14,
    paddingHorizontal: 24,
    textAlign: 'center',
  },
  kavWrap: {
    flex: 1,
  },
  screen: {
    flex: 1,
  },
  titleBlock: {
    alignItems: 'center',
    // Stack above the message list — both are siblings in the screen
    // container, and without an explicit z-order the later sibling
    // (MessageList) renders on top, so message bubbles bleed in front
    // of the avatar + name pill while scrolling. ``elevation`` is the
    // Android counterpart of zIndex for the same intent.
    elevation: 10,
    left: 0,
    position: 'absolute',
    right: 0,
    zIndex: 10,
  },
});
