import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  ArrowUp01Icon,
  Cancel01Icon,
  CpuIcon,
  PackageIcon,
  RefreshIcon,
  RoboticIcon,
  SparklesIcon,
  Tick01Icon,
} from "@hugeicons/core-free-icons"
import type { BuildImageIn, FleetEntry, ImageInfo, RuntimeImageStatus } from "@/lib/api"
import {
  useActivateImage,
  useBuildJob,
  useFleet,
  useImages,
  useImageStatus,
  useStartBuild,
} from "@/lib/queries"
import { cn, formatBytes, relativeTime } from "@/lib/utils"
import { Icon } from "@/components/Icon"
import { PageHeader } from "@/components/PageHeader"
import { ClawbitsIcon, HermesIcon, IronClawIcon, OpenClawIcon } from "@/components/agent-icons"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

/** Per-runtime presentation: the build repos reef ships, in a fixed order. Each
 *  gets a big brand-tinted logo tile (its identity accent) + the two version axes
 *  it exposes (engine + clawbits component). Hermes bakes the clawbits *plugin*
 *  (the clawbits-platform extension), so its component axis reads "Plugin" like
 *  OpenClaw's — IronClaw is the odd one out with a channel. */
const RUNTIMES: {
  id: string
  label: string
  engineLabel: string
  componentLabel: string
  Logo: (props: { className?: string }) => ReactNode
  tile: string // solid brand tint for the logo tile
}[] = [
  {
    id: "openclaw",
    label: "OpenClaw",
    engineLabel: "OpenClaw",
    componentLabel: "Plugin",
    Logo: OpenClawIcon,
    tile: "bg-orange-500/12",
  },
  {
    id: "ironclaw",
    label: "IronClaw",
    engineLabel: "IronClaw",
    componentLabel: "Channel",
    Logo: IronClawIcon,
    tile: "bg-sky-500/12",
  },
  {
    id: "hermes",
    label: "Hermes",
    engineLabel: "Hermes",
    componentLabel: "Plugin",
    Logo: HermesIcon,
    tile: "bg-violet-500/12",
  },
]

/** Prefer the self-describing stack tag (reef-oc:oc…-pl… / reef-ic:ic…-ch… /
 *  reef-hm:hm…-pl…) over the floating tag (:plugin / :channel) so a card names the
 *  build, not the moving pointer. */
function pickActive(images: ImageInfo[]): ImageInfo | undefined {
  const act = images.filter((i) => i.is_active)
  return (
    act.find((i) => /^reef-(oc|ic|hm):(oc|ic|hm).+-(pl|ch)/.test(i.tag)) ??
    act.find((i) => !i.tag.endsWith(":plugin") && !i.tag.endsWith(":channel")) ??
    act[0]
  )
}

/** One KPI: an icon + label → number → optional "→ new" hint (amber when a newer
 *  version is a build away). All tiles share one value size. */
function StatTile({
  label,
  icon,
  value,
  hint,
  hintTone = "muted",
}: {
  label: string
  icon: ReactNode
  value: string
  hint?: string | null
  hintTone?: "amber" | "muted"
}) {
  return (
    <div className="rounded-lg bg-muted/40 px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        {icon}
        <span className="truncate">{label}</span>
      </p>
      <p className="mt-1 truncate text-2xl font-semibold tabular-nums tracking-tight text-foreground">
        {value}
      </p>
      {hint && (
        <p
          className={cn(
            "mt-0.5 truncate text-xs font-medium tabular-nums",
            hintTone === "amber" ? "text-warning" : "text-muted-foreground",
          )}
        >
          {hint}
        </p>
      )}
    </div>
  )
}

/** One older image, for the collapsed rollback list: tag + versions + a
 *  confirm-free "Set active". No mono — versions read as plain data. */
function ImageRow({
  img,
  onActivate,
  activating,
}: {
  img: ImageInfo
  onActivate: (tag: string) => void
  activating: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-sidebar-border px-3 py-2.5 last:border-b-0">
      <span className="min-w-40 flex-1 truncate text-sm font-medium text-foreground">{img.tag}</span>
      <div className="flex items-center gap-4 text-xs text-muted-foreground tabular-nums">
        <span>{img.runtime_version ?? "—"}</span>
        <span>{img.component_version ?? "—"}</span>
        <span>{formatBytes(img.size_bytes)}</span>
        <span>{relativeTime(img.created_at)}</span>
      </div>
      <Button size="xs" variant="outline" onClick={() => onActivate(img.tag)} disabled={activating}>
        Set active
      </Button>
    </div>
  )
}

/** The Advanced build dialog (freeform). OpenClaw exposes engine + component
 *  version pins; IronClaw derives both from source, so it only offers "force
 *  fresh". The primary "Build latest" button (per section) doesn't open this. */
function BuildDialog({
  runtimeId,
  status,
  onClose,
  onBuild,
  pending,
}: {
  runtimeId: string
  status: RuntimeImageStatus | undefined
  onClose: () => void
  onBuild: (body: BuildImageIn) => void
  pending: boolean
}) {
  const rt = RUNTIMES.find((r) => r.id === runtimeId)!
  const isOpenclaw = runtimeId === "openclaw"
  const [engine, setEngine] = useState("")
  const [component, setComponent] = useState("")
  const [forceFresh, setForceFresh] = useState(false)

  useEffect(() => {
    setEngine(status?.latest_runtime.latest ?? "")
    setComponent(status?.latest_component.latest ?? "")
    setForceFresh(false)
  }, [runtimeId, status])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    onBuild({
      agent_type: runtimeId,
      runtime_version: isOpenclaw ? engine.trim() || undefined : undefined,
      component_version: isOpenclaw ? component.trim() || undefined : undefined,
      force_fresh: forceFresh,
    })
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon icon={SparklesIcon} className="size-4" /> Build {rt.label} image
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          {isOpenclaw ? (
            <>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-foreground">OpenClaw version</span>
                <Input
                  value={engine}
                  onChange={(e) => setEngine(e.target.value)}
                  placeholder="latest pinned (Dockerfile default)"
                  spellCheck={false}
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-foreground">Clawbits plugin version</span>
                <Input
                  value={component}
                  onChange={(e) => setComponent(e.target.value)}
                  placeholder="latest from clawhub"
                  spellCheck={false}
                />
              </label>
            </>
          ) : runtimeId === "hermes" ? (
            <p className="text-[13px] text-muted-foreground">
              Builds Hermes from the pinned base image + the in-tree clawbits plugin. The engine
              and plugin versions are derived from the sources — nothing to pin.
            </p>
          ) : (
            <p className="text-[13px] text-muted-foreground">
              Builds IronClaw from the local ironclaw checkout + the clawbits channel in this tree. The
              engine and channel versions are derived from source — nothing to pin.
            </p>
          )}
          <label className="flex items-center gap-2 text-[13px] text-foreground">
            <input
              type="checkbox"
              checked={forceFresh}
              onChange={(e) => setForceFresh(e.target.checked)}
              className="size-4 accent-brand"
            />
            Force fresh (full --no-cache rebuild)
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={pending}
              className="gap-2 bg-brand text-brand-foreground hover:bg-brand/90"
            >
              <Icon icon={SparklesIcon} /> {pending ? "Starting…" : "Build"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Live build log. Refreshes the image/fleet/status queries the moment the build
 *  COMPLETES (not just when it starts), and is dismissable. The <pre> stays mono —
 *  it's raw docker output, where column alignment matters. */
function BuildLog({ jobId, onDismiss }: { jobId: string; onDismiss: () => void }) {
  const job = useBuildJob(jobId)
  const qc = useQueryClient()
  const logRef = useRef<HTMLPreElement>(null)
  const data = job.data
  const status = data?.status

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [data?.log.length])

  useEffect(() => {
    if (status === "succeeded" || status === "failed" || job.isError) {
      qc.invalidateQueries({ queryKey: ["images"] })
      qc.invalidateQueries({ queryKey: ["image-status"] })
      qc.invalidateQueries({ queryKey: ["fleet"] })
    }
  }, [status, job.isError, qc])

  if (!data) return null
  const running = status === "running"
  const tone =
    status === "succeeded"
      ? "text-success"
      : status === "failed"
        ? "text-destructive"
        : "text-muted-foreground"

  return (
    <div className="mb-4 overflow-hidden rounded-xl border border-sidebar-border bg-panel">
      <div className="flex items-center gap-2 border-b border-sidebar-border px-4 py-2.5 text-sm">
        <Icon
          icon={running ? RefreshIcon : status === "succeeded" ? Tick01Icon : PackageIcon}
          className={cn("size-4", running && "animate-spin", tone)}
        />
        <span className={cn("font-medium", tone)}>
          {running ? "Building" : status === "succeeded" ? "Build succeeded" : "Build failed"}
        </span>
        <span className="text-xs text-muted-foreground capitalize">{data.agent_type}</span>
        {data.error && <span className="truncate text-xs text-destructive">· {data.error}</span>}
        <button
          onClick={onDismiss}
          className="ml-auto text-muted-foreground hover:text-foreground"
          title="Dismiss"
        >
          <Icon icon={Cancel01Icon} className="size-4" />
        </button>
      </div>
      <pre
        ref={logRef}
        className="max-h-64 overflow-auto px-4 py-3 font-mono text-[11px] leading-relaxed text-muted-foreground"
      >
        {data.log.length ? data.log.join("\n") : "Waiting for output…"}
      </pre>
    </div>
  )
}

/** One runtime's tile: a big brand logo, the active image's two version axes +
 *  fleet counts as big KPIs, a build affordance, and a collapsed rollback list. */
function RuntimeSection({
  runtime,
  images,
  status,
  fleet,
  onBuildLatest,
  onAdvanced,
  onActivate,
  activating,
}: {
  runtime: (typeof RUNTIMES)[number]
  images: ImageInfo[]
  status: RuntimeImageStatus | undefined
  fleet: FleetEntry[]
  onBuildLatest: () => void
  onAdvanced: () => void
  onActivate: (tag: string) => void
  activating: boolean
}) {
  const typeImages = images.filter((i) => (i.agent_type ?? "openclaw") === runtime.id)
  const active = pickActive(typeImages)
  const older = typeImages.filter((i) => !i.is_active)
  const [showOlder, setShowOlder] = useState(false)

  const buildAvailable = !!status?.build_available
  const hasFloor = !!status?.latest_runtime.latest || !!status?.latest_component.latest
  const agentCount = fleet.filter((e) => (e.agent_type ?? "openclaw") === runtime.id).length
  const staleCount = fleet.filter(
    (e) => (e.agent_type ?? "openclaw") === runtime.id && e.upgrade_available,
  ).length

  const { Logo } = runtime
  const engineNext =
    status?.latest_runtime.latest && active?.runtime_version !== status.latest_runtime.latest
      ? status.latest_runtime.latest
      : null
  const componentNext =
    status?.latest_component.latest && active?.component_version !== status.latest_component.latest
      ? status.latest_component.latest
      : null

  return (
    <div className="mb-4 rounded-xl border border-sidebar-border bg-panel p-5">
      {/* Header: big brand logo · name + freshness · build */}
      <div className="flex items-center gap-4">
        <span
          className={cn(
            "flex size-16 shrink-0 items-center justify-center rounded-2xl",
            runtime.tile,
          )}
        >
          <Logo className="size-11" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
            <h3 className="text-xl font-semibold tracking-tight text-foreground">{runtime.label}</h3>
            {active &&
              (buildAvailable ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-warning">
                  <span className="size-1.5 rounded-full bg-warning" /> Update available
                </span>
              ) : hasFloor ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <span className="size-1.5 rounded-full bg-success" /> Up to date
                </span>
              ) : null)}
            {active && (
              <span className="text-xs text-muted-foreground">
                updated {relativeTime(active.created_at)}
              </span>
            )}
          </div>
          {active ? (
            <p className="mt-1 truncate text-base font-medium text-muted-foreground">{active.tag}</p>
          ) : (
            <p className="mt-1 truncate text-sm text-muted-foreground">No image built yet</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {active && (
            <Button size="lg" variant="ghost" onClick={onAdvanced}>
              Advanced
            </Button>
          )}
          <Button
            size="lg"
            onClick={onBuildLatest}
            variant={buildAvailable || !active ? undefined : "outline"}
            className={cn(
              "gap-2",
              (buildAvailable || !active) && "bg-brand text-brand-foreground hover:bg-brand/90",
            )}
          >
            <Icon icon={SparklesIcon} /> {active ? (buildAvailable ? "Build latest" : "Rebuild") : "Build"}
          </Button>
        </div>
      </div>

      {/* KPIs: the two version axes + fleet counts, big. */}
      <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <StatTile
          icon={<Icon icon={CpuIcon} className="size-3.5 shrink-0" />}
          label={runtime.engineLabel}
          value={active?.runtime_version ?? "—"}
          hint={engineNext ? `→ ${engineNext}` : null}
          hintTone="amber"
        />
        <StatTile
          icon={<ClawbitsIcon className="size-3.5 shrink-0" />}
          label={runtime.componentLabel}
          value={active?.component_version ?? "—"}
          hint={componentNext ? `→ ${componentNext}` : null}
          hintTone="amber"
        />
        <StatTile
          icon={<Icon icon={RoboticIcon} className="size-3.5 shrink-0" />}
          label="Agents"
          value={String(agentCount)}
        />
        <StatTile
          icon={<Icon icon={ArrowUp01Icon} className="size-3.5 shrink-0" />}
          label="Behind"
          value={String(staleCount)}
          hint={staleCount > 0 ? "upgrade each" : null}
          hintTone="amber"
        />
      </div>

      {older.length > 0 && (
        <div className="mt-3 border-t border-sidebar-border pt-2">
          <button
            onClick={() => setShowOlder((s) => !s)}
            className="text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {showOlder ? "Hide" : "Show"} {older.length} older image{older.length === 1 ? "" : "s"}
          </button>
          {showOlder && (
            <div className="mt-2 overflow-hidden rounded-lg border border-sidebar-border">
              {older.map((img) => (
                <ImageRow key={img.tag} img={img} onActivate={onActivate} activating={activating} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function Images() {
  const images = useImages()
  const imageStatus = useImageStatus()
  const fleet = useFleet(15_000)
  const startBuild = useStartBuild()
  const activate = useActivateImage()
  const [jobId, setJobId] = useState<string | null>(null)
  const [advancedFor, setAdvancedFor] = useState<string | null>(null)

  const rows = images.data ?? []
  const statusByType = new Map((imageStatus.data?.runtimes ?? []).map((r) => [r.agent_type, r]))

  const build = (body: BuildImageIn) =>
    startBuild.mutate(body, {
      onSuccess: (job) => {
        setJobId(job.id)
        setAdvancedFor(null)
      },
    })

  const buildLatest = (runtimeId: string) => {
    const st = statusByType.get(runtimeId)
    build({
      agent_type: runtimeId,
      runtime_version: st?.latest_runtime.latest ?? undefined,
      component_version: st?.latest_component.latest ?? undefined,
      force_fresh: false,
    })
  }

  return (
    <div>
      <PageHeader icon={PackageIcon} title="Images" />

      {jobId && <BuildLog jobId={jobId} onDismiss={() => setJobId(null)} />}

      {images.isLoading ? (
        <div className="rounded-xl border border-sidebar-border bg-panel px-3 py-10 text-center text-sm text-muted-foreground">
          Loading images…
        </div>
      ) : (
        RUNTIMES.map((runtime) => (
          <RuntimeSection
            key={runtime.id}
            runtime={runtime}
            images={rows}
            status={statusByType.get(runtime.id)}
            fleet={fleet.data ?? []}
            onBuildLatest={() => buildLatest(runtime.id)}
            onAdvanced={() => setAdvancedFor(runtime.id)}
            onActivate={(tag) => activate.mutate(tag)}
            activating={activate.isPending}
          />
        ))
      )}

      {advancedFor && (
        <BuildDialog
          runtimeId={advancedFor}
          status={statusByType.get(advancedFor)}
          onClose={() => setAdvancedFor(null)}
          pending={startBuild.isPending}
          onBuild={build}
        />
      )}
    </div>
  )
}
