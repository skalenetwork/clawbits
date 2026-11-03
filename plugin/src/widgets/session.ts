// A game's own session (WIDGETS_AGENTS_PLAN §2, option B): every move an agent makes in a chat
// game runs in a session of its own, so its private cards or fleet never enter the chat's session
// (shared with the operator and, for DMs, with every other DM), and a later ordinary chat turn can't
// stream them to the opponent as thinking.
//
// The wake is routed as the channel peer `widget-<widget_id>`. OpenClaw keys a channel peer
// `agent:<agentId>:clawbits:channel:<peerId>` (src/routing/session-key.ts buildAgentPeerSessionKey),
// apart from both the DM/main session and the chat's own room session — unless
// `session.groupScope` is "main" (global, or a matched binding's), which folds every channel peer
// into the main session; the wake checks the resolved key and refuses rather than play there, and
// the `widgets` capability probes the same route (widgets/capability.ts).
//
// Hooks keyed on that session key keep a move silent for that run only: the agent's other runs
// (its automations in the same chat, ordinary chat turns) are untouched. The same hook keeps every
// other session out of a game's: the hand sits in its transcript, which OpenClaw's session tools
// would otherwise read into the DM's main session for any asker.
//
// A game's session never grows into OpenClaw's memory flush, and never outlives its game (Rotation
// and Deletion below): the flush and a kept transcript are the two ways the hand could reach what
// the agent's other sessions read back.

import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { type BasicLogger, logInfo, logWarn, pluginDebug } from "../file-logger.js";
import { currentConfig, type ModelChoice, planSessionPatch } from "../model-choice.js";

const GAME_PEER_PREFIX = "widget-";
const GAME_SESSION_MARKER = `:clawbits:channel:${GAME_PEER_PREFIX}`;
/** A rotated session's generation (`widget-<id>-g<n>`); the first, generation 0, has none. */
const GAME_GENERATION = /-g([1-9]\d*)$/u;

/** Carried by every move's brief (wake.ts), so a game's transcript can be told by its content: by
 *  the memory-run guard below, and by OpenClaw's lifecycle cleanup, which also drops a game's
 *  orphaned transcript windows by it. ASCII, so it reads the same inside the stored JSON. */
export const GAME_TRANSCRIPT_MARKER = "clawbits-game-session-7c1e";

/** The only tools a move may call: its game's own. A move calls the act tool (a read at most), and
 *  any other tool could carry the seat's hand out of the session: chat, other sessions, mail, the
 *  agent's public profile, workspace files and memory notes ordinary sessions read back, scheduled
 *  jobs, the web. */
const GAME_TOOLS: ReadonlySet<string> = new Set([
  "clawbits_widget_act",
  "clawbits_widget_get",
  "clawbits_widget_list",
]);

/** OpenClaw's tool search (2026.7+): looking a tool up is harmless; `tool_call` must name a game tool,
 *  bare or by its catalog id `openclaw:<plugin>:<name>`. */
const TOOL_LOOKUPS: ReadonlySet<string> = new Set(["tool_search", "tool_describe"]);
const TOOL_CALL = "tool_call";
const CATALOG_TOOL_ID = /^(?:openclaw:[^:]+:)?([^:]+)$/u;

const SILENT_REASON =
  "This is a Clawbits chat game turn: it uses only the game's tools and posts nothing. Take your move with clawbits_widget_act, then finish with NO_REPLY.";

/** OpenClaw's tools that read another session's transcript or send into it. */
const SESSION_TOOLS: ReadonlySet<string> = new Set([
  "sessions_history",
  "sessions_send",
  "sessions_search",
  "sessions_list",
]);

/** The label a game's own session carries (gateway-adapter's `conversationLabel`). */
const GAME_SESSION_LABEL = "clawbits game ";

const PRIVATE_REASON =
  "A Clawbits chat game's own session is private to its moves: no other session reads it or sends to it. clawbits_widget_get shows the game's public view.";

/** The route peer a game's own session is keyed by: `widget-<id>`, or `widget-<id>-g<n>` for its
 *  generation n (see Rotation). */
export function gamePeerId(widgetId: string, gen = 0): string {
  return `${GAME_PEER_PREFIX}${widgetId}${gen > 0 ? `-g${String(gen)}` : ""}`;
}

/** Whether a send target is a game's peer rather than a chat (a model send defaulting to the turn's
 *  own conversation). */
export function isGamePeerId(target: string): boolean {
  return target.toLowerCase().startsWith(GAME_PEER_PREFIX);
}

/** The widget and generation whose own session `sessionKey` is, or undefined for any other. */
export function gameSessionOf(
  sessionKey: string | undefined | null,
): { widgetId: string; gen: number } | undefined {
  if (typeof sessionKey !== "string") return undefined;
  const at = sessionKey.toLowerCase().lastIndexOf(GAME_SESSION_MARKER);
  if (at < 0) return undefined;
  const peer = sessionKey.slice(at + GAME_SESSION_MARKER.length);
  if (!peer || peer.includes(":")) return undefined;
  const gen = GAME_GENERATION.exec(peer);
  const widgetId = gen ? peer.slice(0, gen.index) : peer;
  return widgetId ? { widgetId, gen: gen ? Number(gen[1]) : 0 } : undefined;
}

/** The widget whose own session `sessionKey` is (any generation), or undefined for any other. */
export function gameSessionWidgetId(sessionKey: string | undefined | null): string | undefined {
  return gameSessionOf(sessionKey)?.widgetId;
}

/** Whether `sessionKey` is the game's own session as OpenClaw resolved it: only then may a move run.
 *  With `gen`, only that generation's. */
export function isOwnGameSession(sessionKey: string | undefined, widgetId: string, gen?: number): boolean {
  const own = gameSessionOf(sessionKey);
  return (
    own !== undefined &&
    own.widgetId.toLowerCase() === widgetId.toLowerCase() &&
    (gen === undefined || own.gen === gen)
  );
}

/** The agent a session key belongs to (`agent:<id>:…`). */
export function sessionAgentId(sessionKey: string): string | undefined {
  return /^agent:([^:]+):/iu.exec(sessionKey)?.[1];
}

type ToolBlock = { block: true; blockReason: string };

/** Whether a move may call `toolName` (see GAME_TOOLS). */
function gameTurnToolAllowed(toolName: string | undefined, params?: Record<string, unknown>): boolean {
  const name = (toolName ?? "").trim().toLowerCase();
  if (GAME_TOOLS.has(name) || TOOL_LOOKUPS.has(name)) return true;
  if (name !== TOOL_CALL) return false;
  const id = typeof params?.id === "string" ? params.id.trim().toLowerCase() : "";
  const inner = CATALOG_TOOL_ID.exec(id)?.[1];
  return inner !== undefined && GAME_TOOLS.has(inner);
}

/** `before_tool_call`: inside a game's own session, refuse every tool but the game's. */
export function gameTurnToolBlock(
  toolName: string | undefined,
  sessionKey: string | undefined,
  params?: Record<string, unknown>,
): ToolBlock | undefined {
  if (!gameSessionWidgetId(sessionKey)) return undefined;
  return gameTurnToolAllowed(toolName, params) ? undefined : { block: true, blockReason: SILENT_REASON };
}

/** A game session the agent holds: its key and its transcript's id. */
export interface GameSessionRef {
  sessionKey: string;
  sessionId?: string;
}

/** The agent's game sessions, or undefined when the host can't list its sessions. */
export type GameSessionLister = (agentId: string | undefined) => Promise<GameSessionRef[] | undefined>;

/** Whether a session reference names a game's own session, by key or by label. */
function namesGameSession(value: string): boolean {
  const ref = value.toLowerCase();
  return ref.includes(GAME_SESSION_MARKER.slice(1)) || ref.startsWith(GAME_SESSION_LABEL);
}

/**
 * `before_tool_call`, outside a game's own session: keep OpenClaw's session tools out of the games'.
 * A session named by key or label is refused at once; one named by transcript id when it is a game's.
 * A read across every session (an unscoped `sessions_search`, a `sessions_list` with messages) is
 * refused while the agent holds a game session, or when that can't be told. Only the session tools
 * wait on the lister; every other call is answered synchronously.
 */
export function gameSessionPeekBlock(
  toolName: string | undefined,
  params: Record<string, unknown> | undefined,
  ctx: { sessionKey?: string; agentId?: string },
  list: GameSessionLister = listGameSessions,
): ToolBlock | undefined | Promise<ToolBlock | undefined> {
  const name = (toolName ?? "").trim().toLowerCase();
  if (!SESSION_TOOLS.has(name) || gameSessionWidgetId(ctx.sessionKey)) return undefined;
  const refused: ToolBlock = { block: true, blockReason: PRIVATE_REASON };
  const refs = ["sessionKey", "key", "sessionId", "label"]
    .map((field) => params?.[field])
    .filter((ref): ref is string => typeof ref === "string" && ref.trim() !== "")
    .map((ref) => ref.trim());
  if (refs.some(namesGameSession)) return refused;
  const ids = refs.filter((ref) => !ref.includes(":"));
  const acrossSessions =
    (name === "sessions_search" && refs.length === 0) ||
    (name === "sessions_list" &&
      typeof params?.label !== "string" &&
      (Number(params?.messageLimit ?? 0) > 0 || params?.includeLastMessage === true));
  if (!ids.length && !acrossSessions) return undefined;
  const agentIds = [...new Set([ctx.agentId, typeof params?.agentId === "string" ? params.agentId : undefined])];
  return (async () => {
    const games: GameSessionRef[] = [];
    for (const agentId of agentIds) {
      const listed = await list(agentId);
      if (listed === undefined) return acrossSessions ? refused : undefined;
      games.push(...listed);
    }
    if (acrossSessions && games.length) return refused;
    return games.some((game) => game.sessionId !== undefined && ids.includes(game.sessionId))
      ? refused
      : undefined;
  })();
}

/** `message_sending`: cancel any outbound message a game's own session produces. */
export function gameTurnSendCancel(
  sessionKey: string | undefined,
): { cancel: true; cancelReason: string } | undefined {
  return gameSessionWidgetId(sessionKey) ? { cancel: true, cancelReason: SILENT_REASON } : undefined;
}

const MEMORY_RUN_REASON = "clawbits chat game transcript";

/**
 * `before_agent_run`: refuse a memory-flush run (`trigger: "memory"`) over a game's transcript.
 * Up to OpenClaw 2026.9.2 the flush runs in the game's own session, whose tool guard already
 * refuses its writes; from 2026.9.3 it runs apart, keyed `agent:<id>:internal-session-effects:…`,
 * with a bounded copy of the game's transcript as its messages, which the brief's marker names.
 * Rotation keeps a game's session under the flush; this is the net behind it. A refused flush
 * counts as a failed one, which OpenClaw stops retrying for that compaction cycle. A conversation
 * hook: OpenClaw runs it only with `plugins.entries.clawbits.hooks.allowConversationAccess`, which
 * the image sets.
 */
export function gameMemoryRunBlock(
  event: { messages?: unknown },
  ctx: { trigger?: string; sessionKey?: string },
): { outcome: "block"; reason: string } | undefined {
  if (ctx.trigger !== "memory") return undefined;
  const refused = { outcome: "block" as const, reason: MEMORY_RUN_REASON };
  if (gameSessionWidgetId(ctx.sessionKey)) return refused;
  try {
    return JSON.stringify(event.messages ?? []).includes(GAME_TRANSCRIPT_MARKER) ? refused : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the host's memory flush runs apart from the session it flushes (2026.9.3+), or the
 *  host's version can't be told. */
export function hostFlushesApart(version: unknown): boolean {
  const parts = typeof version === "string" ? /^v?(\d+)\.(\d+)\.(\d+)/u.exec(version.trim()) : null;
  if (!parts) return true;
  const [year = 0, month = 0, patch = 0] = parts.slice(1).map(Number);
  return year * 1e6 + month * 1e3 + patch >= 2026 * 1e6 + 9 * 1e3 + 3;
}

/** Register the guards. The tool and send hooks exist at the plugin's floor (2026.6.10) and carry
 *  the run's session key; a host that refuses one still has the outbound adapter's own refusal of
 *  game targets behind it. The tool hook takes every tool (no matcher): a game session allows only
 *  its own, whatever else the host or other plugins add. `before_agent_run` only where the flush
 *  runs apart: with any handler registered, OpenClaw clones every run's messages for it, on every
 *  session of the gateway; before 2026.9.3 the tool guard already holds the flush, which runs in the
 *  game's own session. */
export function registerGameTurnGuards(api: OpenClawPluginApi): void {
  const cfg = (api as { config?: unknown }).config;
  api.on?.(
    "before_tool_call",
    (event, ctx) =>
      gameTurnToolBlock(event.toolName, ctx.sessionKey, event.params) ??
      gameSessionPeekBlock(event.toolName, event.params, ctx, (agentId) => listGameSessions(agentId, cfg)),
  );
  api.on?.("message_sending", (_event, ctx) => gameTurnSendCancel(ctx.sessionKey));
  if (hostFlushesApart((api as { runtime?: { version?: unknown } }).runtime?.version)) {
    api.on?.("before_agent_run", (event, ctx) => gameMemoryRunBlock(event, ctx));
  }
}

// --- The session store -------------------------------------------------------------------------

/** What a game session's entry says about its transcript and how far its context has grown. */
interface GameSessionEntry {
  sessionId?: string;
  sessionFile?: string;
  /** The transcripts this session had before (a reset's predecessors). */
  usageFamilySessionIds?: string[];
  /** The last call's prompt size; fresh only when `totalTokensFresh` is true and, from 2026.8.1,
   *  `totalTokensVersion` is 1. */
  totalTokens?: number;
  totalTokensFresh?: boolean;
  totalTokensVersion?: number;
  /** The context window of the last run ... */
  contextTokens?: number;
  /** ... and its model. */
  modelProvider?: string;
  model?: string;
  compactionCount?: number;
  /** A memory flush ran in this compaction cycle: 2026.8.1+ ... */
  memoryFlush?: unknown;
  /** ... and before. */
  memoryFlushCompactionCount?: number;
  /** What OpenClaw's reset policy reads. */
  updatedAt?: number;
  sessionStartedAt?: number;
  lastInteractionAt?: number;
}

type SessionStoreRuntime = typeof import("openclaw/plugin-sdk/session-store-runtime");

interface SessionEntrySummary {
  sessionKey: string;
  entry: GameSessionEntry;
}

interface TranscriptStatsParams {
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
}

interface LifecycleCleanupParams {
  agentId?: string;
  sessionStore?: string;
  sessionKeySegmentPrefix: string;
  transcriptContentMarker: string;
  orphanTranscriptMinAgeMs: number;
  archiveRemovedEntryTranscripts?: boolean;
  pluginOwnerId?: string;
}

/** The parts of OpenClaw's `plugin-sdk/session-store-runtime` used here, each feature-detected.
 *  Two stores lie behind it: sessions.json beside transcript files (2026.6.10 to 2026.7), then
 *  SQLite (2026.8.1+, told by `deleteSessionEntry`, which first ships with it). Past 2026.10.2 the
 *  synchronous readers are deprecated for `*Async` ones, preferred where present. Readers take the
 *  store's path where `session.store` moves it: without one they read the default store. */
interface SessionStoreSdk {
  listSessionEntries?: (params?: {
    agentId?: string;
    storePath?: string;
    readOnly?: boolean;
  }) => SessionEntrySummary[];
  listSessionEntriesAsync?: (params: { agentId: string; storePath?: string }) => Promise<SessionEntrySummary[]>;
  readTranscriptStatsSync?: (params: TranscriptStatsParams) => { sizeBytes: number };
  readTranscriptStatsAsync?: (params: TranscriptStatsParams) => Promise<{ sizeBytes: number }>;
  resolveStorePath?: (store?: string, options?: { agentId?: string }) => string;
  updateSessionStore?: (
    storePath: string,
    mutator: (store: Record<string, GameSessionEntry>) => void,
  ) => Promise<unknown>;
  /** Never called (it keeps the transcript, or archives it): only tells the SQLite store. */
  deleteSessionEntry?: (params: { sessionKey: string }) => Promise<boolean>;
  cleanupSessionLifecycleArtifacts?: (params: LifecycleCleanupParams) => Promise<{ removedEntries: number }>;
  /** OpenClaw's own reset policy (2026.6.10+). */
  resolveSessionResetType?: SessionStoreRuntime["resolveSessionResetType"];
  resolveChannelResetConfig?: SessionStoreRuntime["resolveChannelResetConfig"];
  resolveSessionResetPolicy?: SessionStoreRuntime["resolveSessionResetPolicy"];
  evaluateSessionFreshness?: SessionStoreRuntime["evaluateSessionFreshness"];
  /** The model a session's next run takes: its override, else its agent's default (2026.8.1+,
   *  from `plugin-sdk/model-session-runtime`). */
  resolveSessionModelRef?: (
    cfg: OpenClawConfig,
    entry?: GameSessionEntry,
    agentId?: string,
  ) => { provider: string; model: string };
}

let sessionStore: Promise<SessionStoreSdk> | undefined;

/** Test seam: the session store SDK, or undefined to load the host's again. */
export function __setSessionStoreForTest(next: SessionStoreSdk | undefined): void {
  sessionStore = next ? Promise.resolve(next) : undefined;
}

function sessionStoreSdk(): Promise<SessionStoreSdk> {
  sessionStore ??= Promise.all([
    import("openclaw/plugin-sdk/session-store-runtime").then(
      (sdk): SessionStoreSdk => sdk,
      (): SessionStoreSdk => ({}),
    ),
    import("openclaw/plugin-sdk/model-session-runtime").then(
      (sdk): SessionStoreSdk =>
        typeof sdk.resolveSessionModelRef === "function"
          ? { resolveSessionModelRef: sdk.resolveSessionModelRef as SessionStoreSdk["resolveSessionModelRef"] }
          : {},
      (): SessionStoreSdk => ({}),
    ),
  ]).then(([store, models]) => ({ ...store, ...models }));
  return sessionStore;
}

function storeKind(sdk: SessionStoreSdk): "sqlite" | "file" | undefined {
  if (
    typeof sdk.cleanupSessionLifecycleArtifacts === "function" &&
    typeof sdk.deleteSessionEntry === "function"
  ) {
    return "sqlite";
  }
  if (typeof sdk.updateSessionStore === "function" && typeof sdk.resolveStorePath === "function") {
    return "file";
  }
  return undefined;
}

/** `session.store` from OpenClaw's config: where the agent's store lives, when not the default. */
function sessionStoreConfig(cfg: unknown): string | undefined {
  const store = (cfg as { session?: { store?: unknown } } | undefined)?.session?.store;
  return typeof store === "string" && store.trim() ? store : undefined;
}

/** The agent's store path for a reader, where `session.store` moves it from the default. */
function storePathOption(
  sdk: SessionStoreSdk,
  agentId: string | undefined,
  cfg: unknown,
): { storePath: string } | Record<string, never> {
  const store = sessionStoreConfig(cfg);
  if (!store || typeof sdk.resolveStorePath !== "function") return {};
  return { storePath: sdk.resolveStorePath(store, agentId ? { agentId } : undefined) };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A game session in the store: its game, generation and entry. */
interface StoredGameSession extends GameSessionRef {
  widgetId: string;
  gen: number;
  entry: GameSessionEntry;
}

/** The agent's game sessions in OpenClaw's session store, or undefined when it can't list them. */
async function listGameSessions(
  agentId: string | undefined,
  cfg?: unknown,
): Promise<StoredGameSession[] | undefined> {
  const sdk = await sessionStoreSdk();
  try {
    const store = storePathOption(sdk, agentId, cfg);
    const rows =
      agentId && typeof sdk.listSessionEntriesAsync === "function"
        ? await sdk.listSessionEntriesAsync({ agentId, ...store })
        : typeof sdk.listSessionEntries === "function"
          ? sdk.listSessionEntries({ ...(agentId ? { agentId } : {}), ...store, readOnly: true })
          : undefined;
    return rows?.flatMap(({ sessionKey, entry }) => {
      const game = gameSessionOf(sessionKey);
      return game ? [{ sessionKey, sessionId: entry.sessionId, ...game, entry }] : [];
    });
  } catch (err) {
    pluginDebug(`game sessions not listed: ${errorText(err)}`);
    return undefined;
  }
}

/** The agent's game sessions by game, each with its generations; undefined when the store can't
 *  list them. */
export async function listGameSessionGenerations(
  agentId: string | undefined,
  cfg?: unknown,
): Promise<Map<string, number[]> | undefined> {
  const listed = await listGameSessions(agentId, cfg);
  if (!listed) return undefined;
  const games = new Map<string, number[]>();
  for (const session of listed) {
    games.set(session.widgetId, [...(games.get(session.widgetId) ?? []), session.gen]);
  }
  return games;
}

// --- Runs on a game's session ------------------------------------------------------------------
// A session is never deleted while a run on it still goes. Moves and deletions take turns on the
// inbound queue, but a run can outlast its dispatch (OpenClaw queues a message for a busy session
// and returns), so OpenClaw's own runs count too, as the agent-event plane reports them
// (activity/subscription.ts). The SQLite store (2026.8.1+) also refuses such a delete itself.

/** A run whose end never came stops counting after this long. */
const GAME_RUN_STALE_MS = 15 * 60_000;

const gameRuns = new Map<string, { sessionKey: string; since: number }>();
let gameHolds = 0;

/** A `lifecycle` agent event: a run on a game's session starts, ends or fails. */
export function trackGameRun(runId: string, sessionKey: string | undefined, phase: string): void {
  if (phase === "start") {
    if (sessionKey && gameSessionOf(sessionKey)) {
      gameRuns.set(runId, { sessionKey: sessionKey.toLowerCase(), since: Date.now() });
    }
  } else if (phase === "end" || phase === "error") {
    gameRuns.delete(runId);
  }
}

/** A move's dispatch holds its session until it settles: call the returned release then. */
export function holdGameSession(sessionKey: string): () => void {
  gameHolds += 1;
  const id = `hold:${String(gameHolds)}`;
  gameRuns.set(id, { sessionKey: sessionKey.toLowerCase(), since: Number.POSITIVE_INFINITY });
  return () => {
    gameRuns.delete(id);
  };
}

/** Whether a run on this session still goes. */
export function gameSessionBusy(sessionKey: string): boolean {
  const key = sessionKey.toLowerCase();
  const now = Date.now();
  for (const [id, run] of gameRuns) {
    if (now - run.since > GAME_RUN_STALE_MS) gameRuns.delete(id);
    else if (run.sessionKey === key) return true;
  }
  return false;
}

// --- Rotation ----------------------------------------------------------------------------------
// Near its context limit OpenClaw flushes a session into the agent's memory notes, which its other
// sessions read back. From 2026.9.3 the flush runs apart from the session's own key, where the tool
// guard above can't see it. So a game's session never gets that far: once the next move could
// reach the flush, the move runs in a fresh session of the same game, generation n+1
// (`widget-<id>-g<n+1>`), after generation n is deleted (Deletion). Nothing is lost: every brief
// is self-contained. Never a reset instead: a reset hands the last messages to OpenClaw's
// session-memory hook, which writes them into the same notes.
//
// The flush fires once the prompt reaches ctx - reserve - soft (agents.defaults.compaction:
// reserveTokensFloor 20000 and memoryFlush.softThresholdTokens 4000 by default; from 2026.9.3 the
// reserve is at most a quarter of the window, ignoring the config, and the soft margin at most half
// the rest), or once the transcript reaches memoryFlush.forceFlushTranscriptBytes (2 MiB). A game
// session rotates well before either, by its entry's last prompt and window where it has them, else
// by a count of moves. The window is the last run's, and OpenClaw sizes the flush by the coming
// run's model, so a session whose next move runs on another model (the chat's choice or the agent's
// default changed) rotates too: a smaller window may already be past the flush. It rotates, too,
// when OpenClaw's reset policy (a configured daily or idle reset; daily at 04:00 by default up to
// 2026.7) would reset it on the next move: that reset would archive its transcript, and from
// 2026.8.1 hand its last messages to the session-memory hook.

const DEFAULT_RESERVE_TOKENS = 20_000;
const DEFAULT_SOFT_TOKENS = 4_000;
const DEFAULT_FORCE_FLUSH_BYTES = 2 * 1024 * 1024;
/** A session rotates at this transcript size, or at half the configured force-flush size. */
const ROTATE_TRANSCRIPT_BYTES = 1024 * 1024;
/** Moves one generation takes when its size can't be measured: far below the flush for any usual
 *  window, as a move adds a few thousand tokens. */
export const UNMEASURED_MOVES_PER_SESSION = 10;

/** How far a game session has grown, from its entry and transcript. */
export interface GameSessionUsage {
  totalTokens?: number;
  totalTokensFresh?: boolean;
  totalTokensVersion?: number;
  /** The host versions its token counts (2026.8.1+, the SQLite store): only a version-1 one is
   *  fresh. */
  tokensVersioned?: boolean;
  contextTokens?: number;
  /** Its next move runs on another model than its last run. */
  modelChanged?: boolean;
  compactionCount?: number;
  /** A memory flush already ran (or was refused) on it. */
  flushed?: boolean;
  transcriptBytes?: number;
  /** OpenClaw would reset it on its next message. */
  resetDue?: boolean;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

const BYTE_UNITS: Readonly<Record<string, number>> = {
  b: 1,
  k: 1024,
  kb: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
};

/** A config byte size (`2097152`, `"2mb"`), as OpenClaw reads one. */
function byteSize(value: unknown): number | undefined {
  if (typeof value !== "string") return positiveNumber(value);
  const size = /^(\d+(?:\.\d+)?)([a-z]+)?$/u.exec(value.trim().toLowerCase());
  const unit = BYTE_UNITS[size?.[2] ?? "b"];
  return size && unit ? positiveNumber(Number(size[1]) * unit) : undefined;
}

function flushSettings(cfg: unknown): { reserveTokens: number; softTokens: number; forceFlushBytes: number } {
  const compaction = (
    cfg as
      | {
          agents?: {
            defaults?: {
              compaction?: {
                reserveTokensFloor?: unknown;
                memoryFlush?: { softThresholdTokens?: unknown; forceFlushTranscriptBytes?: unknown };
              };
            };
          };
        }
      | undefined
  )?.agents?.defaults?.compaction;
  const soft = compaction?.memoryFlush?.softThresholdTokens;
  return {
    reserveTokens: positiveNumber(compaction?.reserveTokensFloor) ?? DEFAULT_RESERVE_TOKENS,
    softTokens: typeof soft === "number" && Number.isFinite(soft) && soft >= 0 ? Math.floor(soft) : DEFAULT_SOFT_TOKENS,
    forceFlushBytes: byteSize(compaction?.memoryFlush?.forceFlushTranscriptBytes) ?? DEFAULT_FORCE_FLUSH_BYTES,
  };
}

/** The prompt size a game session rotates at, for a window of `ctx` tokens: the lower of both
 *  flush thresholds, less a margin for the coming move, and never past 60% of the window. */
export function rotationTokenLimit(ctx: number, cfg?: unknown): number {
  const { reserveTokens, softTokens } = flushSettings(cfg);
  const reserve = Math.min(DEFAULT_RESERVE_TOKENS, Math.floor(ctx / 4));
  const flushAt = Math.max(0, ctx - reserve) - Math.min(softTokens, Math.floor((ctx - reserve) / 2));
  const flushAtBefore = ctx - reserveTokens - softTokens;
  const margin = Math.max(8_000, Math.floor(ctx / 10));
  return Math.min(Math.floor(ctx * 0.6), Math.min(flushAt, flushAtBefore) - margin);
}

/** Why a game session should rotate before a move whose brief is `briefChars` long, or undefined
 *  to keep it. `moves`: the moves it took in this process, undefined when it predates it. */
export function gameRotationReason(
  usage: GameSessionUsage | undefined,
  opts: { moves?: number; briefChars: number; cfg?: unknown },
): string | undefined {
  if (usage?.resetDue) return "a session reset is due";
  if (usage?.flushed) return "a memory flush ran";
  if ((usage?.compactionCount ?? 0) > 0) return "compacted";
  if (usage?.modelChanged) return "the model changed";
  const bytes = usage?.transcriptBytes;
  const byteLimit = Math.min(ROTATE_TRANSCRIPT_BYTES, Math.floor(flushSettings(opts.cfg).forceFlushBytes / 2));
  if (bytes !== undefined && bytes >= byteLimit) return "transcript size";
  const ctx = positiveNumber(usage?.contextTokens);
  // Fresh as OpenClaw reads it, or stricter (it took an unset flag for fresh before 2026.8.1).
  const fresh =
    usage?.totalTokensFresh === true &&
    (usage.totalTokensVersion === 1 || (usage.totalTokensVersion === undefined && !usage.tokensVersioned));
  const tokens = fresh ? positiveNumber(usage?.totalTokens) : undefined;
  if (ctx === undefined || tokens === undefined) {
    return opts.moves === undefined || opts.moves >= UNMEASURED_MOVES_PER_SESSION
      ? "size unmeasured"
      : undefined;
  }
  // A brief's tokens, generously: three characters each.
  return tokens + Math.ceil(opts.briefChars / 3) >= rotationTokenLimit(ctx, opts.cfg)
    ? "near the memory flush"
    : undefined;
}

/** Per game, by its generation-0 session key: the generation its moves run in, and the moves that
 *  took in this process (undefined: it began before). */
const generations = new Map<string, { gen: number; moves?: number }>();

function baseSessionKey(sessionKey: string): string {
  return sessionKey.toLowerCase().replace(GAME_GENERATION, "");
}

/** A move was dispatched into this game session. */
export function noteGameMove(sessionKey: string): void {
  const game = gameSessionOf(sessionKey);
  const state = game && generations.get(baseSessionKey(sessionKey));
  if (state && state.gen === game.gen && state.moves !== undefined) state.moves += 1;
}

function sessionsDir(sdk: SessionStoreSdk, agentId: string | undefined, cfg: unknown): string | undefined {
  if (typeof sdk.resolveStorePath !== "function") return undefined;
  return path.resolve(path.dirname(sdk.resolveStorePath(sessionStoreConfig(cfg), agentId ? { agentId } : undefined)));
}

/** The size of a game session's transcript: the SQLite store's count, or its file's. */
async function transcriptBytes(
  session: StoredGameSession,
  agentId: string | undefined,
  cfg: unknown,
): Promise<number | undefined> {
  const { sessionId, sessionFile } = session.entry;
  if (!sessionId) return undefined;
  const sdk = await sessionStoreSdk();
  try {
    if (storeKind(sdk) === "sqlite") {
      const read = sdk.readTranscriptStatsAsync ?? sdk.readTranscriptStatsSync;
      const stats =
        read &&
        (await read({
          ...(agentId ? { agentId } : {}),
          ...storePathOption(sdk, agentId, cfg),
          sessionId,
          sessionKey: session.sessionKey,
        }));
      return stats ? stats.sizeBytes : undefined;
    }
    const dir = sessionsDir(sdk, agentId, cfg);
    if (!dir) return undefined;
    return (await fs.stat(path.resolve(dir, sessionFile?.trim() || `${sessionId}.jsonl`))).size;
  } catch {
    return undefined;
  }
}

/** Whether OpenClaw's reset policy finds the session stale, as its own inbound would on the next
 *  move: a channel peer resets as a group, by `session.resetByChannel.clawbits` when set. */
async function resetDue(session: StoredGameSession, cfg: unknown): Promise<boolean> {
  const sdk = await sessionStoreSdk();
  const { updatedAt, sessionStartedAt, lastInteractionAt } = session.entry;
  const { resolveSessionResetType, resolveChannelResetConfig, resolveSessionResetPolicy, evaluateSessionFreshness } =
    sdk;
  if (
    typeof updatedAt !== "number" ||
    !resolveSessionResetType ||
    !resolveChannelResetConfig ||
    !resolveSessionResetPolicy ||
    !evaluateSessionFreshness
  ) {
    return false;
  }
  try {
    const sessionCfg = (cfg as OpenClawConfig | undefined)?.session;
    const policy = resolveSessionResetPolicy({
      sessionCfg,
      resetType: resolveSessionResetType({ sessionKey: session.sessionKey, isGroup: true }),
      resetOverride: resolveChannelResetConfig({ sessionCfg, channel: PLUGIN_ID }),
    });
    return !evaluateSessionFreshness({
      updatedAt,
      ...(sessionStartedAt !== undefined ? { sessionStartedAt } : {}),
      ...(lastInteractionAt !== undefined ? { lastInteractionAt } : {}),
      now: Date.now(),
      policy,
    }).fresh;
  } catch {
    return false;
  }
}

function sameModel(last: { provider?: string; model: string }, next: { provider: string; model: string }): boolean {
  const ref = (provider: string | undefined, model: string) => {
    const id = model.trim().toLowerCase();
    const at = provider?.trim().toLowerCase();
    return at && !id.startsWith(`${at}/`) ? `${at}/${id}` : id;
  };
  const nextRef = ref(next.provider, next.model);
  // A model recorded without its provider matches by id.
  return last.provider?.trim()
    ? ref(last.provider, last.model) === nextRef
    : [nextRef, next.model.trim().toLowerCase()].includes(last.model.trim().toLowerCase());
}

/**
 * Whether a game session's next move runs on another model than its last run did: undefined when
 * it can't be told (no run yet, or a host before 2026.8.1 that can't resolve a session's model).
 * `choice`: the chat's model choice the move applies to its session first (gateway-adapter's
 * `convergeSession`), or undefined when none is. A run on a fallback model reads as a change too.
 */
async function modelChanged(
  session: StoredGameSession,
  agentId: string | undefined,
  cfg: unknown,
  choice: ModelChoice | undefined,
): Promise<boolean | undefined> {
  const { entry } = session;
  if (!entry.model?.trim()) return undefined;
  const last = { ...(entry.modelProvider ? { provider: entry.modelProvider } : {}), model: entry.model };
  // What convergeSession will set: a model, the agent's default (null), or nothing.
  const patch = choice
    ? planSessionPatch(entry as Parameters<typeof planSessionPatch>[0], choice)?.model
    : undefined;
  if (typeof patch === "string") {
    const slash = patch.indexOf("/");
    return !sameModel(last, { provider: patch.slice(0, Math.max(slash, 0)), model: patch.slice(slash + 1) });
  }
  const resolve = (await sessionStoreSdk()).resolveSessionModelRef;
  // The live config: a default written since the account started counts.
  const live = currentConfig() ?? cfg;
  if (!resolve || !live) return undefined;
  const next: GameSessionEntry & Record<string, unknown> = { ...entry };
  if (patch === null) {
    for (const field of [
      "providerOverride",
      "modelOverride",
      "modelOverrideFallbackOriginProvider",
      "modelOverrideFallbackOriginModel",
    ]) {
      delete next[field];
    }
  }
  try {
    return !sameModel(last, resolve(live as OpenClawConfig, next, agentId));
  } catch {
    return undefined;
  }
}

async function sessionUsage(
  session: StoredGameSession,
  agentId: string | undefined,
  cfg: unknown,
  choice: ModelChoice | undefined,
): Promise<GameSessionUsage> {
  const { entry } = session;
  return {
    resetDue: await resetDue(session, cfg),
    totalTokens: entry.totalTokens,
    totalTokensFresh: entry.totalTokensFresh,
    totalTokensVersion: entry.totalTokensVersion,
    tokensVersioned: storeKind(await sessionStoreSdk()) === "sqlite",
    contextTokens: entry.contextTokens,
    modelChanged: await modelChanged(session, agentId, cfg, choice),
    compactionCount: entry.compactionCount,
    flushed: entry.memoryFlush != null || entry.memoryFlushCompactionCount != null,
    transcriptBytes: await transcriptBytes(session, agentId, cfg),
  };
}

/**
 * The generation a game's next move runs in: its current one, or the next once the current one
 * grew near the flush, after deleting it (a delete that can't happen now is retried by the sweep).
 * `sessionKey` is the game's generation-0 key as its route resolves; `choice`, the chat's model
 * choice the move applies to its session (undefined: none). Called on the inbound queue before a
 * move, so never while one of ours runs, and it keeps a session a run still holds.
 */
export async function gameGenerationForMove(params: {
  sessionKey: string;
  agentId?: string;
  widgetId: string;
  briefChars: number;
  choice?: ModelChoice;
  cfg?: unknown;
  log?: BasicLogger;
}): Promise<{ gen: number; rotated?: string; deleted?: GameSessionDeletion }> {
  const base = baseSessionKey(params.sessionKey);
  const agentId = params.agentId ?? sessionAgentId(params.sessionKey);
  const listed = await listGameSessions(agentId, params.cfg);
  const own = listed?.filter((session) => baseSessionKey(session.sessionKey) === base);
  const newest = own?.reduce<StoredGameSession | undefined>(
    (max, session) => (max && max.gen >= session.gen ? max : session),
    undefined,
  );
  let state = generations.get(base);
  if (!state || (newest && newest.gen > state.gen)) {
    state = newest ? { gen: newest.gen } : { gen: 0, moves: 0 };
    generations.set(base, state);
  }
  const gen = state.gen;
  const current = own?.find((session) => session.gen === gen);
  // Not in the store's list yet: a fresh generation, unless its moves say otherwise (a list that
  // never shows it is no list). Without a list, moves count.
  if (own && !current && (state.moves ?? 0) < UNMEASURED_MOVES_PER_SESSION) return { gen };
  const usage = current ? await sessionUsage(current, agentId, params.cfg, params.choice) : undefined;
  const rotated = gameRotationReason(usage, {
    moves: state.moves,
    briefChars: params.briefChars,
    cfg: params.cfg,
  });
  // Never under a run still going on it: this move joins that run's session, whose margin holds it.
  if (!rotated || (current && gameSessionBusy(current.sessionKey))) return { gen };
  const deleted = await deleteGameSessions({
    agentId,
    widgetId: params.widgetId,
    gens: [gen],
    cfg: params.cfg,
    log: params.log,
  });
  generations.set(base, { gen: gen + 1, moves: 0 });
  return { gen: gen + 1, rotated, deleted };
}

// --- Deletion ----------------------------------------------------------------------------------
// A finished game's sessions go whole: every generation, transcripts included, no archive left.
// OpenClaw's own `sessions.delete` (`runtime.subagent.deleteSession`) refuses a plugin a session it
// didn't create, which a channel route's sessions never are (since the floor), and archives the
// transcript anyway. So, by store:
//   - SQLite (2026.8.1+): `cleanupSessionLifecycleArtifacts`, the cleanup memory-core runs on its
//     own sessions, removes the sessions under a key prefix with their transcript rows, unarchived
//     (`archiveRemovedEntryTranscripts: false`), and any orphaned transcript window carrying the
//     brief's marker. It refuses while a run on one is in flight.
//   - Files (2026.6.10 to 2026.7): the transcript files go (with any archive of them), then the
//     entry leaves sessions.json through `updateSessionStore`, the store's own writer.
// A prefix reaches every key that starts with it (`…widget-<id>-g1` reaches `…-g12` too), so one is
// used only when the listed sessions it reaches are exactly the ones meant. A generation it can't
// single out from a later one of its game (generation 0 never can) goes with all of them where the
// caller allows it (`orWhole`: every brief is self-contained, so the next move just starts afresh),
// else waits for its game's end, when one prefix takes them all. Deleting its entry alone is no way
// out: the store keeps a placeholder row that still holds its transcript (seen on 2026.8.1).
// A deleted transcript's bytes can outlive its rows in the SQLite file's free pages and WAL (the
// store sets no `secure_delete`) until SQLite reuses them; `openclaw doctor --session-sqlite
// compact` (gateway stopped) rewrites the file without them.

/** "none": the game has no session here; "busy": a run on one still goes; "kept": the store
 *  couldn't delete it (logged once per session, tried again by the sweep). */
export type GameSessionDeletion = "deleted" | "none" | "busy" | "kept";

const PLUGIN_ID = "clawbits";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ARCHIVE_SUFFIX = /^(?:reset|deleted|bak)\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?Z$/u;
const IN_FLIGHT = /competing work|in flight/iu;

/** Sessions whose failed delete was logged: once each, until one succeeds. */
const failureLogged = new Set<string>();

/** The part of a session key a lifecycle prefix matches: after `agent:<id>:`. */
function keySegment(sessionKey: string): string {
  const key = sessionKey.toLowerCase();
  const first = key.indexOf(":");
  const second = first < 0 ? -1 : key.indexOf(":", first + 1);
  return second < 0 ? key : key.slice(second + 1);
}

function transcriptIds(entry: GameSessionEntry): string[] {
  return [entry.sessionId, ...(entry.usageFamilySessionIds ?? [])].filter(
    (id): id is string => typeof id === "string" && id.trim() !== "",
  );
}

/** Whether `name`, in the sessions directory, is a file of transcript `id`: for a UUID, any file
 *  named after it (transcript, topics, checkpoints, trajectory, archives); else the transcript and
 *  its archives. */
function isTranscriptFile(name: string, id: string): boolean {
  if (UUID.test(id)) return name.startsWith(`${id}.`) || name.startsWith(`${id}-topic-`);
  const transcript = `${id}.jsonl`;
  return name === transcript || (name.startsWith(`${transcript}.`) && ARCHIVE_SUFFIX.test(name.slice(transcript.length + 1)));
}

/** The sessions a deletion left, and why. */
interface StoreDeletion {
  kept: StoredGameSession[];
  why?: string;
}

async function deleteFromSqlite(
  cleanup: NonNullable<SessionStoreSdk["cleanupSessionLifecycleArtifacts"]>,
  targets: StoredGameSession[],
  listed: StoredGameSession[],
  params: { agentId?: string; gens?: readonly number[]; cfg?: unknown },
): Promise<StoreDeletion> {
  const kept: StoredGameSession[] = [];
  const store = sessionStoreConfig(params.cfg);
  // Every generation under the game's base key, or each generation under its own.
  for (const group of params.gens ? targets.map((target) => [target]) : [targets]) {
    const first = group[0];
    if (!first) continue;
    const prefix = keySegment(params.gens ? first.sessionKey : baseSessionKey(first.sessionKey));
    if (listed.some((session) => keySegment(session.sessionKey).startsWith(prefix) && !group.includes(session))) {
      kept.push(...group);
      continue;
    }
    const agentId = params.agentId ?? sessionAgentId(first.sessionKey);
    const { removedEntries } = await cleanup({
      ...(agentId ? { agentId } : {}),
      ...(store ? { sessionStore: store } : {}),
      sessionKeySegmentPrefix: prefix,
      transcriptContentMarker: GAME_TRANSCRIPT_MARKER,
      orphanTranscriptMinAgeMs: 0,
      archiveRemovedEntryTranscripts: false,
      pluginOwnerId: PLUGIN_ID,
    });
    if (removedEntries < group.length) kept.push(...group);
  }
  return { kept, why: "its key prefix reaches a session still in play, or the store kept it" };
}

async function deleteFromFiles(
  sdk: Required<Pick<SessionStoreSdk, "resolveStorePath" | "updateSessionStore">>,
  targets: StoredGameSession[],
  params: { agentId?: string; cfg?: unknown },
): Promise<StoreDeletion> {
  const agentId = params.agentId ?? sessionAgentId(targets[0]?.sessionKey ?? "");
  const storePath = path.resolve(sdk.resolveStorePath(sessionStoreConfig(params.cfg), agentId ? { agentId } : undefined));
  const dir = path.dirname(storePath);
  // Files first: an entry whose files outlived it would leave nothing to find them by.
  const ids = targets.flatMap((target) => transcriptIds(target.entry));
  const named = new Set(
    targets
      .map((target) => target.entry.sessionFile?.trim())
      .filter((file): file is string => Boolean(file))
      .map((file) => path.resolve(dir, file))
      .filter((file) => path.dirname(file) === dir)
      .map((file) => path.basename(file)),
  );
  for (const name of await fs.readdir(dir)) {
    if (named.has(name) || ids.some((id) => isTranscriptFile(name, id))) {
      await fs.rm(path.join(dir, name), { force: true });
    }
  }
  const keys = new Set(targets.map((target) => target.sessionKey));
  const removed = new Set<string>();
  await sdk.updateSessionStore(storePath, (store) => {
    for (const key of Object.keys(store)) {
      if (!keys.has(key)) continue;
      delete store[key];
      removed.add(key);
    }
  });
  return {
    kept: targets.filter((target) => !removed.has(target.sessionKey)),
    why: "not in the session store",
  };
}

function reportKept(sessions: StoredGameSession[], why: string, log: BasicLogger | undefined): void {
  for (const session of sessions) {
    const message = `[clawbits] game session ${session.sessionKey} not deleted (${why}); trying again later`;
    if (failureLogged.has(session.sessionKey)) {
      pluginDebug(message);
      continue;
    }
    failureLogged.add(session.sessionKey);
    logWarn(log, message);
  }
}

/**
 * Delete a game's own sessions, every generation or only `gens`, transcripts included and nothing
 * archived, by the best means the host's store offers (see Deletion). With `orWhole`, a generation
 * the store can't delete alone takes the game's others with it. Never while a run on one still goes
 * ("busy": the caller tries again). Never throws.
 */
export async function deleteGameSessions(params: {
  agentId?: string;
  widgetId: string;
  gens?: readonly number[];
  orWhole?: boolean;
  cfg?: unknown;
  log?: BasicLogger;
}): Promise<GameSessionDeletion> {
  const listed = await listGameSessions(params.agentId, params.cfg);
  if (!listed) return "kept";
  const widgetId = params.widgetId.toLowerCase();
  const game = listed.filter((session) => session.widgetId.toLowerCase() === widgetId);
  let gens = params.gens;
  let targets = game.filter((session) => !gens || gens.includes(session.gen));
  if (!targets.length) return "none";
  const sdk = await sessionStoreSdk();
  const kind = storeKind(sdk);
  if (
    gens &&
    params.orWhole &&
    kind === "sqlite" &&
    targets.some((target) =>
      game.some(
        (other) =>
          !targets.includes(other) && keySegment(other.sessionKey).startsWith(keySegment(target.sessionKey)),
      ),
    )
  ) {
    gens = undefined;
    targets = game;
  }
  if (targets.some((session) => gameSessionBusy(session.sessionKey))) return "busy";
  if (params.gens && !gens) {
    logInfo(
      params.log,
      `[clawbits] game ${params.widgetId}: an earlier generation can't be deleted alone, so all of its sessions go; its next move starts afresh`,
    );
  }
  let result: StoreDeletion;
  try {
    const { cleanupSessionLifecycleArtifacts: cleanup, resolveStorePath, updateSessionStore } = sdk;
    result =
      kind === "sqlite" && cleanup
        ? await deleteFromSqlite(cleanup, targets, listed, { ...params, gens })
        : kind === "file" && resolveStorePath && updateSessionStore
          ? await deleteFromFiles({ resolveStorePath, updateSessionStore }, targets, params)
          : { kept: targets, why: "this OpenClaw has no session store a plugin can delete from" };
  } catch (err) {
    const message = errorText(err);
    if (IN_FLIGHT.test(message)) return "busy";
    result = { kept: targets, why: message };
  }
  for (const session of targets) {
    if (result.kept.includes(session)) continue;
    failureLogged.delete(session.sessionKey);
    if (!gens) generations.delete(baseSessionKey(session.sessionKey));
  }
  if (!result.kept.length) return "deleted";
  reportKept(result.kept, result.why ?? "unknown", params.log);
  return "kept";
}

/** Test seam: forget generations, runs and logged failures. */
export function __resetGameSessionsForTest(): void {
  generations.clear();
  gameRuns.clear();
  failureLogged.clear();
}
