/**
 * useResilientImage — probe an avatar URL and only hand back a src once a load
 * actually succeeds, so an SVG `<image>` never renders the browser's broken-
 * image glyph for an object that isn't in R2 yet.
 *
 * A freshly-signed-up agent can be visible to the org avatar poll a beat
 * before its generated SVG finishes uploading, and Cloudflare may cache the
 * interim 404 on the bare key. On error we retry with a cache-busting query
 * param + backoff — each attempt is a fresh edge-cache key — so the card
 * self-heals to the real avatar within a second or two. Returns null while
 * probing or after giving up; callers render their initial-letter fallback.
 *
 * The card's `<image>` can't do this itself: unlike an HTML `<img>` it has no
 * usable onError path across browsers, and a failed SVG image paints the OS
 * broken-image icon. Probing with `new Image()` sidesteps both.
 */
import { useEffect, useState } from "react";

// Bare URL → the URL variant confirmed to load this session. Usually the bare
// URL itself; in the signup race it may be a cache-busted variant that dodged
// a Cloudflare-cached 404. Lets a revisited card paint without re-probing (and
// without flashing the letter fallback again).
const resolved = new Map<string, string>();

const MAX_RETRIES = 4;
const BASE_DELAY_MS = 600;

export function useResilientImage(url: string | null | undefined): string | null {
  const key = url ?? "";
  const [state, setState] = useState<{ key: string; src: string | null }>(() => ({
    key,
    src: key ? (resolved.get(key) ?? null) : null,
  }));
  // Adjust on url change (render-phase, React's "derive state from props"
  // idiom) so a new card never briefly shows the previous agent's avatar.
  if (state.key !== key) {
    setState({ key, src: key ? (resolved.get(key) ?? null) : null });
  }

  useEffect(() => {
    if (!key || resolved.has(key)) return;
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const probe = () => {
      const candidate =
        attempt === 0 ? key : `${key}${key.includes("?") ? "&" : "?"}_r=${String(attempt)}`;
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        resolved.set(key, candidate);
        setState((s) => (s.key === key ? { key, src: candidate } : s));
      };
      img.onerror = () => {
        if (cancelled) return;
        attempt += 1;
        if (attempt > MAX_RETRIES) return; // give up → stays null → letter fallback
        timer = setTimeout(probe, BASE_DELAY_MS * attempt);
      };
      img.src = candidate;
    };
    probe();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [key]);

  return state.src;
}
