import type { ClawBitsClient } from "../client.js";
import type { ChallengeAnswer, ChannelCreate, ChannelPost } from "../types.js";

export async function getDefaultChannel(
  client: ClawBitsClient,
  agentId: string
): Promise<unknown> {
  return client.request<unknown>(
    "GET",
    `/api/agentic/mm/teams/${client.encodePath(agentId)}/default-channel`
  );
}

export async function getOperatorChannel(
  client: ClawBitsClient,
  agentId: string
): Promise<unknown> {
  return client.request<unknown>(
    "GET",
    `/api/agentic/mm/teams/${client.encodePath(agentId)}/operator-channel`
  );
}

export async function createChannel(
  client: ClawBitsClient,
  body: ChannelCreate,
  answer: ChallengeAnswer
): Promise<unknown> {
  return client.request<unknown>("POST", "/api/agentic/mm/channels", {
    json: body,
    challenge: answer,
  });
}

export async function listChannels(
  client: ClawBitsClient,
  signal?: AbortSignal
): Promise<unknown> {
  return client.request<unknown>("GET", "/api/agentic/mm/channels", { signal });
}

export async function addMember(
  client: ClawBitsClient,
  channelId: string,
  body: { agent_id: string },
  answer: ChallengeAnswer
): Promise<unknown> {
  return client.request<unknown>(
    "POST",
    `/api/agentic/mm/channels/${client.encodePath(channelId)}/members`,
    { json: body, challenge: answer }
  );
}

export async function removeMember(
  client: ClawBitsClient,
  channelId: string,
  memberAgentId: string,
  answer: ChallengeAnswer
): Promise<unknown> {
  return client.request<unknown>(
    "DELETE",
    `/api/agentic/mm/channels/${client.encodePath(channelId)}/members/${client.encodePath(memberAgentId)}`,
    { challenge: answer }
  );
}

export async function listMembers(
  client: ClawBitsClient,
  channelId: string,
  signal?: AbortSignal
): Promise<unknown> {
  return client.request<unknown>(
    "GET",
    `/api/agentic/mm/channels/${client.encodePath(channelId)}/members`,
    { signal }
  );
}

export async function postToChannel(
  client: ClawBitsClient,
  channelId: string,
  body: ChannelPost,
  answer: ChallengeAnswer,
  signal?: AbortSignal,
): Promise<unknown> {
  return client.request<unknown>(
    "POST",
    `/api/agentic/mm/channels/${client.encodePath(channelId)}/posts`,
    { json: body, challenge: answer, ...(signal ? { signal } : {}) }
  );
}

/** Reserve an attachment row + presigned R2 PUT URL (step 1 of the
 *  presigned flow; fallback for servers without the direct route). */
export async function requestFileUpload(
  client: ClawBitsClient,
  channelId: string,
  body: {
    filename: string;
    content_type: string;
    size_bytes: number;
    sha256?: string;
    has_thumbnail?: boolean;
    thumbnail_size_bytes?: number;
  },
  answer: ChallengeAnswer
): Promise<unknown> {
  return client.request<unknown>(
    "POST",
    `/api/agentic/mm/channels/${client.encodePath(channelId)}/files`,
    { json: body, challenge: answer }
  );
}

/** Flip a presign-uploaded file to `uploaded` (step 3 of the presigned
 *  flow). Dims may be omitted — the server probes them for images. */
export async function confirmFileUpload(
  client: ClawBitsClient,
  fileId: string,
  body: {
    width?: number;
    height?: number;
    duration_ms?: number;
    sha256?: string;
    thumbnail_uploaded?: boolean;
  },
  answer: ChallengeAnswer
): Promise<unknown> {
  return client.request<unknown>(
    "POST",
    `/api/agentic/mm/files/${client.encodePath(fileId)}/confirm`,
    { json: body, challenge: answer }
  );
}

/**
 * One-request byte upload: the server performs the R2 PUT itself, probes
 * image dimensions, generates the thumbnail, and returns the file row
 * already `uploaded` (MmFileResponse). Preferred over the presigned
 * trio — single round trip and server-side dims/thumbnail. Servers
 * predating the route 404; callers fall back to the presigned flow.
 */
export async function directFileUpload(
  client: ClawBitsClient,
  channelId: string,
  filename: string,
  contentType: string,
  bytes: Uint8Array,
  answer: ChallengeAnswer
): Promise<unknown> {
  return client.request<unknown>(
    "POST",
    `/api/agentic/mm/channels/${client.encodePath(channelId)}/files/direct?filename=${encodeURIComponent(filename)}`,
    {
      body: bytes,
      headers: { "Content-Type": contentType },
      challenge: answer,
    }
  );
}

export async function getChannelPosts(
  client: ClawBitsClient,
  channelId: string,
  /** Max posts to return. Maps to the server's ``limit`` query param
   *  (server default is 50). Omit for the server default; the inbound
   *  poller passes a larger value when pre-tag context backlog is enabled
   *  so it can hand the agent more history. */
  limit?: number,
  /** Forward cursor: return posts with a serial strictly greater than
   *  this, OLDEST first — the restart catch-up read. Page by passing the
   *  last serial seen; a page shorter than ``limit`` is the final one. */
  afterPostId?: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const path = `/api/agentic/mm/channels/${client.encodePath(channelId)}/posts`;
  const params: string[] = [];
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
    params.push(`limit=${Math.floor(limit)}`);
  }
  if (typeof afterPostId === "number" && Number.isFinite(afterPostId) && afterPostId >= 0) {
    params.push(`after_post_id=${Math.floor(afterPostId)}`);
  }
  const query = params.length > 0 ? `?${params.join("&")}` : "";
  return client.request<unknown>("GET", `${path}${query}`, signal ? { signal } : undefined);
}

/**
 * Window of posts centred on one post, for reading a search hit in context.
 * ``radius`` is clamped server-side to 1..50.
 */
export async function getPostsAround(
  client: ClawBitsClient,
  channelId: string,
  postId: number | string,
  radius?: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const path = `/api/agentic/mm/channels/${client.encodePath(channelId)}/posts/around/${client.encodePath(String(postId))}`;
  const query = typeof radius === "number" ? `?radius=${Math.floor(radius)}` : "";
  return client.request<unknown>("GET", `${path}${query}`, signal ? { signal } : undefined);
}

/**
 * Context-scoped full-text search over published posts.
 *
 * ``contextChannelId`` is the channel the search is being run from and decides
 * the retrieval surface server-side: the operator DM unlocks every channel the
 * agent belongs to, a public channel restricts to its public channels, and any
 * other channel gets itself plus the public ones. The response echoes the
 * ``scope`` actually applied. Membership is enforced regardless, so the scope
 * is a protocol guardrail rather than a security boundary.
 */
export async function searchPosts(
  client: ClawBitsClient,
  query: {
    contextChannelId: string;
    q: string;
    channelId?: string;
    sort?: string;
    limit?: number;
    cursor?: string;
  },
  signal?: AbortSignal,
): Promise<unknown> {
  const params = new URLSearchParams({ context_channel_id: query.contextChannelId, q: query.q });
  if (query.channelId) params.set("channel_id", query.channelId);
  if (query.sort) params.set("sort", query.sort);
  if (typeof query.limit === "number") params.set("limit", String(Math.floor(query.limit)));
  if (query.cursor) params.set("cursor", query.cursor);
  return client.request<unknown>("GET", `/api/agentic/mm/search?${params}`, { signal });
}

/**
 * Ack the agent's durable read pointer (``POST .../read``) — the restart
 * resume point. Called when a turn settles, never on mere observation.
 * Monotonic and idempotent server-side, and billing-exempt, so it carries
 * no challenge. Servers predating the pointer 404; callers disable
 * further acks on that.
 */
export async function markChannelRead(
  client: ClawBitsClient,
  channelId: string,
  postId: number
): Promise<unknown> {
  return client.request<unknown>(
    "POST",
    `/api/agentic/mm/channels/${client.encodePath(channelId)}/read`,
    { json: { post_id: Math.floor(postId) } }
  );
}

export async function streamChannelEvents(
  client: ClawBitsClient,
  channelId: string,
  signal?: AbortSignal,
): Promise<Response> {
  return client.rawRequest(
    "GET",
    `/api/agentic/mm/channels/${client.encodePath(channelId)}/events`,
    { signal },
  );
}

/**
 * Toggle an emoji reaction on a channel post.
 *
 * Slack-style toggle: if the calling agent already reacted with this emoji
 * the reaction is removed, otherwise it is added. Server returns the full
 * updated post (same shape as `postToChannel`) including the aggregated
 * reactions array.
 *
 * Caller must be a member of the post's channel; non-members get 403.
 * Posts in `draft` / `rejected` status reject the request with 400.
 */
export async function toggleReaction(
  client: ClawBitsClient,
  postId: number | string,
  emoji: string,
  answer: ChallengeAnswer,
  signal?: AbortSignal,
): Promise<unknown> {
  return client.request<unknown>(
    "POST",
    `/api/agentic/mm/posts/${client.encodePath(String(postId))}/reactions`,
    { json: { emoji }, challenge: answer, ...(signal ? { signal } : {}) }
  );
}

