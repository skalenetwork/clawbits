import type {ReefEnvApplyMode, ReefEnvPatchBody, ReefEnvTier, ReefEnvVar} from "@/lib/reefApi";
import {ENV_KEY_RE} from "@/components/new-agent/prompts";

export {ENV_KEY_RE};

// Mirror of reef's `_SECRET_KEY` heuristic: decides masking only, never
// validation and never what may be sent.
const SECRET_KEY_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PRIVATE|CRED)/i;

export function looksSecret(key: string): boolean {
    return SECRET_KEY_RE.test(key);
}

const ENV_MAX_COUNT = 32;
const ENV_MAX_KEY_LEN = 128;
const ENV_MAX_VALUE_LEN = 4096;

export interface EnvDraftRow {
    id: string;
    key: string;
    /** null = untouched; `""` is a real, distinct set-but-empty value. */
    value: string | null;
    storedLength: number | null;
    removed: boolean;
    existing: boolean;
    /** null = don't send a tier, so reef keeps the existing one (or applies its
     *  name-based default to a brand-new key). Set only when the user chose. */
    tier: ReefEnvTier | null;
    /** The tier the server reported, so the row can render read-vs-hidden without
     *  guessing. null for a row that does not exist server-side yet. */
    serverTier?: ReefEnvTier | null;
    /** The STORED value, which reef returns only for a regular var. null for a
     *  secret (and for a row with nothing saved yet) - that is the whole point. */
    storedValue?: string | null;
}

/** Reef's own default, mirrored so the UI can show the tier a NEW key will get
 *  before it is saved. Same regex as ``looksSecret`` / reef's ``_SECRET_KEY``. */
export function defaultTierFor(key: string): ReefEnvTier {
    return looksSecret(key) ? "secret" : "regular";
}

/** What a row's tier will BE after saving: the explicit choice, else the server's
 *  current tier, else reef's name-based default. */
export function effectiveTier(row: EnvDraftRow): ReefEnvTier {
    return row.tier ?? row.serverTier ?? defaultTierFor(row.key.trim());
}

export function toDraftRows(vars: ReefEnvVar[]): EnvDraftRow[] {
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
    }));
}

// KEEP IN SYNC with reef/admin-ui/src/lib/envApply.ts - envApplyParity.test.ts
// runs both copies.
//
// A key the operator removed and then re-added is an OVERWRITE, not a removal:
// reef rejects any key present in both `set` and `unset` ("pick one", 422), and
// `set` already carries the new value. Without this, the dialog's own advice for
// emptying a variable - "remove the variable and add it back" - builds a request
// the server always rejects.
//
// `Object.hasOwn`, not `in`: env names are `[A-Za-z_][A-Za-z0-9_]*`, so
// "constructor" is a legal one and `"constructor" in {}` is true - which would
// silently swallow a real removal.
export function reconcileUnset(set: Record<string, string>, removed: readonly string[]): string[] {
    return [...new Set(removed)].filter((k) => !Object.hasOwn(set, k));
}

export function buildEnvPatch(rows: EnvDraftRow[], apply: ReefEnvApplyMode): ReefEnvPatchBody {
    const set: Record<string, string> = {};
    const removed: string[] = [];
    const tiers: Record<string, ReefEnvTier> = {};
    for (const r of rows) {
        const key = r.key.trim();
        if (key.length === 0) continue;
        if (r.removed) {
            if (r.existing) removed.push(key);
            continue;
        }
        // Opening Edit on a regular row seeds the input with the stored value so
        // it can be amended rather than retyped. Re-sending that untouched value
        // would cost the agent a restart for nothing, so only a real change goes.
        // (A secret has no stored value to compare against, so it always sends.)
        if (r.value !== null && r.value !== (r.storedValue ?? null)) set[key] = r.value;
        // Only an explicit choice that actually CHANGES something is sent.
        // Omitting it is what makes an ordinary value edit keep the tier it
        // already had instead of being reclassified by the name heuristic; and
        // skipping a choice equal to the server's keeps a flip-and-flip-back from
        // looking like a pending change.
        if (r.tier !== null && r.tier !== (r.serverTier ?? null)) tiers[key] = r.tier;
    }
    const body: ReefEnvPatchBody = {set, unset: reconcileUnset(set, removed), apply};
    if (Object.keys(tiers).length > 0) body.tiers = tiers;
    return body;
}

export type EnvApplyReach = "now" | "stopping" | "down";

export function envApplyReach(
    state: string,
    desiredState: string | null | undefined,
): EnvApplyReach {
    if (state !== "running") return "down";
    return desiredState === "stopped" ? "stopping" : "now";
}

// KEEP IN SYNC with reef/admin-ui/src/lib/envApply.ts - reef builds without a
// clawbits checkout, so it cannot import this; envApplyParity.test.ts runs both.
export function envApplyOptions(
    applyModes: string[],
    reach: EnvApplyReach,
): [ReefEnvApplyMode, ...ReefEnvApplyMode[]] {
    if (!applyModes.includes("restart")) return ["recreate"];
    if (reach !== "now") return ["restart"];
    return ["restart", "recreate", "none"];
}

// "drift" = no store record, list complete; "degraded" = the image ENV read
// failed, so the list is incomplete and a write would 503.
export type EnvReadOnlyCause = "drift" | "degraded";

export function envReadOnlyCause(editable: boolean, managed: boolean): EnvReadOnlyCause | null {
    if (editable) return null;
    return managed ? "degraded" : "drift";
}

export function envPatchIsEmpty(body: ReefEnvPatchBody): boolean {
    // Tiers count: flipping one is a real change reef will write and report, so
    // ignoring them here would grey out Save on a tier-only edit.
    return (
        Object.keys(body.set).length === 0 &&
        body.unset.length === 0 &&
        Object.keys(body.tiers ?? {}).length === 0
    );
}

export function envDraftProblem(rows: EnvDraftRow[]): string | null {
    const live = rows.filter((r) => !r.removed);
    const keys = live.map((r) => r.key.trim()).filter((k) => k.length > 0);
    if (live.some((r) => r.key.trim().length === 0 && (r.value?.length ?? 0) > 0)) {
        return "Every variable needs a name.";
    }
    if (keys.some((k) => !ENV_KEY_RE.test(k))) {
        return 'Names: letters, digits and "_", no leading digit.';
    }
    if (new Set(keys).size !== keys.length) return "Two variables share a name.";
    if (keys.some((k) => k.length > ENV_MAX_KEY_LEN)) {
        return `Names are limited to ${String(ENV_MAX_KEY_LEN)} characters.`;
    }
    if (live.some((r) => (r.value?.length ?? 0) > ENV_MAX_VALUE_LEN)) {
        return `Values are limited to ${String(ENV_MAX_VALUE_LEN)} characters.`;
    }
    if (keys.length > ENV_MAX_COUNT) {
        return `Reef allows ${String(ENV_MAX_COUNT)} variables per agent.`;
    }
    return null;
}
