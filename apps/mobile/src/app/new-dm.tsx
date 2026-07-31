import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { router, Stack } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Avatar } from '@/components/avatar';
import { MaxWidthContent } from '@/components/max-width-content';
import { SheetGrabber } from '@/components/sheet-grabber';
import { useTheme } from '@/hooks/use-theme';
import { useSelectedOrg } from '@/hooks/use-selected-org';
import {
  createOrGetMmDirect,
  listOrgAgents,
  listOrgMembers,
  type AgentUser,
  type MmMemberType,
  type OrgMember,
} from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';

/** Picker row for either a human or an agent — both flow into
 *  ``createOrGetMmDirect`` with a discriminator. */
interface Target {
  kind: MmMemberType;
  id: string;
  label: string;
  sub: string;
  avatarUrl?: string | null;
}

export default function NewDmSheet() {
  const theme = useTheme();
  const { token, user } = useAuth();
  const { selectedOrg } = useSelectedOrg();
  const queryClient = useQueryClient();
  const orgId = selectedOrg?.org_id ?? null;

  const [query, setQuery] = useState('');
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const membersQuery = useQuery({
    queryKey: ['org-members', orgId],
    queryFn: () => listOrgMembers(token, orgId!),
    enabled: token != null && orgId != null,
  });
  const agentsQuery = useQuery({
    queryKey: ['org-agents', orgId],
    queryFn: () => listOrgAgents(token, orgId!),
    enabled: token != null && orgId != null,
  });

  const targets = useMemo<Target[]>(() => {
    const humans = (membersQuery.data?.members ?? [])
      .filter((m: OrgMember) => m.human_id !== user?.id)
      .map<Target>((m) => ({
        kind: 'human',
        id: String(m.human_id),
        label: m.display_name ?? m.email,
        sub: m.email,
        avatarUrl: m.avatar?.url,
      }));
    const agents = (agentsQuery.data?.agents ?? []).map<Target>((a: AgentUser) => ({
      kind: 'agent',
      id: a.agent_id,
      label: a.display_name ?? a.nickname ?? a.agent_id,
      sub: 'Agent',
      avatarUrl: a.avatar?.url,
    }));
    return [...agents, ...humans];
  }, [agentsQuery.data, membersQuery.data, user?.id]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return targets;
    return targets.filter(
      (t) => t.label.toLowerCase().includes(q) || t.sub.toLowerCase().includes(q),
    );
  }, [targets, query]);

  const startDm = async (target: Target) => {
    if (!orgId || pendingKey) return;
    const key = `${target.kind}:${target.id}`;
    setPendingKey(key);
    setError(null);
    try {
      const channel = await createOrGetMmDirect(token, orgId, target.kind, target.id);
      void queryClient.invalidateQueries({ queryKey: ['channels'] });
      if (process.env.EXPO_OS === 'ios') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      router.back();
      // Defer navigation so the dismissal animation runs first.
      setTimeout(() => {
        router.push({
          pathname: '/chats/[channelId]',
          params: { channelId: channel.channel_id },
        });
      }, 50);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start direct message");
      setPendingKey(null);
    }
  };

  const isLoading = membersQuery.isLoading || agentsQuery.isLoading;
  const isEmpty = !isLoading && targets.length === 0;

  return (
    <>
      <Stack.Screen
        options={{ contentStyle: { backgroundColor: theme.background } }}
      />
      <SheetGrabber />
      <MaxWidthContent insetTopWhenLarge>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}>
        <View style={styles.titleBlock}>
          <Text style={[styles.title, { color: theme.text }]}>New direct message</Text>
          <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
            Pick anyone in your organization to start a private conversation.
          </Text>
        </View>

        <View style={styles.searchWrap}>
          <SymbolView
            name={{ ios: 'magnifyingglass', android: 'search' }}
            tintColor={theme.textSecondary}
            size={16}
            style={styles.searchIcon}
          />
          <TextInput
            autoFocus
            value={query}
            onChangeText={(v) => {
              setQuery(v);
              setError(null);
            }}
            placeholder="Search agents and people…"
            placeholderTextColor={theme.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            style={[
              styles.search,
              {
                backgroundColor: theme.inputBg,
                borderColor: theme.inputBorder,
                color: theme.text,
              },
            ]}
          />
        </View>

        {error ? (
          <Text style={[styles.error, { color: theme.destructive }]} selectable>
            {error}
          </Text>
        ) : null}

        <View style={styles.listWrap}>
          {isLoading ? (
            <View style={styles.center}>
              <ActivityIndicator color={theme.textSecondary} />
            </View>
          ) : isEmpty ? (
            <Text style={[styles.emptyText, { color: theme.textSecondary }]}>
              No one else in this organization yet.
            </Text>
          ) : filtered.length === 0 ? (
            <Text style={[styles.emptyText, { color: theme.textSecondary }]}>
              No matches.
            </Text>
          ) : (
            <View style={[styles.list, { backgroundColor: theme.backgroundElement }]}>
              {filtered.map((t, idx) => {
                const key = `${t.kind}:${t.id}`;
                const isPending = pendingKey === key;
                const isLast = idx === filtered.length - 1;
                return (
                  <Pressable
                    key={key}
                    accessibilityRole="button"
                    onPress={() => void startDm(t)}
                    disabled={pendingKey !== null}
                    style={({ pressed }) => [
                      styles.row,
                      pressed && styles.rowPressed,
                      pendingKey !== null && !isPending && { opacity: 0.55 },
                    ]}>
                    <Avatar uri={t.avatarUrl} name={t.label} size={36} />
                    <View style={styles.rowBody}>
                      <Text
                        style={[styles.rowLabel, { color: theme.text }]}
                        numberOfLines={1}>
                        {t.label}
                      </Text>
                      <Text
                        style={[styles.rowSub, { color: theme.textSecondary }]}
                        numberOfLines={1}>
                        {t.sub}
                      </Text>
                    </View>
                    {isPending ? (
                      <ActivityIndicator color={theme.textSecondary} size="small" />
                    ) : null}
                    {!isLast ? (
                      <View
                        style={[
                          styles.divider,
                          { backgroundColor: theme.backgroundSelected },
                        ]}
                      />
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
      </MaxWidthContent>
    </>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: 'center',
    paddingVertical: 32,
  },
  divider: {
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    left: 60,
    position: 'absolute',
    right: 14,
  },
  emptyText: {
    fontSize: 14,
    paddingVertical: 32,
    textAlign: 'center',
  },
  error: {
    fontSize: 13,
    marginHorizontal: 24,
    marginTop: 8,
    textAlign: 'center',
  },
  flex: {
    flex: 1,
  },
  list: {
    borderRadius: 18,
    overflow: 'hidden',
  },
  listWrap: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    position: 'relative',
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
  },
  rowLabel: {
    fontSize: 16,
    fontWeight: '500',
  },
  rowPressed: {
    opacity: 0.6,
  },
  rowSub: {
    fontSize: 12,
    marginTop: 1,
  },
  search: {
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    fontSize: 16,
    height: 44,
    paddingLeft: 38,
    paddingRight: 16,
  },
  searchIcon: {
    height: 16,
    left: 30,
    position: 'absolute',
    top: 14,
    width: 16,
    zIndex: 1,
  },
  searchWrap: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    position: 'relative',
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 19,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  titleBlock: {
    gap: 4,
    paddingBottom: 16,
    paddingHorizontal: 24,
    paddingTop: 24,
  },
});
