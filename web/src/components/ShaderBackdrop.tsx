import { GrainGradient } from "@paper-design/shaders-react";

/**
 * The only React island on the site.
 *
 * Fills the dark hero / CTA canvases with @paper-design's GrainGradient in
 * the candy palette (sampled from the OG card's gummy letters: strawberry,
 * grape, blue, orange) over the warm-black canvas ground. Mounted with
 * client:only="react", so the .shader-fallback CSS gradient behind it is what
 * shows before hydration, without JavaScript, or if WebGL is unavailable -
 * the component simply layers on top when it arrives.
 *
 * Keep this file dumb: props in, canvas out. Anything clever (visibility
 * pausing, palette switching) belongs to the caller.
 */

export const CANDY_COLORS = ["#e8425c", "#8f5bd6", "#4a8fe0", "#f09a3f", "#b03927"];

/** Matches --color-canvas in global.css. */
const CANVAS_INK = "#141311";

interface Props {
  colors?: string[];
  colorBack?: string;
  softness?: number;
  intensity?: number;
  noise?: number;
  speed?: number;
}

export default function ShaderBackdrop({
  colors = CANDY_COLORS,
  colorBack = CANVAS_INK,
  softness = 0.7,
  intensity = 0.15,
  noise = 0.5,
  speed = 0.7,
}: Props) {
  // Reduced motion: freeze rather than remove - the gradient is the art
  // direction; its drift is the only optional part. client:only guarantees
  // window exists by the time this runs.
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  return (
    <GrainGradient
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      colors={colors}
      colorBack={colorBack}
      softness={softness}
      intensity={intensity}
      noise={noise}
      shape="wave"
      speed={still ? 0 : speed}
    />
  );
}
