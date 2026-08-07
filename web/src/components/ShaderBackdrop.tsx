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

/** Matches --color-canvas in global.css. Keep the two in step: this is the
 *  shader's own ground, so a drift shows as a seam where the canvas ends. */
const CANVAS_INK = "#141311";

interface Props {
  colors?: string[];
  colorBack?: string;
  softness?: number;
  intensity?: number;
  noise?: number;
  /**
   * Grain on narrow viewports. Defaults to a fraction of `noise` rather than a
   * fixed value, so a caller that already dialled `noise` down (the CTA runs
   * 0.12) is scaled rather than overridden upward.
   *
   * Grain is a per-pixel effect and phones render it at 3x: the same value that
   * reads as texture on a desktop canvas reads as static on a phone, and it is
   * the most expensive part of the shader to boot.
   */
  noiseNarrow?: number;
  speed?: number;
}

export default function ShaderBackdrop({
  colors = CANDY_COLORS,
  colorBack = CANVAS_INK,
  softness = 0.7,
  intensity = 0.15,
  noise = 0.5,
  noiseNarrow = noise * 0.5,
  speed = 0.7,
}: Props) {
  // Reduced motion: freeze rather than remove - the gradient is the art
  // direction; its drift is the only optional part. client:only guarantees
  // window exists by the time this runs.
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Read once at mount, like `still` above. Deliberately not reactive: matching
  // a resize would mean re-rendering the island, and remounting a WebGL canvas
  // to change a grain constant is a bad trade for a rotation nobody does mid-
  // scroll. 40rem is the same breakpoint the phone demo swaps at.
  const narrow = window.matchMedia("(max-width: 40rem)").matches;

  return (
    <GrainGradient
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      colors={colors}
      colorBack={colorBack}
      softness={softness}
      intensity={intensity}
      noise={narrow ? noiseNarrow : noise}
      shape="wave"
      speed={still ? 0 : speed}
    />
  );
}
