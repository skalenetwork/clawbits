/**
 * GlassSticker — a chip placed as an HTML overlay on the SVG card. Two forms:
 *   • pill: a frosted (translucent, backdrop-blurred) single-line chip with an
 *     optional small leading icon, auto-sized to its text.
 *   • multiline: a solid-white rounded card (e.g. a description snippet) that
 *     fills the width the card gives it and wraps to 3 lines.
 *
 * Two layers: an OUTER element owns the positioning (inline style), so the INNER
 * chip is free to run its own `active:scale` press-in when interactive (a single
 * element can't hold both transforms).
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function GlassSticker({
  icon,
  text,
  textColor,
  multiline = false,
  onClick,
  title,
  style,
  positioned = true,
}: {
  /** Optional small leading icon (already colored). */
  icon?: ReactNode;
  /** The chip's text (date / email / "Reef" / description snippet). */
  text: string;
  /** Ink for the text. */
  textColor: string;
  /** Solid-white rounded card with a 3-line clamp instead of a single-line pill. */
  multiline?: boolean;
  onClick?: () => void;
  title?: string;
  /** Positioning supplied by the card. */
  style?: React.CSSProperties;
  /** When false, the chip is NOT absolutely positioned — it flows in its parent
   *  (e.g. an aligned flex rail). Defaults to true (absolute, placed via `style`). */
  positioned?: boolean;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <div className={cn(positioned && "absolute", "origin-center")} style={style}>
      <Tag
        type={onClick ? "button" : undefined}
        onClick={onClick}
        title={title}
        className={cn(
          // Sizes in cqw (% of the card container width) so the chip scales with
          // the card from thumbnail to hero.
          "overflow-hidden border shadow-[0_1px_6px_rgba(0,0,0,0.10)]",
          multiline
            ? // solid white card, fills its width, wraps to 3 lines
              "flex w-full items-start gap-[2.4cqw] rounded-[5.5cqw] border-black/[0.05] bg-white px-[5cqw] py-[3.4cqw]"
            : // solid-white single-line pill that HUGS its text (capped so it can't overrun)
              "inline-flex max-w-[86cqw] items-center gap-[2.6cqw] rounded-full border-black/[0.05] bg-white px-[4.6cqw] py-[2.7cqw]",
          onClick &&
            "pointer-events-auto cursor-pointer transition-transform duration-150 ease-out active:scale-[0.95]",
        )}
      >
        {icon && (
          <span
            className={cn(
              "grid shrink-0 place-items-center opacity-75",
              multiline ? "mt-[0.6cqw] size-[5cqw]" : "size-[5.2cqw]",
            )}
            style={{ color: textColor }}
            aria-hidden="true"
          >
            {icon}
          </span>
        )}
        <span
          className={cn(
            "min-w-0 font-rounded",
            multiline
              ? "line-clamp-3 w-full text-center text-[4.2cqw] font-medium leading-normal"
              : "truncate text-[4cqw] font-semibold leading-none tracking-tight",
          )}
          style={{ color: textColor }}
        >
          {text}
        </span>
      </Tag>
    </div>
  );
}
