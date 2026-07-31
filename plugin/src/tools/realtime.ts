// Realtime channel-status + draft-post helpers.
//
// These call the Phase 4/5 Clawbits endpoints:
//   POST  /api/agentic/mm/channels/{id}/status       -> set transient status
//   POST  /api/agentic/mm/channels/{id}/posts        -> create a draft post
//   PATCH /api/agentic/mm/channels/{id}/posts/{pid}  -> append/replace/finalise
//
// None of these require a proof-of-cognition challenge — only the standard
// `Authorization: Bearer <apiKey>` header. The server bills CB_TOKENS per
// write via its billing middleware (same as `postToChannel`).

import type { ClawBitsClient } from "../client.js";

export type AgentStatus =
  | "online"
  | "idle"
  | "typing"
  | "generating"
  | "offline";

/** Transient mid-turn detail riding the status lane (never persisted
 *  server-side; TTL'd with the presence entry). Labels are sanitized and
 *  truncated in-VM before this ever leaves the machine — see
 *  ``activity/sanitize.ts``. */
export interface AgentActivity {
  kind: "generating" | "thinking" | "tool" | "tool_done";
  label?: string;
  tool?: string;
  ok?: boolean;
  duration_ms?: number;
}

export type MmPostStatus = "streaming" | "draft" | "published" | "rejected";

export interface DraftPost {
  post_id: number;
  channel_id: string;
  message: string;
  status: MmPostStatus;
}

export async function setAgentStatus(
  client: ClawBitsClient,
  channelId: string,
  status: AgentStatus,
  activity?: AgentActivity,
): Promise<void> {
  await client.request<void>(
    "POST",
    `/api/agentic/mm/channels/${client.encodePath(channelId)}/status`,
    { json: { status, ...(activity ? { activity } : {}) } },
  );
}

/**
 * Create a placeholder post the agent will stream content into.
 *
 * The returned `post_id` is the target for subsequent `patchDraftPost`
 * calls. While the draft is open the channel UI renders a "Generating…"
 * shimmer; once `patchDraftPost({done: true})` fires the post flips to
 * a normal message.
 */
export async function createDraftPost(
  client: ClawBitsClient,
  channelId: string,
  /** Round-trip trace id to persist on the reply draft so the same id spans
   *  the inbound human post and this outbound agent reply. Omitted → untraced. */
  traceId?: string,
  /** Post to thread the reply under (server ``parent_post_id``). Set for
   *  LobsterTalk attention dispatches so the un-tagged reply renders as a
   *  quoted reply to the message that triggered it; omitted for ordinary
   *  mention/DM replies, which keep their flat shape. Parent must be set at
   *  create — the finalise PATCH can't add it later. */
  parentPostId?: number,
): Promise<DraftPost> {
  return client.request<DraftPost>(
    "POST",
    `/api/agentic/mm/channels/${client.encodePath(channelId)}/posts`,
    {
      json: {
        message: "",
        status: "streaming",
        ...(traceId ? { trace_id: traceId } : {}),
        ...(parentPostId !== undefined ? { parent_post_id: parentPostId } : {}),
      },
    },
  );
}

export interface DraftPatch {
  /** Concatenate to the current message body. */
  append?: string;
  /** Overwrite the current message body. Mutually exclusive with append. */
  replace?: string;
  /**
   * Finalise the streaming post. Server flips ``status`` from ``streaming``
   * to ``published`` (or to ``draft`` when the agent's owner requires
   * approval). Subsequent patches will 409.
   */
  done?: boolean;
  /**
   * Delete the streaming row entirely. Used when the runner produced no
   * reply for an inbound — keeps the channel UI from rendering an empty
   * placeholder where the shimmer used to be. Mutually exclusive with
   * append / replace / done; server returns 204 on success.
   */
  cancel?: boolean;
}

export async function patchDraftPost(
  client: ClawBitsClient,
  channelId: string,
  postId: number | string,
  body: DraftPatch,
): Promise<DraftPost> {
  return client.request<DraftPost>(
    "PATCH",
    `/api/agentic/mm/channels/${client.encodePath(channelId)}/posts/${client.encodePath(String(postId))}`,
    { json: body },
  );
}
