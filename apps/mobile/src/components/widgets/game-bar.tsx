import { GlassView } from "expo-glass-effect";
import { SymbolView } from "expo-symbols";
import { useEffect, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useActiveWidgets, useWidget } from "@/lib/data";
import { useSession } from "@/lib/session";
import { scoreLabel, scoreOf, seatOf, waitsOn, widgetLine, widgetTitle, type Widget } from "@/lib/widgets";
import {
  dismissGame,
  seeGameStatus,
  setGameOpen,
  unshowGame,
  useGameBarState,
  useShownGame,
  type GameBarState,
} from "./game-bar-state";
import { KindGlyph } from "./glyphs";
import { useWidgetPalette } from "./palette";
import { WidgetPanel } from "./widget-panel";

/** The chat's game, pinned under its header: moves post nothing, so its message scrolls away, and this slim bar keeps
 *  it in reach: its glyph, how it stands, a dot when it's the viewer's move, and the chat's score once a game here
 *  has finished. A tap opens the board in place and another folds it; each game stays as its player left it on this
 *  phone, and never opens by itself. Once over, the result shows until put away, or until a new game takes the bar;
 *  one seen ending while open folds after a moment. */
export function GameBar({
  channelId,
  enabled,
  lastGame,
  top,
  bottom,
  onHeight,
  onOpen,
}: {
  channelId: string;
  /** Games run in this chat, so its active one is asked for. */
  enabled: boolean;
  /** The game the chat's latest loaded game message started. */
  lastGame: string | null;
  /** Where the header ends. */
  top: number;
  /** Where the composer begins: an open board keeps clear of it. */
  bottom: number;
  /** The bar's row and its gap, for the chat to keep its first message clear of; 0 while none shows. */
  onHeight: (height: number) => void;
  /** Whether the board is open over the chat's messages. */
  onOpen: (open: boolean) => void;
}) {
  const { data } = useActiveWidgets(channelId, enabled);
  const activeId = data?.[0]?.widget_id ?? null;
  // The game last active here, for its result once it ends with its message too far back to be loaded.
  const [lastActive, setLastActive] = useState<string | null>(null);
  if (activeId && activeId !== lastActive) setLastActive(activeId);
  const shown = useShownGame(channelId);
  // A new game takes the bar from one a tap put there, and leaving the chat gives the bar back.
  useEffect(() => {
    if (activeId) unshowGame(channelId, activeId);
  }, [activeId, channelId]);
  useEffect(() => () => unshowGame(channelId), [channelId]);
  const widgetId = shown ?? activeId ?? lastGame ?? lastActive;
  // Not keyed by game: its row stays put when a new game takes it, so the chat's first message doesn't jump.
  return widgetId ? (
    <Bar
      widgetId={widgetId}
      listed={data?.find((item) => item.widget_id === widgetId)}
      channelId={channelId}
      top={top}
      bottom={bottom}
      onHeight={onHeight}
      onOpen={onOpen}
    />
  ) : null;
}

function Bar({
  widgetId,
  listed,
  channelId,
  top,
  bottom,
  onHeight,
  onOpen,
}: {
  widgetId: string;
  listed: Widget | undefined;
  channelId: string;
  top: number;
  bottom: number;
  onHeight: (height: number) => void;
  onOpen: (open: boolean) => void;
}) {
  const { session } = useSession();
  const palette = useWidgetPalette();
  const saved = useGameBarState(widgetId);
  // The widget's own query stays fresh where the list may not: a private widget refetches only itself.
  const widget = useWidget(widgetId).data ?? listed;
  const status = widget?.status;
  useEffect(() => {
    if (status) seeGameStatus(widgetId, status);
  }, [status, widgetId]);
  if (!widget || !session || widget.channel_id !== channelId) return null;
  const over = widget.status !== "active";
  // A running game shows folded while what this phone kept of it loads; a result waits, so one put away never
  // flashes back.
  const kept = saved ?? (over ? null : FOLDED);
  if (!kept || (over && kept.dismissed)) return null;
  const userId = session.user.id;
  const seat = seatOf(widget, userId);
  const yourMove = waitsOn(widget, seat);
  const line = widgetLine(widget, seat);
  const opponent = widget.seats.find((item) => item.seat !== seat)?.display_name;
  const score = scoreOf(widget, userId);
  const toggle = () => {
    setGameOpen(widgetId, !kept.open);
    if (kept.open) unshowGame(channelId);
  };
  return (
    <View pointerEvents="box-none" style={[s.frame, { top, bottom: bottom + GAP }]}>
      <Strip onHeight={onHeight}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={[widgetTitle(widget), opponent && `with ${opponent}`, line, score && scoreLabel(score)]
            .filter(Boolean)
            .join(", ")}
          accessibilityState={{ expanded: kept.open }}
          accessibilityHint={kept.open ? "Folds the game away" : "Opens the game"}
          onPress={toggle}
          style={({ pressed }) => [s.main, pressed && { opacity: 0.7 }]}
        >
          <KindGlyph kind={widget.kind} size={17} color={palette.onPrimaryContainer} />
          <Text numberOfLines={1} style={[s.line, { color: palette.onSurface }, yourMove && s.strong]}>
            {line}
          </Text>
          {/* The turn, said by the line too, not only by this dot. */}
          {yourMove ? <View style={[s.dot, { backgroundColor: palette.primary }]} /> : null}
          {score ? (
            <Text style={[s.score, { color: palette.onSurfaceVariant, backgroundColor: palette.surfaceHigh }]}>
              {`${score.mine}–${score.theirs}`}
            </Text>
          ) : null}
          <View style={s.spacer} />
          <SymbolView
            name={kept.open ? "chevron.up" : "chevron.down"}
            size={13}
            weight="semibold"
            tintColor={palette.onSurfaceVariant}
          />
        </Pressable>
        {over ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
            accessibilityHint="Puts the result away"
            hitSlop={6}
            onPress={() => {
              dismissGame(widgetId);
              unshowGame(channelId);
            }}
            style={({ pressed }) => [s.dismiss, pressed && { backgroundColor: palette.surfaceHigh }]}
          >
            <SymbolView name="xmark" size={12} weight="bold" tintColor={palette.onSurfaceVariant} />
          </Pressable>
        ) : null}
      </Strip>
      {kept.open ? (
        // A board per game, so one's picks never carry over to the next.
        <Board key={widgetId} onOpen={onOpen}>
          <WidgetPanel widget={widget} userId={userId} />
        </Board>
      ) : null}
    </View>
  );
}

/** The bar's row, glass over the chat, telling the chat its height while it shows. */
function Strip({ onHeight, children }: { onHeight: (height: number) => void; children: ReactNode }) {
  useEffect(() => () => onHeight(0), [onHeight]);
  return (
    <View onLayout={(event) => onHeight(Math.round(event.nativeEvent.layout.height) + GAP)} style={s.strip}>
      <GlassView glassEffectStyle="regular" style={s.glass} />
      {children}
    </View>
  );
}

/** The open board over the chat, telling the chat it covers its messages while it shows. Taller than the room
 *  between the bar and the composer, it scrolls. */
function Board({ onOpen, children }: { onOpen: (open: boolean) => void; children: ReactNode }) {
  useEffect(() => {
    onOpen(true);
    return () => onOpen(false);
  }, [onOpen]);
  return (
    <ScrollView style={s.board} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      {children}
    </ScrollView>
  );
}

const FOLDED: GameBarState = { open: false, dismissed: false };
const GAP = 6;
const ROW = 44;
const s = StyleSheet.create({
  // Over the chat from the header down to the composer; only the bar and an open board take touches.
  frame: { position: "absolute", left: 0, right: 0, gap: GAP, paddingHorizontal: 10 },
  strip: { flexDirection: "row", alignItems: "center", minHeight: ROW, paddingLeft: 14, paddingRight: 6 },
  glass: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderRadius: ROW / 2 },
  main: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8, minHeight: ROW, paddingRight: 8 },
  line: { flexShrink: 1, fontSize: 15, lineHeight: 20, fontWeight: "500" },
  strong: { fontWeight: "600" },
  dot: { width: 8, height: 8, borderRadius: 4 },
  score: {
    overflow: "hidden",
    borderRadius: 9,
    paddingHorizontal: 6,
    paddingVertical: 1,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "500",
    fontVariant: ["tabular-nums"],
  },
  spacer: { flex: 1 },
  dismiss: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  // As tall as the board, up to the room there is.
  board: { flexGrow: 0, flexShrink: 1, borderRadius: 22 },
});
