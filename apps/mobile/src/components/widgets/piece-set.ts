import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSyncExternalStore } from "react";

/** How chess boards draw their pieces on this phone: the sea set by default, or the classic one. A device's choice,
 *  switched from the game itself: the other player's board keeps theirs. */
export type PieceSet = "sea" | "classic";

const KEY = "clawbits.chess-pieces";
const listeners = new Set<() => void>();
let current: PieceSet = "sea";
let loading = false;
// A pick made before the saved one loads wins over it.
let picked = false;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!loading) {
    loading = true;
    void AsyncStorage.getItem(KEY)
      .then((saved) => {
        if (saved === "classic" && !picked) {
          current = "classic";
          emit();
        }
      })
      .catch(() => undefined);
  }
  return () => {
    listeners.delete(listener);
  };
}

export function setPieceSet(next: PieceSet): void {
  picked = true;
  current = next;
  emit();
  void AsyncStorage.setItem(KEY, next).catch(() => undefined);
}

export function usePieceSet(): PieceSet {
  return useSyncExternalStore(subscribe, () => current);
}
