/**
 * The minimized Add Agent wizard, docked at the bottom of the sidebar in
 * UpdateBanner's slot and visual language: one translucent mini-card with the
 * wizard's robot tile (the OptionCard tile look, scaled down), the live
 * summary WizardBody publishes (current step + a tiny pie of how far along,
 * boot phase, ready), and a small ✕. Clicking the card restores the wizard
 * exactly where it was; ✕ ends the session — confirmed first while the create
 * is in flight or the one-time access password hasn't been saved.
 */
import {
    AlertCircleIcon,
    Cancel01Icon,
    CheckmarkCircle02Icon,
    Robot02Icon,
} from "@hugeicons/core-free-icons";
import {useSelector} from "@tanstack/react-store";
import {Icon} from "@/components/Icon";
import {confirm} from "@/lib/confirm";
import {
    closeWizard,
    GUARD_COPY,
    openOrRestoreWizard,
    wizardSessionAtom,
    type WizardChipStatus,
} from "./wizardSessionStore";

export function WizardDockChip() {
    const session = useSelector(wizardSessionAtom);
    if (session.phase !== "minimized" || session.summary === null) return null;
    const {title, subtitle, status, progress} = session.summary;
    const guard = session.guard;

    const dismiss = async () => {
        if (guard !== null) {
            const ok = await confirm({
                ...GUARD_COPY[guard],
                confirmLabel: "Discard",
                destructive: true,
            });
            if (!ok) return;
        }
        closeWizard();
    };

    return (
        <div className="pointer-events-auto flex animate-in items-center gap-2.5 rounded-xl border border-sidebar-border bg-card/80 p-2 text-sm shadow-sm backdrop-blur-xl fade-in slide-in-from-bottom-1 duration-300 supports-[backdrop-filter]:bg-card/60">
            {/* The whole card (minus the ✕) is the restore target. */}
            <button
                type="button"
                onClick={() => { openOrRestoreWizard(); }}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
            >
                {/* The wizard's identity tile — OptionCard's app-icon shape,
                    but tinted glass instead of a saturated fill: a whisper of
                    violet behind a violet icon. Status lives by the subtitle. */}
                <span
                    aria-hidden="true"
                    className="flex size-10 shrink-0 items-center justify-center rounded-xl text-violet-600 ring-1 ring-violet-500/15 dark:text-violet-300"
                    style={{background: "linear-gradient(180deg, rgba(167,139,250,0.20), rgba(124,58,237,0.10))"}}
                >
                    <Icon icon={Robot02Icon} className="size-5.5"/>
                </span>
                <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium leading-tight text-foreground">{title}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <StatusMark status={status} progress={progress}/>
                        <span className="truncate">{subtitle}</span>
                    </span>
                </span>
                <span className="sr-only">Restore the agent setup</span>
            </button>
            <button
                type="button"
                onClick={() => { void dismiss(); }}
                title="Dismiss"
                className="-m-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
                <Icon icon={Cancel01Icon} className="size-3.5"/>
                <span className="sr-only">Dismiss the agent setup</span>
            </button>
        </div>
    );
}

/** The tiny state dot beside the subtitle: a partly-filled pie while drafting,
 *  spinner / check / alert once the wizard is doing or done. */
function StatusMark({status, progress}: {status: WizardChipStatus; progress: number | null}) {
    if (status === "working") {
        return (
            <span
                aria-hidden="true"
                className="size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-primary border-t-transparent"
            />
        );
    }
    if (status === "ready" || status === "error") {
        return (
            <Icon
                icon={status === "ready" ? CheckmarkCircle02Icon : AlertCircleIcon}
                className={
                    status === "ready"
                        ? "size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                        : "size-3.5 shrink-0 text-destructive"
                }
            />
        );
    }
    return <ProgressPie fraction={progress ?? 0}/>;
}

/** A wedge growing clockwise from 12 o'clock inside a hairline ring — the
 *  stroke-as-pie trick: a circle stroked HALF its diameter thick paints from
 *  its center outward, so dashing that stroke leaves a filled sector. */
function ProgressPie({fraction}: {fraction: number}) {
    const pct = Math.min(1, Math.max(0, fraction)) * 100;
    return (
        <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 -rotate-90 text-foreground/80" aria-hidden="true">
            <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.3"/>
            <circle
                cx="8"
                cy="8"
                r="2.75"
                fill="none"
                stroke="currentColor"
                strokeWidth="5.5"
                pathLength="100"
                strokeDasharray={`${String(pct)} 100`}
                className="transition-[stroke-dasharray] duration-300"
            />
        </svg>
    );
}
