import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Virtualizer,
  type VirtualizerHandle,
} from "virtua";

/**
 * Single authority for the chat scroll area. Replaces the old
 * combination of ``@tanstack/react-virtual`` + ``use-stick-to-bottom``
 * + manual ``scrollHeight`` deltas — which all wanted to own
 * ``scrollTop`` and fought each other on streaming + prepend.
 *
 * Responsibilities owned here:
 *
 *   - **Windowed render** via virtua's :class:`Virtualizer`. Auto-
 *     measures item heights with a shared ResizeObserver and recomputes
 *     offsets on the next animation frame.
 *   - **Anchor on prepend.** Set ``shift`` to ``true`` for the render
 *     where older history is inserted at the top; virtua offsets its
 *     internal scroll bookkeeping so the visible rows don't move. The
 *     flag is cleared in a layout effect right after.
 *   - **Stick-to-bottom.** A ref tracks whether the user is "at
 *     bottom" (within 80px); when ``rows.length`` grows the effect
 *     calls ``scrollToIndex(last, { align: 'end' })``. The user
 *     scrolling away clears the ref, which suppresses auto-scroll
 *     until they scroll back down.
 *   - **History load trigger.** When ``onScroll`` fires with the
 *     offset below ``LOAD_OLDER_THRESHOLD_PX`` we tell the parent to
 *     load older messages; a single-flight ref prevents back-to-back
 *     loads.
 *   - **Bar clearance via in-flow spacers.** Header/composer clearance is
 *     reserved with a leading spacer div and a trailing spacer *row*, never
 *     with ``padding`` on the scroll element. virtua measures its viewport
 *     from the scroll element's content box (ResizeObserver ``contentRect``,
 *     which excludes padding), so padding here would inset the viewport to the
 *     region *between* the glass bars' inner edges -- and virtua trims its
 *     render window's trailing edge to that boundary while scrolling, so rows
 *     were unmounted while still visible through the translucent header/
 *     composer (the flicker). With the clearance held in content instead, the
 *     content box spans the full height and the trim lands off-screen.
 *   - **Flex spacer.** A flex-grow div above the virtualizer pushes
 *     the rows to the bottom when the channel has fewer rows than the
 *     viewport can hold. Without it, short channels would float at
 *     the top.
 *   - **Initial scroll.** On channel-change, the imperative
 *     :meth:`MessageListHandle.scrollToBottomImmediately` jumps to the
 *     last item with no animation. Unread anchor jumps (Discord/Slack
 *     pattern) are also supported via :meth:`scrollToIndex`.
 */

export interface MessageListHandle {
  /** Smooth or instant scroll to the last item. No-op when there are
   *  no rows. */
  scrollToBottom(behavior?: "auto" | "smooth"): void;
  /** Jump-to-index for "jump to message" / "go to unread" affordances.
   *  ``align: "center"`` matches the old ``scrollIntoView({ block:
   *  "center" })`` semantics. Returns ``false`` if the index is out of
   *  range so the caller can fall through to history loading. */
  scrollToIndex(
    index: number,
    opts?: { align?: "start" | "center" | "end"; behavior?: "auto" | "smooth" },
  ): boolean;
  /** True when the visible viewport is within ``stickToBottomThresholdPx``
   *  of the bottom of the scrollable area. Reading from this avoids
   *  needing the ``onAtBottomChange`` callback when only an imperative
   *  check is needed (e.g. "should the send button trigger a smooth
   *  scroll, or is the user already there?"). */
  getIsAtBottom(): boolean;
}

export interface MessageListProps<T> {
  /** Stable, ordered list of rows. The MessageList does not assume any
   *  particular shape — it only relies on the row count and the
   *  parent-supplied render function. */
  rows: readonly T[];
  /** Extract a stable React key. Should be the post id (or a synthetic
   *  one for optimistic rows). Used both as the React key and indirectly
   *  via the order of ``rows`` for virtua's internal item cache. */
  getRowKey: (row: T, index: number) => string | number;
  /** Render one row. The MessageList wraps the result in the virtualizer-
   *  managed positioning element — the parent shouldn't add absolute
   *  positioning or fixed heights itself. */
  renderRow: (row: T, index: number) => ReactNode;
  /** Identifier for the conversation being shown. When this changes the
   *  list resets its stick-to-bottom + prepend state and jumps to the
   *  bottom on first paint. Keep stable across renders of the same
   *  channel. */
  channelKey: string;
  /** Height (in px) of the floating composer pill that overlays the
   *  bottom of the scroll area. Drives the trailing spacer row's height so
   *  the last message clears the composer with a bit of breathing room.
   *  Reserved as an in-flow spacer rather than scroll-container
   *  ``padding-bottom`` so virtua's viewport isn't inset (which would unmount
   *  rows behind the glass composer -- see the JSX note below). */
  composerHeightPx: number;
  /** Height (in px) of the leading spacer that keeps the first message clear
   *  of the glass header pill at the top of the viewport. Defaults to ``64px``
   *  to match the existing layout (``pt-16``). Reserved as an in-flow spacer
   *  rather than scroll-container ``padding-top`` so virtua's viewport isn't
   *  inset. */
  topPaddingPx?: number;
  /** Distance (in px) from the bottom edge that still counts as "at
   *  bottom" for stick-to-bottom purposes. Default 80px — a few rows
   *  of slop so quick mouse-wheel ticks don't accidentally unlock
   *  auto-scroll. */
  stickToBottomThresholdPx?: number;
  /** Distance (in px) from the top that triggers a history load. */
  loadOlderThresholdPx?: number;
  /** Set to true when this render commits older history at the start
   *  of the ``rows`` array. The parent owns the latch — typically a
   *  ref set before ``setOlderPosts`` and cleared in a ``useLayoutEffect``.
   *  When true, virtua adjusts its internal scroll math so the visible
   *  content doesn't shift. */
  prependShift: boolean;
  /** Whether older history is still loadable. When false, the
   *  scroll-up trigger is suppressed (saves a wasted RPC on a channel
   *  that's already scrolled to the very beginning). */
  hasMoreHistory: boolean;
  /** Called when the user scrolls past ``loadOlderThresholdPx`` from
   *  the top. The parent's implementation should be single-flight —
   *  this list debounces internally via an in-flight ref but the parent
   *  must also tolerate being called twice (state-after-cleanup race). */
  onLoadOlder: () => void;
  /** Whether newer history is loadable. True only while the viewer is reading
   *  an *anchored* window below the live tail (after a jump to an off-screen
   *  message). On the live tail there is nothing newer, so the bottom-edge
   *  trigger stays suppressed and ordinary stick-to-bottom owns the bottom. */
  hasMoreNewer?: boolean;
  /** Called when the user scrolls within ``loadNewerThresholdPx`` of the
   *  bottom while ``hasMoreNewer`` is true — scroll-down through an anchored
   *  window. Single-flight mirror of ``onLoadOlder``. */
  onLoadNewer?: () => void;
  /** Distance (px) from the bottom edge that triggers a newer-history load.
   *  Mirror of ``loadOlderThresholdPx``. */
  loadNewerThresholdPx?: number;
  /** When false, every *automatic* stick-to-bottom is suppressed (row-count
   *  growth, content growth, keyboard re-pin). Set false while anchored on a
   *  history window so loaded/incoming rows don't yank the reader off the
   *  message they jumped to. The imperative ``scrollToBottom`` still works —
   *  it's an explicit user action (the "jump to present" affordance). */
  autoStickToBottom?: boolean;
  /** Notified when the at-bottom state flips. Drives the "jump to
   *  latest" pill visibility in the composer. */
  onAtBottomChange?: (atBottom: boolean) => void;
}

/** Extra breathing room between the last message's bottom edge and
 *  the composer wrapper's top edge, *on top of* the measured wrapper
 *  height (which already includes the always-reserved typing-indicator
 *  strip above the pill — ~16px of visible air on its own). With the
 *  slimmer composer the newest message can sit flush against that
 *  strip, so this stays 0; bump it up if the chat ever feels cramped. */
const COMPOSER_BREATHING_ROOM_PX = 0;

export const MessageList = forwardRef(function MessageList<T>(
  {
    rows,
    getRowKey,
    renderRow,
    channelKey,
    composerHeightPx,
    topPaddingPx = 64,
    stickToBottomThresholdPx = 80,
    loadOlderThresholdPx = 200,
    prependShift,
    hasMoreHistory,
    onLoadOlder,
    hasMoreNewer = false,
    onLoadNewer,
    loadNewerThresholdPx = 200,
    autoStickToBottom = true,
    onAtBottomChange,
  }: MessageListProps<T>,
  ref: React.Ref<MessageListHandle>,
) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Both mobile and desktop use the inner-scroll ``Virtualizer`` now — mobile
  // moved off ``WindowVirtualizer`` when the shell became a fixed-viewport box
  // (the window no longer scrolls on mobile).
  const virtRef = useRef<VirtualizerHandle | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const leadingSpacerRef = useRef<HTMLDivElement | null>(null);
  const shouldStickRef = useRef(true);
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const [atBottom, setAtBottom] = useState(true);

  // The header-clearance spacer sits *before* the Virtualizer, so virtua needs
  // its height as ``startMargin`` to map scroll offsets correctly — without it
  // virtua's scroll extent is short by exactly the spacer height and pinning to
  // the bottom lands that-much above the true bottom (the newest message rests
  // behind the composer, "opens a bit too low"). Measured (not just
  // ``topPaddingPx``) so the ``--safe-top`` notch inset is included, and
  // re-measured if the safe area changes (rotation).
  const [startMarginPx, setStartMarginPx] = useState(topPaddingPx);
  useLayoutEffect(() => {
    const el = leadingSpacerRef.current;
    if (!el) return;
    const measure = () => { setStartMarginPx(el.offsetHeight); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => { ro.disconnect(); };
  }, []);

  // Mirror of rows.length, read inside the content ResizeObserver (which
  // mounts once) so it always sees the current count without re-subscribing.
  const rowCountRef = useRef(rows.length);
  rowCountRef.current = rows.length;

  /** Scroll the newest row to rest just above the composer. The composer is an
   *  ``absolute`` sibling overlaying the bottom of the scroll area; a trailing
   *  spacer row of ``composerHeightPx`` (the final virtualized child) reserves
   *  the matching space *inside* the scrollable content. Pinning targets that
   *  spacer -- index ``rowCountRef.current``, one past the last real row -- so
   *  ``align:"end"`` lands the spacer's bottom at the viewport bottom and the
   *  last real message rests just above the composer. Holding the reservation
   *  as a real item (rather than the scroller's ``padding-bottom``) keeps
   *  virtua's measured viewport at full height -- see the JSX note below for
   *  why that matters. Identical on mobile and desktop (both inner-scroll now). */
  const pinToBottom = useCallback((smooth = false) => {
    const n = rowCountRef.current;
    if (n === 0) return;
    virtRef.current?.scrollToIndex(n, { align: "end", smooth });
  }, []);

  /** Read the scroller's offset + distance-from-bottom from the Virtualizer
   *  handle's cached metrics (no reflow). ``distFromBottom`` is 0 exactly when
   *  pinned (the reserved bottom padding makes ``maxScroll`` coincide). */
  const readMetrics = useCallback((): { offset: number; distFromBottom: number } => {
    const handle = virtRef.current;
    if (!handle) return { offset: 0, distFromBottom: Infinity };
    const offset = handle.scrollOffset;
    return { offset, distFromBottom: handle.scrollSize - handle.viewportSize - offset };
  }, []);

  // Stable callback for the at-bottom event surface. Re-fires only on
  // genuine transitions (not on every scroll tick) — the local ``atBottom``
  // state is the source of truth and ``onAtBottomChange`` fires from
  // ``useEffect`` keyed on it.
  useEffect(() => {
    onAtBottomChange?.(atBottom);
  }, [atBottom, onAtBottomChange]);

  // Channel switch: reset stick + jump-to-end on the next commit. The
  // jump runs after ``rows`` for the new channel have populated the
  // virtualizer (one frame max) so ``scrollToIndex`` lands at a real
  // offset rather than the unmeasured estimate.
  useLayoutEffect(() => {
    shouldStickRef.current = true;
    loadingOlderRef.current = false;
    loadingNewerRef.current = false;
    setAtBottom(true);
    // No imperative call here — the ``rows.length`` effect below picks
    // it up on the same render once the new channel's rows arrive.
  }, [channelKey]);

  // Stick-to-bottom. Re-runs whenever the *row count* changes (new
  // posts, history loads, optimistic inserts). Deliberately depends on
  // ``rows.length`` rather than the array reference — token-stream
  // updates that mutate a row in place but don't change the count
  // shouldn't trigger a forced scroll (the virtualizer's per-row
  // ResizeObserver handles the growing-row case via its internal
  // bookkeeping).
  //
  // Two passes: the immediate ``scrollToIndex`` uses virtua's *estimate*
  // for any just-mounted row (the optimistic send case — React has
  // committed the new row but virtua's ResizeObserver hasn't measured
  // it yet, so the row height is the rolling average of measured
  // siblings). The estimate is usually a few pixels short of the real
  // row, leaving the user 5-30px above the true bottom. A follow-up
  // ``requestAnimationFrame`` re-scrolls AFTER measurement settles,
  // landing at the exact bottom. Cheap — two scroll writes is a no-op
  // when the row was already correctly sized, and removes the "chat
  // scrolls up a bit on send, then snaps to bottom when you type"
  // glitch where the type-driven ``remeasureComposer`` was inadvertently
  // doing the correcting scroll.
  useEffect(() => {
    // Suppressed while anchored on a history window (``autoStickToBottom``
    // false) so loaded/incoming rows don't yank the reader off their spot.
    if (!autoStickToBottom) return;
    if (!shouldStickRef.current) return;
    if (rows.length === 0) return;
    pinToBottom();
    const raf = requestAnimationFrame(() => {
      // Re-check the latch — if the user scrolled away between the
      // initial scroll and this frame, don't yank them back.
      if (!shouldStickRef.current) return;
      pinToBottom();
    });
    return () => { cancelAnimationFrame(raf); };
  }, [rows.length, pinToBottom, autoStickToBottom]);

  // Follow content-height growth while pinned. The effect above only fires
  // on a *row-count* change, but the growths that matter most don't change
  // the count: a streaming reply filling in (same post_id, mutated in
  // place), a "generating" indicator swapped for the finished post, a
  // late-loading image, the reactions strip animating in. virtua doesn't
  // emit ``onScroll`` when content grows below a bottom-pinned viewport
  // (scrollTop is unchanged), so without this the new content grows *below
  // the fold* and the user is left stranded above the latest message —
  // problem: "chat isn't scrolled when the full reply lands". Observing the
  // content box and re-pinning on any growth covers every source with one
  // rule, replacing the old per-source re-pin callbacks.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    let raf: number | null = null;
    const ro = new ResizeObserver(() => {
      if (!autoStickToBottom || !shouldStickRef.current || rowCountRef.current === 0) return;
      if (raf !== null) return;  // coalesce a burst of resize ticks into one scroll
      raf = requestAnimationFrame(() => {
        raf = null;
        if (!shouldStickRef.current) return;
        pinToBottom();
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [pinToBottom, autoStickToBottom]);

  // Imperative API for the parent.
  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom: (behavior: "auto" | "smooth" = "auto") => {
        if (rows.length === 0) return;
        shouldStickRef.current = true;
        pinToBottom(behavior === "smooth");
      },
      scrollToIndex: (
        index: number,
        opts?: {
          align?: "start" | "center" | "end";
          behavior?: "auto" | "smooth";
        },
      ) => {
        if (index < 0 || index >= rows.length) return false;
        virtRef.current?.scrollToIndex(index, {
          align: opts?.align ?? "center",
          smooth: opts?.behavior === "smooth",
        });
        return true;
      },
      getIsAtBottom: () => shouldStickRef.current,
    }),
    [rows.length, pinToBottom],
  );

  // Re-pin to the newest message when the soft keyboard opens/closes. The
  // fixed-viewport shell is sized to ``--vvh`` (visualViewport.height); when the
  // keyboard opens, vv.height shrinks → the shell shrinks → this inner scroller
  // shrinks → visualViewport fires ``resize``, and the newest row must re-pin
  // above the composer in the now-shorter scroller. SINGLE owner of keyboard
  // re-pin (ChannelPage's composer-measure re-pin is gated to desktop). Only
  // re-pin when the user was already at the bottom; rAF-coalesced.
  //
  // No visualViewport ``scroll`` listener: pinToBottom scrolls an INNER element,
  // which does NOT emit a visualViewport ``scroll`` (only window/document scroll
  // does), so the old scroll⇄pin feedback loop is structurally impossible here.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let raf = 0;
    const onResize = () => {
      if (!autoStickToBottom || !shouldStickRef.current) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { pinToBottom(); });
    };
    vv.addEventListener("resize", onResize);
    return () => {
      vv.removeEventListener("resize", onResize);
      cancelAnimationFrame(raf);
    };
  }, [pinToBottom, autoStickToBottom]);

  const evaluateScroll = useCallback(() => {
    const { offset, distFromBottom } = readMetrics();
    const isAtBottom = distFromBottom < stickToBottomThresholdPx;
    // Ref before state so synchronous reads from the imperative
    // handle (``scrollToBottom``) see the latest value.
    shouldStickRef.current = isAtBottom;
    setAtBottom((prev) => (prev === isAtBottom ? prev : isAtBottom));

    if (
      hasMoreHistory &&
      !loadingOlderRef.current &&
      offset >= 0 &&
      offset < loadOlderThresholdPx
    ) {
      loadingOlderRef.current = true;
      // The parent's loader is expected to await a network round-trip
      // before commiting new rows; we clear the flag once the row
      // count actually grows (the ``rows`` effect below). If the
      // parent decides not to load (e.g. channel switched mid-flight),
      // the flag is reset on channel-change via the cleanup above.
      onLoadOlder();
    }

    // Scroll-down mirror: only live while anchored on a history window
    // (``hasMoreNewer``). On the live tail ``hasMoreNewer`` is false, so this
    // never competes with stick-to-bottom for the bottom edge.
    if (
      hasMoreNewer &&
      onLoadNewer &&
      !loadingNewerRef.current &&
      distFromBottom < loadNewerThresholdPx
    ) {
      // No ``>= 0`` floor: at the true bottom virtua's ``distFromBottom`` can
      // be a subpixel negative (the reserved composer spacer makes maxScroll
      // coincide), and "past the bottom" still means "load newer".
      loadingNewerRef.current = true;
      onLoadNewer();
    }
  }, [
    readMetrics,
    hasMoreHistory,
    loadOlderThresholdPx,
    onLoadOlder,
    stickToBottomThresholdPx,
    hasMoreNewer,
    onLoadNewer,
    loadNewerThresholdPx,
  ]);

  // virtua passes the scroll offset (ignored — we read metrics from the handle's
  // cached ``scrollSize``, no reflow), so this runs synchronously.
  const handleScroll = useCallback(() => {
    evaluateScroll();
  }, [evaluateScroll]);

  // Clear the load-older latch when the row count grows — that's the
  // signal the loader committed. ``hasMoreHistory`` flipping to false
  // also clears it so the threshold check stays consistent if the
  // history is fully drained mid-flight.
  const prevRowCountRef = useRef(rows.length);
  useEffect(() => {
    if (rows.length !== prevRowCountRef.current) {
      loadingOlderRef.current = false;
      loadingNewerRef.current = false;
      prevRowCountRef.current = rows.length;
    }
  }, [rows.length]);
  useEffect(() => {
    if (!hasMoreHistory) loadingOlderRef.current = false;
  }, [hasMoreHistory]);
  useEffect(() => {
    if (!hasMoreNewer) loadingNewerRef.current = false;
  }, [hasMoreNewer]);

  // Shared row children, plus a trailing composer-clearance spacer as the FINAL
  // virtualized row. Holding the composer reservation as a real virtua item
  // (instead of the scroll container's ``padding-bottom``) keeps virtua's
  // viewport -- which it measures from the scroll element's content box, with
  // padding excluded -- at full height. With the old ``padding-bottom`` the
  // viewport was inset by the composer height, so virtua unmounted rows at the
  // composer's *inner* edge while they were still visible through the glass.
  // ``scrollSize`` / at-bottom math stays self-consistent because the spacer is
  // a measured item, and appending it shifts no existing row indices (deep-link
  // jump, unread anchor, prepend-shift all index into ``rows`` only).
  const children = rows.map((row, idx) => (
    <div key={getRowKey(row, idx)}>{renderRow(row, idx)}</div>
  ));
  children.push(
    <div
      key="__composer_spacer__"
      aria-hidden
      style={{ height: `${String(composerHeightPx + COMPOSER_BREATHING_ROOM_PX)}px` }}
    />,
  );

  // The inner element owns the scroll on BOTH mobile and desktop. On mobile the
  // fixed-viewport shell (sized to --vvh) gives this scroller a bounded height,
  // so the document never scrolls; on desktop it's the content card.
  //
  // IMPORTANT: the header/composer clearance is reserved with in-flow spacers
  // (the leading spacer below + the trailing composer spacer row appended to
  // ``children``), NOT with ``padding`` on this scroll element. virtua measures
  // its viewport from this element's ResizeObserver ``contentRect`` -- the
  // *content box*, which excludes padding. Padding here therefore shrank
  // virtua's viewport to the region *between* the glass bars' inner edges, and
  // virtua trims its render window's trailing edge to that boundary while
  // scrolling -- so rows were unmounted while still half-visible through the
  // translucent header/composer (the flicker). With the clearance held in
  // content instead, the content box spans the full height, the trailing trim
  // lands off-screen, and rows stay mounted until genuinely out of view.
  return (
    <div
      ref={scrollRef}
      className="messages-scroll min-w-0 flex-1 overflow-x-hidden overflow-y-auto"
      style={{
        // Flex column so the inner ``flex-grow`` spacer can push the
        // virtualizer to the bottom when content is short. No padding -- see
        // the note above; clearance lives in the spacers below.
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div ref={contentRef} className="mx-auto w-full max-w-chat flex flex-1 flex-col">
        {/* Header clearance. A leading spacer (not the scroller's padding-top)
            keeps the first message below the glass header without insetting
            virtua's viewport. ``--safe-top`` adds notch/Dynamic-Island
            clearance under the mobile glass top bar (0 on desktop). virtua
            auto-accounts for leading space (just like the flex-grow below), so
            pinning math is unaffected. */}
        <div
          ref={leadingSpacerRef}
          aria-hidden
          className="shrink-0"
          style={{ height: `calc(${String(topPaddingPx)}px + var(--safe-top, 0px))` }}
        />
        {/* Bottom-align spacer for short channels. ``flex-grow`` claims
            all leftover space above the virtualizer so a fresh channel
            with three messages sits at the bottom of the viewport, not
            the top. With many messages the spacer is squashed to 0 and
            the virtualizer drives the layout. */}
        <div className="flex-grow" />
        <Virtualizer
          ref={virtRef}
          shift={prependShift}
          startMargin={startMarginPx}
          scrollRef={scrollRef}
          onScroll={handleScroll}
        >
          {children}
        </Virtualizer>
      </div>
    </div>
  );
}) as <T>(
  props: MessageListProps<T> & { ref?: React.Ref<MessageListHandle> },
) => React.ReactElement;
