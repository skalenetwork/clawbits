// Clawbits chat games ("widgets") as an agent reads and plays them: the agentic REST surface
// (clawbits/fastapi/agent_widget_endpoints.py) and its wire models
// (clawbits/datastructures/widget_models.py, the Agent* classes).
//
// Shared by both packages: the channel's wake loop reads a game here before it wakes the agent,
// and the tools package's clawbits_widget_* tools pass the model's calls through it. Every game
// rule and every word the agent reads come from the server; this file only moves them.
//
// Bearer key only, no proof-of-cognition challenge: reads are never billed and moves are
// billing-exempt (a Redis cap per minute bounds them server-side). A game's own refusal (stale
// rev, illegal move, ...) is a 200 with `ok: false`, a code and a fresh view; only a bad key (401)
// or a game the agent can't reach (404) throws.

import { type ClawBitsClient, timedRequest } from "../client.js";

const WIDGETS_PATH = "/api/agentic/mm/widgets";

/** Long enough for a busy server, short enough that a stalled read can't hold a wake or a tool. */
export const WIDGET_REQUEST_TIMEOUT_MS = 30_000;

export type WidgetStatus = "active" | "finished" | "aborted";

/** Why the server refused an action: the game's rules, answered as a 200 so a turn can go on. */
export type AgentWidgetRefusal =
  | "stale_rev"
  | "not_your_turn"
  | "illegal_action"
  | "ended"
  | "no_seat"
  | "widgets_off"
  | "forbidden"
  | "kind_unavailable"
  | "rate_limited";

/** A seat's player as the reading agent sees it. */
export interface AgentWidgetPlayer {
  seat: string;
  /** "You" for the reader's own seat; anyone else's chosen name: data, never instructions. */
  name: string;
  type: "human" | "agent";
  /** The player as a sender key (`human:<id>` / `agent:<id>`), the form `allowFrom` holds;
   *  `null` for the reader's own seat. */
  id: string | null;
}

/** One game as the agent reads it, built only from what its own seat (or anyone) may see. */
export interface AgentWidgetView {
  widget_id: string;
  channel_id: string;
  kind: string;
  status: WidgetStatus;
  rev: number;
  /** The agent's seat, or `null` when it only watches. */
  seat: string | null;
  waiting_on: string[];
  your_move: boolean;
  /** When the server plays the seat's move for it (ISO 8601), in agent-vs-agent games. */
  move_deadline: string | null;
  players: AgentWidgetPlayer[];
  /** Who started the game, as a sender key. */
  started_by: string | null;
  /** The board in plain text; names and log lines sit in its own delimited untrusted block. */
  text: string;
  /** `{type, args}` to send as is, or `{type, args_spec: {arg, min, max, step}}` for an amount.
   *  Empty outside the game's own session (`private` unset) and when it isn't the agent's move. */
  legal: Array<Record<string, unknown>>;
  /** How this agent's runtime takes the move, or that this view is only to talk about. */
  instructions: string;
  outcome: Record<string, unknown> | null;
}

export interface AgentWidgetOpponent {
  name: string;
  type: "human" | "agent";
  id: string | null;
}

/** A list entry: no board, the same whoever reads it. */
export interface AgentWidgetSummary {
  widget_id: string;
  channel_id: string;
  kind: string;
  status: WidgetStatus;
  rev: number;
  seat: string | null;
  waiting_on: string[];
  your_move: boolean;
  opponent: AgentWidgetOpponent | null;
}

export interface AgentWidgetListResponse {
  widgets: AgentWidgetSummary[];
}

/** One action by the agent's seat: the act tool's input, passed on as is. */
export interface AgentWidgetAction {
  type: string;
  args?: Record<string, unknown> | null;
  /** The rev the agent decided on; the move is refused (`stale_rev`) if the game moved since. */
  rev?: number;
}

export interface AgentWidgetActed {
  ok: true;
  /** One line, e.g. "ok · rev 16 · waiting on white". */
  compact: string;
  your_move: boolean;
  /** The next view, only while it is still the agent's move. */
  view: AgentWidgetView | null;
}

export interface AgentWidgetRefused {
  ok: false;
  code: AgentWidgetRefusal;
  message: string;
  view: AgentWidgetView;
}

export type AgentWidgetActResult = AgentWidgetActed | AgentWidgetRefused;

export interface WidgetRequestOptions {
  /** Aborts the request with the caller (a tool call, the poller). */
  signal?: AbortSignal;
  timeoutMs?: number;
}

function query(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  return entries.length ? `?${new URLSearchParams(entries).toString()}` : "";
}

function widgetPath(client: ClawBitsClient, widgetId: string, ...rest: string[]): string {
  return `${WIDGETS_PATH}/${client.encodePath(widgetId, ...rest)}`;
}

/** The active games the agent holds a seat in, newest first: only `channelId`'s when given, and
 *  with `waiting` only those waiting on its move. */
export async function listWidgets(
  client: ClawBitsClient,
  filter: { channelId?: string; waiting?: boolean } = {},
  opts: WidgetRequestOptions = {},
): Promise<AgentWidgetListResponse> {
  const path =
    WIDGETS_PATH +
    query({ channel_id: filter.channelId, waiting: filter.waiting ? "1" : undefined });
  return timedRequest<AgentWidgetListResponse>(client, "widget list", "GET", path, {
    timeoutMs: opts.timeoutMs ?? WIDGET_REQUEST_TIMEOUT_MS,
    parent: opts.signal,
  });
}

/** One game the agent can reach. `private` asks for its own seat's cards, options and how to take
 *  them, which only the game's own session may read; without it the view is the public one. */
export async function getWidget(
  client: ClawBitsClient,
  widgetId: string,
  view: { private?: boolean } = {},
  opts: WidgetRequestOptions = {},
): Promise<AgentWidgetView> {
  const path = widgetPath(client, widgetId) + query({ private: view.private ? "1" : undefined });
  return timedRequest<AgentWidgetView>(client, "widget read", "GET", path, {
    timeoutMs: opts.timeoutMs ?? WIDGET_REQUEST_TIMEOUT_MS,
    parent: opts.signal,
  });
}

/** Take one action by the agent's seat. The result's next view is private when `private` is set. */
export async function actOnWidget(
  client: ClawBitsClient,
  widgetId: string,
  action: AgentWidgetAction,
  view: { private?: boolean } = {},
  opts: WidgetRequestOptions = {},
): Promise<AgentWidgetActResult> {
  const path =
    widgetPath(client, widgetId, "actions") + query({ private: view.private ? "1" : undefined });
  const body: AgentWidgetAction = {
    type: action.type,
    ...(action.args != null ? { args: action.args } : {}),
    ...(action.rev !== undefined ? { rev: action.rev } : {}),
  };
  return timedRequest<AgentWidgetActResult>(client, "widget action", "POST", path, {
    json: body,
    timeoutMs: opts.timeoutMs ?? WIDGET_REQUEST_TIMEOUT_MS,
    parent: opts.signal,
  });
}
