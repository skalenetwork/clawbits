// Build the Discord/Slack-style reactor sentence shown in a reaction's
// tooltip ("You, Alice and PartyLava reacted with 👍").
//
// Lives outside the component so the formatting (You-first ordering,
// truncation past N names, agent + human resolution) can be unit-tested
// without React.

import type { MmChannelMember, MmPostReaction } from "@/lib/api";

/** Past this many distinct reactors the tooltip truncates with "and N
 *  others" to keep the popup compact. */
const MAX_NAMED = 5;

export function formatReactors(
  reaction: MmPostReaction,
  members: ReadonlyArray<MmChannelMember>,
  currentUserId: number | null,
): string | null {
  const names: string[] = [];
  let includesMe = false;

  for (const hid of reaction.human_ids) {
    if (currentUserId != null && hid === currentUserId) {
      includesMe = true;
      continue;
    }
    const m = members.find((mm) => mm.human_id === hid);
    names.push(m?.display_name ?? `User ${String(hid)}`);
  }
  for (const aid of reaction.agent_ids) {
    const m = members.find((mm) => mm.agent_id === aid);
    names.push(m?.display_name ?? aid);
  }

  // "You" always reads first — it's the most relevant reactor for the
  // viewer and matches the Discord convention.
  const ordered = includesMe ? ["You", ...names] : names;
  if (ordered.length === 0) return null;

  let who: string;
  if (ordered.length === 1) {
    who = ordered[0]!;
  } else if (ordered.length === 2) {
    who = `${ordered[0]!} and ${ordered[1]!}`;
  } else if (ordered.length <= MAX_NAMED + 1) {
    who = `${ordered.slice(0, -1).join(", ")} and ${ordered[ordered.length - 1]!}`;
  } else {
    who = `${ordered.slice(0, MAX_NAMED).join(", ")} and ${String(ordered.length - MAX_NAMED)} others`;
  }
  return `${who} reacted with ${reaction.emoji}`;
}
