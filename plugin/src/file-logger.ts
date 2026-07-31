import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ClawBitsRequestMetric } from "./latency-metrics.js";

const pluginLogPath = resolve(process.cwd(), "clawbits-plugin.log");
const latencyLogPath = resolve(process.cwd(), "clawbits-latency.log");
const traceLogPath = resolve(process.cwd(), "clawbits-trace.log");

let writeQueue = Promise.resolve();

function enqueueWrite(path: string, line: string): void {
  writeQueue = writeQueue
    .catch(() => {})
    .then(() => appendFile(path, line, "utf8"))
    .catch(() => {});
}

export function writePluginLog(
  level: "debug" | "info" | "warn" | "error",
  message: string,
): void {
  enqueueWrite(pluginLogPath, `${new Date().toISOString()} [${level.toUpperCase()}] ${message}\n`);
}

export function writeLatencyLog(accountId: string, metric: ClawBitsRequestMetric): void {
  enqueueWrite(
    latencyLogPath,
    `${JSON.stringify({
      ts: new Date(metric.timestamp).toISOString(),
      accountId,
      ...metric,
    })}\n`,
  );
}

/**
 * One span in the cross-subsystem latency trace. Appended as a JSONL line to
 * ``clawbits-trace.log`` (same dir as the plugin/latency logs). The collator
 * groups these by ``trace_id`` and merges them with the server's ``TRACE``
 * log lines and the frontend spans to render a single waterfall for a message
 * round-trip — the tool for answering "why is this request taking so long".
 *
 * Plugin-emitted spans today: ``plugin.pickup_lag`` (server post-create →
 * agent pickup) and ``plugin.agent_turn`` (OpenClaw runtime: model + tools).
 * Both are low-volume (human-paced, one per inbound/turn), so this is safe to
 * leave always-on alongside the existing latency log.
 */
export interface TraceSpan {
  /** Correlation id shared across every hop of one round-trip. ``null`` for
   *  an untraced message (still useful for the raw timing). */
  trace_id: string | null;
  /** Dotted span name, e.g. ``plugin.agent_turn``. */
  span: string;
  /** Emitting subsystem — always ``"plugin"`` from here. */
  subsystem: string;
  /** Wall-clock duration of the span in ms, when it brackets an interval. */
  dur_ms?: number;
  /** Epoch-ms start/end for ordering across processes (skew caveats apply
   *  across machines; within one host these align). */
  t_start_ms?: number;
  t_end_ms?: number;
  /** Free-form span attributes (post ids, channel, source, etc.). */
  [key: string]: unknown;
}

/** Optional remote sink for trace spans (the standalone trace viewer's
 *  ``POST /api/trace/spans``). Registered once by the client when it knows the
 *  Clawbits base URL — see ``setTraceSink``. ``undefined`` → file-only, as
 *  before. Kept transport-agnostic here so the logger has no fetch/URL deps. */
let traceSink: ((span: TraceSpan) => void) | undefined;

/** Wire a best-effort remote sink for trace spans. The poster must never throw
 *  or block; tracing is telemetry and must not affect a turn. */
export function setTraceSink(poster: (span: TraceSpan) => void): void {
  traceSink = poster;
}

export function writeTraceSpan(span: TraceSpan): void {
  enqueueWrite(traceLogPath, `${JSON.stringify({ ts: new Date().toISOString(), ...span })}\n`);
  // Ship to the viewer's ring too, when a sink is registered. Fire-and-forget;
  // any failure is swallowed by the poster itself.
  try {
    traceSink?.(span);
  } catch {
    /* a trace breadcrumb must never break the caller */
  }
}

export interface BasicLogger {
  debug?: (msg: string) => void;
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export function logDebug(log: BasicLogger | undefined, message: string): void {
  writePluginLog("debug", message);
  log?.debug?.(message);
}

export function logInfo(log: BasicLogger | undefined, message: string): void {
  writePluginLog("info", message);
  log?.info?.(message);
}

export function logWarn(log: BasicLogger | undefined, message: string): void {
  writePluginLog("warn", message);
  log?.warn?.(message);
}

export function logError(log: BasicLogger | undefined, message: string): void {
  writePluginLog("error", message);
  log?.error?.(message);
}

export function consoleErrorWithFile(message: string): void {
  writePluginLog("error", message);
  console.error(message);
}

// ---------------------------------------------------------------------------
// APP_ENV-gated plugin debug channel
//
// Environment tiers (read at call time, not module load, so per-call envs
// like `APP_ENV=plugin_development openclaw ...` and live process.env
// flips in tests both take effect immediately):
//
//   - production (or anything unrecognized): silent. No healthcheck, no
//     plugin debug. This is the default for shipped installs.
//   - APP_ENV=development: enables the channel healthcheck (auto-run after
//     signup + the standalone `openclaw clawbits healthcheck` subcommand).
//     Plugin debug is still off — keeps logs lean while iterating on the
//     channel API itself.
//   - APP_ENV=plugin_development: everything `development` enables, PLUS
//     plugin-side checkpoint debug lines (receive, deliver, send) for
//     end-to-end flow tracing when you are iterating on the plugin's own
//     delivery wiring. Implies dev, so callers only ever check the broader
//     gate (`isHealthcheckEnabled`) when they want both modes.
// ---------------------------------------------------------------------------

/** True for either `development` or `plugin_development`. Use this for
 *  surfaces that should be available throughout the inner-dev loop. */
export function isHealthcheckEnvEnabled(): boolean {
  const v = process.env["APP_ENV"];
  return v === "development" || v === "plugin_development";
}

/** True ONLY when APP_ENV=plugin_development. Use this to gate verbose
 *  plugin-side checkpoint logs that confirm inbound/outbound flow. */
export function isPluginDebugEnv(): boolean {
  return process.env["APP_ENV"] === "plugin_development";
}

/**
 * Emit a plugin debug checkpoint when (and only when)
 * `APP_ENV=plugin_development`. Writes to the plugin log file AND stderr
 * so it shows up both in `~/.openclaw/clawbits-plugin.log` and in the live
 * console of `openclaw gateway` / `pnpm dev`. No-op otherwise — safe to
 * sprinkle on hot paths without paying any log cost in production or
 * regular development.
 */
export function pluginDebug(message: string): void {
  if (!isPluginDebugEnv()) return;
  const tagged = `[plugin-debug] ${message}`;
  writePluginLog("debug", tagged);
  // Go through `process.stderr.write` rather than `console.error` because
  // Bun's `console.error` is implemented in native code and doesn't dispatch
  // through the JS-level `process.stderr.write` (so tests that swap that
  // method to capture output can't see anything). Writing here directly
  // keeps console capture and child-process piping working uniformly.
  process.stderr.write(`${tagged}\n`);
}
