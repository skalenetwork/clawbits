/**
 * Shared ``@mention`` token logic for the chat surface. Kept framework-free
 * so the SSE patcher, the sidebar badge, and the channel page agree on
 * exactly which posts count as addressing the current viewer — and so the
 * client mirrors the server-side regex in
 * ``TableRead._human_mention_match_regex``.
 */
import type { HumanUser } from "@/lib/api";

/** The channel-wide mention token. ``@here`` addresses every member of the
 *  channel, so it always counts as mentioning the viewer. Stored lowercased
 *  without the leading ``@`` (the same shape the renderer's tokenizer uses). */
export const HERE_TOKEN = "here";

/** True when a bare (lowercased, no leading ``@``) token is the special
 *  channel-wide ``@here`` mention. */
export function isHereToken(token: string): boolean {
  return token === HERE_TOKEN;
}

/** Bare tokens (no leading ``@``) that resolve to this human in an
 *  ``@mention``: the synthetic ``user-<id>``, the whitespace-stripped
 *  display name, and the canonical autocomplete handle. Mirrors
 *  ``ChannelPage``'s ``myMentionTokens`` and the backend regex so the
 *  in-channel highlight, the sidebar badge, and the optimistic SSE patch
 *  all agree on what "mentions me" means. ``@here`` is intentionally NOT
 *  included here — it's added by the matcher so it counts for everyone. */
export function selfMentionTokens(
  user: Pick<HumanUser, "id" | "display_name"> | null | undefined,
): Set<string> {
  const out = new Set<string>();
  if (user?.id == null) return out;
  out.add(`user-${String(user.id)}`);
  const display = user.display_name?.trim() ?? "";
  if (display) {
    out.add(display.toLowerCase().replace(/\s+/g, ""));
    // Canonical handle the composer autocomplete inserts ("Stan Lee" ->
    // "stan-lee", keeping dots/hyphens already present).
    const handle = display
      .replace(/\s+/g, "-")
      .replace(/[^A-Za-z0-9_.-]/g, "")
      .toLowerCase();
    if (handle) out.add(handle);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does ``message`` address the viewer? Matches ``@here`` or any of the
 *  viewer's ``selfTokens``, bounded by the same character class the
 *  renderer's ``TOKEN_RE`` uses to delimit a mention — so ``@here`` fires
 *  on ``@here!`` / ``@here\n`` but not inside ``@herring``. Case-insensitive,
 *  mirroring the renderer (which lowercases both sides). */
export function messageMentionsViewer(
  message: string,
  selfTokens: ReadonlySet<string>,
): boolean {
  if (!message.includes("@")) return false;
  const alt = [HERE_TOKEN, ...selfTokens].map(escapeRegExp).join("|");
  const re = new RegExp(`@(?:${alt})(?![A-Za-z0-9_.-])`, "i");
  return re.test(message);
}
