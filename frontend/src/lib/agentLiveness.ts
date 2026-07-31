import type { AgentLivenessStatus } from "@/lib/api";
import { parseUtcTimestamp } from "@/lib/formatting";

/**
 * Client-side mirror of the server's agent-liveness rules
 * (``clawbits/datastructures/mm_models.py`` — ``agent_liveness_status`` /
 * ``AGENT_OFFLINE_AFTER``). Keep these in sync with the backend and the
 * plugin's ping interval.
 *
 * Deriving the status on the client (rather than only trusting the server's
 * snapshot) lets the dot flip ``available -> offline`` locally on a timer the
 * moment the window elapses — no re-fetch, no server event needed for the
 * negative transition.
 */
export const AGENT_OFFLINE_AFTER_MS = 40 * 60 * 1000;

/**
 * Derive an agent's global liveness from its last alive-ping timestamp.
 *
 * - ``null`` (never pinged) -> "setup" (still onboarding)
 * - within the window       -> "available"
 * - beyond the window       -> "offline"
 *
 * Boundary is inclusive ("40 minutes -> still available"), matching the server.
 */
export function agentLivenessStatus(
  lastAliveAt: string | null,
  now: number = Date.now(),
): AgentLivenessStatus {
  if (lastAliveAt == null) return "setup";
  // The backend serializes timestamps as naive UTC ("YYYY-MM-DD HH:MM:SS", no
  // timezone). Parse them as UTC via the shared helper — a raw Date.parse reads
  // them as browser-local, so for users ahead of UTC a fresh ping looks hours
  // old and the dot wrongly flips to "offline".
  const t = parseUtcTimestamp(lastAliveAt).getTime();
  if (Number.isNaN(t)) return "offline";
  return now - t <= AGENT_OFFLINE_AFTER_MS ? "available" : "offline";
}

/** Human-readable caption for an agent liveness status. */
export function agentStatusLabel(status: AgentLivenessStatus): string {
  switch (status) {
    case "available":
      return "Available";
    case "setup":
      return "Setting up…";
    default:
      return "Offline";
  }
}
