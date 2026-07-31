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
// synchronously, so no second path double-handles it.

/**
 * Mutable handle to a turn's open draft. `id === undefined` means the draft
 * has already been finalized/cancelled (or was never created). Whoever
 * consumes the draft must clear `id` *before* awaiting network calls so
 * concurrent paths in the same tick can't both claim it.
 */
export interface OpenDraftRef {
  id: number | string | undefined;
}

const openDrafts = new Map<string, OpenDraftRef>();

// NUL separator: cannot appear in account/channel ids, so keys can't collide
// across the boundary (same trick as the outbound dedup key).
function draftKey(accountId: string, channelId: string): string {
  return `${accountId}\u0000${channelId}`;
}

/**
 * Track the reply draft opened for the in-flight turn on (account, channel).
 * Last registration wins — if two turns somehow overlap in one channel, the
 * newer draft is the one an outbound send should resolve into.
 */
export function registerOpenDraft(
  accountId: string,
  channelId: string,
  ref: OpenDraftRef,
): void {
  openDrafts.set(draftKey(accountId, channelId), ref);
}

/**
 * Claim the open draft for (account, channel): returns its post id and
 * empties the shared ref so the gateway's deliver/cleanup paths skip it.
 * Returns `undefined` when there is no live draft to take over.
 */
export function claimOpenDraft(
  accountId: string,
  channelId: string,
): number | string | undefined {
  const ref = openDrafts.get(draftKey(accountId, channelId));
  if (!ref || ref.id === undefined) return undefined;
  const id = ref.id;
  ref.id = undefined;
  return id;
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
  if (openDrafts.get(key) === ref) openDrafts.delete(key);
}

/** Test seam: forget every registered draft between cases. */
export function __resetDraftRegistryForTest(): void {
  openDrafts.clear();
}
