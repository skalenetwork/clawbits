/**
 * Pure helpers shared across the chat surface — grouping logic,
 * mention extraction, and display-name resolution. Lifted out of
 * ``ChannelPage.tsx`` so the page can stay focused on top-level
 * state orchestration and so the message-row module can import
 * them without circular dependency on the page.
 */
import { parseUtcTimestamp } from "@/lib/formatting";
import type { MmChannelMember, MmChannelPost } from "@/lib/api";

/** Shareable deep link to one message — ``ChannelPage`` reads ``?msg=`` and
 *  anchors its history window on that post. A copied link has to open in a
 *  browser, so the baked API origin (app and API share one in production)
 *  wins over the desktop shell's ``tauri://`` one. */
export function messageLink(channelId: string, postId: number): string {
  const baked = (import.meta.env.VITE_CLAWBITS_API_URL as string | undefined)?.trim();
  return `${baked || window.location.origin}/channels/${channelId}?msg=${postId}`;
}

/** Window inside which consecutive posts from the same author are
 *  collapsed under a single author header. 5 minutes matches the
 *  Slack / Discord convention. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** True when ``a`` and ``b`` were authored by the same actor (agent or
 *  human). Used by the group-header logic to decide whether the second
 *  post needs its own author chip. */
export function samePoster(a: MmChannelPost, b: MmChannelPost): boolean {
  return a.agent_id === b.agent_id && a.human_id === b.human_id;
}

/** True when two ISO timestamps fall on the same calendar day in the
 *  viewer's local timezone. Used by the day-separator pill. */
export function isSameDay(a: string, b: string): boolean {
  const da = parseUtcTimestamp(a);
  const db = parseUtcTimestamp(b);
  return da.getFullYear() === db.getFullYear()
    && da.getMonth() === db.getMonth()
    && da.getDate() === db.getDate();
}

/** Best-effort author label for a post. Prefers the snapshot the
 *  server attached at read time (``poster_display_name``); falls back
 *  to the agent id or a synthetic ``User N`` when the snapshot is
 *  missing (legacy rows). */
export function posterName(post: MmChannelPost): string {
  if (post.poster_display_name) return post.poster_display_name;
  if (post.agent_id) return post.agent_id;
  if (post.human_id != null) return `User ${String(post.human_id)}`;
  return "Unknown";
}

/** ``@handle`` slug for a member — used by the composer's mention
 *  autocomplete and rendered as the literal text in the message body.
 *  Agents already have a stable id, humans get their display name
 *  collapsed to a safe slug. */
export function mentionHandle(member: MmChannelMember): string {
  if (member.agent_id) return member.agent_id;
  const base =
    member.display_name?.trim() ||
    (member.human_id != null ? `user-${String(member.human_id)}` : "user");
  return base.replace(/\s+/g, "-").replace(/[^A-Za-z0-9_.-]/g, "");
}

/** Human-readable label for a member, used as the suggestion-row
 *  primary text in the mention popover. */
export function mentionLabel(member: MmChannelMember): string {
  return (
    member.display_name?.trim() ||
    member.agent_id ||
    (member.human_id != null ? `User ${String(member.human_id)}` : "Unknown")
  );
}

/** One-line stand-in for a message body that has no text. A post is
 *  allowed to be attachment-only (the composer enables Send as soon as
 *  a file is ready), so anywhere a body is quoted at one-line size —
 *  the reply strip in the composer, the quote-block above a reply — an
 *  empty body means "attachments" far more often than it means
 *  "nothing". Wording matches the channel-list previews.
 *  Returns ``null`` when there is genuinely nothing to show. */
export function attachmentOnlyLabel(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "Attachment" : `${String(count)} attachments`;
}

/** Text to render for a quoted message body: its own text when it has
 *  any, else an attachment label, else a last-resort placeholder. */
export function quotedBodyText(text: string, attachmentCount: number): string {
  return text.trim() || attachmentOnlyLabel(attachmentCount) || "(empty message)";
}

/** Parse the in-progress ``@`` mention at the caret. Returns the
 *  selection range and the query string after the ``@``, or ``null``
 *  if the caret isn't currently sitting on a mention. */
export function extractMentionQuery(
  text: string,
  caret: number,
): { start: number; end: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)@([A-Za-z0-9_.-]*)$/.exec(before);
  if (!match) return null;
  const query = match[1] ?? "";
  const start = before.length - query.length - 1;
  return { start, end: caret, query };
}

/** Parse the in-progress ``#`` channel reference at the caret. Same
 *  shape as :func:`extractMentionQuery` — anchored on ``#`` at word
 *  start (line start or after whitespace), characters limited to the
 *  channel-name alphabet (``A-Za-z0-9_.-``). Returns ``null`` when
 *  the caret isn't sitting on a channel ref. */
export function extractChannelQuery(
  text: string,
  caret: number,
): { start: number; end: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)#([A-Za-z0-9_.-]*)$/.exec(before);
  if (!match) return null;
  const query = match[1] ?? "";
  const start = before.length - query.length - 1;
  return { start, end: caret, query };
}
