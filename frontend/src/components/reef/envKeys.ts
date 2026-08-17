import type {ReefEnvApplyMode, ReefEnvPatchBody, ReefEnvVar} from "@/lib/reefApi";
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
}

export function toDraftRows(vars: ReefEnvVar[]): EnvDraftRow[] {
    return vars.map((v) => ({
        id: `srv:${v.key}`,
        key: v.key,
        value: null,
        storedLength: v.value_length,
        removed: false,
        existing: true,
    }));
}

export function buildEnvPatch(rows: EnvDraftRow[], apply: ReefEnvApplyMode): ReefEnvPatchBody {
    const set: Record<string, string> = {};
    const unset: string[] = [];
    for (const r of rows) {
        const key = r.key.trim();
        if (key.length === 0) continue;
        if (r.removed) {
            if (r.existing) unset.push(key);
            continue;
        }
        if (r.value !== null) set[key] = r.value;
    }
    return {set, unset, apply};
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
    return Object.keys(body.set).length === 0 && body.unset.length === 0;
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
