// Agent-event subscription for live activity (LIVE_AGENT_ACTIVITY_PLAN §1.1).
//
// Registers on the gateway's plugin agent-event plane
// (``api.agent.events.registerAgentEventSubscription``) — in-process,
// unredacted, NOT conversation-gated at OpenClaw 2026.6.10+ — and routes
// events to the turn registry (correlation), stream patcher (text lane) and
// reporter (activity lane). Every handler is a pure observer: nothing here
// may ever throw into the gateway's dispatcher.

import { pluginDebug } from "../file-logger.js";
import { finishReporting, onThinkingEvent, onToolEvent } from "./reporter.js";
import { finishStreaming, onAssistantEvent } from "./stream-patcher.js";
import { claimTurnForRun, turnForRun } from "./turn-registry.js";

/** The slice of the plugin API we need; the vendored SDK stub doesn't type
 *  the agent-events plane, so this narrows an ``unknown`` api object. */
interface AgentEventsCapableApi {
  agent?: {
    events?: {
      registerAgentEventSubscription?: (subscription: {
        id: string;
        description?: string;
        streams?: string[];
        handle: (event: unknown, ctx?: unknown) => void;
      }) => void;
    };
  };
}

interface AgentEventLike {
  runId?: unknown;
  stream?: unknown;
  sessionKey?: unknown;
  data?: unknown;
}

export function routeAgentEvent(event: unknown): void {
  try {
    if (event === null || typeof event !== "object") return;
    const e = event as AgentEventLike;
    const runId = typeof e.runId === "string" ? e.runId : undefined;
    if (!runId) return;
    const stream = typeof e.stream === "string" ? e.stream : "";
    const sessionKey = typeof e.sessionKey === "string" ? e.sessionKey : undefined;

    switch (stream) {
      case "lifecycle": {
        const data = (e.data ?? {}) as Record<string, unknown>;
        const phase = typeof data.phase === "string" ? data.phase : "";
        if (phase === "start") {
          claimTurnForRun(runId, sessionKey);
        } else if (phase === "end" || phase === "error") {
          const turn = turnForRun(runId);
          if (turn) {
            finishStreaming(turn);
            finishReporting(turn);
          }
        }
        return;
      }
      case "assistant": {
        // Deltas normally follow a lifecycle:start bind; the claim fallback
        // covers a missed lifecycle event (still conservative — see registry).
        const turn = turnForRun(runId) ?? claimTurnForRun(runId, sessionKey);
        if (turn) onAssistantEvent(turn, e.data);
        return;
      }
      case "thinking": {
        const turn = turnForRun(runId) ?? claimTurnForRun(runId, sessionKey);
        if (turn) onThinkingEvent(turn, e.data);
        return;
      }
      case "tool": {
        const turn = turnForRun(runId) ?? claimTurnForRun(runId, sessionKey);
        if (turn) onToolEvent(turn, e.data);
        return;
      }
      default:
        return;
    }
  } catch {
    /* observer only — never throw into the gateway */
  }
}

/** Register the subscription. Returns false when the host predates the
 *  agent-events plugin API (feature silently off — shimmer-then-final UX). */
export function registerActivitySubscription(api: unknown): boolean {
  try {
    const register = (api as AgentEventsCapableApi)?.agent?.events
      ?.registerAgentEventSubscription;
    if (typeof register !== "function") {
      pluginDebug(
        "live-activity: host exposes no agent-event subscription API — lane off",
      );
      return false;
    }
    register({
      id: "clawbits-live-activity",
      description:
        "Streams reply text, thinking snippets and tool activity to the Clawbits channel surface.",
      streams: ["lifecycle", "assistant", "thinking", "tool"],
      handle: (event) => {
        routeAgentEvent(event);
      },
    });
    return true;
  } catch (err) {
    pluginDebug(
      `live-activity: subscription registration failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}
