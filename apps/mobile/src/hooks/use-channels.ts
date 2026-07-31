import { useQuery } from '@tanstack/react-query';

import { listMmChannels, type MmChannel } from '@/lib/api';
import { preloadSvgs } from '@/lib/avatar-cache';
import { useAuth } from '@/providers/auth-provider';

/** Shared cache for the org's channel list. Home + chats tabs hit the
 *  same query key so a refetch on either side updates both, and the
 *  ``queryFn`` here is the canonical version — without this, only the
 *  screen that loaded *first* would warm the avatar disk cache, and
 *  flipping to the other tab could still flash initial-letter chips. */
export function useChannels(orgId: string | null, enabled = true) {
  const { token } = useAuth();
  return useQuery({
    queryKey: ['channels', orgId],
    enabled: token != null && orgId != null && enabled,
    queryFn: async () => {
      const result = await listMmChannels(token, orgId);
      void preloadSvgs(collectChannelAvatarUrls(result.channels));
      return result;
    },
  });
}

/** Pulls every SVG avatar URL out of a channel-list response — the
 *  channel tile, the last-message author preview, and (on a DM) the
 *  peer's avatar. WebP uploads are skipped because ``expo-image``
 *  already disk-caches those itself. */
function collectChannelAvatarUrls(channels: MmChannel[]): string[] {
  const urls: string[] = [];
  for (const c of channels) {
    const own = c.avatar?.url;
    if (own && own.toLowerCase().endsWith('.svg')) urls.push(own);
    const author = c.last_message_author_avatar?.url;
    if (author && author.toLowerCase().endsWith('.svg')) urls.push(author);
  }
  return urls;
}
