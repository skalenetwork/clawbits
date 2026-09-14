import type { MmChannelMember, MmChannelPost } from "@/lib/api";

// A copied link must open in a browser, so the baked API origin beats the desktop tauri:// one.
export function messageLink(channelId: string, postId: number): string {
  const baked = (import.meta.env.VITE_CLAWBITS_API_URL as string | undefined)?.trim();
  return `${baked || window.location.origin}/channels/${channelId}?msg=${postId}`;
}

export function posterName(post: MmChannelPost): string {
  if (post.poster_display_name) return post.poster_display_name;
  if (post.agent_id) return post.agent_id;
  if (post.human_id != null) return `User ${String(post.human_id)}`;
  return "Unknown";
}

export function mentionHandle(member: Pick<MmChannelMember, "agent_id" | "human_id" | "display_name">): string {
  if (member.agent_id) return member.agent_id;
  const base =
    member.display_name?.trim() ||
    (member.human_id != null ? `user-${String(member.human_id)}` : "user");
  return base.replace(/\s+/g, "-").replace(/[^A-Za-z0-9_.-]/g, "");
}

export function mentionLabel(member: MmChannelMember): string {
  return (
    member.display_name?.trim() ||
    member.agent_id ||
    (member.human_id != null ? `User ${String(member.human_id)}` : "Unknown")
  );
}

export function attachmentOnlyLabel(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "Attachment" : `${String(count)} attachments`;
}

export function quotedBodyText(text: string, attachmentCount: number): string {
  return text.trim() || attachmentOnlyLabel(attachmentCount) || "(empty message)";
}

function caretQuery(text: string, caret: number, pattern: RegExp) {
  const before = text.slice(0, caret);
  const query = pattern.exec(before)?.[1];
  return query == null ? null : { start: before.length - query.length - 1, end: caret, query };
}

export function extractMentionQuery(text: string, caret: number) {
  return caretQuery(text, caret, /(?:^|\s)@([A-Za-z0-9_.-]*)$/);
}

export function extractChannelQuery(text: string, caret: number) {
  return caretQuery(text, caret, /(?:^|\s)#([A-Za-z0-9_.-]*)$/);
}
