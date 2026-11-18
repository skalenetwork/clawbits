import type { Organization, OrgAgent } from "./models";

/** The server's and the web's window (`AGENT_OFFLINE_AFTER` in mm_models.py, web `agentLiveness.ts`): an agent is
 *  offline once its last alive ping is older than this. */
export const AGENT_OFFLINE_AFTER_MS = 40 * 60 * 1000;

/** A server time in ms: naive UTC ("2026-11-05 15:35:34"), as the server sends it, or ISO with a zone. NaN where it
 *  can't be read. */
export function serverTime(stamp: string): number {
  const trimmed = stamp.trim();
  return Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(trimmed) ? trimmed : `${trimmed.replace(" ", "T")}Z`);
}

/** Whether an agent is offline: it has pinged, but not within the window. One that never has is still being set up,
 *  and one this phone knows nothing of is never called offline either. */
export function agentOffline(lastAliveAt: string | null | undefined, now: number): boolean {
  if (lastAliveAt == null) return false;
  const at = serverTime(lastAliveAt);
  return !Number.isNaN(at) && now - at > AGENT_OFFLINE_AFTER_MS;
}

/** An agent's name as people know it. */
export function agentName(agent: OrgAgent): string {
  return agent.nickname || agent.display_name || agent.agent_id;
}

/** The agents whose games this person may switch, by name: those they run, or every one for an owner of the org. An
 *  older server says nothing of the switch, so none there. */
export function gameSwitchAgents(agents: OrgAgent[], org: Organization | undefined): OrgAgent[] {
  return agents
    .filter((agent) => agent.widgets_enabled !== undefined && (agent.is_operator || org?.my_role === "owner"))
    .sort((a, b) => agentName(a).localeCompare(agentName(b)));
}
