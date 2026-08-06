import { GrainGradient } from "@paper-design/shaders-react";

/**
 * The marketing site's hero canvas, on the sign-in panel.
 *
 * A port of web/src/components/ShaderBackdrop.tsx — same palette, same
 * parameters — so the first thing a visitor sees after clicking "Get Started"
 * on clawbits.ai is the surface they just left. Keep the two in lock-step; if
 * the landing's art direction moves, this moves with it.
 *
 * Loaded through `lazy()` at the only call site (LoginPage), because the WebGL
 * runtime is a few hundred KB and every other route in the app has no use for
 * it. The CSS candy gradient painted behind this is what shows until the chunk
 * lands, without JavaScript, or when WebGL is unavailable — this component
 * simply layers on top when it arrives, so there is no fallback to design.
 *
 * Keep this file dumb: props in, canvas out.
 */

/** Sampled from the OG card's gummy letters: strawberry, grape, blue, orange. */
const CANDY_COLORS = ["#e8425c", "#8f5bd6", "#4a8fe0", "#f09a3f", "#b03927"];

/** The landing's --color-canvas, the warm black everything sits on. */
const CANVAS_INK = "#141311";

interface Props {
  colors?: string[];
  colorBack?: string;
  softness?: number;
  intensity?: number;
  noise?: number;
  speed?: number;
  /**
   * Sizing. The landing renders this into a landscape canvas, where the wave
   * lands as a low band. Dropped into a tall column it would fill the frame
   * as a mountain and put orange under the copy, so the sign-in panel gives
   * the shader a landscape WORLD and lets `fit="cover"` crop it — the wave
   * keeps its proportions and stays where the art direction put it.
   */
  scale?: number;
  offsetY?: number;
  worldWidth?: number;
  worldHeight?: number;
  fit?: "none" | "contain" | "cover";
}

export default function ShaderBackdrop({
  colors = CANDY_COLORS,
  colorBack = CANVAS_INK,
  softness = 0.7,
  intensity = 0.15,
  noise = 0.5,
  speed = 0.7,
  scale,
  offsetY,
  worldWidth,
  worldHeight,
  fit,
}: Props) {
  // Reduced motion: freeze rather than remove — the gradient is the art
  // direction; its drift is the only optional part.
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
      scale={scale}
      offsetY={offsetY}
      worldWidth={worldWidth}
      worldHeight={worldHeight}
      fit={fit}
    />
  );
}
