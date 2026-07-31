import { formatDayLabel } from "@/lib/formatting";

/** Pill-shaped horizontal rule above the first message of a new
 *  calendar day. Centered date label between two hairlines. */
export function DaySeparator({ date }: { date: string }) {
  return (
    <div className="mx-4 my-4 flex items-center gap-3">
      <div className="h-px flex-1 bg-border/60"/>
      <span className="text-[11px] font-medium tracking-wide text-muted-foreground">
        {formatDayLabel(date)}
      </span>
      <div className="h-px flex-1 bg-border/60"/>
    </div>
  );
}

/**
 * Shimmer skeleton row that mirrors the real message-row layout — same
 * outer margin, padding, avatar slot, and stacked content column — so
 * the swap to real content doesn't reflow when the request lands.
 *
 * The two body lines have deliberately uneven widths so a stack of
 * skeletons reads as varied content rather than a repeating bar. Each
 * line uses Tailwind's ``animate-pulse`` for a subtle opacity cycle;
 * we don't need a custom keyframe here.
 */
function MessageSkeletonRow({ lineWidths }: { lineWidths: [string, string] }) {
  return (
    <div
      aria-hidden="true"
      className="mx-0.5 mt-4 flex items-start gap-3 px-2 pt-1.5 pb-0.5"
    >
      <div className="size-10 shrink-0 animate-pulse rounded-full bg-muted/70"/>
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
        <div className="flex items-center gap-2">
          <span className="h-3 w-24 animate-pulse rounded-md bg-muted/70"/>
          <span className="h-2 w-10 animate-pulse rounded-md bg-muted/50"/>
        </div>
        <span className={`h-3 ${lineWidths[0]} animate-pulse rounded-md bg-muted/60`}/>
        <span className={`h-3 ${lineWidths[1]} animate-pulse rounded-md bg-muted/60`}/>
      </div>
    </div>
  );
}

/** Stack of ``count`` skeleton rows. Pre-baked width sequence keeps
 *  the visual rhythm stable across re-renders and biases toward a
 *  "looks like prose" cadence (alternating medium/long lines,
 *  occasionally short). */
export function MessageSkeletons({ count }: { count: number }) {
  const widths: readonly [string, string][] = [
    ["w-3/4", "w-1/2"],
    ["w-5/6", "w-2/3"],
    ["w-2/3", "w-1/3"],
    ["w-11/12", "w-3/5"],
    ["w-4/5", "w-2/5"],
  ];
  return (
    <div className="mx-auto w-full max-w-chat">
      {Array.from({ length: count }, (_, i) => {
        const w = widths[i % widths.length] ?? ["w-3/4", "w-1/2"];
        return <MessageSkeletonRow key={i} lineWidths={w} />;
      })}
    </div>
  );
}
