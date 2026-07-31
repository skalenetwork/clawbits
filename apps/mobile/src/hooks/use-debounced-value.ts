import { useEffect, useState } from 'react';

/**
 * Returns `value` delayed by `delayMs`, resetting the timer on every change so
 * only the last value in a burst lands. Used to throttle the server message
 * search to one request per typing pause (web debounces 180ms). The setState
 * runs inside the timeout callback, not synchronously in the effect body, so it
 * doesn't trip the cascading-render lint rule.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}
