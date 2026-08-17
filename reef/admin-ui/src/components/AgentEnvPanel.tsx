import { useMemo, useRef, useState } from "react"
import { Add01Icon, AlertDiamondIcon, ArrowRight01Icon, SourceCodeIcon } from "@hugeicons/core-free-icons"
import type { EnvApplyMode, SandboxDetail } from "@/lib/api"
import {
  buildEnvPatch,
  envApplyOptions,
  envApplyReach,
  envDraftProblem,
  envPatchIsEmpty,
  envReadOnlyCause,
  toDraftRows,
  type EnvApplyReach,
  type EnvDraftRow,
} from "@/lib/envApply"
import { useAgentEnv, useEnvActions } from "@/lib/queries"
import { cn } from "@/lib/utils"
import { CARD, Chip, Panel, RuntimeEnvList } from "@/components/detail-bits"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { Icon } from "@/components/Icon"
import { Button } from "@/components/ui/button"
import { EnvRow } from "@/components/EnvRows"

const APPLY_COPY: Record<EnvApplyMode, string> = {
  restart:
    "Restarts the agent in place. Nothing on disk changes: the workspace, ~/.openclaw config, chat sessions and the device identity all survive. A few seconds of downtime.",
  recreate:
    'Destroys and rebuilds the container on its current image. The workspace volume and the clawbits identity survive, but ~/.openclaw does not: openclaw.json (everything set with "openclaw config set"), chat sessions, the local state DB, the device identity and any skill installed after boot are lost, and the model is re-pinned to reef\'s default.',
  none: "Writes the change and leaves the agent alone. Nothing is restarted or recreated - it takes effect the next time the agent starts.",
}

const MODE_LABEL: Record<EnvApplyMode, string> = {
  restart: "Restart",
  recreate: "Recreate",
  none: "On next start",
}

const MODE_CONFIRM: Record<EnvApplyMode, string> = {
  restart: "Save & restart",
  recreate: "Save & recreate",
  none: "Save for next start",
}

// Reef restarts a rebuilt container only when its desired state is "running".
const recreateTail = (revives: boolean): string =>
  revives
    ? " The agent isn't up right now; reef rebuilds it and starts it."
    : " You stopped this agent, so reef rebuilds it and leaves it stopped."

interface AgentApplyFacts {
  reach: EnvApplyReach
  applyModes: string[]
  revives: boolean
}

interface ApplyPlan {
  offered: EnvApplyMode[]
  mode: EnvApplyMode
  copy: string
  confirmLabel: string
}

// A forced restart is labelled "Save": reef takes apply="restart" from a down
// agent and then does what "none" does.
function applyPlan(facts: AgentApplyFacts, chosen: EnvApplyMode | null): ApplyPlan {
  const offered = envApplyOptions(facts.applyModes, facts.reach)
  const mode = chosen && offered.includes(chosen) ? chosen : offered[0]
  return {
    offered,
    mode,
    copy: applyCopy(mode, facts),
    confirmLabel: mode === "restart" && facts.reach !== "now" ? "Save" : MODE_CONFIRM[mode],
  }
}

function applyCopy(mode: EnvApplyMode, facts: AgentApplyFacts): string {
  if (mode === "recreate") {
    return facts.reach === "now" ? APPLY_COPY.recreate : APPLY_COPY.recreate + recreateTail(facts.revives)
  }
  if (mode === "none" || facts.reach === "now") return APPLY_COPY[mode]
  if (facts.reach === "stopping") {
    return "You stopped this agent, so reef writes the change and starts nothing - not even the restart it would normally do. It takes effect the next time you start it."
  }
  return `This agent isn't running, so there is nothing to restart. The change is written now and takes effect the next time ${facts.revives ? "it comes up" : "you start it"}.`
}

/** The per-agent user env editor: names and lengths only, saved as one PATCH. */
export function AgentEnvPanel({ detail }: { detail: SandboxDetail }) {
  const id = detail.sandbox_id
  const env = useAgentEnv(id)
  const { save } = useEnvActions(id)
  const [mode, setMode] = useState<EnvApplyMode | null>(null)
  const [confirmSave, setConfirmSave] = useState(false)
  const [showRuntime, setShowRuntime] = useState(false)
  // Row identity must outlive re-ordering; an array index would not.
  const nextRowId = useRef(0)

  const data = env.data
  const vars = useMemo(() => data?.vars ?? [], [data])
  const editable = data?.editable ?? false
  const modes = data?.apply_modes ?? []
  const state = data?.state ?? detail.state
  const readsEnvFile = modes.includes("restart")
  const reach = envApplyReach(state, data?.desired_state)
  // `detail.managed` is the `rec is not None` half of the server's `editable`.
  const readOnlyCause = data ? envReadOnlyCause(editable, detail.managed) : null
  const plan = applyPlan(
    { reach, applyModes: modes, revives: data?.desired_state === "running" },
    mode,
  )
  const busy = save.isPending

  // null = untouched, so the list tracks the server until the operator edits.
  const [draft, setDraft] = useState<EnvDraftRow[] | null>(null)
  // Which rows are in edit mode. Presentational only, so it stays out of the
  // draft rows (which are the shared wire shape in lib/envApply).
  const [editingIds, setEditingIds] = useState<ReadonlySet<string>>(new Set())
  const rows = draft ?? toDraftRows(vars)
  const dirty = draft !== null

  const known = useMemo(() => new Set(vars.map((v) => v.key)), [vars])
  const runtimeEnv = useMemo(
    () => Object.fromEntries(Object.entries(detail.env).filter(([k]) => !known.has(k))),
    [detail.env, known],
  )

  const patch = useMemo(() => buildEnvPatch(rows, plan.mode), [rows, plan.mode])
  const problem = useMemo(() => envDraftProblem(rows), [rows])
  const setKeys = Object.keys(patch.set).sort()
  const unsetKeys = [...patch.unset].sort()
  const tierKeys = Object.keys(patch.tiers ?? {}).sort()
  const changeCount = setKeys.length + unsetKeys.length + tierKeys.length
  const canSave = editable && !envPatchIsEmpty(patch) && problem === null && !busy

  const edit = (next: EnvDraftRow[]) => {
    setDraft(next)
  }
  const patchRow = (rowId: string, part: Partial<EnvDraftRow>) => {
    edit(rows.map((r) => (r.id === rowId ? { ...r, ...part } : r)))
  }
  const reset = () => {
    setDraft(null)
    setEditingIds(new Set())
  }

  const submit = () => {
    save.mutate(patch, {
      // Forget the plaintext the moment reef has it (on failure it stays put).
      onSuccess: () => {
        reset()
      },
      onSettled: () => {
        setConfirmSave(false)
      },
    })
  }

  // Names only, never values - this goes into a dialog and a toast.
  const summary = [
    setKeys.length > 0 ? `Set ${setKeys.join(", ")}` : null,
    unsetKeys.length > 0 ? `Remove ${unsetKeys.join(", ")}` : null,
    tierKeys.length > 0 ? `Change visibility of ${tierKeys.join(", ")}` : null,
  ]
    .filter((s): s is string => s !== null)
    .join(". ")

  return (
    <Panel
      icon={<Icon icon={SourceCodeIcon} className="size-3.5" />}
      title="Environment variables"
      meta={
        data ? (
          !editable ? (
            <Chip size="sm" color="neutral">
              read-only
            </Chip>
          ) : (
            <Chip size="sm" color={!readsEnvFile ? "amber" : "green"} dot>
              {!readsEnvFile ? "recreate only" : "applies on restart"}
            </Chip>
          )
        ) : null
      }
    >
      {env.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading environment…</p>
      ) : env.error ? (
        <p className="text-sm text-destructive">
          {env.error instanceof Error ? env.error.message : "Failed to load the environment"}
        </p>
      ) : (
        <>
          <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
            Anything you set here is readable by the agent and by anyone with its web terminal. Use
            scoped, revocable, spend-limited credentials. A <strong>hidden</strong> value is
            write-only: reef stores it but never hands it back, so it shows as dots forever. A{" "}
            <strong>readable</strong> one can be seen again here. New variables default by name -
            anything that looks like a credential starts hidden - and the lock on a row being
            edited overrides that.
          </p>

          {readOnlyCause === "drift" && (
            <p className="mb-3 text-xs leading-relaxed text-warning">
              Reef has no record for this VM (it was discovered in the runtime, not created here),
              so it can't rewrite its environment. What's listed below is complete.
            </p>
          )}
          {readOnlyCause === "degraded" && (
            <p className="mb-3 text-xs leading-relaxed text-warning">
              Reef couldn't read this agent's image, so this list is incomplete: it shows the
              variables reef has written itself, but not the ones baked in when the agent was
              created. Editing is off until that read recovers - a save would fail rather than
              risk pinning stale values. Check that the image is present on the host.
            </p>
          )}

          {editable && (
            <div className="mb-2 flex justify-end">
              <Button
                variant="outline"
                size="xs"
                disabled={busy}
                onClick={() => {
                  // Minted outside the updater: React re-runs updaters.
                  nextRowId.current += 1
                  const rowId = `new:${String(nextRowId.current)}`
                  setEditingIds((prev) => new Set(prev).add(rowId))
                  edit([
                    ...rows,
                    {
                      id: rowId,
                      key: "",
                      value: "",
                      storedLength: null,
                      removed: false,
                      existing: false,
                      tier: null,
                    },
                  ])
                }}
              >
                <Icon icon={Add01Icon} className="size-3.5" />
                Add
              </Button>
            </div>
          )}

          <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
            {rows.length === 0 ? (
              <p className="px-4 py-3.5 text-sm text-muted-foreground">
                No variables of your own yet. Reef&apos;s own wiring is under &quot;Runtime &amp;
                image&quot; below.
              </p>
            ) : (
              <div className="divide-y divide-border/60">
                {rows.map((r) => (
                  <EnvRow
                    key={r.id}
                    row={r}
                    canEdit={editable}
                    busy={busy}
                    editing={editingIds.has(r.id)}
                    onEdit={() => {
                      setEditingIds((prev) => new Set(prev).add(r.id))
                      // A regular value is already on screen, so seed the input
                      // with it and let the operator amend rather than retype.
                      if (r.storedValue != null) patchRow(r.id, { value: r.storedValue })
                    }}
                    onChange={(part) => {
                      patchRow(r.id, part)
                    }}
                    onRemove={() => {
                      if (r.existing) patchRow(r.id, { removed: true })
                      else edit(rows.filter((x) => x.id !== r.id))
                    }}
                    onRestore={() => {
                      patchRow(r.id, { removed: false })
                    }}
                  />
                ))}
              </div>
            )}
          </div>

          {dirty && changeCount > 0 && (
            <div className={cn(CARD, "mt-3 space-y-3 bg-muted/20 p-3")}>
              {plan.offered.length > 1 && (
                <div className="space-y-2">
                  <div className="text-xs font-medium text-foreground">Apply by</div>
                  <div className="inline-flex items-center gap-0.5 rounded-lg border border-border/60 bg-background/40 p-0.5">
                    {plan.offered.map((m) => (
                      <button
                        key={m}
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setMode(m)
                        }}
                        className={cn(
                          "rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40",
                          plan.mode === m
                            ? "bg-card text-foreground shadow-xs"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {MODE_LABEL[m]}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Keyed off the IMAGE, not `offered.length`: a down agent also
                  has a single mode. */}
              {!readsEnvFile && (
                <p className="flex items-start gap-1.5 text-xs leading-relaxed text-warning">
                  <Icon icon={AlertDiamondIcon} className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    This agent's image predates the per-agent env file: it has neither the reader nor
                    the env mount, so reef refuses to write a file the guest could never read and a
                    recreate is the only save that lands. Upgrade the image once (Versions, on the
                    right) - one recreate now, in-place restarts forever after.
                  </span>
                </p>
              )}

              <p className="text-xs leading-relaxed text-muted-foreground">{plan.copy}</p>

              {problem && <p className="text-xs text-destructive">{problem}</p>}

              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  disabled={!canSave}
                  onClick={() => {
                    setConfirmSave(true)
                  }}
                >
                  {busy ? "Saving…" : `Save ${changeCount} change${changeCount === 1 ? "" : "s"}`}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    reset()
                  }}
                >
                  Discard
                </Button>
              </div>
            </div>
          )}

          <div className="mt-4 border-t border-border/40 pt-3">
            <button
              type="button"
              onClick={() => {
                setShowRuntime((s) => !s)
              }}
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <Icon
                icon={ArrowRight01Icon}
                className={cn("size-3.5 transition-transform", showRuntime && "rotate-90")}
              />
              Runtime &amp; image ({Object.keys(runtimeEnv).length})
            </button>
            {showRuntime && (
              <div className="mt-2.5 space-y-2">
                <p className="text-xs text-muted-foreground">
                  Wired in by reef and the image at boot. Not editable here - these are rebuilt from
                  the agent's profile every time it's recreated.
                </p>
                <RuntimeEnvList env={runtimeEnv} />
              </div>
            )}
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirmSave}
        title={`Apply ${changeCount} change${changeCount === 1 ? "" : "s"} to ${id}?`}
        description={`${summary}. ${plan.copy}`}
        confirmLabel={plan.confirmLabel}
        pending={busy}
        onConfirm={submit}
        onCancel={() => {
          setConfirmSave(false)
        }}
      />
    </Panel>
  )
}
