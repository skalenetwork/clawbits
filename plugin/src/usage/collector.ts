// In-process AI-usage collector (the "hook" source of the usage-tracking
// plan). Two legs, both on the same loose `api.on(...)` plane the plugin
// already uses for `gateway_start`/`cron_changed` (see index.ts):
//
//  - `reply_payload_sending` (UNGATED leg): live dispatcher deliveries carry a
//    `usageState` snapshot sourced from the unified runResult.meta — one
//    per-turn AGGREGATE across every harness (embedded, CLI, Codex
//    app-server), plus a `turnUsd` cost passthrough. One event per runId.
//  - `llm_output` (GRANTED leg): per model-call usage, real time. This is a
//    conversation-class hook — the gateway silently blocks the registration
//    for non-bundled plugins unless the operator config sets
//    `plugins.entries.clawbits.hooks.allowConversationAccess=true`, so the
//    collector must behave identically whether or not this leg ever fires.
//
// Exclusivity: a run that produced per-call events drops its later
// turn-aggregate event (same tokens, finer grain). The aggregate always
// arrives after the calls — it is recorded at run end and consumed at
// dispatch — so a per-run set is enough; the server's `(agent, event_id)`
// dedup is the second line of defense.
//
// Everything here is advisory telemetry (observability, never billing);
// handlers must never throw into the gateway's hook runner.
//
// See docs/protocol/AGENT_USAGE_TRACKING_PLAN.md §1/§3.

// ---------------------------------------------------------------------------
// Wire shape (matches the server's UsageReportEvent contract)
// ---------------------------------------------------------------------------

export interface UsageEvent {
  event_id: string;
  occurred_at_ms: number;
  model: string;
  provider?: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd?: number;
  currency?: string;
}

// Bounds. The queue survives report failures (at-least-once), so it is capped;
// overflow drops the OLDEST events (forward-only: the freshest picture wins).
// The run sets only guard against double-queueing within a process lifetime,
// so a small bound is plenty.
const MAX_PENDING_EVENTS = 5_000;
const MAX_TRACKED_RUNS = 512;

// ---------------------------------------------------------------------------
// Module state (one collector per gateway process, like the cron handle)
// ---------------------------------------------------------------------------

let queue: UsageEvent[] = [];
let droppedOverflow = 0;
let callSeq = 0;
/** Runs that already produced per-call (`llm_output`) usage events. */
const runsWithCalls = new Set<string>();
/** Runs whose turn-aggregate has already been queued (multi-payload turns). */
const seenTurnRuns = new Set<string>();

function rememberRun(set: Set<string>, runId: string): void {
  set.add(runId);
  if (set.size <= MAX_TRACKED_RUNS) return;
  // Sets iterate in insertion order — evict the oldest entries.
  for (const oldest of set) {
    set.delete(oldest);
    if (set.size <= MAX_TRACKED_RUNS) break;
  }
}

function enqueue(event: UsageEvent): void {
  queue.push(event);
  if (queue.length > MAX_PENDING_EVENTS) {
    queue.splice(0, queue.length - MAX_PENDING_EVENTS);
    droppedOverflow += 1;
  }
}

// ---------------------------------------------------------------------------
// Defensive usage normalization. OpenClaw 2026.6.10 emits camelCase
// {input, output, cacheRead, cacheWrite, total}; aliases cover the snake_case
// JSONL spelling and raw provider spellings so a runtime drift degrades to
// "still counted" instead of "silently zero".
// ---------------------------------------------------------------------------

const INPUT_KEYS = ["input", "input_tokens", "prompt_tokens", "promptTokens"];
const OUTPUT_KEYS = ["output", "output_tokens", "completion_tokens", "completionTokens"];
const CACHE_READ_KEYS = [
  "cacheRead",
  "cache_read_tokens",
  "cache_read_input_tokens",
  "cacheReadInputTokens",
];
const CACHE_WRITE_KEYS = [
  "cacheWrite",
  "cache_write_tokens",
  "cache_creation_input_tokens",
  "cacheCreationInputTokens",
];

function toCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function readAliased(usage: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    if (usage[key] !== undefined) return toCount(usage[key]);
  }
  return 0;
}

interface NormalizedTokens {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

/** Null when the shape is unusable or every component is zero — a zero row
 *  carries no information and would only bloat the ledger. */
export function normalizeUsageTokens(usage: unknown): NormalizedTokens | null {
  if (usage === null || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const tokens: NormalizedTokens = {
    input_tokens: readAliased(u, INPUT_KEYS),
    output_tokens: readAliased(u, OUTPUT_KEYS),
    cache_read_tokens: readAliased(u, CACHE_READ_KEYS),
    cache_write_tokens: readAliased(u, CACHE_WRITE_KEYS),
  };
  const total =
    tokens.input_tokens +
    tokens.output_tokens +
    tokens.cache_read_tokens +
    tokens.cache_write_tokens;
  return total > 0 ? tokens : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Hook handlers (exported for tests; registered below)
// ---------------------------------------------------------------------------

/** `llm_output` — one usage event per model call (granted leg). */
export function recordLlmOutput(event: unknown): void {
  try {
    if (event === null || typeof event !== "object") return;
    const e = event as Record<string, unknown>;
    const runId = asString(e.runId) ?? "unknown-run";
    const model = asString(e.model);
    const tokens = normalizeUsageTokens(e.usage);
    if (!model || !tokens) return;
    callSeq += 1;
    // The hook exposes no callId (`model_call_ended` does, but carries no
    // usage), so the id is run-scoped + a process-local sequence. Runs never
    // span a gateway restart, so a reset sequence cannot collide.
    enqueue({
      event_id: `call:${runId}:${String(callSeq)}`,
      occurred_at_ms: Date.now(),
      model,
      ...(asString(e.provider) ? { provider: asString(e.provider) } : {}),
      ...tokens,
    });
    rememberRun(runsWithCalls, runId);
  } catch {
    /* observer only — never throw into the hook runner */
  }
}

/** `reply_payload_sending` — one turn-aggregate event per run (ungated leg).
 *  Pure observer: always returns undefined so the payload is never rewritten
 *  or cancelled.
 *
 *  When the run was already counted per-call by the granted `llm_output` leg,
 *  the aggregate's TOKENS are dropped (exclusivity — no double count) but its
 *  `turnUsd` still matters: at 2026.6.11 `llm_output` carries no cost, so the
 *  dispatch snapshot is the only cost source. That cost rides a zero-token
 *  event (same `turn:<runId>` id), which the server folds into `cost_usd`
 *  without counting a call. */
export function recordReplyPayloadSending(event: unknown): void {
  try {
    if (event === null || typeof event !== "object") return;
    const e = event as Record<string, unknown>;
    const runId = asString(e.runId);
    if (!runId || seenTurnRuns.has(runId)) return;
    const state = e.usageState;
    if (state === null || typeof state !== "object") return;
    const s = state as Record<string, unknown>;
    const model = asString(s.model);
    if (!model) return;
    const turnUsd = s.turnUsd;
    const cost =
      typeof turnUsd === "number" && Number.isFinite(turnUsd) && turnUsd >= 0
        ? { cost_usd: turnUsd, currency: "USD" }
        : null;
    const provider = asString(s.provider) ? { provider: asString(s.provider) } : {};
    if (runsWithCalls.has(runId)) {
      // Tokens already counted per-call — contribute the cost only.
      if (!cost) return;
      enqueue({
        event_id: `turn:${runId}`,
        occurred_at_ms: Date.now(),
        model,
        ...provider,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        ...cost,
      });
      rememberRun(seenTurnRuns, runId);
      return;
    }
    const tokens = normalizeUsageTokens(s.usage);
    if (!tokens) return;
    enqueue({
      event_id: `turn:${runId}`,
      occurred_at_ms: Date.now(),
      model,
      ...provider,
      ...tokens,
      ...(cost ?? {}),
    });
    rememberRun(seenTurnRuns, runId);
  } catch {
    /* observer only — never throw into the hook runner */
  }
}

/** Register both legs on the gateway hook plane (called from index.ts
 *  `registerFull`, next to the cron hooks). The `llm_output` registration is
 *  a no-op warn on installs without the conversation-access grant. */
export function registerUsageHooks(hookApi: {
  on?: (hook: string, handler: (event: unknown, ctx?: unknown) => void) => void;
}): void {
  hookApi.on?.("reply_payload_sending", (event) => {
    recordReplyPayloadSending(event);
  });
  hookApi.on?.("llm_output", (event) => {
    recordLlmOutput(event);
  });
}

// ---------------------------------------------------------------------------
// Queue surface for the reporter (peek/ack so a failed POST keeps the batch)
// ---------------------------------------------------------------------------

export function peekUsageEvents(max: number): UsageEvent[] {
  return queue.slice(0, Math.max(0, max));
}

export function ackUsageEvents(events: UsageEvent[]): void {
  if (events.length === 0) return;
  const acked = new Set(events.map((e) => e.event_id));
  queue = queue.filter((e) => !acked.has(e.event_id));
}

export function pendingUsageCount(): number {
  return queue.length;
}

/** Overflow drops since start — surfaced in the reporter's log line so silent
 *  truncation is never invisible. */
export function droppedUsageCount(): number {
  return droppedOverflow;
}

// ---------------------------------------------------------------------------
// Reporter ownership. Hooks are per-gateway but reporter loops start per
// account; on a (rare) multi-account gateway only the first claimant drains
// the shared queue, otherwise the same tokens would be split arbitrarily
// across two different Clawbits agents.
// ---------------------------------------------------------------------------

let reporterOwner: string | undefined;

export function claimUsageReporter(accountId: string): boolean {
  if (reporterOwner !== undefined && reporterOwner !== accountId) return false;
  reporterOwner = accountId;
  return true;
}

export function releaseUsageReporter(accountId: string): void {
  if (reporterOwner === accountId) reporterOwner = undefined;
}

/** Test hook: reset every piece of module state. */
export function resetUsageCollectorForTests(): void {
  queue = [];
  droppedOverflow = 0;
  callSeq = 0;
  runsWithCalls.clear();
  seenTurnRuns.clear();
  reporterOwner = undefined;
}
