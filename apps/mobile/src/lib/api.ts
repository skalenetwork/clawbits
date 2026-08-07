import { apiBaseUrl } from '@/lib/config';

/** Server-provided avatar reference — mirrors the web frontend's
 *  ``AvatarRef`` and the backend ``clawbits.datastructures.avatar_models``.
 *  ``url`` is stable per (entity, version) tuple and immutable for a year,
 *  so it can be dropped straight into an ``<Image source={{ uri }}>``. */
export interface AvatarRef {
  url: string;
  version: number;
  kind: 'generated' | 'uploaded';
}

export interface HumanUser {
  id: number;
  email: string;
  display_name?: string | null;
  token?: string | null;
  /** Server-stored avatar reference. Present on fresh sessions; absent
   *  on legacy session payloads — frontend falls back to initial letter. */
  avatar?: AvatarRef | null;
  created_at?: string | null;
  last_seen_at?: string | null;
}

export interface Org {
  org_id: string;
  name: string;
  display_name?: string | null;
  is_personal: boolean;
  created_at?: string | null;
}

export type MmChannelType = 'public' | 'private' | 'direct';

export interface MmChannel {
  channel_id: string;
  team_id?: string | null;
  org_id?: string | null;
  name: string;
  display_name?: string | null;
  channel_type: MmChannelType;
  created_by_agent?: string | null;
  created_by_human?: number | null;
  created_at: string;
  last_message_at?: string | null;
  last_message_text?: string | null;
  last_message_author_human_id?: number | null;
  last_message_author_agent_id?: string | null;
  last_message_author_display_name?: string | null;
  unread_count?: number;
  muted?: boolean;
  /** Per-viewer pin flag. True means the current user pinned this
   *  channel — the home screen surfaces it under "Pinned chats" right
   *  below the pinned agents tiles. */
  pinned?: boolean;
  /** Resolved avatar for the channel itself (hash / lock glass tile). */
  avatar?: AvatarRef | null;
  /** Resolved avatar for the last-message author — drives the tiny
   *  preview tile in sidebar rows without a member lookup. */
  last_message_author_avatar?: AvatarRef | null;
  /** Count of uploaded files on the latest published post. Drives the
   *  paperclip indicator in the chats-list preview. Zero (or absent on
   *  older payloads) means the last message is text-only or the
   *  channel is empty. */
  last_message_attachment_count?: number | null;
  /** Peer's user id on human↔human DMs — lets the row resolve the DM
   *  partner's avatar without a separate member fetch. */
  dm_peer_human_id?: number | null;
  /** Peer's agent id on human↔agent DMs — same idea as
   *  ``dm_peer_human_id`` but for agent direct messages. */
  dm_peer_agent_id?: string | null;
}

interface RequestOptions {
  body?: unknown;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  token?: string | null;
}

/** Default per-request timeout. A stalled socket (dropped Wi-Fi, captive
 *  portal, server hang) otherwise leaves a `fetch` pending forever — which
 *  pins an optimistic send in the "streaming" state and can wedge the
 *  bootstrap `getMe` so the splash screen never dismisses. */
const DEFAULT_TIMEOUT_MS = 20_000;
/** Uploads stream a whole file body, so they get a more generous budget. */
const UPLOAD_TIMEOUT_MS = 60_000;

/** `fetch` with a hard timeout. We drive a manual `AbortController` +
 *  `setTimeout` (rather than `AbortSignal.timeout`) so the behaviour is
 *  identical across the Hermes runtime regardless of which static abort
 *  helpers it happens to expose. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error('Request timed out. Check your connection and try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers();
  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  if (options.token) {
    headers.set('Authorization', `Bearer ${options.token}`);
  }

  const response = await fetchWithTimeout(`${apiBaseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (!response.ok) {
    throw new Error(await errorMessage(response));
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

async function errorMessage(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return `HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(text) as { detail?: unknown; message?: unknown };
    const detail = parsed.detail ?? parsed.message;
    if (typeof detail === 'string') return detail;
    return JSON.stringify(detail ?? parsed);
  } catch {
    return text;
  }
}

export type SocialProvider = 'google' | 'github';

/** Absolute URL to open in an in-app browser to start social OAuth.
 *  The ``?bridge=deeplink`` flag tells the backend to finish by firing
 *  ``clawbits://oauth-callback?token=…`` rather than setting a web
 *  session cookie. */
export function socialAuthStartUrl(provider: SocialProvider): string {
  return `${apiBaseUrl}/api/auth/social/${provider}/start?bridge=deeplink`;
}

export async function sendMagicCode(email: string): Promise<void> {
  await requestJson<void>('/api/auth/magic/send', {
    method: 'POST',
    body: { email },
  });
}

export async function verifyMagicCode(email: string, code: string): Promise<HumanUser> {
  return requestJson<HumanUser>('/api/auth/magic/verify', {
    method: 'POST',
    body: { email, code },
  });
}

export async function getMe(token: string | null): Promise<HumanUser> {
  return requestJson<HumanUser>('/api/auth/me', { token });
}

export async function logout(token: string | null): Promise<void> {
  await requestJson<void>('/api/auth/logout', { method: 'POST', token });
}

export async function updateMe(
  token: string | null,
  display_name: string | null,
): Promise<HumanUser> {
  return requestJson<HumanUser>('/api/human/me', {
    method: 'PATCH',
    token,
    body: { display_name },
  });
}

export async function uploadMyAvatar(
  token: string | null,
  file: { uri: string; name: string; type: string },
): Promise<AvatarRef> {
  const form = new FormData();
  // React Native's FormData accepts the {uri, name, type} object literal;
  // the typing on web-style FormData rejects it, so cast through unknown.
  form.append('file', file as unknown as Blob);

  const headers = new Headers();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetchWithTimeout(
    `${apiBaseUrl}/api/human/avatars/users/me/upload`,
    { method: 'POST', headers, body: form },
    UPLOAD_TIMEOUT_MS,
  );
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json() as Promise<AvatarRef>;
}

export async function resetMyAvatar(token: string | null): Promise<AvatarRef> {
  return requestJson<AvatarRef>('/api/human/avatars/users/me', {
    method: 'DELETE',
    token,
  });
}

/** Permanently delete the current human account and all of its data. This
 *  is a hard delete on the server (messages, reactions, uploaded files,
 *  push devices, plus any org/channel where you're the only member).
 *  Resolves on 204; on a guard failure the server returns 409 and this
 *  rejects with the backend's ``detail`` message — currently one of:
 *  "you still operate agents" or "you're the sole owner of a shared org" —
 *  which the caller should surface verbatim. The server only clears web
 *  cookies, so the local token + query cache must be wiped by the caller
 *  (see ``useAuth().deleteAccount``). */
export async function deleteMyAccount(token: string | null): Promise<void> {
  await requestJson<void>('/api/human/account', { method: 'DELETE', token });
}

export async function getOrgs(token: string | null): Promise<{ organizations: Org[]; total: number }> {
  return requestJson<{ organizations: Org[]; total: number }>('/api/human/orgs', { token });
}

export async function listMmChannels(
  token: string | null,
  orgId: string | null,
): Promise<{ channels: MmChannel[]; total: number }> {
  const suffix = orgId ? `?org_id=${encodeURIComponent(orgId)}` : '';
  return requestJson<{ channels: MmChannel[]; total: number }>(
    `/api/human/mm/channels${suffix}`,
    { token },
  );
}

export type GlobalUserStatus = 'online' | 'idle' | 'offline';

/** Publish the caller's global presence (online / idle / offline). The
 *  backend refreshes a Redis TTL and broadcasts ``user.status`` to peers
 *  on a status transition. Mobile drives this off ``AppState`` via
 *  [[use-heartbeat]] — without it an iOS user shows OFFLINE to everyone. */
export async function sendGlobalPresenceHeartbeat(
  token: string | null,
  status: GlobalUserStatus,
): Promise<void> {
  await requestJson<void>('/api/human/presence', {
    method: 'POST',
    token,
    body: { status },
  });
}

export interface MmChannelMember {
  agent_id: string | null;
  human_id: number | null;
  display_name: string | null;
  joined_at: string;
  /** Global presence — only populated for human members. Seeded from
   *  Redis on the list endpoint so the UI has a value before the first
   *  SSE update arrives. */
  status?: GlobalUserStatus | null;
  last_seen_at?: string | null;
  /** Member avatar — points at the user's or agent's R2-stored SVG. */
  avatar?: AvatarRef | null;
  /** Highest ``post_id`` this human has read in the channel, or null if
   *  they've never opened it. Maintained via SSE ``member.read``. Drives
   *  read-receipt indicators under outgoing messages. */
  last_read_post_id?: number | null;
}

export async function listMmChannelMembers(
  token: string | null,
  channelId: string,
): Promise<{ members: MmChannelMember[]; total: number }> {
  return requestJson<{ members: MmChannelMember[]; total: number }>(
    `/api/human/mm/channels/${encodeURIComponent(channelId)}/members`,
    { token },
  );
}

/** Inline channel-timeline event. Currently covers membership changes;
 *  ``event_type`` is left as a free string so future event types
 *  (channel.renamed, topic.changed, etc.) flow through the same
 *  rendering path without a wire-type bump. */
export interface MmChannelEvent {
  event_id: number;
  channel_id: string;
  event_type: 'member.added' | 'member.removed' | string;
  actor_human_id: number | null;
  actor_agent_id: string | null;
  actor_display_name: string | null;
  actor_avatar: AvatarRef | null;
  /** NULL when the actor acted on themselves — the renderer uses this
   *  to pick "joined"/"left" over "added X"/"removed X". */
  subject_human_id: number | null;
  subject_agent_id: string | null;
  subject_display_name: string | null;
  subject_avatar: AvatarRef | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

export interface MmChannelEventListPayload {
  events: MmChannelEvent[];
  total: number;
}

export async function listMmChannelEvents(
  token: string | null,
  channelId: string,
  limit = 100,
): Promise<MmChannelEventListPayload> {
  // ``/inline-events``, not ``/events`` — the latter is the per-channel
  // SSE stream (text/event-stream). See backend comment near
  // ``list_channel_events``.
  return requestJson<MmChannelEventListPayload>(
    `/api/human/mm/channels/${encodeURIComponent(channelId)}/inline-events?limit=${String(limit)}`,
    { token },
  );
}

export type MmPostStatus = 'streaming' | 'draft' | 'published' | 'rejected';

export interface MmFile {
  file_id: string;
  channel_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  status: 'pending' | 'uploaded' | 'failed' | 'deleted';
  width?: number | null;
  height?: number | null;
  duration_ms?: number | null;
  created_at: string;
  uploaded_at?: string | null;
  download_url?: string | null;
  download_url_expires_at?: number | null;
  thumbnail_url?: string | null;
  thumbnail_url_expires_at?: number | null;
}

export interface MmReactionAggregate {
  emoji: string;
  count: number;
  human_ids: number[];
  agent_ids: string[];
}

export interface MmPostParentPreview {
  post_id: number;
  agent_id: string | null;
  human_id: number | null;
  poster_display_name: string | null;
  message_excerpt: string;
  status: MmPostStatus;
  /** Uploaded files on the parent post. Lets the quote render an
   *  attachment-only parent (which legitimately has no text) with a
   *  label instead of a blank line. Absent on legacy payloads → 0. */
  attachment_count?: number;
}

/** Server-resolved OG card embedded on a post at create / edit time.
 *  The backend runs the unfurl synchronously when the post is published,
 *  with a strict timeout, and persists the result on the post row. The
 *  mobile client renders the card on first paint with no skeleton-to-
 *  card swap — the layout shift that the async client-side fetch path
 *  used to produce when the unfurl resolved is eliminated.
 *
 *  Optional fields default to ``null``-via-undefined; the card renderer
 *  tolerates both. ``skipped`` counts URLs the server intentionally
 *  didn't unfurl (server caps at 1 to keep the post payload compact). */
export interface MmPostLinkPreviewEmbedded {
  url: string;
  canonical_url?: string | null;
  title?: string | null;
  description?: string | null;
  image_url?: string | null;
  site_name?: string | null;
  fetched_at?: number | null;
  error?: string | null;
  skipped?: number;
}

export interface MmPost {
  post_id: number;
  channel_id: string;
  agent_id: string | null;
  human_id: number | null;
  poster_display_name: string | null;
  /** Resolved avatar for the post's author (human or agent). Backend
   *  builds it per request from the author id; absent on legacy paths
   *  that haven't been rewired — fall back to the initial-letter glyph. */
  avatar?: AvatarRef | null;
  message: string;
  created_at: string;
  status: MmPostStatus;
  updated_at?: string | null;
  edited_at?: string | null;
  pinned_at?: string | null;
  pinned_by_human_id?: number | null;
  parent_post_id?: number | null;
  parent_preview?: MmPostParentPreview | null;
  /** Server-resolved OG card for the first shareable URL in the message.
   *  ``null`` (or missing) on legacy posts predating the server-side
   *  unfurl path — in that case the renderer falls back to the
   *  client-side ``useLinkPreview`` hook for the first URL it extracts.
   *  When present the renderer skips the async fetch entirely. */
  link_preview?: MmPostLinkPreviewEmbedded | null;
  reactions?: MmReactionAggregate[];
  files?: MmFile[];
  /** Echoed from MmPostRequest.client_msg_uuid on the synchronous create
   * response and the post.created SSE event. Used by optimistic clients to
   * dedupe their local temp post against the server-fanned-out one. */
  client_msg_uuid?: string | null;
  /** Client-only — set on the optimistic temp post when the POST fails. */
  _failed?: boolean;
  /** Client-only — file ids attached to an optimistic send, stashed so a
   *  failed message can be re-sent with the same (already-uploaded)
   *  attachments. Never persisted: temp posts are stripped on dehydrate. */
  _pendingFileIds?: string[];
}

export async function listMmPosts(
  token: string | null,
  channelId: string,
  params: { limit?: number; beforePostId?: number; afterPostId?: number } = {},
): Promise<{ posts: MmPost[]; total: number; limit: number; offset: number }> {
  const query = new URLSearchParams();
  if (params.limit != null) query.set('limit', String(params.limit));
  if (params.beforePostId != null) query.set('before_post_id', String(params.beforePostId));
  // Scroll-down cursor for an anchored history window (jump-to-message): the
  // posts immediately newer than this id, never the live tail.
  if (params.afterPostId != null) query.set('after_post_id', String(params.afterPostId));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return requestJson(
    `/api/human/mm/channels/${encodeURIComponent(channelId)}/posts${suffix}`,
    { token },
  );
}

/** Window of posts centred on ``postId`` (newest-first) — up to ``radius``
 *  older and ``radius`` newer. Powers "jump to message" (a search hit, a reply
 *  quote) when the target sits outside the loaded window: the screen re-anchors
 *  the timeline on this island and pages both ways from it, instead of walking
 *  back from the live tail one page at a time. */
export async function listMmPostsAround(
  token: string | null,
  channelId: string,
  postId: number,
  radius = 25,
): Promise<{ posts: MmPost[]; total: number; limit: number; offset: number }> {
  return requestJson(
    `/api/human/mm/channels/${encodeURIComponent(channelId)}/posts/around/${encodeURIComponent(
      String(postId),
    )}?radius=${String(radius)}`,
    { token },
  );
}

// ---------------------------------------------------------------------------
// Message search (Postgres FTS). Operators (from:/in:/before:/after:/has:)
// are parsed + resolved to ids CLIENT-side (see lib/search-query.ts) — the
// server only takes structured params. Results are membership-scoped and
// cover plaintext channels only (E2EE content is structurally excluded).
// ---------------------------------------------------------------------------

export type MmSearchSort = 'recent' | 'relevant';

export interface MmSearchAuthor {
  kind: 'human' | 'agent';
  human_id?: number | null;
  agent_id?: string | null;
  display_name?: string | null;
  avatar?: AvatarRef | null;
}

export interface MmSearchResult {
  post_id: number;
  channel_id: string;
  channel_display_name?: string | null;
  channel_type: MmChannelType;
  created_at: string;
  author: MmSearchAuthor;
  /** ``ts_headline`` output: matched terms wrapped in ``<mark>…</mark>``,
   *  surrounding text HTML-escaped by Postgres. NEVER inject as HTML —
   *  render by splitting on the ``<mark>`` markers (see the Highlight
   *  component in the search screen). */
  snippet: string;
  rank: number;
}

export interface MmSearchResponse {
  results: MmSearchResult[];
  /** Opaque; ``null`` means last page. Pass back verbatim as ``cursor``. */
  next_cursor: string | null;
  /** Echo of the query the server interpreted — used to drop stale renders. */
  query: string;
  sort: string;
}

export interface SearchMessagesParams {
  orgId: string | null;
  /** Operators already stripped; a blank query with active filters is a
   *  valid filter-only listing, but blank query + no filters returns []. */
  query: string;
  channelId?: string | null;
  sort?: MmSearchSort;
  cursor?: string | null;
  limit?: number;
  fromHumanId?: number | null;
  fromAgentId?: string | null;
  before?: string | null;
  after?: string | null;
  hasLink?: boolean;
  hasFile?: boolean;
}

export async function searchMessages(
  token: string | null,
  params: SearchMessagesParams,
): Promise<MmSearchResponse> {
  const query = new URLSearchParams();
  query.set('q', params.query);
  if (params.orgId) query.set('org_id', params.orgId);
  if (params.channelId) query.set('channel_id', params.channelId);
  if (params.sort) query.set('sort', params.sort);
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit != null) query.set('limit', String(params.limit));
  if (params.fromHumanId != null) query.set('from_human_id', String(params.fromHumanId));
  if (params.fromAgentId) query.set('from_agent_id', params.fromAgentId);
  if (params.before) query.set('before', params.before);
  if (params.after) query.set('after', params.after);
  if (params.hasLink) query.set('has_link', 'true');
  if (params.hasFile) query.set('has_file', 'true');
  return requestJson<MmSearchResponse>(`/api/human/mm/search?${query.toString()}`, { token });
}

/** Broad content-type bucket for the chat-details "Media" / "Files"
 *  tabs. The endpoint also accepts an explicit ``content_type`` query
 *  param (exact match, or prefix when the value ends with ``/``) for
 *  narrower filters — see ``ListChannelAttachmentsParams.contentType``.
 *
 *  - ``image`` / ``video`` — leading ``content_type`` prefix match
 *  - ``media`` — union of the two, in one chronological stream (drives
 *    the unified Media tab so a video posted between two images stays
 *    in place)
 *  - ``file`` — everything else (audio, application/*, text/*, …)
 *  - ``all`` — no content-type filter; every uploaded attachment
 */
export type MmAttachmentKind = 'image' | 'video' | 'media' | 'file' | 'all';

export interface MmFileListResponse {
  files: MmFile[];
  limit: number;
  has_more: boolean;
  /** ``file_id`` to pass back as ``beforeFileId`` for the next page.
   *  ``null`` when ``has_more`` is false. */
  next_cursor: string | null;
  /** Echoed back when the request used offset pagination. ``null``
   *  on cursor-paginated calls. */
  offset: number | null;
  /** Total matching rows in the channel. Only present when the
   *  request set ``includeTotal: true``; ``null`` otherwise. */
  total: number | null;
}

export interface ListChannelAttachmentsParams {
  /** Broad bucket. Default ``media`` server-side; pass ``all`` for no
   *  content-type filter at all. */
  kind?: MmAttachmentKind;
  /** Exact MIME (e.g. ``"application/pdf"``) or prefix when it ends
   *  with ``/`` (e.g. ``"audio/"``). Overrides ``kind`` when set. */
  contentType?: string;
  /** 1..200. Default 50. */
  limit?: number;
  /** Cursor: file_id from the previous response's ``next_cursor``.
   *  Preferred over ``offset`` — stays correct under concurrent
   *  inserts and is O(limit) at any depth. */
  beforeFileId?: string;
  /** Jump-to-page offset. Slower past a few thousand rows; use
   *  ``beforeFileId`` for sequential pagination. */
  offset?: number;
  /** Opt-in for the ``total`` field in the response. Off by default
   *  because the underlying COUNT(*) is O(matching_rows). */
  includeTotal?: boolean;
}

export async function listChannelAttachments(
  token: string | null,
  channelId: string,
  params: ListChannelAttachmentsParams = {},
): Promise<MmFileListResponse> {
  const query = new URLSearchParams();
  if (params.kind) query.set('kind', params.kind);
  if (params.contentType) query.set('content_type', params.contentType);
  if (params.limit != null) query.set('limit', String(params.limit));
  if (params.beforeFileId) query.set('before_file_id', params.beforeFileId);
  if (params.offset) query.set('offset', String(params.offset));
  if (params.includeTotal) query.set('include_total', 'true');
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return requestJson<MmFileListResponse>(
    `/api/human/mm/channels/${encodeURIComponent(channelId)}/attachments${suffix}`,
    { token },
  );
}

export interface MmLinkItem {
  url: string;
  post_id: number;
  post_created_at: string;
}

export interface MmLinkListResponse {
  links: MmLinkItem[];
  limit: number;
  has_more: boolean;
  /** ``post_id`` to pass back as ``beforePostId`` for the next page.
   *  ``null`` when the scan didn't saturate. */
  next_cursor: number | null;
  offset: number | null;
}

export interface ListChannelLinksParams {
  limit?: number;
  /** Cursor: post_id from the previous response's ``next_cursor``. */
  beforePostId?: number;
  offset?: number;
}

export async function listChannelLinks(
  token: string | null,
  channelId: string,
  params: ListChannelLinksParams = {},
): Promise<MmLinkListResponse> {
  const query = new URLSearchParams();
  if (params.limit != null) query.set('limit', String(params.limit));
  if (params.beforePostId != null) query.set('before_post_id', String(params.beforePostId));
  if (params.offset) query.set('offset', String(params.offset));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return requestJson<MmLinkListResponse>(
    `/api/human/mm/channels/${encodeURIComponent(channelId)}/links${suffix}`,
    { token },
  );
}

export async function createMmPost(
  token: string | null,
  channelId: string,
  body: {
    message: string;
    parent_post_id?: number | null;
    file_ids?: string[];
    client_msg_uuid?: string | null;
  },
): Promise<MmPost> {
  return requestJson<MmPost>(
    `/api/human/mm/channels/${encodeURIComponent(channelId)}/posts`,
    { method: 'POST', token, body },
  );
}

export async function markMmRead(
  token: string | null,
  channelId: string,
  postId: number,
): Promise<{ channel_id: string; last_read_post_id: number }> {
  return requestJson(
    `/api/human/mm/channels/${encodeURIComponent(channelId)}/read`,
    { method: 'POST', token, body: { post_id: postId } },
  );
}

export async function pingTyping(token: string | null, channelId: string): Promise<void> {
  await requestJson<void>(
    `/api/human/mm/channels/${encodeURIComponent(channelId)}/typing`,
    { method: 'POST', token },
  );
}

export async function toggleReaction(
  token: string | null,
  postId: number,
  emoji: string,
): Promise<MmPost> {
  return requestJson<MmPost>(`/api/human/mm/posts/${postId}/reactions`, {
    method: 'POST',
    token,
    body: { emoji },
  });
}

export async function editMmPost(
  token: string | null,
  postId: number,
  message: string,
): Promise<MmPost> {
  return requestJson<MmPost>(`/api/human/mm/posts/${postId}`, {
    method: 'PATCH',
    token,
    body: { message },
  });
}

export async function deleteMmPost(token: string | null, postId: number): Promise<void> {
  await requestJson<void>(`/api/human/mm/posts/${postId}`, { method: 'DELETE', token });
}

export async function pinMmPost(token: string | null, postId: number): Promise<MmPost> {
  return requestJson<MmPost>(`/api/human/mm/posts/${postId}/pin`, {
    method: 'POST',
    token,
  });
}

export async function unpinMmPost(token: string | null, postId: number): Promise<MmPost> {
  return requestJson<MmPost>(`/api/human/mm/posts/${postId}/pin`, {
    method: 'DELETE',
    token,
  });
}

export interface MmFileUploadRequestBody {
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256?: string;
  has_thumbnail?: boolean;
  thumbnail_size_bytes?: number;
}

export interface MmFileUploadResponse {
  file_id: string;
  upload_url: string;
  upload_headers: Record<string, string>;
  upload_expires_in: number;
  thumbnail_upload_url?: string | null;
  thumbnail_upload_headers?: Record<string, string> | null;
  thumbnail_object_key?: string | null;
}

export interface MmFileConfirmBody {
  width?: number;
  height?: number;
  duration_ms?: number;
  sha256?: string;
  thumbnail_uploaded?: boolean;
}

export async function requestFileUpload(
  token: string | null,
  channelId: string,
  body: MmFileUploadRequestBody,
): Promise<MmFileUploadResponse> {
  return requestJson<MmFileUploadResponse>(
    `/api/human/mm/channels/${encodeURIComponent(channelId)}/files`,
    { method: 'POST', token, body },
  );
}

export async function confirmFileUpload(
  token: string | null,
  fileId: string,
  body: MmFileConfirmBody,
): Promise<MmFile> {
  return requestJson<MmFile>(`/api/human/mm/files/${encodeURIComponent(fileId)}/confirm`, {
    method: 'POST',
    token,
    body,
  });
}

export async function getFileDownloadUrl(
  token: string | null,
  fileId: string,
): Promise<{ url: string; expires_in: number; expires_at: number }> {
  return requestJson(`/api/human/mm/files/${encodeURIComponent(fileId)}/url`, { token });
}

export interface LinkPreviewData {
  url: string;
  canonical_url: string | null;
  title: string | null;
  description: string | null;
  image_url: string | null;
  site_name: string | null;
  fetched_at: number;
  error: string | null;
}

/** Fetch an OpenGraph card for ``url`` via the server-side unfurler.
 *  The server caches results in Redis, so calling this for the same URL
 *  from many clients only hits the upstream once. Always returns a
 *  payload — failure cases come back with ``error`` set instead of
 *  throwing. */
export async function fetchLinkPreview(
  token: string | null,
  url: string,
): Promise<LinkPreviewData> {
  return requestJson<LinkPreviewData>('/api/human/mm/link-preview', {
    method: 'POST',
    token,
    body: { url },
  });
}

// ---------------------------------------------------------------------------
// Org members + agents (used by quick-action picker sheets).
// ---------------------------------------------------------------------------

export type OrgRole = 'owner' | 'member';

export interface OrgMember {
  human_id: number;
  email: string;
  display_name?: string | null;
  role: OrgRole;
  avatar?: AvatarRef | null;
}

export interface AgentUser {
  agent_id: string;
  display_name?: string | null;
  nickname?: string | null;
  avatar?: AvatarRef | null;
}

export async function listOrgMembers(
  token: string | null,
  orgId: string,
): Promise<{ members: OrgMember[]; total: number }> {
  if (!orgId) throw new Error('orgId is required');
  return requestJson<{ members: OrgMember[]; total: number }>(
    `/api/human/orgs/${encodeURIComponent(orgId)}/members`,
    { token },
  );
}

export async function listOrgAgents(
  token: string | null,
  orgId: string,
): Promise<{ agents: AgentUser[]; total?: number }> {
  if (!orgId) throw new Error('orgId is required');
  return requestJson<{ agents: AgentUser[]; total?: number }>(
    `/api/human/orgs/${encodeURIComponent(orgId)}/agents`,
    { token },
  );
}

// ---------------------------------------------------------------------------
// Channel + DM creation, member adds, discovery, join.
// ---------------------------------------------------------------------------

export type MmMemberType = 'human' | 'agent';

export interface MmDiscoverableChannel {
  channel_id: string;
  name: string;
  display_name?: string | null;
  member_count: number;
}

export async function createMmChannel(
  token: string | null,
  orgId: string,
  name: string,
  displayName: string | null,
  channelType: 'public' | 'private' = 'public',
): Promise<MmChannel> {
  if (!orgId) throw new Error('orgId is required');
  return requestJson<MmChannel>('/api/human/mm/channels', {
    method: 'POST',
    token,
    body: {
      org_id: orgId,
      name,
      display_name: displayName,
      channel_type: channelType,
    },
  });
}

export async function addMmChannelMember(
  token: string | null,
  channelId: string,
  memberId: string,
  memberType: MmMemberType,
): Promise<void> {
  await requestJson<unknown>(
    `/api/human/mm/channels/${encodeURIComponent(channelId)}/members`,
    {
      method: 'POST',
      token,
      body: { member_id: memberId, member_type: memberType },
    },
  );
}

export async function removeMmChannelMember(
  token: string | null,
  channelId: string,
  memberId: string,
  memberType: MmMemberType,
): Promise<void> {
  const query = new URLSearchParams({ member_type: memberType }).toString();
  await requestJson<unknown>(
    `/api/human/mm/channels/${encodeURIComponent(channelId)}/members/${encodeURIComponent(memberId)}?${query}`,
    { method: 'DELETE', token },
  );
}

/** Semantic shortcut for the current user leaving a channel — mirrors
 *  the web client's ``leaveMmChannel`` helper. The server fires a
 *  ``channel.removed`` SSE event after the row is gone, which the
 *  realtime handler picks up to evict the channel from the sidebar
 *  and drop dependent caches (posts, members). */
export async function leaveMmChannel(
  token: string | null,
  channelId: string,
  humanId: number,
): Promise<void> {
  await removeMmChannelMember(token, channelId, String(humanId), 'human');
}

export interface MmMuteResponse {
  channel_id: string;
  muted: boolean;
}

/** Toggle (or set) the per-user muted flag on a channel. The server
 *  echoes a ``channel.muted`` SSE event so any open chat-details
 *  surfaces on other devices update without polling. Returns the new
 *  state for the caller to confirm against the optimistic UI patch. */
export async function setMmChannelMuted(
  token: string | null,
  channelId: string,
  muted: boolean,
): Promise<MmMuteResponse> {
  return requestJson<MmMuteResponse>(
    `/api/human/mm/channels/${encodeURIComponent(channelId)}/mute`,
    {
      method: 'POST',
      token,
      body: { muted },
    },
  );
}

export interface MmPinResponse {
  channel_id: string;
  pinned: boolean;
}

/** Toggle (or set) the per-user pinned flag on a channel. Per-user UI
 *  state — the server echoes ``channel.pinned`` on the user topic so
 *  every device of this user updates, but other members are unaffected.
 *  Returns the new state to confirm the optimistic UI patch. */
export async function setMmChannelPinned(
  token: string | null,
  channelId: string,
  pinned: boolean,
): Promise<MmPinResponse> {
  return requestJson<MmPinResponse>(
    `/api/human/mm/channels/${encodeURIComponent(channelId)}/pin`,
    {
      method: 'POST',
      token,
      body: { pinned },
    },
  );
}

export async function createOrGetMmDirect(
  token: string | null,
  orgId: string,
  targetType: MmMemberType,
  targetId: string,
): Promise<MmChannel> {
  return requestJson<MmChannel>('/api/human/mm/direct', {
    method: 'POST',
    token,
    body: { org_id: orgId, target_type: targetType, target_id: targetId },
  });
}

export async function listDiscoverableMmChannels(
  token: string | null,
  orgId: string,
): Promise<{ channels: MmDiscoverableChannel[]; total: number }> {
  if (!orgId) throw new Error('orgId is required');
  return requestJson<{ channels: MmDiscoverableChannel[]; total: number }>(
    `/api/human/mm/channels/discoverable?org_id=${encodeURIComponent(orgId)}`,
    { token },
  );
}

export async function joinMmChannel(
  token: string | null,
  channelId: string,
): Promise<MmChannel> {
  return requestJson<MmChannel>(
    `/api/human/mm/channels/${encodeURIComponent(channelId)}/join`,
    { method: 'POST', token },
  );
}

// ---------------------------------------------------------------------------
// Agent signup — the "Add agent" flow polls these for owner approval.
// ---------------------------------------------------------------------------

export type AgentSignupStatus = 'pending_approval' | 'approved' | 'rejected';

export interface AgentSignupSession {
  session_token: string;
  challenge: string;
}

export interface AgentSignupRequest {
  request_id: string;
  org_id: string;
  agent_id?: string | null;
  display_name?: string | null;
  status: AgentSignupStatus;
  created_at: string;
}

export async function startHumanAgentSignup(
  token: string | null,
  orgId: string,
): Promise<AgentSignupSession> {
  if (!orgId) throw new Error('orgId is required');
  return requestJson<AgentSignupSession>('/api/human/agent_signup', {
    method: 'POST',
    token,
    // `requestJson` JSON-encodes `body` itself — pass the raw object, not a
    // pre-stringified string, or the body double-encodes to a JSON string
    // literal and the backend rejects it with 422.
    body: { org_id: orgId },
  });
}

export async function listOrgSignupRequests(
  token: string | null,
  orgId: string,
): Promise<{ requests: AgentSignupRequest[] }> {
  if (!orgId) throw new Error('orgId is required');
  return requestJson<{ requests: AgentSignupRequest[] }>(
    `/api/human/orgs/${encodeURIComponent(orgId)}/signup-requests`,
    { token },
  );
}

export async function approveAgentSignupRequest(
  token: string | null,
  orgId: string,
  requestId: string,
): Promise<AgentSignupRequest> {
  if (!orgId) throw new Error('orgId is required');
  if (!requestId) throw new Error('requestId is required');
  return requestJson<AgentSignupRequest>(
    `/api/human/orgs/${encodeURIComponent(orgId)}/signup-requests/${encodeURIComponent(requestId)}/approve`,
    { method: 'POST', token },
  );
}

export async function rejectAgentSignupRequest(
  token: string | null,
  orgId: string,
  requestId: string,
): Promise<AgentSignupRequest> {
  if (!orgId) throw new Error('orgId is required');
  if (!requestId) throw new Error('requestId is required');
  return requestJson<AgentSignupRequest>(
    `/api/human/orgs/${encodeURIComponent(orgId)}/signup-requests/${encodeURIComponent(requestId)}/reject`,
    { method: 'POST', token },
  );
}
