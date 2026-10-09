import { GlassView } from "expo-glass-effect";
import { SymbolView } from "expo-symbols";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";
import Svg, { Defs, Line, Path, RadialGradient, Rect, Stop } from "react-native-svg";
import {
  boardCells,
  displayOf,
  spriteLabel,
  type WidgetAction,
  type WidgetBoard,
  type WidgetScene,
  type WidgetSceneInput,
  type WidgetSceneToken,
} from "@/lib/widgets";
import { useWidgetPalette, withAlpha, type WidgetPalette } from "./palette";
import { Sprite } from "./sprites";

type Pending = { from: string; to: string } | { at: string };
/** Where in a token the viewer took hold, in cells from its first: a ship moves by the cell you hold. */
type Grab = [number, number];

// Coordinates sit outside the board, on the card, where small type keeps its contrast in both appearances.
const GUTTER = 16;
// A moved piece slides to its square; reduced motion places it at once.
const SLIDE = { transitionProperty: "transform", transitionDuration: 200 } as const;

/** One board of a scene, and the viewer's taps on it turned into actions. Knows no rules: what may move where comes
 *  from `input`. A pick is two taps, the piece and then its square; a tap fires at once. A move shows straight
 *  away, and the next scene confirms or undoes it. */
export function BoardView({
  board,
  scene,
  input,
  flip,
  busy,
  onAct,
}: {
  board: WidgetBoard;
  /** The scene the board belongs to: a new one resets what was picked or pending. */
  scene: WidgetScene;
  input: WidgetSceneInput | undefined;
  flip: boolean;
  busy: boolean;
  onAct: (action: WidgetAction) => void;
}) {
  const palette = useWidgetPalette();
  const still = useReducedMotion();
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [grab, setGrab] = useState<Grab>([0, 0]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [choosing, setChoosing] = useState<{ from: string; to: string } | null>(null);
  // A ship just turned, by its token's id: once the board settles it stays held, to turn again or move.
  const [follow, setFollow] = useState<string | null>(null);
  const [shown, setShown] = useState(scene);
  const [wasBusy, setWasBusy] = useState(busy);
  if (shown !== scene) {
    // A new scene answers whatever was in flight, so the local guesses go.
    setShown(scene);
    setSelected(null);
    setPending(null);
    setChoosing(null);
  }
  if (wasBusy !== busy) {
    setWasBusy(busy);
    if (!busy) setPending(null);
  }

  const notebook = board.style === "notebook";
  const labels = Boolean(board.show_labels);
  const fromTop = board.origin === "top";
  const cols = board.cols.length;
  const rows = board.rows.length;
  const side = Math.max(0, width - (labels ? GUTTER : 0));
  const cell = cols ? side / cols : 0;
  const cells = boardCells(board, flip);
  const place = new Map(cells.map((c) => [c.name, c]));
  /** The display box a token covers, in points. */
  const box = (at: string, span: [number, number] = [1, 1]) => {
    const start = place.get(at);
    if (!start) return null;
    const a = displayOf(board, flip, start.x, start.y);
    const b = displayOf(board, flip, start.x + span[0] - 1, start.y + span[1] - 1);
    return {
      left: Math.min(a.dx, b.dx) * cell,
      top: Math.min(a.dy, b.dy) * cell,
      width: span[0] * cell,
      height: span[1] * cell,
    };
  };

  const tokens = board.tokens ?? [];
  // Every cell a token covers, so a ship reads as a ship along its whole length.
  const occupant = new Map<string, WidgetSceneToken>();
  for (const token of tokens) {
    const start = place.get(token.at);
    const [w, h] = token.span ?? [1, 1];
    for (let i = 0; start && i < w; i++)
      for (let j = 0; j < h; j++)
        occupant.set(`${board.cols[start.x + i] ?? ""}${board.rows[start.y + j] ?? ""}`, token);
  }
  const underlays = new Map<string, string[]>();
  const pencil: { at: string; tone: string }[] = [];
  for (const mark of board.marks ?? []) {
    if (mark.tone === "last" || mark.tone === "danger")
      underlays.set(mark.at, [...(underlays.get(mark.at) ?? []), mark.tone]);
    else pencil.push(mark);
  }

  /** The cell `dx`, `dy` cells on from `name`, if that is on the board. */
  const shift = (name: string, [dx, dy]: Grab) => {
    const c = place.get(name);
    if (!c) return null;
    const x = c.x + dx;
    const y = c.y + dy;
    return x >= 0 && y >= 0 && x < cols && y < rows ? `${board.cols[x] ?? ""}${board.rows[y] ?? ""}` : null;
  };
  /** What a tap on `name` takes hold of: the piece there, or the token covering it, held where tapped. */
  const sourceOf = (name: string): { from: string; grab: Grab } | null => {
    if (!input?.pick) return null;
    if (input.pick[name]) return { from: name, grab: [0, 0] };
    const token = occupant.get(name);
    const start = token ? place.get(token.at) : undefined;
    const here = place.get(name);
    return token && start && here && input.pick[token.at] ? { from: token.at, grab: [here.x - start.x, here.y - start.y] } : null;
  };

  const canAct = input != null && !busy && pending == null && choosing == null;
  const taps = canAct ? new Set(input.tap ?? []) : new Set<string>();
  // Where the held token may go, by its first cell; a place that is its own first cell turns it there.
  const picks = canAct && selected ? (input.pick?.[selected] ?? []) : [];
  // Where the held cell may land: each of those places, moved by where the token is held.
  const targets = picks.flatMap((to) => shift(to, grab) ?? []);
  // A held token shows as held along its whole length.
  const isHeld = (name: string) => selected != null && (name === selected || occupant.get(name)?.at === selected);
  if (follow != null && pending == null && !busy) {
    setFollow(null);
    const ship = tokens.find((t) => t.id === follow);
    if (ship && input?.pick?.[ship.at]) {
      setSelected(ship.at);
      setGrab([0, 0]);
    }
  }
  const send = (args: Record<string, unknown>, next: Pending) => {
    if (!input) return;
    setPending(next);
    setSelected(null);
    setChoosing(null);
    onAct({ type: input.action, args });
  };
  const commit = (from: string, to: string) => {
    if (input?.choose?.[from + to]) {
      setSelected(null);
      setChoosing({ from, to });
    } else send({ from, to }, { from, to });
  };
  /** Turns the ship at `from` (the server turns it about its middle where there is room), held still wherever
   *  it lands, so it may turn again. */
  const turn = (from: string) => {
    setFollow(occupant.get(from)?.id ?? null);
    commit(from, from);
  };
  /** Fire at a cell, move the held token so the held cell lands there, take hold of a token, or, on the token
   *  already held, turn it where it may turn or let go. */
  const tap = (name: string) => {
    if (!canAct) return;
    if (taps.has(name)) {
      send({ at: name }, { at: name });
      return;
    }
    const source = sourceOf(name);
    if (selected && source?.from === selected) {
      if (picks.includes(selected)) turn(selected);
      else setSelected(null);
      return;
    }
    const to = selected ? shift(name, [-grab[0], -grab[1]]) : null;
    if (selected && to && picks.includes(to)) commit(selected, to);
    else if (source) {
      setSelected(source.from);
      setGrab(source.grab);
    } else setSelected(null);
  };
  const choices = choosing ? (input?.choose?.[choosing.from + choosing.to] ?? []) : [];
  const ink = notebook ? palette.ink : palette.onSurfaceVariant;

  const order = (list: string[], reversed: boolean) => (reversed ? [...list].reverse() : list);
  const colLabels = (
    <View style={[s.colLabels, { marginLeft: labels ? GUTTER : 0 }]}>
      {order(board.cols, flip).map((col) => (
        <Text key={col} style={[s.label, { width: cell, color: ink }]}>
          {col}
        </Text>
      ))}
    </View>
  );

  return (
    <View
      onLayout={(event) => {
        const next = Math.floor(event.nativeEvent.layout.width);
        if (next !== width) setWidth(next);
      }}
    >
      {board.title ? <Text style={[s.caption, { color: ink }]}>{board.title}</Text> : null}
      {cell > 0 ? (
        <>
          {labels && fromTop ? colLabels : null}
          <View style={s.boardRow}>
            {labels ? (
              <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={{ width: GUTTER }}>
                {order(board.rows, fromTop === flip).map((row) => (
                  <Text key={row} style={[s.label, s.rowLabel, { height: cell, lineHeight: cell, color: ink }]}>
                    {row}
                  </Text>
                ))}
              </View>
            ) : null}
            <View
              style={[s.surface, { width: side, height: cell * rows, backgroundColor: notebook ? palette.paper : undefined }]}
            >
              {notebook ? <GraphPaper cols={cols} rows={rows} cell={cell} color={palette.grid} /> : null}
              {cells.map(({ name, dx, dy, dark }) => {
                const target = targets.includes(name);
                const tappable = taps.has(name);
                const actionable = canAct && (tappable || sourceOf(name) != null || target);
                const token = occupant.get(name);
                const label = [name, token && spriteLabel(token.sprite), (target || tappable) && "available"]
                  .filter(Boolean)
                  .join(", ");
                return (
                  <Pressable
                    key={name}
                    accessibilityRole={actionable ? "button" : undefined}
                    accessibilityLabel={label}
                    accessibilityState={isHeld(name) ? { selected: true } : undefined}
                    onPress={canAct ? () => tap(name) : undefined}
                    style={[
                      s.cell,
                      { left: dx * cell, top: dy * cell, width: cell, height: cell },
                      !notebook && { backgroundColor: dark ? palette.squareDark : palette.squareLight },
                    ]}
                  >
                    {underlays.get(name)?.map((tone) =>
                      tone === "last" ? (
                        <View key={tone} style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha(palette.highlight, 0.55) }]} />
                      ) : (
                        <DangerGlow key={tone} size={cell} color={palette.danger} />
                      ),
                    )}
                    {/* Selection is a ring as well as a tint, so it never rests on colour alone. */}
                    {isHeld(name) ? <SelectRing palette={palette} /> : null}
                    {target ? (
                      occupant.has(name) ? (
                        <View
                          style={[
                            s.captureRing,
                            { borderRadius: cell, borderColor: withAlpha(palette.pieceLightEdge, 0.4) },
                          ]}
                        />
                      ) : (
                        <View
                          style={{
                            width: cell * 0.28,
                            height: cell * 0.28,
                            borderRadius: cell,
                            backgroundColor: withAlpha(palette.pieceLightEdge, 0.4),
                          }}
                        />
                      )
                    ) : null}
                  </Pressable>
                );
              })}

              {tokens.map((token) => {
                let at = token.at;
                if (pending && "from" in pending) {
                  // A token where the move lands is taken, unless it is the one moving (a ship turning in place).
                  if (token.at === pending.to && token.at !== pending.from) return null;
                  if (token.at === pending.from) at = pending.to;
                }
                const rect = box(at, token.span);
                if (!rect) return null;
                const piece = !notebook;
                return (
                  <Animated.View
                    key={token.id}
                    pointerEvents="none"
                    style={[
                      s.token,
                      {
                        width: rect.width,
                        height: rect.height,
                        padding: piece ? rect.width * 0.02 : 0,
                        transform: [{ translateX: rect.left }, { translateY: rect.top }],
                      },
                      piece && [s.pieceShadow, { shadowColor: palette.shadow }],
                      still ? null : SLIDE,
                    ]}
                  >
                    <Sprite
                      name={token.sprite}
                      width={piece ? rect.width * 0.96 : rect.width}
                      height={piece ? rect.height * 0.96 : rect.height}
                      palette={palette}
                    />
                  </Animated.View>
                );
              })}

              {pencil.map(({ at, tone }) => {
                const rect = box(at);
                return rect ? (
                  <View
                    key={`${at}:${tone}`}
                    pointerEvents="none"
                    style={[s.mark, { left: rect.left, top: rect.top, width: cell, height: cell }]}
                  >
                    <PencilMark tone={tone} size={cell} palette={palette} />
                  </View>
                ) : null;
              })}

              {(() => {
                // The held ship's own turn button, at its middle: a ship turns there, about its middle where it
                // has room.
                const ship =
                  canAct && selected
                    ? tokens.find((t) => t.at === selected && (t.span ?? [1, 1]).some((n) => n > 1))
                    : undefined;
                const rect = ship && box(ship.at, ship.span);
                if (!ship || !rect || !selected) return null;
                const canTurn = picks.includes(selected);
                return (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={canTurn ? "Turn the ship" : "No room to turn the ship here"}
                    accessibilityState={{ disabled: !canTurn }}
                    hitSlop={6}
                    onPress={() => {
                      if (canTurn) turn(ship.at);
                    }}
                    style={[
                      s.turn,
                      {
                        left: rect.left + rect.width / 2 - TURN / 2,
                        top: rect.top + rect.height / 2 - TURN / 2,
                        backgroundColor: palette.primary,
                        shadowColor: palette.shadow,
                      },
                      !canTurn && { opacity: 0.45 },
                    ]}
                  >
                    <SymbolView name="arrow.clockwise" size={15} weight="semibold" tintColor={palette.onPrimary} />
                  </Pressable>
                );
              })()}

              {pending && "at" in pending
                ? (() => {
                    const rect = box(pending.at);
                    return rect ? (
                      <View
                        pointerEvents="none"
                        style={[s.mark, { left: rect.left, top: rect.top, width: cell, height: cell }]}
                      >
                        <View style={{ width: cell * 0.3, height: cell * 0.3, borderRadius: cell, backgroundColor: palette.ink }} />
                      </View>
                    ) : null;
                  })()
                : null}

              {choosing && choices.length > 0 ? (
                <View style={[s.chooserScrim, { backgroundColor: withAlpha(palette.surface, 0.4) }]}>
                  {/* A floating menu over the board: glass, on a tint that keeps it legible. */}
                  <View style={[s.chooser, { backgroundColor: withAlpha(palette.surface, 0.72) }]}>
                    <GlassView glassEffectStyle="regular" style={StyleSheet.absoluteFill} />
                    {choices.map((choice) => (
                      <Pressable
                        key={choice.value}
                        accessibilityRole="button"
                        accessibilityLabel={spriteLabel(choice.sprite)}
                        onPress={() => send({ ...choosing, choice: choice.value }, choosing)}
                        style={({ pressed }) => [s.choice, pressed && { backgroundColor: withAlpha(palette.onSurface, 0.08) }]}
                      >
                        <Sprite name={choice.sprite} width={36} height={36} palette={palette} />
                      </Pressable>
                    ))}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Cancel"
                      onPress={() => setChoosing(null)}
                      style={({ pressed }) => [s.choice, pressed && { backgroundColor: withAlpha(palette.onSurface, 0.08) }]}
                    >
                      <SymbolView name="xmark" size={15} weight="semibold" tintColor={palette.onSurfaceVariant} />
                    </Pressable>
                  </View>
                </View>
              ) : null}
            </View>
          </View>
          {labels && !fromTop ? colLabels : null}
        </>
      ) : null}
    </View>
  );
}

/** Graph paper: the lines drawn once, so cells and ships share one exact grid. */
function GraphPaper({ cols, rows, cell, color }: { cols: number; rows: number; cell: number; color: string }) {
  return (
    <Svg width={cols * cell} height={rows * cell} style={StyleSheet.absoluteFill} pointerEvents="none">
      {Array.from({ length: cols + 1 }, (_, i) => (
        <Line key={`x${i}`} x1={i * cell} y1={0} x2={i * cell} y2={rows * cell} stroke={color} strokeWidth={1} />
      ))}
      {Array.from({ length: rows + 1 }, (_, j) => (
        <Line key={`y${j}`} x1={0} y1={j * cell} x2={cols * cell} y2={j * cell} stroke={color} strokeWidth={1} />
      ))}
    </Svg>
  );
}

/** A king in check: a red glow under the piece. */
function DangerGlow({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} style={StyleSheet.absoluteFill} pointerEvents="none">
      <Defs>
        <RadialGradient id="check" cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={color} stopOpacity={0.9} />
          <Stop offset="0.55" stopColor={color} stopOpacity={0.35} />
          <Stop offset="1" stopColor={color} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect width={size} height={size} fill="url(#check)" />
    </Svg>
  );
}

/** Two tones, so the ring reads on cream, walnut and paper alike. */
function SelectRing({ palette }: { palette: WidgetPalette }) {
  return (
    <View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: withAlpha(palette.primary, 0.35), borderWidth: 2, borderColor: palette.pieceLightEdge },
      ]}
    >
      <View style={[StyleSheet.absoluteFill, { borderWidth: 2, borderColor: palette.pieceLight }]} />
    </View>
  );
}

/** A pencil mark over a cell: a cross for a hit, a dot for a miss, a fainter dot where a miss is certain. */
function PencilMark({ tone, size, palette }: { tone: string; size: number; palette: WidgetPalette }) {
  if (tone === "hit") {
    return (
      <Svg width={size * 0.68} height={size * 0.68} viewBox="0 0 10 10">
        <Path d="M1.5 1.5 8.5 8.5M8.5 1.5 1.5 8.5" stroke={palette.danger} strokeWidth={1.7} strokeLinecap="round" fill="none" />
      </Svg>
    );
  }
  return (
    <View
      style={{
        width: size * 0.2,
        height: size * 0.2,
        borderRadius: size,
        backgroundColor: palette.ink,
        opacity: tone === "near" ? 0.45 : 1,
      }}
    />
  );
}

const TURN = 32;
const s = StyleSheet.create({
  turn: {
    position: "absolute",
    width: TURN,
    height: TURN,
    borderRadius: TURN / 2,
    alignItems: "center",
    justifyContent: "center",
    shadowOpacity: 0.3,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
  },
  caption: { fontSize: 15, lineHeight: 20, fontWeight: "500", paddingBottom: 6, paddingHorizontal: 2 },
  boardRow: { flexDirection: "row" },
  surface: { borderRadius: 10, borderCurve: "continuous", overflow: "hidden" },
  cell: { position: "absolute", alignItems: "center", justifyContent: "center" },
  token: { position: "absolute", left: 0, top: 0 },
  pieceShadow: { shadowOpacity: 0.3, shadowRadius: 1.5, shadowOffset: { width: 0, height: 1 } },
  mark: { position: "absolute", alignItems: "center", justifyContent: "center" },
  captureRing: { position: "absolute", top: "4%", left: "4%", right: "4%", bottom: "4%", borderWidth: 3 },
  label: { fontSize: 11, fontWeight: "500", textAlign: "center", fontVariant: ["tabular-nums"] },
  rowLabel: { textAlign: "left" },
  colLabels: { flexDirection: "row", paddingVertical: 4 },
  chooserScrim: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
  chooser: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    padding: 6,
    borderRadius: 16,
    borderCurve: "continuous",
    overflow: "hidden",
  },
  choice: { width: 44, height: 44, borderRadius: 10, alignItems: "center", justifyContent: "center" },
});
