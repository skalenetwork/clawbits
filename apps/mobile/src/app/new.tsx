import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { FlatList, Pressable, Text, View } from "react-native";
import { api, recipients } from "@/lib/api";
import { useOrganizations } from "@/lib/data";
import type { Recipient } from "@/lib/models";
import { useSession } from "@/lib/session";
import { AvatarView, Empty, IconButton, styles } from "@/components/ui";

export default function NewMessage() {
  const { session } = useSession();
  const { selected } = useOrganizations();
  const org = selected?.org_id ?? "";
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["recipients", org],
    enabled: !!org,
    queryFn: ({ signal }) =>
      recipients(session!.token, org, session!.user.id, signal),
  });
  const open = useMutation({
    mutationFn: (target: Recipient) => api.direct(session!.token, org, target),
    onSuccess: (channel) => {
      client.setQueryData(["channel", channel.channel_id], channel);
      void client.invalidateQueries({ queryKey: ["channels"] });
      router.dismiss();
      router.push({
        pathname: "/chat/[id]",
        params: { id: channel.channel_id },
      });
    },
  });
  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <IconButton
              name="xmark"
              label="Close"
              onPress={() => router.back()}
            />
          ),
        }}
      />
      {open.error && <Text style={styles.error}>{open.error.message}</Text>}
      <FlatList
        data={query.data}
        keyExtractor={(item) => `${item.kind}:${item.id}`}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={query.data?.length ? undefined : { flexGrow: 1 }}
        ListEmptyComponent={
          <Empty
            loading={query.isPending && query.fetchStatus !== "paused"}
            title={query.isError ? "Could not load people" : "Nobody here yet"}
            onRetry={
              query.isError
                ? () => {
                    void query.refetch();
                  }
                : undefined
            }
          />
        }
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        renderItem={({ item }) => (
          <Pressable
            disabled={open.isPending}
            accessibilityRole="button"
            onPress={() => open.mutate(item)}
            style={styles.row}
          >
            <AvatarView
              name={item.name}
              avatar={item.avatar}
              shape={item.kind === "agent" ? "agent" : "human"}
            />
            <View>
              <Text style={styles.name}>{item.name}</Text>
              <Text style={styles.preview}>
                {item.kind === "agent" ? "Agent" : "Person"}
              </Text>
            </View>
          </Pressable>
        )}
      />
    </View>
  );
}
