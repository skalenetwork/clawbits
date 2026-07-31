import { createHash } from "node:crypto";
import type {
  ChannelOutboundAdapter,
  ChannelOutboundContext,
  OutboundDeliveryResult,
} from "openclaw/plugin-sdk/core";
import { CHANNEL_ID, resolveClawBitsAccount } from "./accounts.js";
import { resolveKnownAnswers, withChallenge } from "./challenge.js";
import { buildClientForAccount } from "./client-factory.js";
import { claimOpenDraft } from "./draft-registry.js";
import { ClawBitsError } from "./errors.js";
import { consoleErrorWithFile, pluginDebug } from "./file-logger.js";
import { uploadOutboundMedia } from "./outbound-media.js";
import * as mmTools from "./tools/mattermost.js";
import * as realtimeTools from "./tools/realtime.js";

// ---------------------------------------------------------------------------
// Outbound idempotency
// ---------------------------------------------------------------------------
//
// OpenClaw's durable outbound delivery is *best effort*: a send whose outcome
// can't be confirmed (slow/flaky server, a "partial delivery failure" on any
// payload in the batch) is re-attempted, and a DM reply is routed through this
// adapter rather than the idempotent draft `deliver` path that channels use.
// Because `postToChannel` mints a brand-new post on every call, each re-attempt
// used to surface as a *duplicate reply* — and the longer a turn took to settle
// (the shimmer staying open), the more copies landed (observed: one DM "test"
// producing 7 identical posts).
//
// Collapse those re-sends: remember the post we minted for a given
// (account, channel, replyTo, text) and, within a short window, return that
// same result instead of posting again. Returning success (not throwing) also
// lets the delivery layer ACK the queue entry, so the retry loop stops on the
// next attempt instead of running to its retry budget.
//
// Keyed on the message body (+ reply target when the host threads one) so only
// true resends of the *same* payload collapse; two genuinely different replies
// — even back-to-back — produce different keys and both post. The DM message
// tool does not currently set `replyToId`, so the body hash is what collapses
// the burst; the TTL is sized to the in-process retry window (the durable
// queue's tighter retries) and short enough that an intentional identical reply
// minutes later is not suppressed.
const DEDUP_TTL_MS = 5 * 60_000;
const DEDUP_MAX_ENTRIES = 500;
const recentSends = new Map<string, { result: OutboundDeliveryResult; ts: number }>();

function recentSendKey(parts: {
  accountId: string;
  channelId: string;
  replyToId: string;
  text: string;
}): string {
  const textHash = createHash("sha256").update(parts.text).digest("hex").slice(0, 32);
  // NUL separators: never appear in ids/hashes, so keys can't collide across
  // parts (e.g. a channel id ending where a hash begins).
  return `${parts.accountId}\u0000${parts.channelId}\u0000${parts.replyToId}\u0000${textHash}`;
}

/** Drop entries past their TTL, then bound total size (oldest-first). */
function pruneRecentSends(now: number): void {
  for (const [key, entry] of recentSends) {
    if (now - entry.ts > DEDUP_TTL_MS) recentSends.delete(key);
  }
  while (recentSends.size > DEDUP_MAX_ENTRIES) {
    const oldest = recentSends.keys().next();
    if (oldest.done) break;
    recentSends.delete(oldest.value);
  }
}

/** Test seam: clear the in-process dedup cache between cases. */
export function __resetOutboundDedupeForTest(): void {
  recentSends.clear();
}

interface ResolvedSendTarget {
  account: ReturnType<typeof resolveClawBitsAccount>;
  client: ReturnType<typeof buildClientForAccount>;
  answers: Record<string, string>;
  channelId: string;
  rawTo: string;
  looksLikePeer: boolean;
}

/**
 * Shared front half of every outbound send: resolve the account, build the
 * API client, and turn ``ctx.to`` into a real Mattermost channel id.
 *
 * `to` is normally a Mattermost channel id (post-resolveTarget) or the
 * sentinel `default`. We pass any explicit non-default value through —
 * Mattermost itself validates whether the id exists. The one shape we
 * *do* intercept is a peer address like `clawbits:human:3` (the sender
 * peer from session deliveryContext, forwarded raw by the message tool
 * when `messaging.targetResolver.resolveTarget` hasn't run for some
 * reason): we strip the optional provider prefix, and if what's left
 * still looks like a `kind:id` peer rather than a channel id, fall back
 * to the configured channel. Clawbits accounts are 1-channel-per-
 * account, so a peer address always means "the owner channel for this
 * account". Without this guard, a peer-shaped `to` would POST to a
 * nonexistent Mattermost channel and the reply would 404 silently.
 */
function resolveSendTarget(ctx: ChannelOutboundContext): ResolvedSendTarget {
  const account = resolveClawBitsAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
  if (!account.enabled) {
    throw new ClawBitsError({
      statusCode: 0,
      detail: "Clawbits account is disabled in config.",
      path: "/",
    });
  }
  const client = buildClientForAccount(account);
  const answers = resolveKnownAnswers(account.knownAnswers);

  const rawTo = typeof ctx.to === "string" ? ctx.to.trim() : "";
  const stripped = rawTo.replace(/^clawbits:/i, "");
  // A ``channel:<id>`` peer (how a shared-channel reply target is shaped when
  // resolveTarget passes the route peer through raw) names a real Mattermost
  // channel — unwrap it to that id so the reply lands in the room. Other peer
  // kinds (``user:``/``human:``, i.e. a DM peer) still fall back to the
  // configured channel, which for a 1-channel-per-account DM IS the owner
  // channel. Without the unwrap, a ``channel:`` target would hit the fallback
  // and post the channel's reply into the owner DM instead.
  const channelPeer = /^channel:(.+)$/i.exec(stripped);
  const looksLikePeer = stripped.includes(":");
  const channelId = channelPeer
    ? channelPeer[1]
    : stripped && stripped.toLowerCase() !== "default" && !looksLikePeer
      ? stripped
      : account.channelId;
  if (!channelId) {
    throw new ClawBitsError({
      statusCode: 0,
      detail: "No channelId configured and no explicit target supplied.",
      path: "/",
    });
  }
  return { account, client, answers, channelId, rawTo, looksLikePeer };
}

export const outboundAdapter: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  textChunkLimit: 4000,
  async sendText(ctx: ChannelOutboundContext): Promise<OutboundDeliveryResult> {
    // Entry checkpoint (dev-only). This is the path a codex-harness reply takes
    // (agent `tools.message({action:"send"})` → messageAdapter → here).
    pluginDebug(
      `outbound.sendText ENTER account=${String(ctx.accountId ?? "(default)")} to=${JSON.stringify(ctx.to)} bytes=${ctx.text?.length ?? 0}`,
    );
    const { account, client, answers, channelId, rawTo, looksLikePeer } =
      resolveSendTarget(ctx);

    // Idempotency: if we already minted a post for this exact reply (same
    // account/channel/replyTo/body) within the dedup window, this is a
    // best-effort re-attempt — return the prior result instead of posting a
    // duplicate. Computed after target resolution so the key uses the real
    // channel id. Only successful sends are remembered (see below), so a
    // genuine earlier failure still re-posts.
    const dedupeKey = recentSendKey({
      accountId: account.accountId,
      channelId,
      replyToId: typeof ctx.replyToId === "string" ? ctx.replyToId : "",
      text: ctx.text ?? "",
    });
    const nowMs = Date.now();
    pruneRecentSends(nowMs);
    const cached = recentSends.get(dedupeKey);
    if (cached && nowMs - cached.ts <= DEDUP_TTL_MS) {
      consoleErrorWithFile(
        `[clawbits/${account.accountId}] outbound.sendText DEDUPE channel=${channelId} replyTo=${
          typeof ctx.replyToId === "string" && ctx.replyToId ? ctx.replyToId : "(none)"
        } → reusing postId=${cached.result.messageId || "(unknown)"}; suppressed duplicate re-send`,
      );
      // Refresh recency so a long retry tail keeps collapsing onto one post.
      cached.ts = nowMs;
      return cached.result;
    }

    // If the gateway opened a shimmer draft for the turn this reply belongs
    // to (codex message-tool sends bypass the gateway's ``deliver`` and land
    // here instead), finalize that draft in place — same single PATCH the
    // deliver path uses — rather than minting a second post. Without this,
    // the channel shows the "Generating…" shimmer AND the real reply side by
    // side until the turn settles and cancels the draft. ``claimOpenDraft``
    // empties the shared ref synchronously, so the gateway's turn-end
    // cleanup won't also cancel/tombstone it.
    const draftPostId = claimOpenDraft(account.accountId, channelId);
    if (draftPostId !== undefined) {
      try {
        await realtimeTools.patchDraftPost(client, channelId, draftPostId, {
          replace: ctx.text ?? "",
          done: true,
        });
        pluginDebug(
          `outbound.sendText finalized open draft postId=${String(draftPostId)} channel=${channelId} in place (no separate post minted)`,
        );
        const result: OutboundDeliveryResult = {
          channel: CHANNEL_ID,
          messageId: String(draftPostId),
          channelId,
        };
        recentSends.set(dedupeKey, { result, ts: Date.now() });
        return result;
      } catch (err) {
        // Draft vanished (turn already cleaned it up, server restarted, …) —
        // fall through to the normal mint-a-post path so the reply still
        // lands. Losing the in-place morph is cosmetic; losing the reply
        // is not.
        consoleErrorWithFile(
          `[clawbits/${account.accountId}] outbound.sendText draft-finalize failed for postId=${String(draftPostId)} channel=${channelId}: ${err instanceof Error ? err.message : String(err)} — falling back to a fresh post`,
        );
      }
    }

    // Outbound agent posts always publish immediately. The approval gate
    // now applies to inbound human messages tagging the agent (held as
    // drafts on the human's POST), not to the agent's own replies.
    const postBody = { message: ctx.text };
    // Resolved target channel (dev-only). If this `channel=` differs from the
    // room the message was sent in, the reply is being misrouted (the target
    // guard fell back to account.channelId because `to` arrived peer-shaped).
    pluginDebug(
      `outbound.sendText posting to ${channelId} (rawTo=${JSON.stringify(rawTo) || "<empty>"}, looksLikePeer=${looksLikePeer}, account=${account.accountId}, bytes=${ctx.text?.length ?? 0})`,
    );
    try {
      const posted = (await withChallenge(client, answers, (ans) =>
        mmTools.postToChannel(client, channelId, postBody, ans),
      )) as { id?: string | number; post_id?: string | number; message_id?: string | number };
      // The server's create-post response carries a NUMERIC ``post_id``
      // (MmPostResponse.post_id: int). OpenClaw's receipt normalization calls
      // ``.trim()`` on every platform message id, so handing it a raw number
      // fails the batch AFTER the post already landed - a cron announce then
      // delivers the message AND marks the run failed ("OutboundDeliveryError:
      // value?.trim is not a function"). Always return a string.
      const rawPostId = posted?.id ?? posted?.post_id ?? posted?.message_id;
      const messageId = rawPostId == null ? "" : String(rawPostId);
      pluginDebug(
        `Delivered. Clawbits delivery is working — posted reply postId=${messageId || "(unknown)"} channel=${channelId}.`,
      );

      const result: OutboundDeliveryResult = {
        channel: CHANNEL_ID,
        messageId,
        channelId,
      };
      // Remember only successful sends: a re-attempt of this same reply now
      // reuses this post id instead of minting another.
      recentSends.set(dedupeKey, { result, ts: Date.now() });
      return result;
    } catch (err) {
      // Surface delivery failures unconditionally — a rejected POST (challenge
      // mismatch, 403 not-a-member, 404 bad channel) is otherwise invisible
      // because it just propagates up as a thrown error. Errors aren't noise.
      consoleErrorWithFile(
        `[clawbits/${account.accountId}] outbound.sendText FAILED channel=${channelId}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
      throw err;
    }
  },

  async sendMedia(ctx: ChannelOutboundContext): Promise<OutboundDeliveryResult> {
    // Media path: core stages agent-generated/attached media and hands us
    // ``ctx.mediaUrl`` (a remote URL or an approved local media-store path).
    // We upload it as a chat attachment and bind it to a single post with
    // the caption riding in ``message`` — one post, image + text together.
    pluginDebug(
      `outbound.sendMedia ENTER account=${String(ctx.accountId ?? "(default)")} to=${JSON.stringify(ctx.to)} media=${JSON.stringify(ctx.mediaUrl ?? "")} captionBytes=${ctx.text?.length ?? 0}`,
    );
    const { account, client, answers, channelId } = resolveSendTarget(ctx);

    // Same best-effort re-send collapse as sendText; the media reference is
    // folded into the key (NUL-joined — never appears in text or URLs) so a
    // caption-less image and a text-only reply can't collide, and a retried
    // media send reuses the already-minted post.
    const dedupeKey = recentSendKey({
      accountId: account.accountId,
      channelId,
      replyToId: typeof ctx.replyToId === "string" ? ctx.replyToId : "",
      text: `${ctx.text ?? ""}\u0000${ctx.mediaUrl ?? ""}`,
    });
    const nowMs = Date.now();
    pruneRecentSends(nowMs);
    const cached = recentSends.get(dedupeKey);
    if (cached && nowMs - cached.ts <= DEDUP_TTL_MS) {
      consoleErrorWithFile(
        `[clawbits/${account.accountId}] outbound.sendMedia DEDUPE channel=${channelId} → reusing postId=${cached.result.messageId || "(unknown)"}; suppressed duplicate re-send`,
      );
      cached.ts = nowMs;
      return cached.result;
    }

    // Same shimmer-draft takeover as sendText, with one twist: the draft
    // PATCH API can't attach files (MmPostPatchRequest carries no
    // file_ids), so the draft can't be finalized in place — cancel it and
    // mint the media post instead. Without this, the channel shows the
    // "Generating…" shimmer AND the image post side by side until the turn
    // settles. ``claimOpenDraft`` empties the shared ref synchronously, so
    // the gateway's turn-end cleanup won't also cancel/tombstone it.
    const draftPostId = claimOpenDraft(account.accountId, channelId);
    if (draftPostId !== undefined) {
      try {
        await realtimeTools.patchDraftPost(client, channelId, draftPostId, { cancel: true });
        pluginDebug(
          `outbound.sendMedia cancelled open draft postId=${String(draftPostId)} channel=${channelId}; media post replaces the shimmer`,
        );
      } catch (err) {
        // Draft vanished (turn already cleaned it up, server restarted, …)
        // — cosmetic; the media post below still lands.
        consoleErrorWithFile(
          `[clawbits/${account.accountId}] outbound.sendMedia draft-cancel failed for postId=${String(draftPostId)} channel=${channelId}: ${err instanceof Error ? err.message : String(err)} — continuing with a fresh post`,
        );
      }
    }

    let fileId: string;
    try {
      fileId = await uploadOutboundMedia({ client, answers, channelId, ctx });
    } catch (err) {
      // Upload failed. When the media reference is a public https URL the
      // text fallback still delivers something useful; a host-local path
      // must NEVER leak into chat (it exposes the host filesystem layout),
      // so in that case the error propagates and delivery fails loudly.
      const mediaUrl = ctx.mediaUrl ?? "";
      consoleErrorWithFile(
        `[clawbits/${account.accountId}] outbound.sendMedia upload FAILED channel=${channelId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (!/^https:\/\//i.test(mediaUrl)) throw err;
      const fallbackText = ctx.text ? `${ctx.text}\n${mediaUrl}` : mediaUrl;
      return await outboundAdapter.sendText!({ ...ctx, text: fallbackText });
    }

    try {
      const posted = (await withChallenge(client, answers, (ans) =>
        mmTools.postToChannel(
          client,
          channelId,
          { message: ctx.text ?? "", file_ids: [fileId] },
          ans,
        ),
      )) as { id?: string | number; post_id?: string | number; message_id?: string | number };
      // String-coerce the post id — same receipt-normalization contract as
      // sendText (OpenClaw calls .trim() on message ids).
      const rawPostId = posted?.id ?? posted?.post_id ?? posted?.message_id;
      const messageId = rawPostId == null ? "" : String(rawPostId);
      pluginDebug(
        `outbound.sendMedia delivered postId=${messageId || "(unknown)"} channel=${channelId} fileId=${fileId}`,
      );
      const result: OutboundDeliveryResult = {
        channel: CHANNEL_ID,
        messageId,
        channelId,
      };
      recentSends.set(dedupeKey, { result, ts: Date.now() });
      return result;
    } catch (err) {
      consoleErrorWithFile(
        `[clawbits/${account.accountId}] outbound.sendMedia post FAILED channel=${channelId} fileId=${fileId}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
      throw err;
    }
  },
};
