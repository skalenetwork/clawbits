import { useState } from "react";
import { Alert, FlatList, Text, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { useQueries } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { api } from "@/lib/api";
import { useOrganizations } from "@/lib/data";
import { memberCountLabel, orgName } from "@/lib/models";
import { useSession } from "@/lib/session";
import {
  AvatarView,
  color,
  Empty,
  GlassCard,
  IconButton,
  styles,
} from "@/components/ui";

export default function SelectOrg() {
  const { session, selectOrg, signOut } = useSession();
  const orgs = useOrganizations();
  const [busy, setBusy] = useState<string | null>(null);
  const counts = useQueries({
    queries: orgs.organizations.map((org) => ({
      queryKey: ["members", org.org_id],
      enabled: org.member_count == null && !!session,
      staleTime: 60_000,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.members(session!.token, org.org_id, signal),
    })),
  });
  const pick = (id: string) => {
    setBusy(id);
    void selectOrg(id).catch((cause) => {
      setBusy(null);
      Alert.alert(
        "Could not open workspace",
        cause instanceof Error ? cause.message : "Please try again.",
      );
    });
  };
  return (
    <>
      <Stack.Screen
        options={{
          title: "Workspaces",
          headerLargeTitle: true,
          headerShadowVisible: false,
          headerRight: () => (
            <IconButton
              name="rectangle.portrait.and.arrow.right"
              label="Sign out"
              onPress={() =>
                Alert.alert("Sign out?", undefined, [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Sign Out",
                    style: "destructive",
                    onPress: () => {
                      void signOut();
                    },
                  },
                ])
              }
            />
          ),
        }}
      />
      <FlatList
        style={styles.screen}
        data={orgs.organizations}
        keyExtractor={(item) => item.org_id}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={
          orgs.organizations.length
            ? {
                paddingHorizontal: 16,
                paddingTop: 8,
                paddingBottom: 28,
                gap: 12,
              }
            : { flexGrow: 1 }
        }
        ListEmptyComponent={
          <Empty
            loading={orgs.isPending && orgs.fetchStatus !== "paused"}
            title={
              orgs.isError ? "Could not load workspaces" : "No workspaces yet"
            }
            onRetry={
              orgs.isError
                ? () => {
                    void orgs.refetch();
                  }
                : undefined
            }
          />
        }
        renderItem={({ item, index }) => {
          const name = orgName(item);
          const count = item.member_count ?? counts[index]?.data?.total;
          const members = count == null ? " " : memberCountLabel(count);
          return (
            <GlassCard
              label={count == null ? name : `${name}, ${members}`}
              disabled={busy != null}
              onPress={() => pick(item.org_id)}
            >
              <AvatarView avatar={item.avatar} name={name} shape="channel" />
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={styles.name}>
                  {name}
                </Text>
                <Text style={styles.preview}>{members}</Text>
              </View>
              <SymbolView
                name="chevron.right"
                size={13}
                weight="semibold"
                tintColor={color.muted}
              />
            </GlassCard>
          );
        }}
      />
    </>
  );
}
