import { useEffect, useRef, type RefObject } from "react";

/**
 * A ref that always holds the latest ``value``, written after commit so
 * render itself stays pure (writing a ref during render is what makes the
 * React Compiler bail out of a component).
 *
 * For values a long-lived async handler needs to read — an SSE subscription,
 * a timer, a window listener — without becoming an effect dependency and
 * tearing the subscription down on every change.
 */
export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
