import { usePieceSet, type PieceSet } from "@/lib/pieceSet";
import { cn } from "@/lib/utils";
import { parseChessSprite } from "./spriteNames";

/** The sprites a scene may name, drawn here and nowhere else: a scene carries names, never markup.
 *  Chess pieces come in two of Mr L's sets: the sea set by default (a crab king, a mermaid queen, a narwhal
 *  bishop, a seahorse knight, a nautilus rook and a starfish pawn, recoloured to the board's honey and walnut and
 *  sized to fill their squares), and the classic Staunton set, as drawn. Which one a board draws is the device's
 *  choice, in Settings → Appearance. */

const PIECES = import.meta.glob<string>("./pieces/*/*.webp", { query: "?url", import: "default", eager: true });

/** A ship drawn in ink on graph paper, as long as the cells it spans; a sunk one in red. */
function NotebookShip({ sunk, span, className }: { sunk: boolean; span: [number, number]; className?: string }) {
  const [w, h] = span;
  return (
    <svg
      viewBox={`0 0 ${String(w * 10)} ${String(h * 10)}`}
      preserveAspectRatio="none"
      aria-hidden
      className={cn(className, sunk ? "text-(--w-danger)" : "text-(--w-ink)")}
    >
      <rect
        x={1}
        y={1}
        width={w * 10 - 2}
        height={h * 10 - 2}
        rx={1.5}
        fill="currentColor"
        fillOpacity={sunk ? 0.14 : 0.12}
        stroke="currentColor"
        strokeWidth={1.6}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function Sprite({ name, span, className, set }: {
  name: string;
  /** Cells the sprite covers; ships stretch across them. */
  span?: [number, number];
  className?: string;
  /** A set to draw in, whatever the device's choice. */
  set?: PieceSet;
}) {
  const preferred = usePieceSet();
  if (name === "notebook.ship" || name === "notebook.sunk") {
    return <NotebookShip sunk={name === "notebook.sunk"} span={span ?? [1, 1]} className={className} />;
  }
  const chess = parseChessSprite(name);
  const drawn = chess ? PIECES[`./pieces/${set ?? preferred}/${chess.color}${chess.piece}.webp`] : undefined;
  if (drawn) return <img src={drawn} alt="" aria-hidden draggable={false} className={cn("object-contain", className)} />;
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className}>
      <circle cx="12" cy="12" r="6" style={{ fill: "var(--w-on-surface-variant)" }} />
    </svg>
  );
}
