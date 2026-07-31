// Lightweight polling loop that ingests new email from the agent's Clawbits
// mailbox and forwards each new message to an inbound handler.
//
// The cadence mirrors the user-facing flow:
//   1. GET /email/count — cheap. If the total is unchanged since the last
//      poll, do nothing (a new arrival always bumps the total).
//   2. GET /email/inbox — list UIDs.
//   3. For each UID newer than the persisted watermark, GET /email/{uid} to
//      read the full body (+ attachments; this marks it read server-side) and
//      hand it to `onEmailMessage`, then advance the watermark.
//
// The watermark is the last processed IMAP UID, persisted per account via the
// shared `WatermarkStore` (keyed by the synthetic channel id `email:inbox`).
// IMAP UIDs grow monotonically, so the store's monotonic `set` dedupes across
// restarts. On the very first observation (no persisted watermark) we seed to
// the current max UID WITHOUT injecting — exactly like the chat poller seeds
// its `create_at` cursor to "now" — so a fresh start never replays the whole
// mailbox backlog at the agent.

import type { WatermarkStore } from "./channel-watermarks.js";
import type { ClawBitsClient } from "./client.js";
import { DEFAULT_EMAIL_POLL_MS, MIN_EMAIL_POLL_MS } from "./email-constants.js";
import { htmlToText } from "./email-html.js";
import { ClawBitsError } from "./errors.js";
import { logError, logInfo, logWarn } from "./file-logger.js";
import * as emailTools from "./tools/email.js";
import type { EmailAttachment, EmailDetail } from "./tools/email.js";
import type { ResolvedClawBitsAccount } from "./types.js";

/** Synthetic channel id under which the last-processed email UID is persisted
 *  in the shared watermark store. */
export const EMAIL_WATERMARK_CHANNEL = "email:inbox" as const;

/** Inbox listing page size. We page past this window when a burst leaves more
 *  unprocessed mail than one page can hold (see `processInbox`). */
const INBOX_PAGE_LIMIT = 50;
/** Safety cap on pagination so a pathological mailbox can't loop unbounded in
 *  one poll cycle. INBOX_PAGE_LIMIT * this = max messages drained per cycle. */
const MAX_INBOX_PAGES = 20;

/** One email fetched in full and handed to the inbound dispatcher. */
export interface EmailInboundMessage {
  accountId: string;
  uid: number;
  fromAddr: string;
  toAddr: string;
  subject: string;
  date: string;
  bodyText: string;
  attachments: EmailAttachment[];
  headers: Record<string, string>;
}

export interface EmailPollerLog {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface EmailPollerOptions {
  client: ClawBitsClient;
  account: ResolvedClawBitsAccount;
  abortSignal: AbortSignal;
  onEmailMessage: (msg: EmailInboundMessage) => Promise<void> | void;
  /** Milliseconds between polls. Defaults to the account's resolved interval. */
  pollIntervalMs?: number;
  /** Persistent last-processed-UID watermark. Omit for in-memory-only behaviour. */
  watermarkStore?: WatermarkStore;
  log?: EmailPollerLog;
}

/** Sleep `ms`, resolving early if the signal aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/** Choose the body text to hand the agent: prefer the plain-text part, but fall
 *  back to a stripped `text/html` part so HTML-only mail isn't delivered empty. */
function pickBodyText(detail: EmailDetail): string {
  const text = str(detail.body_text, "");
  if (text.trim().length > 0) return text;
  const html = str(detail.body_html, "");
  return html.trim().length > 0 ? htmlToText(html) : "";
}

/** Ascending, finite UIDs from one inbox listing page. */
function sortedUids(listing: emailTools.EmailListResponse): number[] {
  const rows = Array.isArray(listing.emails) ? listing.emails : [];
  return rows
    .map((e) => (typeof e.uid === "number" ? e.uid : Number(e.uid)))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

/**
 * Long-lived email ingestion loop. Resolves when the abort signal fires (clean
 * gateway shutdown) or when the server reports email is not configured (503),
 * which permanently stops this account's poller so it never hammers the API.
 */
export async function runEmailPoller(opts: EmailPollerOptions): Promise<void> {
  const { client, account, abortSignal, onEmailMessage, watermarkStore, log } = opts;
  const accountId = account.accountId;
  const agentId = account.agentId;
  if (!agentId) {
    logWarn(log, `[clawbits/${accountId}] email poller idle: no agentId on account`);
    return;
  }
  // An explicit `opts.pollIntervalMs` is a programmatic override (advanced
  // callers / tests) and is honoured as-is. The account-resolved value is the
  // user-facing config path and is already floored in `accounts.ts`; we re-floor
  // it here only as belt-and-suspenders. Production wiring passes `account`, not
  // `opts.pollIntervalMs`, so the floor always applies in practice.
  const pollIntervalMs =
    opts.pollIntervalMs ??
    Math.max(MIN_EMAIL_POLL_MS, account.emailPollIntervalMs ?? DEFAULT_EMAIL_POLL_MS);

  await watermarkStore?.load?.();
  // Seed the watermark on first observation so a fresh start doesn't replay the
  // whole mailbox. `undefined` means "not yet observed"; we set it from the
  // first inbox listing below before processing anything.
  let seeded = watermarkStore?.get(accountId, EMAIL_WATERMARK_CHANNEL) !== undefined;
  let lastTotal: number | undefined;
  let lastUnread: number | undefined;
  // True when a prior `processInbox` bailed early on a transient error without
  // fully draining. Forces a re-check next cycle even when the counts haven't
  // moved, so a transient failure isn't stranded until new mail bumps the count.
  let pendingDrain = false;

  logInfo(
    log,
    `[clawbits/${accountId}] email poller started (every ${pollIntervalMs}ms, agent ${agentId})`,
  );

  while (!abortSignal.aborted) {
    try {
      const counts = await emailTools.emailCount(client, agentId);
      const total = typeof counts.total === "number" ? counts.total : 0;
      const unread = typeof counts.unread === "number" ? counts.unread : 0;

      // Cheap short-circuit: a new arrival bumps total AND unread, but a delete
      // paired with an arrival can leave total unchanged — so we compare both.
      // The watermark remains the real dedupe; this only gates the inbox fetch.
      const countsChanged =
        lastTotal === undefined || total !== lastTotal || unread !== lastUnread;
      if (countsChanged || pendingDrain || !seeded) {
        const drained = await processInbox(agentId);
        pendingDrain = !drained;
        lastTotal = total;
        lastUnread = unread;
      }
    } catch (err) {
      if (err instanceof ClawBitsError && err.statusCode === 503) {
        logInfo(
          log,
          `[clawbits/${accountId}] email not configured on server (503); stopping email poller`,
        );
        return;
      }
      logWarn(
        log,
        `[clawbits/${accountId}] email poll failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    await delay(pollIntervalMs, abortSignal);
  }

  logInfo(log, `[clawbits/${accountId}] email poller stopped`);

  // --- helpers (closures over the loop state) ---------------------------------

  /** Drain new mail. Returns `true` when the box was fully processed for this
   *  cycle, `false` when a transient error left work behind (caller retries). */
  async function processInbox(agentId: string): Promise<boolean> {
    const firstPage = await emailTools.emailInbox(client, agentId, { limit: INBOX_PAGE_LIMIT });
    const firstUids = sortedUids(firstPage);

    if (!seeded) {
      // First observation: treat everything currently in the box as already
      // seen and only inject genuinely new mail from here on. An empty box
      // still counts as observed (seed 0).
      seeded = true;
      const seedUid = firstUids.length > 0 ? firstUids[firstUids.length - 1] : 0;
      watermarkStore?.set(accountId, EMAIL_WATERMARK_CHANNEL, seedUid);
      if (seedUid > 0) {
        logInfo(
          log,
          `[clawbits/${accountId}] email poller seeded watermark at uid ${seedUid} (${firstUids.length} existing message(s) skipped)`,
        );
      }
      return true;
    }

    const watermark = watermarkStore?.get(accountId, EMAIL_WATERMARK_CHANNEL) ?? 0;

    // Collect every UID past the watermark. The inbox is newest-first, so when a
    // burst exceeds one page the older-but-still-new UIDs spill onto later
    // pages; we keep paging until a page reaches already-seen territory (its
    // smallest UID <= watermark) or runs short. A Set dedupes any overlap from
    // mail arriving mid-pagination.
    const newUids = new Set<number>();
    let pageUids = firstUids;
    let offset = INBOX_PAGE_LIMIT;
    let pages = 1;
    while (true) {
      for (const uid of pageUids) {
        if (uid > watermark) newUids.add(uid);
      }
      const reachedSeen = pageUids.length === 0 || pageUids[0] <= watermark;
      const lastPage = pageUids.length < INBOX_PAGE_LIMIT;
      if (reachedSeen || lastPage || pages >= MAX_INBOX_PAGES || abortSignal.aborted) break;
      const nextPage = await emailTools.emailInbox(client, agentId, {
        limit: INBOX_PAGE_LIMIT,
        offset,
      });
      pageUids = sortedUids(nextPage);
      offset += INBOX_PAGE_LIMIT;
      pages += 1;
    }

    const ordered = [...newUids].sort((a, b) => a - b);
    for (const uid of ordered) {
      if (abortSignal.aborted) return false;
      try {
        const detail = await emailTools.emailGet(client, agentId, uid);
        const msg: EmailInboundMessage = {
          accountId,
          uid,
          fromAddr: str(detail.from_addr),
          toAddr: str(detail.to_addr),
          subject: str(detail.subject),
          date: str(detail.date),
          bodyText: pickBodyText(detail),
          attachments: Array.isArray(detail.attachments) ? detail.attachments : [],
          headers:
            detail.headers && typeof detail.headers === "object" ? detail.headers : {},
        };
        await onEmailMessage(msg);
        watermarkStore?.set(accountId, EMAIL_WATERMARK_CHANNEL, uid);
      } catch (err) {
        if (err instanceof ClawBitsError && err.statusCode === 404) {
          // Vanished between the listing and the fetch (deleted/moved). Skip it
          // past the watermark so we don't retry a message that no longer exists.
          watermarkStore?.set(accountId, EMAIL_WATERMARK_CHANNEL, uid);
          logWarn(
            log,
            `[clawbits/${accountId}] email uid ${uid} not found on fetch; skipping`,
          );
          continue;
        }
        // Transient failure (network, 5xx). Stop this cycle WITHOUT advancing so
        // the same uid is retried next poll, preserving order. Returning false
        // tells the caller the box wasn't drained so it retries even if the
        // mailbox counts don't change.
        logError(
          log,
          `[clawbits/${accountId}] email uid ${uid} fetch/dispatch failed; will retry: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return false;
      }
    }
    return true;
  }
}
