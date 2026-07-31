/**
 * The always-visible summary of past choices — and the wizard's stepper.
 * Centered under the title, one chip per step of the current mode's sequence:
 * completed chips carry the chosen value (icon over a tiny label) and jump
 * back on click; the current step is highlighted (and the only one with a
 * full-color icon — others gray out); steps not yet reached render as muted
 * ghost labels so the whole path stays readable. After launch the rail
 * freezes (dimmed, non-interactive) until failure unfreezes it.
 */
import type {ReactNode} from "react";
import {
    Comment02Icon as SkipGlyph,
    CpuIcon as Chip,
    Settings02Icon as Sliders,
} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import {cn} from "@/lib/utils";
import type {ReefProvider} from "@/lib/reefApi";
import {MaskIcon} from "./bits";
import {providerBrand} from "./brands";
import {stepsFor, STEP_TITLES, type Runtime, type StepId, type WizardState} from "./useWizard";

// Chip icons keep their brand colors (deploy marks + AI providers); ollama's
// and nearai's marks are monochrome by design and the utility icons stay
// neutral.
const REEF_TINT = "text-[#FF8781]";
const SELF_TINT = "text-[#6260ec]";
const CONNECT_TINT = "text-[#0EA5E9]";
// The Hermes mark renders in plain ink (black / white by theme), not a brand
// colour — the silhouette is the brand.
const HERMES_TINT = "text-foreground";
const PROVIDER_TINTS: Record<string, string> = {
    anthropic: "text-[#D97757]",
    openai: "text-[#10A37F]",
    gemini: "text-[#4285F4]",
};

/** The runtime chip's mark + name. OpenClaw/IronClaw ship colour rasters; the
 *  Hermes mark is a monochrome silhouette, so it tints via MaskIcon. */
const RUNTIME_CHIPS: Record<Runtime, {title: string; icon: ReactNode}> = {
    openclaw: {
        title: "OpenClaw",
        icon: <img src="/openclaw.png" alt="" className="size-6 rounded-[3px] object-contain"/>,
    },
    ironclaw: {
        title: "IronClaw",
        icon: <img src="/ironclaw.webp" alt="" className="size-6 rounded-[3px] object-contain"/>,
    },
    hermes: {
        title: "Hermes",
        icon: <MaskIcon src="/hermes.svg" className={cn("size-6", HERMES_TINT)}/>,
    },
};

function chipValue(
    step: StepId,
    state: WizardState,
    providers: ReefProvider[] | null,
    passed: boolean,
): {icon: React.ReactNode; label: string} | null {
    switch (step) {
        case "deploy":
            if (!state.mode) return null;
            return state.mode === "reef"
                ? {icon: <MaskIcon src="/reef.svg" className={cn("size-6", REEF_TINT)}/>, label: "Reef"}
                : {icon: <MaskIcon src="/server4-filled.svg" className={cn("size-6", SELF_TINT)}/>, label: "Self-hosted"};
        case "runtime": {
            if (!state.runtime) return null;
            const {title, icon} = RUNTIME_CHIPS[state.runtime];
            return {
                icon,
                label: state.imageTag ? `${title} · ${state.imageTag.split(":").pop() ?? ""}` : title,
            };
        }
        case "model": {
            if (!state.providerId) return null;
            if (state.providerId === "none") {
                return {icon: <Icon icon={SkipGlyph} className="size-6"/>, label: "Model later"};
            }
            const p = providers?.find(x => x.id === state.providerId);
            const {Glyph} = providerBrand(state.providerId);
            const isCodex = state.providerId === "openai-codex";
            const tint = PROVIDER_TINTS[state.providerId];
            return {
                icon: Glyph ? <Glyph className={cn("size-6", tint)}/> : <Icon icon={Chip} className="size-6"/>,
                // Just the provider — the model choice stays the Options step's
                // detail. The subscription card's full label is long for a chip.
                label: isCodex ? "ChatGPT" : (p?.label ?? state.providerId),
            };
        }
        case "options": {
            const n = state.envRows.filter(r => r.key.trim().length > 0).length;
            if (n > 0) {
                return {icon: <Icon icon={Sliders} className="size-6"/>, label: `${String(n)} env var${n > 1 ? "s" : ""}`};
            }
            // Nothing extra picked: only reads "Defaults" once the step is behind us.
            return passed ? {icon: <Icon icon={Sliders} className="size-6"/>, label: "Defaults"} : null;
        }
        case "connect":
            return state.launched
                ? {icon: <MaskIcon src="/cloud-connect-filled.svg" className={cn("size-6", CONNECT_TINT)}/>, label: "Prompt copied"}
                : null;
        default:
            return null;
    }
}

export function SummaryRail({
    state,
    frozen,
    providers,
    onGoto,
}: {
    state: WizardState;
    frozen: boolean;
    providers: ReefProvider[] | null;
    onGoto: (step: StepId) => void;
}) {
    // Launch isn't a step to navigate — reaching it just locks the rail
    // (every chip freezes as the record of what was chosen).
    const seq = stepsFor(state.mode).filter(s => s !== "launch");
    const currentIdx = state.step === "launch" ? seq.length : seq.indexOf(state.step);
    return (
        <div
            className={cn(
                "flex min-h-9 flex-wrap items-center justify-center gap-2 transition-opacity",
                frozen && "pointer-events-none opacity-60",
            )}
            aria-label="Setup progress"
        >
            {seq.map((step, i) => {
                const value = chipValue(step, state, providers, i < currentIdx);
                const isCurrent = i === currentIdx;
                const reachable = value !== null || i < currentIdx;
                if (value === null && !isCurrent && !reachable) {
                    // Not reached yet — a ghost label keeps the whole path readable.
                    return (
                        <span key={step} className="flex items-center gap-2">
                            {i > 0 && <RailTick/>}
                            <span className="px-1.5 text-xs font-medium text-foreground/35">
                                {STEP_TITLES[step]}
                            </span>
                        </span>
                    );
                }
                return (
                    <span key={step} className="flex items-center gap-2">
                        {i > 0 && <RailTick/>}
                        {/* Borderless, button-like: plain at rest, ghost wash on
                            hover, press-in on click; the current step wears the
                            pressed look. */}
                        <button
                            type="button"
                            disabled={frozen || isCurrent}
                            onClick={() => { onGoto(step); }}
                            className={cn(
                                "flex h-12 items-center gap-2.5 rounded-lg px-4 text-sm font-semibold transition-[background-color,color,transform] duration-150 active:scale-95",
                                isCurrent
                                    ? "bg-foreground/[0.08] text-foreground"
                                    : "text-foreground/70 hover:bg-foreground/[0.07] hover:text-foreground",
                            )}
                        >
                            {value ? (
                                <>
                                    {/* Chosen steps stay in full brand color. */}
                                    <span className="flex shrink-0 items-center">
                                        {value.icon}
                                    </span>
                                    {/* Tiny overline names the decision; the value sits under it.
                                        Keyed by the label so a re-default re-animates in. */}
                                    <span className="flex flex-col items-start gap-0.5 leading-none">
                                        <span className="text-[10px] font-medium opacity-50">
                                            {STEP_TITLES[step]}
                                        </span>
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
                );
            })}
        </div>
    );
}

function RailTick() {
    return <span className="h-4 w-px shrink-0 bg-foreground/15"/>;
}
