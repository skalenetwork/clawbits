import { setPieceSet, usePieceSet, type PieceSet } from "@/lib/pieceSet";
import { cn } from "@/lib/utils";
import { Sprite } from "./sprites";

const OPTIONS: { set: PieceSet; label: string }[] = [
  { set: "sea", label: "Sea pieces" },
  { set: "classic", label: "Classic pieces" },
];

/** The device's piece set, switched from the game itself; each option shows its own knight. Settings → Appearance
 *  holds the same choice. */
export function PieceSetSwitch({ className }: { className?: string }) {
  const current = usePieceSet();
  return (
    <div
      role="group"
      aria-label="Chess pieces"
      className={cn("flex items-center gap-0.5 rounded-full bg-(--w-surface-container-high) p-0.5", className)}
    >
      {OPTIONS.map(({ set, label }) => (
        <button
          key={set}
          type="button"
          aria-label={label}
          aria-pressed={current === set}
          title={label}
          onClick={() => { setPieceSet(set); }}
          className={cn(
            "grid size-7 place-items-center rounded-full outline-none transition-opacity focus-visible:shadow-[0_0_0_2px_var(--w-primary)]",
            current === set ? "bg-(--w-surface) shadow-(--w-elevation-1)" : "opacity-60 hover:opacity-100",
          )}
        >
          <Sprite name="chess.wN" set={set} className="size-6" />
        </button>
      ))}
    </div>
  );
}
