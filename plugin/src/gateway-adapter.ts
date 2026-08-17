import type {
  ChannelGatewayAdapter,
  ChannelGatewayContext,
  ChannelReplyDispatchContext,
} from "openclaw/plugin-sdk/core";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";
import { CHANNEL_ID } from "./accounts.js";
import { buildAgentBody, clawbitsSessionId } from "./agent-body.js";
import { ChannelWatermarkStore } from "./channel-watermarks.js";
import { saveInboundAttachmentsForAgent } from "./attachments.js";
import {
  registerOpenDraft,
  unregisterOpenDraft,
  type OpenDraftRef,
} from "./draft-registry.js";
import { finishReporting } from "./activity/reporter.js";
import { finishStreaming } from "./activity/stream-patcher.js";
import {
  registerInFlightTurn,
  unregisterInFlightTurn,
  type InFlightTurn,
} from "./activity/turn-registry.js";
import { resolveKnownAnswers, withChallenge } from "./challenge.js";
import { ClawBitsClient } from "./client.js";
import { buildClientForAccount } from "./client-factory.js";
import {
  consoleErrorWithFile,
  logInfo,
  logWarn,
  pluginDebug,
  writeTraceSpan,
} from "./file-logger.js";
import { dispatchInboundEmail } from "./email-adapter.js";
import { runEmailPoller } from "./email-poller.js";
import {
  runInboundPoller,
  type InboundMessage,
} from "./inbound-poller.js";
import { runLivenessPinger } from "./liveness.js";
import { runAutomationsReconciler } from "./automations/reconcile.js";
import { runUsageReporter } from "./usage/reporter.js";
import { claimSkillsReporter, runSkillsReporter } from "./skills/sync.js";
import { getWorkspaceDir } from "./skills/scan.js";
import {
  resolveInboundDispatchGuardTarget,
  withInboundDispatchGuard,
} from "./inbound-dispatch-guard.js";
import * as mmTools from "./tools/mattermost.js";
import * as realtimeTools from "./tools/realtime.js";
import * as versionTools from "./tools/version.js";
import type { VersionCheckResponse } from "./tools/version.js";
import type { ResolvedClawBitsAccount } from "./types.js";

// Shared across every account started in this process: a single file-backed
// watermark store so the catch-up backlog isn't re-injected after a restart.
// Keyed internally by (accountId, channelId), so one instance is safe for all
// accounts. `load()` is guarded, so repeated startAccount calls load once.
const channelWatermarkStore = ChannelWatermarkStore.fileBacked();

// Cadence for re-asserting the "generating" presence pill during a turn. The
// server stores that status with a ~15s TTL (clawbits/realtime/bus.py
// STATUS_TTL_SECONDS), designed to be heartbeated — a single set at turn start
// lapses mid-turn on any slow model turn or tool call (image generation
// especially), so the pill goes dark until the reply lands. Re-ping inside the
// TTL to keep it lit for the whole turn.
const GENERATING_HEARTBEAT_MS = 10_000;

// ---------------------------------------------------------------------------
// plugin-outdated chat notice
// ---------------------------------------------------------------------------

/**
 * Post a one-time message into the operator channel telling them the
 * plugin is below the server's minimum supported version. Marker-based
 * idempotency keeps the notice from spamming on every gateway restart:
 * we scan recent posts in the channel for ``[clawbits-plugin-outdated-v
 * {pluginVersion}-min-{minVersion}]`` and skip if it's already there.
 * Changing either version re-fires the notice, so a plugin bump that is
 * still below a tightened floor produces a fresh prompt.
 */
async function postOutdatedNoticeOnce(params: {
  client: ClawBitsClient;
  accountId: string;
  channelId: string;
  answers: Record<string, string>;
  version: VersionCheckResponse;
  log?: { info?: (msg: string) => void; warn?: (msg: string) => void };
}): Promise<void> {
  const { client, accountId, channelId, answers, version, log } = params;
  const pluginV = version.plugin_version ?? "unknown";
  const minV = version.min_plugin_version ?? "unknown";
  const marker = `[clawbits-plugin-outdated-v${pluginV}-min-${minV}]`;

  // Already posted? Scan a window of recent messages for the marker.
  try {
    const payload = (await mmTools.getChannelPosts(client, channelId)) as {
      posts?: unknown;
    } | null;
    const posts = payload?.posts;
    const seenMarker = (() => {
      const messages: string[] = [];
      if (Array.isArray(posts)) {
        for (const p of posts) {
          const m = (p as { message?: unknown } | null)?.message;
          if (typeof m === "string") messages.push(m);
        }
      } else if (posts && typeof posts === "object") {
        for (const p of Object.values(posts as Record<string, unknown>)) {
          const m = (p as { message?: unknown } | null)?.message;
          if (typeof m === "string") messages.push(m);
        }
      }
      return messages.some((m) => m.includes(marker));
    })();
    if (seenMarker) {
      logInfo(
        log,
        `[clawbits/${accountId}] plugin-outdated notice already in ${channelId}; skipping`,
      );
      return;
    }
  } catch (err) {
    logWarn(
      log,
      `[clawbits/${accountId}] could not scan ${channelId} for outdated marker: ${String((err as Error)?.message ?? err)}`,
    );
  }

  const hint =
    version.message ??
    "Update with `openclaw clawbits update` (prints the right command for this install).";
  const greeting = version.operator_display_name
    ? `Hi ${version.operator_display_name},`
    : "Hi there,";
  const text = `⚠️ **${greeting} plugin update required.**\n\n${hint}\n\n_${marker}_`;
  try {
    await withChallenge(client, answers, (answer) =>
      mmTools.postToChannel(client, channelId, { message: text }, answer),
    );
    logInfo(
      log,
      `[clawbits/${accountId}] posted plugin-outdated notice to ${channelId}`,
    );
  } catch (err) {
    logWarn(
      log,
      `[clawbits/${accountId}] failed to post plugin-outdated notice: ${String((err as Error)?.message ?? err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// gateway adapter - long-lived inbound ingestion
// ---------------------------------------------------------------------------

/**
 * Optional deps supplied by `startAccount` so `dispatchInboundMessage` can
 * actually post the agent's reply back to Mattermost. Structured so this
 * function remains callable from tests without a live client (tests exercise
 * the "no channelRuntime" fallback path, which short-circuits before any
 * network calls).
 */
export function tagReplyBody(body: string, senderTag?: string): string {
  const rawTag = senderTag?.trim();
  if (!rawTag) return body;
  const tag = rawTag.startsWith("@") ? rawTag : `@${rawTag}`;
  const leading = body.match(/^\s*/u)?.[0] ?? "";
  const rest = body.slice(leading.length);
  const lowerRest = rest.toLowerCase();
  const lowerTag = tag.toLowerCase();
  const next = rest.slice(tag.length, tag.length + 1);
  if (
    lowerRest.startsWith(lowerTag) &&
    (next === "" || /[\s,.:;!?]/u.test(next))
  ) return body;
  return `${leading}${tag} ${rest}`;
}

function normalizeSessionCommand(text: string): string | null {
  const trimmed = text.trim();
  const match = /^\/(new|reset|start|clear)(?=\s|$)/iu.exec(trimmed);
  if (!match) return null;
  const raw = match[1]?.toLowerCase();
  if (!raw) return null;
  const command = raw === "start"
    ? "/new"
    : raw === "clear"
      ? "/reset"
      : `/${raw}`;
  return `${command}${trimmed.slice(match[0].length)}`;
}

function isHelpCommand(text: string): boolean {
  return /^\/help(?:\s|$)/iu.test(text.trim());
}

// Bare `/usage` in OpenClaw toggles the per-reply token footer (off→tokens→full)
// and just echoes the new mode — not a usage report. Map it to `/usage cost` so
// a single `/usage` prints the session/today/30-day token+cost summary. Explicit
// `/usage tokens|full|off|cost` is passed through untouched.
function normalizeUsageCommand(text: string): string | null {
  return /^\/usage$/iu.test(text.trim()) ? "/usage cost" : null;
}

function buildAdminHelpText(): string {
  return [
    "ℹ️ Clawbits admin commands",
    "",
    "`/help` — Show this help.",
    "`/new [message]` — Start a fresh OpenClaw session in this DM.",
    "`/start [message]` — Alias for `/new`.",
    "`/reset [message]` — Reset this DM's OpenClaw session.",
    "`/clear [message]` — Alias for `/reset`.",
    "",
    "Admin commands only work in the configured operator DM.",
  ].join("\n");
}

export interface DispatchInboundDeps {
  /** Authenticated Clawbits client used for the deliver callback. */
  client?: ClawBitsClient;
  /** Known challenge answers to satisfy the POST-side proof-of-cognition. */
  answers?: Record<string, string>;
  /** Status sink so inbound/outbound activity becomes visible in channels.status. */
  setStatus?: ChannelGatewayContext<ResolvedClawBitsAccount>["setStatus"];
  /**
   * Resolved per-account ``groupChannelShimmer`` flag. Defaults to ``true``
   * when omitted (e.g. hand-rolled tests). When ``false`` the pre-open is
   * skipped for non-direct channels and the legacy single-POST delivery
   * path is used — the escape hatch for the runtime double-post regression.
   */
  groupChannelShimmer?: boolean;
}

/**
 * Forward one parsed Mattermost post into OpenClaw's reply pipeline.
 *
 * Third-party channel plugins reach the host through
 * `ctx.channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher`. The
 * dispatcher runs the model but is **not** wired to any outbound transport
 * - the plugin must supply a `deliver` callback in `dispatcherOptions` that
 * actually sends the generated reply. We also:
 *
 *   • use `channelRuntime.routing.resolveAgentRoute` to pick the right agent
 *     and session key for this inbound conversation (falling back to a
 *     synthesized key if the host did not expose routing), and
 *   • hand the raw context through `channelRuntime.reply.finalizeInboundContext`
 *     so defaults/fields our local type does not know about get populated.
 *
 * If the host did not provide a reply surface (e.g. bundled plugin loaded in
 * a non-gateway context), we log and skip so the poller never wedges.
 */
export async function dispatchInboundMessage(
  ctx: ChannelGatewayContext<ResolvedClawBitsAccount>,
  msg: InboundMessage,
  deps: DispatchInboundDeps = {},
): Promise<void> {
  const fileCount = msg.files?.length ?? 0;
  consoleErrorWithFile(
    `[clawbits/${ctx.accountId}] dispatchInboundMessage post=${msg.postId} sender=${msg.senderId} channel=${msg.channelId} files=${fileCount} text=${JSON.stringify(msg.text)}`,
  );
  pluginDebug(
    `Received. Clawbits inbound dispatch is working — post=${msg.postId} sender=${msg.senderId} channel=${msg.channelId} files=${fileCount}.`,
  );
  const runtime = ctx.channelRuntime as {
    routing?: unknown;
    session?: unknown;
    reply?: unknown;
    media?: unknown;
  } | undefined;
  const replySurface = runtime?.reply as {
    dispatchReplyWithBufferedBlockDispatcher?: unknown;
  } | undefined;

  const conversationId = msg.channelId;
  // The human who authored this post (defensive fall back to the chat id when
  // the server omitted a sender). Drives `From`/attribution — it is NOT the
  // routing/session peer for non-DM chats (see routePeer below).
  const senderId = msg.senderId || conversationId;
  const senderAddr = `clawbits:${senderId}`;
  const { client, answers, setStatus } = deps;
  const groupChannelShimmer = deps.groupChannelShimmer !== false;

  // ``channelType`` comes from the inbound poller's channel-discovery call;
  // ``null`` (fallback path without discovery) and ``undefined`` (legacy
  // callers, hand-rolled test messages) default to "direct" since that
  // matches today's single-channel setup. Anything else explicitly
  // non-direct (``"public"`` / ``"private"`` / ``"group"`` / …) takes the
  // channel path.
  const isDirectChannel =
    msg.channelType === undefined ||
    msg.channelType === null ||
    msg.channelType === "direct";
  const isOperatorDm =
    msg.channelType === "direct" && msg.channelId === ctx.account.channelId;
  // Let only the configured operator DM run session admin commands.
  // Private/group/public channels — and other direct chats — stay ordinary text.
  const operatorDmSessionCommand = isOperatorDm ? normalizeSessionCommand(msg.text) : null;
  const operatorDmUsageCommand = isOperatorDm ? normalizeUsageCommand(msg.text) : null;
  const effectiveText = operatorDmSessionCommand ?? operatorDmUsageCommand ?? msg.text;
  const isOperatorDmHelpCommand = isOperatorDm && isHelpCommand(msg.text);
  // Native host text commands (e.g. /usage) from the operator DM must run as
  // *authorized text command* turns. Without both CommandSource:"text" and
  // CommandAuthorized, the host treats the slash text as a normal model
  // message and its command detector then silently swallows it at the
  // authorized-sender gate (the "/usage gives no response" report). Session
  // commands above already authorize via ``operatorDmSessionCommand``; this
  // covers the rest. /help is excluded — the plugin answers it directly below.
  const isOperatorDmTextCommand =
    isOperatorDm &&
    !isOperatorDmHelpCommand &&
    /^\/[a-z][a-z-]*(?:\s|$)/iu.test(msg.text.trim());
  const isAuthorizedCommand = Boolean(operatorDmSessionCommand) || isOperatorDmTextCommand;

  if (isOperatorDmHelpCommand) {
    setStatus?.({
      accountId: ctx.accountId,
      lastInboundAt: msg.createAt || Date.now(),
      lastError: null,
    });
    if (!client || !answers) {
      logWarn(
        ctx.log,
        `[clawbits/${ctx.accountId}] /help command could not reply for ${msg.postId}: gateway client/answers missing`,
      );
      return;
    }
    try {
      await withChallenge(client, answers, (answer) =>
        mmTools.postToChannel(
          client,
          conversationId,
          {
            message: buildAdminHelpText(),
            ...(msg.traceId ? { trace_id: msg.traceId } : {}),
          },
          answer,
        ),
      );
      setStatus?.({
        accountId: ctx.accountId,
        lastOutboundAt: Date.now(),
        lastError: null,
      });
    } catch (err) {
      const detail = String((err as Error)?.message ?? err);
      setStatus?.({ accountId: ctx.accountId, lastError: detail });
      logWarn(
        ctx.log,
        `[clawbits/${ctx.accountId}] /help command reply failed for ${msg.postId}: ${detail}`,
      );
    }
    return;
  }

  if (
    !runtime?.routing ||
    !runtime?.session ||
    !runtime?.reply ||
    typeof replySurface?.dispatchReplyWithBufferedBlockDispatcher !== "function"
  ) {
    const runtimeKeys = runtime ? Object.keys(runtime) : [];
    consoleErrorWithFile(
      `[clawbits/${ctx.accountId}] channel runtime incomplete; dropped inbound post ${msg.postId}; runtimeKeys=${JSON.stringify(runtimeKeys)} hasRouting=${String(Boolean(runtime?.routing))} hasSession=${String(Boolean(runtime?.session))} hasReply=${String(Boolean(runtime?.reply))}`,
    );
    logWarn(
      ctx.log,
      `[clawbits/${ctx.accountId}] channel runtime incomplete; dropped inbound post ${msg.postId}`,
    );
    return;
  }

  // Per-chat session isolation. DMs route as a ``direct`` peer (the human), so
  // they keep the agent's DM/main session. Non-DM posts (group/public/private
  // channels) route as a ``channel`` peer keyed by the channel id, so each chat
  // gets its own isolated session/context — a room's messages (visible to all
  // its members) never bleed into the owner's DM session or into other rooms.
  // resolveAgentRoute (reached through dispatchInboundDirectDmWithRuntime) keys
  // a channel peer as ``agent:<agentId>:clawbits:channel:<channelId>``, while a
  // direct peer collapses to the agent's DM/main session per ``session.dmScope``.
  const routePeer: { kind: "direct" | "channel"; id: string } = isDirectChannel
    ? { kind: "direct", id: senderId }
    : { kind: "channel", id: conversationId };
  const dispatchGuardTarget = resolveInboundDispatchGuardTarget({
    cfg: ctx.cfg,
    runtime,
    channel: CHANNEL_ID,
    accountId: ctx.accountId,
    peer: routePeer,
  });
  // ``From`` always identifies the human who spoke (attribution survives in
  // shared rooms); ``To`` is the surface the post landed on — the channel for
  // rooms, the peer for DMs.
  const recipientAddr = isDirectChannel ? senderAddr : `clawbits:${conversationId}`;

  // Non-direct channels share the same streaming-draft flow as DMs by
  // default. Safety relies on the ``ChatType: "channel"`` override below
  // forcing the runtime to funnel replies through ``deliver()`` instead
  // of using its own outbound — if the runtime ignores the override and
  // double-posts (one via deliver(), one via its own path) operators can
  // set ``channels.clawbits.groupChannelShimmer = false`` to fall back
  // to the legacy single-POST flow for group/public/private channels.
  // `/usage` is answered instantly by the host command pipeline — no model
  // turn, and its reply doesn't flow through deliver(). Pre-opening a streaming
  // draft for it just flashes a shimmer that the turn-end cleanup cancels
  // milliseconds later (the "shimmer that stops immediately" report). Skip the
  // pre-open for it so there's no phantom shimmer. (`/usage <args>` too; not
  // `/new <msg>` / `/reset <msg>`, which do run a model turn.)
  const isInstantHostCommand = /^\/usage(?:\s|$)/iu.test(effectiveText.trim());
  const usePreOpenShimmer = (isDirectChannel || groupChannelShimmer) && !isInstantHostCommand;

  // Routing decision (dev-only): DM vs channel, route peer, recipient. Useful
  // when diagnosing "agent doesn't reply in a channel"; gated behind
  // plugin_development so it's silent in production.
  pluginDebug(
    `routing post=${msg.postId}: channelType=${String(msg.channelType ?? "(none)")} isDirectChannel=${isDirectChannel} chatType=${isDirectChannel ? "direct" : "channel"} routePeer=${routePeer.kind}:${routePeer.id} recipient=${recipientAddr} preOpenShimmer=${usePreOpenShimmer}`,
  );

  // Announce "generating" and create a draft placeholder before the
  // model runs. The channel UI will render a shimmer where the reply
  // will eventually appear. Any failure here degrades to the legacy
  // single-POST flow so a partial rollout (server without Phase 4/5
  // routes) still delivers replies. The two requests are independent,
  // so race them to save a network RTT.
  //
  // The draft id lives in a shared mutable ref registered with the draft
  // registry: replies that bypass ``deliver`` (codex message-tool sends
  // routed through outbound ``sendText``) claim it from there and finalize
  // the draft in place instead of minting a second post — otherwise the
  // shimmer and the real reply coexist until this turn settles. Each
  // consumer empties ``draftRef.id`` synchronously before its PATCH, so
  // deliver / sendText / the cleanup paths below never double-handle it.
  const draftRef: OpenDraftRef = { id: undefined };
  // Interval that renews the "generating" pill for the life of the turn (see
  // GENERATING_HEARTBEAT_MS). Started once the shimmer opens, cleared in
  // clearGenerating() at turn end.
  let generatingHeartbeat: ReturnType<typeof setInterval> | undefined;
  // LobsterTalk attention replies thread under the post that triggered them —
  // nobody tagged the agent, so without the quoted parent the reply reads as
  // a non-sequitur in a busy channel. Ordinary mention/DM replies stay flat.
  const attentionParentId =
    msg.attention && Number.isFinite(Number(msg.postId))
      ? Number(msg.postId)
      : undefined;
  if (client && usePreOpenShimmer) {
    const [statusResult, draftResult] = await Promise.allSettled([
      realtimeTools.setAgentStatus(client, conversationId, "generating"),
      // Stamp the inbound post's trace id onto the reply draft so one id spans
      // the whole turn (human send → this agent reply) end to end.
      realtimeTools.createDraftPost(client, conversationId, msg.traceId, attentionParentId),
    ]);
    if (statusResult.status === "rejected") {
      logWarn(
        ctx.log,
        `[clawbits/${ctx.accountId}] setAgentStatus(generating) failed for ${msg.postId}: ${String((statusResult.reason as Error)?.message ?? statusResult.reason)}`,
      );
    }
    // Keep the pill lit: the initial set above expires after the server TTL,
    // so re-assert it on an interval until clearGenerating() flips to online.
    generatingHeartbeat = setInterval(() => {
      void realtimeTools.setAgentStatus(client, conversationId, "generating").catch(() => {});
    }, GENERATING_HEARTBEAT_MS);
    generatingHeartbeat.unref?.();
    if (draftResult.status === "fulfilled") {
      draftRef.id = draftResult.value.post_id;
      registerOpenDraft(ctx.accountId, conversationId, draftRef);
    } else {
      logWarn(
        ctx.log,
        `[clawbits/${ctx.accountId}] createDraftPost failed for ${msg.postId}: ${String((draftResult.reason as Error)?.message ?? draftResult.reason)} — falling back to single-POST delivery`,
      );
    }
  }

  // Live-activity correlation (LIVE_AGENT_ACTIVITY_PLAN §3.1): register this
  // turn so the agent-event subscription can bind its runId (via
  // lifecycle:start) and stream assistant deltas into the draft / report
  // thinking+tool activity on the status lane. Flags default on; hand-rolled
  // test contexts without the resolved fields keep the default.
  const accountFlags = ctx.account as
    | { streaming?: boolean; liveActivity?: boolean }
    | undefined;
  const accountStreaming = accountFlags?.streaming !== false;
  const accountLiveActivity = accountFlags?.liveActivity !== false;
  const activityTurn: InFlightTurn | undefined =
    client && (accountStreaming || accountLiveActivity)
      ? registerInFlightTurn({
          accountId: ctx.accountId,
          channelId: conversationId,
          draftRef,
          client,
          channelKeyedSession: !isDirectChannel,
          streaming: accountStreaming,
          liveActivity: accountLiveActivity,
        })
      : undefined;

  const clearGenerating = async (): Promise<void> => {
    if (generatingHeartbeat !== undefined) {
      clearInterval(generatingHeartbeat);
      generatingHeartbeat = undefined;
    }
    if (!client) return;
    try {
      await realtimeTools.setAgentStatus(client, conversationId, "online");
    } catch (err) {
      logWarn(
        ctx.log,
        `[clawbits/${ctx.accountId}] setAgentStatus(online) failed for ${msg.postId}: ${String((err as Error)?.message ?? err)}`,
      );
    }
  };

  // Idempotency guard for ``deliver``. OpenClaw's dispatch path can fire
  // the callback more than once per inbound (streaming intermediate
  // payload, delivery-queue retry, etc.). The first non-empty payload
  // patches the streaming draft and publishes it; an IDENTICAL later
  // payload is a queue retry and is dropped. A DISTINCT later payload is
  // content — a block-streaming host legitimately delivers a reply as
  // several payloads — so it posts as a follow-up message instead of
  // being silently dropped (which would truncate the reply to its first
  // block; LIVE_AGENT_ACTIVITY_PLAN §3.5).
  let delivered = false;
  let lastDeliveredBody: string | undefined;

  const deliver = async (payload: { text?: string; body?: string; [key: string]: unknown }) => {
    consoleErrorWithFile(
      `[clawbits/${ctx.accountId}] deliver invoked for ${msg.postId}: ${JSON.stringify(payload)}`,
    );
    pluginDebug(
      `Delivering. Clawbits reply pipeline reached the plugin — post=${msg.postId} draftPostId=${String(draftRef.id ?? "(none)")} payloadKeys=${JSON.stringify(Object.keys(payload ?? {}))}.`,
    );
    const rawBody =
      (typeof payload?.text === "string" && payload.text) ||
      (typeof payload?.body === "string" && payload.body) ||
      "";
    if (!rawBody) {
      pluginDebug(
        `deliver got EMPTY body for ${msg.postId} (payloadKeys=${JSON.stringify(Object.keys(payload ?? {}))}) — nothing to post`,
      );
      return;
    }
    const body = tagReplyBody(rawBody, msg.senderTag);
    if (!client || !answers) {
      logWarn(
        ctx.log,
        `[clawbits/${ctx.accountId}] deliver dropped reply for ${msg.postId}: gateway client/answers missing`,
      );
      return;
    }
    if (delivered) {
      if (body === lastDeliveredBody) {
        // Queue retry of the payload we already published — drop.
        pluginDebug(
          `Skipping duplicate deliver for ${msg.postId}: identical re-send.`,
        );
        return;
      }
      // Distinct continuation payload: post it as a follow-up so no text
      // is lost. Loud log — today's hosts run with block streaming off, so
      // seeing this means the host's dispatch behavior changed.
      consoleErrorWithFile(
        `[clawbits/${ctx.accountId}] deliver got a second DISTINCT payload for ${msg.postId} — posting follow-up instead of dropping (block-streamed host?)`,
      );
      await withChallenge(client, answers, (ans) =>
        mmTools.postToChannel(
          client,
          conversationId,
          {
            message: body,
            ...(msg.traceId ? { trace_id: msg.traceId } : {}),
          },
          ans,
        ),
      );
      lastDeliveredBody = body;
      setStatus?.({
        accountId: ctx.accountId,
        lastOutboundAt: Date.now(),
        lastError: null,
      });
      return;
    }
    // Claim the draft synchronously: once ``draftRef.id`` is cleared, the
    // outbound sendText path and the turn-end cleanup below both skip it.
    const draftPostId = draftRef.id;
    draftRef.id = undefined;
    if (draftPostId !== undefined) {
      // Finalise the streaming post in place — one PATCH replaces the
      // body, server flips ``status`` from streaming to published, and
      // the UI stops shimmering. Approval gating no longer applies to
      // the agent's reply (it now applies to inbound human messages),
      // so we always finalise to published.
      try {
        await realtimeTools.patchDraftPost(client, conversationId, draftPostId, {
          replace: body,
          done: true,
        });
      } catch (err) {
        logWarn(
          ctx.log,
          `[clawbits/${ctx.accountId}] patchDraftPost failed for ${msg.postId}: ${String((err as Error)?.message ?? err)} — falling back to single-POST delivery`,
        );
        await withChallenge(client, answers, (ans) =>
          mmTools.postToChannel(
            client,
            conversationId,
            {
              message: body,
              ...(msg.traceId ? { trace_id: msg.traceId } : {}),
              ...(attentionParentId !== undefined
                ? { parent_post_id: attentionParentId }
                : {}),
            },
            ans,
          ),
        );
      }
    } else {
      await withChallenge(client, answers, (ans) =>
        mmTools.postToChannel(
          client,
          conversationId,
          {
            message: body,
            ...(msg.traceId ? { trace_id: msg.traceId } : {}),
            ...(attentionParentId !== undefined
              ? { parent_post_id: attentionParentId }
              : {}),
          },
          ans,
        ),
      );
    }
    delivered = true;
    lastDeliveredBody = body;
    setStatus?.({
      accountId: ctx.accountId,
      lastOutboundAt: Date.now(),
      lastError: null,
    });
  };

  // Set right before the runtime dispatch; read in ``finally`` so the
  // ``agent_turn`` span fires on success and error alike. 0 until set.
  let dispatchSpanStart = 0;
  try {
    consoleErrorWithFile(
      `[clawbits/${ctx.accountId}] dispatchInboundDirectDmWithRuntime start post=${msg.postId}`,
    );
    setStatus?.({
      accountId: ctx.accountId,
      lastInboundAt: msg.createAt || Date.now(),
      lastError: null,
    });
    const { mediaContext, savedByFileId } = await saveInboundAttachmentsForAgent(ctx, msg, client);
    // Bracket the OpenClaw runtime turn (model inference + tool calls) — the
    // segment that is almost always the dominant cost of a slow reply and was
    // previously untimed. The plugin straddles both ends of the turn (this
    // dispatch in, the ``deliver`` callback out), so no OpenClaw-side change is
    // needed to measure it.
    dispatchSpanStart = Date.now();
    await withInboundDispatchGuard(dispatchGuardTarget, async () =>
      dispatchInboundDirectDmWithRuntime({
        cfg: ctx.cfg,
        runtime: { channel: runtime } as never,
        channel: CHANNEL_ID,
        channelLabel: CHANNEL_ID,
        accountId: ctx.accountId,
        peer: routePeer,
        senderId,
        senderAddress: senderAddr,
        recipientAddress: recipientAddr,
        conversationLabel: isDirectChannel
          ? `Clawbits DM ${conversationId}`
          : `Clawbits channel ${conversationId}`,
        rawBody: msg.text,
        // `rawBody` stays untouched (audit trail); `bodyForAgent` carries the
        // ClawBits preamble plus any attachment summary so the model knows
        // what environment it's in and what files came along. The hashed
        // per-chat session id lets the agent report a stable session id without
        // a tool call or exposing the raw channel id.
        bodyForAgent: buildAgentBody(
          effectiveText,
          msg.files,
          savedByFileId,
          clawbitsSessionId(conversationId),
          // Render the catch-up history directly into the agent's body. The
          // structured `InboundHistory` context field is capped at 20 entries and
          // framed as "untrusted, for context", so the agent treats it as
          // background and doesn't actually fold it into the reply. The body is
          // the agent's real input (proven by DMs), has no entry cap, and is what
          // the model acts on — so prior messages must go here to be used.
          msg.priorContext,
          msg.senderTag,
          msg.attention,
          // Name the agent to itself. Attention nudges fire partly on a
          // plain-text name reference, which the agent can't act on unless it
          // knows what it's called.
          ctx.account.agentId,
          // Boot catch-up: flips the history block from "do not reply to these"
          // to "these are unanswered, address them". Without it the recovered
          // messages reach the model under an explicit instruction to ignore
          // them, and the agent answers only the trigger.
          msg.catchUp,
        ),
        commandBody: effectiveText,
        commandAuthorized: isAuthorizedCommand ? true : undefined,
        messageId: msg.postId,
        timestamp: msg.createAt || Date.now(),
        provider: CHANNEL_ID,
        surface: CHANNEL_ID,
        originatingChannel: CHANNEL_ID,
        originatingTo: recipientAddr,
        extraContext: {
          ConversationId: conversationId,
          SenderId: msg.senderId,
          // Override the default ``"direct"`` ChatType for non-DM inbound so
          // the runner doesn't address the reply to the operator's DM peer
          // and instead funnels it back through our ``deliver`` callback,
          // which posts to ``msg.channelId`` (the originating channel).
          ChatType: isDirectChannel ? "direct" : "channel",
          ...(isAuthorizedCommand ? { CommandSource: "text" } : {}),
          ...(msg.senderTag ? { SenderTag: msg.senderTag } : {}),
          // NB: prior context is rendered into `bodyForAgent` above, not passed
          // as `InboundHistory`. Core caps `InboundHistory` at 20 entries and
          // labels it untrusted background, which the agent ignores — see the
          // buildAgentBody call above for the rationale.
          ...mediaContext,
        } as unknown as ChannelReplyDispatchContext,
        deliver,
        onRecordError: (err) => {
          logWarn(
            ctx.log,
            `[clawbits/${ctx.accountId}] inbound record error for ${msg.postId}: ${String(err)}`,
          );
        },
        onDispatchError: (err, info) => {
          logWarn(
            ctx.log,
            `[clawbits/${ctx.accountId}] reply dispatch error for ${msg.postId}: ${String(err)} (${JSON.stringify(info)})`,
          );
        },
      }),
    );
    consoleErrorWithFile(
      `[clawbits/${ctx.accountId}] dispatchInboundDirectDmWithRuntime done post=${msg.postId}`,
    );
  } catch (err) {
    consoleErrorWithFile(
      `[clawbits/${ctx.accountId}] inbound dispatch failed for ${msg.postId}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
    );
    setStatus?.({
      accountId: ctx.accountId,
      lastError: err instanceof Error ? err.message : String(err),
    });
    logWarn(
      ctx.log,
      `[clawbits/${ctx.accountId}] inbound dispatch failed for ${msg.postId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    // Tombstone the draft only when the dispatcher actually threw — i.e.
    // an error escaped runtime execution and we never reached a clean
    // deliver(). On normal completion the runner may legitimately choose
    // a silent reply; printing "reply failed to generate" there is a
    // false signal that confused operators (and made it look like the
    // agent posted two replies when a later inbound succeeded). A draft
    // already consumed by deliver/sendText (ref emptied) is left alone —
    // the reply went out before the turn errored.
    const tombstoneDraftId = draftRef.id;
    if (tombstoneDraftId !== undefined && client) {
      draftRef.id = undefined;
      try {
        await realtimeTools.patchDraftPost(client, conversationId, tombstoneDraftId, {
          replace: "_(reply failed to generate)_",
          done: true,
        });
      } catch (cleanupErr) {
        logWarn(
          ctx.log,
          `[clawbits/${ctx.accountId}] draft cleanup patch failed for ${msg.postId}: ${String((cleanupErr as Error)?.message ?? cleanupErr)}`,
        );
      }
    }
  } finally {
    // Stop the live-activity lanes FIRST: the patcher must not race the
    // draft cancel below, and the reporter must not land a late
    // "generating" activity after clearGenerating() flips status online.
    if (activityTurn) {
      finishStreaming(activityTurn);
      finishReporting(activityTurn);
      unregisterInFlightTurn(activityTurn);
    }
    // Per-turn outcome (dev-only). deliveredViaCallback=true → reply went via
    // deliver(); false + an "outbound.sendText" line → went via the codex
    // message-tool/outbound path; false + no send line → the agent produced no
    // reply (the shimmer draft is then cancelled below).
    pluginDebug(
      `inbound turn outcome post=${msg.postId}: deliveredViaCallback=${delivered} draftOpen=${draftRef.id !== undefined} chatType=${isDirectChannel ? "direct" : "channel"}`,
    );
    // Trace span: the OpenClaw runtime turn as observed by the plugin. Skipped
    // when the runtime never started (incomplete-runtime early return leaves
    // ``dispatchSpanStart`` at 0). Tagged with the same ``trace_id`` as the
    // inbound ``pickup_lag`` span so the collator lines them up in the
    // waterfall and the agent turn is isolated from the surrounding hops.
    if (dispatchSpanStart) {
      const turnEnd = Date.now();
      writeTraceSpan({
        trace_id: msg.traceId ?? null,
        span: "plugin.agent_turn",
        subsystem: "plugin",
        dur_ms: turnEnd - dispatchSpanStart,
        t_start_ms: dispatchSpanStart,
        t_end_ms: turnEnd,
        account_id: ctx.accountId,
        channel_id: msg.channelId,
        inbound_post_id: msg.postId,
        delivered_via_callback: delivered,
        chat_type: isDirectChannel ? "direct" : "channel",
      });
    }
    // If the dispatcher returned cleanly but never reached deliver()
    // (silent reply, runtime opted to skip, draft never patched), the
    // streaming draft would stay as an open shimmer forever. Cancel it
    // — the server deletes the row instead of publishing an empty post,
    // so the channel UI doesn't render a placeholder where the shimmer
    // used to be. The "failed to generate" tombstone in the catch
    // branch above still fires for real errors. A draft consumed by
    // deliver/sendText already left the ref empty, so nothing fires here.
    const leftoverDraftId = draftRef.id;
    if (leftoverDraftId !== undefined && client) {
      draftRef.id = undefined;
      try {
        await realtimeTools.patchDraftPost(client, conversationId, leftoverDraftId, {
          cancel: true,
        });
      } catch (cleanupErr) {
        logWarn(
          ctx.log,
          `[clawbits/${ctx.accountId}] draft silent-cancel failed for ${msg.postId}: ${String((cleanupErr as Error)?.message ?? cleanupErr)}`,
        );
      }
    }
    unregisterOpenDraft(ctx.accountId, conversationId, draftRef);
    await clearGenerating();
  }
}

export const gatewayAdapter: ChannelGatewayAdapter<ResolvedClawBitsAccount> = {
  async startAccount(ctx) {
    const account = ctx.account;
    consoleErrorWithFile(
      `[clawbits/${ctx.accountId}] gateway.startAccount enabled=${String(account.enabled)} configured=${String(account.configured)} channelId=${String(account.channelId ?? "")}`,
    );
    if (!account.enabled) {
      ctx.setStatus?.({
        accountId: ctx.accountId,
        running: false,
        lastError: "disabled",
      });
      logInfo(ctx.log, `[clawbits/${ctx.accountId}] gateway idle: account disabled`);
      return;
    }
    // ``channelId`` is no longer required — the poller iterates every
    // channel the agent is a member of via ``listChannels`` and falls
    // back to ``account.channelId`` only if the list call fails. We do
    // still need the agent identity + a usable API key.
    if (!account.configured || !account.apiKey || !account.agentId) {
      ctx.setStatus?.({
        accountId: ctx.accountId,
        running: false,
        lastError: "not fully configured",
      });
      logInfo(ctx.log, `[clawbits/${ctx.accountId}] gateway idle: account not fully configured`);
      return;
    }
    const client = buildClientForAccount(account);
    const answers = resolveKnownAnswers(account.knownAnswers);

    // Version handshake before we start polling. If the server reports
    // this plugin is below its minimum supported version, post a one-time
    // notice into the operator channel and refuse to start — the wire is
    // (or might be) incompatible, so the poller would just hammer 426s
    // and the operator would have no idea why.
    let versionVerdict: VersionCheckResponse | undefined;
    try {
      versionVerdict = await versionTools.versionCheck(client);
    } catch (err) {
      logWarn(
        ctx.log,
        `[clawbits/${ctx.accountId}] versionCheck call failed at startAccount: ${String((err as Error)?.message ?? err)}`,
      );
    }
    if (versionVerdict && !versionVerdict.supported) {
      if (account.channelId) {
        await postOutdatedNoticeOnce({
          client,
          accountId: ctx.accountId,
          channelId: account.channelId,
          answers,
          version: versionVerdict,
          log: ctx.log,
        });
      }
      ctx.setStatus?.({
        accountId: ctx.accountId,
        running: false,
        lastError:
          versionVerdict.message ?? "plugin is below the server's minimum",
      });
      logInfo(
        ctx.log,
        `[clawbits/${ctx.accountId}] gateway idle: plugin outdated (version=${versionVerdict.plugin_version ?? "?"} min=${versionVerdict.min_plugin_version})`,
      );
      return;
    }

    consoleErrorWithFile(
      `[clawbits/${ctx.accountId}] gateway starting poller for channel ${String(account.channelId)}`,
    );
    ctx.setStatus?.({
      accountId: ctx.accountId,
      running: true,
      lastError: null,
    });
    // Liveness pinger: marks the agent "Available" in Clawbits on a plain
    // timer, independent of the LLM heartbeat. Fire-and-forget — it shares the
    // poller's abort signal, self-heals on transient failures, and never
    // blocks or rejects, so it can't disturb the poller below.
    void runLivenessPinger({
      client,
      intervalMs: account.alivePingMs,
      abortSignal: ctx.abortSignal,
      accountId: ctx.accountId,
      log: ctx.log,
    });

    // Automations reconciler: converges the local gateway cron to the operator's
    // desired set in Clawbits and self-reports actual state. Fire-and-forget like
    // the liveness pinger (shares the abort signal, never throws). It manages cron
    // via the in-process getCron handle captured in the gateway_start hook, so it
    // idles harmlessly until that handle is available.
    void runAutomationsReconciler({
      client,
      abortSignal: ctx.abortSignal,
      accountId: ctx.accountId,
      ownerChannelId: account.channelId,
      log: ctx.log,
    });

    // AI-usage reporter: drains the in-process usage collector (fed by the
    // reply-dispatch / llm_output hooks registered in index.ts) and
    // self-reports token usage. Fire-and-forget like the pinger; telemetry-
    // class and billing-exempt server-side. On a multi-account gateway only
    // the first account's loop drains the shared queue.
    void runUsageReporter({
      client,
      abortSignal: ctx.abortSignal,
      accountId: ctx.accountId,
      log: ctx.log,
    });

    // Skills sync: converges the agent's skill directories to the desired set
    // and reports what is actually there. Single owner per gateway, since the
    // roots are shared across accounts.
    if (claimSkillsReporter(ctx.accountId)) {
      void runSkillsReporter({
        client,
        abortSignal: ctx.abortSignal,
        accountId: ctx.accountId,
        workspaceDir: getWorkspaceDir(),
        log: ctx.log,
      });
    }

    // Email ingestion runs alongside the chat poller. Fire-and-forget like the
    // liveness pinger: it shares the poller's abort signal, self-disables if the
    // server reports email is not configured (503), and never throws, so it
    // can't disturb the inbound poller below. Gated on the per-account flag
    // (default on; harmless on upgrade thanks to the 503 self-disable).
    //
    // Email and chat both dispatch into the owner's DM/main session. Concurrent
    // turns into the same session are serialized by core's session write-lock
    // (`acquireSessionWriteLock` in the embedded agent runner), so the two
    // pollers can't corrupt shared session state by running at once.
    if (account.emailEnabled) {
      void runEmailPoller({
        client,
        account,
        abortSignal: ctx.abortSignal,
        log: ctx.log,
        watermarkStore: channelWatermarkStore,
        onEmailMessage: (msg) =>
          dispatchInboundEmail(ctx, msg, {
            client,
            answers,
            setStatus: ctx.setStatus,
          }),
      });
    }

    // Inbound gating moved server-side: the agentic GET only returns
    // posts that have already been approved (or were authored by the
    // agent's own approver), so the poller can dispatch every mention
    // it sees without an explicit owner-author check.
    await runInboundPoller({
      client,
      account,
      abortSignal: ctx.abortSignal,
      log: ctx.log,
      watermarkStore: channelWatermarkStore,
      onInboundMessage: (msg) =>
        dispatchInboundMessage(ctx, msg, {
          client,
          answers,
          setStatus: ctx.setStatus,
          groupChannelShimmer: account.groupChannelShimmer,
        }),
    });
  },
};
