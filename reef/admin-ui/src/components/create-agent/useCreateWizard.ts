/**
 * The create-agent wizard's state machine. One decision per step:
 *
 *   type -> model -> options -> connect -> launch
 *
 * The reducer owns ONLY the operator's choices + position; server data
 * (providers, images, the booting VM's detail) stays in queries in the shell,
 * which derives per-step validity from both. Invalidation rules:
 *   • runtime change  -> image tag re-defaults; provider pick survives unless
 *     the new runtime can't consume it (the shell dispatches "invalidate")
 *   • provider change -> model clears (curated lists are per-provider)
 * After launch fires, the rail freezes until the create fails (unfreeze) or the
 * dialog closes.
 */
import { useReducer } from "react"

export type StepId = "type" | "connect" | "model" | "options" | "launch"

export interface WizardState {
  step: StepId
  /** Agent-type name (e.g. "openclaw" | "ironclaw"). null = undecided. */
  runtime: string | null
  /** Image tag pin; null = the type's active image (the select's default). */
  imageTag: string | null
  /** Clawbits link: null = undecided, true = connect (fields below), false =
   *  standalone VM (no clawbits identity). */
  connect: boolean | null
  orgId: string
  signupToken: string
  clawbitsUrl: string
  /** Provider id from the Reef's list, or "none" (skip). null = undecided. */
  providerId: string | null
  /** BYO value per provider id: an API key, or the host URL for ollama. */
  byoValues: Record<string, string>
  /** Bare model id; "" = runtime default. REQUIRED for ollama. */
  model: string
  /** Custom guest env rows (the Options step edits these). */
  envRows: { key: string; value: string }[]
  /** Opt-in capabilities (reef/capabilities.py). Only the ones whose blast radius
   *  leaves the microVM are listed here; everything the VM contains is ungated.
   *  Seeded from DEFAULT_CAPABILITIES; the create always sends this array, so an
   *  unticked box really does produce a bare agent. */
  capabilities: string[]
  /** Create fired: the launch phase is live. */
  launched: boolean
}

export type WizardAction =
  | { type: "pick-runtime"; runtime: string }
  | { type: "set-image"; tag: string | null }
  | { type: "pick-connect"; connect: boolean }
  | { type: "back-to-connect" } // clawbits fields screen -> the card picker
  | { type: "set-clawbits"; field: "orgId" | "signupToken" | "clawbitsUrl"; value: string }
  | { type: "pick-provider"; id: string }
  | { type: "set-byo"; id: string; value: string }
  | { type: "set-model"; model: string }
  | { type: "set-env"; rows: { key: string; value: string }[] }
  | { type: "toggle-capability"; id: string }
  | { type: "goto"; step: StepId }
  | { type: "launch" }
  | { type: "unlaunch" } // create failed -> back to an editable wizard
  | { type: "invalidate-provider" } // shell: pick no longer valid (list/runtime change)

/** The step sequence (fixed - reef is always this reef, always these steps). */
export const STEP_SEQUENCE: StepId[] = ["type", "model", "options", "connect", "launch"]

export function nextStep(state: WizardState): StepId {
  const i = STEP_SEQUENCE.indexOf(state.step)
  return STEP_SEQUENCE[Math.min(i + 1, STEP_SEQUENCE.length - 1)] ?? state.step
}

/** Capabilities ticked when the wizard opens. MIRRORS
 *  reef/capabilities.py DEFAULT_CAPABILITIES - keep the two in sync. */
export const DEFAULT_CAPABILITIES = ["gh", "cron"]

export const INITIAL: WizardState = {
  step: "type",
  runtime: null,
  imageTag: null,
  connect: null,
  orgId: "",
  signupToken: "",
  clawbitsUrl: "",
  providerId: null,
  byoValues: {},
  model: "",
  envRows: [],
  capabilities: [...DEFAULT_CAPABILITIES],
  launched: false,
}

function reduce(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "pick-runtime": {
      const runtime = action.runtime
      // Image pins are per-type - re-default on change.
      const imageTag = state.runtime === runtime ? state.imageTag : null
      return { ...state, runtime, imageTag, step: nextStep({ ...state, step: "type" }) }
    }
    case "set-image":
      return { ...state, imageTag: action.tag }
    case "pick-connect": {
      if (action.connect) {
        // Move to the clawbits-details screen; a "Continue" advances once valid.
        return { ...state, connect: true }
      }
      // Standalone: drop any typed clawbits values. Connect is the last
      // configurable step now - the shell fires the create right after this
      // (its own "launch" dispatch moves the step on).
      return { ...state, connect: false, orgId: "", signupToken: "", clawbitsUrl: "" }
    }
    case "back-to-connect":
      // Return from the details screen to the two cards (keep typed values so a
      // stray back-click doesn't lose input).
      return { ...state, connect: null }
    case "set-clawbits":
      return { ...state, [action.field]: action.value }
    case "pick-provider": {
      if (state.providerId === action.id) return state
      // Curated model lists are per-provider - a new pick clears the model.
      return { ...state, providerId: action.id, model: "" }
    }
    case "set-byo":
      return { ...state, byoValues: { ...state.byoValues, [action.id]: action.value } }
    case "set-model":
      return { ...state, model: action.model }
    case "set-env":
      return { ...state, envRows: action.rows }
    case "toggle-capability": {
      const on = state.capabilities.includes(action.id)
      return {
        ...state,
        capabilities: on
          ? state.capabilities.filter((c) => c !== action.id)
          : [...state.capabilities, action.id],
      }
    }
    case "goto": {
      // Never leave launch once launched (the rail freezes; create-failure
      // dispatches "unlaunch").
      if (state.launched) return state
      return { ...state, step: action.step }
    }
    case "launch":
      return { ...state, step: "launch", launched: true }
    case "unlaunch":
      return { ...state, launched: false }
    case "invalidate-provider":
      return state.providerId === null
        ? state
        : {
            ...state,
            providerId: null,
            model: "",
            step: state.step === "launch" ? state.step : "model",
          }
    default:
      return state
  }
}

export function useCreateWizard() {
  return useReducer(reduce, INITIAL)
}
