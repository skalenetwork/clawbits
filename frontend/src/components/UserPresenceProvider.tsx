import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
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
  // We hold state in refs and force re-renders explicitly so the Map
  // can be mutated in place — Map identity changes on every `set`, but
  // copying the whole map per update would be wasteful at scale.
  const byHumanIdRef = useRef(new Map<number, GlobalUserStatus>());
  const lastSeenByHumanIdRef = useRef(new Map<number, string | null>());
  const lastSeenLabelByHumanIdRef = useRef(new Map<number, string | null>());
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((n) => n + 1), []);

  const set = useCallback(
    (
      humanId: number,
      status: GlobalUserStatus,
      lastSeenAt: string | null,
      lastSeenLabel: string | null = null,
    ) => {
      const prev = byHumanIdRef.current.get(humanId);
      const prevSeen = lastSeenByHumanIdRef.current.get(humanId);
      const prevLabel = lastSeenLabelByHumanIdRef.current.get(humanId);
      if (prev === status && prevSeen === lastSeenAt && prevLabel === lastSeenLabel) {
        return;
      }
      // Replace the Map so consumers that read identity see a change.
      const next = new Map(byHumanIdRef.current);
      next.set(humanId, status);
      byHumanIdRef.current = next;
      const nextSeen = new Map(lastSeenByHumanIdRef.current);
      nextSeen.set(humanId, lastSeenAt);
      lastSeenByHumanIdRef.current = nextSeen;
      const nextLabel = new Map(lastSeenLabelByHumanIdRef.current);
      nextLabel.set(humanId, lastSeenLabel);
      lastSeenLabelByHumanIdRef.current = nextLabel;
      bump();
    },
    [bump],
  );

  const seed = useCallback(
    (
      entries: Array<{
        humanId: number;
        status: GlobalUserStatus;
        lastSeenAt: string | null;
        lastSeenLabel?: string | null;
      }>,
    ) => {
      if (entries.length === 0) return;
      const next = new Map(byHumanIdRef.current);
      const nextSeen = new Map(lastSeenByHumanIdRef.current);
      const nextLabel = new Map(lastSeenLabelByHumanIdRef.current);
      let changed = false;
      for (const e of entries) {
        if (next.get(e.humanId) !== e.status) {
          next.set(e.humanId, e.status);
          changed = true;
        }
        if (nextSeen.get(e.humanId) !== e.lastSeenAt) {
          nextSeen.set(e.humanId, e.lastSeenAt);
          changed = true;
        }
        const label = e.lastSeenLabel ?? null;
        if (nextLabel.get(e.humanId) !== label) {
          nextLabel.set(e.humanId, label);
          changed = true;
        }
      }
      if (!changed) return;
      byHumanIdRef.current = next;
      lastSeenByHumanIdRef.current = nextSeen;
      lastSeenLabelByHumanIdRef.current = nextLabel;
      bump();
    },
    [bump],
  );

  const value = useMemo<UserPresenceContextValue>(() => {
    const state: UserPresenceState = {
      byHumanId: byHumanIdRef.current,
      lastSeenByHumanId: lastSeenByHumanIdRef.current,
      lastSeenLabelByHumanId: lastSeenLabelByHumanIdRef.current,
    };
    return { state, set, seed };
    // Intentionally depending on the Map identity — the refs swap on
    // each update, so the value object refreshes when state changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    byHumanIdRef.current,
    lastSeenByHumanIdRef.current,
    lastSeenLabelByHumanIdRef.current,
    set,
    seed,
  ]);

  return (
    <UserPresenceContext.Provider value={value}>
      {children}
    </UserPresenceContext.Provider>
  );
}
