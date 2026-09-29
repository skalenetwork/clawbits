import { useEffect } from "react";
import { useLatestRef } from "@/hooks/useLatestRef";
import { isDesktop, onEvent, type DesktopEvents } from "@/lib/desktop";

/** Runs the latest `handler` for an event from the Rust shell, over one subscription while mounted. */
export function useDesktopEvent<K extends keyof DesktopEvents>(name: K, handler: (payload: DesktopEvents[K]) => void): void {
  const latest = useLatestRef(handler);
  useEffect(() => {
    if (!isDesktop) return;
    const off = onEvent(name, (payload) => { latest.current(payload); });
    return () => { void off.then((unlisten) => { unlisten(); }); };
  }, [name, latest]);
}
