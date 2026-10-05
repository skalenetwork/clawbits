/** The row at the list's reading line, fed by its scroll and read by the outline, so scrolling renders only the rail. */
export interface ViewRow {
  get: () => number;
  set: (index: number) => void;
  subscribe: (listener: () => void) => () => void;
}

export function viewRowStore(): ViewRow {
  let row = Number.POSITIVE_INFINITY;
  const listeners = new Set<() => void>();
  return {
    get: () => row,
    set: (next) => {
      if (next === row) return;
      row = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
