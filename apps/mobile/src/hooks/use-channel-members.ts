import { useQuery } from '@tanstack/react-query';

import { listMmChannelMembers, type MmChannelMember } from '@/lib/api';
import { preloadSvgs } from '@/lib/avatar-cache';
import { useAuth } from '@/providers/auth-provider';

export function channelMembersQueryKey(channelId: string) {
  return ['mm-channel-members', channelId] as const;
}

/** Cached list of channel members. Used by the composer's @mention
 *  autocomplete and every ``ChannelAvatar`` for DM peer resolution.
 *
 *  The explicit ``<MmChannelMember[], Error>`` annotation is load-
 *  bearing: this query key is also touched by realtime cache mutations
 *  ([[realtime-handlers.ts]]) and any future consumer. Inferring the
 *  type per call site lets two queryFns drift to incompatible return
 *  shapes silently — exactly the bug that used to make DM avatars
 *  randomly disappear after opening and closing a chat. With the
 *  annotation here, any divergent ``setQueryData`` / ``useQuery`` call
 *  fails the build instead of corrupting the cache at runtime. */
export function useChannelMembers(channelId: string): MmChannelMember[] {
  const { token } = useAuth();
  const query = useQuery<MmChannelMember[], Error>({
    queryKey: channelMembersQueryKey(channelId),
    enabled: token != null && channelId.length > 0,
    queryFn: async () => {
      const result = await listMmChannelMembers(token, channelId);
      // Warm the on-disk SVG cache for every member avatar in this
      // channel so the user never sees an initial-letter chip even
      // briefly when scrolling through messages.
      void preloadSvgs(collectMemberAvatarUrls(result.members));
      return result.members;
    },
    staleTime: 60_000,
  });
  return query.data ?? [];
}

function collectMemberAvatarUrls(members: MmChannelMember[]): string[] {
  const urls: string[] = [];
  for (const m of members) {
    const url = m.avatar?.url;
    if (url && url.toLowerCase().endsWith('.svg')) urls.push(url);
  }
  return urls;
}
