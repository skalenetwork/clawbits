import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { Virtualizer, type VirtualizerHandle } from "virtua";

const TOP_SPACER_PX = 64;
const STICK_THRESHOLD_PX = 80;
const LOAD_THRESHOLD_PX = 200;

export interface MessageListHandle {
  scrollToBottom(smooth?: boolean): void;
  scrollToIndex(index: number, smooth: boolean): void;
  getIsAtBottom(): boolean;
}

const pinToBottom = (virt: RefObject<VirtualizerHandle | null>, rowCount: RefObject<number>, smooth = false) => {
  virt.current?.scrollToIndex(rowCount.current, { align: "end", smooth });
};

// Header and composer clearance live in spacer items, never scroller padding: virtua measures its
// viewport from the content box, so padding would unmount rows still visible through the glass bars.
export function MessageList<T>({
  ref,
  rows,
  getRowKey,
  renderRow,
  hasMoreOlder,
  onLoadOlder,
  hasMoreNewer,
  onLoadNewer,
  autoStickToBottom,
  onAtBottomChange,
}: {
  ref: Ref<MessageListHandle>;
  rows: readonly T[];
  getRowKey: (row: T) => string;
  renderRow: (row: T, index: number) => ReactNode;
  hasMoreOlder: boolean;
  onLoadOlder: () => void;
  hasMoreNewer: boolean;
  onLoadNewer: () => void;
  autoStickToBottom: boolean;
  onAtBottomChange: (atBottom: boolean) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtRef = useRef<VirtualizerHandle>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const leadingSpacerRef = useRef<HTMLDivElement>(null);
  const shouldStickRef = useRef(true);
  const rowCountRef = useRef(rows.length);
  const [atBottom, setAtBottom] = useState(true);
  const [startMarginPx, setStartMarginPx] = useState(TOP_SPACER_PX);

  useLayoutEffect(() => {
    rowCountRef.current = rows.length;
  });

  useLayoutEffect(() => {
    const el = leadingSpacerRef.current;
    if (!el) return;
    const measure = () => { setStartMarginPx(el.offsetHeight); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => { ro.disconnect(); };
  }, []);

  const firstKey = getRowKey(rows[0]!);
  const lastKey = getRowKey(rows.at(-1)!);
  const [edges, setEdges] = useState({ firstKey, lastKey, shift: false });
  if (edges.firstKey !== firstKey || edges.lastKey !== lastKey) {
    setEdges({ firstKey, lastKey, shift: edges.lastKey === lastKey && edges.firstKey !== firstKey });
  }

  useEffect(() => {
    onAtBottomChange(atBottom);
  }, [atBottom, onAtBottomChange]);

  // Second pass after virtua measures a just-mounted row, whose first pin used an estimated height.
  useEffect(() => {
    if (!autoStickToBottom || !shouldStickRef.current) return;
    pinToBottom(virtRef, rowCountRef);
    const raf = requestAnimationFrame(() => { if (shouldStickRef.current) pinToBottom(virtRef, rowCountRef); });
    return () => { cancelAnimationFrame(raf); };
  }, [rows.length, autoStickToBottom]);

  // virtua emits no scroll when content grows below a pinned viewport, so follow growth directly.
  useEffect(() => {
    const el = contentRef.current;
    if (!el || !autoStickToBottom) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (!shouldStickRef.current || raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (shouldStickRef.current) pinToBottom(virtRef, rowCountRef);
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [autoStickToBottom]);

  // Sole owner of the soft-keyboard re-pin; ChannelPage's composer observer is desktop-only.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv || !autoStickToBottom) return;
    let raf = 0;
    const onResize = () => {
      if (!shouldStickRef.current) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { pinToBottom(virtRef, rowCountRef); });
    };
    vv.addEventListener("resize", onResize);
    return () => {
      vv.removeEventListener("resize", onResize);
      cancelAnimationFrame(raf);
    };
  }, [autoStickToBottom]);

  useImperativeHandle(ref, () => ({
    scrollToBottom: (smooth = false) => {
      shouldStickRef.current = true;
      pinToBottom(virtRef, rowCountRef, smooth);
    },
    scrollToIndex: (index, smooth) => {
      virtRef.current?.scrollToIndex(index, { align: "center", smooth });
    },
    getIsAtBottom: () => shouldStickRef.current,
  }), []);

  const onScroll = () => {
    const handle = virtRef.current;
    if (!handle) return;
    const offset = handle.scrollOffset;
    const distFromBottom = handle.scrollSize - handle.viewportSize - offset;
    shouldStickRef.current = distFromBottom < STICK_THRESHOLD_PX;
    setAtBottom(shouldStickRef.current);
    if (hasMoreOlder && offset >= 0 && offset < LOAD_THRESHOLD_PX) onLoadOlder();
    if (hasMoreNewer && distFromBottom < LOAD_THRESHOLD_PX) onLoadNewer();
  };

  return (
    <div ref={scrollRef} className="messages-scroll flex min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
      <div ref={contentRef} className="mx-auto w-full max-w-chat flex flex-1 flex-col">
        <div
          ref={leadingSpacerRef}
          aria-hidden
          className="shrink-0"
          style={{ height: `calc(${String(TOP_SPACER_PX)}px + var(--safe-top, 0px))` }}
        />
        <div className="flex-grow" />
        <Virtualizer
          ref={virtRef}
          shift={edges.shift}
          startMargin={startMarginPx}
          scrollRef={scrollRef}
          onScroll={onScroll}
        >
          {[
            ...rows.map((row, index) => <div key={getRowKey(row)}>{renderRow(row, index)}</div>),
            <div key="__composer_spacer__" aria-hidden style={{ height: "var(--composer-height, 112px)" }} />,
          ]}
        </Virtualizer>
      </div>
    </div>
  );
}
