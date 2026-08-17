import {ReefRequestError, ReefSandboxBusyError} from "@/lib/reefApi";

// 503 deliberately falls through to reef's own detail, which names the remedy.
export function upgradeErrorMessage(e: unknown): string {
    if (e instanceof ReefSandboxBusyError) return "This agent is busy - try again in a moment";
    if (e instanceof ReefRequestError) {
        if (e.status === 404) return "Reef no longer manages this VM";
        if (e.status === 422) return "This agent can't be upgraded";
        if (e.status === 502) return "Reef runtime unavailable";
    }
    return e instanceof Error ? e.message : "Couldn't upgrade this agent";
}

export function lifecycleErrorMessage(e: unknown, managed: boolean): string {
    if (e instanceof ReefSandboxBusyError) return "This agent is busy - try again in a moment";
    if (e instanceof ReefRequestError) {
        if (e.status === 404) {
            return managed
                ? "This agent's VM is gone - try Start, or Destroy to remove it"
                : "Reef no longer manages this VM";
        }
        if (e.status === 502) return "Reef runtime unavailable";
    }
    return e instanceof Error ? e.message : "Couldn't reach this agent";
}

// Upgrade and Reinstall are one endpoint under two labels: these must not
// disagree about what survives.
export const UPGRADE_TIP =
    "Recreate this agent on the newest image. Workspace, clawbits identity, and access password "
    + 'are preserved; brief downtime. Anything set with "openclaw config set" is NOT preserved - '
    + "use environment variables instead.";
export const REINSTALL_TIP =
    "The same recreate as Upgrade - offered plainly because this agent has never reported its "
    + "versions, so reef can't tell whether it is behind. Workspace, clawbits identity, and access "
    + 'password are preserved; brief downtime. Anything set with "openclaw config set" is NOT '
    + "preserved.";
