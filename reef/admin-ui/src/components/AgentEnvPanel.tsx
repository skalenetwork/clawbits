import { useMemo, useRef, useState } from "react"
import { AlertDiamondIcon, ArrowRight01Icon, SourceCodeIcon } from "@hugeicons/core-free-icons"
import type { EnvApplyMode, EnvVar, SandboxDetail } from "@/lib/api"
import {
  envApplyOptions,
  envApplyReach,
  envReadOnlyCause,
  type EnvApplyReach,
} from "@/lib/envApply"
import { useAgentEnv, useEnvActions } from "@/lib/queries"
import { cn } from "@/lib/utils"
import { CARD, Chip, Panel, RuntimeEnvList } from "@/components/detail-bits"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { Icon } from "@/components/Icon"
import { Button } from "@/components/ui/button"
import { AddEnvRowButton, ENV_KEY_RE, EnvVarRow } from "@/components/create-agent/bits"

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

interface DraftRow {
  id: number
  key: string
  value: string
}

// Every plaintext the operator types lives here: never lifted into a parent,
// never written to the query cache.
interface Draft {
  /** Existing key -> replacement value; empty = untouched, not "set to empty".
   *  (On a new row in `rows`, empty really is an empty value.) */
  edits: Record<string, string>
  rows: DraftRow[]
  removed: string[]
}

const EMPTY_DRAFT: Draft = { edits: {}, rows: [], removed: [] }

const omitKey = (map: Record<string, string>, key: string): Record<string, string> =>
  Object.fromEntries(Object.entries(map).filter(([k]) => k !== key))

const describeValue = (v: EnvVar): string =>
  v.value_length === 0 ? "currently empty" : `${v.value_length} characters, hidden`

// Shape only - reserved-key rules stay server-side and come back as a 422.
function validateDraft(draft: Draft, known: Set<string>): string | null {
  const named = draft.rows.filter((r) => r.key.trim().length > 0)
  if (draft.rows.some((r) => r.key.trim().length === 0 && r.value.length > 0)) {
    return "Every new variable needs a name."
  }
  const badName = named.find((r) => !ENV_KEY_RE.test(r.key.trim()))
  if (badName) return 'Names: a letter or "_" first, then letters, digits and "_".'
  const keys = named.map((r) => r.key.trim())
  const dupe = keys.find((k, i) => keys.indexOf(k) !== i)
  if (dupe) return `${dupe} is on two new rows.`
  const collision = keys.find((k) => known.has(k) && !draft.removed.includes(k))
  if (collision) return `${collision} is already set above - edit it there instead.`
  return null
}

/** The per-agent user env editor: names and lengths only, saved as one PATCH. */
export function AgentEnvPanel({ detail }: { detail: SandboxDetail }) {
  const id = detail.sandbox_id
  const env = useAgentEnv(id)
  const { save } = useEnvActions(id)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [mode, setMode] = useState<EnvApplyMode | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [confirmSave, setConfirmSave] = useState(false)
  const [showRuntime, setShowRuntime] = useState(false)
  // Row identity must outlive re-ordering; an array index would not.
  const nextRowId = useRef(0)

  const data = env.data
  const vars = data?.vars ?? []
  const editable = data?.editable ?? false
  const modes = data?.apply_modes ?? []
  const state = data?.state ?? detail.state
  const readsEnvFile = modes.includes("restart")
  const reach = envApplyReach(state, data?.desired_state)
  // `detail.managed` is the `rec is not None` half of the server's `editable`.
  const readOnlyCause = data ? envReadOnlyCause(editable, detail.managed) : null
  const plan = applyPlan(
    {
      reach,
      applyModes: modes,
      revives: data?.desired_state === "running",
    },
    mode,
  )
  const busy = save.isPending

  const known = useMemo(() => new Set(vars.map((v) => v.key)), [vars])
  const runtimeEnv = useMemo(
    () => Object.fromEntries(Object.entries(detail.env).filter(([k]) => !known.has(k))),
    [detail.env, known],
  )

  const setMap = useMemo(() => {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(draft.edits)) {
      // Blank = untouched (see Draft.edits).
      if (v.length > 0 && !draft.removed.includes(k)) out[k] = v
    }
    for (const r of draft.rows) {
      const k = r.key.trim()
      if (k.length > 0) out[k] = r.value
    }
    return out
  }, [draft])

  const setKeys = Object.keys(setMap).sort()
  const unsetKeys = [...draft.removed].sort()
  const changeCount = setKeys.length + unsetKeys.length
  const problem = useMemo(() => validateDraft(draft, known), [draft, known])
  const canSave = editable && changeCount > 0 && problem === null && !busy

  const submit = () => {
    save.mutate(
      { set: setMap, unset: unsetKeys, apply: plan.mode },
      {
        // Forget the plaintext the moment reef has it (on failure it stays put).
        onSuccess: () => {
          setDraft(EMPTY_DRAFT)
        },
        onSettled: () => {
          setConfirmSave(false)
        },
      },
    )
  }

  // Names only, never values - this goes into a dialog and a toast.
  const summary = [
    setKeys.length > 0 ? `Set ${setKeys.join(", ")}` : null,
    unsetKeys.length > 0 ? `Remove ${unsetKeys.join(", ")}` : null,
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
            scoped, revocable, spend-limited credentials. Reef never shows a value back - after
            saving you see the name and the length only, so leaving a value box empty means "keep
            what's there". To clear one, remove it.
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

          <div className="space-y-2.5">
            {vars.length === 0 && draft.rows.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No variables of your own yet. Reef's own wiring is under "Runtime &amp; image" below.
              </p>
            )}

            {vars.map((v) =>
              draft.removed.includes(v.key) ? (
                <RemovedRow
                  key={v.key}
                  name={v.key}
                  disabled={busy}
                  onUndo={() => {
                    setDraft((d) => ({ ...d, removed: d.removed.filter((k) => k !== v.key) }))
                  }}
                />
              ) : (
                <div key={v.key} className="space-y-1">
                  <EnvVarRow
                    row={{ key: v.key, value: draft.edits[v.key] ?? "" }}
                    disabled={!editable || busy}
                    lockKey
                    valuePlaceholder={describeValue(v)}
                    onChange={(next) => {
                      setDraft((d) => ({ ...d, edits: { ...d.edits, [v.key]: next.value } }))
                    }}
                    onRemove={() => {
                      setConfirmRemove(v.key)
                    }}
                  />
                  {(draft.edits[v.key]?.length ?? 0) > 0 && (
                    <div className="flex items-center gap-2 pl-1 text-[11px] text-muted-foreground">
                      <span>New value staged - nothing is sent until you save.</span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setDraft((d) => ({ ...d, edits: omitKey(d.edits, v.key) }))
                        }}
                        className="font-medium underline-offset-2 transition-colors hover:text-foreground hover:underline disabled:opacity-50"
                      >
                        Revert
                      </button>
                    </div>
                  )}
                </div>
              ),
            )}

            {draft.rows.map((r) => (
              <EnvVarRow
                key={r.id}
                row={r}
                disabled={!editable || busy}
                onChange={(next) => {
                  setDraft((d) => ({
                    ...d,
                    rows: d.rows.map((x) => (x.id === r.id ? { ...x, ...next } : x)),
                  }))
                }}
                onRemove={() => {
                  setDraft((d) => ({ ...d, rows: d.rows.filter((x) => x.id !== r.id) }))
                }}
              />
            ))}

            {editable && (
              <AddEnvRowButton
                disabled={busy}
                onClick={() => {
                  // Minted outside the updater: React re-runs updaters.
                  const rowId = nextRowId.current++
                  setDraft((d) => ({ ...d, rows: [...d.rows, { id: rowId, key: "", value: "" }] }))
                }}
              />
            )}
          </div>

          {changeCount > 0 && (
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
                    setDraft(EMPTY_DRAFT)
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
        open={confirmRemove !== null}
        title={`Remove ${confirmRemove ?? ""}?`}
        description={`${confirmRemove ?? ""} is dropped from ${id}'s environment when you save. Nothing has been sent yet - you can undo it until then.`}
        confirmLabel="Stage removal"
        onConfirm={() => {
          const key = confirmRemove
          if (key !== null) {
            setDraft((d) => ({
              ...d,
              edits: omitKey(d.edits, key),
              removed: d.removed.includes(key) ? d.removed : [...d.removed, key],
            }))
          }
          setConfirmRemove(null)
        }}
        onCancel={() => {
          setConfirmRemove(null)
        }}
      />

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

function RemovedRow({
  name,
  disabled,
  onUndo,
}: {
  name: string
  disabled: boolean
  onUndo: () => void
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
      <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-muted-foreground line-through">
        {name}
      </span>
      <span className="shrink-0 text-[11px] text-destructive">removed on save</span>
      <button
        type="button"
        disabled={disabled}
        onClick={onUndo}
        className="shrink-0 text-[11px] font-medium text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline disabled:opacity-50"
      >
        Undo
      </button>
    </div>
  )
}
