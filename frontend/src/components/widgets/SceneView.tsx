import { useRef, useState, type PointerEvent } from "react";
import { RotateCw, X } from "lucide-react";
import type { WidgetAction, WidgetBoard, WidgetScene, WidgetSceneInput, WidgetSceneToken } from "@/lib/api";
import { cn } from "@/lib/utils";
import { CardTable } from "./CardTable";
import { spriteLabel } from "./spriteNames";
import { Sprite } from "./sprites";

// Colour roles only (widgets.css): the theme and dark mode remap them.
const SQUARE_LIGHT = "bg-(--w-square-light)";
const SQUARE_DARK = "bg-(--w-square-dark)";
const INK = "text-(--w-ink)";
// Tones painted under the tokens; the rest are pencil marks drawn over them.
const UNDERLAY: Record<string, string> = {
  last: "bg-[color-mix(in_oklch,var(--w-highlight)_55%,transparent)]",
  danger:
    "bg-[radial-gradient(circle,color-mix(in_oklch,var(--w-danger)_90%,transparent)_0%,color-mix(in_oklch,var(--w-danger)_35%,transparent)_50%,transparent_78%)]",
};
// A pointer that travels this far (px) is dragging a piece, not tapping it.
const DRAG_SLOP = 4;

/** Where in a token the viewer took hold, in cells from its first: a ship moves by the cell you hold. */
type Grab = [number, number];

interface Drag {
  from: string;
  grab: Grab;
  /** Where the press began: a drag is the pointer moving that far from it, however slowly it gets there. */
  x0: number;
  y0: number;
  x: number;
  y: number;
  /** A cell's size on screen, so the token follows the pointer by the cell held. */
  cellW: number;
  cellH: number;
  moved: boolean;
  wasSelected: boolean;
}

type Pending = { from: string; to: string } | { at: string };

/** Draws any widget scene, one board or several or a card table, and turns the viewer's picks and taps into actions. Knows no
 *  rules: what may move where comes from the viewer's `scene.input`. A move shows at once, and the next scene
 *  confirms or undoes it. */
export function SceneView({
  scene,
  seat,
  busy,
  onAct,
}: {
  scene: WidgetScene;
  /** The viewer's seat; null for a spectator, who never acts. */
  seat: string | null;
  /** An action is in flight: the board waits for its answer. */
  busy: boolean;
  onAct: (action: WidgetAction) => void;
}) {
  const boards: WidgetBoard[] =
    scene.boards ?? (scene.board ? [{ id: "main", ...scene.board, tokens: scene.tokens, marks: scene.marks }] : []);
  const input = seat ? scene.input?.[seat] : undefined;
  const inputBoard = input?.board ?? boards[0]?.id;
  const flip = seat != null && scene.flip_for === seat;
  return (
    <div className="@container">
      {scene.table ? (
        <CardTable rows={scene.table.rows} />
      ) : (
        <div className={cn("grid gap-3", boards.length > 1 && "@md:grid-cols-2")}>
          {boards.map((board) => (
            <BoardView
              key={board.id}
              board={board}
              scene={scene}
              input={input && inputBoard === board.id ? input : undefined}
              flip={flip}
              busy={busy}
              onAct={onAct}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BoardView({
  board,
  scene,
  input,
  flip,
  busy,
  onAct,
}: {
  board: WidgetBoard;
  /** The scene the board belongs to: a new one resets what was picked or pending. */
  scene: WidgetScene;
  input: WidgetSceneInput | undefined;
  flip: boolean;
  busy: boolean;
  onAct: (action: WidgetAction) => void;
}) {
  const width = board.cols.length;
  const height = board.rows.length;
  const fromTop = board.origin === "top";
  const notebook = board.style === "notebook";

  const surfaceRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [grab, setGrab] = useState<Grab>([0, 0]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [choosing, setChoosing] = useState<{ from: string; to: string } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // A ship just turned, by its token's id: once the board settles it stays held, to turn again or move.
  const [follow, setFollow] = useState<string | null>(null);
  const [shown, setShown] = useState(scene);
  const [wasBusy, setWasBusy] = useState(busy);
  if (shown !== scene) {
    // A new scene answers whatever was in flight, so the local guesses go.
    setShown(scene);
    setSelected(null);
    setPending(null);
    setChoosing(null);
  }
  if (wasBusy !== busy) {
    setWasBusy(busy);
    if (!busy) setPending(null);
  }

  /** Display column and row (0 at the top left) of a logical cell. */
  const display = (x: number, y: number) => ({
    dx: flip ? width - 1 - x : x,
    dy: fromTop ? (flip ? height - 1 - y : y) : flip ? y : height - 1 - y,
  });
  const cells = Array.from({ length: width * height }, (_, i) => {
    const dx = i % width;
    const dy = Math.floor(i / width);
    const x = flip ? width - 1 - dx : dx;
    const y = fromTop ? (flip ? height - 1 - dy : dy) : flip ? dy : height - 1 - dy;
    const name = `${board.cols[x] ?? ""}${board.rows[y] ?? ""}`;
    return { name, x, y, dx, dy, dark: board.pattern === "checker" && (x + y) % 2 === 0 };
  });
  const place = new Map(cells.map((c) => [c.name, c]));
  const cellAt = (dx: number, dy: number) =>
    dx >= 0 && dy >= 0 && dx < width && dy < height ? cells[dy * width + dx]?.name ?? null : null;
  /** The display rectangle a token covers, in cells. */
  const box = (at: string, span: [number, number] = [1, 1]) => {
    const start = place.get(at);
    if (!start) return null;
    const [w, h] = span;
    const a = display(start.x, start.y);
    const b = display(start.x + w - 1, start.y + h - 1);
    return { left: Math.min(a.dx, b.dx), top: Math.min(a.dy, b.dy), w, h };
  };

  const tokens = board.tokens ?? [];
  // Every cell a token covers, so a ship reads as a ship along its whole length.
  const occupant = new Map<string, WidgetSceneToken>();
  for (const token of tokens) {
    const start = place.get(token.at);
    const [w, h] = token.span ?? [1, 1];
    for (let i = 0; start && i < w; i++) {
      for (let j = 0; j < h; j++) occupant.set(`${board.cols[start.x + i] ?? ""}${board.rows[start.y + j] ?? ""}`, token);
    }
  }
  const underlays = new Map<string, string[]>();
  const pencil: { at: string; tone: string }[] = [];
  for (const mark of board.marks ?? []) {
    if (UNDERLAY[mark.tone]) underlays.set(mark.at, [...(underlays.get(mark.at) ?? []), mark.tone]);
    else pencil.push(mark);
  }

  /** The cell `dx`, `dy` cells on from `cell`, if that is on the board. */
  const shift = (cell: string, [dx, dy]: Grab) => {
    const c = place.get(cell);
    if (!c) return null;
    const x = c.x + dx;
    const y = c.y + dy;
    return x >= 0 && y >= 0 && x < width && y < height ? `${board.cols[x] ?? ""}${board.rows[y] ?? ""}` : null;
  };
  /** What a press on `cell` takes hold of: the piece there, or the token covering it, held where pressed. */
  const sourceOf = (cell: string): { from: string; grab: Grab } | null => {
    if (!input?.pick) return null;
    if (input.pick[cell]) return { from: cell, grab: [0, 0] };
    const token = occupant.get(cell);
    const start = token ? place.get(token.at) : undefined;
    const here = place.get(cell);
    return token && start && here && input.pick[token.at] ? { from: token.at, grab: [here.x - start.x, here.y - start.y] } : null;
  };

  const canAct = input != null && !busy && pending == null && choosing == null;
  const taps = canAct ? new Set(input.tap ?? []) : new Set<string>();
  // Where the held token may go, by its first cell; a place that is its own first cell turns it there.
  const picks = canAct && selected ? input.pick?.[selected] ?? [] : [];
  // Where the held cell may land: each of those places, moved by where the token is held.
  const targets = picks.flatMap((to) => shift(to, grab) ?? []);
  // A held token shows as held along its whole length.
  const isHeld = (cell: string) => selected != null && (cell === selected || occupant.get(cell)?.at === selected);
  if (follow != null && pending == null && !busy) {
    setFollow(null);
    const ship = tokens.find((t) => t.id === follow);
    if (ship && input?.pick?.[ship.at]) {
      setSelected(ship.at);
      setGrab([0, 0]);
    }
  }

  const send = (args: Record<string, unknown>, next: Pending) => {
    if (!input) return;
    setPending(next);
    setSelected(null);
    setChoosing(null);
    onAct({ type: input.action, args });
  };
  const commit = (from: string, to: string) => {
    if (input?.choose?.[from + to]) {
      setSelected(null);
      setChoosing({ from, to });
    } else {
      send({ from, to }, { from, to });
    }
  };
  /** Turns the ship at `from` (the server turns it about its middle where there is room), held still wherever
   *  it lands, so it may turn again. */
  const turn = (from: string) => {
    setFollow(occupant.get(from)?.id ?? null);
    commit(from, from);
  };
  /** A tap or a key press on a cell: fire at it, move the held token so the held cell lands there, take hold of
   *  a token, or, on the token already held, turn it where it may turn or let go. */
  const tap = (cell: string) => {
    if (!canAct) return;
    if (taps.has(cell)) {
      send({ at: cell }, { at: cell });
      return;
    }
    const source = sourceOf(cell);
    if (selected && source?.from === selected) {
      if (picks.includes(selected)) turn(selected);
      else setSelected(null);
      return;
    }
    const to = selected ? shift(cell, [-grab[0], -grab[1]]) : null;
    if (selected && to && picks.includes(to)) commit(selected, to);
    else if (source) {
      setSelected(source.from);
      setGrab(source.grab);
    } else setSelected(null);
  };

  const pointerCell = (e: PointerEvent) => {
    const rect = surfaceRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return { x, y, cell: cellAt(Math.floor((x / rect.width) * width), Math.floor((y / rect.height) * height)) };
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!canAct || e.button !== 0) return;
    const { x, y, cell } = pointerCell(e);
    if (!cell) return;
    const source = sourceOf(cell);
    if (source) {
      const rect = e.currentTarget.getBoundingClientRect();
      e.currentTarget.setPointerCapture(e.pointerId);
      setDrag({
        ...source,
        x0: x,
        y0: y,
        x,
        y,
        cellW: rect.width / width,
        cellH: rect.height / height,
        moved: false,
        wasSelected: source.from === selected,
      });
      setSelected(source.from);
      setGrab(source.grab);
    } else {
      tap(cell);
    }
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const { x, y } = pointerCell(e);
    setDrag({ ...drag, x, y, moved: drag.moved || Math.hypot(x - drag.x0, y - drag.y0) > DRAG_SLOP });
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    setDrag(null);
    if (!drag.moved) {
      // A press on the token already held: turn it where it may turn, else let go.
      if (drag.wasSelected) {
        if (input?.pick?.[drag.from]?.includes(drag.from)) turn(drag.from);
        else setSelected(null);
      }
      return;
    }
    const { cell } = pointerCell(e);
    const to = cell ? shift(cell, [-drag.grab[0], -drag.grab[1]]) : null;
    if (to && to !== drag.from && input?.pick?.[drag.from]?.includes(to)) commit(drag.from, to);
  };

  const choices = choosing ? input?.choose?.[choosing.from + choosing.to] ?? [] : [];
  const cellBox = (left: number, top: number, w = 1, h = 1) => ({
    width: `${String((w * 100) / width)}%`,
    height: `${String((h * 100) / height)}%`,
    transform: `translate(${String((left / w) * 100)}%, ${String((top / h) * 100)}%)`,
  });

  const surface = (
    <div
      ref={surfaceRef}
      role="grid"
      aria-label={board.title ?? board.label ?? "Board"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { setDrag(null); }}
      className={cn(
        // The board well: an opaque surface (dense data never sits on glass), its corners concentric with the card.
        "relative aspect-square w-full select-none overflow-hidden rounded-(--w-radius-inner)",
        notebook && "bg-(--w-paper)",
        canAct && "touch-none",
      )}
      style={notebook ? {
        // Graph paper: lines drawn by the background, so cells and tokens share one exact grid.
        backgroundImage:
          "linear-gradient(to right, var(--w-grid) 1px, transparent 1px), linear-gradient(to bottom, var(--w-grid) 1px, transparent 1px)",
        backgroundSize: `${String(100 / width)}% ${String(100 / height)}%`,
        boxShadow: "inset -1px -1px 0 var(--w-grid)",
      } : undefined}
    >
      <div className="grid size-full" style={{ gridTemplateColumns: `repeat(${String(width)}, minmax(0, 1fr))` }}>
        {cells.map(({ name, dark }) => {
          const target = targets.includes(name);
          const tappable = taps.has(name);
          const actionable = canAct && (tappable || sourceOf(name) != null || target);
          const token = occupant.get(name);
          const label = [name, token && spriteLabel(token.sprite), (target || tappable) && "available"].filter(Boolean).join(", ");
          return (
            <button
              key={name}
              type="button"
              tabIndex={actionable ? 0 : -1}
              aria-label={label}
              aria-pressed={isHeld(name) || undefined}
              // Pointer input is the board's; a click with no pointer behind it is the keyboard.
              onClick={(e) => { if (e.detail === 0) tap(name); }}
              className={cn(
                // Two-tone, so the ring reads on cream, walnut and paper alike.
                "relative outline-none focus-visible:z-10 focus-visible:shadow-[inset_0_0_0_2px_var(--w-piece-light-edge),inset_0_0_0_4px_var(--w-piece-light)]",
                !notebook && (dark ? SQUARE_DARK : SQUARE_LIGHT),
                actionable && "cursor-pointer",
                tappable && "cursor-crosshair hover:bg-[color-mix(in_oklch,var(--w-ink)_12%,transparent)]",
              )}
            >
              {underlays.get(name)?.map((tone) => (
                <span key={tone} aria-hidden className={cn("absolute inset-0", UNDERLAY[tone])} />
              ))}
              {/* Selection is a ring as well as a tint, so it never rests on colour alone. */}
              {isHeld(name) && (
                <span
                  aria-hidden
                  className="absolute inset-0 bg-[color-mix(in_oklch,var(--w-primary)_35%,transparent)] shadow-[inset_0_0_0_2px_var(--w-piece-light-edge),inset_0_0_0_4px_var(--w-piece-light)]"
                />
              )}
              {target && (occupant.has(name) ? (
                <span
                  aria-hidden
                  className="absolute inset-[4%] rounded-full shadow-[inset_0_0_0_3px_color-mix(in_oklch,var(--w-piece-light-edge)_40%,transparent)]"
                />
              ) : (
                <span
                  aria-hidden
                  className="absolute top-1/2 left-1/2 size-[28%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[color-mix(in_oklch,var(--w-piece-light-edge)_40%,transparent)]"
                />
              ))}
            </button>
          );
        })}
      </div>

      {tokens.map((token) => {
        let at = token.at;
        if (pending && "from" in pending) {
          // A token where the move lands is taken, unless it is the one moving (a ship turning in place).
          if (token.at === pending.to && token.at !== pending.from) return null;
          if (token.at === pending.from) at = pending.to;
        }
        const rect = box(at, token.span);
        if (!rect) return null;
        const dragged = drag?.moved && drag.from === token.at;
        let style = cellBox(rect.left, rect.top, rect.w, rect.h);
        if (dragged) {
          // Whole, under the pointer by the cell held.
          const held = place.get(shift(token.at, drag.grab) ?? token.at);
          const spot = held ? display(held.x, held.y) : { dx: rect.left, dy: rect.top };
          const gx = spot.dx - rect.left + 0.5;
          const gy = spot.dy - rect.top + 0.5;
          style = {
            ...cellBox(0, 0, rect.w, rect.h),
            // Lifted about its own middle, after the move: a `scale` property (Tailwind's `scale-*`) applies on top
            // of the transform, so it would grow the move too and the piece would drift off the pointer.
            transform: `translate(${String(drag.x - gx * drag.cellW)}px, ${String(drag.y - gy * drag.cellH)}px) scale(1.1)`,
          };
        }
        return (
          <div
            key={token.id}
            aria-hidden
            className={cn(
              "pointer-events-none absolute top-0 left-0",
              // Its own layer while it follows the pointer, so each frame only moves it.
              dragged ? "z-10 will-change-transform" : "transition-transform duration-200 ease-out motion-reduce:transition-none",
            )}
            style={style}
          >
            <Sprite
              name={token.sprite}
              span={token.span}
              className={cn(
                "size-full",
                notebook ? "p-[3%]" : "p-[2%] drop-shadow-[0_1px_1.5px_color-mix(in_oklch,var(--w-shadow-color)_35%,transparent)]",
              )}
            />
          </div>
        );
      })}

      {(() => {
        // The held ship's own turn button, at its middle: a ship turns there, about its middle where it has room.
        const ship = canAct && selected ? tokens.find((t) => t.at === selected && (t.span ?? [1, 1]).some((n) => n > 1)) : undefined;
        const rect = ship && box(ship.at, ship.span);
        if (!ship || !rect || !selected) return null;
        const canTurn = picks.includes(selected);
        const label = canTurn ? "Turn the ship" : "No room to turn the ship here";
        return (
          <button
            type="button"
            aria-label={label}
            title={label}
            aria-disabled={!canTurn}
            // Its own press: never the start of a drag on the board beneath.
            onPointerDown={(e) => { e.stopPropagation(); }}
            onClick={() => { if (canTurn) turn(ship.at); }}
            className={cn(
              "absolute z-20 grid size-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full outline-none",
              "bg-(--w-primary) text-(--w-on-primary) shadow-[0_1px_3px_color-mix(in_oklch,var(--w-shadow-color)_35%,transparent)]",
              "focus-visible:shadow-[0_0_0_2px_var(--w-surface),0_0_0_4px_var(--w-primary)] aria-disabled:opacity-45",
            )}
            style={{
              left: `${String(((rect.left + rect.w / 2) * 100) / width)}%`,
              top: `${String(((rect.top + rect.h / 2) * 100) / height)}%`,
            }}
          >
            <RotateCw aria-hidden className="size-4" />
          </button>
        );
      })()}

      {pencil.map(({ at, tone }) => {
        const rect = box(at);
        return rect && (
          <div key={`${at}:${tone}`} aria-hidden className="pointer-events-none absolute top-0 left-0" style={cellBox(rect.left, rect.top)}>
            <PencilMark tone={tone} />
          </div>
        );
      })}

      {pending && "at" in pending && (() => {
        const rect = box(pending.at);
        return rect && (
          <div aria-hidden className="pointer-events-none absolute top-0 left-0 grid place-items-center" style={cellBox(rect.left, rect.top)}>
            <span className={cn("size-[30%] animate-pulse rounded-full bg-current", INK)} />
          </div>
        );
      })()}

      {choosing && choices.length > 0 && (
        <div className="absolute inset-0 z-20 grid place-items-center bg-[color-mix(in_oklch,var(--w-surface)_40%,transparent)]">
          {/* A floating menu over the board: glass, with its tint as the legibility floor. */}
          <div role="group" aria-label="Choose a piece" className="wgt-glass flex items-center gap-1 rounded-[1rem] p-1.5">
            {choices.map((c) => (
              <button
                key={c.value}
                type="button"
                autoFocus={c === choices[0]}
                aria-label={spriteLabel(c.sprite)}
                onClick={() => { send({ ...choosing, choice: c.value }, choosing); }}
                className="size-11 rounded-[0.625rem] outline-none hover:bg-(--w-state-hover) focus-visible:shadow-[inset_0_0_0_2px_var(--w-primary)]"
              >
                <Sprite name={c.sprite} className="size-full p-1" />
              </button>
            ))}
            <button
              type="button"
              aria-label="Cancel"
              onClick={() => { setChoosing(null); }}
              className="grid size-11 place-items-center rounded-[0.625rem] text-(--w-on-surface-variant) outline-none hover:bg-(--w-state-hover) hover:text-(--w-on-surface) focus-visible:shadow-[inset_0_0_0_2px_var(--w-primary)]"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );

  const order = (labels: string[], reversed: boolean) => (reversed ? [...labels].reverse() : labels);
  // Coordinates sit outside the board, on the card, where small type keeps its contrast on every theme.
  const colLabels = (
    <div aria-hidden className="grid text-center" style={{ gridTemplateColumns: `repeat(${String(width)}, minmax(0, 1fr))` }}>
      {order(board.cols, flip).map((col) => <span key={col}>{col}</span>)}
    </div>
  );
  const rowLabels = (
    <div aria-hidden className="grid items-center text-right" style={{ gridTemplateRows: `repeat(${String(height)}, minmax(0, 1fr))` }}>
      {order(board.rows, fromTop === flip).map((row) => <span key={row}>{row}</span>)}
    </div>
  );
  return (
    <figure className="min-w-0">
      {board.title && (
        <figcaption
          className={cn(
            "px-0.5 pb-1.5 text-[0.875rem] leading-snug font-medium text-pretty",
            notebook ? INK : "text-(--w-on-surface-variant)",
          )}
        >
          {board.title}
        </figcaption>
      )}
      {board.show_labels ? (
        <div
          className={cn(
            "grid grid-cols-[auto_minmax(0,1fr)] gap-x-1.5 gap-y-1 text-[0.75rem] leading-none font-medium tabular-nums",
            notebook ? INK : "text-(--w-on-surface-variant)",
          )}
        >
          {fromTop && <><span />{colLabels}</>}
          {rowLabels}
          {surface}
          {!fromTop && <><span />{colLabels}</>}
        </div>
      ) : surface}
    </figure>
  );
}

/** A pencil mark over a cell: a cross for a hit, a dot for a miss, a fainter dot where a miss is certain. */
function PencilMark({ tone }: { tone: string }) {
  if (tone === "hit") {
    return (
      <svg viewBox="0 0 10 10" className="absolute inset-[16%] text-(--w-danger)">
        <path d="M1.5 1.5 8.5 8.5M8.5 1.5 1.5 8.5" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" fill="none" />
      </svg>
    );
  }
  return (
    <span
      className={cn(
        "absolute top-1/2 left-1/2 size-[20%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-current",
        INK,
        tone === "near" && "opacity-45",
      )}
    />
  );
}
