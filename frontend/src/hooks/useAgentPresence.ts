import { createContext, useContext } from "react";
import { agentLivenessStatus } from "@/lib/agentLiveness";
import type { AgentLivenessStatus } from "@/lib/api";

/**
 * Global liveness for every agent this session has heard about.
 *
 * Keyed by ``agent_id`` -> the agent's raw ``last_alive_at`` (ISO string) or
 * ``null`` (known but never pinged => "setup"). A *missing* key means "unknown"
 * and renders as offline. Updated by ``AgentPresenceProvider`` from:
 *
 *   - the ``agent.status`` SSE event (channel + per-user fan-out), and
 *   - member-list payloads, which carry ``last_alive_at`` per agent member.
 *
 * Unlike human presence, an agent's available/offline split is *time-derived*:
 * the provider ticks a clock so the dot flips to offline when the window
 * elapses, with no server event for the negative transition.
 */
export interface AgentPresenceState {
  byAgentId: Map<string, string | null>;
  /** Clock (ms) bumped on an interval so time-derived statuses re-evaluate. */
  now: number;
}

export interface AgentPresenceContextValue {
  state: AgentPresenceState;
  /** Insert/replace one agent's last_alive_at. Called by the SSE handler. */
  set: (agentId: string, lastAliveAt: string | null) => void;
  /** Bulk-seed from a member-list payload. */
  seed: (entries: { agentId: string; lastAliveAt: string | null }[]) => void;
}

export const AgentPresenceContext = createContext<AgentPresenceContextValue | null>(null);

export function useAgentPresence(): AgentPresenceContextValue {
  const ctx = useContext(AgentPresenceContext);
  if (!ctx) {
    throw new Error("useAgentPresence must be used within an AgentPresenceProvider");
  }
  return ctx;
}

/**
 * One agent's derived global liveness. Returns "offline" when the agent is
 * unknown (no entry yet). Re-derives on the provider's clock tick, so an
 * "available" agent flips to "offline" once its last ping ages past the window.
 *
 * ``fallbackLastAliveAt`` is a snapshot from an already-fetched payload (agent
 * list / profile). It's used only while the provider has no entry for this
 * agent — the seeding effect runs after render, so without it a cold load
 * would flash the dot offline for a frame. Once seeded (or updated over SSE),
 * the provider's value wins.
 */
export function useAgentStatus(
  agentId: string | null | undefined,
  fallbackLastAliveAt?: string | null,
): AgentLivenessStatus {
  const ctx = useContext(AgentPresenceContext);
  if (!ctx || agentId == null) return "offline";
  if (ctx.state.byAgentId.has(agentId)) {
    return agentLivenessStatus(ctx.state.byAgentId.get(agentId) ?? null, ctx.state.now);
  }
  if (fallbackLastAliveAt === undefined) return "offline";
  return agentLivenessStatus(fallbackLastAliveAt, ctx.state.now);
}
