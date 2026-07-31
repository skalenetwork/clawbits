import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "@/lib/motion";

// Smooth streaming cadence. Tuned for the "typewriter that never lies" feel:
// - MIN_CHARS_PER_FRAME is the floor when the model streams slowly — ~3
//   chars/frame ≈ 180 char/s at 60fps, brisk enough to never read as fake-slow
//   (the 2026 anti-pattern) yet smooth enough to mask 32ms coalescing bursts.
// - CATCHUP_FRAMES caps how long any backlog survives: a big flush (fast model
//   dumping a paragraph) drains within ~8 frames (~130ms) regardless of size,
//   so we track a fast model instead of throttling it.
const MIN_CHARS_PER_FRAME = 3;
const CATCHUP_FRAMES = 8;


/**
 * Meters `target` onto the screen a few characters per animation frame so a
 * bursty SSE stream reads as a smooth typewriter rather than landing in chunks.
 * Sits between the coalesced post cache (which delivers the full target text)
 * and the renderer, decoupling paint cadence from network arrival.
 *
 * Returns the visible prefix of `target`.
 *
 * Behaviour:
 * - **Adaptive catch-up** — never falls behind and never fake-throttles a fast
 *   model (see the constants above).
 * - **Meters growth only** — initialises to the current `target` length, so a
 *   virtualizer re-mount of an already-in-progress reply shows its text
 *   immediately and only animates *new* characters (no jarring replay).
 * - **Shows the full target immediately** when `streaming` is false (finalised)
 *   and under `prefers-reduced-motion`; snaps when `target` shrinks / is
 *   replaced out from under us.
 */
export function useSmoothedText(target: string, streaming: boolean): string {
  const [len, setLen] = useState<number>(target.length);
  // Source of truth for the metered length. Written only inside the effect and
  // its rAF callback — never during render — so a virtualizer re-mount resumes
  // from where the animation left off.
  const lenRef = useRef<number>(target.length);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const cancel = () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
    // Nothing to meter: finalised, reduced-motion, or already caught up (which
    // also covers a shrunk/replaced target). The render path below shows the
    // full target; just keep the ref within bounds.
    if (!streaming || prefersReducedMotion() || lenRef.current >= target.length) {
      cancel();
      if (lenRef.current > target.length) lenRef.current = target.length;
      return cancel;
    }
    const tick = () => {
      rafRef.current = null;
      const cur = lenRef.current;
      const backlog = target.length - cur;
      if (backlog <= 0) return;
      const step = Math.max(MIN_CHARS_PER_FRAME, Math.ceil(backlog / CATCHUP_FRAMES));
      const next = Math.min(target.length, cur + step);
      lenRef.current = next;
      setLen(next);
      if (next < target.length) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return cancel;
  }, [target, streaming]);

  if (!streaming || prefersReducedMotion()) return target;
  return len >= target.length ? target : target.slice(0, len);
}
