import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AgentPresenceContext,
  type AgentPresenceContextValue,
  type AgentPresenceState,
} from "@/hooks/useAgentPresence";

/**
 * How often to re-evaluate time-derived agent statuses. The offline window is
 * 40 min (coarse), so a 30s tick flips a dot to offline promptly enough while
 * costing almost nothing (a handful of agent avatars re-render).
 */
const TICK_MS = 30_000;

/**
 * Provider for the in-memory map of agent global liveness.
 *
 * Mirrors ``UserPresenceProvider`` (map held in a ref, swapped on each update
 * so subscribers re-render), with one addition: a ticking ``now`` so
 * ``useAgentStatus`` flips ``available -> offline`` when the window elapses
 * without any new event.
 */
export function AgentPresenceProvider({ children }: { children: ReactNode }) {
  const byAgentIdRef = useRef(new Map<string, string | null>());
  const [, setTick] = useState(0);
  const bump = useCallback(() => { setTick((n) => n + 1); }, []);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => { setNow(Date.now()); }, TICK_MS);
    return () => { clearInterval(id); };
  }, []);

  const set = useCallback(
    (agentId: string, lastAliveAt: string | null) => {
      const prev = byAgentIdRef.current;
      if (prev.has(agentId) && prev.get(agentId) === lastAliveAt) return;
      const next = new Map(prev);
      next.set(agentId, lastAliveAt);
      byAgentIdRef.current = next;
      bump();
    },
    [bump],
  );

  const seed = useCallback(
    (entries: { agentId: string; lastAliveAt: string | null }[]) => {
      if (entries.length === 0) return;
      const next = new Map(byAgentIdRef.current);
      let changed = false;
      for (const e of entries) {
        if (!next.has(e.agentId) || next.get(e.agentId) !== e.lastAliveAt) {
          next.set(e.agentId, e.lastAliveAt);
          changed = true;
        }
      }
      if (!changed) return;
      byAgentIdRef.current = next;
      bump();
    },
    [bump],
  );

  const value = useMemo<AgentPresenceContextValue>(() => {
    const state: AgentPresenceState = { byAgentId: byAgentIdRef.current, now };
    return { state, set, seed };
    // Depends on the Map identity (swapped on each update) + the clock tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byAgentIdRef.current, now, set, seed]);

  return (
    <AgentPresenceContext.Provider value={value}>
      {children}
    </AgentPresenceContext.Provider>
  );
}
