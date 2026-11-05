import type {
  ChannelOutboundAdapter,
  ChannelOutboundContext,
} from "openclaw/plugin-sdk/channel-contract";
import type { OutboundDeliveryResult } from "openclaw/plugin-sdk/channel-send-result";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import { CHANNEL_ID, resolveClawBitsAccount } from "./accounts.js";
import { resolveKnownAnswers, withChallenge } from "./challenge.js";
import { buildClientForAccount } from "./client-factory.js";
import { claimDraft, forgetOrphanDraft, openTurnContext, registerOpenDraft, type OpenDraftRef } from "./draft-registry.js";
import { ClawBitsError } from "./errors.js";
import { consoleErrorWithFile } from "./file-logger.js";
import { currentConfig } from "./model-choice.js";
import { uploadOutboundMedia } from "./outbound-media.js";
import {
  bindQuestion,
  markQuestionWaiting,
  questionEnded,
  questionFinalizing,
  questionSurface,
  unbindQuestion,
  type QuestionCard,
} from "./questions.js";
import type { SurfacePosted } from "./service-handoff.js";
import * as mmTools from "./tools/mattermost.js";
import * as realtimeTools from "./tools/realtime.js";
import type { AgentSurfaceCreate, ChannelPost } from "./types.js";
import { isGamePeerId } from "./widgets/session.js";

interface ResolvedSendTarget {
  account: ReturnType<typeof resolveClawBitsAccount>;
  client: ReturnType<typeof buildClientForAccount>;
  answers: Record<string, string>;
  channelId: string;
}

/**
 * Turn `ctx.to` into a channel id: a bare id or `clawbits:<id>` passes through, `channel:<id>`
 * unwraps to its room, and any other `kind:id` peer means the account's owner channel.
 */
function resolveSendTarget(ctx: Pick<ChannelOutboundContext, "cfg" | "accountId" | "to">): ResolvedSendTarget {
  const account = resolveClawBitsAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
  if (!account.enabled) {
    throw new ClawBitsError({ statusCode: 0, detail: "Clawbits account is disabled in config.", path: "/" });
  }
  const client = buildClientForAccount(account);
  const stripped = (typeof ctx.to === "string" ? ctx.to.trim() : "").replace(/^clawbits:/i, "");
  const channelPeer = /^channel:(.+)$/i.exec(stripped);
  const channelId = channelPeer
    ? channelPeer[1]
    : stripped && stripped.toLowerCase() !== "default" && !stripped.includes(":")
      ? stripped
      : account.channelId;
  if (!channelId) {
    throw new ClawBitsError({ statusCode: 0, detail: "No channelId configured and no explicit target supplied.", path: "/" });
  }
  if (isGamePeerId(channelId)) {
    const detail = "A Clawbits chat game turn posts nothing to chat.";
    throw new ClawBitsError({ statusCode: 0, detail, path: "/", message: detail });
  }
  return { account, client, answers: resolveKnownAnswers(account.knownAnswers), channelId };
}

/** One key per platform send of a durable intent: a replay returns the post the first try made. */
function sendKey(ctx: ChannelOutboundContext): Pick<ChannelPost, "client_key"> {
  return ctx.deliveryQueueId ? { client_key: `${ctx.deliveryQueueId}:${String(ctx.deliveryPartIndex ?? 0)}` } : {};
}

/** Tells the durable queue the recipient-visible send starts now, so an ack or replay knows it was attempted. */
async function handoff(ctx: ChannelOutboundContext): Promise<void> {
  await ctx.onPlatformSendDispatch?.();
  ctx.assertDirectAdapterHandoff?.();
}

function delivered(messageId: string, channelId: string): OutboundDeliveryResult {
  return { channel: CHANNEL_ID, messageId, target: { kind: "channel", id: channelId } };
}

/** A post made during a turn belongs to its reply: the same trace, under the same parent. */
function replyContext(turn: OpenDraftRef | undefined): Pick<ChannelPost, "trace_id" | "parent_post_id"> {
  return {
    ...(turn?.traceId ? { trace_id: turn.traceId } : {}),
    ...(turn?.parentPostId !== undefined ? { parent_post_id: turn.parentPostId } : {}),
  };
}

async function post(ctx: ChannelOutboundContext, target: ResolvedSendTarget, body: ChannelPost): Promise<OutboundDeliveryResult> {
  const { account, client, answers, channelId } = target;
  const turn = openTurnContext(account.accountId, channelId);
  await handoff(ctx);
  const posted = (await withChallenge(client, answers, (ans) =>
    mmTools.postToChannel(client, channelId, { ...body, ...replyContext(turn) }, ans),
  )) as { post_id?: string | number };
  return delivered(posted?.post_id == null ? "" : String(posted.post_id), channelId);
}

/** A 422's errors as the server lists them (`{"detail": [...]}`), for the agent to fix. */
function rejected(detail: unknown): unknown[] {
  try {
    const body = JSON.parse(String(detail)) as { detail?: unknown };
    return Array.isArray(body.detail) ? body.detail : [body.detail ?? detail];
  } catch {
    return [detail];
  }
}

/** Posts an agent's UI block in a chat (the companion's `clawbits_ui`, through the handoff). In a
 *  turn whose draft is open, the reply so far stays above the block and the rest continues below. */
export async function postSurface(
  accountId: string,
  channelId: string,
  surface: AgentSurfaceCreate,
): Promise<SurfacePosted> {
  const cfg = currentConfig();
  if (!cfg) throw new Error("The Clawbits channel has no config to post with.");
  const target = resolveSendTarget({ cfg, accountId, to: channelId });
  const { account, client, answers } = target;
  const turn = openTurnContext(account.accountId, target.channelId);
  let posted: { post_id: number };
  try {
    posted = (await withChallenge(client, answers, (ans) =>
      mmTools.postToChannel(client, target.channelId, { surface, ...replyContext(turn) }, ans),
    )) as { post_id: number };
  } catch (err) {
    if (err instanceof ClawBitsError && err.statusCode === 422) return { errors: rejected(err.detail) };
    throw err;
  }
  if (turn && (await endDraft(target, turn))) await openDraft(target, turn);
  return { post_id: posted.post_id };
}

const warn = (accountId: string, what: string) => (err: unknown): undefined => {
  consoleErrorWithFile(`[clawbits/${accountId}] ${what}: ${err instanceof Error ? err.message : String(err)}`);
};

/** Ends the turn's draft with what streamed into it (cancelled when nothing did), as the post just made
 *  moves the rest of the turn below it. False when the turn had no draft open. */
async function endDraft({ account, client, channelId }: ResolvedSendTarget, turn: OpenDraftRef): Promise<boolean> {
  const previous = turn.id;
  if (previous === undefined) return false;
  turn.id = undefined;
  forgetOrphanDraft(account.accountId, channelId);
  const ending = await turn.handOver?.();
  await realtimeTools
    .patchDraftPost(client, channelId, previous, ending ? { ...ending, done: true } : { cancel: true })
    .catch(warn(account.accountId, `draft ${String(previous)} not ended`));
  return true;
}

/** Opens a fresh draft below the last post for the rest of the turn and its final reply; cancelled at
 *  once when the turn ended meanwhile, so no draft outlives it. */
async function openDraft({ account, client, channelId }: ResolvedSendTarget, turn: OpenDraftRef): Promise<void> {
  const next = await realtimeTools
    .createDraftPost(client, channelId, turn.traceId, turn.parentPostId)
    .then(({ post_id }) => post_id, warn(account.accountId, "no draft opened"));
  if (next === undefined) return;
  if (openTurnContext(account.accountId, channelId) !== turn) {
    await realtimeTools
      .patchDraftPost(client, channelId, next, { cancel: true })
      .catch(warn(account.accountId, `draft ${String(next)} not cancelled`));
    return;
  }
  turn.id = next;
  registerOpenDraft(account.accountId, channelId, turn);
}

type PayloadContext = Parameters<NonNullable<ChannelOutboundAdapter["sendPayload"]>>[0];

/**
 * Posts an ask_user prompt as its card, or as its text when there is no card or the server refuses it,
 * and the chat waits on the question. The turn's draft ends above it and no new one opens, so nothing
 * works below a question while it waits. When core finalizes the question, a card closes with core's
 * status line and the rest of the turn continues in a fresh draft.
 */
async function postQuestion(ctx: PayloadContext, questionId: string, card: QuestionCard | undefined): Promise<OutboundDeliveryResult> {
  const target = resolveSendTarget(ctx);
  const { account, client, channelId } = target;
  const turn = openTurnContext(account.accountId, channelId);
  const drafted = turn?.id !== undefined;
  const key = sendKey(ctx);
  const carded = card && (await post(ctx, target, { surface: card.surface, ...key }).catch((err: unknown) => {
    if (!(err instanceof ClawBitsError && err.statusCode === 422)) throw err;
    consoleErrorWithFile(
      `[clawbits/${account.accountId}] question ${questionId} sent as text, its card was refused: ${JSON.stringify(rejected(err.detail))}`,
    );
    return undefined;
  }));
  const sent = carded ?? (await post(ctx, target, { message: card?.fallback ?? ctx.payload.text ?? ctx.text ?? "", ...key }));
  const postId = sent.messageId;
  if (carded) {
    await bindQuestion(account.accountId, postId, { channelId, questionId });
    questionFinalizing(account.accountId, postId, true);
  }
  markQuestionWaiting(account.accountId, channelId, questionId);
  if (turn) await endDraft(target, turn);
  await realtimeTools
    .setAgentStatus(client, channelId, "online")
    .catch(warn(account.accountId, `status not cleared for question ${questionId}`));
  questionGatewayRuntime.registerChannelDelivery({
    questionId,
    deliveryId: postId,
    finalize: async (statusLine) => {
      questionEnded(account.accountId, channelId, questionId);
      if (carded) {
        questionFinalizing(account.accountId, postId, false);
        await mmTools.closeSurface(client, postId, statusLine).catch(warn(account.accountId, `question card ${postId} not closed`));
        await unbindQuestion(account.accountId, postId);
      }
      if (turn && drafted) await openDraft(target, turn);
    },
  });
  return sent;
}

export const outboundAdapter = {
  deliveryMode: "direct",
  textChunkLimit: 4000,
  presentationCapabilities: { supported: true, buttons: true },
  /** Only core's ask_user prompts become cards; anything else renders as core's text. */
  renderPresentation: ({ payload, presentation }) => {
    const questionId = questionGatewayRuntime.readAskUserQuestionId(payload);
    const card = questionId ? questionSurface(presentation) : null;
    return questionId && card
      ? { ...payload, channelData: { ...payload.channelData, clawbits: { questionId, ...card } satisfies QuestionCard } }
      : null;
  },
  async sendPayload(ctx: PayloadContext): Promise<OutboundDeliveryResult> {
    const questionId = questionGatewayRuntime.readAskUserQuestionId(ctx.payload);
    if (questionId) return await postQuestion(ctx, questionId, ctx.payload.channelData?.["clawbits"] as QuestionCard | undefined);
    const mediaUrl = ctx.mediaUrl ?? ctx.payload.mediaUrls?.[0];
    return mediaUrl ? await outboundAdapter.sendMedia({ ...ctx, mediaUrl }) : await outboundAdapter.sendText(ctx);
  },
  async sendText(ctx: ChannelOutboundContext): Promise<OutboundDeliveryResult> {
    const target = resolveSendTarget(ctx);
    const { account, client, channelId } = target;
    const text = ctx.text ?? "";
    const key = sendKey(ctx);
    const draft = await claimDraft(account.accountId, channelId);
    if (draft) {
      const patch = { replace: text, done: true, ...(await draft.finish), ...key };
      await handoff(ctx);
      try {
        await realtimeTools.patchDraftPost(client, channelId, draft.id, patch);
        return delivered(String(draft.id), channelId);
      } catch (err) {
        consoleErrorWithFile(
          `[clawbits/${account.accountId}] outbound.sendText draft ${String(draft.id)} not finalized: ${err instanceof Error ? err.message : String(err)}; posting instead`,
        );
      }
    }
    return await post(ctx, target, { message: text, ...key });
  },

  async sendMedia(ctx: ChannelOutboundContext): Promise<OutboundDeliveryResult> {
    const target = resolveSendTarget(ctx);
    const { account, client, answers, channelId } = target;
    const draft = await claimDraft(account.accountId, channelId);
    if (draft) {
      await realtimeTools.patchDraftPost(client, channelId, draft.id, { cancel: true }).catch((err: unknown) =>
        consoleErrorWithFile(
          `[clawbits/${account.accountId}] outbound.sendMedia draft ${String(draft.id)} not cancelled: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
    let fileId: string;
    try {
      fileId = await uploadOutboundMedia({ client, answers, channelId, ctx });
    } catch (err) {
      const mediaUrl = ctx.mediaUrl ?? "";
      if (!/^https:\/\//i.test(mediaUrl)) throw err;
      return await post(ctx, target, { message: ctx.text ? `${ctx.text}\n${mediaUrl}` : mediaUrl, ...sendKey(ctx) });
    }
    return await post(ctx, target, { message: ctx.text ?? "", file_ids: [fileId], ...sendKey(ctx) });
  },
} satisfies ChannelOutboundAdapter;
