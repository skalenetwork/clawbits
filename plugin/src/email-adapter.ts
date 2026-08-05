// Email inbound dispatch: forward one fetched email into OpenClaw's reply
// pipeline as a turn in the owner's session, and route the agent's reply back
// over email (POST /email/send) via the `deliver` callback.
//
// This is the email analogue of `dispatchInboundMessage` in `gateway-adapter.
// ts`, but simpler: email has no Mattermost streaming-draft / shimmer surface,
// so there is no pre-open / patch / cancel dance — just dispatch and deliver.
//
// Per the user's design, email lands in the owner's main DM session (a
// `direct` peer collapses to the agent's DM/main session per session.dmScope),
// so the agent sees email and chat in one conversation. The explicit
// `send_email` action (channel-actions.ts) is the guaranteed email path; the
// auto reply-as-email here is best-effort for replies that flow through the
// buffered-block dispatcher's `deliver` callback.

import type { ChannelGatewayContext } from "openclaw/plugin-sdk/core";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";
import { CHANNEL_ID } from "./accounts.js";
import { buildAgentBody, clawbitsSessionId, formatBytes, type SavedInboundMedia } from "./agent-body.js";
import { CLAWBITS_ATTACHMENT_MAX_BYTES } from "./attachments.js";
import { withChallenge } from "./challenge.js";
import type { ClawBitsClient } from "./client.js";
import { frameEmailForDm } from "./email-dm-frame.js";
import type { EmailInboundMessage } from "./email-poller.js";
import { consoleErrorWithFile, logWarn } from "./file-logger.js";
import {
  resolveInboundDispatchGuardTarget,
  withInboundDispatchGuard,
} from "./inbound-dispatch-guard.js";
import * as emailTools from "./tools/email.js";
import * as mmTools from "./tools/mattermost.js";
import type { ResolvedClawBitsAccount } from "./types.js";

// Email attachments share the channel's media cap; alias keeps the call sites
// readable while the value lives in one place (`attachments.ts`).
const EMAIL_ATTACHMENT_MAX_BYTES = CLAWBITS_ATTACHMENT_MAX_BYTES;

export interface DispatchInboundEmailDeps {
  /** Authenticated Clawbits client used for the send-back deliver callback. */
  client?: ClawBitsClient;
  /** Known challenge answers to satisfy the paid /email/send POST. */
  answers?: Record<string, string>;
  /** Status sink so email activity shows up in channels.status. */
  setStatus?: ChannelGatewayContext<ResolvedClawBitsAccount>["setStatus"];
}

interface AgentMediaContext {
  MediaPath?: string;
  MediaType?: string;
  MediaUrl?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
}

function buildMediaContext(saved: readonly SavedInboundMedia[]): AgentMediaContext {
  if (saved.length === 0) return {};
  const paths = saved.map((m) => m.path);
  const types = saved.map((m) => m.contentType).filter((v): v is string => Boolean(v));
  return {
    MediaPath: saved[0]?.path,
    MediaType: saved[0]?.contentType,
    MediaUrl: saved[0]?.path,
    MediaPaths: paths,
    MediaUrls: paths,
    MediaTypes: types.length > 0 ? types : undefined,
  };
}

/** Decode each inline base64 attachment and persist it to the host media store
 *  via the same `runtime.media.saveMediaBuffer` seam `attachments.ts` uses. */
async function saveEmailAttachments(
  ctx: ChannelGatewayContext<ResolvedClawBitsAccount>,
  email: EmailInboundMessage,
): Promise<{ mediaContext: AgentMediaContext; saved: SavedInboundMedia[]; lines: string[] }> {
  const atts = email.attachments ?? [];
  if (atts.length === 0) return { mediaContext: {}, saved: [], lines: [] };

  const runtime = ctx.channelRuntime as { media?: { saveMediaBuffer?: unknown } } | undefined;
  const saveMediaBuffer = runtime?.media?.saveMediaBuffer;
  const saved: SavedInboundMedia[] = [];
  const lines: string[] = [];
  let idx = 0;
  for (const att of atts) {
    idx += 1;
    const filename = att.filename || `attachment-${idx}`;
    const contentType = att.content_type || "application/octet-stream";
    let bytes: Buffer | undefined;
    try {
      bytes = Buffer.from(att.content_b64 ?? "", "base64");
    } catch {
      bytes = undefined;
    }
    const size = att.size ?? bytes?.byteLength ?? 0;
    if (!bytes || bytes.byteLength === 0) {
      lines.push(`- ${filename} (${contentType}): (could not decode attachment)`);
      continue;
    }
    if (bytes.byteLength > EMAIL_ATTACHMENT_MAX_BYTES) {
      lines.push(`- ${filename} (${contentType}, ${formatBytes(size)}): too large to attach`);
      continue;
    }
    if (typeof saveMediaBuffer !== "function") {
      // No media runtime (e.g. tests / non-gateway load) — surface a labelled
      // line so the agent still knows an attachment came along.
      lines.push(`- ${filename} (${contentType}, ${formatBytes(size)}): received (media store unavailable)`);
      continue;
    }
    try {
      const result = await (saveMediaBuffer as (
        buf: Buffer,
        contentType: string,
        kind: string,
        maxBytes: number,
        filename: string,
      ) => Promise<{ path?: unknown; contentType?: unknown }>)(
        bytes,
        contentType,
        "inbound",
        EMAIL_ATTACHMENT_MAX_BYTES,
        filename,
      );
      const path = result && typeof result.path === "string" ? result.path : undefined;
      if (!path) {
        lines.push(`- ${filename} (${contentType}, ${formatBytes(size)}): received`);
        continue;
      }
      saved.push({
        fileId: `email-${email.uid}-${idx}`,
        path,
        contentType: typeof result.contentType === "string" ? result.contentType : contentType,
      });
      lines.push(`- ${filename} (${contentType}, ${formatBytes(size)}): saved as inbound media`);
    } catch (err) {
      logWarn(
        ctx.log,
        `[clawbits/${ctx.accountId}] email attachment ${filename} not saved for uid ${email.uid}: ${String((err as Error)?.message ?? err)}`,
      );
      lines.push(`- ${filename} (${contentType}, ${formatBytes(size)}): received (not saved)`);
    }
  }
  return { mediaContext: buildMediaContext(saved), saved, lines };
}

/** Prefix a subject with "Re: " unless it already carries one. */
export function replySubject(subject: string): string {
  const s = (subject || "").trim();
  if (!s) return "Re: (no subject)";
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/** Extract the bare address from a `Name <addr>` (or plain) header, lowercased. */
function extractAddress(raw: string): string {
  const s = (raw || "").trim();
  const angle = /<([^>]+)>/.exec(s);
  return (angle ? angle[1] : s).trim().toLowerCase();
}

/** Case-insensitive header lookup (mailers vary the casing of `Message-ID`). */
function findHeader(headers: Record<string, string>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want && typeof v === "string" && v.trim().length > 0) {
      return v.trim();
    }
  }
  return undefined;
}

/** Build threading headers so the owner's mail client groups the reply with the
 *  original. Derived from the inbound `Message-ID`; omitted when absent. */
export function buildReplyThreadingHeaders(
  email: EmailInboundMessage,
): Record<string, string> | undefined {
  const messageId = findHeader(email.headers ?? {}, "message-id");
  if (!messageId) return undefined;
  return { "In-Reply-To": messageId, References: messageId };
}

/** True when the inbound mail is from the agent's own mailbox (a loop). The
 *  agent mails only its owner, so a message whose sender equals the recipient
 *  mailbox can only be the agent's own output bouncing back — never auto-reply
 *  to it. */
export function isSelfAddressed(email: EmailInboundMessage, agentId: string): boolean {
  const from = extractAddress(email.fromAddr);
  if (!from) return false;
  const to = extractAddress(email.toAddr);
  if (to && from === to) return true;
  // Fall back to the local-part vs agentId check when the recipient header is
  // missing/odd but the sender is clearly this agent's address.
  const localPart = from.split("@")[0];
  return localPart.length > 0 && localPart === agentId.toLowerCase();
}

/** Accumulator that reconstructs the agent's full reply from the buffered-block
 *  dispatcher's `deliver` callback, which can fire once per coalesced block
 *  (and may also emit a final payload that repeats the blocks). We keep distinct
 *  segments and let a superset payload (the final full body) replace earlier
 *  blocks, so the resulting email is the complete reply with no duplication. */
class ReplyAccumulator {
  private segments: string[] = [];

  add(text: string): void {
    const t = (text || "").trim();
    if (!t) return;
    const combined = this.segments.join("\n\n");
    const nt = collapseWhitespace(t);
    if (!nt) return;
    const nc = collapseWhitespace(combined);
    // Already captured (exact block or a duplicate/retry of the same text).
    if (nc.length > 0 && nc.includes(nt)) return;
    // New text is a superset of everything so far (final repeats the blocks) —
    // collapse to the single authoritative body.
    if (nc.length > 0 && nt.includes(nc)) {
      this.segments = [t];
      return;
    }
    this.segments.push(t);
  }

  body(): string {
    return this.segments.join("\n\n").trim();
  }
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, "");
}

/** Assemble the agent-facing email turn body (without the Clawbits preamble,
 *  which `buildAgentBody` adds). */
export function buildEmailTurnText(email: EmailInboundMessage, attachmentLines: string[]): string {
  const header = [
    "[Email received]",
    "You just received a new email in your Clawbits mailbox. To respond reliably,",
    "use the message tool's `send_email` action (it always goes to your owner).",
    "Simply replying to this message also emails your owner, but that path is",
    "best-effort.",
    `From: ${email.fromAddr || "(unknown)"}`,
    `To: ${email.toAddr || "(you)"}`,
    `Subject: ${email.subject || "(no subject)"}`,
    `Date: ${email.date || "(unknown)"}`,
    "[end Email received]",
  ].join("\n");
  const body = email.bodyText && email.bodyText.trim().length > 0
    ? email.bodyText
    : "(no text body)";
  const attachments =
    attachmentLines.length > 0
      ? ["", "[Attachments]", ...attachmentLines, "[end Attachments]"].join("\n")
      : "";
  return `${header}\n\n${body}${attachments}`;
}

/**
 * Forward one email into OpenClaw's reply pipeline and route the reply back
 * over email. Mirrors the runtime-surface checks in `dispatchInboundMessage`
 * so a non-gateway load (tests) short-circuits cleanly.
 */
export async function dispatchInboundEmail(
  ctx: ChannelGatewayContext<ResolvedClawBitsAccount>,
  email: EmailInboundMessage,
  deps: DispatchInboundEmailDeps = {},
): Promise<void> {
  const { client, answers, setStatus } = deps;
  const agentId = ctx.account.agentId;
  consoleErrorWithFile(
    `[clawbits/${ctx.accountId}] dispatchInboundEmail uid=${email.uid} from=${JSON.stringify(email.fromAddr)} subject=${JSON.stringify(email.subject)} attachments=${email.attachments.length}`,
  );

  // Loop guard: never inject or auto-reply to mail the agent appears to have
  // sent itself. The poller still advances its watermark past this uid, so the
  // message is simply dropped, not retried.
  if (agentId && isSelfAddressed(email, agentId)) {
    logWarn(
      ctx.log,
      `[clawbits/${ctx.accountId}] dropping self-addressed email uid ${email.uid} from ${email.fromAddr}`,
    );
    return;
  }

  const runtime = ctx.channelRuntime as {
    routing?: unknown;
    session?: unknown;
    reply?: unknown;
  } | undefined;
  const replySurface = runtime?.reply as {
    dispatchReplyWithBufferedBlockDispatcher?: unknown;
  } | undefined;
  if (
    !runtime?.routing ||
    !runtime?.session ||
    !runtime?.reply ||
    typeof replySurface?.dispatchReplyWithBufferedBlockDispatcher !== "function"
  ) {
    logWarn(
      ctx.log,
      `[clawbits/${ctx.accountId}] channel runtime incomplete; dropped inbound email uid ${email.uid}`,
    );
    return;
  }

  // Owner DM session: a direct peer collapses to the agent's DM/main session,
  // so email shares the owner's chat conversation. The conversation id mirrors
  // the operator DM channel when known so the hashed session id matches.
  const conversationId = ctx.account.channelId ?? `email:${ctx.accountId}`;
  const senderId = email.fromAddr || "owner";
  const senderAddr = `clawbits:${senderId}`;
  const routePeer: { kind: "direct"; id: string } = { kind: "direct", id: senderId };
  const dispatchGuardTarget = resolveInboundDispatchGuardTarget({
    cfg: ctx.cfg,
    runtime,
    channel: CHANNEL_ID,
    accountId: ctx.accountId,
    peer: routePeer,
  });

  // TEMPORARY: mirror email activity into the operator DM channel so the owner
  // sees it in chat. Email otherwise round-trips email->email and never touches
  // the DM surface (see this function's header). Best-effort: a failed mirror
  // never blocks inbound dispatch or the reply. Posts are authored by the agent,
  // so the chat inbound poller's self-echo filter (inbound-poller.ts:
  // `post.user_id === account.agentId`) drops them — no re-ingestion loop.
  const dmChannelId = ctx.account.channelId;
  const mirrorToDm = async (text: string): Promise<void> => {
    if (!dmChannelId || !client || !answers) return;
    try {
      await withChallenge(client, answers, (answer) =>
        mmTools.postToChannel(client, dmChannelId, { message: text }, answer),
      );
    } catch (err) {
      logWarn(
        ctx.log,
        `[clawbits/${ctx.accountId}] email->DM mirror failed for uid ${email.uid}: ${String((err as Error)?.message ?? err)}`,
      );
    }
  };

  const { mediaContext, lines } = await saveEmailAttachments(ctx, email);
  const turnText = buildEmailTurnText(email, lines);

  // Mirror the inbound email into the DM right away (temporary; see above).
  // Fire-and-forget so the cosmetic mirror never delays the agent's turn; the
  // reply mirror below lands much later, so chat order stays inbound-then-reply.
  void mirrorToDm(
    frameEmailForDm({
      kind: "received",
      fromAddr: email.fromAddr || "(unknown)",
      subject: email.subject,
      body: email.bodyText,
      footerLines: lines.length > 0 ? ["**Attachments:**", ...lines] : undefined,
    }),
  );
  const bodyForAgent = buildAgentBody(
    turnText,
    undefined,
    undefined,
    clawbitsSessionId(conversationId),
    undefined,
    undefined,
    undefined,
    ctx.account.agentId,
  );

  // The buffered-block dispatcher can call `deliver` several times for one turn
  // (one coalesced block at a time, plus possibly a final repeat). Accumulate
  // the pieces and send ONE email after dispatch settles, so a long reply isn't
  // truncated to its first block (chat sends N messages; email wants one).
  const reply = new ReplyAccumulator();
  const deliver = async (payload: { text?: string; body?: string; [key: string]: unknown }) => {
    const rawBody =
      (typeof payload?.text === "string" && payload.text) ||
      (typeof payload?.body === "string" && payload.body) ||
      "";
    if (rawBody) reply.add(rawBody);
  };

  let sent = false;
  const sendConsolidatedReply = async () => {
    if (sent) return;
    const message = reply.body();
    if (!message) return;
    if (!client || !answers || !agentId) {
      logWarn(
        ctx.log,
        `[clawbits/${ctx.accountId}] email reply dropped for uid ${email.uid}: client/answers/agentId missing`,
      );
      return;
    }
    const threadingHeaders = buildReplyThreadingHeaders(email);
    try {
      await withChallenge(client, answers, (answer) =>
        emailTools.emailSend(
          client,
          agentId,
          {
            subject: replySubject(email.subject),
            message,
            ...(threadingHeaders ? { headers: threadingHeaders } : {}),
          },
          answer,
        ),
      );
      sent = true;
      setStatus?.({ accountId: ctx.accountId, lastOutboundAt: Date.now(), lastError: null });
    } catch (err) {
      const detail = String((err as Error)?.message ?? err);
      setStatus?.({ accountId: ctx.accountId, lastError: detail });
      logWarn(
        ctx.log,
        `[clawbits/${ctx.accountId}] email reply send failed for uid ${email.uid}: ${detail}`,
      );
    }
  };

  try {
    setStatus?.({ accountId: ctx.accountId, lastInboundAt: Date.now(), lastError: null });
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
        recipientAddress: senderAddr,
        conversationLabel: `Clawbits email ${email.fromAddr || conversationId}`,
        rawBody: email.bodyText ?? "",
        bodyForAgent,
        messageId: `email-${email.uid}`,
        timestamp: Date.now(),
        provider: CHANNEL_ID,
        surface: CHANNEL_ID,
        originatingChannel: CHANNEL_ID,
        originatingTo: senderAddr,
        extraContext: {
          ConversationId: conversationId,
          SenderId: senderId,
          ChatType: "direct",
          EmailUid: email.uid,
          EmailFrom: email.fromAddr,
          EmailSubject: email.subject,
          ...mediaContext,
        } as Record<string, unknown>,
        deliver,
        onRecordError: (err) => {
          logWarn(
            ctx.log,
            `[clawbits/${ctx.accountId}] email inbound record error uid ${email.uid}: ${String(err)}`,
          );
        },
        onDispatchError: (err, info) => {
          logWarn(
            ctx.log,
            `[clawbits/${ctx.accountId}] email reply dispatch error uid ${email.uid}: ${String(err)} (${JSON.stringify(info)})`,
          );
        },
      }),
    );
  } catch (err) {
    setStatus?.({ accountId: ctx.accountId, lastError: err instanceof Error ? err.message : String(err) });
    logWarn(
      ctx.log,
      `[clawbits/${ctx.accountId}] email inbound dispatch failed for uid ${email.uid}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Send the agent's reply as a single email once the turn has settled. Runs
  // even if dispatch threw partway, so any reply produced before the error is
  // still delivered (best-effort, mirrors the prior per-block behaviour).
  await sendConsolidatedReply();

  // TEMPORARY: mirror the reply we actually emailed into the DM too, so the
  // owner sees the response in chat alongside the inbound message above. Only
  // when an email was genuinely sent, so the DM matches what went out.
  if (sent) {
    const replyBody = reply.body();
    if (replyBody) {
      await mirrorToDm(
        frameEmailForDm({ kind: "reply_sent", subject: replySubject(email.subject), body: replyBody }),
      );
    }
  }
}
