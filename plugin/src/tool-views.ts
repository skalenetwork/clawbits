/**
 * Model-facing projections of Clawbits API responses.
 *
 * Server payloads are shaped for the human dashboard: avatars, presigned
 * URLs, sidebar preview rows, per-viewer pin/mute state, denormalised author
 * snapshots. None of it is actionable by an agent and all of it costs tokens
 * in every tool result, so each response is narrowed here to the fields the
 * model can use. Field names stay snake_case, matching the ids the agent
 * already sees in its prompt.
 */
import type { EmailDetail } from "./tools/email.js";

interface ServerMember {
  agent_id?: string | null;
  human_id?: number | null;
}

interface ServerChannel {
  channel_id: string;
  name?: string;
  display_name?: string | null;
  channel_type?: string;
  private?: boolean;
  last_message_at?: string | null;
  latest_post_id?: number | null;
  unread_count?: number;
  dm_peer_human_id?: number | null;
  dm_peer_agent_id?: string | null;
}

interface ServerPost extends ServerMember {
  post_id: number;
  status?: string;
  poster_display_name?: string | null;
  message?: string;
  created_at?: string;
  edited_at?: string | null;
  parent_post_id?: number | null;
  reactions?: Array<{ emoji: string; count: number; agent_ids?: string[] }>;
  files?: Array<{
    file_id: string;
    filename: string;
    content_type: string;
    size_bytes: number;
  }>;
}

interface ServerSearchHit {
  post_id: number;
  channel_id: string;
  channel_display_name?: string | null;
  created_at?: string;
  author?: ServerMember & { display_name?: string | null };
  snippet?: string;
}

/** The `human:<id>` / `agent:<id>` form the agent already reads in its prompt
 *  history and writes in `allowFrom`. */
function sender(member: ServerMember | undefined): string {
  if (member?.agent_id) return `agent:${member.agent_id}`;
  if (typeof member?.human_id === "number") return `human:${member.human_id}`;
  return "unknown";
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
};

/** Search snippets arrive as `ts_headline` output: matches wrapped in `<mark>`,
 *  the rest HTML-escaped for the dashboard. The model wants the plain text. */
function plainSnippet(snippet: string | undefined): string {
  return (snippet ?? "")
    .replace(/<\/?mark>/gu, "")
    .replace(/&(?:amp|lt|gt|quot|#39|#x27);/gu, (entity) => ENTITIES[entity] ?? entity);
}

export function summarizeChannels(raw: unknown) {
  // The list route returns an envelope, but a bare array has also come back off
  // this path (extractChannels in the inbound poller accepts both). Reading only
  // the envelope would report "no channels" instead of failing loudly.
  const listing = raw as { channels?: ServerChannel[] } | ServerChannel[] | null;
  const channels = Array.isArray(listing) ? listing : (listing?.channels ?? []);
  return channels.map((channel) => ({
    channel_id: channel.channel_id,
    display_name: channel.display_name ?? channel.name,
    channel_type: channel.channel_type,
    private: channel.private,
    unread_count: channel.unread_count,
    last_message_at: channel.last_message_at,
    latest_post_id: channel.latest_post_id,
    ...(channel.dm_peer_agent_id || typeof channel.dm_peer_human_id === "number"
      ? { dm_peer: sender({ agent_id: channel.dm_peer_agent_id, human_id: channel.dm_peer_human_id }) }
      : {}),
  }));
}

export function summarizePosts(raw: unknown) {
  const { posts } = raw as { posts?: ServerPost[] };
  return (posts ?? []).map((post) => ({
    post_id: post.post_id,
    sender: sender(post),
    ...(post.poster_display_name ? { sender_name: post.poster_display_name } : {}),
    created_at: post.created_at,
    message: post.message,
    // Listings include `streaming` posts, i.e. a reply mid-generation.
    ...(post.status && post.status !== "published" ? { status: post.status } : {}),
    ...(post.edited_at ? { edited_at: post.edited_at } : {}),
    ...(post.parent_post_id ? { parent_post_id: post.parent_post_id } : {}),
    ...(post.reactions?.length ? { reactions: post.reactions } : {}),
    ...(post.files?.length
      ? {
          files: post.files.map(({ file_id, filename, content_type, size_bytes }) => ({
            file_id,
            filename,
            content_type,
            size_bytes,
          })),
        }
      : {}),
  }));
}

export function summarizeSearch(raw: unknown) {
  const response = raw as {
    results?: ServerSearchHit[];
    next_cursor?: string | null;
    scope?: string;
  };
  return {
    scope: response.scope,
    ...(response.next_cursor ? { next_cursor: response.next_cursor } : {}),
    results: (response.results ?? []).map((hit) => ({
      post_id: hit.post_id,
      channel_id: hit.channel_id,
      channel: hit.channel_display_name,
      sender: sender(hit.author),
      ...(hit.author?.display_name ? { sender_name: hit.author.display_name } : {}),
      created_at: hit.created_at,
      snippet: plainSnippet(hit.snippet),
    })),
  };
}

/** Attachment bodies are base64 and can be megabytes; the agent gets the
 *  metadata and fetches nothing. */
export function summarizeEmail(detail: EmailDetail) {
  const attachments = detail.attachments;
  if (!attachments?.length) return detail;
  return {
    ...detail,
    attachments: attachments.map((attachment) => ({
      filename: attachment.filename,
      ...(attachment.content_type !== undefined ? { content_type: attachment.content_type } : {}),
      size:
        typeof attachment.size === "number"
          ? attachment.size
          : Math.floor((attachment.content_b64.length * 3) / 4),
    })),
    attachments_note: "Attachment bodies are omitted from tool output; metadata only.",
  };
}
