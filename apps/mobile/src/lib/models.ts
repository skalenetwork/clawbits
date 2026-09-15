import type { InfiniteData } from "@tanstack/react-query";

export interface Avatar {
  url: string;
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
  is_personal: boolean;
}

export interface Channel {
  channel_id: string;
  org_id: string | null;
  name: string;
  display_name: string | null;
  channel_type: "public" | "private" | "direct";
  dm_peer: { display_name: string | null; avatar: Avatar | null } | null;
  dm_peer_agent_id?: string | null;
  avatar: Avatar | null;
  last_message_at: string | null;
  last_message_text: string | null;
  last_message_attachment_count: number;
  last_message_author_human_id?: number | null;
  last_message_author_display_name?: string | null;
  unread_count: number;
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
  client_msg_uuid?: string | null;
  files: { file_id: string; filename: string }[];
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
  | { type: `channel.${"added" | "removed" | "read" | "muted"}` }
);

export function channelName(channel: Channel): string {
  return channel.dm_peer?.display_name || channel.display_name || channel.name;
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
