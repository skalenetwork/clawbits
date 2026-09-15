import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { FlatList, Text, View } from "react-native";
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
  const [tab, setTab] = useState<ChatTab>("all");
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
          <>
            <ChatFilter value={tab} onChange={setTab} />
            {failed && channels.length ? (
              <Text style={styles.detail}>Offline · Showing saved chats</Text>
            ) : null}
          </>
        }
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
    </View>
  );
}
