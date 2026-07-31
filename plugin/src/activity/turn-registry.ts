// In-flight turn registry: correlates gateway agent events (keyed by runId /
// sessionKey) with the Clawbits conversation + draft they belong to
// (LIVE_AGENT_ACTIVITY_PLAN §3.1).
//
// The gateway adapter registers a turn when it dispatches an inbound into
// the runtime; the agent-event subscription binds the runId on
// ``lifecycle:start`` and looks turns up by runId from then on. Correlation
// rules, conservative on purpose (a mis-bound turn would stream one
// conversation's reply into another's draft — worse than no streaming):
//
//   1. runId already bound → that turn.
//   2. The event's sessionKey ends with ``:clawbits:channel:<channelId>``
//      (how the SDK keys our channel-peer sessions) → the matching unbound
//      turn.
//   3. Exactly ONE unbound turn exists → bind it. This is the DM case:
//      direct chats collapse to the agent's main session (no channel id in
//      the key), and core's per-session write lock means only one such turn
//      is actually running.
//   4. Anything else (ambiguity) → no bind; the turn simply doesn't stream.
//
// Unmatched runs (cron ticks, heartbeats, subagents, email turns) never
// bind — observers ignore them.

import type { ClawBitsClient } from "../client.js";
import type { OpenDraftRef } from "../draft-registry.js";

/** Defensive upper bound on how long a registered turn may stay claimable.
 *  The gateway adapter unregisters in its ``finally``; the TTL only matters
 *  if that path is somehow skipped (process-level bugs), so it is generous. */
const TURN_TTL_MS = 10 * 60_000;

export interface InFlightTurn {
  accountId: string;
  channelId: string;
  /** Shared with the gateway adapter / draft registry: ``id === undefined``
   *  means the draft is gone (finalized, cancelled, or never created). */
  draftRef: OpenDraftRef;
  client: ClawBitsClient;
  /** ``true`` for non-direct channels: the session key is deterministic and
   *  carries the channel id, enabling rule 2. DMs leave this unset. */
  channelKeyedSession: boolean;
  streaming: boolean;
  liveActivity: boolean;
  registeredAt: number;
  runId?: string;
}

const turns = new Set<InFlightTurn>();
const byRunId = new Map<string, InFlightTurn>();

function pruneExpired(now: number): void {
  for (const turn of turns) {
    if (now - turn.registeredAt > TURN_TTL_MS) {
      turns.delete(turn);
      if (turn.runId !== undefined) byRunId.delete(turn.runId);
    }
  }
}

export function registerInFlightTurn(
  turn: Omit<InFlightTurn, "registeredAt" | "runId">,
): InFlightTurn {
  const record: InFlightTurn = { ...turn, registeredAt: Date.now() };
  turns.add(record);
  return record;
}

export function unregisterInFlightTurn(turn: InFlightTurn): void {
  turns.delete(turn);
  if (turn.runId !== undefined && byRunId.get(turn.runId) === turn) {
    byRunId.delete(turn.runId);
  }
}

/** Suffix the SDK uses for our channel-peer session keys — see the routing
 *  comment in gateway-adapter.ts (``agent:<id>:clawbits:channel:<chid>``). */
function sessionKeyMatchesChannel(sessionKey: string, channelId: string): boolean {
  return sessionKey.endsWith(`:clawbits:channel:${channelId}`);
}

/** Look up (and lazily bind) the turn for a run. Safe to call for every
 *  agent event — non-matching runs return undefined. */
export function claimTurnForRun(
  runId: string | undefined,
  sessionKey?: string,
): InFlightTurn | undefined {
  if (!runId) return undefined;
  const bound = byRunId.get(runId);
  if (bound) return bound;

  const now = Date.now();
  pruneExpired(now);

  const unbound: InFlightTurn[] = [];
  for (const turn of turns) {
    if (turn.runId === undefined) unbound.push(turn);
  }
  let match: InFlightTurn | undefined;
  if (sessionKey) {
    match = unbound.find(
      (t) => t.channelKeyedSession && sessionKeyMatchesChannel(sessionKey, t.channelId),
    );
  }
  if (!match) {
    // DM fallback: only when it is unambiguous.
    const dmCandidates = unbound.filter((t) => !t.channelKeyedSession);
    if (dmCandidates.length === 1 && unbound.length === 1) {
      match = dmCandidates[0];
    }
  }
  if (!match) return undefined;
  match.runId = runId;
  byRunId.set(runId, match);
  return match;
}

/** Fast path for events after the bind (assistant/thinking/tool). */
export function turnForRun(runId: string | undefined): InFlightTurn | undefined {
  if (!runId) return undefined;
  return byRunId.get(runId);
}

/** Test seam. */
export function __resetTurnRegistryForTest(): void {
  turns.clear();
  byRunId.clear();
}
