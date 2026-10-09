import { useColorScheme } from "react-native";

/** The widgets' colours: the web's warm palette (frontend/src/components/widgets/widgets.css, OKLCH there) as sRGB
 *  for both appearances, on iOS's own neutrals. Plain strings, because the SVG pieces and cards need them. Dark is
 *  a second palette, not an inversion: gold instead of caramel, cards that stay light. */
const light = {
  surface: "#F2F2F7",
  surfaceHigh: "#E5E5EA",
  onSurface: "#000000",
  onSurfaceVariant: "#6C6C70",
  outline: "#D1D1D6",
  primary: "#885716",
  onPrimary: "#FAF7EE",
  primaryContainer: "#E1D9D3",
  onPrimaryContainer: "#623F10",
  danger: "#FF3B30",
  dangerContainer: "#F4D8DB",
  onDangerContainer: "#C72E25",
  highlight: "#F0CF4C",
  // Players, by seat order: ivory and ebony, as the chess sides (white moves first), which no action wears, so a
  // person never reads as a button. Each takes an edge where its appearance's card would swallow it.
  seat1: "#FDFAF1",
  onSeat1: "#261D16",
  seat1Edge: "#261D16",
  seat2: "#261D16",
  onSeat2: "#FDFAF1",
  seat2Edge: "transparent",
  squareLight: "#EFDCB5",
  squareDark: "#AE815D",
  pieceLight: "#FDFAF1",
  pieceLightEdge: "#261D16",
  paper: "#FCF7E7",
  grid: "#DDCBAD",
  ink: "#6C4122",
  felt: "#715035",
  feltLight: "#856851",
  feltDark: "#61452E",
  onFelt: "#F8F1E3",
  cardFace: "#FCFAF4",
  suitRed: "#C22826",
  suitBlack: "#261D16",
  cardBack: "#993C25",
  cardBackLine: "#B67362",
  shadow: "#2B1D12",
};

export type WidgetPalette = typeof light;

const dark: WidgetPalette = {
  ...light,
  surface: "#1C1C1E",
  surfaceHigh: "#2C2C2E",
  onSurface: "#FFFFFF",
  onSurfaceVariant: "#AEAEB2",
  outline: "#3A3A3C",
  primary: "#DEB870",
  onPrimary: "#2A1C10",
  primaryContainer: "#3B352B",
  onPrimaryContainer: "#E7CC98",
  danger: "#FF453A",
  dangerContainer: "#3C2222",
  onDangerContainer: "#FF6E65",
  highlight: "#CFAD4E",
  seat1Edge: "transparent",
  seat2Edge: "#69625A",
  squareLight: "#C8B494",
  squareDark: "#926B4E",
  paper: "#1E1A15",
  grid: "#473B2C",
  ink: "#DEC088",
  felt: "#46301D",
  feltLight: "#604D3D",
  feltDark: "#3C2919",
  onFelt: "#F0E7D6",
  cardFace: "#EBE7DF",
  shadow: "#000000",
};

export function useWidgetPalette(): WidgetPalette {
  return useColorScheme() === "dark" ? dark : light;
}

/** `hex` at `alpha` (0 to 1), as #RRGGBBAA. */
export function withAlpha(hex: string, alpha: number): string {
  return `${hex}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase()}`;
}
