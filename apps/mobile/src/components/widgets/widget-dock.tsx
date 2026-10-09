import { GlassView } from "expo-glass-effect";
import { Pressable, StyleSheet, View } from "react-native";
import { color } from "@/components/ui";
import { useActiveWidgets, useWidget } from "@/lib/data";
import { useSession } from "@/lib/session";
import { seatOf, type Widget } from "@/lib/widgets";
import { KindGlyph } from "./glyphs";
import { useWidgetPalette } from "./palette";

/** The chat's active widget at the composer's corner: moves post nothing, so the message that started it scrolls
 *  away, and this round button brings it back. It sits over the chat, so it is glass; a tap scrolls the chat to that
 *  message, the one game, rather than opening a second view of it. While that game is on screen it steps aside, and
 *  while it shows it takes a lane of its own above the composer, so it never covers a message. */
export function WidgetDock({
  channelId,
  enabled,
  onScreen,
  onShow,
}: {
  channelId: string;
  enabled: boolean;
  /** The games whose message is on screen now. */
  onScreen: readonly string[];
  /** Scrolls the chat to the widget's message. */
  onShow: (widget: Widget) => void;
}) {
  const { data } = useActiveWidgets(channelId, enabled);
  const listed = data?.[0];
  return listed && !onScreen.includes(listed.widget_id) ? (
    <DockedWidget key={listed.widget_id} listed={listed} onShow={onShow} />
  ) : null;
}

function DockedWidget({ listed, onShow }: { listed: Widget; onShow: (widget: Widget) => void }) {
  const { session } = useSession();
  const palette = useWidgetPalette();
  // The widget's own query stays fresh where the list may not: a private widget refetches only itself.
  const widget = useWidget(listed.widget_id).data ?? listed;
  const userId = session?.user.id ?? null;
  const mySeat = seatOf(widget, userId);
  const opponent = widget.seats.find((seat) => seat.seat !== mySeat)?.display_name;
  const myTurn = mySeat != null && widget.turn === mySeat;
  const title = widget.scene.title ?? widget.kind;
  const status = myTurn ? "Your move" : widget.scene.status?.text;
  return (
    // The lane is part of the composer, which the chat measures and keeps clear of its latest message.
    <View style={s.lane}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[title, opponent && `with ${opponent}`, status].filter(Boolean).join(", ")}
        accessibilityHint="Shows the game in the chat"
        onPress={() => onShow(widget)}
        style={({ pressed }) => [s.button, pressed && { transform: [{ scale: 0.94 }] }]}
      >
        <GlassView glassEffectStyle="regular" isInteractive style={s.glass} />
        <KindGlyph kind={widget.kind} size={19} color={palette.onPrimaryContainer} />
        {/* The turn, said by the label too, not only by this dot. */}
        {myTurn ? <View style={[s.dot, { backgroundColor: palette.primary, borderColor: color.background }]} /> : null}
      </Pressable>
    </View>
  );
}

const SIZE = 48;
const s = StyleSheet.create({
  // A lane above the composer's fields, the button at its right: the list keeps clear of the composer, lane and all.
  lane: { flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: 12, paddingBottom: 8 },
  button: {
    width: SIZE,
    height: SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  glass: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderRadius: SIZE / 2 },
  dot: { position: "absolute", top: 3, right: 3, width: 12, height: 12, borderRadius: 6, borderWidth: 2 },
});
