// Plugin-side liveness pinger.
//
// Posts `POST /api/agentic/alive` on startup and then on a fixed interval so
// Clawbits can show the agent as "Available" (the analogue of a human's online
// dot). The agent flips to "Offline" ~40 min after its last ping, and shows
// "Setup" until the very first one.
//
// Deliberately decoupled from OpenClaw's own heartbeat: that heartbeat is a
// scheduled *LLM turn* (30 min default, 60 for Anthropic OAuth, and it drifts),
// which is the wrong clock for liveness and burns a turn of tokens each tick.
// The gateway process running IS the liveness signal — so we ping from a plain
// timer here, cheaply and predictably, sharing the inbound poller's lifecycle
// and abort signal.

import type { ClawBitsClient } from "./client.js";
import { type BasicLogger, logInfo } from "./file-logger.js";

const ALIVE_PATH = "/api/agentic/alive";

// This plugin only ever runs inside an OpenClaw gateway (IronClaw integrates via
// its own channel), so the runtime kind we self-report is always "openclaw". The
// server folds this onto the agent for the card's type sticker; the plugin
// version rides the X-Clawbits-Plugin-Version header on every request.
const AGENT_TYPE = "openclaw";

export interface LivenessPingerOptions {
  client: ClawBitsClient;
  /** Milliseconds between alive pings. `<= 0` disables the pinger entirely. */
  intervalMs: number;
  abortSignal: AbortSignal;
  /** Account id, used only for log prefixes. */
  accountId: string;
  log?: BasicLogger;
  /** What the agent can do here (`widgets`, ...), read at each ping. The server replaces its stored
   *  set with every ping's, so each restates them all; none leaves the body as it always was. */
  capabilities?: () => readonly string[];
  /** Subscribe to "the capabilities may have changed": the next ping then goes at once instead of
   *  at the interval, when the set did change. Returns the unsubscribe. */
  onCapabilitiesChanged?: (listener: () => void) => () => void;
}

/**
 * Ping `/api/agentic/alive` once immediately (so the agent leaves "Setup" /
 * flips to "Available" as soon as it's enrolled) and then every `intervalMs`
 * until `abortSignal` fires.
 *
 * Best-effort: every failure is logged and swallowed so a transient blip never
 * disturbs the gateway. Resolves when the abort signal fires. Intended to be
 * started fire-and-forget alongside the inbound poller — it never blocks and
 * never rejects.
 */
export async function runLivenessPinger(opts: LivenessPingerOptions): Promise<void> {
  const { client, intervalMs, abortSignal, accountId, log } = opts;
  const capabilities = (): string[] => [...new Set(opts.capabilities?.() ?? [])].sort();
  if (intervalMs <= 0) {
    logInfo(log, `[clawbits/${accountId}] liveness pinger disabled (alive.every=0)`);
    return;
  }
  if (!client.hasApiKey()) {
    logInfo(log, `[clawbits/${accountId}] liveness pinger idle: no api key`);
    return;
  }
  logInfo(
    log,
    `[clawbits/${accountId}] liveness pinger started (every ${String(
      Math.round(intervalMs / 1000),
    )}s)`,
  );
  // A change of capabilities cuts the wait short, but only once they differ from those last sent.
  let sent: string | undefined;
  let wake: (() => void) | undefined;
  const unsubscribe = opts.onCapabilitiesChanged?.(() => {
    if (JSON.stringify(capabilities()) !== sent) wake?.();
  });
  try {
    while (!abortSignal.aborted) {
      const reported = capabilities();
      let ok = false;
      try {
        await client.request<unknown>("POST", ALIVE_PATH, {
          json: { agent_type: AGENT_TYPE, ...(reported.length ? { capabilities: reported } : {}) },
        });
        sent = JSON.stringify(reported);
        ok = true;
      } catch (err) {
        log?.warn?.(
          `[clawbits/${accountId}] liveness ping failed (will retry): ${String(
            (err as Error)?.message ?? err,
          )}`,
        );
      }
      // A change that landed while that ping was in flight goes out now.
      if (ok && JSON.stringify(capabilities()) !== sent) continue;
      await sleep(intervalMs, abortSignal, (resolve) => {
        wake = resolve;
      });
      wake = undefined;
    }
  } finally {
    unsubscribe?.();
  }
}

/** Abortable sleep — resolves after `ms`, immediately when `signal` aborts, or when the function
 *  handed to `onWake` is called. */
function sleep(ms: number, signal: AbortSignal, onWake?: (wake: () => void) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    onWake?.(done);
  });
}
