/**
 * InboxList — the message column: filter chips (All / Unread, server-side
 * filter), sticky date-bucket headers, rich rows, an infinite-scroll sentinel
 * with a "Load more" fallback, and a floating "N new" pill when a poll lands
 * fresh mail while the reader is scrolled down. The parent owns the scroll
 * container (marked ``data-inbox-scroll`` on desktop; the shell's <main> on
 * mobile).
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ArrowUp01Icon, InboxCheckIcon, Mail01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/Icon";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { errMsg } from "@/lib/toast";
import type { EmailSummary } from "@/lib/api";
import { cn } from "@/lib/utils";
import { dayBucket, type DayBucket } from "./emailDisplay";
import { InboxRow } from "./InboxRow";
import { MAX_LIMIT } from "./useInbox";

const EMPTY_UID_SET: ReadonlySet<number> = new Set();

/** Pair each email with the bucket header it introduces (emails arrive
 *  newest-first, so buckets are contiguous runs). Pure — keeps the render
 *  body free of cross-iteration mutation. */
function withBucketHeaders(
  emails: EmailSummary[],
  now: number,
): { email: EmailSummary; header: DayBucket | null }[] {
  let last: DayBucket | null = null;
  return emails.map((email) => {
    const bucket: DayBucket = email.date ? dayBucket(email.date, now) : "Earlier";
    const header = bucket !== last ? bucket : null;
    last = bucket;
    return { email, header };
  });
}

function FilterTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        // z-[1]: labels read above the sliding pill.
        "relative z-[1] flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1 text-sm transition-colors",
        "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30",
        active ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/**
 * FilterTabs — the All/Unread segmented control with a sliding active pill
 * (transitions.dev "tabs sliding": JS writes the active tab's measured
 * offset/width onto the pill, CSS owns the tween). First paint and resizes
 * position the pill without a transition so it never animates in from zero;
 * reduced motion drops the tween entirely.
 */
function FilterTabs({
  unreadOnly,
  onUnreadOnlyChange,
  allCount,
  unreadCount,
}: {
  unreadOnly: boolean;
  onUnreadOnlyChange: (v: boolean) => void;
  allCount: number;
  unreadCount: number;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const painted = useRef(false);

  const positionPill = useCallback((animate: boolean) => {
    const pill = pillRef.current;
    const tab = trackRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!pill || !tab) return;
    if (!animate) {
      const prev = pill.style.transition;
      pill.style.transition = "none";
      pill.style.transform = `translateX(${String(tab.offsetLeft)}px)`;
      pill.style.width = `${String(tab.offsetWidth)}px`;
      void pill.offsetWidth; // flush so the restored transition can't tween the snap
      pill.style.transition = prev;
    } else {
      pill.style.transform = `translateX(${String(tab.offsetLeft)}px)`;
      pill.style.width = `${String(tab.offsetWidth)}px`;
    }
  }, []);

  // Slide on selection change; snap on first paint.
  useLayoutEffect(() => {
    const animate = painted.current;
    painted.current = true;
    positionPill(animate);
  }, [unreadOnly, positionPill]);

  // Snap (never slide) when the column resizes.
  useEffect(() => {
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      positionPill(false);
    });
    observer.observe(track);
    return () => {
      observer.disconnect();
    };
  }, [positionPill]);

  return (
    <div
      ref={trackRef}
      role="tablist"
      aria-label="Filter messages"
      className="relative flex items-center rounded-lg bg-muted/50 p-0.5"
    >
      <span
        ref={pillRef}
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0.5 left-0 w-0 rounded-md bg-card shadow-xs",
          "transition-[transform,width] duration-[250ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
          "motion-reduce:transition-none",
        )}
      />
      <FilterTab active={!unreadOnly} onClick={() => { onUnreadOnlyChange(false); }}>
        All
        <span className="text-caption tabular-nums opacity-70">{allCount}</span>
      </FilterTab>
      <FilterTab active={unreadOnly} onClick={() => { onUnreadOnlyChange(true); }}>
        Unread
        <span className="text-caption tabular-nums opacity-70">{unreadCount}</span>
      </FilterTab>
    </div>
  );
}

function RowSkeleton() {
  return (
    <li className="flex items-start gap-3 rounded-xl px-3 py-2.5">
      <Skeleton className="size-10 shrink-0 rounded-full" />
      <div className="flex-1 space-y-1.5 pt-0.5">
        <div className="flex items-center justify-between gap-2">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3 w-8" />
        </div>
        <Skeleton className="h-3.5 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </li>
  );
}

export function InboxList({
  emails,
  totalForView,
  isLoading,
  isError,
  error,
  isPlaceholder,
  unreadOnly,
  onUnreadOnlyChange,
  allCount,
  unreadCount,
  selectedUid,
  onOpen,
  onToggleRead,
  onDelete,
  onLoadMore,
  now,
}: {
  emails: EmailSummary[];
  /** ``total`` of the current view (mailbox total, or unseen count when filtered). */
  totalForView: number;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  /** True while a bigger page (or the other filter) is being fetched. */
  isPlaceholder: boolean;
  unreadOnly: boolean;
  onUnreadOnlyChange: (v: boolean) => void;
  allCount: number;
  unreadCount: number;
  selectedUid: number | null;
  onOpen: (uid: number, sourceEl: HTMLElement | null) => void;
  onToggleRead: (uid: number, read: boolean) => void;
  onDelete: (uid: number) => void;
  onLoadMore: () => void;
  now: number;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLLIElement>(null);

  const getScroller = useCallback((): HTMLElement | null => {
    const root = rootRef.current;
    if (!root) return null;
    return root.closest<HTMLElement>("[data-inbox-scroll]") ?? root.closest("main");
  }, []);

  // ── New-mail pill ─────────────────────────────────────────────────────────
  // Track the newest uid we've acknowledged; when a poll brings younger mail
  // while the reader is scrolled down, float the pill instead of yanking the
  // list. Fresh rows (uids above the previous watermark) also enter with the
  // settle animation. Detection runs on a short timer — it reads layout
  // (scrollTop), keeps setState out of synchronous effect bodies, and (unlike
  // rAF) still fires in background tabs, so mail that lands while hidden is
  // acknowledged with the tab's state instead of piling up unprocessed.
  const ackTopUid = useRef<number | null>(null);
  const ackedFilter = useRef(unreadOnly);
  const [newCount, setNewCount] = useState(0);
  const [entered, setEntered] = useState<ReadonlySet<number>>(EMPTY_UID_SET);
  const topUid = emails[0]?.uid ?? null;

  useEffect(() => {
    const id = window.setTimeout(() => {
      // A filter flip restarts the watermark — the view changed, nothing "arrived".
      if (ackedFilter.current !== unreadOnly) {
        ackedFilter.current = unreadOnly;
        ackTopUid.current = topUid;
        setNewCount(0);
        setEntered(EMPTY_UID_SET);
        return;
      }
      if (topUid == null) return;
      const prev = ackTopUid.current;
      if (prev == null) {
        ackTopUid.current = topUid;
        return;
      }
      if (topUid <= prev) return;
      const fresh = emails.filter((e) => e.uid > prev).map((e) => e.uid);
      // The entrance class is one-shot: drop the marks once painted.
      setEntered(new Set(fresh));
      window.setTimeout(() => {
        setEntered(EMPTY_UID_SET);
      }, 700);
      if ((getScroller()?.scrollTop ?? 0) > 150) {
        setNewCount(fresh.length);
      } else {
        ackTopUid.current = topUid;
      }
    }, 50);
    return () => {
      window.clearTimeout(id);
    };
  }, [topUid, unreadOnly, emails, getScroller]);

  const jumpToNew = () => {
    getScroller()?.scrollTo({ top: 0, behavior: "smooth" });
    ackTopUid.current = topUid;
    setNewCount(0);
  };

  // Scrolling back to the top acknowledges the new mail without the pill.
  useEffect(() => {
    if (newCount === 0) return;
    const scroller = getScroller();
    if (!scroller) return;
    const onScroll = () => {
      if (scroller.scrollTop <= 10) {
        ackTopUid.current = topUid;
        setNewCount(0);
      }
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [newCount, topUid, getScroller]);

  // ── Infinite scroll ───────────────────────────────────────────────────────
  const canLoadMore = totalForView > emails.length && emails.length < MAX_LIMIT;
  const atCap = totalForView > emails.length && emails.length >= MAX_LIMIT;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !canLoadMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !isPlaceholder) onLoadMore();
      },
      { root: getScroller(), rootMargin: "240px" },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [canLoadMore, isPlaceholder, onLoadMore, getScroller]);

  // ── Roving arrow-key navigation (local — arrows must not be global) ──────
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const rows = Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>("[data-inbox-row]") ?? [],
    );
    if (rows.length === 0) return;
    const activeIndex = rows.findIndex((r) => r === document.activeElement);
    let next: number;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = rows.length - 1;
    else if (activeIndex === -1) next = 0;
    else if (e.key === "ArrowDown") next = Math.min(rows.length - 1, activeIndex + 1);
    else next = Math.max(0, activeIndex - 1);
    rows[next]?.focus();
    rows[next]?.scrollIntoView({ block: "nearest" });
    e.preventDefault();
  };

  // ── Render ────────────────────────────────────────────────────────────────
  const tabStopUid = selectedUid ?? emails[0]?.uid ?? null;
  const items = withBucketHeaders(emails, now);

  return (
    <div ref={rootRef} className="relative flex min-h-0 flex-col" onKeyDown={onKeyDown}>
      {/* Filter tabs — a sliding segmented control; counts are the honest
          mailbox counts, not page sizes. */}
      <div className="px-3 pb-1 pt-3">
        <FilterTabs
          unreadOnly={unreadOnly}
          onUnreadOnlyChange={onUnreadOnlyChange}
          allCount={allCount}
          unreadCount={unreadCount}
        />
      </div>

      {/* Floating new-mail pill. */}
      {newCount > 0 && (
        <div className="pointer-events-none absolute inset-x-0 top-12 z-20 flex justify-center">
          <button
            type="button"
            onClick={jumpToNew}
            className={cn(
              "pointer-events-auto flex items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5",
              "text-xs font-medium text-background shadow-md transition-transform hover:scale-[1.03]",
              "animate-in fade-in slide-in-from-top-2 duration-300 motion-reduce:animate-none",
            )}
          >
            <Icon icon={ArrowUp01Icon} className="size-3.5" />
            {newCount} new
          </button>
        </div>
      )}

      {isLoading && (
        <ul className="space-y-0.5 px-1">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <RowSkeleton key={i} />
          ))}
        </ul>
      )}

      {isError && (
        <div className="px-4 py-8 text-sm text-muted-foreground">
          {errMsg(error, "Couldn't load the inbox")}
        </div>
      )}

      {!isLoading && !isError && emails.length === 0 && (
        unreadOnly ? (
          <EmptyState
            icon={InboxCheckIcon}
            title="All caught up"
            description="No unread mail."
            className="py-12"
          />
        ) : (
          <EmptyState
            icon={Mail01Icon}
            title="No mail yet"
            description="Messages this agent receives will show up here."
            className="py-12"
          />
        )
      )}

      {emails.length > 0 && (
        <ul className="space-y-0.5 px-1 pb-4">
          {items.map(({ email, header }) => (
            <Fragment key={email.uid}>
              {header != null && (
                <li className="sticky top-0 z-10 -mx-1 bg-panel/90 px-4 pb-1 pt-2.5 backdrop-blur-sm">
                  <span className="text-caption font-medium text-muted-foreground">
                    {header}
                  </span>
                </li>
              )}
              <InboxRow
                email={email}
                selected={email.uid === selectedUid}
                tabbable={email.uid === tabStopUid}
                entered={entered.has(email.uid)}
                onOpen={onOpen}
                onToggleRead={onToggleRead}
                onDelete={onDelete}
              />
            </Fragment>
          ))}
          {canLoadMore && (
            <li ref={sentinelRef} className="flex justify-center pt-3">
              <Button variant="outline" size="sm" disabled={isPlaceholder} onClick={onLoadMore}>
                {isPlaceholder ? "Loading…" : "Load more"}
              </Button>
            </li>
          )}
          {atCap && (
            <li className="px-4 pt-3 text-center text-label text-muted-foreground/70">
              Showing the newest {MAX_LIMIT} messages.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
