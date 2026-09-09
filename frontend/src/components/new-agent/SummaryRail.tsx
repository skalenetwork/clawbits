/**
 * The always-visible summary of past choices — and the wizard's stepper.
 * Centered under the title, one chip per step:
 * completed chips carry the chosen value (icon over a tiny label) and jump
 * back on click; the current step is highlighted (and the only one with a
 * full-color icon — others gray out); steps not yet reached render as muted
 * ghost labels so the whole path stays readable. After launch the rail
 * freezes (dimmed, non-interactive) until failure unfreezes it.
 */
import type {ReactNode} from "react";
import {cn} from "@/lib/utils";
import {MaskIcon} from "./bits";
import {STEPS, STEP_TITLES, type Runtime, type StepId, type WizardState} from "./useWizard";

const CONNECT_TINT = "text-[#0EA5E9]";
// The Hermes mark renders in plain ink (black / white by theme), not a brand
// colour — the silhouette is the brand.
const HERMES_TINT = "text-foreground";
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
): {icon: React.ReactNode; label: string} | null {
    switch (step) {
        case "runtime": {
            if (!state.runtime) return null;
            const {title, icon} = RUNTIME_CHIPS[state.runtime];
            return {icon, label: title};
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
    onGoto,
}: {
    state: WizardState;
    frozen: boolean;
    onGoto: (step: StepId) => void;
}) {
    // Launch isn't a step to navigate — reaching it just locks the rail
    // (every chip freezes as the record of what was chosen).
    const seq = STEPS.filter(s => s !== "launch");
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
                const value = chipValue(step, state);
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
