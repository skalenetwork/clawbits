import { useState } from "react";
import { StyleSheet, Text, View, type ViewStyle } from "react-native";
import Animated, { FadeInUp, LayoutAnimationConfig, useReducedMotion } from "react-native-reanimated";
import Svg, { Defs, Path, Pattern, RadialGradient, Rect, Stop } from "react-native-svg";
import { cardLabel, fanMargin, parseCard, TABLE_SPAN, type WidgetCardRow } from "@/lib/widgets";
import { useWidgetPalette, withAlpha, type WidgetPalette } from "./palette";
import { SuitGlyph } from "./sprites";

const PAD = 12;
// A winning card rises and fades back in; reduced motion sets it at once.
const LIFT = { transitionProperty: ["transform" as const, "opacity" as const], transitionDuration: 200 };

/** A card table: rows of cards on felt, from the far side of the table to the viewer's own hand. Cards size to the
 *  table's width, five across with a tenth of a card between, so it fits any phone; a longer row fans. */
export function CardTable({ rows }: { rows: WidgetCardRow[] }) {
  const palette = useWidgetPalette();
  const [width, setWidth] = useState(0);
  const card = Math.min(88, Math.max(0, (width - PAD * 2) / TABLE_SPAN));
  return (
    <View
      onLayout={(event) => {
        const next = Math.floor(event.nativeEvent.layout.width);
        if (next !== width) setWidth(next);
      }}
      style={[s.felt, { backgroundColor: palette.felt, borderColor: palette.feltDark }]}
    >
      {/* Felt is content, not a floating layer: opaque, a soft light from above. */}
      <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
        <Defs>
          <RadialGradient id="felt" cx="50%" cy="35%" rx="65%" ry="60%">
            <Stop offset="0" stopColor={palette.feltLight} />
            <Stop offset="0.55" stopColor={palette.felt} />
            <Stop offset="1" stopColor={palette.feltDark} />
          </RadialGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#felt)" />
      </Svg>
      {/* Cards deal in when dealt, not each time the table mounts, such as scrolling back into view: the config
          mounts with the first rows, once the width is known. */}
      {card > 0 ? (
        <LayoutAnimationConfig skipEntering>
          {rows.map((row, i) => (
            <CardRow
              key={row.id}
              row={row}
              edge={i === 0 ? "top" : i === rows.length - 1 ? "bottom" : "middle"}
              card={card}
              palette={palette}
            />
          ))}
        </LayoutAnimationConfig>
      ) : null}
    </View>
  );
}

function CardRow({
  row,
  edge,
  card,
  palette,
}: {
  row: WidgetCardRow;
  edge: "top" | "middle" | "bottom";
  card: number;
  palette: WidgetPalette;
}) {
  const lift = row.lift ? new Set(row.lift) : null;
  const fan = fanMargin(row.cards.length);
  const shown = row.cards.filter((code) => code != null);
  // One stop for VoiceOver per row: whose, which cards, and its note.
  const label = [
    row.label,
    shown.length ? shown.map(cardLabel).join(", ") : "no cards yet",
    row.note,
    row.active && "in play",
  ]
    .filter(Boolean)
    .join(". ");
  return (
    <View
      accessible
      accessibilityLabel={label}
      // A row's note faces the middle of the table, where bets and the pot sit.
      style={[s.row, { flexDirection: edge === "bottom" ? "column-reverse" : "column" }]}
    >
      <View style={[s.cards, { gap: fan == null ? card * 0.1 : 0 }]}>
        {row.cards.map((code, i) => (
          // Keyed by place and card, so a card dealt or turned over is a new one and deals in.
          <PlayingCard
            key={`${i}:${code ?? ""}`}
            code={code}
            card={card}
            lifted={lift?.has(i) ?? false}
            dimmed={lift != null && !lift.has(i)}
            style={i > 0 && fan != null ? { marginLeft: card * fan } : undefined}
            palette={palette}
          />
        ))}
      </View>
      {/* Always laid out, so a bet coming and going never moves the cards. */}
      <View
        style={[
          s.note,
          { backgroundColor: row.active ? palette.highlight : withAlpha(palette.onFelt, 0.15) },
          !row.note && s.hidden,
        ]}
      >
        <Text style={[s.noteText, { color: row.active ? palette.pieceLightEdge : palette.onFelt }]}>
          {row.note ?? " "}
        </Text>
      </View>
    </View>
  );
}

/** One card: face up, face down (`back`), or an empty place (null). */
function PlayingCard({
  code,
  card,
  lifted,
  dimmed,
  style,
  palette,
}: {
  code: string | null;
  card: number;
  lifted: boolean;
  dimmed: boolean;
  style?: ViewStyle;
  palette: WidgetPalette;
}) {
  const still = useReducedMotion();
  const height = card * 1.4;
  const radius = card * 0.1;
  const size = { width: card, height, borderRadius: radius };
  if (code == null) {
    return (
      <View
        style={[
          size,
          s.slot,
          { borderColor: withAlpha(palette.onFelt, 0.3), backgroundColor: withAlpha(palette.onFelt, 0.06) },
          style,
        ]}
      />
    );
  }
  const face = parseCard(code);
  const ink = face && (face.suit === "h" || face.suit === "d") ? palette.suitRed : palette.suitBlack;
  return (
    <Animated.View
      entering={still ? undefined : FadeInUp.duration(260)}
      style={[
        size,
        s.shadow,
        { shadowColor: palette.shadow, backgroundColor: palette.cardFace },
        lifted && { transform: [{ translateY: -height * 0.08 }] },
        dimmed && { opacity: 0.55 },
        still ? null : LIFT,
        style,
      ]}
    >
      <View style={[StyleSheet.absoluteFill, s.clip, { borderRadius: radius }]}>
        {face ? (
          <>
            <View style={{ position: "absolute", top: height * 0.06, left: card * 0.09, alignItems: "center" }}>
              <Text style={{ fontSize: card * 0.28, lineHeight: card * 0.32, fontWeight: "600", color: ink }}>
                {face.rank}
              </Text>
              <SuitGlyph suit={face.suit} size={card * 0.2} color={ink} />
            </View>
            <View style={{ position: "absolute", right: card * 0.09, bottom: height * 0.07 }}>
              <SuitGlyph suit={face.suit} size={card * 0.46} color={ink} />
            </View>
          </>
        ) : (
          <CardBack border={card * 0.07} radius={radius} palette={palette} />
        )}
      </View>
      {lifted ? <View style={[s.ring, { borderRadius: radius + 2, borderColor: palette.highlight }]} /> : null}
    </Animated.View>
  );
}

/** A back: a cream border round a cross-hatched field, as on a real deck. */
function CardBack({ border, radius, palette }: { border: number; radius: number; palette: WidgetPalette }) {
  return (
    <View
      style={[
        StyleSheet.absoluteFill,
        { borderWidth: border, borderColor: palette.cardFace, borderRadius: radius, overflow: "hidden" },
      ]}
    >
      <Svg width="100%" height="100%">
        <Defs>
          <Pattern id="hatch" width={5} height={5} patternUnits="userSpaceOnUse">
            <Path d="M0 5 5 0M-1 1 1-1M4 6 6 4M0 0 5 5M-1 4 1 6M4-1 6 1" stroke={palette.cardBackLine} strokeWidth={1} />
          </Pattern>
        </Defs>
        <Rect width="100%" height="100%" fill={palette.cardBack} />
        <Rect width="100%" height="100%" fill="url(#hatch)" />
      </Svg>
    </View>
  );
}

const s = StyleSheet.create({
  felt: {
    gap: 8,
    paddingHorizontal: PAD,
    paddingVertical: 14,
    borderRadius: 10,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  row: { alignItems: "center", gap: 6 },
  cards: { flexDirection: "row", justifyContent: "center" },
  slot: { borderWidth: 1.5, borderStyle: "dashed" },
  shadow: { shadowOpacity: 0.3, shadowRadius: 3, shadowOffset: { width: 0, height: 1.5 } },
  clip: { overflow: "hidden" },
  ring: { position: "absolute", top: -2, left: -2, right: -2, bottom: -2, borderWidth: 2 },
  note: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 2 },
  noteText: { fontSize: 12, lineHeight: 16, fontWeight: "500", fontVariant: ["tabular-nums"] },
  hidden: { opacity: 0 },
});
