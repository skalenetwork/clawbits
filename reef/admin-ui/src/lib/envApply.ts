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
