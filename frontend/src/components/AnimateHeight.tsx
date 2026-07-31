import { useLayoutEffect, useRef, type ReactNode } from "react";
import { prefersReducedMotion } from "@/lib/motion";


/**
 * Animates its own height whenever the content inside it changes size — the
 * "animate to height: auto" pattern done honestly. An inner wrapper is measured
 * with a ResizeObserver; on any height delta the outer box FLIPs from its
 * previous height to the new one, so content that appears, grows, shrinks, or
 * reflows resizes *gently* instead of jumping.
 *
 * Used to wrap the live agent-activity panel (the thinking status line + the
 * tool-timeline card) so every phase change — a gerund crossfading into
 * "Thinking…", the tool card unfolding in, a step settling — reads as one
 * smooth resize rather than a swap between differently-sized components.
 *
 * Notes:
 *  - The inner wrapper establishes a block formatting context (`flow-root`) so
 *    child vertical margins are contained and the measured height is exact
 *    (offsetHeight excludes margins that would otherwise collapse through).
 *  - `overflow: hidden` clips content to the animating box. Children that must
 *    escape (portaled menus, tooltips) already render into `document.body`.
 *  - No-op under `prefers-reduced-motion`: height stays `auto`, nothing animates.
 */
export function AnimateHeight({
  children,
  className,
  durationMs = 260,
  align = "top",
}: {
  children: ReactNode;
  className?: string;
  durationMs?: number;
  /** Which edge the content is pinned to while the box animates. ``"bottom"``
   *  keeps the last child visible and reveals new content from the top — right
   *  when something unfolds *above* a persistent line (the tool card growing in
   *  above the thinking status line), so that line never clips mid-grow. */
  align?: "top" | "bottom";
}) {
  const outerRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  // Last height the outer box was told to be. `null` until the first measure,
  // so the initial paint pins the natural height with no entrance animation.
  const prevRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;
    if (prefersReducedMotion()) {
      outer.style.height = "auto";
      return;
    }
    const easing = "cubic-bezier(0.16, 1, 0.3, 1)";
    const apply = (next: number) => {
      const prev = prevRef.current;
      prevRef.current = next;
      if (prev === null) {
        // First measure: pin the natural height, don't animate from 0.
        outer.style.height = `${String(next)}px`;
        return;
      }
      if (Math.abs(prev - next) < 0.5) return;
      // FLIP: snap to the old height, force a reflow, then transition to the new
      // one so the browser animates the delta.
      outer.style.transition = "none";
      outer.style.height = `${String(prev)}px`;
      void outer.offsetHeight;
      outer.style.transition = `height ${String(durationMs)}ms ${easing}`;
      outer.style.height = `${String(next)}px`;
    };
    apply(inner.offsetHeight);
    const ro = new ResizeObserver(() => { apply(inner.offsetHeight); });
    ro.observe(inner);
    return () => { ro.disconnect(); };
  }, [durationMs]);

  return (
    <div
      ref={outerRef}
      className={className}
      style={{
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        justifyContent: align === "bottom" ? "flex-end" : "flex-start",
      }}
    >
      {/* flow-root contains child margins for an exact measure; flex-shrink:0
          keeps the inner at its natural height so it overflows (and is clipped)
          rather than being squashed to the animating box height. */}
      <div ref={innerRef} style={{ display: "flow-root", flexShrink: 0 }}>
        {children}
      </div>
    </div>
  );
}
