import type { AgentUser } from "@/lib/api";
import { frecencyKey, frecencyScore, type FrecencyStore } from "@/lib/frecency";

/** Contact is closed by default, so an org can hold agents that are not yours to
 *  talk to: only a ``can_dm`` one can be opened from home. Ranked by how recently
 *  and how often you reached for them, newest agent first on a tie. */
export function rankDmAgents(
  agents: readonly AgentUser[],
  frecency: FrecencyStore,
  now: number,
): AgentUser[] {
  return agents
    .filter((a) => a.can_dm)
    .sort((a, b) => {
      const sa = frecencyScore(frecencyKey("agent", a.agent_id), frecency, now);
      const sb = frecencyScore(frecencyKey("agent", b.agent_id), frecency, now);
      return sa === sb ? (b.creation_time ?? "").localeCompare(a.creation_time ?? "") : sb - sa;
    });
}
