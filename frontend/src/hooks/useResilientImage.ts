import { useEffect, useState } from "react";

const resolved = new Map<string, string>();

const MAX_RETRIES = 4;
const BASE_DELAY_MS = 600;

/** A src only once a probe load succeeds, else null. A fresh agent's avatar can 404 at the edge for a beat, so
 *  failures retry with a cache-busting param and backoff; callers render their fallback meanwhile. */
export function useResilientImage(url: string | null | undefined): string | null {
  const key = url ?? "";
  const [state, setState] = useState(() => ({ key, src: resolved.get(key) ?? null }));
  if (state.key !== key) setState({ key, src: resolved.get(key) ?? null });

  useEffect(() => {
    if (!key || resolved.has(key)) return;
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const probe = () => {
      const candidate = attempt === 0 ? key : `${key}${key.includes("?") ? "&" : "?"}_r=${attempt}`;
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        resolved.set(key, candidate);
        setState((s) => (s.key === key ? { key, src: candidate } : s));
      };
      img.onerror = () => {
        if (cancelled) return;
        attempt += 1;
        if (attempt <= MAX_RETRIES) timer = setTimeout(probe, BASE_DELAY_MS * attempt);
      };
      img.src = candidate;
    };
    probe();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key]);

  return state.src;
}
