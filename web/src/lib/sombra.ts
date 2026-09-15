/**
 * The canvas gradient's SVG, shared by SombraGradient.astro (live, desktop) and
 * scripts/bake-sombra.ts (baked to /sombra/*.avif, phones).
 */

/** Five colours, bottom band to top glow, and the canvas ground they sit on
 * (--color-canvas; agent-pit's --ap-ground), which the phone bakes composite
 * over. */
export const PALETTES = {
  candy: { colors: ["#b03927", "#f09a3f", "#e8425c", "#8f5bd6", "#4a8fe0"], ground: "#141311" },
  sky: { colors: ["#ffffff", "#c2e1ff", "#ffffff", "#c2e1ff", "#ffffff"], ground: "#add6ff" },
} as const;

export type Palette = keyof typeof PALETTES;

const EDGES = [0, 141.222, 282.444, 423.667, 564.889, 738.592, 879.814, 1021.037, 1162.259, 1303.481];
const TOPS = [240.243, 171.756, 108.62, 52.895, 11.98, 52.895, 108.62, 171.756, 240.243];
const FLOOR = 659;
const BLUR = 15;
const PAD = BLUR * 4;
const PEAK = Math.min(...TOPS);

const segments = TOPS.map((top, i) => `<path d="M ${EDGES[i]} ${top} H ${EDGES[i + 1]} V ${FLOOR} H ${EDGES[i]} Z"/>`).join("");

type Stop = readonly [offset: number, opacity: number];

/** Paint order, top glow first; layer i takes colors[4 - i]. */
const STOPS: Stop[][] = [
  [
    [0, 0], [78, 0], [78.043, 0.0169], [78.086, 0.0327], [78.172, 0.0612], [78.258, 0.0862], [78.344, 0.1082],
    [78.43, 0.1278], [78.516, 0.1454], [78.602, 0.1611], [78.688, 0.1754], [78.773, 0.1882], [78.859, 0.2],
    [79.031, 0.2205], [79.203, 0.2377], [79.375, 0.2523], [79.547, 0.2649], [79.719, 0.2757], [79.891, 0.285],
    [80.063, 0.2931], [80.406, 0.3064], [80.75, 0.3166], [81.094, 0.3244], [81.438, 0.3303], [81.781, 0.3347],
    [82.125, 0.3378], [82.813, 0.3413], [83.5, 0.3418], [84.188, 0.34], [84.875, 0.3365], [85.563, 0.3315],
    [86.25, 0.3253], [87.625, 0.3097], [89, 0.2903], [90.375, 0.2676], [91.75, 0.2415], [93.125, 0.212],
    [94.5, 0.1788], [95.188, 0.1607], [95.875, 0.1416], [96.563, 0.1213], [97.25, 0.0998], [97.938, 0.0771],
    [98.625, 0.0529], [99.313, 0.0273], [100, 0],
  ],
  [
    [0, 0], [56, 0], [56.001, 0.9], [56.021, 0.9091], [56.344, 0.909], [57.375, 0.9086], [58.75, 0.908],
    [61.5, 0.907], [67, 0.9048], [78, 0.9], [78.688, 0.8446], [79.375, 0.791], [80.063, 0.7392], [80.75, 0.6891],
    [81.438, 0.6407], [82.125, 0.5941], [82.813, 0.5493], [83.5, 0.5063], [84.188, 0.4649], [84.875, 0.4254],
    [85.563, 0.3876], [86.25, 0.3516], [86.938, 0.3173], [87.625, 0.2848], [88.313, 0.254], [89, 0.225],
    [89.688, 0.1978], [90.375, 0.1723], [91.063, 0.1485], [91.75, 0.1266], [92.438, 0.1063], [93.125, 0.0879],
    [93.813, 0.0712], [94.5, 0.0562], [95.188, 0.0431], [95.875, 0.0316], [96.563, 0.022], [97.25, 0.0141],
    [97.938, 0.0079], [98.625, 0.0035], [99.313, 0.0009], [100, 0],
  ],
  [
    [0, 0], [31, 0], [31.001, 1], [56, 1], [58.75, 0.8641], [61.5, 0.7313], [64.25, 0.6016], [67, 0.475],
    [69.75, 0.3516], [72.5, 0.2313], [75.25, 0.1141], [78, 0], [100, 0],
  ],
  [[0, 0], [0.001, 1], [31, 1], [56, 0], [100, 0]],
  [[0, 1], [31, 0], [100, 0]],
];

/**
 * Each column gets its own bounding-box gradient, which is what melts the
 * steps together. Grain is a dither, not a texture: fine noise drives a
 * displacement map so edge pixels take a neighbouring band's colour, and the
 * same noise leaves sparse, faint dark specks. The grain filter runs in CSS
 * pixels on the outer svg; `id` keeps filter references unique per page.
 */
export function sombraSvg(palette: Palette, id: string): string {
  const { colors } = PALETTES[palette];
  const gradients = STOPS.map(
    (stops, i) =>
      `<linearGradient id="sombra-${id}-${i}" x1="0" y1="1" x2="0" y2="0">${stops
        .map(([offset, opacity]) => `<stop offset="${offset}%" stop-color="${colors[4 - i]}" stop-opacity="${opacity}"/>`)
        .join("")}</linearGradient>`,
  ).join("");
  const layers = STOPS.map((_, i) => `<g fill="url(#sombra-${id}-${i})" filter="url(#sombra-${id}-blur)">${segments}</g>`).join("");
  return `<svg viewBox="0 0 1271 599" preserveAspectRatio="none" fill="none" width="100%" height="100%" filter="url(#sombra-${id}-grain)"><defs>${gradients}<filter id="sombra-${id}-blur" filterUnits="userSpaceOnUse" x="${-PAD}" y="${PEAK - PAD}" width="${EDGES[EDGES.length - 1] + PAD * 2}" height="${FLOOR - PEAK + PAD * 2}"><feGaussianBlur stdDeviation="${BLUR}"/></filter><filter id="sombra-${id}-grain" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="1.4" numOctaves="1" seed="7" result="noise"/><feDisplacementMap in="SourceGraphic" in2="noise" scale="56" xChannelSelector="R" yChannelSelector="G" result="dither"/><feColorMatrix in="noise" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 -2 0 0.65" result="specks"/><feComposite in="specks" in2="dither" operator="atop"/></filter></defs>${layers}</svg>`;
}
