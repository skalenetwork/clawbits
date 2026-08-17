// KEEP IN SYNC with clawbits' frontend/src/components/reef/envKeys.ts - its
// envApplyParity.test.ts runs both copies and fails on a disagreement.
// Keep this module import-free: that test compiles it inside clawbits' tsconfig.

export type EnvApplyMode = "restart" | "recreate" | "none"

export type EnvApplyReach = "now" | "stopping" | "down"

export function envApplyReach(state: string, desiredState: string | null | undefined): EnvApplyReach {
  if (state !== "running") return "down"
  return desiredState === "stopped" ? "stopping" : "now"
}

export function envApplyOptions(
  applyModes: string[],
  reach: EnvApplyReach,
): [EnvApplyMode, ...EnvApplyMode[]] {
  if (!applyModes.includes("restart")) return ["recreate"]
  if (reach !== "now") return ["restart"]
  return ["restart", "recreate", "none"]
}

// "drift" = no store record, list complete; "degraded" = the image ENV read
// failed, so the list is incomplete and a write would 503.
export type EnvReadOnlyCause = "drift" | "degraded"

export function envReadOnlyCause(editable: boolean, managed: boolean): EnvReadOnlyCause | null {
  if (editable) return null
  return managed ? "degraded" : "drift"
}

// A key the operator removed and then re-added is an OVERWRITE, not a removal:
// reef rejects any key present in both `set` and `unset` ("pick one", 422), and
// `set` already carries the new value. validateDraft deliberately allows a new
// row to reuse a removed key; this is the other half of that carve-out.
//
// `Object.hasOwn`, not `in`: env names are `[A-Za-z_][A-Za-z0-9_]*`, so
// "constructor" is a legal one and `"constructor" in {}` is true - which would
// silently swallow a real removal.
export function reconcileUnset(set: Record<string, string>, removed: readonly string[]): string[] {
  return [...new Set(removed)].filter((k) => !Object.hasOwn(set, k))
}

// ── Draft/diff logic, ported from clawbits' envKeys.ts ──────────────────────
// Everything below is duplicated rather than imported because reef builds
// without a clawbits checkout. envApplyParity.test.ts (in clawbits) compiles
// BOTH copies and fails on any disagreement, so treat the two files as one
// module with two homes.

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

// Mirror of reef's server-side `_SECRET_KEY`.
const SECRET_KEY_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PRIVATE|CRED)/i

export function looksSecret(key: string): boolean {
  return SECRET_KEY_RE.test(key)
}

const ENV_MAX_COUNT = 32
const ENV_MAX_KEY_LEN = 128
const ENV_MAX_VALUE_LEN = 4096

export type EnvTier = "secret" | "regular"

/** Structural, so this module stays import-free (see the header). */
export interface EnvVarLike {
  key: string
  value_length: number
  tier: EnvTier
  value: string | null
}

export interface EnvDraftRow {
  id: string
  key: string
  /** null = untouched; `""` is a real, distinct set-but-empty value. */
  value: string | null
  storedLength: number | null
  removed: boolean
  existing: boolean
  /** null = don't send a tier, so reef keeps the existing one (or applies its
   *  name-based default to a brand-new key). Set only when the user chose. */
  tier: EnvTier | null
  serverTier?: EnvTier | null
  /** The STORED value, which reef returns only for a regular var. */
  storedValue?: string | null
}

/** Reef's own default, mirrored so the UI can show the tier a NEW key will get
 *  before it is saved. */
export function defaultTierFor(key: string): EnvTier {
  return looksSecret(key) ? "secret" : "regular"
}

/** What a row's tier will BE after saving: the explicit choice, else the
 *  server's current tier, else reef's name-based default. */
export function effectiveTier(row: EnvDraftRow): EnvTier {
  return row.tier ?? row.serverTier ?? defaultTierFor(row.key.trim())
}

export function toDraftRows(vars: EnvVarLike[]): EnvDraftRow[] {
  return vars.map((v) => ({
    id: `srv:${v.key}`,
    key: v.key,
    value: null,
    storedLength: v.value_length,
    removed: false,
    existing: true,
    tier: null,
    serverTier: v.tier,
    storedValue: v.value,
  }))
}

export interface EnvPatchLike {
  set: Record<string, string>
  unset: string[]
  apply: EnvApplyMode
  tiers?: Record<string, EnvTier>
}

export function buildEnvPatch(rows: EnvDraftRow[], apply: EnvApplyMode): EnvPatchLike {
  const set: Record<string, string> = {}
  const removed: string[] = []
  const tiers: Record<string, EnvTier> = {}
  for (const r of rows) {
    const key = r.key.trim()
    if (key.length === 0) continue
    if (r.removed) {
      if (r.existing) removed.push(key)
      continue
    }
    // Opening Edit on a regular row seeds the input with the stored value so it
    // can be amended rather than retyped. Re-sending that untouched value would
    // cost the agent a restart for nothing, so only a real change goes.
    if (r.value !== null && r.value !== (r.storedValue ?? null)) set[key] = r.value
    // Only an explicit choice that actually CHANGES something is sent.
    if (r.tier !== null && r.tier !== (r.serverTier ?? null)) tiers[key] = r.tier
  }
  const body: EnvPatchLike = { set, unset: reconcileUnset(set, removed), apply }
  if (Object.keys(tiers).length > 0) body.tiers = tiers
  return body
}

export function envPatchIsEmpty(body: EnvPatchLike): boolean {
  return (
    Object.keys(body.set).length === 0 &&
    body.unset.length === 0 &&
    Object.keys(body.tiers ?? {}).length === 0
  )
}

export function envDraftProblem(rows: EnvDraftRow[]): string | null {
  const live = rows.filter((r) => !r.removed)
  const keys = live.map((r) => r.key.trim()).filter((k) => k.length > 0)
  if (live.some((r) => r.key.trim().length === 0 && (r.value?.length ?? 0) > 0)) {
    return "Every variable needs a name."
  }
  if (keys.some((k) => !ENV_KEY_RE.test(k))) {
    return 'Names: letters, digits and "_", no leading digit.'
  }
  if (new Set(keys).size !== keys.length) return "Two variables share a name."
  if (keys.some((k) => k.length > ENV_MAX_KEY_LEN)) {
    return `Names are limited to ${String(ENV_MAX_KEY_LEN)} characters.`
  }
  if (live.some((r) => (r.value?.length ?? 0) > ENV_MAX_VALUE_LEN)) {
    return `Values are limited to ${String(ENV_MAX_VALUE_LEN)} characters.`
  }
  if (keys.length > ENV_MAX_COUNT) {
    return `Reef allows ${String(ENV_MAX_COUNT)} variables per agent.`
  }
  return null
}
