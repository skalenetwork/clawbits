import type { Channel, Post } from "./models";

export const STAMP_GAP_MS = 60 * 60 * 1000;

export function stampLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (date.toDateString() === now.toDateString()) return `Today ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString())
    return `Yesterday ${time}`;
  const days = (now.getTime() - date.getTime()) / 86_400_000;
  if (days < 7)
    return `${date.toLocaleDateString(undefined, { weekday: "long" })} ${time}`;
  return `${date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  })} ${time}`;
}

export function showStamp(post: Post, previous?: Post): boolean {
  if (!previous) return true;
  if (
    new Date(previous.created_at).toDateString() !==
    new Date(post.created_at).toDateString()
  )
    return true;
  return (
    Date.parse(post.created_at) - Date.parse(previous.created_at) >= STAMP_GAP_MS
  );
}

export function samePerson(a?: Post, b?: Post) {
  return !!a && !!b && a.human_id === b.human_id && a.agent_id === b.agent_id;
}

export function inboxUnread(channels: Pick<Channel, "unread_count">[]): number {
  return channels.reduce((sum, channel) => sum + channel.unread_count, 0);
}

export function backUnreadTitle(total: number): string | undefined {
  if (total <= 0) return undefined;
  return String(total);
}
