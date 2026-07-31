/**
 * Motion preferences. SSR-safe: every guard is checked before touching
 * ``window``, so this is callable from module scope and from render.
 */

/** True when the user has asked the OS to reduce motion. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
