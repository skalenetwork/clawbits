import { useLayoutEffect, useRef, type ReactNode } from "react";
import { prefersReducedMotion } from "@/lib/motion";


/**
 * Smooths the streaming → published handoff of an agent reply. While the post
 * streams this is an inert passthrough; the instant it finalises (``isStreaming``
 * flips false) it plays a ONE-SHOT settle:
 *
 *  - the container **height morphs** from the last streaming height to the
 *    finished height, so the tool-timeline card collapsing away, the caret
 *    leaving, and any final reflow resize *gently* instead of snapping;
 *  - the finished body **fades in** over it, masking the inline markdown /
 *    code-highlight lighting up as StreamingMarkdown gives way to the final
 *    MessageMarkdown.
 *
 * No-op for historical rows (mounted already published — no streaming→published
 * edge is ever seen) and under ``prefers-reduced-motion``.
 */
export function SettleBody({
  isStreaming,
  children,
}: {
  isStreaming: boolean;
  children: ReactNode;
}) {
  const outerRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const streamingRef = useRef(isStreaming);
  // Last height observed while streaming — the FLIP's "from". Gated on
  // streamingRef so the finalize resize itself is never recorded as the "from".
  const lastStreamHeightRef = useRef<number | null>(null);
  const flippedRef = useRef(false);

  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    if (streamingRef.current) lastStreamHeightRef.current = inner.offsetHeight;
    const ro = new ResizeObserver(() => {
      if (streamingRef.current) lastStreamHeightRef.current = inner.offsetHeight;
    });
    ro.observe(inner);
    return () => { ro.disconnect(); };
  }, []);

  // Edge detection + the one-shot settle. Runs every render, but bails
  // immediately unless this is the single streaming→published transition, so
  // it's a cheap ref compare for historical rows and mid-stream frames alike.
  useLayoutEffect(() => {
    const wasStreaming = streamingRef.current;
    streamingRef.current = isStreaming;
    if (!(wasStreaming && !isStreaming) || flippedRef.current) return;
    flippedRef.current = true;
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;
    if (prefersReducedMotion()) return;

    // Fade the finished body in. Added synchronously (before paint) with a
    // ``backwards`` fill so there's no full-opacity flash before the fade.
    inner.classList.add("animate-settle-fade");
    const onFadeEnd = () => {
      inner.classList.remove("animate-settle-fade");
      inner.removeEventListener("animationend", onFadeEnd);
    };
    inner.addEventListener("animationend", onFadeEnd);

    const prev = lastStreamHeightRef.current;
    const next = inner.offsetHeight;
    if (prev === null || Math.abs(prev - next) < 1) return;
    // FLIP: pin the old height, force a reflow, transition to the new one.
    outer.style.overflow = "hidden";
    outer.style.transition = "none";
    outer.style.height = `${String(prev)}px`;
    void outer.offsetHeight;
    outer.style.transition = "height 300ms cubic-bezier(0.16, 1, 0.3, 1)";
    outer.style.height = `${String(next)}px`;
    const onHeightEnd = () => {
      outer.style.transition = "";
      outer.style.height = "";
      outer.style.overflow = "";
      outer.removeEventListener("transitionend", onHeightEnd);
    };
    outer.addEventListener("transitionend", onHeightEnd);
  });

  return (
    <div ref={outerRef}>
      <div ref={innerRef}>{children}</div>
    </div>
  );
}
