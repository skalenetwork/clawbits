import { createContext, useContext } from "react";
import type { GlobalUserStatus } from "@/lib/api";

/**
 * Global presence for every human user this session has heard about.
 *
 * Keyed by ``human_id``. A missing entry means "unknown" — render as
 * offline. Updated by ``UserPresenceProvider`` from:
 *
 *   - the channel SSE stream (``user.status`` events fanned out to
 *     every channel the user is in),
 *   - the global per-user SSE stream (covers cross-tab consistency for
 *     the current viewer's own status), and
 *   - the member-list endpoint, which seeds entries from Redis on
 *     channel open.
 *
 * Local-stale fallback (UX corner case): when the last tab of a remote
 * user closes silently, no offline event fires. After ~60s with no
 * keep-alive the dot will still read online client-side. We accept
 * that for v1 — a follow-up can add a client-side stale-timer.
 */
export interface UserPresenceState {
  byHumanId: Map<number, GlobalUserStatus>;
  lastSeenByHumanId: Map<number, string | null>;
  /** Bucketed "Last seen recently" string for users who hid their
   *  precise last-seen via privacy settings. Null / absent when the
   *  raw timestamp in ``lastSeenByHumanId`` is the source of truth. */
  lastSeenLabelByHumanId: Map<number, string | null>;
}

export interface UserPresenceContextValue {
  state: UserPresenceState;
  /** Replace or insert an entry. Called by the SSE handler. */
  set: (
    humanId: number,
    status: GlobalUserStatus,
    lastSeenAt: string | null,
    lastSeenLabel?: string | null,
  ) => void;
  /** Bulk-seed from a member-list payload. */
  seed: (
    entries: Array<{
      humanId: number;
      status: GlobalUserStatus;
      lastSeenAt: string | null;
      lastSeenLabel?: string | null;
    }>,
  ) => void;
}

export const UserPresenceContext = createContext<UserPresenceContextValue | null>(null);

export function useUserPresence(): UserPresenceContextValue {
  const ctx = useContext(UserPresenceContext);
  if (!ctx) {
    throw new Error("useUserPresence must be used within a UserPresenceProvider");
  }
  return ctx;
}

/** Look up one user's status; returns "offline" when unknown. */
export function useUserStatus(humanId: number | null | undefined): GlobalUserStatus {
  const ctx = useContext(UserPresenceContext);
  if (!ctx || humanId == null) return "offline";
  return ctx.state.byHumanId.get(humanId) ?? "offline";
}

/** Look up one user's last_seen_at (ISO string or null). */
export function useUserLastSeen(humanId: number | null | undefined): string | null {
  const ctx = useContext(UserPresenceContext);
  if (!ctx || humanId == null) return null;
  return ctx.state.lastSeenByHumanId.get(humanId) ?? null;
}

/** Look up the bucketed "Last seen recently" string for users who hid
 *  their precise last-seen. Returns null when the precise timestamp is
 *  available via :func:`useUserLastSeen`. */
export function useUserLastSeenLabel(humanId: number | null | undefined): string | null {
  const ctx = useContext(UserPresenceContext);
  if (!ctx || humanId == null) return null;
  return ctx.state.lastSeenLabelByHumanId.get(humanId) ?? null;
}
