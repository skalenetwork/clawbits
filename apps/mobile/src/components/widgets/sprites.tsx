import { Image } from "expo-image";
import Svg, { Circle, G, Path, Rect } from "react-native-svg";
import { parseChessSprite, type Suit } from "@/lib/widgets";
import type { WidgetPalette } from "./palette";
import { usePieceSet, type PieceSet } from "./piece-set";

/** The sprites a scene may name, drawn here and nowhere else: a scene carries names, never markup. Chess pieces come
 *  in two of Mr L's sets, as on the web: the sea set by default (recoloured to the board's honey and walnut, sized
 *  to fill their squares), and the classic Staunton set, as drawn. The game's own switch picks one per phone. */

const PIECES: Record<PieceSet, Record<string, number>> = {
  sea: {
    wK: require("../../../assets/images/pieces/sea/wK.webp"),
    wQ: require("../../../assets/images/pieces/sea/wQ.webp"),
    wB: require("../../../assets/images/pieces/sea/wB.webp"),
    wN: require("../../../assets/images/pieces/sea/wN.webp"),
    wR: require("../../../assets/images/pieces/sea/wR.webp"),
    wP: require("../../../assets/images/pieces/sea/wP.webp"),
    bK: require("../../../assets/images/pieces/sea/bK.webp"),
    bQ: require("../../../assets/images/pieces/sea/bQ.webp"),
    bB: require("../../../assets/images/pieces/sea/bB.webp"),
    bN: require("../../../assets/images/pieces/sea/bN.webp"),
    bR: require("../../../assets/images/pieces/sea/bR.webp"),
    bP: require("../../../assets/images/pieces/sea/bP.webp"),
  },
  classic: {
    wK: require("../../../assets/images/pieces/classic/wK.webp"),
    wQ: require("../../../assets/images/pieces/classic/wQ.webp"),
    wB: require("../../../assets/images/pieces/classic/wB.webp"),
    wN: require("../../../assets/images/pieces/classic/wN.webp"),
    wR: require("../../../assets/images/pieces/classic/wR.webp"),
    wP: require("../../../assets/images/pieces/classic/wP.webp"),
    bK: require("../../../assets/images/pieces/classic/bK.webp"),
    bQ: require("../../../assets/images/pieces/classic/bQ.webp"),
    bB: require("../../../assets/images/pieces/classic/bB.webp"),
    bN: require("../../../assets/images/pieces/classic/bN.webp"),
    bR: require("../../../assets/images/pieces/classic/bR.webp"),
    bP: require("../../../assets/images/pieces/classic/bP.webp"),
  },
};

/** A sprite in a box of `width` × `height`: a piece fills a square cell, a ship stretches across its cells. */
export function Sprite({
  name,
  width,
  height,
  palette,
  set,
}: {
  name: string;
  width: number;
  height: number;
  palette: WidgetPalette;
  /** A set to draw in, whatever this phone picked. */
  set?: PieceSet;
}) {
  const preferred = usePieceSet();
  if (name === "notebook.ship" || name === "notebook.sunk") {
    // A ship drawn in ink on graph paper, a sunk one in red.
    const sunk = name === "notebook.sunk";
    const ink = sunk ? palette.danger : palette.ink;
    const inset = Math.max(2, Math.min(width, height) * 0.1);
    return (
      <Svg width={width} height={height}>
        <Rect
          x={inset}
          y={inset}
          width={width - inset * 2}
          height={height - inset * 2}
          rx={3}
          fill={ink}
          fillOpacity={sunk ? 0.14 : 0.12}
          stroke={ink}
          strokeWidth={1.6}
        />
      </Svg>
    );
  }
  const chess = parseChessSprite(name);
  const drawn = chess ? PIECES[set ?? preferred][chess.color + chess.piece] : undefined;
  if (drawn) return <Image source={drawn} style={{ width, height }} contentFit="contain" />;
  return (
    <Svg width={width} height={height} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={6} fill={palette.onSurfaceVariant} />
    </Svg>
  );
}

// Suits on the same 24-unit grid, filled, so they read at any card size and never fall back to an emoji font.
const SUIT_PATH: Record<Suit, string> = {
  h: "M12 20.5C12 20.5 3 14.6 3 8.9 3 6.1 5.1 4 7.7 4c1.8 0 3.4 1 4.3 2.6C12.9 5 14.5 4 16.3 4 18.9 4 21 6.1 21 8.9c0 5.7-9 11.6-9 11.6z",
  d: "M12 2.5Q14.6 8.4 19 12 14.6 15.6 12 21.5 9.4 15.6 5 12 9.4 8.4 12 2.5z",
  s: "M12 2.5C12 2.5 3 9.2 3 14c0 2.6 2 4.5 4.5 4.5 1.6 0 3-.8 3.7-2L10 21.5h4l-1.2-5c.7 1.2 2.1 2 3.7 2 2.5 0 4.5-1.9 4.5-4.5 0-4.8-9-11.5-9-11.5z",
  c: "M11 14.5 10 21.5h4l-1-7z",
};

export function SuitGlyph({ suit, size, color }: { suit: Suit; size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <G fill={color}>
        <Path d={SUIT_PATH[suit]} />
        {suit === "c" ? (
          <>
            <Circle cx={12} cy={7.3} r={4.2} />
            <Circle cx={7.3} cy={13.4} r={4.2} />
            <Circle cx={16.7} cy={13.4} r={4.2} />
            <Circle cx={12} cy={12} r={2.6} />
          </>
        ) : null}
      </G>
    </Svg>
  );
}
