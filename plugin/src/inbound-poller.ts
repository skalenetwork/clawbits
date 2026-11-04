import {
  createChannelIngressMonitor,
  type ChannelIngressMonitorLifecycle,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import { stopTurn } from "./draft-registry.js";
import { resolveKnownAnswers, withChallenge } from "./challenge.js";
import type { ClawBitsClient } from "./client.js";
import { ClawBitsError } from "./errors.js";
import { logDebug, logError, logInfo, logWarn, writeTraceSpan } from "./file-logger.js";
import type { InboundUiAction, UiAction } from "./inbound-types.js";
import { finishMcpSignIn, isMcpSignIn, type McpSignIn } from "./mcp-oauth.js";
import { choiceOf, INHERIT, type ModelSelection } from "./model-choice.js";
import { answerQuestionClick, QUESTION_EVENT, questionWaiting } from "./questions.js";
import type { KeyedStore } from "./runtime.js";
import { wakeCompanion } from "./service-handoff.js";
import * as mmTools from "./tools/mattermost.js";
import type { ResolvedClawBitsAccount } from "./types.js";
import { getWidget, listWidgets } from "./widgets/api.js";
import type { GameSessionDeletion } from "./widgets/session.js";
import {
  summarySignal,
  waitingSignals,
  widgetTurnSignal,
  WidgetWakes,
  type WidgetSignal,
  type WidgetSignalSource,
  type WidgetTurn,
} from "./widgets/wake.js";

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
  /** Set on a game wake (widgets/wake.ts): the turn is the agent's move in this game. It runs in
   *  the game's own session and is silent: no draft, no status, no chat text, no sends. */
  widget?: WidgetTurn;
  /** Set when the post is a human's click on one of this agent's UI blocks. */
  uiAction?: InboundUiAction;
  /** Set when `text` answers the question its chat waits on: core takes the whole text as the answer. */
  questionAnswer?: true;
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
  /** Set on the message that started a chat game, which its wake plays instead. */
  widget_id?: string;
  /** Set on a human's click on a UI block: the action the server built from the block. */
  ui_action?: UiAction;
  /** The post this one replies to; a click's is its UI block. */
  parent_preview?: { post_id: number; agent_id: string | null };
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
  queue: ChannelIngressQueue<StoredInboundEvent> | (() => ChannelIngressQueue<StoredInboundEvent>);
  onInboundMessage: (msg: InboundMessage, turn?: InboundTurn) => Promise<void> | void;
  contextWatermarks?: KeyedStore<number>;
  onModelSelection?: (selection: ModelSelection) => void;
  pollIntervalMs?: number;
  websocketEnabled?: boolean;
  websocketReconcileIntervalMs?: number;
  websocketControlRefreshIntervalMs?: number;
  log?: InboundPollerLog;
  now?: () => number;
  catchUpEnabled?: boolean;
  onWidgetEnded?: (widget: {
    widgetId: string;
    channelId: string;
  }) => Promise<GameSessionDeletion | void> | GameSessionDeletion | void;
  onGameSessionSweep?: (
    serial: (run: () => Promise<void>) => Promise<void>,
    seated: (widgetId: string) => boolean,
  ) => Promise<void>;
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
    ...(typeof raw["widget_id"] === "string" && raw["widget_id"]
      ? { widget_id: raw["widget_id"] as string }
      : {}),
    ...(raw["ui_action"] && typeof raw["ui_action"] === "object"
      ? { ui_action: raw["ui_action"] as UiAction }
      : {}),
    ...(raw["parent_preview"] && typeof raw["parent_preview"] === "object"
      ? { parent_preview: raw["parent_preview"] as MattermostPost["parent_preview"] }
      : {}),
    ...(files ? { files } : {}),
  };
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_WEBSOCKET_RECONCILE_INTERVAL_MS = 5 * 60_000;
const DEFAULT_WEBSOCKET_CONTROL_REFRESH_INTERVAL_MS = 5 * 60_000;
const GAME_SESSION_SWEEP_INTERVAL_MS = 60 * 60_000;
const KNOWN_LIMIT = 1000;
const DEFAULT_CONSECUTIVE_AGENT_TURNS = 10;
const MAX_CONSECUTIVE_AGENT_TURNS = 50;
const HUMAN_GUIDANCE_MESSAGE = "Nice, but need human guidance to proceed.";
const CATCH_UP_CONTEXT_LIMIT = 50;
const CATCH_UP_PAGE_SIZE = 50;
const MAX_CATCH_UP_PAGES = 4;
const MAX_CATCH_UP_DEFERRALS = 1;
const CATCH_UP_DEFERRAL_RETRY_MS = 1000;
const INGRESS_RETRY = { maxAttempts: 3, deadLetterMinAgeMs: 0, baseMs: 2_000, maxMs: 30_000 };
const INGRESS_RETENTION = { completedTtlMs: 30 * 24 * 60 * 60_000, completedMaxEntries: 2_000, failedMaxEntries: 1_000 };

type InboundSource = "poll" | "reconcile" | "sse" | "ws";

interface PostEvent {
  kind: "post";
  channelId: string;
  post: MattermostPost;
  source: InboundSource;
  attention?: true;
  catchUp?: InboundContextPost[];
  /** Admitted as an answer to a waiting question; the ingress lane is fixed when admitted. */
  question?: true;
  /** Admitted again as an ordinary post after its question ended before it was delivered. */
  requeued?: true;
}

export type InboundEvent =
  | PostEvent
  | { kind: "message"; msg: InboundMessage }
  | { kind: "stop"; channelId: string; at: number };

export interface StoredInboundEvent {
  version: number;
  body: InboundEvent;
}

export interface InboundTurn {
  lifecycle: ChannelIngressMonitorLifecycle;
  lastAttempt: boolean;
}

function inboundEventId(event: InboundEvent): string {
  switch (event.kind) {
    case "post":
      return event.attention ? `attention:${event.post.id}` : event.requeued ? `turn:${event.post.id}` : event.post.id;
    case "message":
      return event.msg.postId;
    case "stop":
      return `stop:${event.channelId}:${String(event.at)}`;
  }
}

function isUnsettled(post: MattermostPost): boolean {
  return post.status === "streaming" || post.status === "draft";
}

function postSerialOf(post: MattermostPost): number {
  const serial = Number(post.id);
  return Number.isFinite(serial) && serial > 0 ? Math.floor(serial) : 0;
}

function errorText(err: unknown): string {
  return String((err as Error)?.message ?? err);
}

function resolvePositiveMs(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "string" && value.trim().length > 0 ? Number(value.trim()) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.floor(parsed));
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

function isPairChat(channelType: string | null | undefined): boolean {
  return channelType === "direct" || channelType === "agent_chat";
}

/** The action of a click on one of this agent's own UI blocks, which the server makes the parent of
 *  the click's post. */
function ownSurfaceAction(post: MattermostPost, agentId: string | undefined): InboundUiAction | undefined {
  const { ui_action: action, parent_preview: parent } = post;
  if (!agentId || !action || parent?.agent_id !== agentId) return undefined;
  const { name, sourceComponentId, context } = action;
  return { name, surfacePostId: parent.post_id, sourceComponentId, context };
}

/** A human's typed answer to the question its chat waits on: plain text with this agent's own @mention
 *  removed, no files and no leading `/`. */
function typedAnswer(post: MattermostPost, agentId: string | undefined): string | undefined {
  if (!agentId || post.human_id === undefined || post.ui_action || post.widget_id || post.files?.length) return undefined;
  const own = new RegExp(`(^|[^${MENTION_HANDLE_CHARS}])@${escapeRegExp(agentId)}(?![${MENTION_HANDLE_CHARS}])[,:]?[ \\t]*`, "g");
  const text = (post.message ?? "").replace(own, "$1").trim();
  return text && !text.startsWith("/") ? text : undefined;
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

function agentEventsWebSocketUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/u, "");
  const url = new URL(`${base}/api/agentic/mm/events/ws`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
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
  const ws = new WebSocket(agentEventsWebSocketUrl(params.client.getEndpoint()), {
    headers: { Authorization: `Bearer ${params.apiKey}` },
  });
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
  const { client, account, abortSignal, log } = opts;
  const tag = `[clawbits/${account.accountId}]`;
  const mentionToken = account.agentId ? `@${account.agentId}` : null;
  const backlog = account.channelContextBacklog ?? 0;
  const allowFromSet = new Set(
    (account.allowFrom ?? []).map((v) => String(v).trim()).filter((v) => v.length > 0),
  );
  const allowFromWildcard = allowFromSet.has("*");
  const allowedKey = (key: string): boolean => allowFromSet.size === 0 || allowFromWildcard || allowFromSet.has(key);
  const allowedSender = (senderId: string): boolean =>
    (senderId && !senderId.includes(":") ? [senderId, `human:${senderId}`, `agent:${senderId}`] : [senderId]).some(allowedKey);
  const answers = resolveKnownAnswers(account.knownAnswers);
  let interAgentMode = account.interAgentMode === true;
  let interAgentMessageLimit = clampInterAgentMessageLimit(account.interAgentMessageLimit);
  let agentSnoozed = false;
  let modelSelection: ModelSelection = { agentDefault: INHERIT, channels: new Map() };
  let consecutiveAgentTurns = 0;
  let awaitingHumanGuidance = false;
  let guidanceNoticeSent = false;
  const channelTypes = new Map<string, string | null>();
  const baselines = new Map<string, number>();
  const admitted = new Set<string>();
  const sseChannels = new Map<string, { task: Promise<void>; abort: AbortController }>();
  let agentWsTask: Promise<void> | undefined;
  let agentWsAbort: AbortController | undefined;
  let agentWsConnected = false;
  let agentWsDisabledUntil = 0;
  let forceReconcilePoll = false;
  const config = account.config as Record<string, unknown>;
  const pollMs = resolvePollIntervalMs(
    opts.pollIntervalMs ?? account.config.pollIntervalMs ?? config["poll_interval_ms"] ?? process.env.CLAWBITS_POLL_INTERVAL_MS,
  );
  const websocketEnabled = resolveBoolean(
    opts.websocketEnabled ?? account.config.websocketEnabled ?? config["websocket_enabled"] ?? process.env.CLAWBITS_WEBSOCKET_ENABLED,
    true,
  );
  const catchUpEnabled = resolveBoolean(
    opts.catchUpEnabled ?? account.config.catchUpEnabled ?? config["catch_up_enabled"] ?? process.env.CLAWBITS_CATCH_UP_ENABLED,
    true,
  );
  const websocketReconcileIntervalMs = resolvePositiveMs(
    opts.websocketReconcileIntervalMs ??
      account.config.websocketReconcileIntervalMs ??
      config["websocket_reconcile_interval_ms"] ??
      process.env.CLAWBITS_WEBSOCKET_RECONCILE_INTERVAL_MS,
    DEFAULT_WEBSOCKET_RECONCILE_INTERVAL_MS,
  );
  const websocketControlRefreshIntervalMs = resolvePositiveMs(
    opts.websocketControlRefreshIntervalMs ??
      account.config.websocketControlRefreshIntervalMs ??
      config["websocket_control_refresh_interval_ms"] ??
      process.env.CLAWBITS_WEBSOCKET_CONTROL_REFRESH_INTERVAL_MS,
    DEFAULT_WEBSOCKET_CONTROL_REFRESH_INTERVAL_MS,
  );
  const jitter = (intervalMs: number): number =>
    intervalMs > 0 ? Math.floor(Math.random() * Math.min(30_000, Math.floor(intervalMs / 10))) : 0;
  let nextWebSocketReconcileAt = now() + websocketReconcileIntervalMs + jitter(websocketReconcileIntervalMs);
  let nextWebSocketControlRefreshAt =
    now() + websocketControlRefreshIntervalMs + jitter(websocketControlRefreshIntervalMs);

  let lane: Promise<unknown> = Promise.resolve();
  const inLane = <T>(run: () => Promise<T>): Promise<T> => {
    const next = lane.then(run);
    lane = next.catch(() => undefined);
    return next;
  };

  const dispatchMessage = async (msg: InboundMessage): Promise<boolean> => {
    try {
      await opts.onInboundMessage(msg);
      return true;
    } catch (err) {
      logError(log, `${tag} inbound dispatch failed for ${msg.postId}: ${String(err)}`);
      return false;
    }
  };

  const widgetWakes = new WidgetWakes({
    accountId: account.accountId,
    now,
    snoozed: () => agentSnoozed,
    allowed: allowedKey,
    read: (widgetId) => getWidget(client, widgetId, { private: true }, { signal: abortSignal }),
    enqueue: (id, run) => {
      void inLane(run).catch((err) => logWarn(log, `${tag} queued ${id} failed: ${errorText(err)}`));
    },
    dispatch: dispatchMessage,
    channelType: (channelId) => channelTypes.get(channelId) ?? null,
    ...(opts.onWidgetEnded
      ? { ended: async (widget: { widgetId: string; channelId: string }) => await opts.onWidgetEnded?.(widget) }
      : {}),
    log,
  });
  const widgetsOn = account.widgets !== false;
  const offerGame = (signal: WidgetSignal, source: WidgetSignalSource): void => {
    if (widgetsOn) widgetWakes.offer(signal, source);
  };
  let heldGameSignals: WidgetSignal[] = [];
  let nextGameSessionSweepAt = 0;
  let gameSessionSweep: Promise<void> | undefined;
  const startGameSessionSweep = (): void => {
    const sweep = opts.onGameSessionSweep;
    if (!sweep || gameSessionSweep || abortSignal.aborted || now() < nextGameSessionSweepAt) return;
    nextGameSessionSweepAt = now() + GAME_SESSION_SWEEP_INTERVAL_MS + Math.floor(Math.random() * 60_000);
    gameSessionSweep = sweep(inLane, (widgetId) => widgetWakes.seated(widgetId))
      .catch((err) => logWarn(log, `${tag} game session sweep failed: ${errorText(err)}`))
      .finally(() => {
        gameSessionSweep = undefined;
      });
  };
  let waitingWidgetsSupported = true;
  let waitingWidgetsRead: Promise<void> | undefined;
  const readWaitingWidgets = (): Promise<void> => {
    if (!widgetsOn || !waitingWidgetsSupported || agentSnoozed || abortSignal.aborted) return Promise.resolve();
    waitingWidgetsRead ??= (async () => {
      try {
        const listed = await listWidgets(client, { waiting: true }, { signal: abortSignal });
        for (const summary of listed?.widgets ?? []) offerGame(summarySignal(summary), "list");
      } catch (err) {
        if (err instanceof ClawBitsError && err.statusCode === 404) {
          waitingWidgetsSupported = false;
          logInfo(log, `${tag} server has no agent widget routes; game catch-up off`);
          return;
        }
        logWarn(log, `${tag} waiting games read failed: ${errorText(err)}`);
      } finally {
        waitingWidgetsRead = undefined;
      }
    })();
    return waitingWidgetsRead;
  };

  if (!account.agentId) {
    logWarn(log, `${tag} inbound poller: no agentId; exiting`);
    return;
  }
  const fallbackChannelId = account.channelId;
  logInfo(
    log,
    `${tag} inbound poller started; fallback channel ${String(fallbackChannelId ?? "(none)")}; mention token ${String(mentionToken)}; fallback poll ${pollMs}ms; ws reconcile ${websocketReconcileIntervalMs}ms; ws control refresh ${websocketControlRefreshIntervalMs}ms`,
  );

  const acks = new Map<string, { sent: number; want: number; busy: boolean }>();
  const ackRead = (channelId: string, postSerial: number): void => {
    if (!(postSerial > 0)) return;
    const ack = acks.get(channelId) ?? { sent: 0, want: 0, busy: false };
    acks.set(channelId, ack);
    if (postSerial <= ack.want) return;
    ack.want = postSerial;
    if (ack.busy) return;
    ack.busy = true;
    void (async () => {
      while (ack.sent < ack.want) {
        const target = ack.want;
        try {
          await mmTools.markChannelRead(client, channelId, target);
          ack.sent = target;
        } catch (err) {
          logWarn(log, `${tag} read-pointer ack failed for ${channelId}: ${errorText(err)}`);
          break;
        }
      }
      ack.busy = false;
    })();
  };

  const postHumanGuidanceNotice = async (channelId: string, post: MattermostPost): Promise<void> => {
    const senderTag = senderTagForPost(post);
    const message = senderTag ? `${senderTag} ${HUMAN_GUIDANCE_MESSAGE}` : HUMAN_GUIDANCE_MESSAGE;
    try {
      await withChallenge(client, answers, (ans) =>
        mmTools.postToChannel(client, channelId, { message, ...(post.trace_id ? { trace_id: post.trace_id } : {}) }, ans),
      );
    } catch (err) {
      logWarn(log, `${tag} failed to post human-guidance pause notice in ${channelId}: ${errorText(err)}`);
    }
  };

  const handlePost = async (event: PostEvent, turn: InboundTurn, question = false): Promise<void> => {
    const { channelId, post, source, attention, catchUp } = event;
    if (post.delete_at && post.delete_at > 0) return;
    if (agentSnoozed) {
      logDebug(log, `${tag} inbound skip ${post.id}: agent snoozed`);
      return;
    }
    const channelType = channelTypes.get(channelId) ?? null;
    const isUserPost = isUserAuthoredPost(post);
    const isSelfAuthored = post.agent_id === account.agentId || post.user_id === account.agentId;
    const isAgentAuthored = Boolean(post.agent_id);
    const senderId = senderIdForPost(post);
    const senderAllowed = interAgentMode || !isAgentAuthored;
    const senderAllowedByAllowFrom = allowedSender(senderId);
    const postChannelId = post.channel_id ?? channelId;
    const hasMention = account.agentId ? hasAgentMention(post.message ?? "", account.agentId) : false;
    if (isUserPost && !isSelfAuthored && !isAgentAuthored && hasMention) {
      consecutiveAgentTurns = 0;
      awaitingHumanGuidance = false;
      guidanceNoticeSent = false;
    }
    const pairChat = isPairChat(channelType);
    const uiAction = ownSurfaceAction(post, account.agentId);
    const isFallbackOperatorChannel = Boolean(
      fallbackChannelId && postChannelId === fallbackChannelId && channelType === null,
    );
    const isAddressedToAgent = hasMention || Boolean(uiAction) || pairChat || isFallbackOperatorChannel || Boolean(attention);
    const isServerCommand = channelType === "direct" && isServerHandledCommand(post.message);
    const isGameStart =
      Boolean(post.widget_id) &&
      isUserPost &&
      !isSelfAuthored &&
      !isAgentAuthored &&
      (pairChat || widgetWakes.seated(post.widget_id as string));
    if (isGameStart) {
      logDebug(log, `${tag} inbound skip ${post.id}: starts game ${String(post.widget_id)}, played by its wake`);
      return;
    }
    const wouldDispatch = isUserPost && !isSelfAuthored && senderAllowed && isAddressedToAgent && !isServerCommand;
    if (wouldDispatch && !senderAllowedByAllowFrom) {
      logWarn(log, `${tag} inbound blocked by allowFrom sender=${senderId || "(unknown)"} post=${post.id} channel=${postChannelId}`);
      return;
    }
    if (!wouldDispatch) {
      logDebug(
        log,
        `${tag} inbound skip ${post.id}: source=${source} userPost=${isUserPost} self=${isSelfAuthored} agentAuthored=${isAgentAuthored} interAgentMode=${interAgentMode} hasMention=${hasMention} addressed=${isAddressedToAgent} serverCommand=${isServerCommand} type=${post.type ?? ""}`,
      );
      return;
    }
    if (isAgentAuthored) {
      if (awaitingHumanGuidance || consecutiveAgentTurns >= interAgentMessageLimit) {
        awaitingHumanGuidance = true;
        if (guidanceNoticeSent) return;
        guidanceNoticeSent = true;
        logWarn(
          log,
          `${tag} pausing inter-agent replies after ${consecutiveAgentTurns} consecutive agent turn(s); limit=${interAgentMessageLimit}; waiting for a human @${account.agentId} tag`,
        );
        await postHumanGuidanceNotice(postChannelId, post);
        return;
      }
      consecutiveAgentTurns += 1;
    }

    const pickedUpAt = Date.now();
    writeTraceSpan({
      trace_id: post.trace_id ?? null,
      span: "plugin.pickup_lag",
      subsystem: "plugin",
      dur_ms: pickedUpAt - post.create_at,
      t_start_ms: post.create_at,
      t_end_ms: pickedUpAt,
      account_id: account.accountId,
      channel_id: channelId,
      inbound_post_id: post.id,
      source,
    });

    if (question) {
      const answer = typedAnswer(post, account.agentId);
      logInfo(log, `${tag} inbound ${post.id} answers the question waiting in ${postChannelId}`);
      if (uiAction) await answerQuestionClick(client, account.accountId, uiAction, senderId);
      else if (answer) {
        await opts.onInboundMessage(
          {
            accountId: account.accountId,
            channelId: postChannelId,
            postId: post.id,
            senderId,
            text: answer,
            files: [],
            channelType,
            ...(post.trace_id ? { traceId: post.trace_id } : {}),
            createAt: post.create_at,
            questionAnswer: true,
          },
          turn,
        );
      }
      return;
    }

    const shownKey = `${account.accountId}:${channelId}`;
    const sharedRoom = !pairChat && !isFallbackOperatorChannel;
    let priorContext = catchUp?.length ? catchUp : undefined;
    if (catchUp) {
      if (sharedRoom) await opts.contextWatermarks?.register(shownKey, post.create_at);
    } else if (backlog > 0 && sharedRoom) {
      const shown = (await opts.contextWatermarks?.lookup(shownKey)) ?? 0;
      try {
        const history = parsePostsResponse(await mmTools.getChannelPosts(client, channelId, backlog + 1));
        const context = buildPriorContext(history, post.id, post.create_at, backlog, account.agentId, shown, interAgentMode);
        if (context.length > 0) priorContext = context;
      } catch (err) {
        logWarn(log, `${tag} backlog fetch failed for ${channelId}: ${errorText(err)} - dispatching without context`);
      }
      await opts.contextWatermarks?.register(shownKey, post.create_at);
    }

    const senderTag = interAgentMode && !pairChat ? senderTagForPost(post) : undefined;
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
      ...(attention ? { attention: true } : {}),
      ...(catchUp ? { catchUp: true } : {}),
      ...(uiAction ? { uiAction } : {}),
      createAt: post.create_at,
    };
    logInfo(log, `${tag} inbound dispatch ${msg.postId} from ${msg.senderId || "unknown"} on ${msg.channelId}: ${JSON.stringify(msg.text)}`);
    await opts.onInboundMessage(msg, turn);
  };

  /** A click on one of this agent's question cards, or a typed post in a chat waiting on a question.
   *  The asking turn holds the account lane, the turn lane and its session's dispatch guard until the
   *  question ends, so these go around all three. */
  const answersQuestion = (event: PostEvent): boolean =>
    !event.attention &&
    (ownSurfaceAction(event.post, account.agentId)?.name === QUESTION_EVENT ||
      (questionWaiting(account.accountId, event.channelId) && typedAnswer(event.post, account.agentId) !== undefined));

  const deliver = async (event: InboundEvent, turn: InboundTurn): Promise<void> => {
    if (event.kind === "stop") return await stopTurn(account.accountId, event.channelId);
    const { lifecycle } = turn;
    const beat = setInterval(() => lifecycle.onDeferredHeartbeat?.(), lifecycle.deferredHeartbeatIntervalMs ?? 60_000);
    try {
      if (event.kind === "post" && event.question) {
        if (answersQuestion(event)) await handlePost(event, turn, true);
        else {
          const { channelId, post, source } = event;
          if (!(await admit({ kind: "post", channelId, post, source, requeued: true }))) {
            throw new Error(`inbound ${post.id} could not move to the turn lane`);
          }
        }
      } else {
        await inLane(async () => {
          if (event.kind === "post") await handlePost(event, turn);
          else await opts.onInboundMessage(event.msg, turn);
        });
      }
    } finally {
      clearInterval(beat);
    }
  };

  const ingress = createChannelIngressMonitor<InboundEvent, InboundEvent, StoredInboundEvent>({
    queue: opts.queue,
    inspect: (event) => ({
      eventId: inboundEventId(event),
      laneKey: event.kind === "stop" ? "stop" : event.kind === "post" && event.question ? "question" : "turn",
    }),
    payload: {
      version: 1,
      serialize: (event) => event,
      deserialize: (event) => event,
      encode: (envelope) => envelope,
      decode: (stored) => stored,
      createClaimError: (kind, claim) => new Error(`inbound event ${claim.id}: ${kind}`),
    },
    pollIntervalMs: 1_000,
    retention: INGRESS_RETENTION,
    drain: { retryPolicy: INGRESS_RETRY },
    abortSignal,
    onError: (err) => logWarn(log, `${tag} inbound queue: ${errorText(err)}`),
    deliver: (event, lifecycle, claim) =>
      deliver(event, { lifecycle, lastAttempt: claim.attempts + 1 >= INGRESS_RETRY.maxAttempts }),
  });

  const admit = async (event: InboundEvent): Promise<boolean> => {
    try {
      return (await ingress.admit(event)).kind === "durable";
    } catch (err) {
      logWarn(log, `${tag} inbound admission failed for ${inboundEventId(event)}: ${errorText(err)}`);
      return false;
    }
  };

  const observe = async (channelId: string, post: MattermostPost, source: InboundSource, attention = false): Promise<void> => {
    const id = postSerialOf(post);
    const floor = baselines.get(channelId);
    const key = attention ? `attention:${post.id}` : post.id;
    if (!id || admitted.has(key) || isUnsettled(post) || post.agent_id === account.agentId || post.user_id === account.agentId) return;
    if (!attention && (floor === undefined ? source === "poll" || source === "reconcile" : id <= floor)) return;
    const event: PostEvent = { kind: "post", channelId, post, source, ...(attention ? { attention: true } : {}) };
    if (!(await admit(answersQuestion(event) ? { ...event, question: true } : event))) return;
    remember(admitted, key);
    if (!attention) ackRead(channelId, id);
  };

  const wakeAfterMcpSignIn = ({ state, channel_id, human_id }: McpSignIn, text: string): void => {
    const channelId = channelTypes.has(channel_id) ? channel_id : account.channelId;
    if (!channelId) return;
    void admit({
      kind: "message",
      msg: {
        accountId: account.accountId,
        channelId,
        postId: `mcp-oauth-${state}`,
        senderId: `human:${human_id}`,
        text,
        channelType: channelTypes.get(channelId) ?? null,
        createAt: now(),
      },
    });
  };

  const seedBaseline = (channel: DiscoveredChannel): void => {
    if (!baselines.has(channel.id) && channel.latestPostId !== null) baselines.set(channel.id, channel.latestPostId);
  };

  const rebuildDiscoveredChannels = (channels: DiscoveredChannel[]): void => {
    channelTypes.clear();
    for (const channel of channels) {
      channelTypes.set(channel.id, channel.channelType);
      if (!catchUpPending) seedBaseline(channel);
    }
  };

  const discoveredFromChannelTypes = (): DiscoveredChannel[] =>
    [...channelTypes.entries()].map(([id, channelType]) => ({ id, channelType, latestPostId: null, lastReadPostId: null }));

  const channelSetKey = (channels: DiscoveredChannel[]): string =>
    channels.map((channel) => channel.id).sort().join("\0");

  const publishModelSelection = (selection: ModelSelection): void => {
    modelSelection = selection;
    opts.onModelSelection?.(selection);
  };

  const applyControlPayload = (raw: unknown): DiscoveredChannel[] => {
    const channels = extractChannels(raw);
    rebuildDiscoveredChannels(channels);
    interAgentMode = extractInterAgentMode(raw) ?? (account.interAgentMode === true);
    interAgentMessageLimit = extractInterAgentMessageLimit(raw) ?? clampInterAgentMessageLimit(account.interAgentMessageLimit);
    agentSnoozed = extractAgentSnoozed(raw) ?? false;
    const selection = extractModelSelection(raw);
    if (selection) publishModelSelection(selection);
    const waiting = waitingSignals(raw);
    if (catchUpPending) heldGameSignals = waiting;
    else for (const signal of waiting) offerGame(signal, "snapshot");
    return channels;
  };

  const mergeDiscoveredChannels = (channels: DiscoveredChannel[]): void => {
    for (const channel of channels) {
      channelTypes.set(channel.id, channel.channelType);
      seedBaseline(channel);
    }
  };

  const removeDiscoveredChannel = (channelId: string): void => {
    channelTypes.delete(channelId);
    baselines.delete(channelId);
  };

  const stopSse = (reason: string): void => {
    for (const [channelId, state] of sseChannels) {
      logDebug(log, `${tag} closing SSE for ${channelId}: ${reason}`);
      state.abort.abort();
    }
  };

  const stopAgentWebSocket = (reason: string): void => {
    if (!agentWsAbort) return;
    logDebug(log, `${tag} closing agent WebSocket: ${reason}`);
    agentWsAbort.abort();
  };

  const postOf = (event: SseEnvelope): { channelId: string; post: MattermostPost } | undefined => {
    const raw = event.data;
    if (!raw || typeof raw !== "object") return undefined;
    const post = normalizePost(raw as Record<string, unknown>);
    const channelId = event.channel_id ?? post?.channel_id ?? fallbackChannelId;
    return post && channelId ? { channelId, post } : undefined;
  };

  const handleRealtimePostEvent = (event: SseEnvelope, source: "sse" | "ws", attention = false): void => {
    const found = postOf(event);
    if (found) void observe(found.channelId, found.post, source, attention);
  };

  const scheduleNextWebSocketReconcile = (): void => {
    nextWebSocketReconcileAt = now() + websocketReconcileIntervalMs + jitter(websocketReconcileIntervalMs);
  };

  const scheduleNextWebSocketControlRefresh = (): void => {
    nextWebSocketControlRefreshAt =
      websocketControlRefreshIntervalMs > 0
        ? now() + websocketControlRefreshIntervalMs + jitter(websocketControlRefreshIntervalMs)
        : Number.POSITIVE_INFINITY;
  };

  const startAgentWebSocket = (): void => {
    if (!websocketEnabled || agentWsTask || agentWsDisabledUntil > now() || abortSignal.aborted || agentSnoozed || !account.apiKey) {
      return;
    }
    const wsAbort = new AbortController();
    const abortWs = () => wsAbort.abort();
    abortSignal.addEventListener("abort", abortWs, { once: true });
    logInfo(log, `${tag} opening agent WebSocket`);
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
        logInfo(log, `${tag} agent WebSocket connected`);
      },
      onEvent: (event) => {
        switch (event.type) {
          case "snapshot":
            applyControlPayload(event.data);
            forceReconcilePoll = true;
            scheduleNextWebSocketControlRefresh();
            return;
          case "channel.added":
            mergeDiscoveredChannels(extractChannels([event.data ?? (event.channel_id ? { channel_id: event.channel_id } : null)]));
            forceReconcilePoll = true;
            return;
          case "channel.removed":
            if (event.channel_id) removeDiscoveredChannel(event.channel_id);
            forceReconcilePoll = true;
            return;
          case "resync_required":
            forceReconcilePoll = true;
            return;
          case "model.selection": {
            const data = event.data;
            if (!data || typeof data !== "object") return;
            const { channel_id, model, thinking } = data as Record<string, unknown>;
            const choice = choiceOf(model, thinking);
            publishModelSelection(
              typeof channel_id === "string"
                ? { ...modelSelection, channels: new Map(modelSelection.channels).set(channel_id, choice) }
                : { ...modelSelection, agentDefault: choice },
            );
            return;
          }
          case "skills.sync":
          case "automation.sync":
            wakeCompanion(event.type, account.accountId);
            return;
          case "turn.stop":
            if (event.channel_id) void admit({ kind: "stop", channelId: event.channel_id, at: now() });
            return;
          case "widget.turn": {
            const signal = widgetTurnSignal(event.channel_id, event.data);
            if (signal) offerGame(signal, "ws");
            return;
          }
          case "mcp.oauth.code": {
            const signIn = event.data;
            if (!isMcpSignIn(signIn)) return;
            void finishMcpSignIn(signIn, client)
              .then((note) => wakeAfterMcpSignIn(signIn, note))
              .catch((err: unknown) => logWarn(log, `${tag} MCP sign-in for ${signIn.server} failed: ${errorText(err)}`));
            return;
          }
          case "lobstertalk.consider":
            handleRealtimePostEvent(event, "ws", true);
            return;
          case "post.created":
            handleRealtimePostEvent(event, "ws");
            return;
        }
      },
    })
      .catch((err) => {
        if (!abortSignal.aborted && !wsAbort.signal.aborted) {
          agentWsDisabledUntil = now() + 60_000;
          forceReconcilePoll = true;
          logWarn(log, `${tag} agent WebSocket stopped: ${errorText(err)}; SSE/polling fallback remains active`);
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
    logInfo(log, `${tag} opening SSE for ${channel.id}`);
    const sseAbort = new AbortController();
    const abortSse = () => sseAbort.abort();
    abortSignal.addEventListener("abort", abortSse, { once: true });
    const task = consumeChannelEvents({
      client,
      channelId: channel.id,
      abortSignal: sseAbort.signal,
      onEvent: (event) => {
        if (event.type === "post.created") handleRealtimePostEvent(event, "sse");
      },
    })
      .catch((err) => {
        if (!abortSignal.aborted && !sseAbort.signal.aborted) {
          logWarn(log, `${tag} SSE stopped for ${channel.id}: ${errorText(err)}; polling fallback remains active`);
        }
      })
      .finally(() => {
        abortSignal.removeEventListener("abort", abortSse);
        sseChannels.delete(channel.id);
      });
    sseChannels.set(channel.id, { task, abort: sseAbort });
  };

  const drainGap = async (channelId: string, fromSerial: number): Promise<{ posts: MattermostPost[]; overflowed: boolean }> => {
    const collected: MattermostPost[] = [];
    let after = fromSerial;
    for (let page = 0; page < MAX_CATCH_UP_PAGES; page += 1) {
      const posts = parsePostsResponse(await mmTools.getChannelPosts(client, channelId, CATCH_UP_PAGE_SIZE, after));
      collected.push(...posts);
      if (posts.length < CATCH_UP_PAGE_SIZE) return { posts: collected, overflowed: false };
      after = posts.reduce((max, p) => Math.max(max, postSerialOf(p)), after);
    }
    return { posts: collected, overflowed: true };
  };

  const catchUpChannel = async ({ id: channelId, channelType, latestPostId, lastReadPostId }: DiscoveredChannel): Promise<number> => {
    if (lastReadPostId === null) {
      if (latestPostId === null) return 0;
      baselines.set(channelId, latestPostId);
      ackRead(channelId, latestPostId);
      return 0;
    }
    baselines.set(channelId, Math.max(lastReadPostId, latestPostId ?? 0));
    if (latestPostId !== null && latestPostId <= lastReadPostId) return 0;
    const gap = await drainGap(channelId, lastReadPostId);
    let posts = gap.posts;
    if (gap.overflowed) {
      logWarn(log, `${tag} catch-up gap in ${channelId} exceeds ${posts.length} post(s); skipping the oldest part`);
      posts = parsePostsResponse(await mmTools.getChannelPosts(client, channelId));
    }
    const newest = posts.reduce((max, p) => Math.max(max, postSerialOf(p)), lastReadPostId);
    baselines.set(channelId, Math.max(newest, latestPostId ?? 0));
    const pending = posts.filter(
      (p) =>
        !(p.delete_at && p.delete_at > 0) &&
        isUserAuthoredPost(p) &&
        !p.agent_id &&
        p.user_id !== account.agentId &&
        !p.widget_id,
    );
    const isOperator = Boolean(fallbackChannelId && channelId === fallbackChannelId && channelType === null);
    const addressed = pending.filter(
      (p) =>
        isPairChat(channelType) ||
        isOperator ||
        (ownSurfaceAction(p, account.agentId)?.name ?? QUESTION_EVENT) !== QUESTION_EVENT ||
        (account.agentId ? hasAgentMention(p.message ?? "", account.agentId) : false),
    );
    const trigger = addressed.at(-1);
    if (trigger) {
      const context = buildPriorContext(posts, trigger.id, trigger.create_at, CATCH_UP_CONTEXT_LIMIT, account.agentId, 0, interAgentMode);
      if (!(await admit({ kind: "post", channelId, post: trigger, source: "poll", catchUp: context }))) return 0;
      remember(admitted, trigger.id);
      logInfo(log, `${tag} catch-up: replaying ${channelId} - trigger ${trigger.id}, ${context.length} message(s) of missed context`);
    } else if (pending.length > 0) {
      logInfo(log, `${tag} catch-up: ${pending.length} missed post(s) in ${channelId}, none addressed to this agent - skipping`);
    }
    ackRead(channelId, posts.filter((p) => !isUnsettled(p)).reduce((max, p) => Math.max(max, postSerialOf(p)), lastReadPostId));
    return trigger ? pending.length : 0;
  };

  const runCatchUp = async (discovered: DiscoveredChannel[]): Promise<void> => {
    let recovered = 0;
    for (const channel of discovered) {
      if (abortSignal.aborted) return;
      try {
        recovered += await catchUpChannel(channel);
      } catch (err) {
        if (!baselines.has(channel.id) && channel.latestPostId !== null) baselines.set(channel.id, channel.latestPostId);
        logWarn(log, `${tag} catch-up failed for ${channel.id}: ${errorText(err)} (retries next boot)`);
      }
    }
    logInfo(log, `${tag} catch-up complete over ${discovered.length} channel(s), ${recovered} missed message(s) surfaced`);
  };

  const pollDiscoveredChannels = async (discovered: DiscoveredChannel[], source: "poll" | "reconcile"): Promise<void> => {
    for (const { id: channelId } of discovered) {
      if (abortSignal.aborted) break;
      try {
        const posts = parsePostsResponse(await mmTools.getChannelPosts(client, channelId));
        if (!baselines.has(channelId)) {
          baselines.set(channelId, posts.reduce((max, p) => Math.max(max, postSerialOf(p)), 0));
          continue;
        }
        for (const post of posts) {
          if (abortSignal.aborted) break;
          await observe(channelId, post, source);
        }
      } catch (err) {
        logWarn(log, `${tag} inbound ${source} failed for ${channelId}: ${errorText(err)}`);
      }
    }
  };

  let catchUpPending = catchUpEnabled;
  let catchUpDeferrals = 0;
  let controlPayloadOk = false;
  ingress.start();

  try {
    while (!abortSignal.aborted) {
      let discovered: DiscoveredChannel[] = discoveredFromChannelTypes();
      const wasSnoozed = agentSnoozed;
      let waitingGamesListed = false;
      const shouldRefreshControl =
        !agentWsConnected ||
        channelTypes.size === 0 ||
        (websocketControlRefreshIntervalMs > 0 && now() >= nextWebSocketControlRefreshAt);
      if (shouldRefreshControl) {
        try {
          const beforeIds = channelSetKey(discovered);
          discovered = applyControlPayload(await mmTools.listChannels(client));
          waitingGamesListed = true;
          controlPayloadOk = true;
          if (agentWsConnected) scheduleNextWebSocketControlRefresh();
          if (agentWsConnected && beforeIds !== channelSetKey(discovered)) {
            forceReconcilePoll = true;
            stopAgentWebSocket("channel set changed");
          }
        } catch (err) {
          if (agentWsConnected) scheduleNextWebSocketControlRefresh();
          else interAgentMode = account.interAgentMode === true;
          logWarn(log, `${tag} listChannels failed: ${errorText(err)} - falling back to cached channels/single channel`);
          discovered = discoveredFromChannelTypes();
        }
      }
      if (discovered.length === 0 && fallbackChannelId) {
        discovered = [{ id: fallbackChannelId, channelType: null, latestPostId: null, lastReadPostId: null }];
        rebuildDiscoveredChannels(discovered);
      }

      if (agentSnoozed) {
        stopAgentWebSocket("agent snoozed");
        stopSse("agent snoozed");
        if (!wasSnoozed) logInfo(log, `${tag} agent snoozed; skipping SSE and post polling`);
        await sleepInterruptible(pollMs, abortSignal);
        continue;
      }

      if (wasSnoozed && !catchUpPending) {
        for (const channel of discovered) {
          if (channel.latestPostId === null) continue;
          baselines.set(channel.id, Math.max(baselines.get(channel.id) ?? 0, channel.latestPostId));
          ackRead(channel.id, channel.latestPostId);
        }
        logInfo(log, `${tag} agent unsnoozed; skipping snoozed backlog`);
      }

      if (catchUpPending) {
        if (!controlPayloadOk && catchUpDeferrals < MAX_CATCH_UP_DEFERRALS) {
          catchUpDeferrals += 1;
          logWarn(log, `${tag} catch-up deferred (${catchUpDeferrals}/${MAX_CATCH_UP_DEFERRALS}): no control payload yet - holding realtime startup`);
          await sleepInterruptible(Math.min(CATCH_UP_DEFERRAL_RETRY_MS, pollMs), abortSignal);
          continue;
        }
        catchUpPending = false;
        await runCatchUp(discovered);
        if (abortSignal.aborted) break;
        for (const signal of heldGameSignals.splice(0)) offerGame(signal, "snapshot");
      }

      startGameSessionSweep();
      startAgentWebSocket();

      if (websocketEnabled && agentWsTask && !agentWsConnected && agentWsDisabledUntil <= now()) {
        await Promise.race([sleepInterruptible(Math.min(1000, pollMs), abortSignal), agentWsTask.catch(() => undefined)]);
        if (abortSignal.aborted) break;
        if (agentWsConnected) continue;
      }

      for (const channel of discovered) startSse(channel);

      if (websocketEnabled && agentWsConnected && agentWsDisabledUntil <= now()) {
        if (forceReconcilePoll || (websocketReconcileIntervalMs > 0 && now() >= nextWebSocketReconcileAt)) {
          forceReconcilePoll = false;
          scheduleNextWebSocketReconcile();
          await pollDiscoveredChannels(discovered, "reconcile");
          await readWaitingWidgets();
        }
      } else {
        await pollDiscoveredChannels(discovered, "poll");
        if (!waitingGamesListed) await readWaitingWidgets();
      }

      if (abortSignal.aborted) break;
      await sleepInterruptible(pollMs, abortSignal);
    }
  } finally {
    widgetWakes.dispose();
    stopAgentWebSocket("poller stopped");
    for (const { task, abort } of sseChannels.values()) {
      abort.abort();
      void task.catch(() => undefined);
    }
    await ingress.stop();
    logInfo(log, `${tag} inbound poller stopped`);
  }
}

interface DiscoveredChannel {
  id: string;
  channelType: string | null;
  latestPostId: number | null;
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

function extractModelSelection(raw: unknown): ModelSelection | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const { channels, default_model, default_thinking } = raw as Record<string, unknown>;
  if (!Array.isArray(channels)) return undefined;
  return {
    agentDefault: choiceOf(default_model, default_thinking),
    channels: new Map(
      channels.flatMap((channel: Record<string, unknown> | null) =>
        typeof channel?.channel_id === "string"
          ? [[channel.channel_id, choiceOf(channel.model, channel.thinking)] as const]
          : [],
      ),
    ),
  };
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

function remember(known: Set<string>, id: string): void {
  if (known.size >= KNOWN_LIMIT) {
    const first = known.values().next();
    if (!first.done) known.delete(first.value);
  }
  known.add(id);
}
