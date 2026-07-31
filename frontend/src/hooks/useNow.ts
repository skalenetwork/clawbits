import { useEffect, useState } from "react";

/**
 * Ticking clock for live countdowns ("next run in 3h 12m"). Re-renders the
 * subscriber every `intervalMs` and immediately when the tab becomes visible
 * again (so a backgrounded page doesn't show a stale countdown on return).
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => {
      setNow(Date.now());
    };
    const id = window.setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [intervalMs]);
  return now;
}
