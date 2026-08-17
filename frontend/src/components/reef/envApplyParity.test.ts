// The two env editors transcribe the apply-mode rule separately (reef builds
// without a clawbits checkout). The cross-package import below is the point of
// this file: it runs both copies over every cell.
import {describe, expect, it} from "vitest";
import {envApplyOptions, envApplyReach, envReadOnlyCause} from "./envKeys";
import {
    envApplyOptions as reefApplyOptions,
    envApplyReach as reefApplyReach,
    envReadOnlyCause as reefReadOnlyCause,
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
