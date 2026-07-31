import { useEffect, useRef } from "react";
import { Loading02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/Icon";

/**
 * Infinite-scroll sentinel + spinner for the attachment tabs. Auto-fetches
 * the next page when scrolled into view (IntersectionObserver), with a
 * tappable fallback so keyboard / reduced-motion users can still advance.
 * Renders nothing when there's no next page.
 */
export function AttachmentTabFooter({
  hasMore,
  loading,
  onLoadMore,
}: {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hasMore || loading) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onLoadMore();
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => { io.disconnect(); };
  }, [hasMore, loading, onLoadMore]);

  if (!hasMore && !loading) return null;

  return (
    <div ref={ref} className="flex justify-center py-4">
      {loading ? (
        <Icon icon={Loading02Icon} className="size-4 animate-spin text-muted-foreground" />
      ) : (
        <button
          type="button"
          onClick={onLoadMore}
          className="rounded-full bg-muted/50 px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Load more
        </button>
      )}
    </div>
  );
}
