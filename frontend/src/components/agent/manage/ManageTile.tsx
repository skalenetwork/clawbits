/**
 * ManageTile — one flat management tile: tinted icon well · title + caption ·
 * trailing control. The well's tint is the tile's only decoration and
 * transitions with state (e.g. the snooze well turning amber) — no nested
 * cards, hierarchy comes from the type scale.
 */
import type { ReactNode } from "react";
import type { IconSvgElement } from "@hugeicons/react";
import { Icon } from "@/components/Icon";
import { cn } from "@/lib/utils";

export function ManageTile({
  icon,
  wellClassName,
  title,
  titleAdornment,
  caption,
  align = "center",
  control,
  className,
}: {
  icon: IconSvgElement;
  /** Overrides the muted default well tint — pass a dual-mode pair. */
  wellClassName?: string;
  title: string;
  /** Small inline element after the title (e.g. an info icon with a tooltip). */
  titleAdornment?: ReactNode;
  /** One short line (caller adds ``truncate``) or a small block. */
  caption?: ReactNode;
  /** ``center`` for one-line captions, ``start`` when the caption wraps. */
  align?: "center" | "start";
  /** Trailing control (Switch, Button, Stepper). */
  control?: ReactNode;
  className?: string;
}) {
  const start = align === "start";
  return (
    <div
      className={cn(
        "flex gap-3 rounded-xl border border-border/60 bg-card p-4",
        start ? "items-start" : "items-center",
        className,
      )}
    >
      <span
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-xl transition-colors duration-200",
          wellClassName ?? "bg-muted/60 text-muted-foreground",
        )}
      >
        <Icon icon={icon} className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <span className="truncate">{title}</span>
          {titleAdornment}
        </div>
        {caption != null && (
          <div className="text-caption text-muted-foreground">{caption}</div>
        )}
      </div>
      {control != null && (
        <div className={cn("flex shrink-0 items-center", start && "mt-1")}>{control}</div>
      )}
    </div>
  );
}
