import { Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
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
      accessibilityLabel={`${name}${unread ? `, ${channel.unread_count} unread` : ""}`}
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
            style={[styles.name, { flex: 1 }]}
          >
            {name}
          </Text>
          <Text style={{ fontSize: 15, color: color.muted }}>
            {listTime(channel.last_message_at)}
          </Text>
        </View>
        <View style={badge.line}>
          <Text numberOfLines={1} style={[styles.preview, badge.preview]}>
            {previewText(channel, userId)}
          </Text>
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
  line: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 4,
  },
  preview: { flex: 1, marginTop: 0 },
  pill: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    borderRadius: 10,
    backgroundColor: color.red,
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
