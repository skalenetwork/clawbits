/**
 * The always-visible summary of past choices - and the wizard's stepper.
 * Centered under the title, one chip per step: completed chips carry the chosen
 * value (icon over a tiny label) and jump back on click; the current step is
 * highlighted; steps not yet reached render as muted ghost labels so the whole
 * path stays readable. After launch the rail freezes (dimmed, non-interactive)
 * until failure unfreezes it.
 */
import { CubeIcon, Comment02Icon, Settings02Icon } from "@hugeicons/core-free-icons"
import { agentMeta } from "@/lib/agentTypes"
import { ClawbitsIcon } from "@/components/agent-icons"
import { Icon } from "@/components/Icon"
import type { ProviderInfo } from "@/lib/api"
import { cn } from "@/lib/utils"
import { providerBrand, PROVIDER_TINTS } from "./brands"
import { STEP_SEQUENCE, type StepId, type WizardState } from "./useCreateWizard"

/** Doubles as the chip's tiny overline label above the chosen value. */
const STEP_TITLES: Record<StepId, string> = {
  type: "Type",
  connect: "Connect",
  model: "Provider",
  options: "Options",
  launch: "Launch",
}

function chipValue(
  step: StepId,
  state: WizardState,
  providers: ProviderInfo[] | null,
  passed: boolean,
): { icon: React.ReactNode; label: string } | null {
  switch (step) {
    case "type": {
      if (!state.runtime) return null
      const meta = agentMeta(state.runtime)
      const tag = state.imageTag ? state.imageTag.split(":").pop() ?? "" : ""
      return {
        icon: <meta.Icon className="size-6" />,
        label: tag ? `${meta.label} · ${tag}` : meta.label,
      }
    }
    case "connect": {
      if (state.connect === null) return null
      if (state.connect === false) {
        return { icon: <Icon icon={CubeIcon} className="size-6" />, label: "Standalone" }
      }
      // Org id is long and noisy in the rail - just name the choice.
      return { icon: <ClawbitsIcon className="size-6" />, label: "Clawbits" }
    }
    case "model": {
      if (!state.providerId) return null
      if (state.providerId === "none") {
        return { icon: <Icon icon={Comment02Icon} className="size-6" />, label: "Model later" }
      }
      const p = providers?.find((x) => x.id === state.providerId)
      const { Glyph } = providerBrand(state.providerId)
      const isCodex = state.providerId === "openai-codex"
      const tint = PROVIDER_TINTS[state.providerId]
      return {
        icon: Glyph ? (
          <Glyph className={cn("size-6", tint)} />
        ) : (
          <Icon icon={Comment02Icon} className="size-6" />
        ),
        // Just the provider - the model choice stays the Options step's detail.
        // The subscription card's full label is long for a chip.
        label: isCodex ? "ChatGPT" : (p?.label ?? state.providerId),
      }
    }
    case "options": {
      const n = state.envRows.filter((r) => r.key.trim().length > 0).length
      if (n > 0) {
        return {
          icon: <Icon icon={Settings02Icon} className="size-6" />,
          label: `${String(n)} env var${n > 1 ? "s" : ""}`,
        }
      }
      // Nothing extra picked: only reads "Defaults" once the step is behind us.
      return passed
        ? { icon: <Icon icon={Settings02Icon} className="size-6" />, label: "Defaults" }
        : null
    }
    default:
      return null
  }
}

export function SummaryRail({
  state,
  frozen,
  providers,
  onGoto,
}: {
  state: WizardState
  frozen: boolean
  providers: ProviderInfo[] | null
  onGoto: (step: StepId) => void
}) {
  // Launch isn't a step to navigate - reaching it just locks the rail (every
  // chip freezes as the record of what was chosen).
  const seq = STEP_SEQUENCE.filter((s) => s !== "launch")
  const currentIdx = state.step === "launch" ? seq.length : seq.indexOf(state.step)
  return (
    <div
      className={cn(
        "flex min-h-9 flex-wrap items-center justify-center gap-2 transition-opacity",
        frozen && "pointer-events-none opacity-60",
      )}
      aria-label="Setup progress"
    >
      {seq.map((step, i) => {
        const value = chipValue(step, state, providers, i < currentIdx)
        const isCurrent = i === currentIdx
        const reachable = value !== null || i < currentIdx
        if (value === null && !isCurrent && !reachable) {
          // Not reached yet - a ghost label keeps the whole path readable.
          return (
            <span key={step} className="flex items-center gap-2">
              {i > 0 && <RailTick />}
              <span className="px-1.5 text-xs font-medium text-foreground/35">
                {STEP_TITLES[step]}
              </span>
            </span>
          )
        }
        return (
          <span key={step} className="flex items-center gap-2">
            {i > 0 && <RailTick />}
            <button
              type="button"
              disabled={frozen || isCurrent}
              onClick={() => {
                onGoto(step)
              }}
              className={cn(
                "flex h-12 items-center gap-2.5 rounded-lg px-4 text-sm font-semibold transition-[background-color,color,transform] duration-150 active:scale-95",
                isCurrent
                  ? "bg-foreground/[0.08] text-foreground"
                  : "text-foreground/70 hover:bg-foreground/[0.07] hover:text-foreground",
              )}
            >
              {value ? (
                <>
                  <span className="flex shrink-0 items-center">{value.icon}</span>
                  <span className="flex flex-col items-start gap-0.5 leading-none">
                    <span className="text-[10px] font-medium opacity-50">{STEP_TITLES[step]}</span>
                    <span key={value.label} className="animate-in fade-in duration-300">
                      {value.label}
                    </span>
                  </span>
                </>
              ) : (
                <span className="text-base">{STEP_TITLES[step]}</span>
              )}
            </button>
          </span>
        )
      })}
    </div>
  )
}

function RailTick() {
  return <span className="h-4 w-px shrink-0 bg-foreground/15" />
}
