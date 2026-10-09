import { SymbolView, type SFSymbol } from "expo-symbols";
import { useMemo, useState } from "react";
import { Alert, PanResponder, Pressable, StyleSheet, Text, View } from "react-native";
import { useWidgetAction } from "@/lib/data";
import {
  actionKey,
  boardsBySeat,
  drawsChessPieces,
  logLine,
  notesOf,
  resultOf,
  seatOf,
  snapAmount,
  type Widget,
  type WidgetSceneAction,
  type WidgetSceneAmount,
  type WidgetEnd,
  type WidgetSeat,
} from "@/lib/widgets";
import { ActionFace, EndGlyph } from "./glyphs";
import { useWidgetPalette, withAlpha, type WidgetPalette } from "./palette";
import { setPieceSet, usePieceSet, type PieceSet } from "./piece-set";
import { SceneView } from "./scene-view";
import { Sprite } from "./sprites";

type Tone = "tonal" | "primary" | "danger";

/** A widget with its players, status, recent log and the viewer's actions around the board, stacked for a phone:
 *  the opponent above the board and the viewer below it, as on a board turned towards them. */
export function WidgetPanel({ widget, userId }: { widget: Widget; userId: number }) {
  const palette = useWidgetPalette();
  const act = useWidgetAction();
  const { scene } = widget;
  const mySeat = seatOf(widget, userId);
  const bottom = widget.seats.find((seat) => seat.seat === mySeat) ?? widget.seats[0];
  const top = widget.seats.find((seat) => seat !== bottom);
  const actions = (mySeat && scene.actions?.[mySeat]) || [];
  const result = resultOf(widget, mySeat);
  const chessPieces = drawsChessPieces(scene);
  const log = logLine(notesOf(scene));
  const bySeat = boardsBySeat(scene);
  // The game's notes (its moves, its hands) wait behind a button.
  const [notes, setNotes] = useState(false);
  const send = (type: string, args?: Record<string, unknown>) => {
    act.mutate({ widget, action: args ? { type, args } : { type } });
  };
  /** An action that asks first (resign, all-in) does so in the system's own alert. */
  const run = (action: WidgetSceneAction, args = action.args) => {
    if (!action.confirm) {
      send(action.type, args);
      return;
    }
    Alert.alert(action.confirm, undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: action.label,
        style: action.tone === "danger" ? "destructive" : "default",
        onPress: () => send(action.type, args),
      },
    ]);
  };
  const statusColor =
    scene.status?.tone === "danger"
      ? palette.danger
      : scene.status?.tone === "muted"
        ? palette.onSurfaceVariant
        : palette.onSurface;

  const view = (
    <SceneView
      scene={scene}
      seat={mySeat}
      busy={act.isPending}
      onAct={(action) => {
        act.mutate({ widget, action });
      }}
    />
  );
  // The game's latest notes: while open they take the middle.
  const history = notes && log ? <Text style={[s.log, { color: palette.onSurfaceVariant }]}>{log}</Text> : null;
  // What the viewer may do, grouped while there is anything; an amount's slider takes the whole width there is.
  const moves =
    actions.length > 0 ? (
      <View
        accessibilityLabel="Your moves"
        style={[
          s.moves,
          { backgroundColor: withAlpha(palette.onSurface, 0.05) },
          actions.some((action) => action.amount) && s.movesWide,
        ]}
      >
        {actions.map((action) =>
          action.amount ? (
            // Keyed by rev too, so each new scene starts the pick from the server's suggestion.
            <AmountControl
              key={`${actionKey(action)}:${widget.rev}`}
              action={action}
              amount={action.amount}
              busy={act.isPending}
              palette={palette}
              onRun={(args) => run(action, args)}
            />
          ) : action.disabled ? (
            // A state, not a control: no button that can't be pressed.
            <View
              key={actionKey(action)}
              accessible
              accessibilityLabel={action.label}
              style={[s.capsule, s.state, { borderColor: palette.outline }]}
            >
              <ActionFace type={action.type} label={action.label} color={palette.onSurfaceVariant} />
            </View>
          ) : (
            <Capsule
              key={actionKey(action)}
              type={action.type}
              label={action.label}
              tone={action.tone ?? "tonal"}
              disabled={act.isPending}
              palette={palette}
              onPress={() => run(action)}
            />
          ),
        )}
      </View>
    ) : null;
  const ending = result ? (
    <Result end={result.end} headline={result.headline} reason={scene.status?.text} palette={palette} />
  ) : null;
  // The notes' switch and the piece set: kept apart from the moves, and in reach while the notes are open.
  const tools =
    log || chessPieces ? (
      <View style={s.tools}>
        {log ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Game notes"
            accessibilityState={{ expanded: notes }}
            hitSlop={4}
            onPress={() => setNotes(!notes)}
            style={[s.end, notes ? { backgroundColor: palette.surfaceHigh } : null]}
          >
            <SymbolView name="list.bullet.rectangle" size={17} tintColor={palette.onSurfaceVariant} />
          </Pressable>
        ) : null}
        {chessPieces ? <PieceSetSwitch palette={palette} /> : null}
      </View>
    ) : null;

  return (
    <View style={[s.card, { backgroundColor: palette.surface }]}>
      {bySeat ? (
        // A board each (a fleet each), then one row: the viewer at the left, the other player at the right, and the
        // middle between them. The ringed avatar and the marks say what the status does; VoiceOver hears it on the
        // viewer's avatar.
        <>
          {view}
          <View style={s.row}>
            {bottom ? (
              <SeatBadge
                seat={bottom}
                widget={widget}
                userId={userId}
                palette={palette}
                status={result ? undefined : scene.status?.text}
              />
            ) : null}
            <View style={s.between}>
              {history ?? ending ?? moves}
              {tools}
            </View>
            {top ? <SeatBadge seat={top} widget={widget} userId={userId} palette={palette} mirrored /> : null}
          </View>
        </>
      ) : (
        <>
          <SeatLine seat={top} widget={widget} userId={userId} palette={palette} />
          {view}
          {/* The middle, between the players: the moves under the status, the notes while open, or how it ended. */}
          <View style={s.middle}>
            {history ??
              ending ?? (
                <>
                  {scene.status ? (
                    <Text
                      style={[
                        s.status,
                        { color: statusColor },
                        (scene.status.tone === "info" || scene.status.tone === "danger") && s.strong,
                      ]}
                    >
                      {scene.status.text}
                    </Text>
                  ) : null}
                  {moves}
                </>
              )}
          </View>
          {tools ? <View style={s.toolsRow}>{tools}</View> : null}
          <SeatLine seat={bottom} widget={widget} userId={userId} palette={palette} />
        </>
      )}
    </View>
  );
}

const PIECE_SETS: { set: PieceSet; label: string }[] = [
  { set: "sea", label: "Sea pieces" },
  { set: "classic", label: "Classic pieces" },
];

/** This phone's piece set, switched from the game itself; each option shows its own knight. */
function PieceSetSwitch({ palette }: { palette: WidgetPalette }) {
  const current = usePieceSet();
  return (
    <View accessibilityLabel="Chess pieces" style={[s.switch, { backgroundColor: palette.surfaceHigh }]}>
      {PIECE_SETS.map(({ set, label }) => (
        <Pressable
          key={set}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ selected: current === set }}
          hitSlop={4}
          onPress={() => setPieceSet(set)}
          style={[s.switchOption, current === set ? { backgroundColor: palette.surface } : { opacity: 0.6 }]}
        >
          <Sprite name="chess.wN" set={set} width={22} height={22} palette={palette} />
        </Pressable>
      ))}
    </View>
  );
}

/** A seat's initial in a circle of its own tone, ringed while the seat is to move; large beneath a board, where it
 *  stands alone. Each player wears their seat's tone, ivory or ebony as the chess sides, which no action wears, so a
 *  person never reads as a button. */
function SeatAvatar({
  name,
  seat,
  toAct,
  large = false,
  palette,
}: {
  name: string;
  /** The seat's place in the widget's order, which picks its tone. */
  seat: number;
  toAct: boolean;
  large?: boolean;
  palette: WidgetPalette;
}) {
  const [fill, ink, edge] =
    Math.max(0, seat) % 2 === 0
      ? [palette.seat1, palette.onSeat1, palette.seat1Edge]
      : [palette.seat2, palette.onSeat2, palette.seat2Edge];
  return (
    <View
      style={[
        large ? s.badge : s.initial,
        { backgroundColor: fill, borderWidth: 1, borderColor: edge },
        // An outline, so the ring takes no room and nothing shifts when the turn passes.
        toAct && { outlineWidth: 2, outlineOffset: 2, outlineColor: palette.primary },
      ]}
    >
      <Text style={[large ? s.badgeText : s.initialText, { color: ink }]}>{name.charAt(0).toUpperCase()}</Text>
    </View>
  );
}

/** A seat as its avatar alone, at its end of the row beneath the boards. VoiceOver hears its name and, on the
 *  viewer's, the status the screen leaves out. */
function SeatBadge({
  seat,
  widget,
  userId,
  palette,
  status,
  mirrored = false,
}: {
  seat: WidgetSeat;
  widget: Widget;
  userId: number;
  palette: WidgetPalette;
  status?: string;
  /** At the right end: the name on the avatar's left, facing the middle. */
  mirrored?: boolean;
}) {
  const name = seat.display_name ?? "Player";
  const you = seat.human_id != null && seat.human_id === userId;
  const toAct = widget.status === "active" && widget.turn === seat.seat;
  return (
    <View
      accessible
      accessibilityLabel={[name, you && "you", toAct && "to move", status].filter(Boolean).join(", ")}
      style={[s.badgeRow, mirrored && { flexDirection: "row-reverse" }]}
    >
      <SeatAvatar
        name={name}
        seat={widget.seats.findIndex((item) => item.seat === seat.seat)}
        toAct={toAct}
        large
        palette={palette}
      />
      <Text numberOfLines={1} style={[s.seatName, { color: palette.onSurface }]}>
        {name}
        {you ? <Text style={{ fontWeight: "400", color: palette.onSurfaceVariant }}> (you)</Text> : null}
      </Text>
    </View>
  );
}

function SeatLine({
  seat,
  widget,
  userId,
  palette,
}: {
  seat: WidgetSeat | undefined;
  widget: Widget;
  userId: number;
  palette: WidgetPalette;
}) {
  if (!seat) return null;
  const name = seat.display_name ?? "Player";
  const you = seat.human_id != null && seat.human_id === userId;
  const toAct = widget.status === "active" && widget.turn === seat.seat;
  // A kind may say more about a seat than its name, e.g. its chips; that line takes the name's place.
  const note = widget.scene.seat_notes?.[seat.seat] ?? seat.seat.charAt(0).toUpperCase() + seat.seat.slice(1);
  return (
    <View
      accessible
      accessibilityLabel={[name, you && "you", note, toAct && "to move"].filter(Boolean).join(", ")}
      style={s.seat}
    >
      {/* The seat to move is ringed; the status line says it in words, the label for VoiceOver. */}
      <SeatAvatar
        name={name}
        seat={widget.seats.findIndex((item) => item.seat === seat.seat)}
        toAct={toAct}
        palette={palette}
      />
      <Text numberOfLines={1} style={[s.seatName, { color: palette.onSurface }]}>
        {name}
        {you ? <Text style={{ fontWeight: "400", color: palette.onSurfaceVariant }}> (you)</Text> : null}
      </Text>
      <Text numberOfLines={1} style={[s.seatNote, { color: palette.onSurfaceVariant }]}>
        {note}
      </Text>
    </View>
  );
}

/** How the game ended, one line between the players: a cup and `You won` (or the winner, for a spectator), a broken
 *  heart and `You lost`, a draw, an early end (the same few symbols for every kind). VoiceOver hears why, too. */
function Result({
  end,
  headline,
  reason,
  palette,
}: {
  end: WidgetEnd;
  headline: string;
  reason?: string;
  palette: WidgetPalette;
}) {
  const won = end === "won" || end === "finished";
  const ink = won ? palette.onPrimaryContainer : palette.onSurfaceVariant;
  return (
    <View
      accessible
      accessibilityLabel={reason ? `${headline}, ${reason}` : headline}
      style={[s.result, { backgroundColor: won ? palette.primaryContainer : palette.surfaceHigh }]}
    >
      <EndGlyph end={end} size={16} color={won ? palette.primary : ink} />
      <Text style={[s.resultText, { color: ink }]}>{headline}</Text>
    </View>
  );
}

/** An action as an icon: round with its symbol alone, a pill when a number rides along. Its label is its name. */
function Capsule({
  type,
  label,
  tone,
  disabled,
  palette,
  onPress,
  bare = false,
}: {
  type: string;
  label: string;
  tone: Tone;
  disabled: boolean;
  palette: WidgetPalette;
  onPress: () => void;
  /** The symbol without its number, where the number shows beside it already. */
  bare?: boolean;
}) {
  const [background, ink] = {
    tonal: [palette.surfaceHigh, palette.onSurface],
    primary: [palette.primary, palette.onPrimary],
    danger: [palette.dangerContainer, palette.onDangerContainer],
  }[tone];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        s.capsule,
        { backgroundColor: background },
        pressed && s.pressed,
        disabled && { opacity: 0.5 },
      ]}
    >
      <ActionFace type={type} label={label} color={ink} bare={bare} />
    </Pressable>
  );
}

/** An action that takes a number first, a raise or a bet: quick picks, the number between a step either side and the
 *  button that sends it, and a slider beneath. */
function AmountControl({
  action,
  amount,
  busy,
  palette,
  onRun,
}: {
  action: WidgetSceneAction;
  amount: WidgetSceneAmount;
  busy: boolean;
  palette: WidgetPalette;
  onRun: (args: Record<string, unknown>) => void;
}) {
  const [value, setValue] = useState(() => snapAmount(amount, amount.value));
  return (
    <View style={s.amount}>
      {amount.presets?.length ? (
        <View style={s.presets}>
          {amount.presets.map((preset) => {
            const on = value === snapAmount(amount, preset.value);
            return (
              <Pressable
                key={preset.label}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => setValue(snapAmount(amount, preset.value))}
                style={[s.preset, on && { backgroundColor: palette.primaryContainer }]}
              >
                <Text style={[s.presetText, { color: on ? palette.onPrimaryContainer : palette.onSurfaceVariant }]}>
                  {preset.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      <View style={s.sliderRow}>
        <Step
          symbol="minus"
          label={`Less, by ${amount.step}`}
          disabled={value <= amount.min}
          palette={palette}
          onPress={() => setValue(snapAmount(amount, value - amount.step))}
        />
        <Text style={[s.value, { color: palette.onSurface }]}>{value}</Text>
        <Step
          symbol="plus"
          label={`More, by ${amount.step}`}
          disabled={value >= amount.max}
          palette={palette}
          onPress={() => setValue(snapAmount(amount, value + amount.step))}
        />
        <Capsule
          type={action.type}
          label={`${action.label} ${value}`}
          tone={action.tone ?? "tonal"}
          disabled={busy}
          palette={palette}
          bare
          onPress={() => onRun({ ...action.args, [amount.arg]: value })}
        />
      </View>
      <Slider amount={amount} value={value} label={action.label} palette={palette} onChange={setValue} />
    </View>
  );
}

function Step({
  symbol,
  label,
  disabled,
  palette,
  onPress,
}: {
  symbol: SFSymbol;
  label: string;
  disabled: boolean;
  palette: WidgetPalette;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [s.step, pressed && { backgroundColor: palette.surface }, disabled && { opacity: 0.35 }]}
    >
      <SymbolView name={symbol} size={14} weight="semibold" tintColor={palette.onSurfaceVariant} />
    </Pressable>
  );
}

const THUMB = 26;

/** A track to drag along; VoiceOver adjusts it a step at a time. */
function Slider({
  amount,
  value,
  label,
  palette,
  onChange,
}: {
  amount: WidgetSceneAmount;
  value: number;
  label: string;
  palette: WidgetPalette;
  onChange: (value: number) => void;
}) {
  const [width, setWidth] = useState(0);
  const span = amount.max - amount.min;
  const responder = useMemo(() => {
    // iOS measures a touch against the view it began on (the track: its children take no touches) for the whole
    // drag, past either end too.
    const pick = (x: number) => {
      if (!width) return;
      const share = Math.min(Math.max((x - THUMB / 2) / Math.max(1, width - THUMB), 0), 1);
      onChange(snapAmount(amount, amount.min + share * span));
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event) => pick(event.nativeEvent.locationX),
      onPanResponderMove: (event) => pick(event.nativeEvent.locationX),
    });
  }, [amount, onChange, span, width]);
  const share = span > 0 ? (value - amount.min) / span : 0;
  const thumb = share * Math.max(0, width - THUMB);
  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min: amount.min, max: amount.max, now: value }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(event) =>
        onChange(snapAmount(amount, value + (event.nativeEvent.actionName === "increment" ? 1 : -1) * amount.step))
      }
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={s.track}
      {...responder.panHandlers}
    >
      <View pointerEvents="none" style={[s.rail, { backgroundColor: palette.outline }]}>
        <View style={{ width: thumb + THUMB / 2, height: "100%", borderRadius: 2, backgroundColor: palette.primary }} />
      </View>
      <View
        pointerEvents="none"
        style={[s.thumb, { left: thumb, backgroundColor: palette.pieceLight, shadowColor: palette.shadow }]}
      />
    </View>
  );
}

const s = StyleSheet.create({
  card: { gap: 10, padding: 12, borderRadius: 22, borderCurve: "continuous" },
  end: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  tools: { flexDirection: "row", alignItems: "center", gap: 8 },
  toolsRow: { flexDirection: "row", justifyContent: "flex-end" },
  switch: { flexDirection: "row", gap: 2, padding: 2, borderRadius: 999 },
  switchOption: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  seat: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32 },
  initial: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  initialText: { fontSize: 12, fontWeight: "600" },
  // A name gives way before the middle does.
  badgeRow: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1, maxWidth: "34%" },
  badge: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  badgeText: { fontSize: 15, fontWeight: "600" },
  seatName: { flexShrink: 1, fontSize: 15, lineHeight: 20, fontWeight: "500" },
  seatNote: { flexShrink: 1, fontSize: 13, lineHeight: 18, fontVariant: ["tabular-nums"] },
  status: { fontSize: 17, lineHeight: 22, textAlign: "center" },
  // The middle: between the seats down the stack, or between the avatars across the row beneath the boards.
  middle: { alignItems: "center", gap: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  between: { flex: 1, flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: 8 },
  moves: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: 6,
    borderRadius: 24,
    borderCurve: "continuous",
  },
  movesWide: { width: "100%" },
  result: { flexDirection: "row", alignItems: "center", gap: 6, height: 40, paddingHorizontal: 14, borderRadius: 20 },
  resultText: { fontSize: 15, fontWeight: "600" },
  strong: { fontWeight: "600" },
  log: { fontSize: 15, lineHeight: 20, fontVariant: ["tabular-nums"] },
  // Round with a symbol alone, a pill when a number rides along.
  capsule: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 40,
    minWidth: 40,
    paddingHorizontal: 10,
    borderRadius: 20,
  },
  pressed: { opacity: 0.75, transform: [{ scale: 0.97 }] },
  state: { borderWidth: StyleSheet.hairlineWidth * 2 },
  amount: { width: "100%", gap: 8, padding: 2 },
  presets: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  preset: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5 },
  presetText: { fontSize: 13, fontWeight: "500" },
  sliderRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  value: { flex: 1, textAlign: "center", fontSize: 17, lineHeight: 22, fontWeight: "600", fontVariant: ["tabular-nums"] },
  step: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  track: { alignSelf: "stretch", height: 36, justifyContent: "center" },
  rail: { height: 4, borderRadius: 2, overflow: "hidden" },
  thumb: {
    position: "absolute",
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    shadowOpacity: 0.25,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
});
