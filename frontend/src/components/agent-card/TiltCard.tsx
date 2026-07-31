/**
 * Pointer-tracked 3D tilt wrapper (transitions.dev card-hover-tilt recipe);
 * the styles live in index.css (`.t-tilt*`) with the other `t-` helpers.
 *
 * The pointer is tracked on the OUTER wrapper (which never transforms) so the
 * tilting child can't pull its own edges out from under the cursor. rotateX/Y
 * and the cursor position are written into CSS custom properties
 * (`--tilt-rx/ry`, `--tilt-gx/gy`), and `.is-hover` toggles on the wrapper.
 *
 * The specular glare is intentionally NOT rendered here: AgentCollectibleCard
 * draws its own glare INSIDE the SVG, clipped to the card's actual silhouette,
 * and just reads these same CSS vars. That keeps the glow on the real shape
 * instead of the bounding rectangle.
 */
import { useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export function TiltCard({
  children,
  max = 14,
  className,
}: {
  children: ReactNode;
  /** Max tilt in degrees at the card edges. */
  max?: number;
  className?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    // Ignore touch so the tilt never fights page scroll (e.g. in the agent
    // gallery grid); it's a mouse/pen hover flourish only.
    if (e.pointerType === "touch") return;
    const wrap = wrapRef.current;
    const card = cardRef.current;
    if (!wrap || !card) return;
    const r = wrap.getBoundingClientRect();
    const px = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const py = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    wrap.classList.add("is-hover");
    card.classList.add("is-tilting");
    card.style.setProperty("--tilt-ry", `${((px - 0.5) * max).toFixed(2)}deg`);
    card.style.setProperty("--tilt-rx", `${((0.5 - py) * max).toFixed(2)}deg`);
    card.style.setProperty("--tilt-gx", `${(px * 100).toFixed(1)}%`);
    card.style.setProperty("--tilt-gy", `${(py * 100).toFixed(1)}%`);
  };

  const onLeave = () => {
    const wrap = wrapRef.current;
    const card = cardRef.current;
    if (wrap) wrap.classList.remove("is-hover");
    if (card) {
      card.classList.remove("is-tilting");
      card.style.setProperty("--tilt-rx", "0deg");
      card.style.setProperty("--tilt-ry", "0deg");
    }
  };

  return (
    <div
      ref={wrapRef}
      className={cn("t-tilt", className)}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
    >
      <div ref={cardRef} className="t-tilt-card">
        {children}
      </div>
    </div>
  );
}
