import { useSyncExternalStore } from "react";

/** How the chat's game panel shows a game on this device, as the player last left it: open, collapsed to its strip,
 *  or, once over, dismissed. A device's choice, per game: the other player's panel keeps theirs. */
export type WidgetView = "open" | "collapsed" | "dismissed";

const keyOf = (widgetId: string) => `fc_widget_view_${widgetId}`;
const listeners = new Set<() => void>();
// Held here too, so a choice lasts the session where storage is blocked.
const known = new Map<string, WidgetView | null>();

function stored(widgetId: string): WidgetView | null {
  try {
    const value = localStorage.getItem(keyOf(widgetId));
    return value === "open" || value === "collapsed" || value === "dismissed" ? value : null;
  } catch {
    return null;
  }
}

function read(widgetId: string): WidgetView | null {
  if (!known.has(widgetId)) known.set(widgetId, stored(widgetId));
  return known.get(widgetId) ?? null;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // Another tab's choice applies here as well.
  const onStorage = (event: StorageEvent) => {
    if (!event.key?.startsWith(keyOf(""))) return;
    known.delete(event.key.slice(keyOf("").length));
    onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function setWidgetView(widgetId: string, view: WidgetView): void {
  if (read(widgetId) === view) return;
  known.set(widgetId, view);
  try {
    localStorage.setItem(keyOf(widgetId), view);
  } catch {
    // Storage blocked: the choice holds until the page reloads.
  }
  for (const listener of listeners) listener();
}

/** The view this device chose for a game, or null where it chose none yet. */
export function useWidgetView(widgetId: string): WidgetView | null {
  return useSyncExternalStore(subscribe, () => read(widgetId), () => null);
}
