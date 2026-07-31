import { KeyboardAwareLegendList } from '@legendapp/list/keyboard';
import type { LegendListRef } from '@legendapp/list/react-native';
import { forwardRef, useCallback, useRef } from 'react';
import {
  ActivityIndicator,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  StyleSheet,
  View,
  type ViewToken,
} from 'react-native';
import type { SharedValue } from 'react-native-reanimated';

import { DateSeparator } from '@/components/chat/date-separator';
import { MessageBubbleMenu, type BubbleAction } from '@/components/chat/message-bubble-menu';
import { SystemMessage } from '@/components/chat/system-message';
import { TypingBubble } from '@/components/chat/typing-bubble';
import { useTheme } from '@/hooks/use-theme';
import type { ChatRow } from '@/lib/chat-grouping';

interface MessageListProps {
  /** Rows in display order (oldest at index 0, newest last). */
  rows: ChatRow[];
  /** Triggered when the user scrolls near the top — load older history. */
  onLoadOlder?: () => void;
  loadingOlder?: boolean;
  /** Triggered when the user scrolls near the bottom while reading an anchored
   *  history window — load newer messages. A no-op on the live tail (nothing
   *  newer to fetch), so the parent gates it on anchor state. */
  onLoadNewer?: () => void;
  /** When false, auto-stick-to-bottom is suppressed (``maintainScrollAtEnd``
   *  off) so loaded/incoming rows don't yank the reader off the message they
   *  jumped to. Set false while anchored on a history window. */
  autoStickToBottom?: boolean;
  /** Padding above the visual top (under the navbar). */
  topPadding: number;
  /** SharedValue tracking the composer's measured height. Drives the list's
   *  ``extraContentPadding`` internally so the last message is never
   *  covered by the composer, and so the keyboard rising/falling adjusts
   *  the scrollable range by exactly (keyboardHeight - composerHeight).
   *  Produced by ``useKeyboardChatComposerInset`` in the parent screen. */
  contentInsetEndAdjustment: SharedValue<number>;
  /** SharedValue used by ``useKeyboardScrollToEnd`` to suppress
   *  keyboard-driven layout changes while a programmatic snap is in
   *  flight (e.g., when the user sends a message and we scroll to
   *  bottom + close the keyboard at the same time). */
  freeze: SharedValue<boolean>;
  /** Receive viewability events for mark-as-read tracking. */
  onViewableItemsChanged?: (info: { viewableItems: ViewToken<ChatRow>[] }) => void;
  viewabilityConfig?: {
    itemVisiblePercentThreshold?: number;
    minimumViewTime?: number;
  };
  /** Long-press menu action — copy, pin/unpin, edit, delete. */
  onBubbleAction: (action: BubbleAction, postId: number) => void;
  /** Quick reaction picked from the long-press auxiliary preview. */
  onBubbleReact: (postId: number, emoji: string) => void;
  /** Tap on an image attachment — opens the lightbox. */
  onBubbleImagePress?: (index: number, imageUrls: string[]) => void;
  /** Tap on a quoted parent — jumps to the referenced post. */
  onBubbleParentPress?: (parentPostId: number) => void;
  /** Post id to briefly flash (search result / jump-to-message landed). */
  highlightedPostId?: number | null;
  /** Fired when the user crosses the scroll-fab visibility threshold. The
   *  parent screen owns the visibility state so it can place the chip in the
   *  composer row instead of floating above the list. */
  onShowScrollToBottomChange?: (show: boolean) => void;
  /** When true (default) the list re-snaps to the newest message during a
   *  short settle window after mount so a freshly-opened chat reliably lands
   *  at the bottom. Pass false when the screen is opening on a jump target
   *  (?jumpToPostId) so the bottom-snap doesn't fight the jump's scroll. */
  enableInitialBottomSnap?: boolean;
}

// Estimate of an average bubble row height. Legend List uses this for the
// first paint only; once each row is measured the average converges to
// the real value. A reasonable estimate matters at channel-open: too low
// makes the list paint with too many rows at once (jank); too high reserves
// dead space and the bottom-anchor lands too high until measurements
// catch up. ~70 covers a typical 1-line incoming bubble + spacing; the
// first measured paint corrects it.
const ESTIMATED_ITEM_SIZE = 70;

// How long after mount we keep re-snapping to the newest message on each
// content-size change. Variable-height bubbles (images, link previews,
// multi-line markdown) measure in across several frames *after* the first
// paint, growing the content below the estimate-based initial scroll — so a
// single ``onLoad`` snap lands short of the bottom. Re-snapping through this
// window lets the chat reliably OPEN at the latest message; after it expires
// ``maintainScrollAtEnd`` owns stick-to-bottom for live updates. Disengages
// immediately if the user grabs the list (``onScrollBeginDrag``).
const INITIAL_SNAP_SETTLE_MS = 1500;

// Visual offset from the visible bottom of the list at which the
// scroll-to-bottom chip starts showing. ~1.5 screens up — matches iMessage's
// "you're scrolled up far enough to lose context" feel.
const FAB_SHOW_OFFSET_PX = 240;

// Legend List's chat-list semantics:
// - ``initialScrollAtEnd`` — on first render, scroll to the last item.
//   Load-bearing for "open at the latest message."
// - ``alignItemsAtEnd`` — when total content is shorter than the
//   viewport, anchor it to the bottom (empty channels don't float at
//   the top).
// - ``maintainScrollAtEnd`` (``{ animated: false }``) — when new data
//   lands while the user is at the bottom, auto-snap instantly. This
//   is the chat-list equivalent of the web's ``shouldStickRef``
//   pattern, with the library doing the bookkeeping.
// - ``maintainVisibleContentPosition: true`` — pin scroll position
//   across both scroll-direction layout shifts AND data-array changes.
//   Load-bearing for older-history prepends staying anchored to the
//   user's current view (equivalent to ``virtua``'s ``shift`` prop on
//   the web side).
const MAINTAIN_SCROLL_AT_END = { animated: false } as const;

export const MessageList = forwardRef<LegendListRef, MessageListProps>(function MessageList(
  {
    rows,
    onLoadOlder,
    loadingOlder,
    onLoadNewer,
    autoStickToBottom = true,
    topPadding,
    contentInsetEndAdjustment,
    freeze,
    onViewableItemsChanged,
    viewabilityConfig,
    onBubbleAction,
    onBubbleReact,
    onBubbleImagePress,
    onBubbleParentPress,
    highlightedPostId,
    onShowScrollToBottomChange,
    enableInitialBottomSnap = true,
  },
  ref,
) {
  const theme = useTheme();
  const lastShowFabRef = useRef(false);

  // Merge the forwarded ref with a local one so the list can scroll itself on
  // initial load (below) while the parent keeps its ref for jump-to-message /
  // keyboard scroll-to-end.
  const innerRef = useRef<LegendListRef | null>(null);
  const setListRef = useCallback(
    (node: LegendListRef | null) => {
      innerRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  // Bottom-snap settle window. ``initialScrollAtEnd`` lands using ESTIMATED
  // row sizes; variable-height bubbles (images, link previews, markdown)
  // measure in over the next several frames and grow the content below that
  // point, so a single snap settles short of the bottom. We re-snap on every
  // content-size change for a short window after mount, then hand off to
  // ``maintainScrollAtEnd`` — and bail the instant the user grabs the list.
  const mountedAtRef = useRef(0);
  const userInteractedRef = useRef(false);
  if (mountedAtRef.current === 0) mountedAtRef.current = Date.now();

  const snapToEndDuringSettle = useCallback(() => {
    if (!enableInitialBottomSnap) return;
    if (userInteractedRef.current) return;
    if (Date.now() - mountedAtRef.current > INITIAL_SNAP_SETTLE_MS) return;
    innerRef.current?.scrollToEnd({ animated: false });
  }, [enableInitialBottomSnap]);

  const handleLoad = useCallback(() => {
    snapToEndDuringSettle();
  }, [snapToEndDuringSettle]);

  const handleContentSizeChange = useCallback(() => {
    snapToEndDuringSettle();
  }, [snapToEndDuringSettle]);

  const handleScrollBeginDrag = useCallback(() => {
    // Ignore drags surfaced while a programmatic snap is in flight (``freeze``
    // is set by scrollMessageToEnd) so the open-at-bottom settle isn't latched
    // off by its own scroll. A genuine user drag (freeze clear) stops the
    // settle re-snaps so we never yank them off a message they scrolled to.
    if (freeze.value) return;
    userInteractedRef.current = true;
  }, [freeze]);

  // Bucket row sizes by kind (and split media vs text bubbles) so LegendList
  // keeps a separate size average per type — a tall image/OG-card row doesn't
  // pollute the text-row estimate and vice versa, which steadies the layout
  // and reduces the correction the open-at-bottom settle has to do.
  const getItemType = useCallback((item: ChatRow) => {
    if (item.kind !== 'message') return item.kind;
    const p = item.post;
    return (p.files?.length ?? 0) > 0 || p.link_preview != null
      ? 'message-media'
      : 'message-text';
  }, []);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
      const distanceFromBottom =
        contentSize.height - layoutMeasurement.height - contentOffset.y;
      const shouldShow = distanceFromBottom > FAB_SHOW_OFFSET_PX;
      if (shouldShow === lastShowFabRef.current) return;
      lastShowFabRef.current = shouldShow;
      onShowScrollToBottomChange?.(shouldShow);
    },
    [onShowScrollToBottomChange],
  );

  return (
    <View style={styles.container}>
      <KeyboardAwareLegendList
        ref={setListRef}
        onLoad={handleLoad}
        data={rows}
        keyExtractor={(row) => rowKey(row)}
        getItemType={getItemType}
        estimatedItemSize={ESTIMATED_ITEM_SIZE}
        renderItem={({ item }) => {
          if (item.kind === 'separator') return <DateSeparator isoTime={item.isoTime} />;
          if (item.kind === 'typing') return <TypingBubble />;
          if (item.kind === 'event') {
            return (
              <SystemMessage event={item.event} viewerHumanId={item.viewerHumanId} />
            );
          }
          return (
            <MessageBubbleMenu
              row={item}
              onAction={onBubbleAction}
              onReact={onBubbleReact}
              onImagePress={onBubbleImagePress}
              onParentPress={onBubbleParentPress}
              highlighted={highlightedPostId != null && item.post.post_id === highlightedPostId}
            />
          );
        }}
        initialScrollAtEnd
        alignItemsAtEnd
        // Off while anchored on a history window so loaded/incoming rows don't
        // snap the viewer to the bottom, away from the message they jumped to.
        maintainScrollAtEnd={autoStickToBottom ? MAINTAIN_SCROLL_AT_END : false}
        maintainVisibleContentPosition
        // Composer height feeds in as ``contentInsetEndAdjustment`` so the
        // last message always has clearance above the composer pill,
        // both at rest and when the keyboard rises. ``freeze`` lets the
        // companion ``useKeyboardScrollToEnd`` hook suppress keyboard
        // layout churn during programmatic scroll-to-end.
        contentInsetEndAdjustment={contentInsetEndAdjustment}
        freeze={freeze}
        // ``always`` — the list lifts whenever the keyboard rises,
        // mirroring Telegram. ``whenAtEnd`` was tried first; its
        // mid-animation state-machine fights the keyboard animation
        // (visible as "lift / drop / lift" jitter).
        keyboardLiftBehavior="always"
        onStartReached={onLoadOlder}
        // 2 viewports of headroom: prefetch begins two screens before
        // the user reaches the top of currently-loaded content, so the
        // network round-trip lands while there's still history under
        // their thumb. ``hasNextPage`` gating in the parent's
        // ``onLoadOlder`` makes an over-eager threshold a no-op once
        // the last page returns short.
        onStartReachedThreshold={2}
        // Scroll-down mirror — only does work while anchored on a history
        // window (the parent's handler no-ops on the live tail). Same 2-viewport
        // headroom so the newer page lands before the user reaches it.
        onEndReached={onLoadNewer}
        onEndReachedThreshold={2}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        // Only ``paddingTop`` here — the composer-region bottom inset is
        // already provided dynamically via ``contentInsetEndAdjustment``,
        // so adding ``paddingBottom`` would double-count and leave a
        // visible gap above the composer.
        contentContainerStyle={{ paddingTop: topPadding }}
        contentInsetAdjustmentBehavior="never"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        showsVerticalScrollIndicator
        onScroll={handleScroll}
        // Re-snap to the newest message as variable-height bubbles measure in
        // during the post-mount settle window (see ``snapToEndDuringSettle``).
        onContentSizeChange={handleContentSizeChange}
        // User grabbed the list — cancel the open-at-bottom settle re-snaps.
        onScrollBeginDrag={handleScrollBeginDrag}
        scrollEventThrottle={64}
        ListHeaderComponent={
          loadingOlder ? (
            <View style={styles.loader}>
              <ActivityIndicator color={theme.textSecondary} />
            </View>
          ) : null
        }
      />
    </View>
  );
});

function rowKey(row: ChatRow): string {
  if (row.kind === 'separator') return row.id;
  if (row.kind === 'typing') return row.id;
  if (row.kind === 'event') return `event-${String(row.event.event_id)}`;
  return `post-${String(row.post.post_id)}`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loader: {
    paddingVertical: 16,
  },
});
