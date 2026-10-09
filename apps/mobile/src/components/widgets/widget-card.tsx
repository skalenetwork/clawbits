import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useWidget } from "@/lib/data";
import { useSession } from "@/lib/session";
import { useWidgetPalette } from "./palette";
import { WidgetPanel } from "./widget-panel";

/** A widget inside the message that started it. Its state comes from the server by id, never from the message. */
export function WidgetCard({ widgetId, channelId }: { widgetId: string; channelId: string }) {
  const { session } = useSession();
  const palette = useWidgetPalette();
  const { data: widget, isError } = useWidget(widgetId);
  if (isError) {
    return (
      <View style={[s.placeholder, { backgroundColor: palette.surface }]}>
        <Text style={[s.text, { color: palette.onSurfaceVariant }]}>{"This widget isn't available."}</Text>
      </View>
    );
  }
  // The footprint while it loads, so the list doesn't jump much.
  if (!widget || !session) {
    return (
      <View style={[s.placeholder, s.loading, { backgroundColor: palette.surface }]}>
        <ActivityIndicator />
      </View>
    );
  }
  // A widget shows only in the chat it lives in.
  if (widget.channel_id !== channelId) return null;
  return <WidgetPanel widget={widget} userId={session.user.id} />;
}

const s = StyleSheet.create({
  placeholder: { padding: 16, borderRadius: 22, borderCurve: "continuous" },
  loading: { minHeight: 240, alignItems: "center", justifyContent: "center" },
  text: { fontSize: 15, lineHeight: 20 },
});
