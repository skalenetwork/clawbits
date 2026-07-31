import { useEffect } from "react";

/**
 * Publishes the *visual* viewport height to CSS custom properties on <html>:
 *  - ``--vvh``: the visual-viewport height in px (the visible area, EXCLUDING the
 *    on-screen keyboard and any browser chrome). The mobile shell is sized to
 *    this (``height: var(--vvh)``), so when the keyboard opens (vv.height
 *    shrinks) the shell shrinks with it and the composer/nav stay above the
 *    keyboard — no per-element keyboard compensation needed.
 *  - ``--vv-offset-top``: raw ``visualViewport.offsetTop`` in px (0 when closed).
 *    The mobile shell's ``top`` is set to this so it follows the visual-viewport
 *    pan iOS applies when the keyboard opens (otherwise the fixed shell sits
 *    offsetTop px above the visible area).
 *
 * No-op-safe everywhere: where ``visualViewport`` is missing we fall back to
 * ``window.innerHeight``, and the CSS default (``--vvh: 100svh``) covers the
 * pre-hydration frame. On desktop nothing consumes these. Call once, high in the
 * tree (App).
 */
export function useViewportVars(): void {
  useEffect(() => {
    const root = document.documentElement;
    const vv = window.visualViewport;
    let raf = 0;

    const publish = (): void => {
      raf = 0;
      const height = vv ? vv.height : window.innerHeight;
      // Skip the frame if the API transiently reports a non-positive height
      // (some webviews before first layout, and the 0-height blip iOS can emit
      // mid keyboard-animation) — publishing 0 would collapse the shell.
      if (height <= 0) return;
      root.style.setProperty("--vvh", `${String(Math.round(height))}px`);
      // Treat a sub-2px offsetTop as 0: iOS can leave a 1px residual pan.
      const offsetTop = vv && vv.offsetTop >= 2 ? vv.offsetTop : 0;
      root.style.setProperty("--vv-offset-top", `${String(Math.round(offsetTop))}px`);
    };

    // Coalesce the burst of scroll+resize events iOS emits during the keyboard
    // animation and momentum scroll — setting CSS vars on every event janks.
    const schedule = (): void => {
      if (!raf) raf = requestAnimationFrame(publish);
    };

    publish();

    if (vv) {
      vv.addEventListener("resize", schedule);
      vv.addEventListener("scroll", schedule);
    }
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (vv) {
        vv.removeEventListener("resize", schedule);
        vv.removeEventListener("scroll", schedule);
      }
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
    };
  }, []);
}
