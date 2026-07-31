import { useCallback, useSyncExternalStore } from "react";

import { draftStore, type MessageDraft } from "@/lib/messageDrafts";

const EMPTY: ReadonlyMap<string, MessageDraft> = new Map();

/**
 * Live map of ``channel_id → unsent draft`` for the signed-in user — feeds
 * the Telegram-style "Draft:" previews in the chat list. Updates arrive on
 * the store's debounced persist cycle (~400 ms), not per keystroke, so
 * subscribing components don't re-render on every character typed.
 */
export function useMessageDrafts(
  userId: number | null | undefined,
): ReadonlyMap<string, MessageDraft> {
  const getSnapshot = useCallback(
    () => (userId == null ? EMPTY : draftStore.getSnapshot(userId)),
    [userId],
  );
  return useSyncExternalStore(draftStore.subscribe, getSnapshot);
}
