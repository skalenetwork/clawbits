import { type CSSProperties } from "react";

// Progressive (gradient) blur — the iOS status-bar / nav-scrim effect.
//
// A single ``backdrop-blur`` + mask only fades a *uniformly* blurred
// layer in and out; the blur radius is constant, so content either side
// of the mask is equally sharp/soft and you get a visible "blur stops
// here" seam. A real progressive blur instead STACKS several layers,
// each with a larger ``backdrop-filter: blur()`` radius and a mask that
// confines it closer to the strong edge. Because each layer samples the
// backdrop *including the already-blurred layers painted behind it*, the
// blur compounds toward the edge — a smooth 0 → max ramp with no seam.
//
// Layer i (0 = gentlest) gets:
//   - radius  = blur / 2^(layers-1-i)        → …, blur/4, blur/2, blur
//   - a mask whose opaque band shrinks toward the strong edge, so the
//     gentle layers cover the whole band while the strong ones only
//     touch the very edge. The soft gradient stops keep the bands from
//     banding into each other.
//
// Give the root its placement + height via ``className`` (and an
// optional ``bg-gradient`` tint there — the layers sample it harmlessly).

interface ProgressiveBlurProps {
  /** Placement, size, and any tint (e.g. a ``bg-gradient-*``). The
   *  element is the blur band itself, so it needs absolute positioning
   *  and a fixed extent along the blur axis. */
  className?: string;
  /** Edge where the blur is strongest; it ramps to zero at the opposite
   *  edge. Default ``"top"``. */
  side?: "top" | "bottom";
  /** Radius (px) of the strongest single layer. The *effective* edge
   *  blur is a bit higher since the layers compound. Default ``4``. */
  blur?: number;
  /** Number of stacked layers — more is smoother but costs a touch more
   *  paint. Default ``5``. */
  layers?: number;
  style?: CSSProperties;
}

export function ProgressiveBlur({
  className,
  side = "top",
  blur = 4,
  layers = 5,
  style,
}: ProgressiveBlurProps) {
  // Mask runs from the strong edge (0%) toward the weak edge.
  const dir = side === "top" ? "to bottom" : "to top";
  return (
    <div aria-hidden className={className} style={style}>
      {Array.from({ length: layers }, (_, i) => {
        const radius = blur / 2 ** (layers - 1 - i);
        // reach: how far this layer extends from the strong edge.
        // Gentlest (i=0) spans the whole band; strongest hugs the edge.
        const reach = 1 - i / layers;
        const solid = (reach * 50).toFixed(2);
        const fade = (reach * 100).toFixed(2);
        const mask = `linear-gradient(${dir}, #000 0%, #000 ${solid}%, transparent ${fade}%)`;
        return (
          <div
            key={i}
            className="absolute inset-0"
            style={{
              backdropFilter: `blur(${String(radius)}px)`,
              WebkitBackdropFilter: `blur(${String(radius)}px)`,
              maskImage: mask,
              WebkitMaskImage: mask,
            }}
          />
        );
      })}
    </div>
  );
}
