import { Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { glyphKind, listTime, previewText } from "@/lib/chatFilters";
import { channelName, type Channel } from "@/lib/models";
import { AvatarView, color, styles } from "@/components/ui";

export function ChatRow({
  channel,
  userId,
}: {
  channel: Channel;
  userId: number;
}) {
  const unread = channel.unread_count > 0;
  const name = channelName(channel);
  const shape = glyphKind(channel);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}${unread ? `, ${channel.unread_count} unread` : ""}${channel.widget_turn ? ", your move" : ""}`}
      onPress={() =>
        router.push({
          pathname: "/chat/[id]",
          params: { id: channel.channel_id },
        })
      }
      style={({ pressed }) => [
        styles.row,
        pressed && { backgroundColor: color.secondary },
      ]}
    >
      <AvatarView
        avatar={
          shape === "channel"
            ? channel.avatar
            : channel.dm_peer?.avatar || channel.avatar
        }
        name={name}
        shape={shape}
      />
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "baseline" }}>
          <Text
            numberOfLines={1}
            style={[styles.name, badge.name, unread && badge.unread]}
          >
            {name}
          </Text>
          <Text style={badge.time}>
            {listTime(channel.last_message_at)}
          </Text>
        </View>
        <View style={badge.line}>
          <Text
            numberOfLines={1}
            style={[styles.preview, badge.preview, unread && badge.unread]}
          >
            {previewText(channel, userId)}
          </Text>
          {/* A game here waits on you: quiet, beside the unread count rather than another badge. */}
          {channel.widget_turn ? (
            <SymbolView name="gamecontroller.fill" size={15} tintColor={color.muted} />
          ) : null}
          {unread ? (
            <View style={badge.pill}>
              <Text style={badge.count}>
                {channel.unread_count > 99 ? "99+" : String(channel.unread_count)}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

const badge = StyleSheet.create({
  name: { flex: 1 },
  unread: { fontWeight: "600" },
  time: { fontSize: 15, color: color.muted },
  line: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 2,
  },
  preview: { flex: 1, marginTop: 0 },
  pill: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    borderRadius: 10,
    backgroundColor: color.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  count: {
    fontSize: 12,
    fontWeight: "600",
    color: "#ffffff",
    fontVariant: ["tabular-nums"],
  },
});
