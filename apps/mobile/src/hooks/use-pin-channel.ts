import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { Alert } from 'react-native';

import { setMmChannelPinned, type MmChannel } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';

interface ChannelsCache {
  channels: MmChannel[];
  total: number;
}

/**
 * Shared mutation for toggling the per-viewer `channel.pinned` flag.
 * Used by the chats-list long-press menu, the home-page "Pin a chat"
 * picker, and the home-page filled-slot unpin context menu — every
 * surface goes through the same optimistic-update + rollback path so
 * the caches stay consistent across tabs.
 *
 * Patches every `['channels', ...]` query key (we cache per orgId), so
 * flipping orgs after a pin doesn't show stale data either.
 */
export function usePinChannel(channelId: string) {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: ({ nextPinned }: { nextPinned: boolean }) =>
      setMmChannelPinned(token, channelId, nextPinned),
    onMutate: async ({ nextPinned }) => {
      await queryClient.cancelQueries({ queryKey: ['channels'] });
      const previous = queryClient.getQueriesData<ChannelsCache>({
        queryKey: ['channels'],
      });
      queryClient.setQueriesData<ChannelsCache>({ queryKey: ['channels'] }, (prev) => {
        if (!prev) return prev;
        const idx = prev.channels.findIndex((c) => c.channel_id === channelId);
        if (idx < 0) return prev;
        const next = prev.channels.slice();
        const existing = next[idx];
        if (!existing) return prev;
        next[idx] = { ...existing, pinned: nextPinned };
        return { ...prev, channels: next };
      });
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) {
        for (const [key, data] of ctx.previous) {
          queryClient.setQueryData(key, data);
        }
      }
      Alert.alert('Could not update pin', 'Try again in a moment.');
    },
    onSuccess: () => {
      if (process.env.EXPO_OS === 'ios') {
        void Haptics.selectionAsync();
      }
    },
  });

  return {
    pin: () => mutation.mutate({ nextPinned: true }),
    unpin: () => mutation.mutate({ nextPinned: false }),
    toggle: (isPinned: boolean) => mutation.mutate({ nextPinned: !isPinned }),
    isPending: mutation.isPending,
  };
}
