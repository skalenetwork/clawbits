import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

const LAYERS = 5;

/** A progressive blur: stacked backdrop blurs, each stronger and masked closer to `side`, so the blur ramps to the
 *  edge instead of stopping on a seam. `blur` is the strongest layer's radius. */
export function ProgressiveBlur({ className, side = "top", blur = 4, style }: {
  className?: string;
  side?: "top" | "bottom";
  blur?: number;
  style?: CSSProperties;
}) {
  const direction = side === "top" ? "to bottom" : "to top";
  return (
    <div aria-hidden className={className} style={style}>
      {Array.from({ length: LAYERS }, (_, i) => {
        const reach = 1 - i / LAYERS;
        const filter = `blur(${String(blur / 2 ** (LAYERS - 1 - i))}px)`;
        const mask = `linear-gradient(${direction}, #000 0%, #000 ${(reach * 50).toFixed(2)}%, transparent ${(reach * 100).toFixed(2)}%)`;
        return (
          <div
            key={i}
            className="absolute inset-0"
            style={{ backdropFilter: filter, WebkitBackdropFilter: filter, maskImage: mask, WebkitMaskImage: mask }}
          />
        );
      })}
    </div>
  );
}

const mix = (color: string, pct: number) => `color-mix(in oklab, var(--${color}) ${String(pct)}%, transparent)`;

const easedFade = (stop: (pct: number) => string, fade: string, side: "top" | "bottom") =>
  `linear-gradient(to ${side === "top" ? "bottom" : "top"}, ${stop(100)} calc(100% - ${fade}), ${stop(60)} calc(100% - ${fade} * 0.6), ${stop(25)} calc(100% - ${fade} * 0.3), ${stop(8)} calc(100% - ${fade} * 0.1), transparent)`;

/** A sidebar's scroller between its fixed header and footer. Content fades out at the edges: no tint can hide it
 *  over the macOS sidebar glass. */
export const SIDEBAR_SCROLL =
  "no-scrollbar min-h-0 flex-1 overflow-y-auto px-2 py-3 [mask-image:linear-gradient(to_bottom,transparent,#000_0.75rem,#000_calc(100%_-_0.75rem),transparent)]";

/** The tinted, blurred scrim behind sticky chrome. By default it blurs progressively and eases out 2rem past the
 *  chrome; `inset` keeps a uniform blur inside it, easing out over its last 0.75rem. */
export function Scrim({ color, side = "top", inset }: {
  color: "background" | "popover";
  side?: "top" | "bottom";
  inset?: boolean;
}) {
  if (inset) {
    const mask = easedFade((pct) => `rgb(0 0 0 / ${String(pct / 100)})`, "0.75rem", side);
    return (
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 backdrop-blur-md"
        style={{ background: mix(color, 80), maskImage: mask, WebkitMaskImage: mask }}
      />
    );
  }
  return (
    <ProgressiveBlur
      blur={8}
      side={side}
      className={cn(
        "pointer-events-none absolute inset-x-0 -z-10 h-[calc(100%+2rem)]",
        side === "top" ? "top-0" : "bottom-0",
      )}
      style={{ background: easedFade((pct) => mix(color, Math.round(0.85 * pct)), "2.5rem", side) }}
    />
  );
}
