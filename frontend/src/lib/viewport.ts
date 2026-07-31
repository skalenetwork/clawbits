/**
 * Viewport-class detection for the responsive app shell.
 *
 * The shell branches desktop vs mobile on ``useIsMobile()``. If that hook only
 * resolved in a useEffect (its old behavior), the first React paint on a phone
 * would render the DESKTOP shell, then swap — a guaranteed layout flash and a
 * double-mount of the heavy ChannelPage / query tree. To avoid that, we stamp
 * ``html[data-viewport]`` synchronously from main.tsx BEFORE React renders
 * (same discipline as ``setupDesktopAttributes`` for the Tauri platform), and
 * ``useIsMobile()`` seeds its initial state from that attribute.
 */

/** Tailwind ``md`` breakpoint — the desktop/mobile divide for the shell. */
export const MOBILE_BREAKPOINT = 768;

export type ViewportKind = "mobile" | "desktop";

export function currentViewport(): ViewportKind {
  if (typeof window === "undefined") return "desktop";
  return window.innerWidth < MOBILE_BREAKPOINT ? "mobile" : "desktop";
}

/**
 * Stamp ``html[data-viewport]`` now and keep it in sync on resize/orientation.
 * Call once from main.tsx before ``createRoot().render()`` so the very first
 * paint already knows whether to draw the mobile or desktop shell.
 *
 * The matchMedia listener lives for the app's lifetime (like the desktop
 * attribute setup), so there's nothing to tear down.
 */
export function setupViewportClass(): void {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const apply = (): void => {
    document.documentElement.dataset.viewport = currentViewport();
  };
  apply();
  const mql = window.matchMedia(
    `(max-width: ${String(MOBILE_BREAKPOINT - 1)}px)`,
  );
  // "change" is canonical; "resize" is a backup for environments that don't
  // reliably fire the MQL event (and covers in-place width changes).
  mql.addEventListener("change", apply);
  window.addEventListener("resize", apply);
}
