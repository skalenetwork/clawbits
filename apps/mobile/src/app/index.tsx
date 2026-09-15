import { useQuery } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { FlatList, Pressable, Text, View } from "react-native";
import { api, ApiError } from "@/lib/api";
import { useOrganizations } from "@/lib/data";
import { channelName } from "@/lib/models";
import { useSession } from "@/lib/session";
import { AvatarView, color, Empty, IconButton, styles } from "@/components/ui";
import { OrgMenu } from "@/components/org-menu";

export default function Chats() {
  const { session } = useSession();
  const orgs = useOrganizations();
  const org = orgs.selected?.org_id ?? "";
  const query = useQuery({
    queryKey: ["channels", org],
    enabled: !!org,
    queryFn: ({ signal }) => api.channels(session!.token, org, signal),
  });
  const failed = query.isError || orgs.isError;
  const denied =
    query.error instanceof ApiError && [403, 404].includes(query.error.status);
  const channels = [...(denied ? [] : (query.data?.channels ?? []))].sort(
    (a, b) => (b.last_message_at || "").localeCompare(a.last_message_at || ""),
  );
  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          headerLeft: () => <OrgMenu />,
          headerRight: () => (
            <IconButton
              name="square.and.pencil"
              label="New message"
              disabled={!org}
              onPress={() => router.push("/new")}
            />
          ),
        }}
      />
      <FlatList
        data={channels}
        contentInsetAdjustmentBehavior="automatic"
        keyExtractor={(item) => item.channel_id}
        contentContainerStyle={channels.length ? undefined : { flexGrow: 1 }}
        refreshing={query.isRefetching}
        onRefresh={() => {
          void query.refetch();
        }}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListHeaderComponent={
          failed && channels.length ? (
            <Text style={styles.detail}>Offline · Showing saved chats</Text>
          ) : undefined
        }
        ListEmptyComponent={
          <Empty
            loading={
              orgs.isPending ||
              (!!org && query.isPending && query.fetchStatus !== "paused")
            }
            title={failed ? "Could not load chats" : "No conversations yet"}
            detail={
              org
                ? "Start a message to a person or agent."
                : "Your organizations will appear here."
            }
            onRetry={
              failed
                ? () => {
                    void orgs.refetch();
                    if (org) void query.refetch();
                  }
                : undefined
            }
          />
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${channelName(item)}${item.unread_count ? `, ${item.unread_count} unread` : ""}`}
            onPress={() =>
              router.push({
                pathname: "/chat/[id]",
                params: { id: item.channel_id },
              })
            }
            style={({ pressed }) => [
              styles.row,
              { opacity: pressed ? 0.5 : 1 },
            ]}
          >
            <AvatarView
              avatar={item.dm_peer?.avatar || item.avatar}
              name={channelName(item)}
            />
            <View style={{ flex: 1 }}>
              <View
                style={{ flexDirection: "row", gap: 8, alignItems: "baseline" }}
              >
                <Text numberOfLines={1} style={[styles.name, { flex: 1 }]}>
                  {channelName(item)}
                </Text>
                <Text style={{ fontSize: 12, color: color.muted }}>
                  {item.last_message_at
                    ? new Date(item.last_message_at).toLocaleDateString(
                        undefined,
                        { month: "short", day: "numeric" },
                      )
                    : ""}
                </Text>
              </View>
              <Text numberOfLines={2} style={styles.preview}>
                {item.last_message_text ||
                  (item.last_message_attachment_count
                    ? "Attachment"
                    : item.channel_type === "direct"
                      ? "Start a conversation"
                      : "Channel")}
              </Text>
            </View>
            {item.unread_count > 0 && (
              <View
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: 5,
                  backgroundColor: color.red,
                }}
              />
            )}
          </Pressable>
        )}
      />
    </View>
  );
}
