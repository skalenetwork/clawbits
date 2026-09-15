import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { useAnimatedHeaderHeight } from "expo-router/build/react-navigation/native-stack/utils/useAnimatedHeaderHeight";
import { Animated, FlatList, View } from "react-native";
import { api, ApiError } from "@/lib/api";
import {
  CHAT_TAB_LABEL,
  filterChannelsByTab,
  type ChatTab,
} from "@/lib/chatFilters";
import { useOrganizations } from "@/lib/data";
import { useSession } from "@/lib/session";
import { ChatFilter } from "@/components/chat-filter";
import { ChatRow } from "@/components/chat-row";
import { Empty, IconButton, styles } from "@/components/ui";
import { OrgMenu } from "@/components/org-menu";

const emptyTitle: Record<ChatTab, string> = {
  all: "No conversations yet",
  channels: "No channels",
  dms: "No direct messages",
  agents: "No agent chats",
};

export default function Chats() {
  const { session } = useSession();
  const orgs = useOrganizations();
  const headerHeight = useAnimatedHeaderHeight();
  const [tab, setTab] = useState<ChatTab>("all");
  const [filterHeight, setFilterHeight] = useState(52);
  const [pulling, setPulling] = useState(false);
  const org = orgs.selected?.org_id ?? "";
  const query = useQuery({
    queryKey: ["channels", org],
    enabled: !!org,
    queryFn: ({ signal }) => api.channels(session!.token, org, signal),
  });
  const failed = query.isError || orgs.isError;
  const denied =
    query.error instanceof ApiError && [403, 404].includes(query.error.status);
  const channels = filterChannelsByTab(
    [...(denied ? [] : (query.data?.channels ?? []))].sort((a, b) =>
      (b.last_message_at || "").localeCompare(a.last_message_at || ""),
    ),
    tab,
  );
  return (
    <>
      <FlatList
        style={styles.screen}
        data={channels}
        contentInsetAdjustmentBehavior="automatic"
        keyExtractor={(item) => item.channel_id}
        contentContainerStyle={channels.length ? undefined : { flexGrow: 1 }}
        refreshing={pulling}
        onRefresh={() => {
          setPulling(true);
          void query.refetch().finally(() => setPulling(false));
        }}
        ListHeaderComponent={<View style={{ height: filterHeight }} />}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={
          <Empty
            loading={
              orgs.isPending ||
              (!!org && query.isPending && query.fetchStatus !== "paused")
            }
            title={failed ? "Could not load chats" : emptyTitle[tab]}
            detail={
              org
                ? tab === "all"
                  ? "Start a message to a person or agent."
                  : `Nothing in ${CHAT_TAB_LABEL[tab].toLowerCase()} yet.`
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
          <ChatRow channel={item} userId={session!.user.id} />
        )}
      />
      <Animated.View
        onLayout={(event) => {
          setFilterHeight(event.nativeEvent.layout.height);
        }}
        style={[
          {
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            zIndex: 1,
            backgroundColor: "transparent",
          },
          { transform: [{ translateY: headerHeight }] },
        ]}
        pointerEvents="box-none"
      >
        <ChatFilter
          value={tab}
          onChange={setTab}
          offline={failed && channels.length > 0}
        />
      </Animated.View>
      <Stack.Screen
        options={{
          headerShadowVisible: false,
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
    </>
  );
}
