import {
    Alert02Icon,
    CheckmarkCircle02Icon,
    Clock05Icon,
    Delete02Icon,
    LinkSquare02Icon,
    PauseIcon,
    PlayIcon,
} from "@hugeicons/core-free-icons";
import type {IconSvgElement} from "@hugeicons/react";
import {Icon} from "@/components/Icon";
import {cn} from "@/lib/utils";
import type {AutomationDotColor, AutomationStateKey, AutomationVisualState} from "@/lib/automations";

/**
 * The automation status chip — a tinted pill carrying the honest state label,
 * extending the presence grammar (emerald=healthy, amber=pending, blue=running,
 * zinc=inert, red=sync failure). The icon pulses while an intent is in flight
 * ("Applying…", "Removing…") — pending is the animation; success is never
 * painted before the agent's ack.
 */
const CHIP_TONE: Record<AutomationDotColor, string> = {
    emerald: "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300",
    amber: "bg-amber-400/20 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300",
    red: "bg-red-500/15 text-red-700 dark:bg-red-400/15 dark:text-red-300",
    blue: "bg-blue-500/15 text-blue-700 dark:bg-blue-400/15 dark:text-blue-300",
    zinc: "bg-muted/60 text-muted-foreground",
};

const CHIP_ICON: Record<AutomationStateKey, IconSvgElement> = {
    active: CheckmarkCircle02Icon,
    running: PlayIcon,
    pending: Clock05Icon,
    paused: PauseIcon,
    failed: Alert02Icon,
    removing: Delete02Icon,
    external: LinkSquare02Icon,
};

type ChipSize = "sm" | "lg";

const CHIP_SIZE: Record<ChipSize, {pill: string; icon: string}> = {
    sm: {pill: "gap-1.5 px-2.5 py-1 text-[11px]", icon: "size-3.5"},
    lg: {pill: "gap-2 px-3 py-1.5 text-xs", icon: "size-4"},
};

export function StatusChip({state, labelOverride, size = "sm", className}: {
    state: AutomationVisualState;
    /** Replace the label (e.g. "Run requested…") while keeping the tone. */
    labelOverride?: string | null;
    size?: ChipSize;
    className?: string;
}) {
    const busy = state.pulse || state.shimmer || labelOverride != null;
    const s = CHIP_SIZE[size];
    return (
        <span
            className={cn(
                "inline-flex min-w-0 items-center rounded-full font-medium",
                s.pill,
                CHIP_TONE[state.dot],
                className,
            )}
        >
            <Icon
                icon={CHIP_ICON[state.key]}
                className={cn("shrink-0", s.icon, busy && "animate-pulse")}
            />
            <span className="truncate">{labelOverride ?? state.label}</span>
        </span>
    );
}

/** Amber drift marker — shown, never silently reconciled. */
export function DriftChip({className}: {className?: string}) {
    return (
        <span
            className={cn(
                "inline-flex shrink-0 items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium",
                "text-amber-600 dark:bg-amber-500/15 dark:text-amber-400",
                className,
            )}
        >
            Changed outside Clawbits
        </span>
    );
}

/** Consecutive-failure streak — the only failure-streak signal the backend
 *  has. Same size as the status chip so the pair reads as one row. */
export function FailStreakChip({count, size = "sm", className}: {
    count: number;
    size?: ChipSize;
    className?: string;
}) {
    const s = CHIP_SIZE[size];
    return (
        <span
            className={cn(
                "inline-flex shrink-0 items-center rounded-full font-medium",
                s.pill,
                CHIP_TONE.red,
                className,
            )}
            title={`${String(count)} failed run${count === 1 ? "" : "s"} in a row`}
        >
            <Icon icon={Alert02Icon} className={cn("shrink-0", s.icon)}/>
            failing ×{count}
        </span>
    );
}

/** Recessed mono tag for external (mirror-only) rows. */
export function ExternalChip({className}: {className?: string}) {
    return (
        <span
            className={cn(
                "inline-flex shrink-0 items-center rounded-full bg-muted px-2 py-0.5 font-mono",
                "text-[10px] font-medium text-muted-foreground",
                className,
            )}
        >
            external
        </span>
    );
}
