import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { GlobalUserStatus } from "@/lib/api";
import {
  UserPresenceContext,
  type UserPresenceContextValue,
  type UserPresenceState,
} from "@/hooks/useUserPresence";

/**
 * Provider for the in-memory map of human-user presence.
 *
 * Kept independent of react-query so updates from SSE don't churn
 * queries — only components that subscribe via ``useUserPresence`` /
 * ``useUserStatus`` re-render, and only when their specific user's
 * entry changes (React handles that via Map identity + selector).
 *
 * The map identity changes on every update so consumers reading
 * ``state`` rerender — fine for the small set of avatars that subscribe
 * directly. Larger surfaces (member lists) should call ``useUserStatus``
 * per row, which only rerenders when the underlying Map identity
 * changes — still acceptable given how rarely statuses transition in
 * practice.
 */
export function UserPresenceProvider({ children }: { children: ReactNode }) {
  // Three parallel maps in one state object: every update replaces the maps
  // it touches (so identity-based consumers see the change) and returns the
  // previous object untouched when nothing moved (so they don't re-render).
  const [state, setState] = useState<UserPresenceState>(() => ({
    byHumanId: new Map(),
    lastSeenByHumanId: new Map(),
    lastSeenLabelByHumanId: new Map(),
  }));

  const set = useCallback(
    (
      humanId: number,
      status: GlobalUserStatus,
      lastSeenAt: string | null,
      lastSeenLabel: string | null = null,
    ) => {
      setState((prev) => {
        if (
          prev.byHumanId.get(humanId) === status
          && prev.lastSeenByHumanId.get(humanId) === lastSeenAt
          && prev.lastSeenLabelByHumanId.get(humanId) === lastSeenLabel
        ) {
          return prev;
        }
        return {
          byHumanId: new Map(prev.byHumanId).set(humanId, status),
          lastSeenByHumanId: new Map(prev.lastSeenByHumanId).set(humanId, lastSeenAt),
          lastSeenLabelByHumanId: new Map(prev.lastSeenLabelByHumanId).set(
            humanId,
            lastSeenLabel,
          ),
        };
      });
    },
    [],
  );

  const seed = useCallback(
    (
      entries: {
        humanId: number;
        status: GlobalUserStatus;
        lastSeenAt: string | null;
        lastSeenLabel?: string | null;
      }[],
    ) => {
      if (entries.length === 0) return;
      setState((prev) => {
        const byHumanId = new Map(prev.byHumanId);
        const lastSeenByHumanId = new Map(prev.lastSeenByHumanId);
        const lastSeenLabelByHumanId = new Map(prev.lastSeenLabelByHumanId);
        let changed = false;
        for (const e of entries) {
          const label = e.lastSeenLabel ?? null;
          if (byHumanId.get(e.humanId) !== e.status) {
            byHumanId.set(e.humanId, e.status);
            changed = true;
          }
          if (lastSeenByHumanId.get(e.humanId) !== e.lastSeenAt) {
            lastSeenByHumanId.set(e.humanId, e.lastSeenAt);
            changed = true;
          }
          if (lastSeenLabelByHumanId.get(e.humanId) !== label) {
            lastSeenLabelByHumanId.set(e.humanId, label);
            changed = true;
          }
        }
        return changed ? { byHumanId, lastSeenByHumanId, lastSeenLabelByHumanId } : prev;
      });
    },
    [],
  );

  const value = useMemo<UserPresenceContextValue>(
    () => ({ state, set, seed }),
    [state, set, seed],
  );

  return (
    <UserPresenceContext.Provider value={value}>
      {children}
    </UserPresenceContext.Provider>
  );
}
