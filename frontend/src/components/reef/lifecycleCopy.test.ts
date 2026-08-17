import {describe, expect, it} from "vitest";

import {
    REINSTALL_TIP,
    UPGRADE_TIP,
    lifecycleErrorMessage,
    upgradeErrorMessage,
} from "@/components/reef/lifecycleCopy";
import {ReefRequestError} from "@/lib/reefApi";

// Verbatim from fleet.FleetService._upgrade_locked.
const NO_SPEC_503 =
    "agent-alpha has no container and reef holds no rebuild spec for it, so there is no env to "
    + "carry onto the new image: the credentials and access secret it ran with lived in the "
    + "container that is gone. Delete this agent and create it again.";

describe("upgradeErrorMessage", () => {
    it("hands reef's 503 remedy to the operator instead of a blanket failure", () => {
        const msg = upgradeErrorMessage(new ReefRequestError(503, NO_SPEC_503));
        expect(msg).toBe(NO_SPEC_503);
        expect(msg).toContain("Delete this agent and create it again");
        expect(msg).not.toBe("Reef runtime unavailable");
    });

    it("still reduces a tunnel 502 to one line", () => {
        expect(upgradeErrorMessage(new ReefRequestError(502, "Bad Gateway"))).toBe(
            "Reef runtime unavailable",
        );
    });
});

describe("lifecycleErrorMessage", () => {
    it("promises no rebuild it can't deliver, and names the control that always works", () => {
        const msg = lifecycleErrorMessage(new ReefRequestError(404, "sandbox not found"), true);
        expect(msg).not.toContain("Start rebuilds it");
        expect(msg).toContain("Destroy");
    });
});

describe("recreate tooltips", () => {
    it("agree on what survives, because they are the same call", () => {
        for (const tip of [UPGRADE_TIP, REINSTALL_TIP]) {
            expect(tip).toContain("access password are preserved");
            expect(tip).toContain('"openclaw config set" is NOT preserved');
        }
    });

    it("no longer sells Reinstall as the escape from a VM Start can't rebuild", () => {
        expect(REINSTALL_TIP).not.toContain("Start can't rebuild");
        expect(REINSTALL_TIP).not.toContain("VM is gone");
    });
});
