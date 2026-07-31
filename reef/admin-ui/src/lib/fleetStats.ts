// Pure aggregations over the live fleet — counts, summed metrics, type tallies,
// and sorts. Kept UI-free so the home page just renders the numbers.

import type { FleetEntry } from "@/lib/api"

export interface StateCounts {
  total: number
  running: number
  creating: number
  stopped: number
  failed: number
  destroyed: number
}

export function stateCounts(entries: FleetEntry[]): StateCounts {
  const c: StateCounts = {
    total: entries.length,
    running: 0,
    creating: 0,
    stopped: 0,
    failed: 0,
    destroyed: 0,
  }
  for (const e of entries) c[e.state]++
  return c
}

export interface FleetMetrics {
  cpuPercent: number // summed across agents reporting metrics
  memUsed: number
  memLimit: number
  netRx: number
  netTx: number
  contributors: number // how many agents contributed live metrics
}

export function aggregateMetrics(entries: FleetEntry[]): FleetMetrics {
  const m: FleetMetrics = {
    cpuPercent: 0,
    memUsed: 0,
    memLimit: 0,
    netRx: 0,
    netTx: 0,
    contributors: 0,
  }
  for (const e of entries) {
    const x = e.metrics
    if (!x) continue
    m.cpuPercent += x.cpu_percent
    m.memUsed += x.memory_bytes
    m.memLimit += x.memory_limit_bytes
    m.netRx += x.net_rx_bytes
    m.netTx += x.net_tx_bytes
    m.contributors++
  }
  return m
}

export interface TypeCount {
  type: string
  count: number
}

export function typeCounts(entries: FleetEntry[]): TypeCount[] {
  const map = new Map<string, number>()
  for (const e of entries) map.set(e.agent_type, (map.get(e.agent_type) ?? 0) + 1)
  return [...map.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count)
}

export function managedCount(entries: FleetEntry[]): number {
  return entries.filter((e) => e.managed).length
}

export function driftCount(entries: FleetEntry[]): number {
  return entries.filter((e) => !e.managed).length
}

export type SortKey = "cpu" | "recent"

function ts(iso: string | null): number {
  if (!iso) return 0
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? 0 : t
}

/** Returns a sorted copy — busiest first ("cpu") or newest first ("recent"). */
export function sortAgents(entries: FleetEntry[], key: SortKey): FleetEntry[] {
  const copy = [...entries]
  if (key === "cpu") {
    copy.sort((a, b) => (b.metrics?.cpu_percent ?? -1) - (a.metrics?.cpu_percent ?? -1))
  } else {
    copy.sort((a, b) => ts(b.created_at) - ts(a.created_at))
  }
  return copy
}
