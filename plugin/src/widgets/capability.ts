// What the agent tells the server it can do, on every alive ping (`capabilities`, which the server
// stores whole: a ping without one reports none). `widgets` lets people seat the agent in chat
// games, so it is claimed only when a game could actually be played here:
//   - the account didn't turn games off (`channels.clawbits[.accounts.<id>].widgets: false`);
//   - a game can have a session of its own: OpenClaw routes a game peer to its own session, with
//     bindings and `session.groupScope` applied, exactly as a move's dispatch checks it
//     (widgets/session.ts);
//   - the tools plugin registered `clawbits_widget_act` in this gateway (it reports its tools
//     through the service handoff, so an older tools plugin without it never claims games);
//   - OpenClaw's tool policy shows that optional tool to the agent a game routes to.

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { companionToolRegistered } from "../service-handoff.js";
import type { ResolvedClawBitsAccount } from "../types.js";
import { isOwnGameSession } from "./session.js";

export const WIDGETS_CAPABILITY = "widgets";
export const WIDGET_ACT_TOOL = "clawbits_widget_act";
export const TOOLS_PLUGIN_ID = "clawbits-tools";
/** The game a capability probe routes: every game peer routes alike. */
export const GAME_ROUTE_PROBE = "probe";

/** Where a game would run: OpenClaw's route for a game peer (`gamePeerId(GAME_ROUTE_PROBE)`). */
export interface GameRoute {
  agentId?: string;
  sessionKey: string;
}

interface ToolPolicy {
  allow?: unknown;
  alsoAllow?: unknown;
  deny?: unknown;
}

function entries(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string").map((v) => v.trim().toLowerCase())
    : [];
}

function globMatches(pattern: string, name: string): boolean {
  if (!pattern.includes("*")) return pattern === name;
  const source = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${source.join(".*")}$`).test(name);
}

/** The agent's own `tools` block (`agents.list[]` or `agents.entries`), when configured. */
function agentToolPolicy(cfg: OpenClawConfig | undefined, agentId: string | undefined): ToolPolicy | undefined {
  if (!agentId) return undefined;
  const agents = (cfg as { agents?: { list?: unknown; entries?: unknown } } | undefined)?.agents;
  const wanted = agentId.trim().toLowerCase();
  if (agents?.entries && typeof agents.entries === "object") {
    const key = Object.keys(agents.entries).find((id) => id.trim().toLowerCase() === wanted);
    return key === undefined
      ? undefined
      : ((agents.entries as Record<string, { tools?: ToolPolicy }>)[key]?.tools ?? undefined);
  }
  if (Array.isArray(agents?.list)) {
    const entry = (agents.list as Array<{ id?: unknown; tools?: ToolPolicy }>).find(
      (e) => typeof e?.id === "string" && e.id.trim().toLowerCase() === wanted,
    );
    return entry?.tools;
  }
  return undefined;
}

/**
 * Whether OpenClaw shows an optional plugin tool to the agent. Optional tools are never part of
 * the default surface (src/plugins/tools.ts, createPluginToolAllowlist): an explicit
 * `tools.allow` / `tools.alsoAllow` entry, global or the agent's own, must name the tool, its
 * plugin, `group:plugins` or `*`; and no `tools.deny` entry (a glob included) may take it away.
 * An allow glob counts only from OpenClaw 2026.9.1, past the plugin's floor, so it never claims
 * here: under-claiming hides games from one agent, over-claiming stalls every game it is seated in.
 */
export function optionalToolAllowed(
  cfg: OpenClawConfig | undefined,
  toolName: string,
  pluginId: string,
  agentId?: string,
): boolean {
  const global = (cfg as { tools?: ToolPolicy } | undefined)?.tools;
  const own = agentToolPolicy(cfg, agentId);
  const name = toolName.toLowerCase();
  const plugin = pluginId.toLowerCase();
  const names = (entry: string): boolean =>
    entry === "*" || entry === "group:plugins" || entry === plugin || entry === name;
  const allow = [global?.allow, global?.alsoAllow, own?.allow, own?.alsoAllow].flatMap(entries);
  const deny = [global?.deny, own?.deny].flatMap(entries);
  return allow.some(names) && !deny.some((entry) => names(entry) || globMatches(entry, name));
}

/** Whether this account may claim `widgets` (see the head of this file). `route` is where a game
 *  would run; none (the host routes nothing) means no game could be played. */
export function widgetsAvailable(
  cfg: OpenClawConfig | undefined,
  account: Pick<ResolvedClawBitsAccount, "widgets">,
  route: GameRoute | undefined,
  toolRegistered: (name: string) => boolean = companionToolRegistered,
): boolean {
  return (
    account.widgets !== false &&
    route !== undefined &&
    isOwnGameSession(route.sessionKey, GAME_ROUTE_PROBE) &&
    toolRegistered(WIDGET_ACT_TOOL) &&
    optionalToolAllowed(cfg, WIDGET_ACT_TOOL, TOOLS_PLUGIN_ID, route.agentId)
  );
}

/** The capabilities an alive ping reports for this account. */
export function agentCapabilities(
  cfg: OpenClawConfig | undefined,
  account: Pick<ResolvedClawBitsAccount, "widgets">,
  route: GameRoute | undefined,
  toolRegistered?: (name: string) => boolean,
): string[] {
  return widgetsAvailable(cfg, account, route, toolRegistered) ? [WIDGETS_CAPABILITY] : [];
}
