import { useEffect, useMemo, useSyncExternalStore } from "react";

import { headlineOf, type Headline, type LiveTurn } from "@/lib/turnSteps";

function signal() {
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    notify: () => { for (const listener of listeners) listener(); },
  };
}

const traceSignal = signal();
const openTraces = new Set<string>();

/** Whether the trace under `key` is open. Kept outside React, as the headline is: the virtualized list unmounts a row
 *  on scroll, and a live turn's rows remount at the presence-row to streaming-draft handoff. */
export function useTraceOpen(key: string): boolean {
  return useSyncExternalStore(traceSignal.subscribe, () => openTraces.has(key));
}

export function toggleTrace(key: string): void {
  if (!openTraces.delete(key)) openTraces.add(key);
  traceSignal.notify();
}

/** How long a headline holds before a newer one replaces it; thinking refreshes at most this often. */
const HOLD_MS = 500;
const THINKING_HOLD_MS = 1500;

interface HeadlineEntry {
  shown: Headline;
  since: number;
  /** The last headline offered, so a render offering it again changes nothing. */
  offered: string;
  /** Shows the pending headline once the current one has held. */
  timer?: number;
}

const headlineSignal = signal();
const headlines = new Map<string, HeadlineEntry>();

function show(entry: HeadlineEntry, headline: Headline): void {
  entry.shown = headline;
  entry.since = Date.now();
  headlineSignal.notify();
}

/** A newer headline shows at once unless the current one still holds. Then it waits and the latest pending wins; a
 *  tool that finishes before its wait is over never shows. The same headline updates in place, except thinking, whose
 *  every refresh holds. */
function offer(key: string, next: Headline): void {
  const offered = JSON.stringify(next);
  const entry = headlines.get(key);
  if (!entry) {
    headlines.set(key, { shown: next, since: Date.now(), offered });
    headlineSignal.notify();
    return;
  }
  if (offered === entry.offered) return;
  entry.offered = offered;
  window.clearTimeout(entry.timer);
  const thinking = entry.shown.kind === "thinking" && next.kind === "thinking";
  if (next.key === entry.shown.key && !thinking) {
    entry.shown = next;
    headlineSignal.notify();
    return;
  }
  const wait = entry.since + (thinking ? THINKING_HOLD_MS : HOLD_MS) - Date.now();
  if (wait <= 0) show(entry, next);
  else if (next.kind !== "tool" || next.step.status === "running") entry.timer = window.setTimeout(() => { show(entry, next); }, wait);
}

/** The live turn's headline: its newest signal, held, and forward-only across every row that shows it. The first one
 *  shows in the render that brings it, as its offer would show it at once. */
export function useTurnHeadline(turn: LiveTurn | undefined): Headline | undefined {
  const key = turn?.key;
  const next = useMemo(() => (turn ? headlineOf(turn) : undefined), [turn]);
  useEffect(() => {
    if (key && next) offer(key, next);
  }, [key, next]);
  const held = useSyncExternalStore(headlineSignal.subscribe, () => (key ? headlines.get(key)?.shown : undefined));
  const shown = held ?? next;
  return useMemo(() => {
    if (shown?.kind !== "tool") return shown;
    const step = turn?.steps.find((s) => s.id === shown.key);
    return step?.kind === "tool" && step !== shown.step ? { ...shown, step } : shown;
  }, [shown, turn]);
}

/** A live turn's state outside React (its headline, whether its trace is open) is keyed by channel and agent. */
export function liveTurnKey(channelId: string, key: string): string {
  return `turn:${channelId}:${key}`;
}

/** Leaving a channel ends every live turn it was showing. */
export function endChannelTurns(channelId: string): void {
  const prefix = liveTurnKey(channelId, "");
  for (const key of [...headlines.keys(), ...openTraces]) if (key.startsWith(prefix)) endLiveTurn(key);
}

/** A live turn ended: drop its headline, and hand an open trace to the reply it published. */
export function endLiveTurn(key: string, replyKey?: string): void {
  const entry = headlines.get(key);
  if (entry) {
    window.clearTimeout(entry.timer);
    headlines.delete(key);
    headlineSignal.notify();
  }
  if (openTraces.delete(key)) {
    if (replyKey) openTraces.add(replyKey);
    traceSignal.notify();
  }
}
