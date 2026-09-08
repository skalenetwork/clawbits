// OpenClaw refuses new agent work when the current async context carries a
// RELEASED root-work store (isGatewaySubordinateWorkAdmissionClosed in the
// gateway bundle), and reports it as "Gateway is draining" even when nothing
// is draining.
//
// Measured on 2026.9.2: inbound channel dispatch runs with
// store={origin:"hooks:gateway-start",released:true}. The host releases that
// root as soon as plugin gateway_start hooks resolve, and an external channel
// plugin's dispatch chain still carries it. Channel start itself is already
// shielded by the host, so the context is picked up after that point.
//
// The host applies this same primitive around its own inbound dispatch in
// ingress-drain (runOutsideGatewayRootWorkAdmission -> dispatchClaimedEvent).
//
// This does not weaken the fence: restartDraining, restartSignalPending and
// suspendPhase are all checked BEFORE the store, so a genuine suspend or
// restart still refuses the work. Only the stale-context false positive goes.

type AdmissionState = {
  currentRootWork?: { exit: <T>(run: () => T) => T };
};

const STATE_KEY = Symbol.for("openclaw.gatewayWorkAdmissionState");

function admissionState(): AdmissionState | undefined {
  return (globalThis as unknown as Record<symbol, AdmissionState | undefined>)[STATE_KEY];
}

export function runOutsideGatewayRootWork<T>(run: () => T): T {
  const rootWork = admissionState()?.currentRootWork;
  return rootWork ? rootWork.exit(run) : run();
}
