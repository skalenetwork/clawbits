import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
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
 * Mirrors ``UserPresenceProvider``, with one addition: a ticking ``now`` so
 * ``useAgentStatus`` flips ``available -> offline`` when the window elapses
 * without any new event.
 */
export function AgentPresenceProvider({ children }: { children: ReactNode }) {
  // The map is replaced (never mutated) on every real change and returned
  // as-is otherwise, so subscribers re-render exactly when something moved.
  const [byAgentId, setByAgentId] = useState<Map<string, string | null>>(() => new Map());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => { setNow(Date.now()); }, TICK_MS);
    return () => { clearInterval(id); };
  }, []);

  const set = useCallback((agentId: string, lastAliveAt: string | null) => {
    setByAgentId((prev) => {
      if (prev.has(agentId) && prev.get(agentId) === lastAliveAt) return prev;
      return new Map(prev).set(agentId, lastAliveAt);
    });
  }, []);

  const seed = useCallback((entries: { agentId: string; lastAliveAt: string | null }[]) => {
    if (entries.length === 0) return;
    setByAgentId((prev) => {
      const next = new Map(prev);
      let changed = false;
      for (const e of entries) {
        if (!next.has(e.agentId) || next.get(e.agentId) !== e.lastAliveAt) {
          next.set(e.agentId, e.lastAliveAt);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const value = useMemo<AgentPresenceContextValue>(() => {
    const state: AgentPresenceState = { byAgentId, now };
    return { state, set, seed };
  }, [byAgentId, now, set, seed]);

  return (
    <AgentPresenceContext.Provider value={value}>
      {children}
    </AgentPresenceContext.Provider>
  );
}
