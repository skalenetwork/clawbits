import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useWidget } from "@/lib/data";
import { useSession } from "@/lib/session";
import { seatOf, waitsOn, widgetLine, widgetTitle } from "@/lib/widgets";
import { showGame } from "./game-bar-state";
import { KindGlyph } from "./glyphs";
import { useWidgetPalette } from "./palette";

/** A game in the message that started it, one line: its glyph and name with how it stands, then the result. The
 *  board lives in the bar at the chat's top, which a tap here opens. Its state comes from the server by id, never
 *  from the message. */
export function WidgetCard({ widgetId, channelId }: { widgetId: string; channelId: string }) {
  const { session } = useSession();
  const palette = useWidgetPalette();
  const { data: widget, isError } = useWidget(widgetId);
  if (isError) {
    return (
      <View style={[s.card, { backgroundColor: palette.surface }]}>
        <Text style={[s.text, { color: palette.onSurfaceVariant }]}>{"This widget isn't available."}</Text>
      </View>
    );
  }
  // The line's footprint while it loads, so the list doesn't jump.
  if (!widget || !session) {
    return (
      <View style={[s.card, { backgroundColor: palette.surface }]}>
        <ActivityIndicator size="small" />
      </View>
    );
  }
  // A widget shows only in the chat it lives in.
  if (widget.channel_id !== channelId) return null;
  const seat = seatOf(widget, session.user.id);
  const title = widgetTitle(widget);
  const line = widgetLine(widget, seat);
  const yourMove = waitsOn(widget, seat);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${line}`}
      accessibilityHint="Opens the game at the top of the chat"
      onPress={() => showGame(channelId, widgetId)}
      style={({ pressed }) => [s.card, { backgroundColor: palette.surface }, pressed && { opacity: 0.75 }]}
    >
      <KindGlyph kind={widget.kind} size={17} color={palette.onPrimaryContainer} />
      <Text numberOfLines={1} style={[s.text, { color: palette.onSurfaceVariant }]}>
        <Text style={[s.title, { color: palette.onSurface }]}>{title}</Text>
        {` · ${line}`}
      </Text>
      {/* The turn, said by the line too, not only by this dot. */}
      {yourMove ? <View style={[s.dot, { backgroundColor: palette.primary }]} /> : null}
    </Pressable>
  );
}

const s = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 22,
    borderCurve: "continuous",
  },
  text: { flexShrink: 1, fontSize: 15, lineHeight: 20 },
  title: { fontWeight: "600" },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
