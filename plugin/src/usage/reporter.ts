// Plugin-side AI-usage reporter.
//
// A fire-and-forget loop alongside the liveness pinger / inbound poller /
// automations reconciler (see gateway-adapter.startAccount). Each cycle it
// drains the in-process usage collector (usage/collector.ts) and POSTs a
// batch to Clawbits. Telemetry-class + billing-exempt (the report route is on
// the exemption allowlist). At-least-once: the batch is only removed from the
// queue after a 2xx — the server dedups on `(agent, event_id)`, so a retry
// after a failed ack can never double-count. Restart loses the in-memory
// queue; accepted under the plan's forward-only decision (a local queue
// spill file is the Phase 4 durability add).
//
// See docs/protocol/AGENT_USAGE_TRACKING_PLAN.md §3.

import type { ClawBitsClient } from "../client.js";
import { timedRequest } from "../client.js";
import { type BasicLogger, logInfo } from "../file-logger.js";
import { PLUGIN_VERSION } from "../version.js";
import {
  ackUsageEvents,
  claimUsageReporter,
  droppedUsageCount,
  peekUsageEvents,
  pendingUsageCount,
  releaseUsageReporter,
} from "./collector.js";

const REPORT_PATH = "/api/agentic/usage/report";

export const USAGE_REPORT_INTERVAL_MS = 60_000;

// Matches the server's USAGE_REPORT_MAX_EVENTS transport cap, so a normal
// report never truncates server-side.
export const USAGE_REPORT_MAX_EVENTS = 500;

// Same rationale as AUTOMATIONS_REQUEST_TIMEOUT_MS: without a ceiling a dead
// keep-alive socket freezes the single-flight loop for minutes.
export const USAGE_REQUEST_TIMEOUT_MS = 20_000;

interface UsageReportAck {
  ok?: boolean;
  ingested?: number;
  duplicates?: number;
  rejected?: number;
}


/** One report pass (exported for tests; the loop below drives it live).
 *  Returns the number of events acked (0 = nothing pending). */
export async function reportUsageOnce(opts: {
  client: ClawBitsClient;
  abortSignal?: AbortSignal;
  requestTimeoutMs?: number;
}): Promise<number> {
  const events = peekUsageEvents(USAGE_REPORT_MAX_EVENTS);
  if (events.length === 0) return 0;
  await timedRequest<UsageReportAck>(
    opts.client,
    "usage report",
    "POST",
    REPORT_PATH,
    {
      json: { plugin_version: PLUGIN_VERSION, source: "hook", events },
      timeoutMs: opts.requestTimeoutMs ?? USAGE_REQUEST_TIMEOUT_MS,
      ...(opts.abortSignal ? { parent: opts.abortSignal } : {}),
    },
  );
  // Ack strictly after the 2xx — a thrown request keeps the batch queued for
  // the next cycle (server-side dedup absorbs the overlap).
  ackUsageEvents(events);
  return events.length;
}

export interface UsageReporterOptions {
  client: ClawBitsClient;
  abortSignal: AbortSignal;
  accountId: string;
  intervalMs?: number;
  log?: BasicLogger;
}

/**
 * Run the usage report loop until `abortSignal` fires. Best-effort: every
 * failure is logged and swallowed; never blocks the gateway, never rejects.
 * On a multi-account gateway only the first account's loop drains the shared
 * in-process queue (see claimUsageReporter).
 */
export async function runUsageReporter(opts: UsageReporterOptions): Promise<void> {
  const { client, abortSignal, accountId, log } = opts;
  const intervalMs = opts.intervalMs ?? USAGE_REPORT_INTERVAL_MS;
  if (!client.hasApiKey()) {
    logInfo(log, `[clawbits/${accountId}] usage reporter idle: no api key`);
    return;
  }
  if (!claimUsageReporter(accountId)) {
    logInfo(
      log,
      `[clawbits/${accountId}] usage reporter skipped: another account already reports for this gateway`,
    );
    return;
  }
  logInfo(
    log,
    `[clawbits/${accountId}] usage reporter started (every ${String(
      Math.round(intervalMs / 1000),
    )}s)`,
  );

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (abortSignal.aborted) {
        resolve();
        return;
      }
      const finish = () => {
        clearTimeout(timer);
        abortSignal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      abortSignal.addEventListener("abort", finish, { once: true });
    });

  try {
    while (!abortSignal.aborted) {
      try {
        const sent = await reportUsageOnce({ client, abortSignal });
        if (sent > 0) {
          const dropped = droppedUsageCount();
          logInfo(
            log,
            `[clawbits/${accountId}] usage report: ${String(sent)} event(s) sent, ${String(
              pendingUsageCount(),
            )} pending${dropped > 0 ? `, ${String(dropped)} dropped by overflow since start` : ""}`,
          );
        }
      } catch (err) {
        log?.warn?.(
          `[clawbits/${accountId}] usage report failed (will retry): ${String(
            (err as Error)?.message ?? err,
          )}`,
        );
      }
      await sleep(intervalMs);
    }
  } finally {
    releaseUsageReporter(accountId);
  }
}
