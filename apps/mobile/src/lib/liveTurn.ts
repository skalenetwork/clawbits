/**
 * An agent's turn in flight, folded from the channel's member.status lane: its steps, its thinking bursts in their
 * places between them, and the held, forward-only headline its turn line shows. The state lives outside React and
 * outside the query cache, per channel, until the channel is left, and so does the turn a reply keeps: its thinking,
 * and its steps for a plugin that saves none on the post.
 * Kept in step with frontend/src/lib/turnSteps.ts, thinkingStitch.ts, hooks/useTraceState.ts, useChannelEvents.ts and
 * components/chat/TurnTrace.tsx.
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { AgentActivity, MemberStatus, Post, TurnStep } from "./models";

/** One burst of thinking, stitched from its rolling tails. `at` is how many steps the turn had when it began, which
 *  places it before the step that ended it. Session-only: never sent to or stored by the server. */
export interface Thought {
  at: number;
  text: string;
}

/** A burst of thinking as a reply keeps it: `before` is the id of the step that followed it, none when nothing did. */
export interface KeptThought {
  before: string | undefined;
  text: string;
}

/** A turn in flight: its steps, and its thinking as ordered bursts beside them, never as steps. `key` names the turn
 *  to the state that outlives its rows. */
export interface LiveTurn {
  key: string;
  steps: TurnStep[];
  thoughts: Thought[];
}

/** What a finished turn did, in order: its steps, and the thinking this session watched between them. */
export interface Turn {
  steps: TurnStep[];
  thoughts: KeptThought[];
}

/** What a live turn's headline says: its newest signal. */
export type Headline =
  | { kind: "thinking" | "note"; key: string; text: string }
  | { kind: "tool"; key: string; step: TurnStep };

/** What the live line says after its count. `live` carries the line's one effect; a held, finished tool is static. */
export type Segment = { key: string; live: boolean } & (
  | { kind: "text"; text: string }
  | { kind: "tool"; step: TurnStep; more: number }
);

/** Bounds one burst's reconstruction; the newest text wins past it. */
const THINKING_MAX_CHARS = 8000;

/**
 * Weld a thinking tail onto the burst stitched so far. Consecutive tails of one burst overlap, so the new one extends
 * the text along the largest suffix/prefix overlap; one already contained changes nothing; one past the text (the
 * burst outran the sample rate) follows a `…` gap.
 */
function stitchThinkingTail(acc: string, rawTail: string): string {
  const incoming = rawTail.trim();
  if (!acc) return incoming;
  const tail = incoming.replace(/^…+\s*/u, "");
  if (!tail || acc.includes(tail)) return acc;
  let overlap = 0;
  for (let k = Math.min(acc.length, tail.length); k > 0; k--) {
    if (acc.endsWith(tail.slice(0, k))) {
      overlap = k;
      break;
    }
  }
  const merged = overlap > 0 ? acc + tail.slice(overlap) : `${acc} … ${tail}`;
  return merged.length > THINKING_MAX_CHARS ? `…${merged.slice(-THINKING_MAX_CHARS)}` : merged;
}

/** A sentence ends at `. ! ?`, an optional closing quote or bracket, then whitespace, so `v2.3` stays whole. */
const SENTENCE_END = /(?<=[.!?]["'”’)\]]?)\s+/;

/** The sentence stitched thinking is writing: the text after its last sentence end, or its last complete sentence
 *  when the text stops at one. `index` counts the sentences before it, so it names one sentence as that sentence
 *  grows. */
export function currentSentence(text: string): { index: number; text: string } | undefined {
  const sentences = text.trim().split(SENTENCE_END);
  const last = sentences.at(-1);
  return last ? { index: sentences.length - 1, text: last } : undefined;
}

/** A headline drops a leading stitch gap and its sentence's closing punctuation, even inside a closing quote or
 *  bracket; the open rows keep both. */
const bare = (text: string) => text.replace(/^…\s*/u, "").replace(/[.;:!?…]+(["'”’)\]]?)$/u, "$1");

function upsert(steps: TurnStep[], step: TurnStep): TurnStep[] {
  const i = steps.findIndex((s) => s.id === step.id);
  return i < 0 ? [...steps, step] : steps.with(i, step);
}

/** Fold one step event; a tool runs while its `ok` is null. Events carry the step's id; older plugins send none, so
 *  there a start merges into a still-running call of the same tool and an end closes the last running call. */
function applyStep(steps: TurnStep[], act: AgentActivity, label: string): TurnStep[] {
  if (act.kind === "note") {
    const id = act.id ?? `note:${String(steps.length)}`;
    return label ? upsert(steps, { kind: "note", id, label, tool: null, ok: null, duration_ms: null }) : steps;
  }
  if (act.kind !== "tool" && act.kind !== "tool_done") return steps;
  const running = steps.findLast((s) => s.kind === "tool" && s.ok === null);
  if (act.kind === "tool") {
    const tool = act.tool ?? null;
    const prev = act.id
      ? steps.find((s) => s.id === act.id)
      : running?.tool === tool && steps.at(-1) === running
        ? running
        : undefined;
    const id = prev?.id ?? act.id ?? `tool:${String(steps.length)}`;
    return upsert(
      steps,
      prev?.kind === "tool"
        ? { ...prev, label: label || prev.label }
        : { kind: "tool", id, label, tool, ok: null, duration_ms: null },
    );
  }
  const prev = act.id ? steps.find((s) => s.id === act.id) : running;
  if (prev?.kind !== "tool") return steps;
  const detailed = (text: string) => Boolean(text && text !== prev.tool);
  return upsert(steps, {
    ...prev,
    ok: act.ok !== false,
    duration_ms: act.duration_ms ?? prev.duration_ms,
    label: detailed(prev.label) ? prev.label : detailed(label) ? label : prev.label || label,
  });
}

/** Fold one status-lane event into the turn. A thinking tail welds onto the latest burst while no step has been added
 *  since it began; after a new step it starts the next burst, unless the latest burst already holds it: the status
 *  heartbeat repeats the last tail. */
export function applyActivity(turn: LiveTurn, act: AgentActivity): LiveTurn {
  const label = act.label?.trim() ?? "";
  if (act.kind !== "thinking") {
    const steps = applyStep(turn.steps, act, label);
    return steps === turn.steps ? turn : { ...turn, steps };
  }
  if (!label) return turn;
  const at = turn.steps.length;
  const burst = turn.thoughts.at(-1);
  const text = burst ? stitchThinkingTail(burst.text, label) : label;
  if (text === burst?.text) return turn;
  const thoughts = burst?.at === at ? turn.thoughts.with(-1, { at, text }) : [...turn.thoughts, { at, text: label }];
  return { ...turn, thoughts };
}

/** The turn a published reply keeps: each burst anchored to the id of the step that followed it, since the reply's
 *  saved steps may be counted differently (a mid-turn join, a reconnect, notes never sent). */
export function keepTurn({ steps, thoughts }: LiveTurn): Turn {
  return { steps, thoughts: thoughts.map(({ at, text }) => ({ before: steps[at]?.id, text })) };
}

/** The newest signal: a burst of thinking no step has followed yet, as the sentence it is writing; else the last step,
 *  which a finished tool keeps until something follows. */
export function headlineOf({ steps, thoughts }: LiveTurn): Headline | undefined {
  const burst = thoughts.at(-1);
  if (burst?.at === steps.length) {
    const sentence = currentSentence(burst.text);
    const key = `thinking:${String(burst.at)}:${String(sentence?.index)}`;
    if (sentence) return { kind: "thinking", key, text: bare(sentence.text) };
  }
  const last = steps.at(-1);
  if (last?.kind === "note") return { kind: "note", key: last.id, text: bare(last.label) };
  return last && { kind: "tool", key: last.id, step: last };
}

/** A turn's thinking put back among its steps: each burst just before the step that followed it, or after the last
 *  step when that step is not here. */
export function withThoughts(steps: TurnStep[], thoughts: readonly KeptThought[]): (TurnStep | KeptThought)[] {
  const ids = new Set(steps.map((s) => s.id));
  return [
    ...steps.flatMap((step) => [...thoughts.filter((t) => t.before === step.id), step]),
    ...thoughts.filter((t) => !(t.before && ids.has(t.before))),
  ];
}

/**
 * What the live line says after its count: the warming word before the turn's first signal, then the held headline.
 * Thinking reads "Thinking · <sentence>" and narration reads bare. A running tool is live, with how many other calls
 * run beside it; a finished one holds, static, until the next signal. While the reply text streams it says nothing
 * unless a tool runs.
 */
export function segmentOf(steps: TurnStep[], headline: Headline | undefined, writing: boolean): Segment | undefined {
  if (headline?.kind === "tool") {
    const live = headline.step.ok === null;
    const beside = (s: TurnStep) => s.kind === "tool" && s.ok === null && s.id !== headline.key;
    const more = live ? steps.filter(beside).length : 0;
    return writing && !live ? undefined : { kind: "tool", key: headline.key, step: headline.step, more, live };
  }
  if (writing) return undefined;
  if (!headline) return { kind: "text", key: "word", text: "Warming up", live: true };
  const text = headline.kind === "thinking" ? `Thinking · ${headline.text}` : headline.text;
  return { kind: "text", key: headline.key, text, live: true };
}

/** The line's count: "N steps" once a tool ran; else "Thought" for a turn that only thought or narrated, once the
 *  segment stops saying so (`speaking` is false: the reply streams, or the turn settled); else nothing. */
export function countOf(steps: TurnStep[], thoughts: readonly KeptThought[], speaking: boolean): string | undefined {
  const tools = steps.filter((s) => s.kind === "tool").length;
  if (tools > 0) return `${String(tools)} step${tools === 1 ? "" : "s"}`;
  return !speaking && steps.length + thoughts.length > 0 ? "Thought" : undefined;
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Mirrors PRESENCE_TTL_MS.generating in frontend/src/hooks/useChannelEvents.ts: Redis expiry never broadcasts. */
const GENERATING_TTL_MS = 15_000;
const HOLD_MS = 500;
const THINKING_HOLD_MS = 1500;

type Turns = Readonly<Record<string, LiveTurn>>;

interface HeadlineEntry {
  shown: Headline;
  since: number;
  /** The last headline offered, so offering it again changes nothing. */
  offered: string;
  /** Shows the pending headline once the current one has held. */
  timer?: ReturnType<typeof setTimeout>;
}

const NO_TURNS: Turns = {};
/** Each channel's generating agents by id, with their turns so far: an agent is here exactly while it generates. */
const channels = new Map<string, Turns>();
const expiries = new Map<string, ReturnType<typeof setTimeout>>();
const headlines = new Map<string, HeadlineEntry>();
const opened = new Set<string>();
/** Each channel's replies by post id, with the turns they kept. */
const kept = new Map<string, Map<string, Turn>>();

const liveKey = (channel: string, agent: string) => `turn:${channel}:agent:${agent}`;

/** The channel's generating agents by id, each with its turn so far. */
export function liveTurns(channel: string): Turns {
  return channels.get(channel) ?? NO_TURNS;
}

function write(channel: string, turns: Turns): void {
  channels.set(channel, turns);
  notify();
}

/** A live turn ended: drop its expiry and headline, and hand an open trace to the reply it published. */
function forget(key: string, replyKey?: string): void {
  clearTimeout(expiries.get(key));
  expiries.delete(key);
  clearTimeout(headlines.get(key)?.timer);
  const dropped = headlines.delete(key);
  const handed = opened.delete(key);
  if (handed && replyKey) opened.add(replyKey);
  if (dropped || handed) notify();
}

/** A turn ended: the reply it published keeps the turn while the channel is open. */
function endTurn(channel: string, agent: string, replyKey?: string): void {
  const turns = liveTurns(channel);
  const turn = turns[agent];
  if (turn) {
    if (replyKey && turn.steps.length + turn.thoughts.length > 0)
      kept.set(channel, (kept.get(channel) ?? new Map<string, Turn>()).set(replyKey, keepTurn(turn)));
    write(channel, Object.fromEntries(Object.entries(turns).filter(([id]) => id !== agent)));
  }
  forget(liveKey(channel, agent), replyKey);
}

function expire(channel: string, agent: string): void {
  const key = liveKey(channel, agent);
  clearTimeout(expiries.get(key));
  expiries.set(
    key,
    setTimeout(() => {
      endTurn(channel, agent);
    }, GENERATING_TTL_MS),
  );
}

/** Fold one member.status event. A turn lives only while its agent generates, so its next turn starts clean. */
export function memberStatus(channel: string, { member_kind, member_id, status, activity }: MemberStatus): void {
  if (member_kind !== "agent") return;
  if (status !== "generating") {
    endTurn(channel, member_id);
    return;
  }
  const turns = liveTurns(channel);
  const turn = turns[member_id] ?? { key: liveKey(channel, member_id), steps: [], thoughts: [] };
  const next = activity ? applyActivity(turn, activity) : turn;
  if (next !== turns[member_id]) write(channel, { ...turns, [member_id]: next });
  expire(channel, member_id);
}

/** A presence snapshot opens every stream and lists who generates now. A turn already followed keeps its own steps,
 *  a mid-turn join starts from the agent's current step, and every other turn ends. */
export function presenceSnapshot(channel: string, members: MemberStatus[]): void {
  const turns = liveTurns(channel);
  const next: Record<string, LiveTurn> = {};
  for (const { member_kind, member_id, status, activity } of members) {
    if (member_kind !== "agent" || status !== "generating") continue;
    const seed = { key: liveKey(channel, member_id), steps: [], thoughts: [] };
    next[member_id] = turns[member_id] ?? (activity ? applyActivity(seed, activity) : seed);
    expire(channel, member_id);
  }
  for (const agent of Object.keys(turns)) if (!next[agent]) forget(liveKey(channel, agent));
  write(channel, next);
}

/** The agent's streaming draft published as its reply: the turn ends there, and an open trace and the turn follow
 *  the reply. */
export function replyPublished({ channel_id, agent_id, post_id }: Post): void {
  if (agent_id) endTurn(channel_id, agent_id, String(post_id));
}

/** Leaving a channel ends every live turn it was showing, and drops the turns its replies kept. */
export function endChannelTurns(channel: string): void {
  const prefix = liveKey(channel, "");
  for (const key of new Set([...expiries.keys(), ...headlines.keys(), ...opened]))
    if (key.startsWith(prefix)) forget(key);
  const ended = channels.delete(channel);
  if (kept.delete(channel) || ended) notify();
}

/** The generating agent's turn, or undefined for no agent. */
export function useLiveTurn(channel: string, agent: string | null): LiveTurn | undefined {
  return useSyncExternalStore(subscribe, () => (agent ? liveTurns(channel)[agent] : undefined));
}

/** The channel's generating agents by id, each with its turn so far. */
export function useLiveTurns(channel: string): Turns {
  return useSyncExternalStore(subscribe, () => liveTurns(channel));
}

function show(entry: HeadlineEntry, headline: Headline): void {
  entry.shown = headline;
  entry.since = Date.now();
  notify();
}

/** Offer a turn's newest signal. It shows at once unless the current headline still holds; then it waits and the
 *  latest pending wins, and a tool that finishes before its wait is over never shows. The same headline updates in
 *  place, except thinking, whose every refresh holds. */
export function offerHeadline(key: string, next: Headline): void {
  const offered = JSON.stringify(next);
  const entry = headlines.get(key);
  if (!entry) {
    headlines.set(key, { shown: next, since: Date.now(), offered });
    notify();
    return;
  }
  if (offered === entry.offered) return;
  entry.offered = offered;
  clearTimeout(entry.timer);
  const thinking = entry.shown.kind === "thinking" && next.kind === "thinking";
  if (next.key === entry.shown.key && !thinking) {
    entry.shown = next;
    notify();
    return;
  }
  const wait = entry.since + (thinking ? THINKING_HOLD_MS : HOLD_MS) - Date.now();
  if (wait <= 0) show(entry, next);
  else if (next.kind !== "tool" || next.step.ok === null)
    entry.timer = setTimeout(() => {
      show(entry, next);
    }, wait);
}

/** The headline a live turn shows now. */
export function heldHeadline(key: string): Headline | undefined {
  return headlines.get(key)?.shown;
}

/** The live turn's headline: its newest signal, held, and forward-only across every line that shows it. The first one
 *  shows in the render that brings it, as its offer would show it at once. A shown tool is re-read from the turn, so a
 *  parallel call's finish is not lost to a hold. */
export function useTurnHeadline(turn: LiveTurn | undefined): Headline | undefined {
  const key = turn?.key;
  const next = useMemo(() => (turn ? headlineOf(turn) : undefined), [turn]);
  useEffect(() => {
    if (key && next) offerHeadline(key, next);
  }, [key, next]);
  const held = useSyncExternalStore(subscribe, () => (key ? heldHeadline(key) : undefined));
  const shown = held ?? next;
  return useMemo(() => {
    if (shown?.kind !== "tool") return shown;
    const step = turn?.steps.find((s) => s.id === shown.key);
    return step?.kind === "tool" && step !== shown.step ? { ...shown, step } : shown;
  }, [shown, turn]);
}

/** Whether the trace under `key` is open: a live turn's key, then the id of the reply it published. */
export function traceOpen(key: string | undefined): boolean {
  return key !== undefined && opened.has(key);
}

export function toggleTrace(key: string): void {
  if (!opened.delete(key)) opened.add(key);
  notify();
}

/** Kept outside React: the list unmounts rows on scroll, and a live line remounts at the generating-row to
 *  streaming-draft handoff. */
export function useTraceOpen(key: string | undefined): boolean {
  return useSyncExternalStore(subscribe, () => traceOpen(key));
}

/** The turn a reply kept in this session, by its channel and post id. Held in memory only, until the channel is
 *  left. */
export function keptTurn(channel: string, reply: string): Turn | undefined {
  return kept.get(channel)?.get(reply);
}

export function useKeptTurn(post: Post | undefined): Turn | undefined {
  return useSyncExternalStore(subscribe, () => (post ? keptTurn(post.channel_id, String(post.post_id)) : undefined));
}
