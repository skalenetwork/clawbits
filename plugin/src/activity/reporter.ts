// Activity lane of live activity (LIVE_AGENT_ACTIVITY_PLAN §3.3): turns
// ``thinking`` / ``tool`` agent events into sanitized, rate-capped status
// updates on the channel status lane. Ephemeral by design — the server
// TTLs the payload with the presence entry and never persists it.

import { ClawBitsError } from "../errors.js";
import { pluginDebug } from "../file-logger.js";
import * as realtimeTools from "../tools/realtime.js";
import type { AgentActivity } from "../tools/realtime.js";
import {
  sanitizeThinkingTail,
  sanitizeToolDetail,
  sanitizeToolResultDescriptor,
  sanitizeToolSummary,
} from "./sanitize.js";
import type { InFlightTurn } from "./turn-registry.js";

/** Thinking updates are a ticker — latest-wins at ~1/s. Tool start/done are
 *  sparse discrete moments and send immediately (still on the serialized
 *  chain, so a burst can't reorder). */
const THINKING_MIN_INTERVAL_MS = 1000;

/** Process-wide latch: the server told us it doesn't know the ``activity``
 *  field (422 from a pre-activity Clawbits). Stop sending it anywhere —
 *  plain status updates elsewhere in the plugin are unaffected. */
let serverLacksActivity = false;

interface ReporterState {
  disabled: boolean;
  lastThinkingSentAt: number;
  thinkingTimer: ReturnType<typeof setTimeout> | null;
  pendingThinking: string | null;
  toolStartedAt: Map<string, number>;
  inflight: Promise<void>;
}

const states = new WeakMap<InFlightTurn, ReporterState>();

function stateFor(turn: InFlightTurn): ReporterState {
  let state = states.get(turn);
  if (!state) {
    state = {
      disabled: false,
      lastThinkingSentAt: 0,
      thinkingTimer: null,
      pendingThinking: null,
      toolStartedAt: new Map(),
      inflight: Promise.resolve(),
    };
    states.set(turn, state);
  }
  return state;
}

function queueSend(turn: InFlightTurn, state: ReporterState, activity: AgentActivity): void {
  state.inflight = state.inflight.then(async () => {
    if (state.disabled || serverLacksActivity) return;
    try {
      await realtimeTools.setAgentStatus(turn.client, turn.channelId, "generating", activity);
    } catch (err) {
      // A 422 means the server predates the activity field — latch off
      // process-wide so we stop paying the failed request everywhere.
      if (err instanceof ClawBitsError && err.statusCode === 422) {
        serverLacksActivity = true;
        pluginDebug("activity reporter: server rejected activity (422) — lane latched off");
      } else {
        state.disabled = true;
        pluginDebug(
          `activity reporter stopped for channel=${turn.channelId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  });
}

export function onThinkingEvent(turn: InFlightTurn, data: unknown): void {
  if (!turn.liveActivity || serverLacksActivity) return;
  const state = stateFor(turn);
  if (state.disabled) return;
  if (data === null || typeof data !== "object") return;
  const d = data as Record<string, unknown>;
  const label = sanitizeThinkingTail(d.text ?? d.delta);
  if (!label) return;
  state.pendingThinking = label;

  const now = Date.now();
  const dueIn = THINKING_MIN_INTERVAL_MS - (now - state.lastThinkingSentAt);
  if (dueIn <= 0) {
    flushThinking(turn, state);
    return;
  }
  if (!state.thinkingTimer) {
    state.thinkingTimer = setTimeout(() => {
      state.thinkingTimer = null;
      flushThinking(turn, state);
    }, dueIn);
  }
}

function flushThinking(turn: InFlightTurn, state: ReporterState): void {
  const label = state.pendingThinking;
  if (label === null) return;
  state.pendingThinking = null;
  state.lastThinkingSentAt = Date.now();
  queueSend(turn, state, { kind: "thinking", label });
}

export function onToolEvent(turn: InFlightTurn, data: unknown): void {
  if (!turn.liveActivity || serverLacksActivity) return;
  const state = stateFor(turn);
  if (state.disabled) return;
  if (data === null || typeof data !== "object") return;
  const d = data as Record<string, unknown>;
  const phase = typeof d.phase === "string" ? d.phase : "";
  const name = typeof d.name === "string" && d.name ? d.name : "tool";
  const callId = typeof d.toolCallId === "string" ? d.toolCallId : "";

  if (phase === "start") {
    if (callId) state.toolStartedAt.set(callId, Date.now());
    queueSend(turn, state, {
      kind: "tool",
      tool: name,
      label: sanitizeToolSummary(name, d.args),
    });
    return;
  }
  if (phase === "result") {
    const startedAt = callId ? state.toolStartedAt.get(callId) : undefined;
    if (callId) state.toolStartedAt.delete(callId);
    queueSend(turn, state, {
      kind: "tool_done",
      tool: name,
      // Usually just the tool name — the UI keeps whatever the START label
      // captured. The exception is a harness that only knows the interesting
      // argument once the call finishes (Codex web_search: the query and the
      // opened URL both land with `item/completed`). `meta` is OpenClaw's own
      // formatted detail and covers queries; the result descriptor covers the
      // URL of a page-open, which `meta` has no formatter for.
      label:
        sanitizeToolDetail(name, d.meta) ?? sanitizeToolResultDescriptor(name, d.result) ?? name,
      ok: d.isError !== true,
      ...(startedAt !== undefined ? { duration_ms: Date.now() - startedAt } : {}),
    });
  }
}

/** End of run: drop pending ticks and disable the lane so a queued-but-
 *  unsent update can't land AFTER the adapter's ``clearGenerating`` flips
 *  the status back to online (which would re-light the pill for a TTL).
 *  Idempotent. */
export function finishReporting(turn: InFlightTurn): void {
  const state = states.get(turn);
  if (!state) return;
  state.disabled = true;
  if (state.thinkingTimer) {
    clearTimeout(state.thinkingTimer);
    state.thinkingTimer = null;
  }
  state.pendingThinking = null;
}

/** Test seams. */
export function __reporterInflightForTest(turn: InFlightTurn): Promise<void> {
  return states.get(turn)?.inflight ?? Promise.resolve();
}

export function __resetActivityReporterForTest(): void {
  serverLacksActivity = false;
}
