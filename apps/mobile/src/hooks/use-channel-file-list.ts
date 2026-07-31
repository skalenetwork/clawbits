import { useInfiniteQuery } from '@tanstack/react-query';

import {
  listChannelAttachments,
  listChannelLinks,
  type MmAttachmentKind,
  type MmFile,
  type MmFileListResponse,
  type MmLinkItem,
  type MmLinkListResponse,
} from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';

const PAGE_SIZE = 50;

export function channelFileListQueryKey(channelId: string, kind: MmAttachmentKind) {
  return ['mm-channel-file-list', channelId, kind] as const;
}

export function channelLinksQueryKey(channelId: string) {
  return ['mm-channel-links', channelId] as const;
}

/** Paginated list of channel-wide attachments sliced by content-type kind,
 *  for the chat-details Media / Files tabs. Distinct from
 *  ``useChannelAttachments`` ([[use-channel-attachments]]), which tracks
 *  the *composer's* pending uploads on a single screen.
 *
 *  Pagination uses opaque ``next_cursor`` strings (file_ids) so the
 *  query stays correct under concurrent inserts and stays O(limit)
 *  even when the channel holds tens of thousands of attachments —
 *  backed by the ``ix_mm_files_channel_listing`` composite index on
 *  the server. */
export function useChannelFileList(
  channelId: string,
  kind: MmAttachmentKind,
  enabled: boolean = true,
) {
  const { token } = useAuth();
  return useInfiniteQuery<
    MmFileListResponse,
    Error,
    { pages: MmFileListResponse[]; pageParams: (string | undefined)[] },
    readonly unknown[],
    string | undefined
  >({
    queryKey: channelFileListQueryKey(channelId, kind),
    enabled: enabled && token != null && channelId.length > 0,
    // ``undefined`` on the first page = no cursor = start from the
    // newest attachment.
    initialPageParam: undefined,
    queryFn: ({ pageParam }) =>
      listChannelAttachments(token, channelId, {
        kind,
        limit: PAGE_SIZE,
        beforeFileId: pageParam,
      }),
    getNextPageParam: (lastPage) =>
      lastPage.has_more && lastPage.next_cursor
        ? lastPage.next_cursor
        : undefined,
    staleTime: 60_000,
  });
}

export function flattenFilePages(
  pages: MmFileListResponse[] | undefined,
): MmFile[] {
  if (!pages) return [];
  const out: MmFile[] = [];
  for (const page of pages) out.push(...page.files);
  return out;
}

export function useChannelLinks(channelId: string, enabled: boolean = true) {
  const { token } = useAuth();
  return useInfiniteQuery<
    MmLinkListResponse,
    Error,
    { pages: MmLinkListResponse[]; pageParams: (number | undefined)[] },
    readonly unknown[],
    number | undefined
  >({
    queryKey: channelLinksQueryKey(channelId),
    enabled: enabled && token != null && channelId.length > 0,
    initialPageParam: undefined,
    queryFn: ({ pageParam }) =>
      listChannelLinks(token, channelId, {
        limit: PAGE_SIZE,
        beforePostId: pageParam,
      }),
    getNextPageParam: (lastPage) =>
      lastPage.has_more && lastPage.next_cursor != null
        ? lastPage.next_cursor
        : undefined,
    staleTime: 60_000,
  });
}

export function flattenLinkPages(
  pages: MmLinkListResponse[] | undefined,
): MmLinkItem[] {
  if (!pages) return [];
  const out: MmLinkItem[] = [];
  for (const page of pages) out.push(...page.links);
  return out;
}
