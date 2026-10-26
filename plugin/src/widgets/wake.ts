// The game wake loop (WIDGETS_AGENTS_PLAN §4 P3): turns "a game waits on your move" signals into
// one silent agent turn per move, in the game's own session.
//
// Signals arrive from the agent WebSocket (`widget.turn`, ids only) and from catch-up (the
// snapshot's and channel list's `widget_waiting`, `GET /widgets?waiting=1`), so the same move is
// usually reported several times. Per game:
//   - one pending wake; a newer rev replaces it, an older one is ignored;
//   - `waiting: false` drops it, an ended game drops everything and its session;
//   - a rev already woken is woken again only on a backoff (1, 5, 15 min after its turn ended),
//     then not until the rev changes — a model that stops early can't stall the game, nor loop;
//   - at dispatch the game is read again (its private view): no wake unless it is still the
//     agent's move, the agent isn't snoozed and allowFrom admits every other player.
// Wakes and the end-of-game cleanup run on the inbound queue, behind any chat turn, one at a time.
// A cleanup that finds a run still going on the game's session waits for it (1, 5, 15 min), then
// leaves it to the sweep of ended games' sessions.

import { ClawBitsError } from "../errors.js";
import { type BasicLogger, logDebug, logInfo, logWarn } from "../file-logger.js";
import type { InboundMessage } from "../inbound-poller.js";
import type { AgentWidgetSummary, AgentWidgetView } from "./api.js";
import { GAME_TRANSCRIPT_MARKER, type GameSessionDeletion } from "./session.js";

/** A move the agent is woken for: what downstream silences and routes to the game's session. */
export interface WidgetTurn {
  id: string;
  rev: number;
  kind: string;
  seat: string;
}

/** "This game changed", from any source: whether it now waits on the agent's seat. */
export interface WidgetSignal {
  widgetId: string;
  channelId: string;
  rev: number;
  kind: string;
  seat: string | null;
  waiting: boolean;
  status: string;
}

export type WidgetSignalSource = "ws" | "snapshot" | "list" | "retry";

/** Same-rev re-wakes, counted from the end of the previous wake's turn. */
export const WAKE_RETRY_BACKOFF_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000];

/** An ended game's cleanup again while a run on its session still goes; then the sweep's. */
export const CLEANUP_RETRY_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000];

/** Games remembered as ended, so a late signal can't wake one again. */
const ENDED_MEMORY = 500;

export interface WidgetWakeDeps {
  accountId: string;
  now: () => number;
  snoozed: () => boolean;
  /** allowFrom on a player's sender key (`human:<id>` / `agent:<id>`). */
  allowed: (senderKey: string) => boolean;
  /** The game's private view, read at dispatch. */
  read: (widgetId: string) => Promise<AgentWidgetView>;
  /** Run on the serial inbound queue; `expire` instead when it waited past the queue's TTL. */
  enqueue: (id: string, run: () => Promise<void>, expire: () => void) => void;
  /** Dispatch the turn; whether it settled. */
  dispatch: (msg: InboundMessage) => Promise<boolean>;
  channelType: (channelId: string) => string | null;
  /** A game the agent sat in ended: drop its session. Runs on the queue, after any move; "busy"
   *  (a run on the session still goes) runs it again later. */
  ended?: (widget: { widgetId: string; channelId: string }) => Promise<GameSessionDeletion | void>;
  /** Test seam: schedule a retry; returns its cancel. */
  setTimer?: (run: () => void, ms: number) => () => void;
  log?: BasicLogger;
}

interface GameState {
  channelId: string;
  /** The newest rev any source reported: older signals are stale. */
  latestRev: number;
  pending?: WidgetSignal;
  queued: boolean;
  /** The rev last woken, when its turn ended (or began, while it runs), and how often. */
  woken?: { rev: number; at: number; attempts: number };
  cancelRetry?: () => void;
}

function defaultTimer(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/** A `widget.turn` event (`{type, channel_id, data: {widget_id, rev, kind, seat, waiting, status}}`). */
export function widgetTurnSignal(channelId: unknown, data: unknown): WidgetSignal | undefined {
  if (!data || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;
  if (
    typeof d.widget_id !== "string" ||
    !d.widget_id ||
    typeof channelId !== "string" ||
    typeof d.rev !== "number" ||
    !Number.isFinite(d.rev) ||
    typeof d.status !== "string"
  ) {
    return undefined;
  }
  return {
    widgetId: d.widget_id,
    channelId,
    rev: d.rev,
    kind: typeof d.kind === "string" ? d.kind : "",
    seat: typeof d.seat === "string" ? d.seat : null,
    waiting: d.waiting === true,
    status: d.status,
  };
}

/** The games a channel list (the WebSocket snapshot or `GET /channels`) says wait on the agent:
 *  each channel's `widget_waiting` (`{widget_id, rev, kind, seat}`), active by construction. */
export function waitingSignals(raw: unknown): WidgetSignal[] {
  const channels = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? (raw as { channels?: unknown }).channels
      : undefined;
  if (!Array.isArray(channels)) return [];
  const out: WidgetSignal[] = [];
  for (const channel of channels) {
    if (!channel || typeof channel !== "object") continue;
    const { channel_id: channelId, widget_waiting: waiting } = channel as Record<string, unknown>;
    const signal = widgetTurnSignal(channelId, {
      ...(waiting && typeof waiting === "object" ? waiting : {}),
      waiting: true,
      status: "active",
    });
    if (signal && waiting) out.push(signal);
  }
  return out;
}

/** A `GET /widgets?waiting=1` entry. */
export function summarySignal(summary: AgentWidgetSummary): WidgetSignal {
  return {
    widgetId: summary.widget_id,
    channelId: summary.channel_id,
    rev: summary.rev,
    kind: summary.kind,
    seat: summary.seat,
    waiting: summary.your_move,
    status: summary.status,
  };
}

/** What the agent reads on a move: the server's trusted instructions and legal actions, then the
 *  board, whose names and log lines the server already fenced in their untrusted block. */
export function wakeBody(view: AgentWidgetView): string {
  return [
    // The marker tells the game's transcript by its content (widgets/session.ts).
    `[Clawbits chat game · ${view.kind} · widget_id ${view.widget_id} · rev ${view.rev} · ${GAME_TRANSCRIPT_MARKER}]`,
    view.instructions,
    `legal: ${JSON.stringify(view.legal)}`,
    "[end Clawbits chat game]",
    "",
    view.text,
  ].join("\n");
}

/** The synthetic inbound for a move, modelled on the MCP sign-in wake: a non-numeric post id
 *  (nothing to react to or ack), the opponent as sender, and `widget`, which routes the turn to the
 *  game's own session and keeps it silent. The id names the attempt too: OpenClaw drops an inbound
 *  whose message id it ran in the last 20 minutes (src/auto-reply/reply/inbound-dedupe.ts), which
 *  would make every same-rev retry a silent no-op. */
export function wakeMessage(
  accountId: string,
  view: AgentWidgetView,
  channelType: string | null,
  createAt: number,
  attempt = 1,
): InboundMessage {
  const opponent = view.players.find((p) => p.id);
  return {
    accountId,
    channelId: view.channel_id,
    postId: `widget-${view.widget_id}-r${String(view.rev)}-a${String(attempt)}`,
    senderId: opponent?.id ?? view.started_by ?? `widget:${view.widget_id}`,
    text: wakeBody(view),
    createAt,
    channelType,
    widget: { id: view.widget_id, rev: view.rev, kind: view.kind, seat: view.seat ?? "" },
  };
}

export class WidgetWakes {
  readonly #deps: WidgetWakeDeps;
  readonly #games = new Map<string, GameState>();
  readonly #ended = new Set<string>();
  #disposed = false;

  constructor(deps: WidgetWakeDeps) {
    this.#deps = deps;
  }

  /** Whether the agent holds a seat in this game, as far as any signal told. */
  seated(widgetId: string): boolean {
    return this.#games.has(widgetId) || this.#ended.has(widgetId);
  }

  offer(signal: WidgetSignal, source: WidgetSignalSource): void {
    if (this.#disposed || this.#ended.has(signal.widgetId)) return;
    if (signal.status !== "active") {
      this.#end(signal.widgetId, signal.channelId);
      return;
    }
    const game = this.#game(signal.widgetId, signal.channelId);
    if (signal.rev < game.latestRev) return;
    game.latestRev = signal.rev;
    if (!signal.waiting) {
      // The opponent's move now: whatever was pending is moot.
      game.pending = undefined;
      this.#cancelRetry(game);
      return;
    }
    if (this.#deps.snoozed()) {
      this.#debug(`skip ${signal.widgetId} rev ${String(signal.rev)} (${source}): agent snoozed`);
      return;
    }
    if (!this.#due(game, signal.rev)) return;
    game.pending = signal;
    if (game.queued) return;
    game.queued = true;
    this.#deps.enqueue(
      `widget-${signal.widgetId}`,
      () => this.#run(signal.widgetId),
      () => {
        game.queued = false;
        game.pending = undefined;
      },
    );
  }

  /** Stop retries; later signals are ignored. */
  dispose(): void {
    this.#disposed = true;
    for (const game of this.#games.values()) this.#cancelRetry(game);
  }

  #game(widgetId: string, channelId: string): GameState {
    let game = this.#games.get(widgetId);
    if (!game) {
      game = { channelId, latestRev: -1, queued: false };
      this.#games.set(widgetId, game);
    }
    return game;
  }

  /** Whether `rev` may be woken now: a new rev always, the last one only on its backoff. */
  #due(game: GameState, rev: number): boolean {
    const woken = game.woken;
    if (!woken || woken.rev !== rev) return true;
    const wait = WAKE_RETRY_BACKOFF_MS[woken.attempts - 1];
    return wait !== undefined && this.#deps.now() >= woken.at + wait;
  }

  async #run(widgetId: string): Promise<void> {
    const game = this.#games.get(widgetId);
    if (!game) return;
    game.queued = false;
    const signal = game.pending;
    game.pending = undefined;
    if (!signal || this.#disposed || this.#deps.snoozed()) return;

    let view: AgentWidgetView;
    try {
      view = await this.#deps.read(widgetId);
    } catch (err) {
      if (err instanceof ClawBitsError && err.statusCode === 404) {
        // Gone, or out of the agent's reach: nothing left to play.
        this.#end(widgetId, game.channelId);
        return;
      }
      logWarn(
        this.#deps.log,
        `[clawbits/${this.#deps.accountId}] game ${widgetId} not read for its wake: ${String((err as Error)?.message ?? err)}`,
      );
      return;
    }
    if (view.status !== "active") {
      this.#end(widgetId, view.channel_id);
      return;
    }
    game.latestRev = Math.max(game.latestRev, view.rev);
    if (!view.your_move || !view.seat) {
      this.#debug(`skip ${widgetId} rev ${String(view.rev)}: not this agent's move`);
      return;
    }
    if (!this.#due(game, view.rev)) return;
    const now = this.#deps.now();
    const refused = view.players.find((p) => p.id && !this.#deps.allowed(p.id));
    if (refused?.id) {
      // Settled for this rev: no retries until the game moves.
      game.woken = { rev: view.rev, at: now, attempts: WAKE_RETRY_BACKOFF_MS.length + 1 };
      logWarn(
        this.#deps.log,
        `[clawbits/${this.#deps.accountId}] game ${widgetId} not played: allowFrom blocks ${refused.id}`,
      );
      return;
    }

    // Claimed before the turn and never due while it runs, so the signals its own moves raise
    // can't wake it twice; the backoff counts from its end.
    const attempts = game.woken?.rev === view.rev ? game.woken.attempts + 1 : 1;
    const woken = { rev: view.rev, at: Number.POSITIVE_INFINITY, attempts };
    game.woken = woken;
    this.#cancelRetry(game);
    logInfo(
      this.#deps.log,
      `[clawbits/${this.#deps.accountId}] game ${widgetId} wakes ${view.seat} at rev ${String(view.rev)} (attempt ${String(attempts)})`,
    );
    try {
      await this.#deps.dispatch(
        wakeMessage(
          this.#deps.accountId,
          view,
          this.#deps.channelType(view.channel_id),
          now,
          attempts,
        ),
      );
    } finally {
      woken.at = this.#deps.now();
      this.#scheduleRetry(widgetId, game, view);
    }
  }

  #cancelRetry(game: GameState): void {
    game.cancelRetry?.();
    game.cancelRetry = undefined;
  }

  /** Look again once the backoff passes: the read at dispatch drops it if the move was made. */
  #scheduleRetry(widgetId: string, game: GameState, view: AgentWidgetView): void {
    const woken = game.woken;
    const wait = woken && WAKE_RETRY_BACKOFF_MS[woken.attempts - 1];
    if (!woken || wait === undefined || this.#disposed || this.#games.get(widgetId) !== game) return;
    const cancel = (this.#deps.setTimer ?? defaultTimer)(() => {
      if (game.cancelRetry !== cancel) return;
      game.cancelRetry = undefined;
      this.offer(
        {
          widgetId,
          channelId: view.channel_id,
          rev: woken.rev,
          kind: view.kind,
          seat: view.seat,
          waiting: true,
          status: "active",
        },
        "retry",
      );
    }, wait);
    game.cancelRetry = cancel;
  }

  #end(widgetId: string, channelId: string): void {
    const game = this.#games.get(widgetId);
    if (game) this.#cancelRetry(game);
    this.#games.delete(widgetId);
    if (this.#ended.size >= ENDED_MEMORY) {
      const oldest = this.#ended.values().next();
      if (!oldest.done) this.#ended.delete(oldest.value);
    }
    this.#ended.add(widgetId);
    this.#cleanup(widgetId, game?.channelId ?? channelId, 0);
  }

  /** Drop an ended game's session on the queue; while a run on it still goes, again on a backoff. */
  #cleanup(widgetId: string, channelId: string, attempt: number): void {
    const ended = this.#deps.ended;
    if (!ended || (attempt > 0 && this.#disposed)) return;
    const cleanup = async (): Promise<void> => {
      let outcome: GameSessionDeletion | void;
      try {
        outcome = await ended({ widgetId, channelId });
      } catch (err) {
        logWarn(
          this.#deps.log,
          `[clawbits/${this.#deps.accountId}] game ${widgetId} cleanup failed: ${String((err as Error)?.message ?? err)}`,
        );
        return;
      }
      const wait = CLEANUP_RETRY_MS[attempt];
      if (outcome !== "busy" || wait === undefined || this.#disposed) return;
      this.#debug(`cleanup of ${widgetId} waits for a run on its session`);
      (this.#deps.setTimer ?? defaultTimer)(() => this.#cleanup(widgetId, channelId, attempt + 1), wait);
    };
    this.#deps.enqueue(`widget-${widgetId}-end`, cleanup, () => void cleanup());
  }

  #debug(message: string): void {
    logDebug(this.#deps.log, `[clawbits/${this.#deps.accountId}] game wake ${message}`);
  }
}
