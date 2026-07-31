import { useState } from "react"
import { Robot02Icon, SortByDown01Icon } from "@hugeicons/core-free-icons"
import type { FleetEntry } from "@/lib/api"
import { agentTypeOf } from "@/lib/agentTypes"
import { sortAgents, type SortKey } from "@/lib/fleetStats"
import { cn, formatBytes, formatPercent, formatUptime } from "@/lib/utils"
import { AgentAvatar } from "@/components/AgentAvatar"
import { Icon } from "@/components/Icon"
import { StatusBadge } from "@/components/StatusBadge"
import { Button } from "@/components/ui/button"

/** The centerpiece: every agent as a clickable card with a colour aura and a
 *  live metrics line. Sortable by load or recency; a polished empty state when
 *  the reef is empty. */
export function AgentGrid({
  agents,
  onSelect,
  onCreate,
}: {
  agents: FleetEntry[]
  onSelect: (id: string) => void
  onCreate: () => void
}) {
  const [sort, setSort] = useState<SortKey>("cpu")
  const sorted = sortAgents(agents, sort)
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-tight">Agents</h2>
        {agents.length > 1 && <SortToggle value={sort} onChange={setSort} />}
      </div>

      {agents.length === 0 ? (
        <EmptyState onCreate={onCreate} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sorted.map((a) => (
            <AgentCard key={a.sandbox_id} entry={a} onSelect={onSelect} />
          ))}
        </div>
      )}
    </section>
  )
}

const SORTS: { key: SortKey; label: string }[] = [
  { key: "cpu", label: "Load" },
  { key: "recent", label: "Recent" },
]

function SortToggle({ value, onChange }: { value: SortKey; onChange: (k: SortKey) => void }) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-border/60 bg-card p-0.5">
      <Icon icon={SortByDown01Icon} className="mx-1 size-3.5 text-muted-foreground" />
      {SORTS.map((s) => (
        <button
          key={s.key}
          type="button"
          onClick={() => onChange(s.key)}
          className={cn(
            "rounded-md px-2 py-1 text-xs font-medium transition-colors",
            value === s.key
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {s.label}
        </button>
      ))}
    </div>
  )
}

function AgentCard({ entry, onSelect }: { entry: FleetEntry; onSelect: (id: string) => void }) {
  const at = agentTypeOf(entry)
  const m = entry.metrics
  return (
    <button
      type="button"
      onClick={() => onSelect(entry.sandbox_id)}
      className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card p-4 text-left transition-all hover:border-border hover:bg-muted/30 hover:shadow-xs"
    >
      <div className="flex items-center gap-3">
        <AgentAvatar entry={entry} size="md" showState={false} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{entry.sandbox_id}</div>
          <div className="truncate text-xs text-muted-foreground">{at.label}</div>
        </div>
        {!entry.managed && (
          <span className="shrink-0 rounded-full border border-border px-1.5 text-[9px] font-medium text-muted-foreground">
            drift
          </span>
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <StatusBadge state={entry.state} />
        <span className="truncate text-xs tabular-nums text-muted-foreground">{metricsLine(m)}</span>
      </div>
    </button>
  )
}

/** "cpu · mem · uptime", dropping uptime when the runtime doesn't report it
 *  (the Docker dev backend omits it; msb provides it in prod). */
function metricsLine(m: FleetEntry["metrics"]): string {
  if (!m) return "—"
  const parts = [formatPercent(m.cpu_percent), formatBytes(m.memory_bytes)]
  if (m.uptime_secs > 0) parts.push(formatUptime(m.uptime_secs))
  return parts.join(" · ")
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="relative flex flex-col items-center justify-center gap-5 overflow-hidden rounded-2xl border border-dashed border-border/60 bg-muted/40 px-6 py-16 text-center">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.06] [background-image:radial-gradient(circle_at_1px_1px,currentColor_1px,transparent_0)] [background-size:18px_18px]"
      />
      <span className="relative flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <Icon icon={Robot02Icon} className="size-7" />
      </span>
      <div className="relative space-y-1.5">
        <p className="text-base font-semibold">No agents yet</p>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">
          Spin up your first microVM — it boots isolated, with its own web UI.
        </p>
      </div>
      <Button onClick={onCreate} className="relative bg-brand text-brand-foreground hover:bg-brand/90">
        <Icon icon={Robot02Icon} /> New Agent VM
      </Button>
    </div>
  )
}
