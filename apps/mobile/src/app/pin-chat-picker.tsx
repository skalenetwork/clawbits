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

import { ChannelAvatar } from '@/components/channel-avatar';
import { MaxWidthContent } from '@/components/max-width-content';
import { SheetGrabber } from '@/components/sheet-grabber';
import { useChannels } from '@/hooks/use-channels';
import { usePinChannel } from '@/hooks/use-pin-channel';
import { useSelectedOrg } from '@/hooks/use-selected-org';
import { useTheme } from '@/hooks/use-theme';
import { formatChannelTitle } from '@/lib/formatting';
import type { MmChannel } from '@/lib/api';

export default function PinChatPickerSheet() {
  const theme = useTheme();
  const { selectedOrg } = useSelectedOrg();
  const orgId = selectedOrg?.org_id ?? null;
  const channelsQuery = useChannels(orgId);

  const [query, setQuery] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);

  // Only show channels not already pinned — the user pinned 4-spots row
  // on the home page can't accept a duplicate anyway, and excluding
  // pinned channels here keeps the list focused on the actionable set.
  const candidates = useMemo(() => {
    const all = channelsQuery.data?.channels ?? [];
    return all.filter((c) => !c.pinned);
  }, [channelsQuery.data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((c) => {
      const raw = c.display_name ?? c.name ?? '';
      const isDirect = c.channel_type === 'direct';
      const label = isDirect ? raw : formatChannelTitle(raw);
      return label.toLowerCase().includes(q);
    });
  }, [candidates, query]);

  const isLoading = channelsQuery.isLoading;
  const isEmpty = !isLoading && candidates.length === 0;

  return (
    <>
      <Stack.Screen options={{ contentStyle: { backgroundColor: theme.background } }} />
      <SheetGrabber />
      <MaxWidthContent insetTopWhenLarge>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.flex}>
          <View style={styles.titleBlock}>
            <Text style={[styles.title, { color: theme.text }]}>Pin a chat</Text>
            <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
              Choose a channel or DM to keep one tap away from the home screen.
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
              onChangeText={setQuery}
              placeholder="Search chats…"
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

          <View style={styles.listWrap}>
            {isLoading ? (
              <View style={styles.center}>
                <ActivityIndicator color={theme.textSecondary} />
              </View>
            ) : isEmpty ? (
              <Text style={[styles.emptyText, { color: theme.textSecondary }]}>
                Every chat is already pinned. Long-press a slot on the home
                screen to unpin one first.
              </Text>
            ) : filtered.length === 0 ? (
              <Text style={[styles.emptyText, { color: theme.textSecondary }]}>
                No matches.
              </Text>
            ) : (
              <View style={[styles.list, { backgroundColor: theme.backgroundElement }]}>
                {filtered.map((channel, idx) => (
                  <PickRow
                    key={channel.channel_id}
                    channel={channel}
                    isLast={idx === filtered.length - 1}
                    isAnyPending={pendingId !== null}
                    isThisPending={pendingId === channel.channel_id}
                    onPinned={() => {
                      // Briefly defer dismissal so the optimistic patch
                      // settles in cache before the home screen re-renders
                      // behind the dismissing sheet.
                      setPendingId(channel.channel_id);
                      setTimeout(() => router.back(), 50);
                    }}
                  />
                ))}
              </View>
            )}
          </View>
        </KeyboardAvoidingView>
      </MaxWidthContent>
    </>
  );
}

function PickRow({
  channel,
  isLast,
  isAnyPending,
  isThisPending,
  onPinned,
}: {
  channel: MmChannel;
  isLast: boolean;
  isAnyPending: boolean;
  isThisPending: boolean;
  onPinned: () => void;
}) {
  const theme = useTheme();
  const { pin, isPending } = usePinChannel(channel.channel_id);
  const isDirect = channel.channel_type === 'direct';
  const raw = channel.display_name ?? channel.name ?? '';
  const label = isDirect ? raw : formatChannelTitle(raw);
  const pending = isPending || isThisPending;

  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        if (isAnyPending) return;
        pin();
        onPinned();
      }}
      disabled={isAnyPending}
      style={({ pressed }) => [
        styles.row,
        pressed && styles.rowPressed,
        isAnyPending && !pending && { opacity: 0.55 },
      ]}>
      <ChannelAvatar channel={channel} size={36} />
      <View style={styles.rowBody}>
        <Text style={[styles.rowLabel, { color: theme.text }]} numberOfLines={1}>
          {label}
        </Text>
        <Text style={[styles.rowSub, { color: theme.textSecondary }]} numberOfLines={1}>
          {isDirect ? 'Direct message' : 'Channel'}
        </Text>
      </View>
      {pending ? (
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
    paddingHorizontal: 24,
    paddingVertical: 32,
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
