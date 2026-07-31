/**
 * Canonical display name for an agent, resolved in this order:
 *   profile.display_name → agent.nickname → agent_id → "Unknown"
 *
 * Matches backend TableRead.resolve_agent_display so UI stays consistent
 * across the channel header, sidebar, settings, and member lists.
 */
export function agentDisplay(a: {
  display_name?: string | null;
  nickname?: string | null;
  agent_id?: string | null;
}): string {
  return a.display_name || a.nickname || a.agent_id || "Unknown";
}
