import { useState, type ButtonHTMLAttributes } from "react";
import { Minus, Plus, ScrollText, Undo2 } from "lucide-react";
import { useWidgetAction } from "@/hooks/useWidget";
import type { Widget, WidgetSceneAction, WidgetSceneAmount, WidgetSeat } from "@/lib/api";
import { cn } from "@/lib/utils";
import { boardsBySeat, drawsChessPieces, notesOf, resultOf, seatOf, type WidgetEnd } from "@/lib/widgets";
import { ActionFace, EndGlyph } from "./ActionGlyph";
import { PieceSetSwitch } from "./PieceSetSwitch";
import { SceneView } from "./SceneView";
import "./widgets.css";

const STATUS_TONE: Record<string, string> = {
  neutral: "text-(--w-on-surface)",
  info: "font-semibold text-(--w-on-surface)",
  danger: "font-semibold text-(--w-danger)",
  muted: "text-(--w-on-surface-variant)",
};
// Narrow, everything stacks: opponent, board, the middle, you. Once the card is 32rem wide and holds one board, the
// board takes the left and everything about it the right: the opponent at the top, you at the bottom, as on the
// board, and the middle between you. No title row: the dock's glyph names the game, and the section's label does
// for a screen reader.
// The grid is a child of the card: an element's @lg: queries its ancestors' size, never its own.
const STACK = "grid [grid-template-areas:'top'_'board'_'meta'_'bottom']";
const SPLIT = cn(
  STACK,
  "@lg:grid-cols-[minmax(0,1fr)_12rem] @lg:grid-rows-[auto_1fr_auto] @lg:gap-x-3",
  "@lg:[grid-template-areas:'board_top'_'board_meta'_'board_bottom']",
);
// Actions may share a type (bets of two sizes), so each is told apart by its args too.
const actionKey = (a: WidgetSceneAction) => `${a.type}:${JSON.stringify(a.args ?? {})}`;
// A state layer over the capsule's own tone, so hover reads the same on every surface.
const HOVER = "hover:bg-[image:linear-gradient(var(--w-state-hover),var(--w-state-hover))]";

const CAPSULE_TONE = {
  tonal: cn("bg-(--w-surface-container-high) text-(--w-on-surface)", HOVER),
  // The accent is kept for the key moment, such as answering a draw offer.
  primary: cn("bg-(--w-primary) text-(--w-on-primary)", HOVER),
  danger: cn("bg-(--w-danger-container) text-(--w-on-danger-container)", HOVER),
  ghost: cn("text-(--w-on-surface-variant)", HOVER),
};

/** An action as an icon: round with its glyph alone, a pill when a number rides along. Its label is its name and
 *  its tooltip, so nothing is said by the icon alone. */
function ActionButton({ glyph, label, tone = "tonal", bare, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  /** The action's type, which picks its glyph. */
  glyph: string;
  label: string;
  tone?: keyof typeof CAPSULE_TONE;
  /** The glyph without its number, where the number shows beside it already. */
  bare?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...props}
      className={cn(
        "wgt-capsule inline-flex h-10 min-w-10 shrink-0 items-center justify-center gap-1.5 px-2.5 outline-none",
        "focus-visible:shadow-[0_0_0_2px_var(--w-surface),0_0_0_4px_var(--w-primary)] disabled:opacity-50",
        CAPSULE_TONE[tone],
        className,
      )}
    >
      <ActionFace type={glyph} label={label} bare={bare} />
    </button>
  );
}

/** How the game ended, one line between the players: a cup and `You won` (or the winner, for a spectator), a broken
 *  heart and `You lost`, a draw, an early end (the same few glyphs for every kind). The reason is its tooltip; a screen
 *  reader hears it too. */
function Result({ end, headline, reason }: { end: WidgetEnd; headline: string; reason?: string }) {
  const won = end === "won" || end === "finished";
  return (
    <p
      role="status"
      title={reason}
      className={cn(
        "inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[0.9375rem] leading-none font-semibold",
        won ? "bg-(--w-primary-container) text-(--w-on-primary-container)" : "bg-(--w-surface-container-high) text-(--w-on-surface-variant)",
      )}
    >
      <EndGlyph end={end} aria-hidden className={cn("size-[1.125rem] shrink-0", won && "text-(--w-primary)")} />
      {headline}
      {reason && <span className="sr-only">, {reason}</span>}
    </p>
  );
}

function StepButton({ label, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      {...props}
      className="grid size-8 shrink-0 place-items-center rounded-full text-(--w-on-surface-variant) outline-none hover:bg-(--w-state-hover) focus-visible:shadow-[0_0_0_2px_var(--w-primary)] disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/** An action that takes a number first, such as a raise or a bet: quick picks, the number between a step either
 *  side and the button that sends it as `args[amount.arg]`, and a slider beneath. Every part may shrink, so it
 *  keeps within the narrowest column. */
function AmountAction({ action, amount, busy, onRun }: {
  action: WidgetSceneAction;
  amount: WidgetSceneAmount;
  busy: boolean;
  onRun: (args: Record<string, unknown>) => void;
}) {
  const clamp = (v: number) => Math.min(amount.max, Math.max(amount.min, v));
  const [value, setValue] = useState(() => clamp(amount.value));
  return (
    <div
      role="group"
      aria-label={action.label}
      className="grid w-full min-w-0 basis-full grid-cols-[minmax(0,1fr)] gap-1.5"
    >
      {amount.presets && amount.presets.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {amount.presets.map((p) => (
            <button
              key={p.label}
              type="button"
              aria-pressed={value === clamp(p.value)}
              onClick={() => { setValue(clamp(p.value)); }}
              className="wgt-capsule px-2.5 py-1 text-[0.75rem] leading-none font-medium text-(--w-on-surface-variant) outline-none hover:bg-(--w-state-hover) focus-visible:shadow-[0_0_0_2px_var(--w-primary)] aria-pressed:bg-(--w-primary-container) aria-pressed:text-(--w-on-primary-container)"
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
      <div className="flex min-w-0 items-center gap-1">
        <StepButton label={`Less, by ${String(amount.step)}`} disabled={value <= amount.min} onClick={() => { setValue(clamp(value - amount.step)); }}>
          <Minus aria-hidden className="size-4" />
        </StepButton>
        <output aria-live="polite" className="min-w-0 flex-1 truncate text-center text-base leading-none font-semibold tabular-nums">
          {value}
        </output>
        <StepButton label={`More, by ${String(amount.step)}`} disabled={value >= amount.max} onClick={() => { setValue(clamp(value + amount.step)); }}>
          <Plus aria-hidden className="size-4" />
        </StepButton>
        <ActionButton
          glyph={action.type}
          label={`${action.label} ${String(value)}`}
          tone={action.tone ?? "tonal"}
          bare
          disabled={busy}
          onClick={() => { onRun({ ...action.args, [amount.arg]: value }); }}
        />
      </div>
      <input
        type="range"
        min={amount.min}
        max={amount.max}
        step={amount.step}
        value={value}
        aria-label={`${action.label}, amount`}
        onChange={(e) => { setValue(clamp(Number(e.target.value))); }}
        className="w-full min-w-0 accent-(--w-primary)"
      />
    </div>
  );
}

// Each player wears their seat's tone, ivory or ebony as the chess sides, which no action wears, so a person never
// reads as a button.
const SEAT_TONE = [
  "border border-(--w-seat-1-edge) bg-(--w-seat-1) text-(--w-on-seat-1)",
  "border border-(--w-seat-2-edge) bg-(--w-seat-2) text-(--w-on-seat-2)",
];

/** A seat's initial in a circle of its own tone, ringed while the seat is to move. Given a label, it stands for the
 *  seat alone. */
function SeatAvatar({ name, seat, toAct, label, className }: {
  name: string;
  /** The seat's place in the widget's order, which picks its tone. */
  seat: number;
  toAct: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      title={label}
      className={cn(
        "grid shrink-0 place-items-center rounded-full font-semibold transition-shadow motion-reduce:transition-none",
        SEAT_TONE[Math.max(0, seat) % SEAT_TONE.length],
        toAct && "shadow-[0_0_0_2px_var(--w-surface),0_0_0_4px_var(--w-primary)]",
        className,
      )}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

/** A seat at its end of the row beneath the boards: its avatar and, facing the middle, its name. The avatar carries
 *  the name for a screen reader, so the words on show aren't read twice. */
function SeatBadge({ seat, widget, userId, mirrored = false }: {
  seat: WidgetSeat;
  widget: Widget;
  userId: number | null;
  /** At the right end: the name on the avatar's left. */
  mirrored?: boolean;
}) {
  const name = seat.display_name ?? "Player";
  const you = seat.human_id != null && seat.human_id === userId;
  const toAct = widget.status === "active" && widget.turn === seat.seat;
  return (
    <div className={cn("flex min-w-0 items-center gap-2", mirrored ? "flex-row-reverse justify-self-end" : "justify-self-start")}>
      <SeatAvatar
        name={name}
        seat={widget.seats.findIndex((s) => s.seat === seat.seat)}
        toAct={toAct}
        label={`${name}${you ? " (you)" : ""}${toAct ? ", to move" : ""}`}
        className="size-10 text-[0.875rem]"
      />
      <span aria-hidden className="min-w-0 truncate text-[0.875rem] leading-snug font-medium">
        {name}
        {you && <span className="font-normal text-(--w-on-surface-variant)"> (you)</span>}
      </span>
    </div>
  );
}

function SeatLine({ seat, widget, userId, className }: {
  seat: WidgetSeat | undefined;
  widget: Widget;
  userId: number | null;
  className?: string;
}) {
  if (!seat) return null;
  const name = seat.display_name ?? "Player";
  const toAct = widget.status === "active" && widget.turn === seat.seat;
  const note = widget.scene.seat_notes?.[seat.seat];
  return (
    <div className={cn("flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 px-1.5 py-1", className)}>
      {/* The seat to move is ringed; the status line says it in words. */}
      <SeatAvatar
        name={name}
        seat={widget.seats.findIndex((s) => s.seat === seat.seat)}
        toAct={toAct}
        className="size-7 text-[0.75rem]"
      />
      <span className="min-w-0 text-[0.875rem] leading-snug font-medium break-words">
        {name}
        {seat.human_id != null && seat.human_id === userId && (
          <span className="font-normal text-(--w-on-surface-variant)"> (you)</span>
        )}
        {toAct && <span className="sr-only">, to move</span>}
      </span>
      {/* A kind may say more about a seat than its name, e.g. its chips; that line takes the name's place. */}
      <span className={cn("text-[0.75rem] leading-snug text-(--w-on-surface-variant) tabular-nums", !note && "capitalize")}>
        {note ?? seat.seat}
      </span>
    </div>
  );
}

/** A widget with its players, status, recent log and the viewer's actions around the board. In a message it sits
 *  on tone like any content (`card`); docked above the composer it floats, so it takes the glass (`sheet`). Its
 *  own chunk: the board loads only where a widget shows. */
export default function WidgetPanel({ widget, userId, compact, variant = "card", className }: {
  widget: Widget;
  userId: number | null;
  /** Docked above the composer: a smaller board. */
  compact?: boolean;
  variant?: "card" | "sheet";
  className?: string;
}) {
  const act = useWidgetAction();
  const [confirming, setConfirming] = useState<string | null>(null);
  // The game's notes (its moves, its hands) wait behind a button.
  const [notes, setNotes] = useState(false);
  const { scene } = widget;
  const mySeat = seatOf(widget, userId);
  // The viewer's seat sits at the bottom, as it does on a board turned towards them.
  const bottom = widget.seats.find((s) => s.seat === mySeat) ?? widget.seats[0];
  const top = widget.seats.find((s) => s !== bottom);
  const single = (scene.boards?.length ?? 1) === 1;
  const width = single ? (compact ? "max-w-[34rem]" : "max-w-[42rem]") : compact ? "max-w-[36rem]" : "max-w-[40rem]";
  const actions = (mySeat && scene.actions?.[mySeat]) || [];
  const log = notesOf(scene);
  const pending = actions.find((a) => actionKey(a) === confirming);
  const title = scene.title ?? widget.kind;
  const result = resultOf(widget, mySeat);
  const chessPieces = drawsChessPieces(scene);
  const bySeat = boardsBySeat(scene);

  const run = (a: WidgetSceneAction) => {
    setConfirming(null);
    act.mutate({ widget, action: a.args ? { type: a.type, args: a.args } : { type: a.type } });
  };

  const view = (
    <SceneView scene={scene} seat={mySeat} busy={act.isPending} onAct={(action) => { act.mutate({ widget, action }); }} />
  );
  // The game's notes, all of them, the latest in view: while open they take the middle.
  const history = notes && log.length > 0 ? (
    <div id={`${widget.widget_id}-notes`} className="flex max-h-56 min-h-0 w-full flex-col-reverse overflow-y-auto">
      <p className="text-[0.875rem] leading-normal text-pretty text-(--w-on-surface-variant) tabular-nums">{log.join(" ")}</p>
    </div>
  ) : null;
  // What the viewer may do, grouped while there is anything: an action that asks first asks in its place.
  const moves = actions.length > 0 ? (
    <div
      role="group"
      aria-label="Your moves"
      className={cn(
        "flex flex-wrap items-center justify-center gap-2 rounded-[1.5rem] bg-(--w-surface-container) p-1.5",
        // As wide as its buttons; an amount's slider takes the whole width there is.
        actions.some((a) => a.amount) ? "w-full" : "w-fit max-w-full",
      )}
    >
      {pending ? (
        <>
          <span className="basis-full text-center text-base leading-normal text-pretty">{pending.confirm}</span>
          <button
            type="button"
            aria-label="Cancel"
            title="Cancel"
            onClick={() => { setConfirming(null); }}
            className={cn(
              "wgt-capsule grid size-10 place-items-center outline-none focus-visible:shadow-[0_0_0_2px_var(--w-surface),0_0_0_4px_var(--w-primary)]",
              CAPSULE_TONE.ghost,
            )}
          >
            <Undo2 aria-hidden className="size-[1.125rem]" />
          </button>
          <ActionButton glyph={pending.type} label={pending.label} tone="danger" disabled={act.isPending} onClick={() => { run(pending); }} />
        </>
      ) : (
        actions.map((a) => a.amount ? (
          // Keyed by rev too, so each new scene starts the pick from the server's suggestion.
          <AmountAction
            key={`${actionKey(a)}:${String(widget.rev)}`}
            action={a}
            amount={a.amount}
            busy={act.isPending}
            onRun={(args) => { act.mutate({ widget, action: { type: a.type, args } }); }}
          />
        ) : a.disabled ? (
          // A state, not a control: no button that can't be pressed.
          <span
            key={actionKey(a)}
            role="img"
            aria-label={a.label}
            title={a.label}
            className="wgt-capsule inline-flex h-10 min-w-10 items-center justify-center gap-1.5 px-2.5 text-(--w-on-surface-variant) shadow-[inset_0_0_0_1px_var(--w-outline-variant)]"
          >
            <ActionFace type={a.type} label={a.label} />
          </span>
        ) : (
          <ActionButton
            key={actionKey(a)}
            glyph={a.type}
            label={a.label}
            tone={a.tone ?? "tonal"}
            disabled={act.isPending}
            onClick={() => { if (a.confirm) setConfirming(actionKey(a)); else run(a); }}
          />
        ))
      )}
    </div>
  ) : null;
  const ending = result ? <Result end={result.end} headline={result.headline} reason={scene.status?.text} /> : null;
  // The notes' switch and the piece set: kept apart from the moves, and in reach while the notes are open.
  const tools = (log.length > 0 || chessPieces) && (
    <div className="flex items-center gap-2">
      {log.length > 0 && (
        <button
          type="button"
          aria-label="Game notes"
          aria-expanded={notes}
          aria-controls={`${widget.widget_id}-notes`}
          title={notes ? "Hide game notes" : "Show game notes"}
          onClick={() => { setNotes(!notes); }}
          className={cn(
            "wgt-capsule grid size-10 place-items-center outline-none focus-visible:shadow-[0_0_0_2px_var(--w-surface),0_0_0_4px_var(--w-primary)]",
            notes ? CAPSULE_TONE.tonal : CAPSULE_TONE.ghost,
          )}
        >
          <ScrollText aria-hidden className="size-[1.125rem]" />
        </button>
      )}
      {chessPieces && <PieceSetSwitch />}
    </div>
  );

  return (
    <section
      aria-label={title}
      className={cn(
        "wgt @container w-full",
        variant === "sheet" ? "wgt-glass wgt-sheet" : "wgt-card",
        width,
        className,
      )}
    >
      {bySeat ? (
        // A board each (a fleet each), then one row: the viewer at the left, the other player at the right, and the
        // middle between them. The ringed avatar and the marks say what the status does, so it speaks to a screen
        // reader only.
        <div className="flex flex-col gap-2">
          {!result && scene.status && <p role="status" className="sr-only">{scene.status.text}</p>}
          {view}
          {/* The sides share what the middle leaves, so a long name gives way, never the moves. */}
          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-0.5">
            {bottom && <SeatBadge seat={bottom} widget={widget} userId={userId} />}
            <div className="flex min-w-0 flex-wrap items-center justify-center gap-2">
              {history ?? ending ?? moves}
              {tools}
            </div>
            {top && <SeatBadge seat={top} widget={widget} userId={userId} mirrored />}
          </div>
        </div>
      ) : (
        <div className={single ? SPLIT : STACK}>
          <SeatLine seat={top} widget={widget} userId={userId} className="[grid-area:top]" />
          <div className="min-w-0 self-start [grid-area:board]">{view}</div>
          <SeatLine seat={bottom} widget={widget} userId={userId} className="[grid-area:bottom]" />
          {/* The middle, between the players: the moves under the status, the notes while open, or how it ended. */}
          <div className="flex min-h-0 min-w-0 flex-col gap-2 px-1.5 py-1 [grid-area:meta]">
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2">
              {history ?? ending ?? (
                <>
                  {scene.status && (
                    <p
                      role="status"
                      className={cn("text-center text-[0.9375rem] leading-snug text-pretty", STATUS_TONE[scene.status.tone] ?? STATUS_TONE.neutral)}
                    >
                      {scene.status.text}
                    </p>
                  )}
                  {moves}
                </>
              )}
            </div>
            {tools && <div className="flex justify-end">{tools}</div>}
          </div>
        </div>
      )}
    </section>
  );
}
