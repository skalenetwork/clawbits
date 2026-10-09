import type { QueryClient } from "@tanstack/react-query";
import type { Channel, Organization } from "./models";

/** Chat widgets: games the server runs inside a chat. Each change arrives as a declarative scene (boards, cards,
 *  what the viewer may pick, which buttons it has); nothing here knows a rule, so a new kind needs no release. */

export type WidgetStatus = "active" | "finished" | "aborted";
export type WidgetKindName = "chess" | "battleship" | "poker" | "blackjack";

export const WIDGET_KINDS: { kind: WidgetKindName; label: string }[] = [
  { kind: "chess", label: "Chess" },
  { kind: "battleship", label: "Battleship" },
  { kind: "poker", label: "Poker" },
  { kind: "blackjack", label: "Blackjack" },
];

export interface WidgetSeat {
  seat: string;
  human_id: number | null;
  agent_id: string | null;
  display_name: string | null;
}

export interface WidgetSceneInput {
  /** The action a pick or a tap commits: `{from, to, choice?}` for a pick, `{at}` for a tap. */
  action: string;
  /** The board it applies to; a one-board scene needs none. */
  board?: string;
  pick?: Record<string, string[]>;
  choose?: Record<string, { value: string; sprite: string }[]>;
  tap?: string[];
}

/** A number the viewer picks before acting, sent as `args[arg]`. */
export interface WidgetSceneAmount {
  arg: string;
  min: number;
  max: number;
  step: number;
  value: number;
  presets?: { label: string; value: number }[];
}

export interface WidgetSceneAction {
  type: string;
  label: string;
  confirm?: string;
  tone?: "primary" | "danger";
  /** A state to show, not an action to take (e.g. a draw already offered). */
  disabled?: boolean;
  args?: Record<string, unknown>;
  amount?: WidgetSceneAmount;
}

export interface WidgetSceneToken {
  id: string;
  sprite: string;
  at: string;
  /** Cells covered across and down from `at`, its lowest column and row. */
  span?: [number, number];
}

export interface WidgetSceneMark {
  at: string;
  tone: string;
}

export interface WidgetBoardLayout {
  cols: string[];
  rows: string[];
  pattern?: "checker" | "plain";
  style?: "board" | "notebook";
  origin?: "bottom" | "top";
  show_labels?: boolean;
}

export interface WidgetBoard extends WidgetBoardLayout {
  id: string;
  title?: string;
  /** The board's name for screen readers, where no title shows. */
  label?: string;
  /** The seat whose board it is (a fleet): that player shows beneath it. */
  seat?: string;
  tokens?: WidgetSceneToken[];
  marks?: WidgetSceneMark[];
}

/** A row of cards on a table: rank then suit (`As`, `Td`), `back` face down, null for a place still empty. */
export interface WidgetCardRow {
  id: string;
  seat?: string;
  label?: string;
  cards: (string | null)[];
  note?: string;
  lift?: number[];
  active?: boolean;
}

export interface WidgetScene {
  v: number;
  title?: string;
  board?: WidgetBoardLayout;
  tokens?: WidgetSceneToken[];
  marks?: WidgetSceneMark[];
  boards?: WidgetBoard[];
  table?: { rows: WidgetCardRow[] };
  /** A line per seat shown in place of the seat's name, e.g. its chips. */
  seat_notes?: Record<string, string>;
  turn?: string | null;
  flip_for?: string | null;
  input?: Record<string, WidgetSceneInput>;
  actions?: Record<string, WidgetSceneAction[]>;
  status?: { text: string; tone: string };
  log?: string[];
}

export interface Widget {
  widget_id: string;
  channel_id: string;
  kind: string;
  status: WidgetStatus;
  rev: number;
  turn: string | null;
  seats: WidgetSeat[];
  scene: WidgetScene;
  /** The scene is the viewer's own; a live event carries only the public one. */
  private?: boolean;
  /** The message that started it, which shows the game in the chat. */
  post_id?: number | null;
  outcome: Record<string, unknown> | null;
  created_by_human_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface WidgetAction {
  type: string;
  args?: Record<string, unknown>;
}

export const widgetKey = (id: string) => ["widget", id] as const;
export const activeWidgetsKey = (channel: string) => ["widgets", channel] as const;

/** Folds a fresh widget into its caches; an older rev never overwrites a newer one. The widget's own entry keeps
 *  its newest rev, so a late event for a game that has since ended can't put it back in the chat's active list
 *  (where it no longer is to compare with). */
export function applyWidget(client: QueryClient, widget: Widget): void {
  const known = client.getQueryData<Widget>(widgetKey(widget.widget_id));
  if (known && known.rev > widget.rev) return;
  client.setQueryData<Widget>(widgetKey(widget.widget_id), widget);
  client.setQueryData<Widget[]>(activeWidgetsKey(widget.channel_id), (old) => {
    const known = old?.find((item) => item.widget_id === widget.widget_id);
    if (known && known.rev > widget.rev) return old;
    const rest = (old ?? []).filter((item) => item.widget_id !== widget.widget_id);
    return widget.status === "active" ? [widget, ...rest] : old && rest;
  });
}

/** A widget a request answered with, unless the cache already holds a newer rev of it: a live event that beat a slow
 *  answer stays. */
export function freshWidget(client: QueryClient, fetched: Widget): Widget {
  const known = client.getQueryData<Widget>(widgetKey(fetched.widget_id));
  return known && known.rev > fetched.rev ? known : fetched;
}

/** A chat's active widgets as a request listed them, set against each widget's own cache: a newer rev there stands in
 *  for the listed one, and a widget that has ended since stays off the list, so a slow answer can't bring a finished
 *  game back (and with it block a new one). Each listed widget at least as new as its cache seeds it. */
export function freshActiveWidgets(client: QueryClient, listed: Widget[]): Widget[] {
  return listed.flatMap((fetched) => {
    const widget = freshWidget(client, fetched);
    if (widget === fetched) client.setQueryData<Widget>(widgetKey(fetched.widget_id), fetched);
    return widget.status === "active" ? [widget] : [];
  });
}

/** A live `widget.updated`. A private widget's event carries only the public scene, so the viewer's own view is
 *  fetched instead, unless this rev is already here (the viewer's own action answered with it). */
export function applyWidgetEvent(client: QueryClient, widget: Widget): void {
  if (!widget.private) {
    applyWidget(client, widget);
    return;
  }
  const known = client.getQueryData<Widget>(widgetKey(widget.widget_id));
  if (known && known.rev >= widget.rev) return;
  void client.invalidateQueries({ queryKey: widgetKey(widget.widget_id) });
  if (widget.status !== "active")
    client.setQueryData<Widget[]>(activeWidgetsKey(widget.channel_id), (old) =>
      old?.filter((item) => item.widget_id !== widget.widget_id),
    );
  else if (!client.getQueryData<Widget[]>(activeWidgetsKey(widget.channel_id))?.length)
    void client.invalidateQueries({ queryKey: activeWidgetsKey(widget.channel_id) });
}

/** How a widget ended for its viewer, the same few ways for every kind: won, lost, a draw, ended early (aborted), or
 *  just finished, for a spectator or an outcome that names no winner. Null while it runs. */
export type WidgetEnd = "won" | "lost" | "draw" | "ended" | "finished";

export function endOf(widget: Widget, seat: string | null): WidgetEnd | null {
  if (widget.status === "active") return null;
  if (widget.status === "aborted") return "ended";
  const winner = widget.outcome?.winner;
  if (winner === null) return "draw";
  if (typeof winner !== "string" || seat == null) return "finished";
  return winner === seat ? "won" : "lost";
}

const HEADLINE: Record<WidgetEnd, string> = {
  won: "You won",
  lost: "You lost",
  draw: "Draw",
  ended: "Ended",
  finished: "Finished",
};

/** How a widget ended, as its result heads it: from the viewer's side, the winner named for a spectator. Null while
 *  it runs; the reason is the scene's status. */
export function resultOf(widget: Widget, seat: string | null): { end: WidgetEnd; headline: string } | null {
  const end = endOf(widget, seat);
  if (!end) return null;
  const winner =
    end === "finished" ? widget.seats.find((item) => item.seat === widget.outcome?.winner)?.display_name : null;
  return { end, headline: winner ? `${winner} won` : HEADLINE[end] };
}

/** Whether a scene draws chess pieces, so the piece-set switch belongs beside it. */
export function drawsChessPieces(scene: WidgetScene): boolean {
  return [scene.tokens ?? [], ...(scene.boards ?? []).map((board) => board.tokens ?? [])]
    .flat()
    .some((token) => token.sprite.startsWith("chess."));
}

/** The game's notes, behind their button. A card game keeps none: its table tells the hand. */
export function notesOf(scene: WidgetScene): string[] {
  return scene.table ? [] : (scene.log ?? []);
}

/** Whether every board is a seat's own (a fleet each), so each player sits beneath their board. */
export function boardsBySeat(scene: WidgetScene): boolean {
  const boards = scene.boards ?? [];
  return boards.length > 1 && boards.every((board) => board.seat != null);
}

/** Where among the chat's loaded messages the one that started `widget` is, or -1 while it isn't loaded. */
export function widgetPostIndex(posts: { post_id: number; widget_id?: string | null }[], widget: Widget): number {
  return posts.findIndex((post) =>
    widget.post_id != null ? post.post_id === widget.post_id : post.widget_id === widget.widget_id,
  );
}

/** The viewer's seat, or null for a spectator. */
export function seatOf(widget: Widget, userId: number | null): string | null {
  return widget.seats.find((seat) => seat.human_id != null && seat.human_id === userId)?.seat ?? null;
}

/** Widgets run in one-to-one chats between people. */
export function isWidgetChat(channel: Channel | undefined): boolean {
  return channel?.channel_type === "direct" && channel.dm_peer_human_id != null;
}

/** A game can start here: a chat between two people, in an org that allows them. The chat's own switch is asked
 *  for on the way. */
export function canPlay(channel: Channel | undefined, org: Organization | undefined): boolean {
  return isWidgetChat(channel) && Boolean(org?.widgets_enabled);
}

/** Actions may share a type (bets of two sizes), so each is told apart by its args too. */
export const actionKey = (action: WidgetSceneAction): string =>
  `${action.type}:${JSON.stringify(action.args ?? {})}`;

/** The nearest step from `min`, within bounds; the bounds themselves are always reachable. */
export function snapAmount(amount: WidgetSceneAmount, value: number): number {
  if (value >= amount.max) return amount.max;
  if (value <= amount.min) return amount.min;
  return Math.min(amount.max, amount.min + Math.round((value - amount.min) / amount.step) * amount.step);
}

/** Every board of a scene, a one-board scene's tokens and marks folded into its board. */
export function normalizeBoards(scene: WidgetScene): WidgetBoard[] {
  if (scene.boards) return scene.boards;
  return scene.board ? [{ id: "main", ...scene.board, tokens: scene.tokens, marks: scene.marks }] : [];
}

export interface BoardCell {
  name: string;
  /** Column and row in the board's own terms. */
  x: number;
  y: number;
  /** Where it shows: column and row from the top left. */
  dx: number;
  dy: number;
  dark: boolean;
}

/** Where cell (x, y) shows: a board turns for the seat it flips for, and counts its rows up from the bottom unless
 *  its origin is the top. */
export function displayOf(board: WidgetBoardLayout, flip: boolean, x: number, y: number): { dx: number; dy: number } {
  const width = board.cols.length;
  const height = board.rows.length;
  const fromTop = board.origin === "top";
  return {
    dx: flip ? width - 1 - x : x,
    dy: fromTop ? (flip ? height - 1 - y : y) : flip ? y : height - 1 - y,
  };
}

/** The board's cells in display order, row by row from the top left. */
export function boardCells(board: WidgetBoardLayout, flip: boolean): BoardCell[] {
  const cells: BoardCell[] = [];
  for (let y = 0; y < board.rows.length; y++)
    for (let x = 0; x < board.cols.length; x++) {
      const { dx, dy } = displayOf(board, flip, x, y);
      cells.push({
        name: `${board.cols[x] ?? ""}${board.rows[y] ?? ""}`,
        x,
        y,
        dx,
        dy,
        dark: board.pattern === "checker" && (x + y) % 2 === 0,
      });
    }
  return cells.sort((a, b) => a.dy - b.dy || a.dx - b.dx);
}

// Past five cards a row fans out, each card over the last, keeping to the width of five.
export const FAN_FROM = 5;
/** Five cards and their four gaps (a tenth of a card each) span 5.4 card widths. */
export const TABLE_SPAN = 5.4;

/** The margin before each card after the first, as a share of a card's width (below zero: it lies over the one
 *  before), so `count` cards span what five do; none when the row fits. */
export function fanMargin(count: number): number | null {
  return count > FAN_FROM ? (TABLE_SPAN - 1) / (count - 1) - 1 : null;
}

const RANK_NAMES: Record<string, string> = {
  A: "ace", K: "king", Q: "queen", J: "jack", T: "ten", "9": "nine", "8": "eight",
  "7": "seven", "6": "six", "5": "five", "4": "four", "3": "three", "2": "two",
};
const SUIT_NAMES: Record<string, string> = { c: "clubs", d: "diamonds", h: "hearts", s: "spades" };

export type Suit = "c" | "d" | "h" | "s";

export function parseCard(code: string): { rank: string; suit: Suit } | null {
  const [, rank, suit] = /^([2-9TJQKA])([cdhs])$/.exec(code) ?? [];
  return rank && suit ? { rank: rank === "T" ? "10" : rank, suit: suit as Suit } : null;
}

/** What a screen reader says for a card, e.g. "ten of diamonds". */
export function cardLabel(code: string | null): string {
  if (code == null) return "empty place";
  const [, rank, suit] = /^([2-9TJQKA])([cdhs])$/.exec(code) ?? [];
  return rank && suit ? `${RANK_NAMES[rank]} of ${SUIT_NAMES[suit]}` : "face-down card";
}

const PIECE_NAMES: Record<string, string> = {
  P: "pawn", N: "knight", B: "bishop", R: "rook", Q: "queen", K: "king",
};

export function parseChessSprite(name: string): { color: "w" | "b"; piece: string } | null {
  const [, color, piece] = /^chess\.([wb])([PNBRQK])$/.exec(name) ?? [];
  return piece && (color === "w" || color === "b") ? { color, piece } : null;
}

/** What a screen reader says for a sprite, e.g. "white knight". */
export function spriteLabel(name: string): string {
  if (name === "notebook.ship") return "ship";
  if (name === "notebook.sunk") return "sunk ship";
  const chess = parseChessSprite(name);
  return chess ? `${chess.color === "w" ? "white" : "black"} ${PIECE_NAMES[chess.piece] ?? "piece"}` : "piece";
}

/** The log's last lines as one paragraph, an ellipsis marking what came before. */
export function logLine(log: string[] | undefined, tail = 10): string {
  if (!log?.length) return "";
  return `${log.length > tail ? "… " : ""}${log.slice(-tail).join(" ")}`;
}
