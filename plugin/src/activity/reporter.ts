// Activity lane of live activity (LIVE_AGENT_ACTIVITY_PLAN §3.3): turns thinking, narration, tool and
// exec-outcome agent events into sanitized, rate-capped status updates on the channel status lane, and
// keeps the turn's tool and narration steps (never its thinking) for the reply post to carry.

import { ClawBitsError } from "../errors.js";
import { pluginDebug } from "../file-logger.js";
import * as realtimeTools from "../tools/realtime.js";
import type { AgentActivity, McpApp, TurnStep } from "../tools/realtime.js";
import { fetchMcpApp, mcpAppView } from "./mcp-apps.js";
import {
  sanitizeThinkingTail,
  sanitizeToolDetail,
  sanitizeToolResultDescriptor,
  sanitizeToolSummary,
} from "./sanitize.js";
import type { InFlightTurn } from "./turn-registry.js";

/** Prose (thinking tails, narration) is a ticker, latest-wins at ~1/s. Tool start/done are sparse
 *  discrete moments and send immediately, after any pending prose, on the serialized chain. */
const PROSE_MIN_INTERVAL_MS = 1000;

/** Steps a reply keeps, as many as the server stores; later ones still stream live. */
const TURN_STEPS_MAX = 200;

/** Tool search's dispatcher: the model's call to a searched tool arrives as `tool_call` with the target's id and
 *  arguments, then the host emits the target's own nested events (`parentToolCallId`). One step, named for the target. */
const TOOL_CALL = "tool_call";
const CATALOG_PREFIX = /^(?:openclaw|mcp|client):[^:]+:/;

interface ToolSearchCall {
  id?: unknown;
  name?: unknown;
  toolId?: unknown;
  args?: unknown;
  input?: unknown;
}

/** Process-wide latch: the server told us it doesn't know the ``activity``
 *  field (422 from a pre-activity Clawbits). Stop sending it anywhere —
 *  plain status updates elsewhere in the plugin are unaffected. */
let serverLacksActivity = false;

interface ReporterState {
  disabled: boolean;
  lastProseSentAt: number;
  proseTimer: ReturnType<typeof setTimeout> | null;
  pendingProse: AgentActivity | null;
  /** The turn's tool and narration steps by id, in the order they began. */
  steps: Map<string, TurnStep>;
  startedAt: Map<string, number>;
  /** Calls a tool search dispatched, to the step that dispatched them. */
  parentOf: Map<string, string>;
  /** The MCP App views steps rendered, read as their results land. */
  apps: Map<string, Promise<McpApp | undefined>>;
  last: AgentActivity | undefined;
  inflight: Promise<void>;
}

const states = new WeakMap<InFlightTurn, ReporterState>();

function stateFor(turn: InFlightTurn): ReporterState {
  let state = states.get(turn);
  if (!state) {
    state = {
      disabled: false,
      lastProseSentAt: 0,
      proseTimer: null,
      pendingProse: null,
      steps: new Map(),
      startedAt: new Map(),
      parentOf: new Map(),
      apps: new Map(),
      last: undefined,
      inflight: Promise.resolve(),
    };
    states.set(turn, state);
  }
  return state;
}

/** The turn's reporting state, or undefined when the lane is off for it. Steps are kept even once sending stops. */
function reporting(turn: InFlightTurn, data: unknown): [ReporterState, Record<string, unknown>] | undefined {
  return turn.liveActivity && data !== null && typeof data === "object"
    ? [stateFor(turn), data as Record<string, unknown>]
    : undefined;
}

const silenced = (state: ReporterState): boolean => state.disabled || serverLacksActivity;

function keepStep(state: ReporterState, step: TurnStep): void {
  if (state.steps.has(step.id) || state.steps.size < TURN_STEPS_MAX) state.steps.set(step.id, step);
}

function queueSend(turn: InFlightTurn, state: ReporterState, activity: AgentActivity): void {
  if (silenced(state)) return;
  state.last = activity;
  state.inflight = state.inflight.then(async () => {
    if (silenced(state)) return;
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

function tickProse(turn: InFlightTurn, state: ReporterState, activity: AgentActivity): void {
  if (silenced(state)) return;
  state.pendingProse = activity;
  const dueIn = PROSE_MIN_INTERVAL_MS - (Date.now() - state.lastProseSentAt);
  if (dueIn <= 0) {
    flushProse(turn, state);
    return;
  }
  state.proseTimer ??= setTimeout(() => {
    state.proseTimer = null;
    flushProse(turn, state);
  }, dueIn);
}

function flushProse(turn: InFlightTurn, state: ReporterState): void {
  const activity = state.pendingProse;
  if (activity === null) return;
  state.pendingProse = null;
  state.lastProseSentAt = Date.now();
  queueSend(turn, state, activity);
}

export function onThinkingEvent(turn: InFlightTurn, data: unknown): void {
  const live = reporting(turn, data);
  if (!live) return;
  const [state, d] = live;
  const label = sanitizeThinkingTail(d.text ?? d.delta);
  if (label) tickProse(turn, state, { kind: "thinking", label });
}

/** OpenClaw's `item` stream: the model's narration for the person watching (commentary-phase preambles). */
export function onItemEvent(turn: InFlightTurn, data: unknown): void {
  const live = reporting(turn, data);
  if (!live) return;
  const [state, d] = live;
  const label = d.kind === "preamble" ? sanitizeThinkingTail(d.progressText) : undefined;
  if (!label) return;
  const id = typeof d.itemId === "string" && d.itemId ? d.itemId : "preamble";
  keepStep(state, { kind: "note", id, label });
  tickProse(turn, state, { kind: "note", id, label });
}

export function onToolEvent(turn: InFlightTurn, data: unknown): void {
  const live = reporting(turn, data);
  if (!live) return;
  const [state, d] = live;
  const callId = typeof d.toolCallId === "string" ? d.toolCallId : "";
  const parent = typeof d.parentToolCallId === "string" ? d.parentToolCallId : undefined;
  const view = d.phase === "result" ? mcpAppView(d.result) : undefined;
  if (view) state.apps.set(parent ?? callId, fetchMcpApp(view));
  if (parent) {
    if (callId) state.parentOf.set(callId, parent);
    return;
  }
  if (d.hideFromChannelProgress === true) return;
  const phase = typeof d.phase === "string" ? d.phase : "";
  const name = typeof d.name === "string" && d.name ? d.name : "tool";
  const id = callId ? { id: callId } : {};

  if (phase === "start") {
    const call = name === TOOL_CALL ? (d.args as ToolSearchCall | undefined) : undefined;
    const target = call?.id ?? call?.name ?? call?.toolId;
    const tool = typeof target === "string" && target ? target.replace(CATALOG_PREFIX, "") : name;
    const label = sanitizeToolSummary(tool, call ? (call.args ?? call.input) : d.args);
    if (callId) {
      state.startedAt.set(callId, performance.now());
      keepStep(state, { kind: "tool", id: callId, tool, label });
    }
    flushProse(turn, state);
    queueSend(turn, state, { kind: "tool", ...id, tool, label });
    return;
  }
  if (phase === "result") {
    const step = state.steps.get(callId);
    const tool = step?.tool ?? name;
    const startedAt = state.startedAt.get(callId);
    // Usually just the tool name — the UI keeps whatever the START label
    // captured. The exception is a harness that only knows the interesting
    // argument once the call finishes (Codex web_search: the query and the
    // opened URL both land with `item/completed`). `meta` is OpenClaw's own
    // formatted detail and covers queries; the result descriptor covers the
    // URL of a page-open, which `meta` has no formatter for.
    const label = sanitizeToolDetail(tool, d.meta) ?? sanitizeToolResultDescriptor(tool, d.result) ?? tool;
    const outcome = {
      ok: step?.ok !== false && d.isError !== true,
      ...(startedAt !== undefined ? { duration_ms: Math.round(performance.now() - startedAt) } : {}),
    };
    state.startedAt.delete(callId);
    if (step) state.steps.set(callId, { ...step, ...outcome, ...(step.label === tool ? { label } : {}) });
    queueSend(turn, state, { kind: "tool_done", ...id, tool, label, ...outcome });
  }
}

/** OpenClaw's `command_output` stream: an exec that ran but exited nonzero, which the tool event reports as success.
 *  An exec a tool search ran fails the step that dispatched it, and may end before that step's own result. */
export function onCommandOutputEvent(turn: InFlightTurn, data: unknown): void {
  const live = reporting(turn, data);
  if (!live) return;
  const [state, d] = live;
  if (d.phase !== "end" || d.status !== "failed" || typeof d.toolCallId !== "string") return;
  const step = state.steps.get(state.parentOf.get(d.toolCallId) ?? d.toolCallId);
  if (step?.kind !== "tool" || step.ok === false) return;
  const failed = { ...step, ok: false };
  state.steps.set(step.id, failed);
  queueSend(turn, state, { ...failed, kind: "tool_done" });
}

/** The turn's tool and narration steps so far, with the App views they rendered, for the reply post to keep; none when the server predates them. */
export async function turnSteps(turn: InFlightTurn): Promise<TurnStep[] | undefined> {
  const state = states.get(turn);
  if (!state?.steps.size || serverLacksActivity) return undefined;
  return Promise.all(
    [...state.steps.values()].map(async (step) => {
      const app = await state.apps.get(step.id);
      return app ? { ...step, app } : step;
    }),
  );
}

/** The activity last reported for a turn, so a status heartbeat can repeat it instead of clearing it. */
export function lastActivity(turn: InFlightTurn): AgentActivity | undefined {
  const state = states.get(turn);
  return state && !silenced(state) ? state.last : undefined;
}

/** End of run: drop pending ticks and disable the lane so a queued-but-
 *  unsent update can't land AFTER the adapter's ``clearGenerating`` flips
 *  the status back to online (which would re-light the pill for a TTL).
 *  Idempotent. */
export function finishReporting(turn: InFlightTurn): void {
  const state = states.get(turn);
  if (!state) return;
  state.disabled = true;
  if (state.proseTimer) {
    clearTimeout(state.proseTimer);
    state.proseTimer = null;
  }
  state.pendingProse = null;
}

/** Test seams. */
export function __reporterInflightForTest(turn: InFlightTurn): Promise<void> {
  return states.get(turn)?.inflight ?? Promise.resolve();
}

export function __resetActivityReporterForTest(): void {
  serverLacksActivity = false;
}
