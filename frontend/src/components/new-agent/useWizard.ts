/**
 * The "Add agent" wizard's state machine. One decision per step:
 *
 *   reef: deploy → runtime → model → options → launch
 *   self: deploy → runtime → connect → launch
 *
 * The reducer owns ONLY the user's choices + position; server data (providers,
 * images, joined agents) stays in queries in the shell, which derives per-step
 * validity from both. Invalidation rules (the summary-rail contract, see
 * docs/protocol/AGENT_SETUP_WIZARD_PLAN.md §2.3):
 *   • mode change     → provider pick resets (runtime survives)
 *   • runtime change  → image tag re-defaults; provider pick survives unless
 *     the new runtime can't consume it (the shell dispatches "invalidate")
 *   • provider change → model clears (curated lists are per-provider)
 * After launch fires, the rail freezes until the create fails (unfreeze) or
 * the dialog closes.
 */
import {useReducer} from "react";
import type {AgentUser} from "@/lib/api";

export type Mode = "reef" | "self";
export type Runtime = "openclaw" | "ironclaw" | "hermes";
export type StepId = "deploy" | "runtime" | "model" | "options" | "connect" | "launch";

export interface WizardState {
    step: StepId;
    mode: Mode | null;
    runtime: Runtime | null;
    /** Image tag pin; null = the type's active image (the select's default). */
    imageTag: string | null;
    /** Provider id from the Reef's list, or "none" (skip). null = undecided. */
    providerId: string | null;
    /** BYO value per provider id: an API key, or the host URL for ollama. */
    byoValues: Record<string, string>;
    /** Bare model id; "" = runtime default. REQUIRED for ollama. */
    model: string;
    /** Custom guest env rows (the Launch "Advanced" sheet edits these). */
    envRows: {key: string; value: string}[];
    /** Opt-in capabilities (reef/capabilities.py). Only things that reach OUTSIDE
     *  the agent's VM are listed; everything the VM contains is always on.
     *  Seeded from DEFAULT_CAPABILITIES; the create always sends this array, so
     *  an unticked box really does produce a bare agent. */
    capabilities: string[];
    /** Create fired (reef) / prompt copied (self): the launch phase is live. */
    launched: boolean;
}

export type WizardAction =
    | {type: "pick-mode"; mode: Mode}
    | {type: "pick-runtime"; runtime: Runtime}
    | {type: "set-image"; tag: string | null}
    | {type: "pick-provider"; id: string}
    | {type: "set-byo"; id: string; value: string}
    | {type: "set-model"; model: string}
    | {type: "set-env"; rows: {key: string; value: string}[]}
    | {type: "toggle-capability"; id: string}
    | {type: "goto"; step: StepId}
    | {type: "launch"}
    | {type: "unlaunch"} // create failed → back to an editable wizard
    | {type: "invalidate-provider"}; // shell: pick no longer valid (list/runtime change)

/** The step sequence for a mode (deploy is shared; undecided mode shows deploy only). */
export function stepsFor(mode: Mode | null): StepId[] {
    if (mode === "self") return ["deploy", "runtime", "connect", "launch"];
    return ["deploy", "runtime", "model", "options", "launch"];
}

export function nextStep(state: WizardState): StepId {
    const seq = stepsFor(state.mode);
    const i = seq.indexOf(state.step);
    return seq[Math.min(i + 1, seq.length - 1)] ?? state.step;
}

/** Step names — the summary rail's tiny overline and the minimized dock
 *  chip's step label. Lives here (not SummaryRail) so component files stay
 *  fast-refreshable (react-refresh/only-export-components). */
export const STEP_TITLES: Record<StepId, string> = {
    deploy: "Runs on",
    runtime: "Type",
    model: "Provider",
    options: "Options",
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

/** Capabilities ticked when the wizard opens. MIRRORS
 *  reef/capabilities.py DEFAULT_CAPABILITIES — keep the two in sync. `gh` is on
 *  because reef injects no GitHub token, so the grant is inert until a human
 *  supplies one; `cron` is not, because nothing gates it a second time. */
export const DEFAULT_CAPABILITIES = ["gh"];

export const INITIAL: WizardState = {
    step: "deploy",
    mode: null,
    runtime: null,
    imageTag: null,
    providerId: null,
    byoValues: {},
    model: "",
    envRows: [],
    capabilities: [...DEFAULT_CAPABILITIES],
    launched: false,
};

function reduce(state: WizardState, action: WizardAction): WizardState {
    switch (action.type) {
        case "pick-mode": {
            if (state.mode === action.mode) return state;
            // Advancing is the SHELL's call (a reef pick waits for the token to
            // verify; a revisit must not bounce straight back off the step).
            // Mode round-trip resets the provider decision (the step re-shapes);
            // the runtime pick and typed values survive an accidental toggle.
            return {...state, mode: action.mode, providerId: null};
        }
        case "pick-runtime": {
            const runtime = action.runtime;
            // Image pins are per-type — re-default on change.
            const imageTag = state.runtime === runtime ? state.imageTag : null;
            return {...state, runtime, imageTag, step: nextStep({...state, step: "runtime"})};
        }
        case "set-image":
            return {...state, imageTag: action.tag};
        case "pick-provider": {
            if (state.providerId === action.id) return state;
            // Curated model lists are per-provider — a new pick clears the model.
            return {...state, providerId: action.id, model: ""};
        }
        case "set-byo":
            return {...state, byoValues: {...state.byoValues, [action.id]: action.value}};
        case "set-model":
            return {...state, model: action.model};
        case "toggle-capability": {
            const on = state.capabilities.includes(action.id);
            return {
                ...state,
                capabilities: on
                    ? state.capabilities.filter(c => c !== action.id)
                    : [...state.capabilities, action.id],
            };
        }
        case "set-env":
            return {...state, envRows: action.rows};
        case "goto": {
            // Never jump forward past undecided steps, never leave launch once
            // launched (the rail freezes; create-failure dispatches "unlaunch").
            if (state.launched) return state;
            return {...state, step: action.step};
        }
        case "launch":
            return {...state, step: "launch", launched: true};
        case "unlaunch":
            return {...state, launched: false};
        case "invalidate-provider":
            return state.providerId === null
                ? state
                : {...state, providerId: null, model: "", step: state.step === "launch" ? state.step : "model"};
        default:
            return state;
    }
}

export function useWizard() {
    return useReducer(reduce, INITIAL);
}
