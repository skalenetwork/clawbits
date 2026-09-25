import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/Icon";
import { StatusDot } from "@/components/settings/Settings";
import { Skeleton } from "@/components/ui/skeleton";
import { listAutomationRuns, type Automation, type AutomationRun } from "@/lib/api";
import { automationsRefetchInterval } from "@/lib/automationsPolling";
import { formatDuration, formatRelativeAgo, parseUtcTimestamp } from "@/lib/formatting";
import { queryKeys } from "@/lib/queryKeys";
import { formatInstant } from "@/lib/schedule";
import { TONE_FILL, type StatusTone } from "@/lib/status";
import { cn } from "@/lib/utils";

type RunKind = "did-not-run" | "failed" | "not-delivered" | "ok" | "unknown";

interface RunSummary {
  error?: string;
  diagnostic_summary?: string;
  delivered?: boolean;
  delivery_status?: string;
  delivery_error?: string;
  did_not_run?: boolean;
}

const RUN_KIND: Record<RunKind, { label: string; tone: StatusTone }> = {
  "did-not-run": { label: "didn't run", tone: "warn" },
  failed: { label: "failed", tone: "bad" },
  "not-delivered": { label: "ran, not delivered", tone: "warn" },
  ok: { label: "ran", tone: "ok" },
  unknown: { label: "ran", tone: "idle" },
};

const BAR: Record<StatusTone, string> = { ...TONE_FILL, idle: "bg-foreground/15" };

const summaryOf = (run: AutomationRun): RunSummary => run.summary ?? {};

function runKind(run: AutomationRun): RunKind {
  const summary = summaryOf(run);
  const status = (run.status ?? "").toLowerCase();
  if (summary.did_not_run === true) return "did-not-run";
  if (["error", "failed", "failure"].includes(status)) return "failed";
  if (summary.delivered === false || summary.delivery_status === "not-delivered") return "not-delivered";
  if (["ok", "success", "succeeded"].includes(status)) return "ok";
  return "unknown";
}

function runDurationMs(run: AutomationRun): number | null {
  if (!run.started_at || !run.finished_at) return null;
  const ms = parseUtcTimestamp(run.finished_at).getTime() - parseUtcTimestamp(run.started_at).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function startedAt(run: AutomationRun): string | null {
  const started = run.started_at ?? run.created_at;
  return started ? formatInstant(parseUtcTimestamp(started).getTime()) : null;
}

function RunRow({ run }: { run: AutomationRun }) {
  const [open, setOpen] = useState(false);
  const { error, diagnostic_summary, delivery_error } = summaryOf(run);
  const kind = runKind(run);
  const warn = kind === "did-not-run" || kind === "not-delivered";
  const expandable = Boolean(error || diagnostic_summary || delivery_error);
  const duration = formatDuration(runDurationMs(run));

  return (
    <li className="border-foreground/8 not-first:border-t">
      <button
        type="button"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={() => {
          setOpen(!open);
        }}
        className="flex w-full items-center gap-2 py-[7px] text-left text-[13px] outline-none enabled:cursor-pointer focus-visible:underline"
      >
        <StatusDot tone={RUN_KIND[kind].tone} className="size-[7px]" />
        <span title={startedAt(run) ?? undefined} className="min-w-0 flex-1 truncate">
          {RUN_KIND[kind].label} {formatRelativeAgo(run.started_at ?? run.created_at)}
        </span>
        {duration && <span className="shrink-0 text-muted-foreground tabular-nums">{duration}</span>}
        {expandable && (
          <Icon
            icon={ArrowDown01Icon}
            className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
          />
        )}
      </button>
      {open && (
        <div className="mb-2 flex flex-col gap-1.5 rounded-[10px] bg-foreground/5 p-3 text-xs leading-relaxed wrap-anywhere">
          {error && <p className={warn ? "text-amber-700 dark:text-amber-400" : "text-destructive"}>{error}</p>}
          {delivery_error && (
            <p className="text-amber-700 dark:text-amber-400">Delivery to the channel failed: {delivery_error}</p>
          )}
          {diagnostic_summary && <p className="font-mono text-[11px] text-muted-foreground">{diagnostic_summary}</p>}
        </div>
      )}
    </li>
  );
}

export function RunHistory({
  orgId,
  automation: a,
  lastFailed,
}: {
  orgId: string;
  automation: Automation;
  lastFailed: boolean;
}) {
  const query = useQuery({
    queryKey: queryKeys.automationRuns(orgId, a.agent_id, a.automation_id),
    queryFn: () => listAutomationRuns(orgId, a.agent_id, a.automation_id),
    refetchInterval: automationsRefetchInterval,
  });
  const runs = query.data?.runs ?? [];
  const lastRunAtMs = a.reported_state?.lastRunAtMs;
  const longest = Math.max(1, ...runs.map(runDurationMs).filter((ms) => ms != null));

  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex justify-between gap-3 text-xs text-muted-foreground">
        <h4 className="font-medium">Runs</h4>
        {lastRunAtMs != null && (
          <span title={formatInstant(lastRunAtMs)} className={cn(lastFailed && "text-destructive")}>
            {lastFailed ? "Last run failed" : "Last run"} {formatRelativeAgo(lastRunAtMs)}
          </span>
        )}
      </div>
      {(runs.length > 0 || a.run_pending) && (
        <div aria-hidden className="flex h-7 items-end gap-[3px]">
          {runs.toReversed().map((run) => {
            const kind = runKind(run);
            const ms = runDurationMs(run);
            const full = kind === "failed" || kind === "not-delivered";
            return (
              <span
                key={run.id}
                title={[startedAt(run), RUN_KIND[kind].label, formatDuration(ms)].filter(Boolean).join(" · ")}
                className={cn("min-h-[35%] max-w-6 flex-1 rounded-[2px]", BAR[RUN_KIND[kind].tone])}
                style={{
                  height: full ? "100%" : ms == null ? "55%" : `${String(Math.round((ms / longest) * 100))}%`,
                }}
              />
            );
          })}
          {a.run_pending && (
            <span
              title="Run requested, it appears here once the agent reports it"
              className="h-[55%] max-w-6 flex-1 rounded-[2px] border border-dashed border-muted-foreground/50"
            />
          )}
        </div>
      )}
      {!query.data ? (
        query.isError ? (
          <p className="text-[13px] text-destructive">Couldn't load runs</p>
        ) : (
          <Skeleton className="h-20 rounded-[10px]" />
        )
      ) : runs.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          {a.managed_by === "external"
            ? "Run history isn't reported for automations managed outside Clawbits."
            : "No runs reported yet"}
        </p>
      ) : (
        <ul>
          {runs.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
        </ul>
      )}
    </section>
  );
}
