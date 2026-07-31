/**
 * CardFlip — a two-face 3D Y-rotation reveal: the front (e.g. HatchingCard)
 * flips away to expose the back (the real AgentCollectibleCard) when `flipped`
 * turns true. `prefers-reduced-motion` degrades to a plain crossfade (the
 * rotation is suppressed; opacity still transitions).
 *
 * Both faces stay mounted (absolute-stacked) so the reveal is seamless; the
 * container takes the front face's height until the flip, then the back's.
 */
import { cn } from "@/lib/utils";

export function CardFlip({
  flipped,
  front,
  back,
  className,
}: {
  flipped: boolean;
  front: React.ReactNode;
  back: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("relative w-full [perspective:1200px]", className)}>
      <div
        className={cn(
          "relative grid transition-transform duration-700 ease-in-out [transform-style:preserve-3d] motion-reduce:transition-none",
          flipped && "[transform:rotateY(180deg)] motion-reduce:[transform:none]",
        )}
      >
        {/* Both faces share the one grid cell; backface culling picks the
            visible one mid-turn. Reduced motion: opacity does the swap. */}
        <div
          className={cn(
            "col-start-1 row-start-1 [backface-visibility:hidden] transition-opacity duration-700 motion-reduce:duration-300",
            flipped && "opacity-0 motion-reduce:pointer-events-none",
          )}
          aria-hidden={flipped}
        >
          {front}
        </div>
        <div
          className={cn(
            "col-start-1 row-start-1 [backface-visibility:hidden] [transform:rotateY(180deg)] motion-reduce:[transform:none] transition-opacity duration-700 motion-reduce:duration-300",
            !flipped && "opacity-0 pointer-events-none",
          )}
          aria-hidden={!flipped}
        >
          {back}
        </div>
      </div>
    </div>
  );
}
