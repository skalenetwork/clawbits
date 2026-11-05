import { pluginRuntime, type KeyedStore } from "./runtime.js";
import type { DraftPatch } from "./tools/realtime.js";

// ---------------------------------------------------------------------------
// Open reply-draft registry
// ---------------------------------------------------------------------------
//
// The gateway adapter opens a streaming "shimmer" draft post at turn start
// and, for replies that flow through its own `deliver` callback, finalizes
// that draft in place. But codex-harness replies leave the turn through the
// message tool (`tools.message({action:"send"})` → outbound `sendText`),
// which historically minted a brand-new post — so the channel briefly showed
// BOTH the still-shimmering draft and the real reply until the turn settled
// and the gateway's finally-block cancelled the draft (a 1-2s visual
// overlap on every codex reply).
//
// This registry is the bridge: the gateway registers the draft it opened for
// (account, channel); `sendText` claims it and finalizes it in place instead
// of posting separately. The shared mutable ref means whichever path handles
// the draft first (deliver, sendText, turn-end cleanup) empties it
// synchronously, so no second path double-handles it. The same handle
// carries the turn's stop, which the agent WebSocket's `turn.stop` reaches
// outside the serial inbound queue the turn is holding.

/**
 * Mutable handle to a turn's open draft. `id === undefined` means the draft
 * has already been finalized/cancelled (or was never created). Whoever
 * consumes the draft must clear `id` *before* awaiting network calls so
 * concurrent paths in the same tick can't both claim it.
 */
export interface OpenDraftRef {
  id: number | string | undefined;
  stop?: () => Promise<void>;
  /** What the post that finishes the draft keeps of the turn: its steps so far. */
  finish?: () => Promise<Pick<DraftPatch, "steps">>;
  /** For a post that moves the reply below it: what ends this draft (the text streamed so far and
   *  the steps behind it, nothing when it is empty), while the turn's next text and steps start afresh. */
  handOver?: () => Promise<Pick<DraftPatch, "replace" | "steps"> | undefined>;
  traceId?: string;
  parentPostId?: number;
}

const openDrafts = new Map<string, OpenDraftRef>();

const ORPHAN_TTL_MS = 5 * 60_000;
let orphans: KeyedStore<string> | undefined;
const orphanStore = (): KeyedStore<string> | undefined =>
  (orphans ??= pluginRuntime()?.state.openKeyedStore<string>({
    namespace: "open-drafts",
    maxEntries: 1_000,
    defaultTtlMs: ORPHAN_TTL_MS,
  }));
const orphanKey = (accountId: string, channelId: string): string => `${accountId}:${channelId}`;

// NUL separator: cannot appear in account/channel ids, so keys can't collide
// across the boundary (same trick as the outbound dedup key).
function draftKey(accountId: string, channelId: string): string {
  return `${accountId}\u0000${channelId}`;
}

/**
 * Track the in-flight turn's handle on (account, channel).
 * Last registration wins — if two turns somehow overlap in one channel, the
 * newer draft is the one an outbound send should resolve into.
 */
export function registerOpenDraft(
  accountId: string,
  channelId: string,
  ref: OpenDraftRef,
): void {
  openDrafts.set(draftKey(accountId, channelId), ref);
  if (ref.id !== undefined) void orphanStore()?.register(orphanKey(accountId, channelId), String(ref.id)).catch(() => {});
}

/**
 * Claim the open draft for (account, channel): returns its post id and what
 * finishing it keeps, and empties the shared ref so the gateway's deliver/cleanup
 * paths skip it. Returns `undefined` when there is no live draft to take over.
 */
export function claimOpenDraft(
  accountId: string,
  channelId: string,
): { id: number | string; finish: Promise<Pick<DraftPatch, "steps">> } | undefined {
  const ref = openDrafts.get(draftKey(accountId, channelId));
  if (!ref || ref.id === undefined) return undefined;
  const id = ref.id;
  ref.id = undefined;
  return { id, finish: ref.finish?.() ?? Promise.resolve({}) };
}

/**
 * Drop the registry entry at turn end — but only if it still points at this
 * turn's ref, so a slow turn's cleanup can't evict a newer turn's draft.
 */
export function unregisterOpenDraft(
  accountId: string,
  channelId: string,
  ref: OpenDraftRef,
): void {
  const key = draftKey(accountId, channelId);
  if (openDrafts.get(key) !== ref) return;
  openDrafts.delete(key);
  void orphanStore()?.delete(orphanKey(accountId, channelId)).catch(() => {});
}

/** The turn's draft ended early, with none after it yet: restart recovery has nothing to finish. */
export function forgetOrphanDraft(accountId: string, channelId: string): void {
  void orphanStore()?.delete(orphanKey(accountId, channelId)).catch(() => {});
}

/** The live draft, or one a previous process left open in this chat: restart recovery finishes it. */
export async function claimDraft(
  accountId: string,
  channelId: string,
): Promise<{ id: number | string; finish: Promise<Pick<DraftPatch, "steps">> } | undefined> {
  const live = claimOpenDraft(accountId, channelId);
  const orphan = await orphanStore()?.consume(orphanKey(accountId, channelId)).catch(() => undefined);
  if (live) return live;
  return orphan ? { id: orphan, finish: Promise.resolve({}) } : undefined;
}

/** The in-flight turn's handle: its reply context for a send that posts instead of finishing its
 *  draft, and its draft for a post that moves the reply below it. */
export function openTurnContext(accountId: string, channelId: string): OpenDraftRef | undefined {
  return openDrafts.get(draftKey(accountId, channelId));
}

/** Stop the turn running in (account, channel); a no-op when none is. */
export async function stopTurn(accountId: string, channelId: string): Promise<void> {
  await openDrafts.get(draftKey(accountId, channelId))?.stop?.();
}

/** Test seam: forget every registered draft between cases. */
export function __resetDraftRegistryForTest(): void {
  openDrafts.clear();
  orphans = undefined;
}
