import type { ReactNode } from "react"
import {
  ArrowDataTransferVerticalIcon,
  CpuIcon,
  PackageIcon,
  RamMemoryIcon,
} from "@hugeicons/core-free-icons"
import type { HugeiconsIconProps } from "@hugeicons/react"
import type { FleetMetrics, StateCounts } from "@/lib/fleetStats"
import { formatBytes, formatPercent } from "@/lib/utils"
import { Icon } from "@/components/Icon"

/** The KPI row — live fleet aggregates as compact, uniform tiles: a label, a
 *  hero number, and a single supporting line (same height across all four). */
export function KpiTiles({ counts, metrics }: { counts: StateCounts; metrics: FleetMetrics }) {
  const memPct = metrics.memLimit > 0 ? Math.min(100, (metrics.memUsed / metrics.memLimit) * 100) : 0
  const live = metrics.contributors > 0
  const agentWord = metrics.contributors === 1 ? "agent" : "agents"
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Tile label="Fleet" icon={PackageIcon} value={String(counts.total)}>
        <span className="text-success">{counts.running} running</span>
        {counts.failed > 0 && <span className="text-destructive"> · {counts.failed} failed</span>}
      </Tile>

      <Tile label="CPU" icon={CpuIcon} value={live ? formatPercent(metrics.cpuPercent) : "—"}>
        {live ? `across ${String(metrics.contributors)} ${agentWord}` : "no live agents"}
      </Tile>

      <Tile label="Memory" icon={RamMemoryIcon} value={live ? formatBytes(metrics.memUsed) : "—"}>
        {live ? `${String(Math.round(memPct))}% of ${formatBytes(metrics.memLimit)}` : "no live agents"}
      </Tile>

      <Tile
        label="Network"
        icon={ArrowDataTransferVerticalIcon}
        value={live ? formatBytes(metrics.netRx + metrics.netTx) : "—"}
      >
        {live ? `↓ ${formatBytes(metrics.netRx)} · ↑ ${formatBytes(metrics.netTx)}` : "no live agents"}
      </Tile>
    </div>
  )
}

function Tile({
  label,
  icon,
  value,
  children,
}: {
  label: string
  icon: HugeiconsIconProps["icon"]
  value: string
  children: ReactNode
}) {
  return (
    <div className="rounded-xl border border-border/50 bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Icon icon={icon} className="size-3.5" />
        </span>
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      <div className="mt-1 truncate text-xs text-muted-foreground">{children}</div>
    </div>
  )
}
