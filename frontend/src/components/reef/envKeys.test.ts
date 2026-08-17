import {describe, expect, it} from "vitest";
import {
    buildEnvPatch,
    envApplyOptions,
    envApplyReach,
    envPatchIsEmpty,
    toDraftRows,
    type EnvDraftRow,
} from "./envKeys";

describe("envApplyReach", () => {
    it("reaches the agent now only while it is running and not deliberately stopped", () => {
        expect(envApplyReach("running", "running")).toBe("now");
        expect(envApplyReach("running", null)).toBe("now");
        expect(envApplyReach("running", undefined)).toBe("now");
    });

    it('reads a running agent under a deliberate Stop as "stopping", not "now"', () => {
        expect(envApplyReach("running", "stopped")).toBe("stopping");
    });

    it('is "down" for every non-running state, whatever reef wants', () => {
        for (const state of ["stopped", "failed", "creating"]) {
            for (const desired of ["running", "stopped", null]) {
                expect(envApplyReach(state, desired)).toBe("down");
            }
        }
    });
});

describe("envApplyOptions", () => {
    const RESTART_CAPABLE = ["restart", "recreate"];
    const RECREATE_ONLY = ["recreate"];

    it("offers all three modes when the save reaches the agent now, restart first", () => {
        expect(envApplyOptions(RESTART_CAPABLE, "now")).toEqual(["restart", "recreate", "none"]);
    });

    for (const reach of ["stopping", "down"] as const) {
        it(`forces restart (never "none") on a restart-capable ${reach} agent`, () => {
            expect(envApplyOptions(RESTART_CAPABLE, reach)).toEqual(["restart"]);
        });
    }

    for (const reach of ["now", "stopping", "down"] as const) {
        it(`forces recreate (never "none") on a ${reach} recreate-only agent`, () => {
            expect(envApplyOptions(RECREATE_ONLY, reach)).toEqual(["recreate"]);
        });
    }

    it("treats an unknown/empty apply_modes as recreate-only rather than assuming restart", () => {
        expect(envApplyOptions([], "now")).toEqual(["recreate"]);
        expect(envApplyOptions(["something-new"], "now")).toEqual(["recreate"]);
    });
});

describe("cleared value on an existing row", () => {
    const stored: EnvDraftRow[] = toDraftRows([
        {key: "AGENTPIT_API_KEY", value_length: 32, source: "file"},
    ]);

    it("seeds an existing row with value null, so it contributes nothing", () => {
        expect(stored[0]?.value).toBeNull();
        expect(envPatchIsEmpty(buildEnvPatch(stored, "restart"))).toBe(true);
    });

    it("still allows a deliberate empty value on an ADDED row", () => {
        const added: EnvDraftRow[] = [
            {id: "new:1", key: "EMPTY_ON_PURPOSE", value: "", storedLength: null, removed: false, existing: false},
        ];
        expect(buildEnvPatch(added, "restart").set).toEqual({EMPTY_ON_PURPOSE: ""});
    });
});
