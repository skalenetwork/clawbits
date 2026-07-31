interface UnreadDividerProps {
  count: number;
}

/**
 * Horizontal divider rendered between the last read post and the first
 * unread post on a channel. Anchored at channel-enter time and frozen
 * thereafter — new posts that arrive while the user is in the channel
 * appear below the divider, so it serves as a "you were here last"
 * landmark.
 */
export function UnreadDivider({ count }: UnreadDividerProps) {
  if (count <= 0) return null;
  return (
    <div
      role="separator"
      aria-label={`${count} unread message${count === 1 ? "" : "s"}`}
      className="my-4 flex items-center gap-3 px-4 select-none"
    >
      <div className="h-px flex-1 bg-destructive/40" />
      <span className="rounded-full bg-destructive/15 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-destructive">
        {count} new
      </span>
      <div className="h-px flex-1 bg-destructive/40" />
    </div>
  );
}
