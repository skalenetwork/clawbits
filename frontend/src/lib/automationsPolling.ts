/**
 * Polling cadence for automation queries. There is no browser-facing live
 * event for automations (`automation.sync` targets the agent's WebSocket
 * only), so the honest ceiling is polling: a 30s baseline while the tab is
 * visible, tightened to 3s for ~45s after any write so the operator watches
 * `requested → applied` land. TanStack Query already pauses the interval in
 * background tabs (`refetchIntervalInBackground` defaults to false).
 */

const BASELINE_MS = 30_000;
const BURST_MS = 3_000;
const BURST_WINDOW_MS = 45_000;

let burstUntil = 0;

/** Call after any automation write (create/update/delete/run-now). */
export function bumpAutomationsBurst(): void {
  burstUntil = Date.now() + BURST_WINDOW_MS;
}

/** Pass as `refetchInterval` — re-evaluated by TanStack Query on every tick. */
export function automationsRefetchInterval(): number {
  return Date.now() < burstUntil ? BURST_MS : BASELINE_MS;
}
