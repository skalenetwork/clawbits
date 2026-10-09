import type { InfiniteData } from "@tanstack/react-query";
import type { Widget } from "./widgets";

export interface Avatar {
  url: string;
  kind?: "generated" | "uploaded";
}

export interface User {
  id: number;
  email: string;
  display_name: string | null;
  token?: string | null;
}

export interface Organization {
  org_id: string;
  name: string;
  display_name: string | null;
  avatar?: Avatar | null;
  is_personal: boolean;
  member_count?: number;
  /** Chat widgets (games) allowed in the org's one-to-one chats. */
  widgets_enabled?: boolean;
}

export interface Channel {
  channel_id: string;
  org_id: string | null;
  name: string;
  display_name: string | null;
  channel_type: "public" | "private" | "direct" | "agent_chat";
  dm_peer: { display_name: string | null; avatar: Avatar | null } | null;
  dm_peer_agent_id?: string | null;
  dm_peer_human_id?: number | null;
  avatar: Avatar | null;
  last_message_at: string | null;
  last_message_text: string | null;
  last_message_attachment_count: number;
  last_message_author_human_id?: number | null;
  last_message_author_display_name?: string | null;
  unread_count: number;
  /** The chat's own widgets switch. */
  widgets_enabled?: boolean;
  /** An active widget here waits on the viewer. */
  widget_turn?: boolean;
}

export interface PostFile {
  file_id: string;
  filename: string;
  content_type?: string;
  download_url?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface Post {
  post_id: number;
  channel_id: string;
  human_id: number | null;
  agent_id: string | null;
  poster_display_name: string | null;
  message: string;
  status: "published" | "streaming" | "draft" | "rejected";
  created_at: string;
  updated_at: string | null;
  published_at?: string | null;
  client_msg_uuid?: string | null;
  files: PostFile[];
  steps?: TurnStep[] | null;
  /** The widget this post started; the post shows the widget, never its text. */
  widget_id?: string | null;
}

/** A finished agent turn's tool call or narration, kept on its reply. */
export interface TurnStep {
  kind: "tool" | "note";
  id: string;
  label: string;
  tool: string | null;
  ok: boolean | null;
  duration_ms: number | null;
}

/** What an agent is doing right now, from its status lane. `id` keys one step across all of its events. */
export interface AgentActivity {
  kind: "generating" | "thinking" | "tool" | "tool_done" | "note";
  id?: string;
  label?: string;
  tool?: string;
  ok?: boolean;
  duration_ms?: number;
}

/** A channel member's realtime status; an agent mid-turn says what it is doing. */
export interface MemberStatus {
  member_kind: "agent" | "human";
  member_id: string;
  status: "online" | "idle" | "typing" | "generating" | "offline";
  activity?: AgentActivity;
}

export interface McpConnectLink {
  agent_name: string;
  server: string;
  host: string;
  status: "open" | "connecting" | "connected";
}

export interface PostsPage {
  posts: Post[];
  next?: number | null;
}
export type History = InfiniteData<PostsPage>;
export interface Recipient {
  id: string;
  kind: "human" | "agent";
  name: string;
  avatar: Avatar | null;
}

export type ChatEvent = { channel_id: string } & (
  | { type: "post.created" | "post.updated"; data: Post }
  | { type: "post.deleted"; data: { post_id: number } }
  | { type: "member.status"; data: MemberStatus }
  | { type: "presence.snapshot"; data: { members: MemberStatus[] } }
  | { type: `channel.${"added" | "removed" | "read" | "muted"}` }
  | { type: "widget.updated"; data: Widget }
  | { type: "widget.turn"; data: { my_turn: boolean } }
  | { type: "channel.widgets"; data: { widgets_enabled: boolean } }
);

export function channelName(channel: Channel): string {
  if (channel.channel_type === "agent_chat") return channel.display_name?.trim() || "New chat";
  return channel.dm_peer?.display_name || channel.display_name || channel.name;
}

export function orgName(org: Organization): string {
  return org.display_name || org.name;
}

export function memberCountLabel(count: number): string {
  return count === 1 ? "1 member" : `${count} members`;
}

const updatedAt = (post: Post): number =>
  Date.parse(post.updated_at || post.created_at);

const withPages = (history: History, pages: PostsPage[]): History =>
  pages.every((page, index) => page === history.pages[index])
    ? history
    : { ...history, pages };

export function mergePost(history: History | undefined, post: Post): History {
  if (!history) return { pages: [{ posts: [post] }], pageParams: [null] };
  let found = false;
  const pages = history.pages.map((page) => {
    const current = page.posts.find((item) => item.post_id === post.post_id);
    if (!current) return page;
    found = true;
    if (current === post || updatedAt(current) > updatedAt(post)) return page;
    return {
      ...page,
      posts: page.posts.map((item) => (item === current ? post : item)),
    };
  });
  if (!found && pages[0])
    pages[0] = {
      ...pages[0],
      posts: [post, ...pages[0].posts].sort((a, b) => b.post_id - a.post_id),
    };
  return withPages(history, pages);
}

export function removePost(history: History, id: number): History {
  return withPages(
    history,
    history.pages.map((page) =>
      page.posts.some((post) => post.post_id === id)
        ? { ...page, posts: page.posts.filter((post) => post.post_id !== id) }
        : page,
    ),
  );
}

export function historyPosts(history: History | undefined): Post[] {
  const posts = new Map<number, Post>();
  for (const post of history?.pages.flatMap((page) => page.posts) ?? [])
    if (!posts.has(post.post_id)) posts.set(post.post_id, post);
  return [...posts.values()].sort((a, b) => a.post_id - b.post_id);
}

export function reconcilePage(
  page: PostsPage,
  before: Post[],
  current: Post[],
  first: boolean,
): PostsPage {
  const previous = new Map(before.map((post) => [post.post_id, post]));
  const live = new Set(current.map((post) => post.post_id));
  const posts = new Map(
    page.posts
      .filter((post) => !previous.has(post.post_id) || live.has(post.post_id))
      .map((post) => [post.post_id, post]),
  );
  for (const post of current) {
    const fetched = posts.get(post.post_id);
    if (
      previous.get(post.post_id) !== post &&
      (fetched ? updatedAt(post) >= updatedAt(fetched) : first)
    )
      posts.set(post.post_id, post);
  }
  return {
    ...page,
    posts: [...posts.values()].sort((a, b) => b.post_id - a.post_id),
  };
}
