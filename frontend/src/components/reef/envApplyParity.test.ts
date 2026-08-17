// The two env editors transcribe the apply-mode rule separately (reef builds
// without a clawbits checkout). The cross-package import below is the point of
// this file: it runs both copies over every cell.
import {describe, expect, it} from "vitest";
import type {ReefEnvPatchBody} from "@/lib/reefApi";
import {
    buildEnvPatch,
    defaultTierFor,
    envApplyOptions,
    envApplyReach,
    envDraftProblem,
    envPatchIsEmpty,
    envReadOnlyCause,
    effectiveTier,
    reconcileUnset,
    toDraftRows,
    type EnvDraftRow,
} from "./envKeys";
import {
    buildEnvPatch as reefBuildEnvPatch,
    defaultTierFor as reefDefaultTierFor,
    envApplyOptions as reefApplyOptions,
    envApplyReach as reefApplyReach,
    envDraftProblem as reefDraftProblem,
    envPatchIsEmpty as reefPatchIsEmpty,
    envReadOnlyCause as reefReadOnlyCause,
    effectiveTier as reefEffectiveTier,
    reconcileUnset as reefReconcileUnset,
    toDraftRows as reefToDraftRows,
    type EnvDraftRow as ReefEnvDraftRow,
} from "../../../../reef/admin-ui/src/lib/envApply";

const STATES = ["running", "stopped", "failed", "creating"];
const DESIRED: (string | null)[] = ["running", "stopped", null];
const IMAGES: {label: string; modes: string[]}[] = [
    {label: "restart-capable", modes: ["restart", "recreate"]},
    {label: "recreate-only", modes: ["recreate"]},
];

interface Cell {
    state: string;
    desired: string | null;
    image: string;
    clawbits: string;
    reef: string;
}

function cells(): Cell[] {
    const out: Cell[] = [];
    for (const state of STATES) {
        for (const desired of DESIRED) {
            for (const image of IMAGES) {
                out.push({
                    state,
                    desired,
                    image: image.label,
                    clawbits: envApplyOptions(image.modes, envApplyReach(state, desired)).join("/"),
                    reef: reefApplyOptions(image.modes, reefApplyReach(state, desired)).join("/"),
                });
            }
        }
    }
    return out;
}

describe("clawbits ManageEnvDialog vs reef admin-ui AgentEnvPanel", () => {
    it("offers the identical modes, in the identical order, in every cell", () => {
        const disagreed = cells().filter((c) => c.clawbits !== c.reef);
        expect(disagreed).toEqual([]);
    });

    it("computes the identical reach in every cell", () => {
        for (const state of STATES) {
            for (const desired of DESIRED) {
                expect(reefApplyReach(state, desired)).toBe(envApplyReach(state, desired));
            }
        }
    });

    it("pins the agreed table", () => {
        const table = cells().map((c) => `${c.state}/${String(c.desired)}/${c.image} -> ${c.clawbits}`);
        expect(table).toEqual([
            "running/running/restart-capable -> restart/recreate/none",
            "running/running/recreate-only -> recreate",
            "running/stopped/restart-capable -> restart",
            "running/stopped/recreate-only -> recreate",
            "running/null/restart-capable -> restart/recreate/none",
            "running/null/recreate-only -> recreate",
            "stopped/running/restart-capable -> restart",
            "stopped/running/recreate-only -> recreate",
            "stopped/stopped/restart-capable -> restart",
            "stopped/stopped/recreate-only -> recreate",
            "stopped/null/restart-capable -> restart",
            "stopped/null/recreate-only -> recreate",
            "failed/running/restart-capable -> restart",
            "failed/running/recreate-only -> recreate",
            "failed/stopped/restart-capable -> restart",
            "failed/stopped/recreate-only -> recreate",
            "failed/null/restart-capable -> restart",
            "failed/null/recreate-only -> recreate",
            "creating/running/restart-capable -> restart",
            "creating/running/recreate-only -> recreate",
            "creating/stopped/restart-capable -> restart",
            "creating/stopped/recreate-only -> recreate",
            "creating/null/restart-capable -> restart",
            "creating/null/recreate-only -> recreate",
        ]);
    });

    // Both editors let the operator remove a key and re-add it (that is the only
    // way to blank a value). Both must therefore drop it from `unset`, or reef
    // 422s with "in both set and unset; pick one".
    it("reconciles a removed-then-re-added key identically", () => {
        const CASES: {set: Record<string, string>; removed: string[]}[] = [
            {set: {K: ""}, removed: ["K"]},
            {set: {K: "new"}, removed: ["K"]},
            {set: {}, removed: ["K"]},
            {set: {B: "x"}, removed: ["A", "B", "C"]},
            {set: {}, removed: ["A", "A"]},
            {set: {}, removed: ["constructor", "toString"]},
            {set: {}, removed: []},
        ];
        for (const c of CASES) {
            expect(reefReconcileUnset(c.set, c.removed)).toEqual(reconcileUnset(c.set, c.removed));
        }
        expect(reconcileUnset({K: ""}, ["K"])).toEqual([]);
    });

    // The two env editors are now the same editor in two homes: clawbits' agent
    // Manage section and reef's operator panel. Everything below runs BOTH copies
    // over the same input, so a change to one that is not made to the other fails
    // here rather than shipping as a behaviour difference between the two UIs.
    const ROWS: EnvDraftRow[] = [
        {id: "srv:PUBLIC_URL", key: "PUBLIC_URL", value: null, storedLength: 14,
         removed: false, existing: true, tier: null, serverTier: "regular",
         storedValue: "https://x.test"},
        {id: "srv:SESSION_SECRET", key: "SESSION_SECRET", value: "new", storedLength: 7,
         removed: false, existing: true, tier: null, serverTier: "secret", storedValue: null},
        {id: "srv:GONE", key: "GONE", value: null, storedLength: 3,
         removed: true, existing: true, tier: null, serverTier: "secret", storedValue: null},
        {id: "new:1", key: "ALGOLIA_APP_ID", value: "abc", storedLength: null,
         removed: false, existing: false, tier: null},
        {id: "new:2", key: "FORCED", value: "v", storedLength: null,
         removed: false, existing: false, tier: "secret"},
    ];

    it("builds the identical patch from the identical draft", () => {
        expect(reefBuildEnvPatch(ROWS as ReefEnvDraftRow[], "restart")).toEqual(
            buildEnvPatch(ROWS, "restart"),
        );
        // ...and the patch is the one we mean: an untouched regular value is not
        // re-sent, a removal is unset, an explicit tier rides along.
        expect(buildEnvPatch(ROWS, "restart")).toEqual({
            set: {SESSION_SECRET: "new", ALGOLIA_APP_ID: "abc", FORCED: "v"},
            unset: ["GONE"],
            apply: "restart",
            tiers: {FORCED: "secret"},
        });
    });

    it("agrees on the name-based tier default", () => {
        for (const key of [
            "ALGOLIA_APP_ID", "PUBLIC_URL", "STRIPE_SECRET_KEY", "GH_TOKEN",
            "DB_PASSWORD", "MY_PRIVATE_THING", "AWS_CRED", "PLAIN", "passphrase",
        ]) {
            expect(reefDefaultTierFor(key)).toBe(defaultTierFor(key));
        }
        expect(defaultTierFor("ALGOLIA_APP_ID")).toBe("regular");
        expect(defaultTierFor("STRIPE_SECRET_KEY")).toBe("secret");
    });

    it("resolves the effective tier identically", () => {
        for (const r of ROWS) {
            expect(reefEffectiveTier(r)).toBe(effectiveTier(r));
        }
    });

    it("maps server vars to draft rows identically", () => {
        const vars = [
            {key: "A", value_length: 3, source: "file", tier: "regular" as const, value: "abc"},
            {key: "B", value_length: 9, source: "container", tier: "secret" as const, value: null},
        ];
        expect(reefToDraftRows(vars)).toEqual(toDraftRows(vars));
    });

    it("reports the identical draft problem, including none", () => {
        const cases: EnvDraftRow[][] = [
            ROWS,
            [{id: "n", key: "1BAD", value: "v", storedLength: null, removed: false, existing: false, tier: null}],
            [{id: "n", key: "", value: "v", storedLength: null, removed: false, existing: false, tier: null}],
            [{id: "a", key: "DUP", value: "v", storedLength: null, removed: false, existing: false, tier: null},
             {id: "b", key: "DUP", value: "w", storedLength: null, removed: false, existing: false, tier: null}],
        ];
        for (const rows of cases) {
            expect(reefDraftProblem(rows as ReefEnvDraftRow[])).toBe(envDraftProblem(rows));
        }
    });

    it("agrees on when a patch is empty (tier-only changes count)", () => {
        const cases: ReefEnvPatchBody[] = [
            {set: {}, unset: [], apply: "restart"},
            {set: {}, unset: [], apply: "restart", tiers: {A: "secret"}},
            {set: {A: "v"}, unset: [], apply: "restart"},
        ];
        for (const c of cases) expect(reefPatchIsEmpty(c)).toBe(envPatchIsEmpty(c));
        expect(envPatchIsEmpty({set: {}, unset: [], apply: "restart"})).toBe(true);
        // A tier-only change is a real change, so it must NOT read as empty.
        expect(
            envPatchIsEmpty({set: {}, unset: [], apply: "restart", tiers: {A: "secret"}}),
        ).toBe(false);
    });

    it("reads the same cause behind a read-only panel", () => {
        for (const editable of [true, false]) {
            for (const managed of [true, false]) {
                expect(reefReadOnlyCause(editable, managed)).toBe(envReadOnlyCause(editable, managed));
            }
        }
        expect(envReadOnlyCause(false, false)).toBe("drift");
        expect(envReadOnlyCause(false, true)).toBe("degraded");
        expect(envReadOnlyCause(true, true)).toBeNull();
    });
});
