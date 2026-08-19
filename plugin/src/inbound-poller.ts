// Lightweight polling loop that ingests new Mattermost posts from the
// Clawbits-managed owner channel and forwards them to an inbound handler.
//
// Clawbits inbound uses a single agent WebSocket when available, with SSE,
// rare reconciliation, and fallback polling behind it. The poller tracks a monotonic
// `create_at` cursor so we never re-dispatch the same post, filters out our
// own echoes (posts authored by `account.agentId`) and Mattermost system
// messages (`type: "system_join_channel"`, etc.), and respects an AbortSignal
// for clean shutdown from the channel gateway.

import type { WatermarkStore } from "./channel-watermarks.js";
import { resolveKnownAnswers, withChallenge } from "./challenge.js";
import type { ClawBitsClient } from "./client.js";
import { ClawBitsError } from "./errors.js";
import { wakeAutomationsReconciler } from "./automations/reconcile.js";
import {
  consoleErrorWithFile,
  logDebug,
  logError,
  logInfo,
  logWarn,
  writeTraceSpan,
} from "./file-logger.js";
import * as mmTools from "./tools/mattermost.js";
import type { ResolvedClawBitsAccount } from "./types.js";

/** Subset of `MmFileResponse` we surface to the agent. The server returns
 *  more fields (status, sha256, dimensions, etc.); the poller keeps only
 *  what the inbound dispatcher uses to summarise the attachment for the
 *  model. */
export interface InboundFile {
  fileId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  /** Presigned GET URL when the server inlined one (images today). May
   *  be ``null`` for non-image files; the agent can request a fresh URL
   *  via ``GET /api/agentic/mm/files/{id}/url`` if it needs the bytes. */
  downloadUrl: string | null;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

/** A single prior post handed to the agent as read-only catch-up context
 *  the first time it is tagged in a shared channel. Distinct from
 *  `InboundMessage` because these are never dispatched as their own turns —
 *  they only ever render inside the tagged message's context block. */
export interface InboundContextPost {
  postId: string;
  senderId: string;
  text: string;
  createAt: number;
  /** True when this agent authored the post — lets the renderer label the
   *  line as the agent's own prior reply so it reads the history correctly. */
  isSelf: boolean;
}

/** One parsed Mattermost post that survived ingestion filters. */
export interface InboundMessage {
  accountId: string;
  channelId: string;
  postId: string;
  senderId: string;
  /** Literal @mention prefix for the sender when inter-agent mode is enabled. */
  senderTag?: string;
  text: string;
  createAt: number;
  /** Files attached to this post. Optional for backwards compatibility
   *  with callers (mostly tests) that hand-roll an `InboundMessage`;
   *  `runInboundPoller` itself always sets this — to ``[]`` when the
   *  post had no attachments — so production paths can treat it as
   *  effectively required. */
  files?: InboundFile[];
  /** Channel type as reported by the server (``"direct"`` / ``"public"`` /
   *  ``"private"`` / ``null`` when the discovery call couldn't surface
   *  it). The dispatcher uses this for reply routing and the shimmer
   *  decision: DMs always use the streaming-draft flow; group channels do
   *  too by default, falling back to a single-POST reply when
   *  ``groupChannelShimmer`` is disabled (see gateway-adapter). */
  channelType?: string | null;
  /** Up to `channelContextBacklog` posts that arrived in this channel since
   *  the agent last looked (newer than the persisted watermark), oldest
   *  first. Set on each dispatched mention in a shared channel when the agent
   *  does not require response approval, so it can catch up on what it missed.
   *  Undefined for DMs, and whenever there's nothing new to surface. */
  priorContext?: InboundContextPost[];
  /** End-to-end latency trace id read off the inbound post (server-persisted
   *  from the human send). Carried through the turn and re-stamped onto the
   *  agent's reply so one id spans the whole round-trip. Undefined for posts
   *  created before tracing or by clients that don't mint one. */
  traceId?: string;
  /** Set when the dispatch was triggered by the server-side LobsterTalk attention
   *  gate (a `lobstertalk.consider` control event) rather than a direct
   *  @mention/DM. The agent is prompted to reply only if it can add something
   *  genuinely useful, so a soft nudge doesn't read as a command to respond. */
  attention?: boolean;
  /** This turn is the boot catch-up for its channel: `priorContext` holds
   *  messages that arrived while the agent was down and are still unanswered.
   *  Flips the history block off its "do not reply to these" framing — without
   *  it the model is told to ignore exactly what we recovered. */
  catchUp?: boolean;
  raw: MattermostPost;
}

/** Subset of the Mattermost post shape the poller actually reads. */
export interface MattermostPost {
  id: string;
  create_at: number;
  update_at?: number;
  delete_at?: number;
  user_id?: string;
  channel_id?: string;
  message?: string;
  type?: string;
  /** ``streaming`` | ``draft`` | ``published`` | ``rejected``. Needed because
   *  the agent read path returns streaming rows too, and a half-written reply
   *  is otherwise indistinguishable from a finished one. See
   *  `isSettledSelfPost`. */
  status?: string;
  props?: Record<string, unknown>;
  agent_id?: string;
  human_id?: number;
  poster_display_name?: string;
  created_at_raw?: string;
  /** Server-persisted end-to-end trace id (see InboundMessage.traceId). */
  trace_id?: string;
  /** Inline attachments as returned by the agent posts endpoint. Shape
   *  follows `MmFileResponse` server-side. */
  files?: InboundFile[];
}

export interface InboundPollerLog {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface InboundPollerOptions {
  client: ClawBitsClient;
  account: ResolvedClawBitsAccount;
  abortSignal: AbortSignal;
  onInboundMessage: (msg: InboundMessage) => Promise<void> | void;
  /** Milliseconds between fallback polls when realtime is unavailable. Defaults to 30 seconds. */
  pollIntervalMs?: number;
  /** Milliseconds a queued inbound post may wait before it is dropped. Defaults to 10 minutes. */
  inboundQueueTtlMs?: number;
  /** Prefer one agent WebSocket over per-channel SSE. Defaults true. */
  websocketEnabled?: boolean;
  /** Rare post reconciliation poll cadence while WebSocket is healthy. Defaults to 5 minutes. */
  websocketReconcileIntervalMs?: number;
  /** Channel/settings refresh cadence while WebSocket is healthy. Defaults to 5 minutes. */
  websocketControlRefreshIntervalMs?: number;
  log?: InboundPollerLog;
  /** Test seam: override wall-clock time for cursor init. */
  now?: () => number;
  /** Test seam: pin every channel's floor to this `create_at` and skip boot
   *  catch-up. Production never passes it. */
  initialCursor?: number;
  /** Run the one-shot boot catch-up pass. Defaults true. */
  catchUpEnabled?: boolean;
  /**
   * Optional set of post IDs to treat as self-authored echoes (skip). The
   * outbound adapter can share this bag to suppress its own posts when the
   * server does not echo a distinct `user_id`.
   */
  seenPostIds?: Set<string>;
  /**
   * Persistent per-(account, channel) "last seen" watermark. Used to trim the
   * catch-up backlog so history the agent has already been shown is never
   * re-injected across gateway restarts. Omit for the in-memory-only
   * behaviour (dedupe within a single poller lifetime; re-inject once after a
   * restart).
   */
  watermarkStore?: WatermarkStore;
}

interface MmPostsResponse {
  posts?: Record<string, MattermostPost> | Array<Record<string, unknown>>;
  order?: string[];
}

function parseTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const raw = value.trim();

    // Clawbits currently returns SQLite-style naive timestamps such as
    // "2026-04-21 12:10:08". SQLite CURRENT_TIMESTAMP is UTC, but Node parses
    // that shape as local time, which shifts messages by the local timezone and
    // causes the poller cursor to think fresh posts are already old. Treat this
    // specific naive DATETIME shape as UTC.
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/u.test(raw)) {
      const parsedUtc = Date.parse(raw.replace(" ", "T") + "Z");
      if (!Number.isNaN(parsedUtc)) return parsedUtc;
    }

    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) return numeric;
  }
  return 0;
}

function normalizeFile(raw: unknown): InboundFile | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const fileId = typeof r["file_id"] === "string" ? (r["file_id"] as string) : "";
  if (!fileId) return undefined;
  const filename = typeof r["filename"] === "string" ? (r["filename"] as string) : fileId;
  const contentType =
    typeof r["content_type"] === "string"
      ? (r["content_type"] as string)
      : "application/octet-stream";
  const sizeRaw = r["size_bytes"];
  const sizeBytes =
    typeof sizeRaw === "number" && Number.isFinite(sizeRaw) ? sizeRaw : 0;
  const downloadUrl =
    typeof r["download_url"] === "string" && (r["download_url"] as string).length > 0
      ? (r["download_url"] as string)
      : null;
  const thumbnailUrl =
    typeof r["thumbnail_url"] === "string" && (r["thumbnail_url"] as string).length > 0
      ? (r["thumbnail_url"] as string)
      : null;
  const widthRaw = r["width"];
  const heightRaw = r["height"];
  const durationRaw = r["duration_ms"];
  return {
    fileId,
    filename,
    contentType,
    sizeBytes,
    downloadUrl,
    thumbnailUrl,
    width: typeof widthRaw === "number" && Number.isFinite(widthRaw) ? widthRaw : null,
    height: typeof heightRaw === "number" && Number.isFinite(heightRaw) ? heightRaw : null,
    durationMs:
      typeof durationRaw === "number" && Number.isFinite(durationRaw) ? durationRaw : null,
  };
}

function normalizePost(raw: Record<string, unknown>): MattermostPost | undefined {
  const idValue = raw["id"] ?? raw["post_id"];
  const id = typeof idValue === "string" ? idValue : idValue != null ? String(idValue) : "";
  if (!id) return undefined;

  const createAt = parseTimestamp(raw["create_at"] ?? raw["created_at"]);
  const updateAt = parseTimestamp(raw["update_at"] ?? raw["updated_at"]);
  const deleteAt = parseTimestamp(raw["delete_at"] ?? raw["deleted_at"]);
  const userIdRaw = raw["user_id"] ?? raw["agent_id"] ?? raw["human_id"];
  const userId =
    typeof userIdRaw === "string"
      ? userIdRaw
      : typeof userIdRaw === "number"
        ? String(userIdRaw)
        : undefined;

  let files: InboundFile[] | undefined;
  const rawFiles = raw["files"];
  if (Array.isArray(rawFiles) && rawFiles.length > 0) {
    const collected: InboundFile[] = [];
    for (const entry of rawFiles) {
      const f = normalizeFile(entry);
      if (f) collected.push(f);
    }
    if (collected.length > 0) files = collected;
  }

  return {
    id,
    create_at: createAt,
    ...(updateAt ? { update_at: updateAt } : {}),
    ...(deleteAt ? { delete_at: deleteAt } : {}),
    ...(userId ? { user_id: userId } : {}),
    ...(typeof raw["channel_id"] === "string" ? { channel_id: raw["channel_id"] as string } : {}),
    ...(typeof raw["message"] === "string" ? { message: raw["message"] as string } : {}),
    ...(typeof raw["type"] === "string" ? { type: raw["type"] as string } : {}),
    ...(typeof raw["status"] === "string" ? { status: raw["status"] as string } : {}),
    ...(raw["props"] && typeof raw["props"] === "object"
      ? { props: raw["props"] as Record<string, unknown> }
      : {}),
    ...(typeof raw["agent_id"] === "string" ? { agent_id: raw["agent_id"] as string } : {}),
    ...(typeof raw["human_id"] === "number" ? { human_id: raw["human_id"] as number } : {}),
    ...(typeof raw["poster_display_name"] === "string"
      ? { poster_display_name: raw["poster_display_name"] as string }
      : {}),
    ...(typeof raw["created_at"] === "string"
      ? { created_at_raw: raw["created_at"] as string }
      : {}),
    ...(typeof raw["trace_id"] === "string" ? { trace_id: raw["trace_id"] as string } : {}),
    ...(files ? { files } : {}),
  };
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_WEBSOCKET_RECONCILE_INTERVAL_MS = 5 * 60_000;
const DEFAULT_WEBSOCKET_CONTROL_REFRESH_INTERVAL_MS = 5 * 60_000;
const DEFAULT_INBOUND_QUEUE_TTL_MS = 10 * 60_000;
const SEEN_RING_LIMIT = 1000;
const DEFAULT_CONSECUTIVE_AGENT_TURNS = 10;
const MAX_CONSECUTIVE_AGENT_TURNS = 50;
const HUMAN_GUIDANCE_MESSAGE = "Nice, but need human guidance to proceed.";

// --- Boot catch-up -----------------------------------------------------------
// PREFERRED RESUME POINT: the server-side read pointer (`last_read_post_id`
// on the channel listing, acked on turn settle). It is a post-id serial, so
// it needs no look-back window, no clock math, and survives a wiped guest
// filesystem. The timestamp windows below are the LEGACY fallback for
// servers that predate the pointer (channel payload carries no
// `last_read_post_id`) — that path keeps the old semantics.
//
// Legacy look-back bound with a persisted cursor. Generous because the
// one-turn-per-channel cap decouples window size from burst risk.
const CATCH_UP_WINDOW_MS = 6 * 60 * 60_000;
// Legacy look-back with no cursor: a first boot, or a recreate/upgrade that
// wiped the state file.
const COLD_CATCH_UP_WINDOW_MS = 60 * 60_000;
// The pass runs before the agent WebSocket starts, so bound it: on breach the
// remaining channels keep their now()-seeded floors and retry next boot (the
// un-advanced read pointer is what makes the retry work).
const MAX_CATCH_UP_TURNS = 8;
const MAX_CATCH_UP_MS = 5 * 60_000;
const CATCH_UP_CONTEXT_LIMIT = 50;
// See the skew note in `runCatchUp` (legacy path only — a serial cursor has
// no clock to skew).
const MAX_CATCH_UP_CLOCK_SKEW_MS = 10 * 60_000;
// Forward-cursor drain bounds: pages of `CATCH_UP_PAGE_SIZE` via
// `after_post_id`, at most `MAX_CATCH_UP_PAGES` per channel. A gap beyond
// that falls back to the newest page with the overflow noted — answering
// this week's messages beats faithfully replaying last week's.
const CATCH_UP_PAGE_SIZE = 50;
const MAX_CATCH_UP_PAGES = 4;
// A failed boot control fetch defers catch-up — but only this many times,
// each followed by a SHORT retry sleep (not the full poll interval): the
// deferral holds realtime startup to keep live settles from acking past the
// unread gap, so every deferred tick is added latency on all message flow.
// After the budget the pass runs against the fallback channel set — a
// bounded snooze-blindness window that is no worse than the live path's own
// (agentSnoozed also starts false there), rather than an indefinite outage.
const MAX_CATCH_UP_DEFERRALS = 1;
const CATCH_UP_DEFERRAL_RETRY_MS = 1000;

type InboundSource = "poll" | "reconcile" | "sse" | "ws";

type ExpiringInboundQueueItem = {
  id: string;
  enqueuedAt: number;
  expiresAt: number;
  run: () => Promise<void>;
  expire?: () => Promise<void> | void;
};

type PendingExpiringInboundQueueItem = ExpiringInboundQueueItem & {
  resolve: () => void;
  reject: (err: unknown) => void;
};

class ExpiringInboundQueue {
  #pending: PendingExpiringInboundQueueItem[] = [];
  #draining = false;

  constructor(private readonly now: () => number) {}

  enqueue(item: ExpiringInboundQueueItem): Promise<void> {
    const task = new Promise<void>((resolve, reject) => {
      this.#pending.push({ ...item, resolve, reject });
    });
    this.#drain();
    return task;
  }

  #drain(): void {
    if (this.#draining) return;
    this.#draining = true;
    void (async () => {
      try {
        for (;;) {
          const item = this.#pending.shift();
          if (!item) return;
          try {
            if (this.now() >= item.expiresAt) {
              await item.expire?.();
            } else {
              await item.run();
            }
            item.resolve();
          } catch (err) {
            item.reject(err);
          }
        }
      } finally {
        this.#draining = false;
        if (this.#pending.length > 0) this.#drain();
      }
    })();
  }
}

function resolvePositiveMs(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "string" && value.trim().length > 0 ? Number(value.trim()) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.floor(parsed));
}

function resolveInboundQueueTtlMs(value: unknown): number {
  return resolvePositiveMs(value, DEFAULT_INBOUND_QUEUE_TTL_MS);
}

function resolvePollIntervalMs(value: unknown): number {
  return Math.max(1, resolvePositiveMs(value, DEFAULT_POLL_INTERVAL_MS));
}

function resolveBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

/** Sleep `ms` but resolve immediately if `signal` aborts. */
async function sleepInterruptible(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Normalize the `GET /channels/{id}/posts` response. Mattermost returns
 * `{ posts: { [id]: Post }, order: string[] }`; we sort ascending by
 * `create_at` so the caller observes messages in arrival order.
 */
export function parsePostsResponse(raw: unknown): MattermostPost[] {
  if (!raw || typeof raw !== "object") return [];
  const body = raw as MmPostsResponse;
  const sourcePosts = body.posts;
  const out: MattermostPost[] = [];

  if (Array.isArray(sourcePosts)) {
    for (const item of sourcePosts) {
      if (!item || typeof item !== "object") continue;
      const normalized = normalizePost(item as Record<string, unknown>);
      if (normalized) out.push(normalized);
    }
  } else {
    const byId = sourcePosts ?? {};
    const ids = Array.isArray(body.order) && body.order.length > 0 ? body.order : Object.keys(byId);
    for (const id of ids) {
      const post = byId[id];
      if (!post || typeof post !== "object") continue;
      const normalized = normalizePost(post as unknown as Record<string, unknown>);
      if (normalized) out.push(normalized);
    }
  }

  out.sort((a, b) => (a.create_at ?? 0) - (b.create_at ?? 0));
  return out;
}

/**
 * MM sends system events through the same posts stream (joins, header
 * changes, etc.). They carry a non-empty `type` like `system_join_channel`.
 * Real user messages have no `type` or an empty string. An attachment-only
 * post (image dropped without a caption) is still user-authored content —
 * we accept it when the post carries at least one file even if the
 * message body is blank.
 */
export function isUserAuthoredPost(post: MattermostPost): boolean {
  if (post.type) return false;
  const hasText = Boolean((post.message ?? "").trim());
  const hasFiles = Array.isArray(post.files) && post.files.length > 0;
  return hasText || hasFiles;
}

/**
 * True when `post` is a *finished* reply by this agent — the only thing that
 * proves it already answered what came before.
 *
 * The `status` check is the whole point. `activity/stream-patcher.ts` appends
 * partial assistant text into the open draft every ~180ms, so a turn killed
 * mid-reply leaves a NON-EMPTY `streaming` row that `isUserAuthoredPost`
 * accepts. Trusting that would clamp away the post the dead turn was answering
 * — a permanent silent miss whose evidence the server reaper then deletes.
 *
 * Missing `status` counts as settled: old servers and test fixtures omit it.
 */
export function isSettledSelfPost(post: MattermostPost, agentId: string | undefined): boolean {
  if (!agentId) return false;
  if (post.agent_id !== agentId && post.user_id !== agentId) return false;
  if (post.status === "streaming" || post.status === "draft") return false;
  if (post.delete_at && post.delete_at > 0) return false;
  return isUserAuthoredPost(post);
}

/** Stable sender label for a post: prefer the human id, then the agent id,
 *  finally the raw user id. Mirrors the attribution `runInboundPoller`
 *  builds for the dispatched message so context lines read consistently. */
export function senderIdForPost(post: MattermostPost): string {
  if (post.human_id !== undefined) return `human:${String(post.human_id)}`;
  if (post.agent_id) return `agent:${post.agent_id}`;
  return post.user_id ?? "";
}

function sanitizeMentionHandle(raw: string): string {
  return raw.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9_.-]/g, "");
}

export function senderTagForPost(post: MattermostPost): string | undefined {
  if (post.agent_id) return `@${post.agent_id}`;
  if (post.human_id !== undefined) {
    const base = post.poster_display_name?.trim() || `user-${String(post.human_id)}`;
    const handle = sanitizeMentionHandle(base) || `user-${String(post.human_id)}`;
    return `@${handle}`;
  }
  return undefined;
}

const MENTION_HANDLE_CHARS = "A-Za-z0-9_.-";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionRegex(agentId: string): RegExp {
  return new RegExp(
    `(^|[^${MENTION_HANDLE_CHARS}])(@${escapeRegExp(agentId)})(?=$|[^${MENTION_HANDLE_CHARS}])`,
    "g",
  );
}

function hasAgentMention(message: string, agentId: string): boolean {
  return mentionRegex(agentId).test(message);
}

/**
 * Bare `/cb-usage` is a DM-only command answered server-side in-chat (the gateway
 * posts the agent's CB_TOKENS balance as a reply). In a DM the plugin must not
 * also dispatch it to the model, or the human gets a duplicate, LLM-generated
 * answer. The DM gate lives at the call site — elsewhere `/cb-usage` is a normal
 * message.
 */
export function isServerHandledCommand(message: string | undefined): boolean {
  return (message ?? "").trim().toLowerCase() === "/cb-usage";
}

export function collapseSelfMentions(message: string, agentId: string | undefined): string {
  if (!agentId || !message.includes(`@${agentId}`)) return message;
  const re = mentionRegex(agentId);
  let seen = false;
  let out = "";
  let last = 0;
  for (const match of message.matchAll(re)) {
    const fullStart = match.index ?? 0;
    const prefix = match[1] ?? "";
    const tag = match[2] ?? "";
    const tagStart = fullStart + prefix.length;
    const tagEnd = tagStart + tag.length;
    if (!seen) {
      seen = true;
      continue;
    }
    out += message.slice(last, tagStart);
    last = tagEnd;
    const next = message.slice(last, last + 1);
    if (/\s/.test(out.slice(-1)) && /\s/.test(next)) {
      last += 1;
    } else if (/\s/.test(out.slice(-1)) && /[,.;:!?]/.test(next)) {
      out = out.trimEnd();
    }
  }
  if (!seen || last === 0) return message;
  out += message.slice(last);
  return out;
}

/**
 * Build the read-only catch-up context for a freshly-tagged post: the
 * user-authored posts that came strictly before it, oldest first, capped to
 * the most recent `limit`. System events and the triggering post itself are
 * excluded; the agent's own prior replies are kept (with `isSelf: true`) so
 * the history reads as a coherent back-and-forth. Posts at or below
 * `sinceCreateAt` (the persisted watermark of what the agent has already
 * been shown) are skipped so history is never surfaced twice. When
 * `includeAgentPosts` is false, agent-authored posts are excluded from this
 * model-visible context too. Returns an empty array when there is nothing to
 * surface.
 */
export function buildPriorContext(
  history: MattermostPost[],
  triggerPostId: string,
  triggerCreateAt: number,
  limit: number,
  agentId?: string,
  sinceCreateAt = 0,
  includeAgentPosts = true,
): InboundContextPost[] {
  if (limit <= 0) return [];
  const eligible: InboundContextPost[] = [];
  for (const p of history) {
    if (p.id === triggerPostId) continue;
    if (p.create_at == null || p.create_at >= triggerCreateAt) continue;
    if (p.create_at <= sinceCreateAt) continue;
    if (p.delete_at && p.delete_at > 0) continue;
    if (!includeAgentPosts && p.agent_id) continue;
    if (!isUserAuthoredPost(p)) continue;
    eligible.push({
      postId: p.id,
      senderId: senderIdForPost(p),
      text: p.message ?? "",
      createAt: p.create_at,
      isSelf: Boolean(agentId && (p.agent_id === agentId || p.user_id === agentId)),
    });
  }
  // `history` is sorted ascending by create_at (parsePostsResponse), so the
  // tail is the most recent `limit` posts before the trigger.
  return eligible.length > limit ? eligible.slice(-limit) : eligible;
}

/**
 * Long-lived polling loop. Resolves when `abortSignal` fires or the loop
 * exits normally. Never throws; network/parse failures are logged.
 *
 * The poller fans out across every channel the agent is a member of (via
 * `GET /api/agentic/mm/channels`), maintaining a per-channel `create_at`
 * cursor so each conversation tracks independently. It dispatches human
 * posts that are addressed to the agent; when inter-agent mode is enabled it
 * also dispatches other agents' addressed posts and tags replies to the sender.
 */
interface SseEnvelope {
  type?: string;
  channel_id?: string;
  data?: unknown;
}

function parseSseFrame(frame: string): SseEnvelope | null {
  const data = frame
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return null;
  try {
    const parsed = JSON.parse(data) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as SseEnvelope) : null;
  } catch {
    return null;
  }
}

type AgentWebSocketEnvelope = SseEnvelope & {
  type?: string;
};

function agentEventsWebSocketUrl(endpoint: string, apiKey: string): string {
  const base = endpoint.replace(/\/+$/u, "");
  const url = new URL(`${base}/api/agentic/mm/events/ws`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("api_key", apiKey);
  return url.toString();
}

async function consumeAgentWebSocketEvents(params: {
  client: ClawBitsClient;
  apiKey: string;
  abortSignal: AbortSignal;
  onOpen?: () => void;
  onEvent: (event: AgentWebSocketEnvelope) => void;
}): Promise<void> {
  if (typeof WebSocket === "undefined") {
    throw new Error("WebSocket is not available in this runtime");
  }
  const ws = new WebSocket(agentEventsWebSocketUrl(params.client.getEndpoint(), params.apiKey));
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (err?: unknown) => {
      if (settled) return;
      settled = true;
      params.abortSignal.removeEventListener("abort", onAbort);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => {
      try {
        ws.close();
      } catch {
        // ignore close race
      }
      settle();
    };
    const onOpen = () => {
      params.onOpen?.();
    };
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      try {
        const parsed = JSON.parse(event.data) as unknown;
        if (parsed && typeof parsed === "object") {
          params.onEvent(parsed as AgentWebSocketEnvelope);
        }
      } catch {
        // ignore malformed frame
      }
    };
    const onError = () => {
      settle(new Error("WebSocket error"));
    };
    const onClose = (event: CloseEvent) => {
      if (params.abortSignal.aborted) {
        settle();
        return;
      }
      settle(new Error(`WebSocket closed: ${event.code} ${event.reason || ""}`.trim()));
    };
    if (params.abortSignal.aborted) {
      onAbort();
      return;
    }
    params.abortSignal.addEventListener("abort", onAbort, { once: true });
    ws.addEventListener("open", onOpen);
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
  });
}

async function consumeChannelEvents(params: {
  client: ClawBitsClient;
  channelId: string;
  abortSignal: AbortSignal;
  onEvent: (event: SseEnvelope) => void;
}): Promise<void> {
  const response = await mmTools.streamChannelEvents(
    params.client,
    params.channelId,
    params.abortSignal,
  );
  if (!response.ok) {
    throw new Error(`SSE connect failed: HTTP ${response.status}`);
  }
  const body = response.body;
  if (!body) {
    throw new Error("SSE response body missing");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!params.abortSignal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      for (;;) {
        const idx = buffer.indexOf("\n\n");
        if (idx < 0) break;
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = parseSseFrame(frame);
        if (event) params.onEvent(event);
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore close race
    }
  }
}

export async function runInboundPoller(opts: InboundPollerOptions): Promise<void> {
  const now = opts.now ?? (() => Date.now());
  const seen = opts.seenPostIds ?? new Set<string>();
  // SCHEDULER EPOCH ONLY — feeds the reconcile/control-refresh deadlines below.
  // It used to double as the per-channel cursor seed, which is what dropped
  // every message sent during a VM restart. Keep the two separate: seeding the
  // timers from a past watermark puts both deadlines permanently in the past.
  const startedAt = opts.initialCursor ?? now();
  const cursors = new Map<string, number>();
  const reconcileFloors = new Map<string, number>();
  const { client, account, abortSignal, log } = opts;
  const mentionToken = account.agentId ? `@${account.agentId}` : null;
  const backlog = account.channelContextBacklog ?? 0;
  const allowFromSet = new Set(
    (account.allowFrom ?? []).map((v) => String(v).trim()).filter((v) => v.length > 0),
  );
  const answers = resolveKnownAnswers(account.knownAnswers);
  let interAgentMode = account.interAgentMode === true;
  let interAgentMessageLimit = clampInterAgentMessageLimit(account.interAgentMessageLimit);
  let agentSnoozed = false;
  let consecutiveAgentTurns = 0;
  let awaitingHumanGuidance = false;
  let guidanceNoticeSent = false;
  const watermarks = opts.watermarkStore;
  const channelTypes = new Map<string, string | null>();
  const sseChannels = new Map<
    string,
    { channelType: string | null; task: Promise<void>; abort: AbortController }
  >();
  let agentWsTask: Promise<void> | undefined;
  let agentWsAbort: AbortController | undefined;
  let agentWsConnected = false;
  let agentWsDisabledUntil = 0;
  let forceReconcilePoll = false;
  let nextWebSocketReconcileAt = startedAt;
  let nextWebSocketControlRefreshAt = startedAt;
  // OpenClaw's reply runtime is single-agent stateful. Poll delivery was already
  // serial because each post awaited dispatch; SSE delivery used to fire-and-forget
  // each post.created event, so two quick messages could enter the same agent
  // session at once and wedge the chat. Keep pickup low-latency by enqueueing
  // from the SSE reader, but run process+dispatch through an explicit expiring
  // message queue so stale backlog does not drain minutes later.
  const pollMs = resolvePollIntervalMs(
    opts.pollIntervalMs ??
      account.config.pollIntervalMs ??
      (account.config as Record<string, unknown>)["poll_interval_ms"] ??
      process.env.CLAWBITS_POLL_INTERVAL_MS,
  );
  const inboundQueueTtlMs = resolveInboundQueueTtlMs(
    opts.inboundQueueTtlMs ??
      account.config.inboundQueueTtlMs ??
      (account.config as Record<string, unknown>)["inbound_queue_ttl_ms"] ??
      process.env.CLAWBITS_INBOUND_QUEUE_TTL_MS,
  );
  const websocketEnabled = resolveBoolean(
    opts.websocketEnabled ??
      account.config.websocketEnabled ??
      (account.config as Record<string, unknown>)["websocket_enabled"] ??
      process.env.CLAWBITS_WEBSOCKET_ENABLED,
    true,
  );
  const catchUpEnabled = resolveBoolean(
    opts.catchUpEnabled ??
      account.config.catchUpEnabled ??
      (account.config as Record<string, unknown>)["catch_up_enabled"] ??
      process.env.CLAWBITS_CATCH_UP_ENABLED,
    true,
  );
  const websocketReconcileIntervalMs = resolvePositiveMs(
    opts.websocketReconcileIntervalMs ??
      account.config.websocketReconcileIntervalMs ??
      (account.config as Record<string, unknown>)["websocket_reconcile_interval_ms"] ??
      process.env.CLAWBITS_WEBSOCKET_RECONCILE_INTERVAL_MS,
    DEFAULT_WEBSOCKET_RECONCILE_INTERVAL_MS,
  );
  const websocketControlRefreshIntervalMs = resolvePositiveMs(
    opts.websocketControlRefreshIntervalMs ??
      account.config.websocketControlRefreshIntervalMs ??
      (account.config as Record<string, unknown>)["websocket_control_refresh_interval_ms"] ??
      process.env.CLAWBITS_WEBSOCKET_CONTROL_REFRESH_INTERVAL_MS,
    DEFAULT_WEBSOCKET_CONTROL_REFRESH_INTERVAL_MS,
  );
  const websocketIntervalJitter = (intervalMs: number): number =>
    intervalMs > 0
      ? Math.floor(Math.random() * Math.min(30_000, Math.floor(intervalMs / 10)))
      : 0;
  const websocketReconcileJitter = (): number =>
    websocketIntervalJitter(websocketReconcileIntervalMs);
  const websocketControlRefreshJitter = (): number =>
    websocketIntervalJitter(websocketControlRefreshIntervalMs);
  nextWebSocketReconcileAt =
    startedAt + websocketReconcileIntervalMs + websocketReconcileJitter();
  nextWebSocketControlRefreshAt =
    startedAt + websocketControlRefreshIntervalMs + websocketControlRefreshJitter();
  const inboundQueue = new ExpiringInboundQueue(now);

  if (watermarks?.load) {
    try {
      await watermarks.load();
    } catch (err) {
      logWarn(
        log,
        `[clawbits/${account.accountId}] watermark store load failed: ${String((err as Error)?.message ?? err)} — backlog runs untrimmed`,
      );
    }
  }

  // Catch-up durability rests on this file, and every way it can fail is
  // silent: writes are swallowed, and the gateway's cwd is not a reef
  // persistent volume. Say where it landed and whether we found anything, so
  // "the fix is a no-op on this VM" is one grep away.
  logInfo(
    log,
    `[clawbits/${account.accountId}] cursor store: path=${watermarks?.path ?? "(none)"} existing=${watermarks?.loadedExisting ?? false} catchUp=${catchUpEnabled}`,
  );

  if (!account.agentId) {
    logWarn(log, `[clawbits/${account.accountId}] inbound poller: no agentId; exiting`);
    return;
  }

  const fallbackChannelId = account.channelId;
  consoleErrorWithFile(
    `[clawbits/${account.accountId}] inbound poller started; fallback channel ${String(fallbackChannelId ?? "(none)")}; mention token ${String(mentionToken)}; fallback poll ${pollMs}ms; ws reconcile ${websocketReconcileIntervalMs}ms; ws control refresh ${websocketControlRefreshIntervalMs}ms`,
  );
  logInfo(
    log,
    `[clawbits/${account.accountId}] inbound poller started; fallback channel ${String(fallbackChannelId ?? "(none)")}; fallback poll ${pollMs}ms; ws reconcile ${websocketReconcileIntervalMs}ms; ws control refresh ${websocketControlRefreshIntervalMs}ms`,
  );

  // --- Durable resume cursor -------------------------------------------------
  // The store's bare-channel-id key means "history already SHOWN as context"
  // and is only written for shared channels — a DM never gets one. This second
  // key means "a turn for this post finished, or we refused it", and is written
  // for every channel. Same namespacing trick as the
  // email poller's `EMAIL_WATERMARK_CHANNEL`.
  const cursorKey = (channelId: string): string => `cursor:${channelId}`;

  const persistCursor = (channelId: string, createAt: number): void => {
    if (!Number.isFinite(createAt) || createAt <= 0) return;
    watermarks?.set(account.accountId, cursorKey(channelId), createAt);
  };

  // --- Server read-pointer ack ---------------------------------------------
  // The durable twin of `persistCursor`, in server units: `POST .../read`
  // advances this agent's `last_read_post_id`, which the next boot reads
  // back off the channel listing and drains from (`after_post_id`). Unlike
  // the local file it survives recreates and image upgrades. "Settled"
  // semantics: call sites are turn completion and catch-up's
  // nothing-addressable case — never observation or a transient refusal.
  const ackedByChannel = new Map<string, number>();
  let serverAckSupported = true;
  const ackRead = (channelId: string, postSerial: number): void => {
    if (!serverAckSupported) return;
    if (!Number.isFinite(postSerial) || postSerial <= 0) return;
    const previous = ackedByChannel.get(channelId) ?? 0;
    if (postSerial <= previous) return;
    // Claim before the async call so concurrent settles don't double-send;
    // rolled back on a non-404 failure so a later settle retries.
    ackedByChannel.set(channelId, postSerial);
    void mmTools.markChannelRead(client, channelId, postSerial).catch((err) => {
      if (err instanceof ClawBitsError && err.statusCode === 404) {
        serverAckSupported = false;
        logInfo(
          log,
          `[clawbits/${account.accountId}] server has no read-pointer endpoint; falling back to local watermarks only`,
        );
        return;
      }
      if (ackedByChannel.get(channelId) === postSerial) {
        ackedByChannel.set(channelId, previous);
      }
      logWarn(
        log,
        `[clawbits/${account.accountId}] read-pointer ack failed for ${channelId}: ${String((err as Error)?.message ?? err)}`,
      );
    });
  };

  /** Serial of a post as the server knows it, or 0 when unparseable (the
   *  ack path treats 0 as "nothing to ack"). Post ids on the agent API are
   *  integer serials serialised into `id` by `normalizePost`. */
  const postSerialOf = (post: MattermostPost): number => {
    const serial = Number(post.id);
    return Number.isFinite(serial) && serial > 0 ? Math.floor(serial) : 0;
  };

  /** Raise a channel's live cursor, and unless told otherwise its durable one.
   *  In-memory means "claimed" (taken before the turn, so a concurrent SSE/WS
   *  delivery can't double-enter); durable means "the turn settled". A kill
   *  between the two re-delivers on the next boot, which is what we want. */
  const advanceCursor = (channelId: string, createAt: number, persist = true): void => {
    if (!Number.isFinite(createAt)) return;
    if (createAt > cursorFor(channelId)) cursors.set(channelId, createAt);
    if (persist) persistCursor(channelId, createAt);
  };

  /** Raise BOTH gates. `cursors` gates the poll path, `reconcileFloors` the
   *  reconcile path; they are independent and production normally takes the
   *  reconcile one, so moving only one leaves the other open.
   *
   *  IN-MEMORY ONLY, deliberately: a clamp is burst suppression for this
   *  process, not proof anything settled. The durable pointers (local
   *  watermark + server ack) advance only on turn settle or a permanent
   *  classification — that gap is exactly what re-delivers a clamped-past
   *  post on the next boot. */
  const clampChannelFloors = (channelId: string, createAt: number): void => {
    if (!Number.isFinite(createAt)) return;
    advanceCursor(channelId, createAt, false);
    const floor = reconcileFloors.get(channelId) ?? startedAt;
    if (createAt > floor) reconcileFloors.set(channelId, createAt);
  };

  /** How far back catch-up may look here. Deliberately NOT what `cursorFor`
   *  seeds: live floors always start at `now()`, and catch-up opens the gate
   *  only for the single post it replays. Seeding the map low would leave a low
   *  floor behind on every path that skips catch-up (failed control fetch,
   *  abort, blown budget), and the ordinary poll would then drain the backlog
   *  one turn per post. */
  const resumeFloorFor = (channelId: string): number => {
    if (opts.initialCursor !== undefined) return opts.initialCursor;
    const persisted = watermarks?.get(account.accountId, cursorKey(channelId));
    const window = persisted === undefined ? COLD_CATCH_UP_WINDOW_MS : CATCH_UP_WINDOW_MS;
    const windowFloor = startedAt - window;
    return persisted === undefined ? windowFloor : Math.max(persisted, windowFloor);
  };

  // `cursorFor` is the lazy seeder for a channel first seen at ANY point in the
  // process lifetime — the first control refresh, but equally a `channel.added`
  // event hours later. It always seeds at the current clock, so being added to
  // an existing busy room never replays that room's history.
  const cursorFor = (channelId: string): number => {
    const existing = cursors.get(channelId);
    if (existing !== undefined) return existing;
    const floor = opts.initialCursor ?? now();
    cursors.set(channelId, floor);
    reconcileFloors.set(channelId, floor);
    return floor;
  };

  const rebuildDiscoveredChannels = (channels: DiscoveredChannel[]): void => {
    channelTypes.clear();
    for (const channel of channels) {
      channelTypes.set(channel.id, channel.channelType);
      cursorFor(channel.id);
    }
  };

  // Read-state fields are null here on purpose: they are only trustworthy
  // fresh off a control payload, and null routes catch-up to its safe
  // (legacy) branch rather than acting on stale pointers.
  const discoveredFromChannelTypes = (): DiscoveredChannel[] =>
    [...channelTypes.entries()].map(([id, channelType]) => ({
      id,
      channelType,
      latestPostId: null,
      lastReadPostId: null,
    }));

  const channelSetKey = (channels: DiscoveredChannel[]): string =>
    channels.map((channel) => channel.id).sort().join("\0");

  const applyControlPayload = (raw: unknown): DiscoveredChannel[] => {
    const channels = extractChannels(raw);
    rebuildDiscoveredChannels(channels);
    interAgentMode = extractInterAgentMode(raw) ?? (account.interAgentMode === true);
    interAgentMessageLimit =
      extractInterAgentMessageLimit(raw) ??
      clampInterAgentMessageLimit(account.interAgentMessageLimit);
    agentSnoozed = extractAgentSnoozed(raw) ?? false;
    return channels;
  };

  const mergeDiscoveredChannels = (channels: DiscoveredChannel[]): void => {
    if (channels.length === 0) return;
    const merged = new Map(channelTypes);
    for (const channel of channels) {
      merged.set(channel.id, channel.channelType);
      cursorFor(channel.id);
    }
    rebuildDiscoveredChannels(
      [...merged.entries()].map(([id, channelType]) => ({
        id,
        channelType,
        latestPostId: null,
        lastReadPostId: null,
      })),
    );
  };

  const removeDiscoveredChannel = (channelId: string): void => {
    channelTypes.delete(channelId);
    cursors.delete(channelId);
    reconcileFloors.delete(channelId);
  };

  const dropQueuedPost = (
    channelId: string,
    post: MattermostPost,
    source: InboundSource,
    reason: "agent snoozed" | "queue expired",
    enqueuedAt: number,
  ): void => {
    const waitedMs = Math.max(0, now() - enqueuedAt);
    if (isUserAuthoredPost(post) && !seen.has(post.id)) rememberSeen(seen, post.id);
    const postCreateAt = post.create_at ?? 0;
    // TRANSIENT abandonment: claim in memory so this process doesn't retry,
    // but leave the durable cursor (and the server pointer) behind it — a
    // message that aged out because a long turn held the lane, or landed in
    // a snooze window, should re-deliver on the next boot, not vanish.
    advanceCursor(channelId, postCreateAt, false);
    const message =
      reason === "queue expired"
        ? `[clawbits/${account.accountId}] inbound queue expired ${post.id}: source=${source} channel=${channelId} waited=${waitedMs}ms ttl=${inboundQueueTtlMs}ms`
        : `[clawbits/${account.accountId}] inbound skip ${post.id}: agent snoozed`;
    if (reason === "queue expired") logWarn(log, message);
    else logDebug(log, message);
  };

  const enqueueInbound = (
    channelId: string,
    channelType: string | null,
    post: MattermostPost,
    source: InboundSource,
    awaitDispatch: boolean,
    forceAttention = false,
    contextOverride?: InboundContextPost[],
  ): Promise<void> => {
    const enqueuedAt = now();
    if (agentSnoozed) {
      dropQueuedPost(channelId, post, source, "agent snoozed", enqueuedAt);
      return Promise.resolve();
    }
    return inboundQueue.enqueue({
      id: post.id,
      enqueuedAt,
      expiresAt: enqueuedAt + inboundQueueTtlMs,
      run: async () => {
        if (agentSnoozed) {
          dropQueuedPost(channelId, post, source, "agent snoozed", enqueuedAt);
          return;
        }
        await processPost(
          channelId,
          channelType,
          post,
          source,
          awaitDispatch,
          forceAttention,
          contextOverride,
        );
      },
      expire: () => dropQueuedPost(channelId, post, source, "queue expired", enqueuedAt),
    });
  };

  const postHumanGuidanceNotice = async (channelId: string, post: MattermostPost): Promise<void> => {
    const senderTag = senderTagForPost(post);
    const message = senderTag ? `${senderTag} ${HUMAN_GUIDANCE_MESSAGE}` : HUMAN_GUIDANCE_MESSAGE;
    try {
      await withChallenge(client, answers, (ans) =>
        mmTools.postToChannel(
          client,
          channelId,
          {
            message,
            ...(post.trace_id ? { trace_id: post.trace_id } : {}),
          },
          ans,
        ),
      );
    } catch (err) {
      logWarn(
        log,
        `[clawbits/${account.accountId}] failed to post human-guidance pause notice in ${channelId}: ${String((err as Error)?.message ?? err)}`,
      );
    }
  };

  /** Dispatch one turn. Returns whether it SETTLED (ran to completion) —
   *  the callers gate the durable cursor and the server ack on this, so a
   *  crashed/failed turn re-delivers on the next boot instead of being
   *  silently burned past. */
  const dispatchMessage = async (msg: InboundMessage): Promise<boolean> => {
    try {
      logInfo(
        log,
        `[clawbits/${account.accountId}] inbound dispatch ${msg.postId} from ${msg.senderId || "unknown"} on ${msg.channelId}: ${JSON.stringify(msg.text)}`,
      );
      await opts.onInboundMessage(msg);
      return true;
    } catch (err) {
      logError(
        log,
        `[clawbits/${account.accountId}] inbound dispatch failed for ${msg.postId}: ${String(err)}`,
      );
      return false;
    }
  };

  async function processPost(
    channelId: string,
    channelType: string | null,
    post: MattermostPost,
    source: InboundSource,
    awaitDispatch: boolean,
    forceAttention = false,
    contextOverride?: InboundContextPost[],
  ): Promise<void> {
    if (post.create_at == null) return;
    if (post.delete_at && post.delete_at > 0) return;
    const cursor = cursorFor(channelId);
    const postCreateAt = post.create_at;
    const isSeen = seen.has(post.id);
    const reconcileFloor = reconcileFloors.get(channelId) ?? cursorFor(channelId);
    if (source === "poll" && postCreateAt <= cursor) return;
    if (source === "reconcile" && postCreateAt <= reconcileFloor) return;
    if (source === "reconcile" && isSeen) return;
    const isUserPost = isUserAuthoredPost(post);
    if (agentSnoozed) {
      if (isUserPost && !isSeen) rememberSeen(seen, post.id);
      // In-memory only: snooze is transient, and the durable pointer staying
      // put is what re-delivers the post after a restart. The unsnooze
      // branch in the main loop decides whether the snoozed backlog is
      // durably discarded.
      advanceCursor(channelId, postCreateAt, false);
      logDebug(
        log,
        `[clawbits/${account.accountId}] inbound skip ${post.id}: agent snoozed`,
      );
      return;
    }
    const isSelfAuthored = Boolean(
      account.agentId && (post.agent_id === account.agentId || post.user_id === account.agentId),
    );
    const isAgentAuthored = Boolean(post.agent_id);
    const senderId = senderIdForPost(post);
    const senderAllowKeys = [senderId];
    if (senderId && !senderId.includes(":")) {
      senderAllowKeys.push(`human:${senderId}`, `agent:${senderId}`);
    }
    const senderAllowed = interAgentMode || !isAgentAuthored;
    const senderAllowedByAllowFrom =
      allowFromSet.size === 0 || senderAllowKeys.some((key) => allowFromSet.has(key));
    const postChannelId = post.channel_id ?? channelId;
    const hasMention = account.agentId ? hasAgentMention(post.message ?? "", account.agentId) : false;
    const humanTaggedThisAgent = isUserPost && !isSelfAuthored && !isAgentAuthored && hasMention;
    if (humanTaggedThisAgent) {
      if (awaitingHumanGuidance || consecutiveAgentTurns > 0) {
        logInfo(
          log,
          `[clawbits/${account.accountId}] human tagged ${account.agentId}; resetting inter-agent guidance pause/counter`,
        );
      }
      consecutiveAgentTurns = 0;
      awaitingHumanGuidance = false;
      guidanceNoticeSent = false;
    }

    const isDirectChannel = channelType === "direct";
    const isFallbackOperatorChannel = Boolean(
      fallbackChannelId && postChannelId === fallbackChannelId && channelType === null,
    );
    // `forceAttention` is the server-side LobsterTalk gate saying "look at this
    // post even though nobody tagged you"; it makes an un-mentioned channel
    // post dispatch like an addressed one. The remaining gates (user-authored,
    // not self, allowFrom, not already seen) still apply. Non-addressed posts
    // are never marked seen, so this can't double-fire against `post.created`.
    const isAddressedToAgent =
      hasMention || isDirectChannel || isFallbackOperatorChannel || forceAttention;
    // `/cb-usage` is a DM-only command answered server-side; elsewhere it's a
    // normal message and must still reach the model.
    const isServerCommand = isDirectChannel && isServerHandledCommand(post.message);
    const wouldDispatchWithoutAllowFrom =
      !isSeen &&
      isUserPost &&
      !isSelfAuthored &&
      senderAllowed &&
      isAddressedToAgent &&
      !isServerCommand;
    if (wouldDispatchWithoutAllowFrom && !senderAllowedByAllowFrom) {
      rememberSeen(seen, post.id);
      // In-memory only: the allowlist is operator-editable, so this refusal
      // is transient — an added sender's backlog should surface on the next
      // boot instead of having been silently burned past.
      advanceCursor(channelId, postCreateAt, false);
      logWarn(
        log,
        `[clawbits/${account.accountId}] inbound blocked by allowFrom sender=${senderId || "(unknown)"} post=${post.id} channel=${postChannelId}`,
      );
      return;
    }
    const shouldDispatch = wouldDispatchWithoutAllowFrom && senderAllowedByAllowFrom;

    if (shouldDispatch && isAgentAuthored) {
      if (awaitingHumanGuidance || consecutiveAgentTurns >= interAgentMessageLimit) {
        awaitingHumanGuidance = true;
        rememberSeen(seen, post.id);
        advanceCursor(channelId, postCreateAt);
        if (!guidanceNoticeSent) {
          guidanceNoticeSent = true;
          logWarn(
            log,
            `[clawbits/${account.accountId}] pausing inter-agent replies after ${consecutiveAgentTurns} consecutive agent turn(s); limit=${interAgentMessageLimit}; waiting for a human @${account.agentId} tag`,
          );
          await postHumanGuidanceNotice(postChannelId, post);
        } else {
          logDebug(
            log,
            `[clawbits/${account.accountId}] inbound skip ${post.id}: inter-agent replies paused until human tags @${account.agentId}`,
          );
        }
        return;
      }
      consecutiveAgentTurns += 1;
    }

    if (!shouldDispatch) {
      logDebug(
        log,
        `[clawbits/${account.accountId}] inbound skip ${post.id}: source=${source} seen=${isSeen} userPost=${isUserPost} self=${isSelfAuthored} agentAuthored=${isAgentAuthored} interAgentMode=${interAgentMode} senderAllowed=${senderAllowed} allowFrom=${allowFromSet.size > 0 ? "restricted" : "off"} allowFromMatch=${senderAllowedByAllowFrom} hasMention=${hasMention} fallbackOperatorChannel=${isFallbackOperatorChannel} addressed=${isAddressedToAgent} serverCommand=${isServerCommand} type=${post.type ?? ""}`,
      );
      advanceCursor(channelId, postCreateAt);
      return;
    }

    // Claim before optional backlog fetch / model dispatch. SSE and safety
    // polling can observe the same post; early claim prevents double runs.
    rememberSeen(seen, post.id);

    // Trace span: how long the post sat between server-side creation
    // (``create_at``) and the agent picking it up here. Surfaces poll-cadence
    // vs SSE delivery lag — the gap that's otherwise invisible because each
    // subsystem only times its own work. (Cross-machine clock skew applies to
    // this cross-process delta; on one host it's exact.) Fires once per
    // claimed inbound, tagged with the delivery ``source`` so poll and SSE
    // pickups are distinguishable.
    const pickedUpAt = Date.now();
    writeTraceSpan({
      trace_id: post.trace_id ?? null,
      span: "plugin.pickup_lag",
      subsystem: "plugin",
      dur_ms: pickedUpAt - postCreateAt,
      t_start_ms: postCreateAt,
      t_end_ms: pickedUpAt,
      account_id: account.accountId,
      channel_id: channelId,
      inbound_post_id: post.id,
      source,
    });

    let priorContext: InboundContextPost[] | undefined;
    // Catch-up supplies its own context and already paid for the fetch. Skip
    // the `channelEligible` branch — it excludes direct channels, so a DM could
    // not otherwise carry catch-up context at all — but still advance the
    // "shown" watermark so the next mention doesn't re-inject the same history.
    const channelEligible =
      !contextOverride && backlog > 0 && !isDirectChannel && !isFallbackOperatorChannel;
    if (contextOverride) {
      if (contextOverride.length > 0) priorContext = contextOverride;
      if (!isDirectChannel && !isFallbackOperatorChannel) {
        watermarks?.set(account.accountId, channelId, postCreateAt);
      }
    }
    logDebug(
      log,
      `[clawbits/${account.accountId}] backlog eligibility for ${post.id} in ${channelId}: backlog=${backlog} isDirect=${isDirectChannel} isFallbackOperator=${isFallbackOperatorChannel} → eligible=${channelEligible}`,
    );
    if (channelEligible) {
      const watermark = watermarks?.get(account.accountId, channelId) ?? 0;
      try {
        const historyRaw = await mmTools.getChannelPosts(client, channelId, backlog + 1);
        const history = parsePostsResponse(historyRaw);
        const ctx = buildPriorContext(
          history,
          post.id,
          postCreateAt,
          backlog,
          account.agentId,
          watermark,
          interAgentMode,
        );
        if (ctx.length > 0) priorContext = ctx;
        logDebug(
          log,
          `[clawbits/${account.accountId}] gathered ${ctx.length} backlog post(s) since watermark=${watermark} for mention ${post.id} in ${channelId}`,
        );
      } catch (err) {
        logWarn(
          log,
          `[clawbits/${account.accountId}] backlog fetch failed for ${channelId}: ${String((err as Error)?.message ?? err)} — dispatching without context`,
        );
      }
      watermarks?.set(account.accountId, channelId, postCreateAt);
    }

    // Reply-tagging addresses the right participant in a multi-party (inter-
    // agent) channel. In a 1:1 DM there's only one counterpart, so prefixing
    // every reply with their handle is noise — skip it in direct channels.
    const senderTag = interAgentMode && !isDirectChannel ? senderTagForPost(post) : undefined;
    const msg: InboundMessage = {
      accountId: account.accountId,
      channelId: postChannelId,
      postId: post.id,
      senderId,
      ...(senderTag ? { senderTag } : {}),
      text: collapseSelfMentions(post.message ?? "", account.agentId),
      files: post.files ?? [],
      channelType,
      ...(priorContext ? { priorContext } : {}),
      ...(post.trace_id ? { traceId: post.trace_id } : {}),
      ...(forceAttention ? { attention: true } : {}),
      ...(contextOverride ? { catchUp: true } : {}),
      createAt: postCreateAt,
      raw: post,
    };
    // Claim in memory before the turn; persist + ack only once it SETTLES.
    // A dispatch failure leaves both durable pointers behind the post, so
    // the next boot re-delivers it (bounded: one catch-up turn per channel).
    advanceCursor(channelId, postCreateAt, false);

    const settle = (ok: boolean): void => {
      if (!ok) return;
      persistCursor(channelId, postCreateAt);
      ackRead(channelId, postSerialOf(post));
    };
    const task = dispatchMessage(msg);
    if (awaitDispatch) {
      settle(await task);
    } else {
      void task.then(settle);
    }
  }

  const stopSse = (reason: string): void => {
    for (const [channelId, state] of sseChannels) {
      logDebug(log, `[clawbits/${account.accountId}] closing SSE for ${channelId}: ${reason}`);
      state.abort.abort();
    }
  };

  const stopAgentWebSocket = (reason: string): void => {
    if (!agentWsAbort) return;
    logDebug(log, `[clawbits/${account.accountId}] closing agent WebSocket: ${reason}`);
    agentWsAbort.abort();
  };

  const handleRealtimePostEvent = (event: SseEnvelope, source: "sse" | "ws"): void => {
    if (event.type !== "post.created") return;
    const raw = event.data;
    if (!raw || typeof raw !== "object") return;
    const post = normalizePost(raw as Record<string, unknown>);
    if (!post) return;
    const channelId = event.channel_id ?? post.channel_id ?? fallbackChannelId;
    if (!channelId) return;
    void enqueueInbound(
      channelId,
      channelTypes.get(channelId) ?? null,
      post,
      source,
      true,
    ).catch((err) => {
      logWarn(
        log,
        `[clawbits/${account.accountId}] queued ${source.toUpperCase()} dispatch failed for ${post.id}: ${String((err as Error)?.message ?? err)}`,
      );
    });
  };

  const handleAttentionNudge = (event: SseEnvelope): void => {
    // A `lobstertalk.consider` control event carries the same post payload as
    // `post.created`; dispatch it as an attention nudge so the agent considers
    // a message it wasn't tagged in (and is prompted to reply only if useful).
    const raw = event.data;
    if (!raw || typeof raw !== "object") return;
    const post = normalizePost(raw as Record<string, unknown>);
    if (!post) return;
    const channelId = event.channel_id ?? post.channel_id ?? fallbackChannelId;
    if (!channelId) return;
    void enqueueInbound(
      channelId,
      channelTypes.get(channelId) ?? null,
      post,
      "ws",
      true,
      true,
    ).catch((err) => {
      logWarn(
        log,
        `[clawbits/${account.accountId}] LobsterTalk nudge dispatch failed for ${post.id}: ${String((err as Error)?.message ?? err)}`,
      );
    });
  };

  const startAgentWebSocket = (): void => {
    if (
      !websocketEnabled ||
      agentWsTask ||
      agentWsDisabledUntil > now() ||
      abortSignal.aborted ||
      agentSnoozed ||
      !account.apiKey
    ) {
      return;
    }
    const wsAbort = new AbortController();
    const abortWs = () => wsAbort.abort();
    abortSignal.addEventListener("abort", abortWs, { once: true });
    logInfo(log, `[clawbits/${account.accountId}] opening agent WebSocket`);
    agentWsAbort = wsAbort;
    agentWsTask = consumeAgentWebSocketEvents({
      client,
      apiKey: account.apiKey,
      abortSignal: wsAbort.signal,
      onOpen: () => {
        agentWsConnected = true;
        forceReconcilePoll = true;
        scheduleNextWebSocketControlRefresh();
        stopSse("agent WebSocket connected");
        // An automation.sync nudge only rides this socket, so any desired-state
        // change made while it was down was missed. Reconcile now instead of
        // waiting for the reconciler's next poll.
        wakeAutomationsReconciler(account.accountId);
        logInfo(log, `[clawbits/${account.accountId}] agent WebSocket connected`);
      },
      onEvent: (event) => {
        if (event.type === "snapshot") {
          applyControlPayload(event.data);
          forceReconcilePoll = true;
          scheduleNextWebSocketControlRefresh();
          return;
        }
        if (event.type === "channel.added") {
          const rawChannel = event.data ??
            (event.channel_id ? { channel_id: event.channel_id } : null);
          const added = extractChannels([rawChannel]);
          mergeDiscoveredChannels(added);
          forceReconcilePoll = true;
          return;
        }
        if (event.type === "channel.removed") {
          const channelId = event.channel_id;
          if (channelId) removeDiscoveredChannel(channelId);
          forceReconcilePoll = true;
          return;
        }
        if (event.type === "resync_required") {
          forceReconcilePoll = true;
          return;
        }
        if (event.type === "automation.sync") {
          // Operator changed this agent's desired automations — wake the
          // reconciler so it converges near-instantly instead of on the timer.
          wakeAutomationsReconciler(account.accountId);
          return;
        }
        // `mutualist.consider` is the pre-rename name for the same event; kept
        // so an agent on this build still gets nudges from a server that hasn't
        // been redeployed yet. Drop once every server speaks `lobstertalk.*`.
        if (
          event.type === "lobstertalk.consider" ||
          event.type === "mutualist.consider"
        ) {
          // Server-side attention gate flagged a post this agent wasn't tagged
          // in; dispatch it as an attention nudge (reply only if useful).
          handleAttentionNudge(event);
          return;
        }
        handleRealtimePostEvent(event, "ws");
      },
    })
      .catch((err) => {
        if (!abortSignal.aborted && !wsAbort.signal.aborted) {
          agentWsDisabledUntil = now() + 60_000;
          forceReconcilePoll = true;
          logWarn(
            log,
            `[clawbits/${account.accountId}] agent WebSocket stopped: ${String((err as Error)?.message ?? err)}; SSE/polling fallback remains active`,
          );
        }
      })
      .finally(() => {
        abortSignal.removeEventListener("abort", abortWs);
        if (agentWsAbort === wsAbort) agentWsAbort = undefined;
        agentWsTask = undefined;
        agentWsConnected = false;
      });
  };

  const startSse = (channel: DiscoveredChannel): void => {
    if (
      sseChannels.has(channel.id) ||
      abortSignal.aborted ||
      agentSnoozed ||
      agentWsConnected ||
      (websocketEnabled && agentWsTask && agentWsDisabledUntil <= now())
    ) {
      return;
    }
    logInfo(log, `[clawbits/${account.accountId}] opening SSE for ${channel.id}`);
    const sseAbort = new AbortController();
    const abortSse = () => sseAbort.abort();
    abortSignal.addEventListener("abort", abortSse, { once: true });
    const task = consumeChannelEvents({
      client,
      channelId: channel.id,
      abortSignal: sseAbort.signal,
      onEvent: (event) => handleRealtimePostEvent(event, "sse"),
    })
      .catch((err) => {
        if (!abortSignal.aborted && !sseAbort.signal.aborted) {
          logWarn(
            log,
            `[clawbits/${account.accountId}] SSE stopped for ${channel.id}: ${String((err as Error)?.message ?? err)}; polling fallback remains active`,
          );
        }
      })
      .finally(() => {
        abortSignal.removeEventListener("abort", abortSse);
        sseChannels.delete(channel.id);
      });
    sseChannels.set(channel.id, { channelType: channel.channelType, task, abort: sseAbort });
  };

  const scheduleNextWebSocketReconcile = (): void => {
    nextWebSocketReconcileAt = now() + websocketReconcileIntervalMs + websocketReconcileJitter();
  };

  const scheduleNextWebSocketControlRefresh = (): void => {
    nextWebSocketControlRefreshAt =
      websocketControlRefreshIntervalMs > 0
        ? now() + websocketControlRefreshIntervalMs + websocketControlRefreshJitter()
        : Number.POSITIVE_INFINITY;
  };

  /** Page the server's forward cursor from `fromSerial`: every post that
   *  arrived after that serial, oldest first, bounded by
   *  `MAX_CATCH_UP_PAGES`. `overflowed` means the gap may extend further. */
  const drainGap = async (
    channelId: string,
    fromSerial: number,
  ): Promise<{ posts: MattermostPost[]; overflowed: boolean }> => {
    const collected: MattermostPost[] = [];
    let after = fromSerial;
    for (let page = 0; page < MAX_CATCH_UP_PAGES; page += 1) {
      const raw = await mmTools.getChannelPosts(client, channelId, CATCH_UP_PAGE_SIZE, after);
      const posts = parsePostsResponse(raw);
      collected.push(...posts);
      if (posts.length < CATCH_UP_PAGE_SIZE) return { posts: collected, overflowed: false };
      after = posts.reduce((max, p) => Math.max(max, postSerialOf(p)), after);
    }
    return { posts: collected, overflowed: true };
  };

  /**
   * One-shot boot catch-up: answer what arrived while the gateway was down.
   *
   * Runs after the first control payload lands (so `agentSnoozed` is real) and
   * before the WebSocket starts (so live traffic can't interleave ahead of the
   * backlog).
   *
   * Two modes per channel:
   *  - SERVER-CURSOR (the channel payload carries `last_read_post_id`): drain
   *    `after_post_id` pages — the exact offline gap, no look-back window, no
   *    clock math, immune to a wiped state file. The pointer advances only
   *    when the replayed turn settles (or nothing was addressable), so a
   *    crash mid-catch-up retries on the next boot.
   *  - LEGACY (no pointer): the previous behavior — newest-50 page trimmed by
   *    the persisted-watermark/window floor, with the clock-skew canary. Its
   *    completion acks too, so a legacy agent upgrades itself to
   *    server-cursor mode on its next restart.
   *
   * ONE turn per channel by design: dispatch is serial at three layers (this
   * queue, the session lock in inbound-dispatch-guard, OpenClaw's per-session
   * lane), so N turns would take minutes and start expiring against the queue
   * TTL. Newest addressed post is the trigger; older ones ride as context.
   */
  const runCatchUp = async (discovered: DiscoveredChannel[]): Promise<void> => {
    const deadline = now() + MAX_CATCH_UP_MS;
    let turnsSpent = 0;
    let recovered = 0;

    for (const channel of discovered) {
      if (abortSignal.aborted) return;
      const { id: channelId, channelType } = channel;
      if (turnsSpent >= MAX_CATCH_UP_TURNS || now() >= deadline) {
        // Out of budget. Floors keep their now()-seeds (burst-safe), the
        // durable pointers stay put, and the next boot retries this channel.
        clampChannelFloors(channelId, now());
        continue;
      }

      const serverMode = channel.lastReadPostId != null;
      // Quiet channel, zero fetches: the pointer already covers the newest
      // post. Only trustable when the payload carries both serials.
      if (
        serverMode &&
        channel.latestPostId != null &&
        channel.latestPostId <= (channel.lastReadPostId as number)
      ) {
        continue;
      }

      // Every exit from here MUST clamp (in-memory), or the lowered floor is
      // picked up by the next reconcile pass as the per-post burst this
      // function avoids.
      let clampTo = now();
      try {
        let posts: MattermostPost[];
        let resume: number;
        if (serverMode) {
          const gap = await drainGap(channelId, channel.lastReadPostId as number);
          posts = gap.posts;
          if (gap.overflowed) {
            // The gap outran the page budget. Prioritise the newest traffic
            // — answering this week's messages beats faithfully replaying
            // last week's — and log the truncation instead of pretending
            // the middle never happened.
            logWarn(
              log,
              `[clawbits/${account.accountId}] catch-up gap in ${channelId} exceeds ${posts.length} post(s); skipping the oldest part`,
            );
            posts = parsePostsResponse(await mmTools.getChannelPosts(client, channelId));
          }
          // Everything drained is strictly after the acked pointer, so the
          // whole fetch is unread by definition. No settled-self-post clamp
          // here: the ack is the settle marker in this mode, and clamping on
          // self posts would let a boot-time automation delivery bury the
          // very gap being recovered (the D8 race).
          resume = 0;
        } else {
          posts = parsePostsResponse(await mmTools.getChannelPosts(client, channelId));
          if (posts.length > 0) {
            const newestInPage = posts[posts.length - 1]?.create_at ?? 0;
            clampTo = Math.max(clampTo, newestInPage);
            // Clock-skew canary (legacy only — a serial cursor has no clock
            // to skew): the window floor is VM-local, every `create_at` is
            // server-issued, and the reef image has no NTP. Only "VM behind"
            // is detectable; refuse rather than look back by skew + window.
            // In-memory clamp only: the durable pointer stays put, so the
            // next boot (or an upgraded server) retries instead of the old
            // behavior of durably burning past what it refused to read.
            const skew = now() - newestInPage;
            if (newestInPage > 0 && skew < -MAX_CATCH_UP_CLOCK_SKEW_MS) {
              logWarn(
                log,
                `[clawbits/${account.accountId}] catch-up skipped for ${channelId}: VM clock is ${Math.round(-skew / 1000)}s behind the newest server post — refusing to guess a look-back window`,
              );
              continue;
            }
          }
          resume = Math.max(
            resumeFloorFor(channelId),
            ...posts.filter((p) => isSettledSelfPost(p, account.agentId)).map((p) => p.create_at),
          );
        }
        if (posts.length === 0) continue;
        const newestCreateAt = posts[posts.length - 1]?.create_at ?? 0;
        clampTo = Math.max(clampTo, newestCreateAt);
        const newestSerial = posts.reduce((max, p) => Math.max(max, postSerialOf(p)), 0);

        const pending = posts.filter(
          (p) =>
            p.create_at > resume &&
            !(p.delete_at && p.delete_at > 0) &&
            isUserAuthoredPost(p) &&
            // Human-authored only (also excludes our own echoes): replaying
            // agent traffic would reset every agent's inter-agent throttle at
            // the same instant across a fleet roll.
            !p.agent_id &&
            p.user_id !== account.agentId,
        );
        if (pending.length === 0) {
          // Examined, nothing pending: a permanent classification, so the
          // pointer may advance — this is also what creates the pointer for
          // legacy agents and stops the same gap being re-drained every boot.
          ackRead(channelId, newestSerial);
          continue;
        }

        const isDirect = channelType === "direct";
        // Mirrors processPost's operator test exactly (channelType === null):
        // a typed non-direct operator channel must NOT pick an un-mentioned
        // trigger here that processPost will then refuse as not-addressed —
        // that mismatch used to drop the recovered message AND burn the
        // cursor past it.
        const isOperator = Boolean(
          fallbackChannelId && channelId === fallbackChannelId && channelType === null,
        );
        const addressed = pending.filter(
          (p) =>
            isDirect ||
            isOperator ||
            (account.agentId ? hasAgentMention(p.message ?? "", account.agentId) : false),
        );
        if (addressed.length === 0) {
          logInfo(
            log,
            `[clawbits/${account.accountId}] catch-up: ${pending.length} missed post(s) in ${channelId}, none addressed to this agent — skipping`,
          );
          // Same permanent classification as the empty-pending case. The
          // LobsterTalk rescue path is unaffected: nudges arrive over the
          // WS keyed on the post, gated by `seen` — never by this pointer.
          ackRead(channelId, newestSerial);
          continue;
        }

        const trigger = addressed[addressed.length - 1]!;
        const context = buildPriorContext(
          posts,
          trigger.id,
          trigger.create_at,
          CATCH_UP_CONTEXT_LIMIT,
          account.agentId,
          resume,
          interAgentMode,
        );

        // Open the gate just below the trigger so processPost will accept it,
        // then let the dispatch path claim it normally. The ack rides the
        // settle path inside processPost — never fired from here.
        cursors.set(channelId, trigger.create_at - 1);
        reconcileFloors.set(channelId, trigger.create_at - 1);

        turnsSpent += 1;
        recovered += pending.length;
        logInfo(
          log,
          `[clawbits/${account.accountId}] catch-up: replaying ${channelId} — trigger ${trigger.id}, ${context.length} message(s) of missed context, mode=${serverMode ? "server-cursor" : "legacy"}, resume=${serverMode ? channel.lastReadPostId : resume}`,
        );
        await enqueueInbound(channelId, channelType, trigger, "poll", true, false, context);
      } catch (err) {
        logWarn(
          log,
          `[clawbits/${account.accountId}] catch-up failed for ${channelId}: ${String((err as Error)?.message ?? err)} — clamping to now (retries next boot)`,
        );
      } finally {
        clampChannelFloors(channelId, clampTo);
      }
    }

    logInfo(
      log,
      `[clawbits/${account.accountId}] catch-up complete: ${turnsSpent} turn(s) over ${discovered.length} channel(s), ${recovered} missed message(s) surfaced`,
    );
  };

  const pollDiscoveredChannels = async (
    discovered: DiscoveredChannel[],
    source: "poll" | "reconcile",
  ): Promise<void> => {
    for (const { id: channelId, channelType } of discovered) {
      if (abortSignal.aborted) break;
      try {
        const raw = await mmTools.getChannelPosts(client, channelId);
        const posts = parsePostsResponse(raw);
        logDebug(
          log,
          `[clawbits/${account.accountId}] inbound ${source} fetched ${posts.length} post(s) from ${channelId}; cursor=${cursorFor(channelId)}`,
        );
        for (const post of posts) {
          if (abortSignal.aborted) break;
          await enqueueInbound(channelId, channelType, post, source, true);
        }
      } catch (err) {
        consoleErrorWithFile(
          `[clawbits/${account.accountId}] inbound ${source} failed for ${channelId}: ${String((err as Error)?.stack ?? (err as Error)?.message ?? err)}`,
        );
        logWarn(
          log,
          `[clawbits/${account.accountId}] inbound ${source} failed for ${channelId}: ${String((err as Error)?.message ?? err)}`,
        );
      }
    }
  };

  let catchUpPending = catchUpEnabled && opts.initialCursor === undefined;
  let catchUpDeferrals = 0;
  let controlPayloadOk = false;

  try {
    while (!abortSignal.aborted) {
      let discovered: DiscoveredChannel[] = discoveredFromChannelTypes();
      const wasSnoozed = agentSnoozed;
      const shouldRefreshControl =
        !agentWsConnected ||
        channelTypes.size === 0 ||
        (websocketControlRefreshIntervalMs > 0 && now() >= nextWebSocketControlRefreshAt);
      if (shouldRefreshControl) {
        try {
          const listed = await mmTools.listChannels(client);
          const beforeIds = channelSetKey(discovered);
          discovered = applyControlPayload(listed);
          controlPayloadOk = true;
          const afterIds = channelSetKey(discovered);
          if (agentWsConnected) {
            scheduleNextWebSocketControlRefresh();
          }
          if (agentWsConnected && beforeIds !== afterIds) {
            forceReconcilePoll = true;
            stopAgentWebSocket("channel set changed");
          }
        } catch (err) {
          if (agentWsConnected) {
            scheduleNextWebSocketControlRefresh();
          } else {
            interAgentMode = account.interAgentMode === true;
          }
          logWarn(
            log,
            `[clawbits/${account.accountId}] listChannels failed: ${String((err as Error)?.message ?? err)} — falling back to cached channels/single channel`,
          );
          discovered = discoveredFromChannelTypes();
        }
      }
      if (discovered.length === 0 && fallbackChannelId) {
        discovered = [
          { id: fallbackChannelId, channelType: null, latestPostId: null, lastReadPostId: null },
        ];
        rebuildDiscoveredChannels(discovered);
      }
      if (discovered.length === 0) {
        logDebug(log, `[clawbits/${account.accountId}] no channels to poll this tick`);
      }

      if (agentSnoozed) {
        stopAgentWebSocket("agent snoozed");
        stopSse("agent snoozed");
        if (!wasSnoozed) {
          logInfo(
            log,
            `[clawbits/${account.accountId}] agent snoozed; skipping SSE and post polling`,
          );
        }
        await sleepInterruptible(pollMs, abortSignal);
        continue;
      }

      if (wasSnoozed && !agentSnoozed) {
        if (catchUpPending) {
          // Snoozed since BOOT: the pending gap predates the snooze (it
          // accumulated while the process was down), so it is not "snoozed
          // backlog" — leave catch-up armed and let the pass below answer
          // it now that the agent is awake. This is what used to strand the
          // boot gap forever: the flag was cleared here before the pass
          // ever got to run.
          logInfo(
            log,
            `[clawbits/${account.accountId}] agent unsnoozed with boot catch-up still pending; running it now`,
          );
        } else {
          // Mid-life unsnooze: discard the snoozed backlog, and durably —
          // ack to the latest serial where known, so a restart right after
          // unsnoozing doesn't replay the pile the operator silenced.
          const resumeCursor = now();
          for (const channel of discovered) {
            clampChannelFloors(channel.id, resumeCursor);
            if (channel.latestPostId != null) ackRead(channel.id, channel.latestPostId);
          }
          logInfo(
            log,
            `[clawbits/${account.accountId}] agent unsnoozed; cursor advanced to skip snoozed backlog`,
          );
        }
      }

      // Gated on a real control payload: `agentSnoozed` starts false and is only
      // set by `applyControlPayload`, so running blind would let a snoozed agent
      // answer its backlog.
      if (catchUpPending) {
        if (!controlPayloadOk && catchUpDeferrals < MAX_CATCH_UP_DEFERRALS) {
          // Hold realtime startup too: starting the WebSocket/poll on this
          // tick would let a live settle ack past the gap before catch-up
          // ever reads it — the deferred-control race. Short retry sleep,
          // not the poll interval: this hold delays ALL message flow.
          catchUpDeferrals += 1;
          logWarn(
            log,
            `[clawbits/${account.accountId}] catch-up deferred (${catchUpDeferrals}/${MAX_CATCH_UP_DEFERRALS}): no control payload yet — holding realtime startup`,
          );
          await sleepInterruptible(Math.min(CATCH_UP_DEFERRAL_RETRY_MS, pollMs), abortSignal);
          continue;
        }
        catchUpPending = false;
        if (!controlPayloadOk) {
          logWarn(
            log,
            `[clawbits/${account.accountId}] catch-up proceeding without a control payload after ${catchUpDeferrals} deferral(s) — fallback channel set only`,
          );
        }
        try {
          await runCatchUp(discovered);
        } catch (err) {
          logWarn(
            log,
            `[clawbits/${account.accountId}] catch-up pass aborted: ${String((err as Error)?.message ?? err)}`,
          );
          for (const channel of discovered) clampChannelFloors(channel.id, now());
        }
        if (abortSignal.aborted) break;
      }

      startAgentWebSocket();

      if (websocketEnabled && agentWsTask && !agentWsConnected && agentWsDisabledUntil <= now()) {
        await Promise.race([
          sleepInterruptible(Math.min(1000, pollMs), abortSignal),
          agentWsTask.catch(() => undefined),
        ]);
        if (abortSignal.aborted) break;
        if (agentWsConnected) continue;
      }

      for (const channel of discovered) startSse(channel);

      const websocketHealthy = Boolean(
        websocketEnabled && agentWsConnected && agentWsDisabledUntil <= now(),
      );
      if (websocketHealthy) {
        const shouldReconcile =
          forceReconcilePoll ||
          (websocketReconcileIntervalMs > 0 && now() >= nextWebSocketReconcileAt);
        if (shouldReconcile) {
          forceReconcilePoll = false;
          scheduleNextWebSocketReconcile();
          await pollDiscoveredChannels(discovered, "reconcile");
        }
      } else {
        await pollDiscoveredChannels(discovered, "poll");
      }

      if (abortSignal.aborted) break;
      await sleepInterruptible(pollMs, abortSignal);
    }
  } finally {
    stopAgentWebSocket("poller stopped");
    for (const { task, abort } of sseChannels.values()) {
      abort.abort();
      void task.catch(() => undefined);
    }
    // The only other writer is a 1s unref'd debounce timer that must not hold
    // the process open, so without this a clean stop loses the last second.
    try {
      await watermarks?.flush?.();
    } catch (err) {
      logWarn(
        log,
        `[clawbits/${account.accountId}] watermark flush on shutdown failed: ${String((err as Error)?.message ?? err)}`,
      );
    }
    logInfo(log, `[clawbits/${account.accountId}] inbound poller stopped`);
  }
}

/** A channel discovered through `GET /api/agentic/mm/channels`. */
interface DiscoveredChannel {
  id: string;
  /** ``"direct"`` for 1:1 DMs, ``"public"`` / ``"private"`` for rooms.
   *  ``null`` when the listing didn't carry the field (older payloads,
   *  fallback-only path). The dispatch gate treats ``null`` like a
   *  non-direct channel, so a missing type doesn't accidentally make
   *  the agent auto-reply in a shared room. */
  channelType: string | null;
  /** Newest published post serial, or null when the channel is empty or the
   *  payload predates the field. With `lastReadPostId` this answers "did
   *  anything move while I was down" without a posts GET. */
  latestPostId: number | null;
  /** This agent's server-side read pointer (acked on turn settle), or null
   *  on servers that predate it / when the agent never acked. Null selects
   *  the legacy timestamp-window catch-up. */
  lastReadPostId: number | null;
}

function extractSerial(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

/**
 * Extract channels (id + type + read state) from `GET /api/agentic/mm/channels`.
 * Tolerates either a bare array or a `{ channels: [...] }` envelope.
 */
function extractChannels(raw: unknown): DiscoveredChannel[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    const out: DiscoveredChannel[] = [];
    for (const c of raw) {
      if (!c || typeof c !== "object") continue;
      const obj = c as {
        channel_id?: unknown;
        channel_type?: unknown;
        latest_post_id?: unknown;
        last_read_post_id?: unknown;
      };
      if (typeof obj.channel_id !== "string" || obj.channel_id.length === 0) continue;
      out.push({
        id: obj.channel_id,
        channelType: typeof obj.channel_type === "string" ? obj.channel_type : null,
        latestPostId: extractSerial(obj.latest_post_id),
        lastReadPostId: extractSerial(obj.last_read_post_id),
      });
    }
    return out;
  }
  if (typeof raw === "object") {
    const channels = (raw as { channels?: unknown }).channels;
    if (Array.isArray(channels)) return extractChannels(channels);
  }
  return [];
}

function clampInterAgentMessageLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return DEFAULT_CONSECUTIVE_AGENT_TURNS;
  }
  return Math.min(MAX_CONSECUTIVE_AGENT_TURNS, Math.floor(value));
}

function extractInterAgentMessageLimit(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const value = obj["inter_agent_message_limit"] ?? obj["interAgentMessageLimit"];
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return clampInterAgentMessageLimit(value);
}

function extractAgentSnoozed(raw: unknown): boolean | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj["snoozed"] === "boolean") return obj["snoozed"] as boolean;
  if (typeof obj["agent_snoozed"] === "boolean") return obj["agent_snoozed"] as boolean;
  return undefined;
}

function extractInterAgentMode(raw: unknown): boolean | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj["inter_agent_mode_enabled"] === "boolean") {
    return obj["inter_agent_mode_enabled"] as boolean;
  }
  if (typeof obj["interAgentMode"] === "boolean") {
    return obj["interAgentMode"] as boolean;
  }
  return undefined;
}

/** Bounded LRU-ish ring: drop the oldest entry when we exceed the cap. */
function rememberSeen(seen: Set<string>, id: string): void {
  if (seen.has(id)) return;
  if (seen.size >= SEEN_RING_LIMIT) {
    const first = seen.values().next();
    if (!first.done) seen.delete(first.value);
  }
  seen.add(id);
}
