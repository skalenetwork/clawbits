import { Home03Icon, Robot02Icon } from "@hugeicons/core-free-icons"
import type { FleetEntry } from "@/lib/api"
import { aggregateMetrics, stateCounts } from "@/lib/fleetStats"
import { useHealth } from "@/lib/queries"
import { AgentGrid } from "@/components/AgentGrid"
import { FleetComposition } from "@/components/FleetComposition"
import { HostRuntime } from "@/components/HostRuntime"
import { Icon } from "@/components/Icon"
import { KpiTiles } from "@/components/KpiTiles"
import { PageHeader } from "@/components/PageHeader"
import { Button } from "@/components/ui/button"

/** The fleet home page — the operator's command center when no agent is
 *  selected. A simple header, live KPIs, the agent grid, and a compact
 *  composition + host summary. */
export function Home({
  agents,
  onCreate,
  onSelect,
}: {
  agents: FleetEntry[]
  onCreate: () => void
  onSelect: (id: string) => void
}) {
  const health = useHealth()
  const counts = stateCounts(agents)
  const metrics = aggregateMetrics(agents)
  const healthProps = {
    available: health.data?.msb_available,
    sandboxes: health.data?.sandboxes,
    loading: health.isLoading,
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Home03Icon}
        title="Home"
        actions={
          <Button
            onClick={onCreate}
            size="sm"
            className="bg-brand text-brand-foreground text-[13px] gap-2 hover:bg-brand/90"
          >
            <Icon icon={Robot02Icon} /> New Agent VM
          </Button>
        }
      />
      <KpiTiles counts={counts} metrics={metrics} />
      <AgentGrid agents={agents} onSelect={onSelect} onCreate={onCreate} />
      {counts.total > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold tracking-tight">Overview</h2>
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
            <FleetComposition agents={agents} counts={counts} />
            <HostRuntime agents={agents} counts={counts} health={healthProps} />
          </div>
        </section>
      )}
    </div>
  )
}
