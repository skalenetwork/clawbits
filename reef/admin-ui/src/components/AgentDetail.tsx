import { useState, type ReactNode } from "react"
import {
  AlertDiamondIcon,
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  Copy01Icon,
  Delete02Icon,
  Globe02Icon,
  HardDriveIcon,
  LinkSquare02Icon,
  MoreHorizontalIcon,
  PackageIcon,
  PlayIcon,
  RefreshIcon,
  Settings02Icon,
  ShieldIcon,
  StopIcon,
  Tick01Icon,
  ViewIcon,
  ViewOffIcon,
} from "@hugeicons/core-free-icons"
import { toast } from "sonner"
import { api } from "@/lib/api"
import type { AccessInfo, FleetEntry, Metrics, SandboxDetail } from "@/lib/api"
import { useSandboxDetail, useSandboxLogs, useUpgradeSandbox } from "@/lib/queries"
import {
  cn,
  formatBytes,
  formatDateTime,
  formatPercent,
  formatUptime,
  relativeTime,
  shortAge,
  surfaceAuthUrl,
  terminalAuthUrl,
} from "@/lib/utils"
import { AgentAvatar } from "@/components/AgentAvatar"
import { AgentEnvPanel } from "@/components/AgentEnvPanel"
import { ClawbitsIcon, HermesIcon, IronClawIcon, OpenClawIcon } from "@/components/agent-icons"
import { CARD, Chip, Panel } from "@/components/detail-bits"
import { ReefMark } from "@/components/ReefMark"
import { StatusBadge } from "@/components/StatusBadge"
import { Icon } from "@/components/Icon"
import { PageHeader } from "@/components/PageHeader"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

// Metric meter tone by load: healthy → amber → red.
const METER = { ok: "bg-success", warn: "bg-warning", danger: "bg-destructive" } as const
const loadTone = (f: number): keyof typeof METER => (f < 0.75 ? "ok" : f < 0.9 ? "warn" : "danger")

interface Props {
  entry: FleetEntry
  live: boolean
  onStart: (id: string) => void
  onStop: (id: string) => void
  onRestart: (id: string) => void
  onDestroy: (id: string) => void
  onSetRestartPolicy: (id: string, policy: string) => void
  pending: boolean
}

export function AgentDetail({
  entry,
  live,
  onStart,
  onStop,
  onRestart,
  onDestroy,
  onSetRestartPolicy,
  pending,
}: Props) {
  const id = entry.sandbox_id
  const [tab, setTab] = useState<"overview" | "logs">("overview")
  // Poll the detail (status + versions, access, env) while the page is live so
  // the Versions card and "reported X ago" stay current without a reload.
  const detail = useSandboxDetail(id, live ? 10_000 : false)
  const d = detail.data
  const state = d?.state ?? entry.state
  const canStart = state === "stopped" || state === "failed"
  const canStop = state === "running"
  const m = entry.metrics
  const webUrl = d?.access?.url
  const webLabel = d?.access?.kind === "hermes" ? "Dashboard" : "Control UI"
  const terminalUrl = d?.access?.terminal_url
  // Open surfaces pre-authenticated when a profile has a static secret:
  // OpenClaw uses a `#token=` fragment, the Hermes dashboard basic-auth
  // creds (surfaceAuthUrl branches on kind); ttyd embeds basic-auth creds.
  const controlOpen = webUrl
    ? surfaceAuthUrl(d?.access?.kind, webUrl, d?.access?.password ?? "")
    : undefined
  const terminalOpen = terminalUrl
    ? terminalAuthUrl(terminalUrl, d?.access?.password ?? "")
    : undefined
  const clawbitsOrg = d?.env?.["CLAWBITS_ORG_ID"]

  return (
    <div className="space-y-5">
      {/* Compact identity + actions, portaled into the card's unified header bar. */}
      <PageHeader
        leading={<AgentAvatar entry={{ ...entry, state }} size="sm" ringClass="ring-panel" />}
        title={id}
        badges={
          <>
            <StatusBadge state={state} size="sm" />
            {clawbitsOrg && (
              <Chip
                color="blue"
                size="sm"
                icon={<ClawbitsIcon className="size-3" />}
                title={`Clawbits org ${clawbitsOrg}`}
              >
                Clawbits
              </Chip>
            )}
            {!entry.managed && (
              <Chip
                color="neutral"
                size="sm"
                icon={<Icon icon={AlertDiamondIcon} className="size-3" />}
                title="Unmanaged by Reef — discovered in the runtime but not tracked in Reef's store"
              >
                drift
              </Chip>
            )}
          </>
        }
        actions={
          <>
            {controlOpen && (
              <Button
                size="sm"
                className="bg-brand text-brand-foreground hover:bg-brand/90"
                onClick={() => window.open(controlOpen, "_blank", "noopener,noreferrer")}
              >
                <Icon icon={ArrowUpRight01Icon} /> {webLabel}
              </Button>
            )}
            {terminalOpen && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.open(terminalOpen, "_blank", "noopener,noreferrer")}
              >
                <Icon icon={ArrowUpRight01Icon} /> Terminal
              </Button>
            )}
            {canStop ? (
              <>
                <Button variant="outline" size="sm" onClick={() => onStop(id)} disabled={pending}>
                  <Icon icon={StopIcon} /> Stop
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onRestart(id)}
                  disabled={pending}
                >
                  <Icon icon={RefreshIcon} /> Restart
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                className="bg-brand text-brand-foreground hover:bg-brand/90"
                onClick={() => onStart(id)}
                disabled={pending || !canStart}
              >
                <Icon icon={PlayIcon} /> Start
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon-sm" aria-label="More actions" />}
              >
                <Icon icon={MoreHorizontalIcon} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={4}>
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => onDestroy(id)}
                  disabled={pending}
                >
                  <Icon icon={Delete02Icon} /> Destroy
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      {/* Vitals — tier-1: the "is it healthy right now" answer, at a glance. */}
      <VitalsBand metrics={m} cpus={d?.cpus ?? null} createdAt={d?.created_at ?? entry.created_at} />

      <Tabs value={tab} onValueChange={(v) => setTab(v as "overview" | "logs")}>
        <TabsList variant="line">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="pt-4">
          <DetailOverview
            entry={entry}
            detail={d}
            loading={detail.isLoading}
            error={detail.error}
            onSetRestartPolicy={onSetRestartPolicy}
          />
        </TabsContent>
        <TabsContent value="logs" className="pt-4">
          <LogsView id={id} live={live} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

/** Tier-1 live vitals — a flat 4-up stat row. Surfaces uptime (and disk I/O via
 *  the Network/Disk card) that the old strip dropped. Hidden when the agent
 *  isn't reporting metrics (e.g. stopped). */
function VitalsBand({
  metrics,
  cpus,
  createdAt,
}: {
  metrics: Metrics | null
  cpus: number | null
  createdAt: string | null
}) {
  if (!metrics) return null
  const m = metrics
  const cpuFrac = clamp01(cpus ? m.cpu_percent / (cpus * 100) : m.cpu_percent / 100)
  const memFrac = m.memory_limit_bytes ? clamp01(m.memory_bytes / m.memory_limit_bytes) : undefined
  // Prefer the agent-reported uptime; fall back to age-since-created when the
  // runtime doesn't surface it (e.g. some docker backends report 0).
  const hasUptime = m.uptime_secs > 0
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <VitalCard
        label="Uptime"
        value={hasUptime ? formatUptime(m.uptime_secs) : createdAt ? shortAge(createdAt) : "—"}
        sub={hasUptime ? "since boot" : createdAt ? "since created" : undefined}
      />
      <VitalCard
        label="CPU"
        value={formatPercent(m.cpu_percent)}
        meter={cpuFrac}
        sub={cpus != null ? `of ${cpus} vCPU` : undefined}
      />
      <VitalCard
        label="Memory"
        value={formatBytes(m.memory_bytes)}
        meter={memFrac}
        sub={m.memory_limit_bytes ? `of ${formatBytes(m.memory_limit_bytes)}` : undefined}
      />
      <VitalCard
        label="Network"
        value={<IoValue rx={m.net_rx_bytes} tx={m.net_tx_bytes} />}
        sub={<IoValue rx={m.disk_read_bytes} tx={m.disk_write_bytes} muted label="disk" />}
      />
    </div>
  )
}

/** A ↓in ↑out pair, used for cumulative network + disk counters. */
function IoValue({
  rx,
  tx,
  muted,
  label,
}: {
  rx: number
  tx: number
  muted?: boolean
  label?: string
}) {
  return (
    <span className={cn("tabular-nums", muted && "font-normal")}>
      <span className="text-muted-foreground">↓</span> {formatBytes(rx)}
      <span className="text-muted-foreground/50"> · </span>
      <span className="text-muted-foreground">↑</span> {formatBytes(tx)}
      {label && <span className="ml-1 text-muted-foreground/70">{label}</span>}
    </span>
  )
}

function VitalCard({
  label,
  value,
  sub,
  meter,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  /** 0..1 — renders a thin load meter (tone scales with load) when present. */
  meter?: number
}) {
  return (
    <div className={cn(CARD, "flex flex-col gap-1.5 p-4")}>
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <div className="text-lg font-semibold leading-none">{value}</div>
      {meter != null && (
        <span className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-muted/50">
          <span
            className={cn("block h-full rounded-full", METER[loadTone(meter)])}
            style={{ width: `${Math.round(clamp01(meter) * 100)}%` }}
          />
        </span>
      )}
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  )
}

/** Overview — a two-column bento: reference config in the main column, the
 *  status-y "Versions + Self-healing" pinned in a side rail on wide screens. */
function DetailOverview({
  entry,
  detail,
  loading,
  error,
  onSetRestartPolicy,
}: {
  entry: FleetEntry
  detail: SandboxDetail | undefined
  loading: boolean
  error: unknown
  onSetRestartPolicy: (id: string, policy: string) => void
}) {
  if (!detail) {
    return (
      <div className="space-y-3">
        {loading && <p className="text-sm text-muted-foreground">Loading details…</p>}
        {error != null && (
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : "Failed to load details"}
          </p>
        )}
      </div>
    )
  }

  const m = entry.metrics
  return (
    <div className="grid items-start gap-4 lg:grid-cols-3">
      {/* Main column — access + reference configuration. */}
      <div className="space-y-4 lg:col-span-2">
        {detail.access && <AccessPanel access={detail.access} sandboxId={detail.sandbox_id} />}
        <ConfigurationPanel entry={entry} detail={detail} />
        <NetworkingPanel detail={detail} metrics={m} />
        {detail.mounts.length > 0 && <MountsPanel mounts={detail.mounts} />}
        <AgentEnvPanel detail={detail} />
      </div>

      {/* Side rail — current-ness + self-healing, sticky on wide screens. */}
      <div className="space-y-4 self-start lg:sticky lg:top-16">
        {detail.status?.versions ? (
          <VersionsPanel status={detail.status} entry={entry} />
        ) : (
          <VersionsEmpty entry={entry} />
        )}
        <SelfHealingPanel entry={entry} detail={detail} onSetRestartPolicy={onSetRestartPolicy} />
      </div>
    </div>
  )
}

const POLICY_BLURB: Record<string, string> = {
  always: "Reef keeps this agent running — it restarts after any exit.",
  "on-failure": "Reef restarts this agent if it crashes, but leaves a clean stop alone.",
  never: "Reef won't auto-restart this agent.",
}

const POLICY_OPTS: { key: string; label: string }[] = [
  { key: "always", label: "Always" },
  { key: "on-failure", label: "On failure" },
  { key: "never", label: "Never" },
]

/** Self-healing controls: the reconciler's restart policy (editable) plus the
 *  crash-loop history. Managed agents only — drift VMs have no record to drive. */
function SelfHealingPanel({
  entry,
  detail,
  onSetRestartPolicy,
}: {
  entry: FleetEntry
  detail: SandboxDetail
  onSetRestartPolicy: (id: string, policy: string) => void
}) {
  const policy = detail.restart_policy ?? entry.restart_policy ?? "on-failure"
  const count = detail.restart_count ?? entry.restart_count ?? 0
  const last = detail.last_restart_at ?? entry.last_restart_at
  const autoHeal = policy !== "never"
  return (
    <Panel
      icon={<Icon icon={RefreshIcon} className="size-3.5" />}
      title="Self-healing"
      meta={
        <Chip size="sm" color={autoHeal ? "green" : "neutral"} dot>
          auto-heal {autoHeal ? "on" : "off"}
        </Chip>
      }
    >
      <div className="space-y-3">
        <div className="inline-flex w-full items-center gap-0.5 rounded-lg border border-border/60 bg-background/40 p-0.5">
          {POLICY_OPTS.map((p) => (
            <button
              key={p.key}
              type="button"
              disabled={!entry.managed}
              onClick={() => onSetRestartPolicy(entry.sandbox_id, p.key)}
              className={cn(
                "flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors disabled:opacity-40",
                policy === p.key
                  ? "bg-card text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{POLICY_BLURB[policy] ?? ""}</p>
        {count > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-warning">
            <Icon icon={AlertDiamondIcon} className="size-3.5" />
            <span>
              Auto-restarted {count}×{last ? ` · last ${relativeTime(last)}` : ""}
            </span>
          </div>
        )}
      </div>
    </Panel>
  )
}

/** One version line: logo · name · running version. Purely informational — the
 *  server owns the "is there a newer build" verdict (the Upgrade bar above). */
function VersionRow({
  icon,
  name,
  running,
}: {
  icon: ReactNode
  name: string
  running?: string | null
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex size-7 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[15px]">{name}</span>
      <span className="font-mono text-sm text-foreground">{running ?? "—"}</span>
    </div>
  )
}

/** The image upgrade/reinstall action for a managed agent. Two honest modes over
 *  the SAME lossless recreate (backend always rebuilds on the active tag,
 *  independent of what the agent reported — so this works even before the
 *  Versions card fills in):
 *   • server-confirmed behind (`upgrade_available`) → a prominent warning "Update
 *     available / Upgrade";
 *   • never reported its versions (`reported === false`) → a muted "Reinstall"
 *     escape hatch, so an old agent that doesn't report can still be pulled onto
 *     the current active image.
 *  A reported-and-current agent needs no action, so it renders nothing — the
 *  happy path is untouched. Hidden entirely for drift/creating agents reef can't
 *  recreate (it owns managed agents' volumes + ports). */
function UpgradeControl({ entry, reported }: { entry: FleetEntry; reported: boolean }) {
  const upgrade = useUpgradeSandbox()
  if (!entry.managed || entry.state === "creating") return null
  const behind = entry.upgrade_available
  // Nothing to offer when the agent reported and isn't behind the active image.
  if (!behind && reported) return null
  const busy = upgrade.isPending
  return (
    <div
      className={cn(
        "mb-3 flex items-center justify-between gap-2 rounded-lg px-2.5 py-2",
        behind ? "bg-warning/10" : "border border-border/60 bg-muted/30",
      )}
    >
      <span className={cn("text-xs", behind ? "text-warning" : "text-muted-foreground")}>
        {behind ? "Update available" : "Version not reported"}
      </span>
      <Button
        size="xs"
        variant={behind ? "default" : "secondary"}
        onClick={() => upgrade.mutate(entry.sandbox_id)}
        disabled={busy}
        className={cn("gap-1.5", behind && "bg-warning/90 text-white hover:bg-warning")}
        title="Recreate this agent on the current active image. Workspace, clawbits identity, and access password are preserved; brief downtime."
      >
        <Icon icon={RefreshIcon} className={cn(busy && "animate-spin")} />
        {behind ? (busy ? "Upgrading…" : "Upgrade") : busy ? "Reinstalling…" : "Reinstall"}
      </Button>
    </div>
  )
}

function VersionsPanel({
  status,
  entry,
}: {
  status: NonNullable<SandboxDetail["status"]>
  entry: FleetEntry
}) {
  const v = status.versions ?? {}
  // Each runtime reports its own engine + clawbits component: IronClaw bakes the
  // clawbits WASM *channel*, OpenClaw and Hermes both carry the *plugin*.
  const clawbitsRow = (name: string, running: string | null | undefined) => (
    <VersionRow
      icon={<ClawbitsIcon className="size-5 text-sky-600 dark:text-sky-400" />}
      name={name}
      running={running}
    />
  )
  const engineRows = {
    ironclaw: (
      <>
        <VersionRow icon={<IronClawIcon className="size-6" />} name="IronClaw" running={v.ironclaw} />
        {clawbitsRow("Clawbits Channel", v.clawbitsChannel)}
      </>
    ),
    hermes: (
      <>
        <VersionRow
          icon={<HermesIcon className="size-6 text-foreground" />}
          name="Hermes"
          running={v.hermes}
        />
        {clawbitsRow("Clawbits Plugin", v.clawbitsPlugin)}
      </>
    ),
  }
  return (
    <Panel
      icon={<Icon icon={PackageIcon} className="size-3.5" />}
      title="Versions"
      meta={
        status.reportedAt && (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-1.5 animate-pulse rounded-full bg-success" />
            {relativeTime(status.reportedAt)}
          </span>
        )
      }
    >
      <UpgradeControl entry={entry} reported />
      <div className="space-y-3">
        {engineRows[entry.agent_type as keyof typeof engineRows] ?? (
          <>
            <VersionRow icon={<OpenClawIcon className="size-6" />} name="OpenClaw" running={v.openclaw} />
            {clawbitsRow("Clawbits Plugin", v.clawbitsPlugin)}
          </>
        )}
        <VersionRow
          icon={<ReefMark className="size-5 text-violet-600 dark:text-violet-400" />}
          name="Reef Image"
          running={v.image}
        />
      </div>
    </Panel>
  )
}

/** Shown before the agent has volunteered its status.json (fresh boot, or a
 *  stopped / non-reporting VM). Ghost rows hint at what's coming; the detail
 *  query polls, so it swaps to the real versions the moment the agent reports.
 *  A managed agent that never reports (e.g. an old image) still gets a Reinstall
 *  action here — the recreate targets the active tag regardless of report. */
function VersionsEmpty({ entry }: { entry: FleetEntry }) {
  return (
    <Panel icon={<Icon icon={PackageIcon} className="size-3.5" />} title="Versions">
      <UpgradeControl entry={entry} reported={false} />
      <div className="space-y-2.5" aria-hidden>
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-2.5">
            <span className="size-5 shrink-0 animate-pulse rounded-md bg-muted/50" />
            <span className="h-3 flex-1 animate-pulse rounded bg-muted/40" />
            <span className="h-3 w-12 animate-pulse rounded bg-muted/40" />
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Collected once the agent reports in.
      </p>
    </Panel>
  )
}

function ConfigurationPanel({ entry, detail }: { entry: FleetEntry; detail: SandboxDetail }) {
  const profile = detail.profile ?? entry.profile
  const tenant = detail.tenant ?? entry.tenant
  return (
    <Panel icon={<Icon icon={Settings02Icon} className="size-3.5" />} title="Configuration">
      <KV label="Image">
        <span className="font-mono text-xs">{detail.image}</span>
      </KV>
      {profile && <KV label="Profile">{profile}</KV>}
      {tenant && <KV label="Tenant">{tenant}</KV>}
      <KV label="vCPUs">{detail.cpus != null ? String(detail.cpus) : "—"}</KV>
      <KV label="Memory">{detail.memory_mib != null ? `${detail.memory_mib} MiB` : "—"}</KV>
      <KV label="Created">
        {entry.created_at ? (
          <span title={entry.created_at}>
            {formatDateTime(entry.created_at)}
            <span className="ml-1.5 text-muted-foreground">· {relativeTime(entry.created_at)}</span>
          </span>
        ) : (
          "—"
        )}
      </KV>
      {detail.updated_at && <KV label="Updated">{relativeTime(detail.updated_at)}</KV>}
      {detail.command && (
        <KV label="Command" wrap>
          <span className="font-mono text-xs">{detail.command}</span>
        </KV>
      )}
    </Panel>
  )
}

function NetworkingPanel({ detail, metrics }: { detail: SandboxDetail; metrics: Metrics | null }) {
  const net = detail.network
  return (
    <Panel icon={<Icon icon={ShieldIcon} className="size-3.5" />} title="Networking">
      <KV label="Default egress">
        <PolicyChip value={net.default_egress} />
      </KV>
      <KV label="Default ingress">
        <PolicyChip value={net.default_ingress} />
      </KV>
      {metrics && (
        <>
          <KV label="Net I/O">
            <IoValue rx={metrics.net_rx_bytes} tx={metrics.net_tx_bytes} />
          </KV>
          <KV label="Disk I/O">
            <IoValue rx={metrics.disk_read_bytes} tx={metrics.disk_write_bytes} />
          </KV>
        </>
      )}
      <div className="pt-3">
        <div className="mb-1.5 text-sm text-muted-foreground">Egress allowlist</div>
        {net.egress_allow.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {net.egress_allow.map((t) => (
              <span
                key={t}
                className="rounded-md bg-muted/70 px-2 py-0.5 font-mono text-xs text-muted-foreground"
              >
                {t}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">unrestricted</span>
        )}
      </div>
    </Panel>
  )
}

function MountsPanel({ mounts }: { mounts: SandboxDetail["mounts"] }) {
  return (
    <Panel icon={<Icon icon={HardDriveIcon} className="size-3.5" />} title="Mounts">
      <div className="space-y-1.5">
        {mounts.map((mt, i) => {
          const vol = mt.type.toLowerCase().includes("volume")
          return (
            <div key={i} className="flex items-center gap-2 text-xs">
              <Icon
                icon={vol ? HardDriveIcon : LinkSquare02Icon}
                className="size-3.5 shrink-0 text-muted-foreground"
              />
              <span className="truncate font-mono text-muted-foreground">{mt.source}</span>
              <Icon icon={ArrowRight01Icon} className="size-3 shrink-0 text-muted-foreground/50" />
              <span className="truncate font-mono text-foreground">{mt.dest}</span>
              {mt.readonly && (
                <span className="ml-auto shrink-0 rounded bg-muted/70 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  ro
                </span>
              )}
            </div>
          )
        })}
      </div>
    </Panel>
  )
}

function PolicyChip({ value }: { value: string }) {
  const deny = value.toLowerCase() === "deny"
  return (
    <Chip size="sm" color={deny ? "amber" : "green"} dot>
      {value}
    </Chip>
  )
}

function KV({ label, children, wrap }: { label: string; children: ReactNode; wrap?: boolean }) {
  return (
    <div
      className={cn(
        "flex justify-between gap-4 border-b border-border/40 py-2 first:pt-0 last:border-0 last:pb-0",
        wrap ? "items-start" : "items-center",
      )}
    >
      <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
      <div
        className={cn(
          "min-w-0 text-sm text-foreground",
          wrap ? "text-left break-all" : "truncate text-right",
        )}
      >
        {children}
      </div>
    </div>
  )
}

function AccessPanel({ access, sandboxId }: { access: AccessInfo; sandboxId: string }) {
  const [show, setShow] = useState(false)
  const primaryLabel = access.kind === "hermes" ? "Dashboard" : "Control UI"
  const [copied, setCopied] = useState<string | null>(null)
  // The password is a one-time reveal at create, so `detail.access` carries it as
  // null. If the operator recovers it via the reveal endpoint, fold it back in so
  // the open URLs pre-authenticate and the password row appears.
  const [revealed, setRevealed] = useState<string | null>(null)
  const [revealing, setRevealing] = useState(false)
  const password = access.password ?? revealed
  const copy = (label: string, value: string) => {
    navigator.clipboard?.writeText(value)
    setCopied(label)
    toast.success(`Copied ${label}`)
    setTimeout(() => setCopied((c) => (c === label ? null : c)), 1500)
  }
  const doReveal = async () => {
    setRevealing(true)
    try {
      const a = await api.reveal(sandboxId)
      if (a.password) {
        setRevealed(a.password)
        setShow(true)
        toast.success("Password revealed from the running agent")
      } else {
        toast.error("This agent has no saved password to reveal")
      }
    } catch {
      toast.error("Couldn't reveal the saved password")
    } finally {
      setRevealing(false)
    }
  }
  return (
    <Panel icon={<Icon icon={Globe02Icon} className="size-3.5" />} title="Web access">
      {access.url && (
        <UrlRow
          label={primaryLabel}
          url={access.url}
          openUrl={surfaceAuthUrl(access.kind, access.url, password ?? "")}
          copied={copied === primaryLabel}
          onCopy={() => copy(primaryLabel, access.url!)}
        />
      )}
      {access.terminal_url && (
        // Open with creds embedded (ttyd basic auth) → no prompt. The displayed and
        // copied URL stays clean; only the open action carries the credentials.
        <UrlRow
          label="Terminal"
          url={access.terminal_url}
          openUrl={terminalAuthUrl(access.terminal_url, password ?? "")}
          copied={copied === "Terminal"}
          onCopy={() => copy("Terminal", access.terminal_url!)}
        />
      )}
      {password ? (
        <div>
          <div className="mb-1 text-xs text-muted-foreground">Password</div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-muted/40 px-3 py-2 font-mono text-xs text-foreground">
              {show ? password : "•".repeat(16)}
            </code>
            <IconBtn title={show ? "Hide" : "Reveal"} onClick={() => setShow((s) => !s)}>
              {show ? (
                <Icon icon={ViewOffIcon} className="size-4" />
              ) : (
                <Icon icon={ViewIcon} className="size-4" />
              )}
            </IconBtn>
            <IconBtn title="Copy password" onClick={() => copy("password", password)}>
              {copied === "password" ? (
                <Icon icon={Tick01Icon} className="size-4 text-success" />
              ) : (
                <Icon icon={Copy01Icon} className="size-4" />
              )}
            </IconBtn>
          </div>
          {access.kind === "hermes" && (
            // The dashboard sits behind nginx basic-auth — a manual sign-in
            // needs the username too, not just the password.
            <div className="mt-1 text-xs text-muted-foreground">
              Signs in with username <code className="font-mono">reef</code> and this password.
            </div>
          )}
        </div>
      ) : (
        // Reef doesn't persist the one-time password, so the detail view omits it —
        // but the running guest still has it. Recover it on demand instead of
        // forcing a destroy+recreate.
        <div>
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
            onClick={() => void doReveal()}
            disabled={revealing}
          >
            {revealing ? "Revealing…" : "Lost the password? Reveal it"}
          </button>
        </div>
      )}
    </Panel>
  )
}

/** One labeled URL row in the access panel: open + copy + open-in-new-tab. Opens
 *  via window.open so a creds-bearing ``openUrl`` (the terminal) authenticates
 *  without a prompt, while the displayed/copied ``url`` stays clean. */
function UrlRow({
  label,
  url,
  openUrl,
  copied,
  onCopy,
}: {
  label: string
  url: string
  openUrl?: string
  copied: boolean
  onCopy: () => void
}) {
  const open = () => window.open(openUrl ?? url, "_blank", "noopener,noreferrer")
  return (
    <div className="mb-3">
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={open}
          className="min-w-0 flex-1 truncate rounded-lg bg-muted/40 px-3 py-2 text-left font-mono text-xs text-foreground hover:underline"
        >
          {url}
        </button>
        <IconBtn title={`Copy ${label} URL`} onClick={onCopy}>
          {copied ? (
            <Icon icon={Tick01Icon} className="size-4 text-success" />
          ) : (
            <Icon icon={Copy01Icon} className="size-4" />
          )}
        </IconBtn>
        <IconBtn title="Open in new tab" onClick={open}>
          <Icon icon={LinkSquare02Icon} className="size-4" />
        </IconBtn>
      </div>
    </div>
  )
}

function LogsView({ id, live }: { id: string; live: boolean }) {
  const [tail, setTail] = useState(200)
  const logs = useSandboxLogs(id, tail, live ? 4000 : false)
  const lines = logs.data?.lines ?? []
  return (
    <section className={cn(CARD, "overflow-hidden")}>
      <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <label className="text-xs text-muted-foreground">Tail</label>
        <select
          value={tail}
          onChange={(e) => setTail(Number(e.target.value))}
          className="rounded-md border border-border bg-background/40 px-2 py-1 text-xs text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          {[100, 200, 500, 1000].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        {live && (
          <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-1.5 animate-pulse rounded-full bg-success" />
            live · 4s
          </span>
        )}
      </div>
      <div className="max-h-[60vh] overflow-auto bg-background/30 p-4">
        {logs.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading logs…</p>
        ) : logs.error ? (
          <p className="text-sm text-destructive">
            {logs.error instanceof Error ? logs.error.message : "Failed to load logs"}
          </p>
        ) : lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">No output captured.</p>
        ) : (
          <pre className="font-mono text-xs leading-relaxed break-all whitespace-pre-wrap text-muted-foreground">
            {lines.join("\n")}
          </pre>
        )}
      </div>
    </section>
  )
}

function IconBtn({
  title,
  onClick,
  children,
}: {
  title: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  )
}
