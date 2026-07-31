import { useSyncExternalStore } from "react";

/** Chat "bubble mode" — when on, the message timeline renders iMessage/Telegram
 *  style speech bubbles (own messages right-aligned + accent, others left);
 *  when off, the classic avatar + author-row layout. Enabled by default.
 *
 *  Persisted to localStorage under ``fc_bubble_mode`` (``fc_`` prefix matches
 *  {@link useTheme}). Exposed as a tiny external store rather than a context so
 *  any component in the tree — including the deep, un-memoized message rows —
 *  can read it and re-render on toggle without threading a provider or props. */

const STORAGE_KEY = "fc_bubble_mode";

function read(): boolean {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    // Absent → enabled by default. Only an explicit "0" turns it off.
    return v === null ? true : v !== "0";
  } catch {
    return true;
  }
}

let current = read();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

// Cross-tab sync: mirror a change made in another tab into this one.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) {
      current = read();
      emit();
    }
  });
}

export function setBubbleMode(next: boolean): void {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  } catch {
    /* ignore — private mode etc.; the in-memory value still updates */
  }
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Reactive read of the current bubble-mode preference. */
export function useBubbleMode(): boolean {
  return useSyncExternalStore(subscribe, () => current, () => true);
}
