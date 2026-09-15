import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { listTime, previewText } from "@/lib/chatFilters";
import { channelName, type Channel } from "@/lib/models";
import { AvatarView, color, styles } from "@/components/ui";

function ChatGlyph({ channel }: { channel: Channel }) {
  if (channel.channel_type === "direct") {
    return (
      <AvatarView
        avatar={channel.dm_peer?.avatar || channel.avatar}
        name={channelName(channel)}
      />
    );
  }
  return (
    <View style={styles.avatar}>
      <SymbolView
        name={channel.channel_type === "private" ? "lock.fill" : "number"}
        size={22}
        tintColor={color.muted}
      />
    </View>
  );
}

export function ChatRow({
  channel,
  userId,
}: {
  channel: Channel;
  userId: number;
}) {
  const unread = channel.unread_count > 0;
  const name = channelName(channel);
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
      <ChatGlyph channel={channel} />
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "baseline" }}>
          <Text
            numberOfLines={1}
            style={[styles.name, { flex: 1, fontWeight: unread ? "700" : "400" }]}
          >
            {name}
          </Text>
          <Text style={{ fontSize: 15, color: color.muted }}>
            {listTime(channel.last_message_at)}
          </Text>
        </View>
        <Text numberOfLines={1} style={styles.preview}>
          {previewText(channel, userId)}
        </Text>
      </View>
      {unread ? (
        <View
          style={{
            width: 10,
            height: 10,
            borderRadius: 5,
            backgroundColor: color.red,
          }}
        />
      ) : null}
    </Pressable>
  );
}
