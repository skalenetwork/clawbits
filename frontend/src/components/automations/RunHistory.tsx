import {useState} from "react";
import {ActivityIcon as Activity, ArrowDown01Icon as Chevron} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import type {AutomationRun} from "@/lib/api";
import {formatRelativeAgo, parseUtcTimestamp} from "@/lib/formatting";
import {formatInstant} from "@/lib/schedule";
import {cn} from "@/lib/utils";
import {formatDuration} from "@/lib/toolPresentation";

/**
 * Run history for one automation — the strip (a Vercel-style row of thin bars)
 * and the list. The run is the real artifact, but honestly framed: a green
 * run means it completed without crashing, not that the task succeeded, and
 * runs carry only status/error/diagnostics (output goes to the delivery
 * channel; no transcript is stored).
 */

function runOk(status: string | null): boolean {
    const s = (status ?? "").toLowerCase();
    return s === "ok" || s === "success" || s === "succeeded";
}

function runFailed(status: string | null): boolean {
    const s = (status ?? "").toLowerCase();
    return s === "error" || s === "failed" || s === "failure";
}

/** The bounded run summary the plugin self-reports. Delivery outcome is tracked
 *  separately from the turn status: a run can succeed yet fail to reach its
 *  channel. `did_not_run` marks a manual run the gateway declined to start. */
interface RunSummary {
    error?: string;
    diagnostic_summary?: string;
    delivered?: boolean;
    delivery_status?: string;
    delivery_error?: string;
    did_not_run?: boolean;
    reason?: string;
}

function runSummary(run: AutomationRun): RunSummary {
    return run.summary ?? {};
}

/**
 * The honest state of a run, in precedence order:
 * - `did-not-run`  a manual run the gateway declined (paused, already running…)
 * - `failed`       the turn itself crashed
 * - `not-delivered` the turn succeeded but its output never reached the channel
 * - `ok`           ran and delivered
 * - `unknown`      reported without a status
 */
type RunKind = "did-not-run" | "failed" | "not-delivered" | "ok" | "unknown";

function runKind(run: AutomationRun): RunKind {
    const s = runSummary(run);
    if (s.did_not_run === true) return "did-not-run";
    if (runFailed(run.status)) return "failed";
    if (s.delivered === false || s.delivery_status === "not-delivered") return "not-delivered";
    if (runOk(run.status)) return "ok";
    return "unknown";
}

const RUN_KIND_LABEL: Record<RunKind, string> = {
    "did-not-run": "didn't run",
    failed: "failed",
    "not-delivered": "ran, not delivered",
    ok: "ran",
    unknown: "ran",
};

/** Dot/bar tint per kind. Amber marks "attention, but not a crash" — a declined
 *  manual run or a delivered-nothing run — distinct from a red hard failure. */
const RUN_KIND_DOT: Record<RunKind, string> = {
    "did-not-run": "bg-amber-500",
    failed: "bg-red-500",
    "not-delivered": "bg-amber-500",
    ok: "bg-emerald-500",
    unknown: "bg-zinc-400 dark:bg-zinc-600",
};

/** Wall-clock duration from the run row (finished − started), if reported. */
function runDurationMs(run: AutomationRun): number | null {
    if (!run.started_at || !run.finished_at) return null;
    const started = parseUtcTimestamp(run.started_at).getTime();
    const finished = parseUtcTimestamp(run.finished_at).getTime();
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return null;
    return finished - started;
}

/**
 * The strip: one thin bar per run, oldest → newest, height scaled by duration
 * where reported. `pendingGhost` appends a dashed pulsing slot while a
 * requested run hasn't landed as a row yet — the animation encodes the async
 * contract instead of faking a result.
 */
export function RunStrip({runs, pendingGhost = false, className}: {
    runs: AutomationRun[];
    pendingGhost?: boolean;
    className?: string;
}) {
    if (runs.length === 0 && !pendingGhost) return null;
    const durations = runs.map(runDurationMs);
    const max = Math.max(1, ...durations.filter((d): d is number => d != null));
    const chronological = [...runs].reverse();
    const chronologicalDurations = [...durations].reverse();
    return (
        <div className={cn("flex h-8 items-end gap-1", className)} aria-label="Recent runs">
            {chronological.map((run, i) => {
                const dur = chronologicalDurations[i] ?? null;
                const h = dur != null ? Math.max(0.35, dur / max) : 0.55;
                const kind = runKind(run);
                // A crash or a silent no-delivery is drawn full height so it
                // stands out by shape, not color alone.
                const attention = kind === "failed" || kind === "not-delivered";
                const barColor =
                    kind === "failed"
                        ? "bg-red-500/80"
                        : kind === "not-delivered" || kind === "did-not-run"
                          ? "bg-amber-500/70"
                          : kind === "ok"
                            ? "bg-emerald-500/50 hover:bg-emerald-500/80"
                            : "bg-muted-foreground/30";
                const started = run.started_at ?? run.created_at;
                return (
                    <span
                        key={run.id}
                        title={[
                            started ? formatInstant(parseUtcTimestamp(started).getTime()) : null,
                            RUN_KIND_LABEL[kind],
                            formatDuration(dur),
                        ].filter(Boolean).join(" · ")}
                        className={cn("w-1.5 rounded-full transition-colors", barColor)}
                        style={{height: attention ? "100%" : `${String(Math.round(h * 100))}%`}}
                    />
                );
            })}
            {pendingGhost && (
                <span
                    title="Run requested — appears here once the agent reports it"
                    className="h-[55%] w-1.5 animate-pulse rounded-full border border-dashed border-muted-foreground/50"
                />
            )}
        </div>
    );
}

/** One expandable run row: status pill, when, duration, error on demand. */
function RunRow({run}: {run: AutomationRun}) {
    const [expanded, setExpanded] = useState(false);
    const summary = runSummary(run);
    const kind = runKind(run);
    // A dropped delivery is an amber warning, not a red error — the turn ran.
    const amber = kind === "did-not-run" || kind === "not-delivered";
    const hasDetail =
        Boolean(summary.error) ||
        Boolean(summary.diagnostic_summary) ||
        Boolean(summary.delivery_error);
    const dur = formatDuration(runDurationMs(run));
    const started = run.started_at ?? run.created_at;

    return (
        <li>
            <button
                type="button"
                onClick={() => { if (hasDetail) setExpanded(v => !v); }}
                className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left",
                    hasDetail && "cursor-pointer transition-colors hover:bg-muted/40",
                )}
                aria-expanded={hasDetail ? expanded : undefined}
                disabled={!hasDetail}
            >
                <span
                    aria-hidden
                    className={cn("size-2 shrink-0 rounded-full", RUN_KIND_DOT[kind])}
                />
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {RUN_KIND_LABEL[kind]} {started ? formatRelativeAgo(started) : ""}
                </span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground tabular-nums">
                    {dur && <span>{dur}</span>}
                    {hasDetail && (
                        <Icon
                            icon={Chevron}
                            className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
                        />
                    )}
                </span>
            </button>
            {expanded && hasDetail && (
                <div className="mb-2 ml-7 space-y-1.5 rounded-lg bg-muted/40 p-3">
                    {summary.error && (
                        <p className={cn(
                            "break-words text-xs leading-relaxed",
                            amber
                                ? "text-amber-600 dark:text-amber-400"
                                : "text-red-600 dark:text-red-400",
                        )}>{summary.error}</p>
                    )}
                    {summary.delivery_error && (
                        <p className="break-words text-xs leading-relaxed text-amber-600 dark:text-amber-400">
                            Delivery to the channel failed: {summary.delivery_error}
                        </p>
                    )}
                    {summary.diagnostic_summary && (
                        <p className="break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
                            {summary.diagnostic_summary}
                        </p>
                    )}
                </div>
            )}
        </li>
    );
}

export function RunList({runs, isLoading, isError}: {
    runs: AutomationRun[];
    isLoading: boolean;
    isError: boolean;
}) {
    if (isLoading) {
        return (
            <div className="space-y-2 py-2">
                {Array.from({length: 3}).map((_, i) => (
                    <div key={i} className="h-10 animate-pulse rounded-lg bg-muted"/>
                ))}
            </div>
        );
    }
    if (isError) {
        return <p className="py-6 text-center text-sm text-destructive">Couldn't load runs.</p>;
    }
    if (runs.length === 0) {
        return (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
                <Icon icon={Activity} className="size-5 text-muted-foreground"/>
                <p className="text-sm text-muted-foreground">No runs reported yet</p>
            </div>
        );
    }
    return (
        <ul className="divide-y divide-border/40">
            {runs.map((run) => <RunRow key={run.id} run={run}/>)}
        </ul>
    );
}
