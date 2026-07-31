// Text lane of live activity (LIVE_AGENT_ACTIVITY_PLAN §3.2): coalesces
// ``assistant`` agent events (cumulative cleaned text + deltas) into
// serialized PATCH ``{append}`` calls on the turn's open draft post.
//
// Cosmetic-only by construction: the delivery path's final
// ``{replace, done}`` PATCH stays authoritative, so anything that goes
// wrong here (races with finalize, network errors, draft gone) simply
// stops the lane for the turn — the reply itself is unaffected.

import { pluginDebug } from "../file-logger.js";
import * as realtimeTools from "../tools/realtime.js";
import type { InFlightTurn } from "./turn-registry.js";

/** Flush cadence: whichever comes first. April-design numbers. */
const FLUSH_IDLE_MS = 180;
const FLUSH_MIN_CHARS = 120;
/** Server-side ``append`` cap is 4000 chars; stay under it per PATCH. */
const APPEND_CHUNK_MAX_CHARS = 3900;

interface StreamState {
  cumulative: string;
  sentChars: number;
  /** The runner rewrote already-streamed text — next flush is a replace. */
  pendingReplace: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** PATCH serialization chain — order is the correctness invariant. */
  inflight: Promise<void>;
  stopped: boolean;
}

const states = new WeakMap<InFlightTurn, StreamState>();

function stateFor(turn: InFlightTurn): StreamState {
  let state = states.get(turn);
  if (!state) {
    state = {
      cumulative: "",
      sentChars: 0,
      pendingReplace: false,
      timer: null,
      inflight: Promise.resolve(),
      stopped: false,
    };
    states.set(turn, state);
  }
  return state;
}

function stop(state: StreamState): void {
  state.stopped = true;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

function scheduleFlush(turn: InFlightTurn, state: StreamState): void {
  const unsent = state.cumulative.length - state.sentChars;
  if (state.pendingReplace || unsent >= FLUSH_MIN_CHARS) {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    queueFlush(turn, state);
    return;
  }
  if (unsent <= 0 || state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    queueFlush(turn, state);
  }, FLUSH_IDLE_MS);
}

function queueFlush(turn: InFlightTurn, state: StreamState): void {
  state.inflight = state.inflight.then(() => flushOnce(turn, state));
}

async function flushOnce(turn: InFlightTurn, state: StreamState): Promise<void> {
  if (state.stopped) return;
  // Read (never claim) the shared draft ref: the delivery path owns its
  // lifecycle. A missing id means finalized/cancelled/never-created — the
  // lane is over for this turn.
  const draftPostId = turn.draftRef.id;
  if (draftPostId === undefined) {
    stop(state);
    return;
  }
  try {
    if (state.pendingReplace) {
      state.pendingReplace = false;
      const body = state.cumulative;
      await realtimeTools.patchDraftPost(turn.client, turn.channelId, draftPostId, {
        replace: body,
      });
      state.sentChars = body.length;
      return;
    }
    while (!state.stopped && state.sentChars < state.cumulative.length) {
      const chunk = state.cumulative.slice(
        state.sentChars,
        state.sentChars + APPEND_CHUNK_MAX_CHARS,
      );
      await realtimeTools.patchDraftPost(turn.client, turn.channelId, draftPostId, {
        append: chunk,
      });
      state.sentChars += chunk.length;
    }
  } catch (err) {
    // Expected end-of-turn races: deliver() finalized the draft (409) or it
    // was cancelled (404). Anything else is still only cosmetic — stop the
    // lane either way, quietly.
    stop(state);
    pluginDebug(
      `stream-patcher stopped for channel=${turn.channelId} draft=${String(draftPostId)}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** Feed one ``assistant`` agent event into the turn's stream state. */
export function onAssistantEvent(turn: InFlightTurn, data: unknown): void {
  if (!turn.streaming) return;
  const state = stateFor(turn);
  if (state.stopped) return;
  if (data === null || typeof data !== "object") return;
  const d = data as Record<string, unknown>;
  const text = typeof d.text === "string" ? d.text : undefined;
  const delta = typeof d.delta === "string" ? d.delta : undefined;
  const replace = d.replace === true;

  if (replace && text !== undefined) {
    // Only downgrade to a wire replace when already-sent chars changed;
    // a replace event that still extends what we sent keeps appending.
    if (
      state.sentChars > 0 &&
      !text.startsWith(state.cumulative.slice(0, state.sentChars))
    ) {
      state.pendingReplace = true;
    }
    state.cumulative = text;
  } else if (text !== undefined && text.length >= state.cumulative.length) {
    state.cumulative = text;
  } else if (delta) {
    state.cumulative += delta;
  } else {
    return;
  }
  scheduleFlush(turn, state);
}

/** End of run (lifecycle end/error, or turn unregistration): stop the lane
 *  and drop anything unsent — the authoritative final text lands via the
 *  delivery path. Idempotent. */
export function finishStreaming(turn: InFlightTurn): void {
  const state = states.get(turn);
  if (state) stop(state);
}

/** Test seam: await the PATCH chain so assertions see a settled state. */
export function __streamPatcherInflightForTest(turn: InFlightTurn): Promise<void> {
  return states.get(turn)?.inflight ?? Promise.resolve();
}
