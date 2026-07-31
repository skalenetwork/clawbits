import type { ReactNode } from "react"
import type { FleetEntry } from "@/lib/api"
import { agentMeta } from "@/lib/agentTypes"
import { driftCount, managedCount, type StateCounts, typeCounts } from "@/lib/fleetStats"
import { cn } from "@/lib/utils"

interface HealthProps {
  available: boolean | undefined
  sandboxes: number | null | undefined
  loading: boolean
}

/** A compact host/runtime summary — msb health, what's on the host, and how
 *  much of it Reef actually tracks. Styled as a card with an overline so it
 *  pairs with FleetComposition in the home page's lower row. */
export function HostRuntime({
  agents,
  counts,
  health,
}: {
  agents: FleetEntry[]
  counts: StateCounts
  health: HealthProps
}) {
  const ok = health.available
  const types = typeCounts(agents)
  return (
    <div className="rounded-xl border border-border/50 bg-card p-5">
      <div className="mb-1 text-xs font-medium text-muted-foreground">Host &amp; runtime</div>
      <div className="divide-y divide-border/50">
        <Row label="Runtime">
          <span className="inline-flex items-center gap-1.5">
            <span
              className={cn(
                "size-1.5 rounded-full",
                health.loading ? "bg-muted-foreground/50" : ok ? "bg-success" : "bg-destructive",
              )}
            />
            {health.loading ? "checking…" : ok ? "msb online" : "msb offline"}
          </span>
        </Row>
        <Row label="Sandboxes">{health.sandboxes ?? counts.total}</Row>
        <Row label="Tracked by Reef">{managedCount(agents)}</Row>
        <Row label="Drift">{driftCount(agents)}</Row>
        {types.length > 0 && (
          <Row label="Types">
            <span className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
              {types.map((t) => {
                const Glyph = agentMeta(t.type).Icon
                return (
                  <span key={t.type} className="inline-flex items-center gap-1.5">
                    <Glyph className="size-4" />
                    <span className="tabular-nums">{t.count}</span>
                  </span>
                )
              })}
            </span>
          </Row>
        )}
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium tabular-nums text-foreground">{children}</span>
    </div>
  )
}
