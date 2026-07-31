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

import { MaxWidthContent } from '@/components/max-width-content';
import { SheetGrabber } from '@/components/sheet-grabber';
import { useTheme } from '@/hooks/use-theme';
import { useSelectedOrg } from '@/hooks/use-selected-org';
import {
  joinMmChannel,
  listDiscoverableMmChannels,
  type MmDiscoverableChannel,
} from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';

export default function BrowseChannelsSheet() {
  const theme = useTheme();
  const { token } = useAuth();
  const { selectedOrg } = useSelectedOrg();
  const queryClient = useQueryClient();
  const orgId = selectedOrg?.org_id ?? null;

  const [query, setQuery] = useState('');
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const discoverableQuery = useQuery({
    queryKey: ['mm-discoverable', orgId],
    queryFn: () => listDiscoverableMmChannels(token, orgId!),
    enabled: token != null && orgId != null,
  });

  const channels = useMemo(
    () => discoverableQuery.data?.channels ?? [],
    [discoverableQuery.data?.channels],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return channels;
    return channels.filter(
      (c) =>
        (c.display_name ?? c.name).toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q),
    );
  }, [channels, query]);

  const join = async (channel: MmDiscoverableChannel) => {
    if (joiningId) return;
    setJoiningId(channel.channel_id);
    setError(null);
    try {
      const joined = await joinMmChannel(token, channel.channel_id);
      void queryClient.invalidateQueries({ queryKey: ['channels'] });
      void queryClient.invalidateQueries({ queryKey: ['mm-discoverable'] });
      if (process.env.EXPO_OS === 'ios') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      router.back();
      setTimeout(() => {
        router.push({
          pathname: '/chats/[channelId]',
          params: { channelId: joined.channel_id },
        });
      }, 50);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't join channel");
      setJoiningId(null);
    }
  };

  const isLoading = discoverableQuery.isLoading;
  const isEmpty = !isLoading && channels.length === 0;

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
          <Text style={[styles.title, { color: theme.text }]}>Browse channels</Text>
          <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
            Public channels in your organization. Join any to see its history and post.
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
            placeholder="Search channels…"
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
            <View style={styles.empty}>
              <SymbolView
                name={{ ios: 'number', android: 'tag' }}
                tintColor={theme.textSecondary}
                size={28}
              />
              <Text style={[styles.emptyTitle, { color: theme.text }]}>
                No more channels to join
              </Text>
              <Text style={[styles.emptyText, { color: theme.textSecondary }]}>
                You&apos;re already a member of every public channel.
              </Text>
            </View>
          ) : filtered.length === 0 ? (
            <Text style={[styles.emptyText, { color: theme.textSecondary }]}>
              No matches.
            </Text>
          ) : (
            <View style={[styles.list, { backgroundColor: theme.backgroundElement }]}>
              {filtered.map((c, idx) => {
                const isLast = idx === filtered.length - 1;
                const isJoining = joiningId === c.channel_id;
                const label = c.display_name ?? c.name;
                return (
                  <View key={c.channel_id} style={styles.row}>
                    <View style={[styles.glyph, { backgroundColor: theme.inputBg }]}>
                      <SymbolView
                        name={{ ios: 'number', android: 'tag' }}
                        tintColor={theme.textSecondary}
                        size={16}
                      />
                    </View>
                    <View style={styles.rowBody}>
                      <Text
                        style={[styles.rowLabel, { color: theme.text }]}
                        numberOfLines={1}>
                        {label}
                      </Text>
                      <Text
                        style={[styles.rowSub, { color: theme.textSecondary }]}
                        numberOfLines={1}>
                        {c.member_count} {c.member_count === 1 ? 'member' : 'members'}
                      </Text>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Join ${label}`}
                      onPress={() => void join(c)}
                      disabled={joiningId !== null}
                      style={({ pressed }) => [
                        styles.joinButton,
                        {
                          backgroundColor: theme.text,
                          opacity:
                            joiningId !== null && !isJoining
                              ? 0.3
                              : pressed
                                ? 0.7
                                : 1,
                        },
                      ]}>
                      {isJoining ? (
                        <ActivityIndicator color={theme.background} size="small" />
                      ) : (
                        <Text style={[styles.joinLabel, { color: theme.background }]}>
                          Join
                        </Text>
                      )}
                    </Pressable>
                    {!isLast ? (
                      <View
                        style={[
                          styles.divider,
                          { backgroundColor: theme.backgroundSelected },
                        ]}
                      />
                    ) : null}
                  </View>
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
  empty: {
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 32,
    paddingVertical: 32,
  },
  emptyText: {
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 16,
    paddingVertical: 32,
    textAlign: 'center',
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginTop: 6,
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
  glyph: {
    alignItems: 'center',
    borderRadius: 8,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  joinButton: {
    alignItems: 'center',
    borderRadius: 999,
    height: 30,
    justifyContent: 'center',
    minWidth: 64,
    paddingHorizontal: 14,
  },
  joinLabel: {
    fontSize: 13,
    fontWeight: '600',
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
