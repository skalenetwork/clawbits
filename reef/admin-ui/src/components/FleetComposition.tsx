import type { FleetEntry } from "@/lib/api"
import { agentMeta } from "@/lib/agentTypes"
import type { StateCounts } from "@/lib/fleetStats"
import { typeCounts } from "@/lib/fleetStats"

const SEGMENTS: { key: keyof StateCounts; label: string; bar: string; dot: string }[] = [
  { key: "running", label: "Running", bar: "bg-success", dot: "bg-success" },
  { key: "creating", label: "Creating", bar: "bg-warning", dot: "bg-warning" },
  { key: "stopped", label: "Stopped", bar: "bg-muted-foreground/40", dot: "bg-muted-foreground/60" },
  { key: "failed", label: "Failed", bar: "bg-destructive", dot: "bg-destructive" },
]

/** A slim "shape of the reef" card — a stacked state bar with a legend, plus a
 *  by-type tally. One glance tells the operator the fleet's makeup. */
export function FleetComposition({
  agents,
  counts,
}: {
  agents: FleetEntry[]
  counts: StateCounts
}) {
  const total = counts.total || 1
  const types = typeCounts(agents)
  const visible = SEGMENTS.filter((s) => counts[s.key] > 0)
  return (
    <div className="rounded-xl border border-border/50 bg-card p-5">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">Fleet composition</span>
        <span className="text-xs tabular-nums text-muted-foreground">{counts.total} total</span>
      </div>

      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
        {visible.map((s) => (
          <span
            key={s.key}
            className={s.bar}
            style={{ width: `${String((counts[s.key] / total) * 100)}%` }}
          />
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {visible.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={`size-1.5 rounded-full ${s.dot}`} />
            {s.label} <span className="tabular-nums text-foreground">{counts[s.key]}</span>
          </span>
        ))}
      </div>

      {types.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/50 pt-3">
          {types.map((t) => {
            const meta = agentMeta(t.type)
            const Glyph = meta.Icon
            return (
              <span
                key={t.type}
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
              >
                <Glyph className="size-4" />
                {meta.label} <span className="tabular-nums text-foreground">{t.count}</span>
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
