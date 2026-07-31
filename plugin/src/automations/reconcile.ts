// Plugin-side automations reconciler.
//
// A 4th fire-and-forget loop alongside the liveness pinger + inbound poller
// (see gateway-adapter.startAccount). Each cycle: read the local gateway cron
// (via the in-process getCron handle), fetch the operator's desired set from
// Clawbits, converge the MANAGED jobs to match, mirror EXTERNAL jobs, and
// self-report actual state. Telemetry-class + billing-exempt (the state route is
// on the exemption allowlist). Wakes immediately on a cron_changed hook or an
// `automation.sync` WS nudge; otherwise polls on a timer.
//
// See docs/protocol/OPENCLAW_AUTOMATIONS_INTEGRATION_STRATEGY.md §3.4/§3.5.

import { CHANNEL_ID } from "../accounts.js";
import type { ClawBitsClient } from "../client.js";
import { timedRequest } from "../client.js";
import { type BasicLogger, logInfo } from "../file-logger.js";
import { CLAWBITS_CHANNEL_ID_RE } from "../messaging-adapter.js";
import { PLUGIN_VERSION } from "../version.js";
import {
  type CronDelivery,
  type CronHandle,
  type CronJobView,
  type RunOutcome,
  cronJobMatchesParams,
  extractJobId,
  getCronHandle,
  interpretRunResult,
  parseSentinel,
  preserveEveryAnchor,
  specToCronAdd,
} from "./cron-handle.js";

const DESIRED_PATH = "/api/agentic/automations/desired";
const STATE_PATH = "/api/agentic/automations/state";

export const AUTOMATIONS_RECONCILE_INTERVAL_MS = 60_000;

// Hard ceiling on each reconcile HTTP call. Without it, Node's fetch (undici)
// waits ~300s for response headers/body, and because the loop is single-flight
// a single dead keep-alive socket would freeze reconcile — and ignore nudges —
// for minutes (the "applies 5-7 minutes later" symptom). 20s is generous for a
// telemetry-class call yet fails fast enough to retry on the next cycle/nudge.
export const AUTOMATIONS_REQUEST_TIMEOUT_MS = 20_000;


interface DesiredItem {
  automation_id: string;
  gateway_job_id: string | null;
  desired_generation: number;
  intent: "present" | "absent";
  desired_spec: Record<string, unknown> | null;
  spec_hash: string | null;
  // Run-now: run the job once when run_requested > run_observed.
  run_requested_generation?: number;
  run_observed_generation?: number;
}

interface DesiredResponse {
  schema_version: string;
  desired_generation: number;
  automations: DesiredItem[];
}

interface ManagedReport {
  automation_id: string;
  gateway_job_id: string | null;
  observed_generation: number;
  run_observed_generation?: number;
  status: "applied" | "failed" | "removed";
  error?: string | null;
  reported_spec?: unknown;
  reported_state?: unknown;
}

interface ExternalReport {
  gateway_job_id: string;
  name?: string;
  reported_spec?: unknown;
  reported_state?: unknown;
}

interface RunReport {
  automation_id: string;
  gateway_job_id: string;
  gateway_run_id: string;
  status?: string;
  started_at_ms?: number;
  finished_at_ms?: number;
  summary?: Record<string, unknown>;
  diagnostics?: unknown;
}

/** Derive the latest run of a managed job from its `state`. The in-process
 *  CronService exposes no run-log reader (only per-job state), so we report the
 *  last run each cycle — keyed by its start time so re-reports upsert and each
 *  distinct run accumulates a row. Sub-interval runs between cycles are missed;
 *  the full transcript lives in the agent's channel. */
export function lastRunReport(automationId: string, job: CronJobView): RunReport | undefined {
  const st = job.state;
  if (!st || typeof st.lastRunAtMs !== "number") return undefined;
  const status = typeof st.lastRunStatus === "string" ? st.lastRunStatus : undefined;
  const summary: Record<string, unknown> = {};
  if (typeof st.lastError === "string") summary.error = st.lastError;
  if (typeof st.lastDiagnosticSummary === "string") {
    summary.diagnostic_summary = st.lastDiagnosticSummary;
  }
  // Delivery outcome, reported ALONGSIDE (not folded into) the turn status: a
  // run whose turn succeeded but whose announce never reached the channel is
  // the "marked run OK, nothing delivered" case. Carry it so the operator sees
  // a distinct "not delivered" state instead of a false green.
  if (typeof st.lastDelivered === "boolean") summary.delivered = st.lastDelivered;
  if (typeof st.lastDeliveryStatus === "string") summary.delivery_status = st.lastDeliveryStatus;
  if (typeof st.lastDeliveryError === "string") summary.delivery_error = st.lastDeliveryError;
  return {
    automation_id: automationId,
    gateway_job_id: job.id,
    gateway_run_id: `run:${String(st.lastRunAtMs)}`,
    ...(status ? { status } : {}),
    started_at_ms: st.lastRunAtMs,
    ...(typeof st.lastDurationMs === "number"
      ? { finished_at_ms: st.lastRunAtMs + st.lastDurationMs }
      : {}),
    summary,
    ...(st.lastDiagnostics !== undefined ? { diagnostics: st.lastDiagnostics } : {}),
  };
}

// Human-facing explanation for a manual run that the gateway declined to start,
// keyed by its machine reason. Surfaced as a run row so "Run now" that produced
// nothing is honest about WHY, instead of silently consuming the click.
const RUN_NOW_MISS_MESSAGES: Record<string, string> = {
  "already-running": "A run was already in progress, so the manual run was skipped.",
  "restart-recovery-pending":
    "The agent is still recovering after a restart — try the manual run again shortly.",
  "not-due": "The job was not due to run.",
  stopped: "This automation is paused — enable it, then run it.",
  "invalid-spec": "The automation's schedule or target is invalid — check its settings.",
  rejected: "The gateway declined to run this automation.",
};

/** A synthetic run row for a manual run that did NOT start. Keyed by the run-now
 *  generation so a re-report upserts rather than piling up. */
function runNowMissRow(
  automationId: string,
  jobId: string,
  generation: number,
  outcome: RunOutcome,
): RunReport {
  const message =
    (outcome.reason ? RUN_NOW_MISS_MESSAGES[outcome.reason] : undefined) ??
    (outcome.reason
      ? `The manual run did not start (${outcome.reason}).`
      : "The manual run did not start.");
  const at = Date.now();
  return {
    automation_id: automationId,
    gateway_job_id: jobId,
    gateway_run_id: `run-now:${String(generation)}`,
    status: outcome.kind === "error" ? "error" : "skipped",
    started_at_ms: at,
    finished_at_ms: at,
    summary: {
      run_now: true,
      did_not_run: true,
      error: message,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Wake registry: lets the cron_changed hook + the automation.sync nudge cut a
// sleeping loop short so reconcile is near-instant. Each running loop registers
// its wake fn for its WHOLE lifetime (not just while sleeping), so a nudge that
// arrives mid-reconcile is not lost — it sets the loop's dirty flag and triggers
// an immediate re-reconcile. Keyed by accountId (a Set tolerates the brief
// overlap of two loops during a reconnect); a global wake — cron_changed carries
// no account — wakes every loop.
// ---------------------------------------------------------------------------

const wakers = new Map<string, Set<() => void>>();

function registerWaker(accountId: string, wake: () => void): () => void {
  let set = wakers.get(accountId);
  if (!set) {
    set = new Set();
    wakers.set(accountId, set);
  }
  set.add(wake);
  return () => {
    const current = wakers.get(accountId);
    if (!current) return;
    current.delete(wake);
    if (current.size === 0) wakers.delete(accountId);
  };
}

export function wakeAutomationsReconciler(accountId?: string): void {
  if (accountId) {
    const set = wakers.get(accountId);
    if (set) for (const wake of [...set]) wake();
    return;
  }
  for (const set of [...wakers.values()]) for (const wake of [...set]) wake();
}

function reportedSpecOf(job: CronJobView): Record<string, unknown> {
  return {
    name: job.name,
    description: job.description,
    schedule: job.schedule,
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    payload: job.payload,
    enabled: job.enabled,
  };
}

/** Default delivery for a managed automation: announce the scheduled agentTurn's
 *  output back to the agent's owner channel in Clawbits. A scheduled job runs in
 *  an isolated session with no "last" channel, so it needs an explicit route or
 *  OpenClaw drops the output. The owner channel UUID is a runtime-only value
 *  (the backend stores no channel identity for an agent), so we build it here
 *  from the resolved account, fresh each reconcile pass. Returns undefined when
 *  the account has no resolved owner channel — then the job runs without a route
 *  (same as before this feature; no regression). */
export function ownerChannelDelivery(params: {
  accountId: string;
  channelId?: string;
}): CronDelivery | undefined {
  const channelId = params.channelId?.trim();
  if (!channelId || !CLAWBITS_CHANNEL_ID_RE.test(channelId)) return undefined;
  return {
    mode: "announce",
    channel: CHANNEL_ID,
    to: channelId,
    accountId: params.accountId,
  };
}

async function resolveNewJobId(
  cron: CronHandle,
  addResult: unknown,
  automationId: string,
): Promise<string | null> {
  const fromResult = extractJobId(addResult);
  if (fromResult) return fromResult;
  // Fall back to a sentinel match on a fresh list (cron.add result shape varies).
  try {
    const jobs = await cron.list({ includeDisabled: true });
    const match = jobs.find((j) => parseSentinel(j) === automationId);
    return match?.id ?? null;
  } catch {
    return null;
  }
}

/** One reconcile pass (exported for tests; the loop below drives it live). */
export async function reconcileOnce(opts: {
  cron: CronHandle;
  client: ClawBitsClient;
  accountId: string;
  ownerChannelId?: string;
  /** Aborts in-flight reconcile requests when the loop shuts down. */
  abortSignal?: AbortSignal;
  /** Per-request timeout; defaults to AUTOMATIONS_REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number;
  log?: BasicLogger;
}): Promise<void> {
  const { cron, client, accountId, ownerChannelId, abortSignal, log } = opts;
  const timeoutMs = opts.requestTimeoutMs ?? AUTOMATIONS_REQUEST_TIMEOUT_MS;

  const localJobs = await cron.list({ includeDisabled: true });
  const desired = await timedRequest<DesiredResponse>(client, "reconcile request", "GET", DESIRED_PATH, {
    timeoutMs,
    parent: abortSignal,
  });

  // Route scheduled output back to the agent's owner channel (runtime-only id).
  const defaultDelivery = ownerChannelDelivery({ accountId, channelId: ownerChannelId });

  const bySentinel = new Map<string, CronJobView>();
  const byId = new Map<string, CronJobView>();
  for (const job of localJobs) {
    byId.set(job.id, job);
    const sid = parseSentinel(job);
    if (sid) bySentinel.set(sid, job);
  }

  const managed: ManagedReport[] = [];
  const runs: RunReport[] = [];
  const desiredIds = new Set<string>();

  for (const item of desired.automations) {
    desiredIds.add(item.automation_id);
    const existing =
      bySentinel.get(item.automation_id) ??
      (item.gateway_job_id ? byId.get(item.gateway_job_id) : undefined);

    if (item.intent === "absent") {
      if (existing) {
        try {
          await cron.remove(existing.id);
        } catch (err) {
          log?.warn?.(
            `[clawbits/${accountId}] cron.remove failed for ${existing.id}: ${String(
              (err as Error)?.message ?? err,
            )}`,
          );
        }
      }
      managed.push({
        automation_id: item.automation_id,
        gateway_job_id: existing?.id ?? item.gateway_job_id ?? null,
        observed_generation: item.desired_generation,
        status: "removed",
      });
      continue;
    }

    if (!item.desired_spec) continue;
    const params = specToCronAdd(item.desired_spec, item.automation_id, {
      defaultDelivery,
    });
    try {
      let jobId: string | null;
      let reportedState: unknown;
      if (existing) {
        // Convergence gate: write only on real drift. A no-op cron.update is
        // not free — the gateway recomputes nextRunAtMs from `now` for any
        // patch carrying schedule/enabled and re-anchors `every` intervals,
        // so updating every cycle starves the job forever (never fires).
        const applyParams = preserveEveryAnchor(params, existing);
        if (!cronJobMatchesParams(existing, applyParams)) {
          await cron.update(existing.id, applyParams);
          logInfo(
            log,
            `[clawbits/${accountId}] converged automation ${item.automation_id} onto job ${existing.id} (gen ${String(item.desired_generation)})`,
          );
        }
        jobId = existing.id;
        reportedState = existing.state;
      } else {
        const result = await cron.add(params);
        jobId = await resolveNewJobId(cron, result, item.automation_id);
        logInfo(
          log,
          `[clawbits/${accountId}] created cron job ${jobId ?? "?"} for automation ${item.automation_id} (gen ${String(item.desired_generation)})`,
        );
      }
      // Run-now: an imperative one-off run requested by the operator. Best-effort
      // and attempted once per generation bump — we advance run_observed even on
      // a run failure so a permanent error can't loop every cycle (the operator
      // re-clicks to retry). Skipped until the job exists locally. We inspect the
      // gateway's result: a forced run can still decline (paused job, already
      // running, invalid spec), and a declined run is surfaced as its own run row
      // instead of being silently swallowed. A run that DID start (inline or
      // enqueued) reports its real outcome — including delivery — via
      // lastRunReport on the next cycle (the cron_changed hook wakes us when it
      // finishes).
      const runRequested = item.run_requested_generation ?? 0;
      let runObserved = item.run_observed_generation ?? 0;
      if (jobId && runRequested > runObserved) {
        let outcome: RunOutcome;
        try {
          outcome = interpretRunResult(await cron.run(jobId, "force"));
        } catch (err) {
          outcome = {
            started: false,
            kind: "error",
            reason: String((err as Error)?.message ?? err),
          };
        }
        if (outcome.started) {
          logInfo(
            log,
            `[clawbits/${accountId}] ran automation ${item.automation_id} on demand (gen ${String(runRequested)})`,
          );
        } else {
          log?.warn?.(
            `[clawbits/${accountId}] on-demand run for ${jobId} did not start: ${outcome.reason ?? "unknown"}`,
          );
          runs.push(runNowMissRow(item.automation_id, jobId, runRequested, outcome));
        }
        runObserved = runRequested;
      }
      if (existing) {
        const run = lastRunReport(item.automation_id, existing);
        if (run) runs.push(run);
      }
      managed.push({
        automation_id: item.automation_id,
        gateway_job_id: jobId,
        observed_generation: item.desired_generation,
        run_observed_generation: runObserved,
        status: "applied",
        reported_spec: item.desired_spec,
        ...(reportedState !== undefined ? { reported_state: reportedState } : {}),
      });
    } catch (err) {
      managed.push({
        automation_id: item.automation_id,
        gateway_job_id: existing?.id ?? null,
        observed_generation: item.desired_generation,
        status: "failed",
        error: String((err as Error)?.message ?? err),
      });
    }
  }

  // External mirror: any local job not managed by a Clawbits automation we know.
  const external: ExternalReport[] = [];
  for (const job of localJobs) {
    const sid = parseSentinel(job);
    if (sid && desiredIds.has(sid)) continue;
    external.push({
      gateway_job_id: job.id,
      name: job.name,
      reported_spec: reportedSpecOf(job),
      reported_state: job.state,
    });
  }

  await timedRequest<unknown>(client, "reconcile request", "POST", STATE_PATH, {
    json: {
      plugin_version: PLUGIN_VERSION,
      managed,
      external,
      runs,
    },
    timeoutMs,
    parent: abortSignal,
  });
}

export interface AutomationsReconcilerOptions {
  client: ClawBitsClient;
  abortSignal: AbortSignal;
  accountId: string;
  /** The account's owner channel UUID (account.channelId). Used to route
   *  scheduled output back to that channel; absent → jobs run without a route. */
  ownerChannelId?: string;
  /** Poll interval; the loop also wakes on cron_changed / automation.sync. */
  intervalMs?: number;
  log?: BasicLogger;
}

/**
 * Run the reconcile loop until `abortSignal` fires. Best-effort: every failure
 * is logged and swallowed; never blocks the gateway, never rejects. Inert (just
 * idles) until the gateway_start hook has populated the cron handle.
 */
export async function runAutomationsReconciler(
  opts: AutomationsReconcilerOptions,
): Promise<void> {
  const { client, abortSignal, accountId, ownerChannelId, log } = opts;
  const intervalMs = opts.intervalMs ?? AUTOMATIONS_RECONCILE_INTERVAL_MS;
  if (!client.hasApiKey()) {
    logInfo(log, `[clawbits/${accountId}] automations reconciler idle: no api key`);
    return;
  }
  logInfo(
    log,
    `[clawbits/${accountId}] automations reconciler started (every ${String(
      Math.round(intervalMs / 1000),
    )}s, wakes on nudge)`,
  );

  // `dirty` captures a wake that lands mid-reconcile (or mid-sleep). `wakeSleep`
  // cuts the current sleep short. The waker is registered for the whole loop so
  // wakes are never dropped in the window between reconciles.
  let dirty = false;
  let wakeSleep: (() => void) | undefined;
  const wake = () => {
    dirty = true;
    wakeSleep?.();
  };
  const unregister = registerWaker(accountId, wake);

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (abortSignal.aborted || dirty) {
        resolve();
        return;
      }
      const finish = () => {
        clearTimeout(timer);
        abortSignal.removeEventListener("abort", finish);
        wakeSleep = undefined;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      abortSignal.addEventListener("abort", finish, { once: true });
      wakeSleep = finish;
    });

  try {
    let warnedNoCron = false;
    while (!abortSignal.aborted) {
      const cron = getCronHandle();
      if (!cron) {
        if (!warnedNoCron) {
          logInfo(
            log,
            `[clawbits/${accountId}] automations reconciler waiting for gateway cron handle`,
          );
          warnedNoCron = true;
        }
      } else {
        warnedNoCron = false;
        // Clear BEFORE reconciling so a wake arriving during the pass is not
        // erased; if one lands, we skip the sleep and reconcile again at once.
        dirty = false;
        try {
          await reconcileOnce({ cron, client, accountId, ownerChannelId, abortSignal, log });
        } catch (err) {
          log?.warn?.(
            `[clawbits/${accountId}] automations reconcile failed (will retry): ${String(
              (err as Error)?.message ?? err,
            )}`,
          );
        }
        if (dirty && !abortSignal.aborted) continue;
      }
      await sleep(intervalMs);
    }
  } finally {
    unregister();
  }
}
