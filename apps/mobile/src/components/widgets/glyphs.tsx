import { SymbolView, type SFSymbol } from "expo-symbols";
import { Text } from "react-native";
import Svg, { Path } from "react-native-svg";
import type { WidgetEnd } from "@/lib/widgets";

// Drawn where SF Symbols has nothing that fits, so both apps show the same shape: Lucide's paths (ISC), stroked as
// Lucide strokes them.
const DRAWN = {
  // A four-leaf clover: all in on luck.
  clover: [
    "M16.17 7.83 2 22",
    "M4.02 12a2.827 2.827 0 1 1 3.81-4.17A2.827 2.827 0 1 1 12 4.02a2.827 2.827 0 1 1 4.17 3.81A2.827 2.827 0 1 1 19.98 12a2.827 2.827 0 1 1-3.81 4.17A2.827 2.827 0 1 1 12 19.98a2.827 2.827 0 1 1-4.17-3.81A1 1 0 1 1 4 12",
    "m7.83 7.83 8.34 8.34",
  ],
  // A broken heart: a loss, with a glyph of its own.
  "heart-crack": [
    "M12.409 5.824c-.702.792-1.15 1.496-1.415 2.166l2.153 2.156a.5.5 0 0 1 0 .707l-2.293 2.293a.5.5 0 0 0 0 .707L12 15",
    "M13.508 20.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5a5.5 5.5 0 0 1 9.591-3.677.6.6 0 0 0 .818.001A5.5 5.5 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5z",
  ],
} as const;
type Drawn = keyof typeof DRAWN;
type Glyph = SFSymbol | Drawn;

const isDrawn = (name: Glyph): name is Drawn => name in DRAWN;

/** A symbol by name, or one of the few drawn ones. */
function GlyphView({ name, size, color }: { name: Glyph; size: number; color: string }) {
  if (!isDrawn(name)) return <SymbolView name={name} size={size} weight="semibold" tintColor={color} />;
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2.25}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {DRAWN[name].map((d) => (
        <Path key={d} d={d} />
      ))}
    </Svg>
  );
}

const KIND: Record<string, SFSymbol> = {
  chess: "crown.fill",
  battleship: "ferry.fill",
  poker: "suit.spade.fill",
  blackjack: "suit.club.fill",
};

// The symbol beside an action's label, for the action types kinds share; others go without one.
const ACTION: Record<string, Glyph> = {
  offer_draw: "equal.circle",
  accept_draw: "equal.circle",
  resign: "flag.fill",
  decline_draw: "xmark",
  abort: "xmark",
  fold: "xmark",
  shuffle: "shuffle",
  ready: "checkmark",
  check: "checkmark",
  call: "equal",
  bet: "circle.circle.fill",
  raise: "arrow.up",
  allin: "clover",
  deal: "rectangle.stack.fill",
  hit: "plus",
  stand: "hand.raised.fill",
  double: "2.circle",
  split: "rectangle.split.2x1",
};

/** The symbol that names a widget kind wherever it shows; a kind this app doesn't know gets a generic one. */
export function KindGlyph({ kind, size, color }: { kind: string; size: number; color: string }) {
  return <SymbolView name={KIND[kind] ?? "gamecontroller.fill"} size={size} tintColor={color} />;
}

export function ActionGlyph({ type, size, color }: { type: string; size: number; color: string }) {
  const name = ACTION[type];
  return name ? <GlyphView name={name} size={size} color={color} /> : null;
}

/** What an action's button shows: its symbol and the number its label carries (what a call costs, a bet's size),
 *  or, for an action no symbol names, its label in words. The full label is the button's accessibility name. */
export function ActionFace({ type, label, color, bare = false }: { type: string; label: string; color: string; bare?: boolean }) {
  const name = ACTION[type];
  if (!name) return <Text style={{ fontSize: 15, lineHeight: 20, fontWeight: "500", color }}>{label}</Text>;
  const number = bare ? undefined : /\d[\d,]*/.exec(label)?.[0];
  return (
    <>
      <GlyphView name={name} size={16} color={color} />
      {number ? (
        <Text style={{ fontSize: 15, lineHeight: 20, fontWeight: "600", color, fontVariant: ["tabular-nums"] }}>{number}</Text>
      ) : null}
    </>
  );
}

const END: Record<WidgetEnd, Glyph> = {
  won: "trophy.fill",
  lost: "heart-crack",
  draw: "equal.circle",
  ended: "nosign",
  finished: "trophy.fill",
};

/** How a widget ended, the same few symbols for every kind: a cup for a win, a broken heart of its own for a loss. */
export function EndGlyph({ end, size, color }: { end: WidgetEnd; size: number; color: string }) {
  return <GlyphView name={END[end]} size={size} color={color} />;
}
