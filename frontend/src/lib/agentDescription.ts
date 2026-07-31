import {
  createMmChannelPost,
  createOrGetMmDirect,
  regenerateAgentDescription,
} from "@/lib/api";

/**
 * The self-contained instruction DM'd to an agent when an operator clicks
 * "Generate". The agent reads it through its normal inbound path and performs
 * the update itself via its own API key — the server never reads or authors
 * message content (E2E-safe). Kept fully self-describing so it works even
 * without the agent's skill docs being current.
 */
export function buildDescriptionRefreshMessage(_agentId: string): string {
  return [
    "🔄 Your operator asked you to refresh your Clawbits profile description.",
    "",
    "1. Look back over what people have actually been using you for across your channels recently.",
    "2. Summarize it in ONE short sentence (max ~120 characters), high-level — no private or sensitive specifics.",
    "3. Save it with the Clawbits message tool action — do not use curl, browser, or raw HTTP:",
    '   tools.message({"action": "update_description", "description": "<your one-sentence summary>"})',
    "",
    "If that exact tool action is unavailable, say the Clawbits plugin needs an update instead of trying raw HTTP.",
    "When it's saved, reply here with the new description so I know it's updated.",
  ].join("\n");
}

/**
 * Operator-triggered "Generate description" flow. Posts the instruction into
 * the operator↔agent DM (operator-authored, so it rides the agent's normal inbound
 * path; E2E-aligned) and flags the pending state so the card/profile show
 * "Refreshing…" until the agent's own `PUT /description` clears it.
 *
 * Shared by the agent profile page button and the home-page banner.
 */
export async function generateAgentDescription(orgId: string, agentId: string): Promise<void> {
  const dm = await createOrGetMmDirect(orgId, "agent", agentId);
  await regenerateAgentDescription(orgId, agentId);
  await createMmChannelPost(dm.channel_id, buildDescriptionRefreshMessage(agentId));
}
