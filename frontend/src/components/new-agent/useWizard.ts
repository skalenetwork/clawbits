/**
 * The "Add agent" wizard's state machine. One decision per step:
 *
 *   runtime → connect → launch
 *
 * The reducer owns ONLY the user's choices + position; server data (the signup
 * session, joined agents) stays in queries in the shell, which derives per-step
 * validity from both. After launch fires the rail freezes until the dialog
 * closes.
 */
import {useReducer} from "react";
import type {AgentUser} from "@/lib/api";

export type Runtime = "openclaw" | "ironclaw" | "hermes";
export type StepId = "runtime" | "connect" | "launch";

export const STEPS: StepId[] = ["runtime", "connect", "launch"];

export interface WizardState {
    step: StepId;
    runtime: Runtime | null;
    /** Prompt copied: the launch phase is live. */
    launched: boolean;
}

export type WizardAction =
    | {type: "pick-runtime"; runtime: Runtime}
    | {type: "goto"; step: StepId}
    | {type: "launch"}
    | {type: "unlaunch"};

export function nextStep(state: WizardState): StepId {
    const i = STEPS.indexOf(state.step);
    return STEPS[Math.min(i + 1, STEPS.length - 1)] ?? state.step;
}

/** Step names — the summary rail's tiny overline and the minimized dock
 *  chip's step label. Lives here (not SummaryRail) so component files stay
 *  fast-refreshable (react-refresh/only-export-components). */
export const STEP_TITLES: Record<StepId, string> = {
    runtime: "Type",
    connect: "Connect",
    launch: "Launch",
};

/** Display label for a joined agent — LaunchStep's cards/rows and the dock
 *  chip's "ready" title. */
export function agentLabel(a: AgentUser): string {
    const dn = a.display_name?.trim() ?? "";
    const nk = a.nickname?.trim() ?? "";
    return dn.length > 0 ? dn : nk.length > 0 ? nk : a.agent_id;
}

export const INITIAL: WizardState = {
    step: "runtime",
    runtime: null,
    launched: false,
};

function reduce(state: WizardState, action: WizardAction): WizardState {
    switch (action.type) {
        case "pick-runtime":
            return {...state, runtime: action.runtime, step: nextStep({...state, step: "runtime"})};
        case "goto":
            // Never leave launch once launched (the rail freezes).
            return state.launched ? state : {...state, step: action.step};
        case "launch":
            return {...state, step: "launch", launched: true};
        case "unlaunch":
            return {...state, launched: false};
        default:
            return state;
    }
}

export function useWizard() {
    return useReducer(reduce, INITIAL);
}
