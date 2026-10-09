import { useSyncExternalStore } from "react";

/** How chess boards draw their pieces on this device: the sea set by default, or the classic shapes. A device's
 *  choice, like the theme: the other player's board keeps theirs. */
export type PieceSet = "sea" | "classic";

const STORAGE_KEY = "fc_chess_pieces";
const listeners = new Set<() => void>();
// Held here too, so a choice lasts the session where storage is blocked.
let current: PieceSet | undefined;

function stored(): PieceSet {
  try {
    return localStorage.getItem(STORAGE_KEY) === "classic" ? "classic" : "sea";
  } catch {
    return "sea";
  }
}

function read(): PieceSet {
  return (current ??= stored());
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // Another tab's choice applies here as well.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    current = stored();
    onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function setPieceSet(next: PieceSet): void {
  current = next;
  try {
    if (next === "sea") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Storage blocked: the choice holds until the page reloads.
  }
  for (const listener of listeners) listener();
}

export function usePieceSet(): PieceSet {
  return useSyncExternalStore(subscribe, read, () => "sea");
}
