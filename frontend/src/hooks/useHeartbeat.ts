import { useEffect, useRef } from "react";
import { sendGlobalPresenceHeartbeat, type GlobalUserStatus } from "@/lib/api";

// Cadence is tuned to the backend Redis TTLs:
//   - online TTL ~45s → heartbeat every 30s so we never expire under
//     normal jitter.
//   - idle  TTL ~300s → heartbeat every 60s (cheap; mostly to keep the
//     dot from flipping back to "offline" while the tab is hidden).
const ONLINE_HEARTBEAT_MS = 30_000;
const IDLE_HEARTBEAT_MS = 60_000;
// User activity quiescence threshold while the tab is visible.
const IDLE_AFTER_MS = 5 * 60_000;

/**
 * Drive the current user's global presence.
 *
 * Reports ``online`` while the tab is visible and the user has been
 * active within ``IDLE_AFTER_MS``; flips to ``idle`` after that
 * threshold or when the tab is hidden; fires ``offline`` on page
 * unload via ``navigator.sendBeacon`` (best-effort).
 *
 * Only one tab needs to be active for the user to count as online —
 * stale tabs that flip to idle won't override the fresh tab because
 * the backend honors last-writer-wins with TTLs (see decisions in
 * conversation history).
 */
export function useHeartbeat(enabled: boolean): void {
  const lastActivityRef = useRef<number>(0);
  const lastStatusRef = useRef<GlobalUserStatus | null>(null);
  const lastSentRef = useRef<number>(0);

  useEffect(() => {
    if (!enabled) return;

    const bumpActivity = () => {
      lastActivityRef.current = Date.now();
    };
    // Mounting counts as activity — the first tick must not read a zero.
    bumpActivity();
    window.addEventListener("pointermove", bumpActivity, { passive: true });
    window.addEventListener("keydown", bumpActivity, { passive: true });
    window.addEventListener("touchstart", bumpActivity, { passive: true });
    window.addEventListener("focus", bumpActivity);

    const computeStatus = (): GlobalUserStatus => {
      if (document.visibilityState !== "visible") return "idle";
      const sinceActivity = Date.now() - lastActivityRef.current;
      return sinceActivity > IDLE_AFTER_MS ? "idle" : "online";
    };

    const tick = (force = false) => {
      const status = computeStatus();
      const now = Date.now();
      const minInterval =
        status === "online" ? ONLINE_HEARTBEAT_MS : IDLE_HEARTBEAT_MS;
      const dueForRefresh = now - lastSentRef.current >= minInterval;
      const transitioned = lastStatusRef.current !== status;
      if (!force && !transitioned && !dueForRefresh) return;
      lastStatusRef.current = status;
      lastSentRef.current = now;
      void sendGlobalPresenceHeartbeat(status);
    };

    // Initial announce so the dot turns green right after sign-in.
    tick(true);
    const handle = window.setInterval(() => tick(false), ONLINE_HEARTBEAT_MS);

    const onVisibility = () => tick(true);
    document.addEventListener("visibilitychange", onVisibility);

    const onUnload = () => {
      // sendBeacon is the only thing that reliably ships during unload.
      // Falls back to keepalive fetch if Beacon isn't available.
      const payload = JSON.stringify({ status: "offline" });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(
          "/api/human/presence",
          new Blob([payload], { type: "application/json" }),
        );
      } else {
        void sendGlobalPresenceHeartbeat("offline", { keepalive: true });
      }
    };
    window.addEventListener("pagehide", onUnload);
    window.addEventListener("beforeunload", onUnload);

    return () => {
      window.removeEventListener("pointermove", bumpActivity);
      window.removeEventListener("keydown", bumpActivity);
      window.removeEventListener("touchstart", bumpActivity);
      window.removeEventListener("focus", bumpActivity);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onUnload);
      window.removeEventListener("beforeunload", onUnload);
      window.clearInterval(handle);
    };
  }, [enabled]);
}
