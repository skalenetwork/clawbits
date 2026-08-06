import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { useLongPress } from "@/hooks/useLongPress";

interface ListRowProps {
  /** Leading visual — avatar, glyph, icon tile. */
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Right-aligned column — timestamp, badge, chevron. */
  trailing?: ReactNode;
  onClick?: () => void;
  /** Press-and-hold (touch only) — opens a context action sheet. Desktop
   *  pointers are ignored by the hook, so hover/click are untouched. */
  onLongPress?: () => void;
  /** Persistent selected state (e.g. the open conversation on tablet). */
  active?: boolean;
  /** Inset hairline separator at the bottom — starts after the leading slot
   *  (Telegram-style), so a run of rows reads as one grouped list. */
  divider?: boolean;
  className?: string;
}

/**
 * Dense, full-width list cell for mobile lists (conversations, agents,
 * members) — the iOS/Telegram-style row: leading avatar, a title over a
 * one-line subtitle, and a trailing meta column. Edge-to-edge and flush by
 * design (the list owns spacing), with a press state instead of hover so it
 * feels native on touch. The optional divider is inset to start after the
 * avatar column.
 */
export function ListRow({
  leading,
  title,
  subtitle,
  trailing,
  onClick,
  onLongPress,
  active,
  divider,
  className,
}: ListRowProps) {
  const interactive = Boolean(onClick);
  // Always attach the handlers (the hook is touch-only and a no-op without a
  // callback) so we don't conditionally call the hook.
  const longPress = useLongPress(onLongPress ?? (() => undefined));
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!interactive}
      {...longPress}
      className={cn(
        "flex w-full items-stretch gap-3 px-3 text-left transition",
        interactive && "active:bg-foreground/[0.05]",
        active && "bg-foreground/[0.06]",
        className,
      )}
    >
      {leading != null && (
        <div className="flex shrink-0 items-center py-2.5">{leading}</div>
      )}
      {/* The divider sits on the content+trailing wrapper, not the leading
          slot, so it's inset - it begins at the text and leaves the avatar
          column clear (Telegram style). */}
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center gap-3 py-2.5",
          divider && "border-b border-border/50",
        )}
      >
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
          <div className="min-w-0 truncate text-[15px] leading-tight text-foreground">
            {title}
          </div>
          {subtitle != null && (
            <div className="min-w-0 truncate text-[13px] leading-tight text-muted-foreground">
              {subtitle}
            </div>
          )}
        </div>
        {trailing != null && (
          <div className="flex shrink-0 flex-col items-end justify-center gap-1 text-[11px] leading-none">
            {trailing}
          </div>
        )}
      </div>
    </button>
  );
}
