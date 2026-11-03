import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useSyncExternalStore } from "react";
import { widgetDismissedKey, widgetOpenKey, type WidgetStatus } from "@/lib/widgets";

/** What the chat's game bar remembers of a game on this phone: whether its player left it open, and whether its
 *  result was put away. A game starts folded and opens only at its player's tap. */
export interface GameBarState {
  open: boolean;
  dismissed: boolean;
}

const remembered = new Map<string, GameBarState>();
const loading = new Set<string>();
// The game a tap on its message put in a chat's bar, over the bar's own, until folded or put away.
const shown = new Map<string, string>();
// Each game's status as its bar last saw it, and the fold pending for one seen ending while open.
const statuses = new Map<string, WidgetStatus>();
const folds = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reads what this phone kept of a game's bar, once; a tap made meanwhile wins. */
export function loadGameBar(widgetId: string): void {
  if (remembered.has(widgetId) || loading.has(widgetId)) return;
  loading.add(widgetId);
  void AsyncStorage.multiGet([widgetOpenKey(widgetId), widgetDismissedKey(widgetId)])
    .then((pairs) => {
      const saved = new Map(pairs);
      return {
        open: saved.get(widgetOpenKey(widgetId)) === "1",
        dismissed: saved.get(widgetDismissedKey(widgetId)) === "1",
      };
    })
    .catch(() => ({ open: false, dismissed: false }))
    .then((state) => {
      loading.delete(widgetId);
      // A tap made while it loaded wins over what was kept.
      if (!remembered.has(widgetId)) remembered.set(widgetId, state);
      emit();
    });
}

function keep(key: string, on: boolean) {
  void (on ? AsyncStorage.setItem(key, "1") : AsyncStorage.removeItem(key)).catch(() => undefined);
}

// Any change to a game's bar calls off its pending fold: a tap after the end says how the player wants it.
function update(widgetId: string, change: Partial<GameBarState>) {
  clearTimeout(folds.get(widgetId));
  folds.delete(widgetId);
  remembered.set(widgetId, { open: false, dismissed: false, ...remembered.get(widgetId), ...change });
  emit();
  if (change.open !== undefined) keep(widgetOpenKey(widgetId), change.open);
  if (change.dismissed !== undefined) keep(widgetDismissedKey(widgetId), change.dismissed);
}

/** A game's bar as this phone left it, or null while that loads, so a result put away never flashes back. */
export function useGameBarState(widgetId: string): GameBarState | null {
  const watch = useCallback(
    (listener: () => void) => {
      const stop = subscribe(listener);
      loadGameBar(widgetId);
      return stop;
    },
    [widgetId],
  );
  return useSyncExternalStore(watch, () => gameBarState(widgetId));
}

export function gameBarState(widgetId: string): GameBarState | null {
  return remembered.get(widgetId) ?? null;
}

export function setGameOpen(widgetId: string, open: boolean): void {
  update(widgetId, { open });
}

/** How long a game seen ending while open keeps its result up before it folds to the bar, as on the web. */
export const RESULT_HOLD_MS = 6_000;

/** The bar saw a game at `status`: one seen ending while open keeps its result up a moment, then folds, so a
 *  finished board never stays over the chat. One first seen over stays as its player left it. */
export function seeGameStatus(widgetId: string, status: WidgetStatus): void {
  const before = statuses.get(widgetId);
  statuses.set(widgetId, status);
  if (before !== "active" || status === "active" || !remembered.get(widgetId)?.open || folds.has(widgetId)) return;
  folds.set(
    widgetId,
    setTimeout(() => {
      folds.delete(widgetId);
      update(widgetId, { open: false });
    }, RESULT_HOLD_MS),
  );
}

/** Puts a finished game's result away; its message still opens it. */
export function dismissGame(widgetId: string): void {
  update(widgetId, { dismissed: true });
}

/** A tap on a game's message: the game opens in its chat's bar, over the bar's own game, its result back if it was
 *  put away. */
export function showGame(channelId: string, widgetId: string): void {
  shown.set(channelId, widgetId);
  update(widgetId, { open: true, dismissed: false });
}

/** The game a tap put in this chat's bar, if any. */
export function useShownGame(channelId: string): string | null {
  return useSyncExternalStore(subscribe, () => shownGame(channelId));
}

export function shownGame(channelId: string): string | null {
  return shown.get(channelId) ?? null;
}

/** Gives the chat's bar back to its own game, unless the tapped one is `unless`. */
export function unshowGame(channelId: string, unless?: string): void {
  if (!shown.has(channelId) || shown.get(channelId) === unless) return;
  shown.delete(channelId);
  emit();
}
