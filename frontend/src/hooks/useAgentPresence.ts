import { useSyncExternalStore } from "react";
import { agentLivenessStatus } from "@/lib/agentLiveness";
import type { AgentLivenessStatus } from "@/lib/api";

const CLOCK_MS = 30_000;

export interface AgentPresence {
  agentId: string;
  lastAliveAt: string | null;
}

let aliveByAgent: ReadonlyMap<string, string | null> = new Map();
let now = Date.now();
let clock: number | undefined;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (clock === undefined) {
    now = Date.now();
    clock = window.setInterval(() => {
      now = Date.now();
      notify();
    }, CLOCK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    window.clearInterval(clock);
    clock = undefined;
  };
}

export function updateAgentPresence(entries: readonly AgentPresence[]): void {
  let next: Map<string, string | null> | null = null;
  for (const { agentId, lastAliveAt } of entries) {
    const current = next ?? aliveByAgent;
    if (current.has(agentId) && current.get(agentId) === lastAliveAt) continue;
    next ??= new Map(aliveByAgent);
    next.set(agentId, lastAliveAt);
  }
  if (!next) return;
  aliveByAgent = next;
  notify();
}

export function useAgentStatus(
  agentId: string | null | undefined,
  fallbackLastAliveAt?: string | null,
): AgentLivenessStatus {
  return useSyncExternalStore(subscribe, () => {
    if (agentId == null) return "offline";
    if (aliveByAgent.has(agentId)) return agentLivenessStatus(aliveByAgent.get(agentId) ?? null, now);
    return fallbackLastAliveAt === undefined ? "offline" : agentLivenessStatus(fallbackLastAliveAt, now);
  });
}
