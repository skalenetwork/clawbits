import { useInfiniteQuery } from "@tanstack/react-query";

import {
  listChannelAttachments,
  listChannelLinks,
  type MmAttachmentKind,
  type MmFile,
  type MmFileListResponse,
  type MmLinkItem,
  type MmLinkListResponse,
} from "@/lib/api";

const PAGE_SIZE = 50;

/** Query key for a channel's attachment list, sliced by ``kind``. The
 *  ``kind`` is part of the key so the Media (``media``) and Files
 *  (``file``) tabs cache independently. Exported so the SSE consumer can
 *  invalidate it when a new attachment lands. */
export function channelFileListQueryKey(channelId: string, kind: MmAttachmentKind) {
  return ["mm", "channel", channelId, "file-list", kind] as const;
}

/** Prefix matching every ``kind`` slice of a channel's file list — pass to
 *  ``invalidateQueries`` to refresh all attachment tabs at once. */
export function channelFileListPrefix(channelId: string) {
  return ["mm", "channel", channelId, "file-list"] as const;
}

export function channelLinksQueryKey(channelId: string) {
  return ["mm", "channel", channelId, "link-list"] as const;
}

/**
 * Paginated channel-wide attachments sliced by content-type ``kind``, for
 * the Attachments sidebar's Media / Files tabs. Cursor pagination uses the
 * opaque ``next_cursor`` (a ``file_id``) so the list stays correct under
 * concurrent inserts and O(limit) at any depth — backed server-side by the
 * ``ix_mm_files_channel_listing`` composite index.
 *
 * Distinct from ``useChannelAttachments`` (the composer's pending-upload
 * pipeline): this is the read-only history browser.
 */
export function useChannelFileList(
  channelId: string,
  kind: MmAttachmentKind,
  enabled = true,
) {
  return useInfiniteQuery<
    MmFileListResponse,
    Error,
    { pages: MmFileListResponse[]; pageParams: (string | undefined)[] },
    readonly unknown[],
    string | undefined
  >({
    queryKey: channelFileListQueryKey(channelId, kind),
    enabled: enabled && channelId.length > 0,
    // ``undefined`` on the first page = no cursor = start from newest.
    initialPageParam: undefined,
    queryFn: ({ pageParam }) =>
      listChannelAttachments(channelId, {
        kind,
        limit: PAGE_SIZE,
        beforeFileId: pageParam,
      }),
    getNextPageParam: (lastPage) =>
      lastPage.has_more && lastPage.next_cursor ? lastPage.next_cursor : undefined,
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

/** Paginated distinct URLs posted to the channel, for the Links tab. */
export function useChannelLinks(channelId: string, enabled = true) {
  return useInfiniteQuery<
    MmLinkListResponse,
    Error,
    { pages: MmLinkListResponse[]; pageParams: (number | undefined)[] },
    readonly unknown[],
    number | undefined
  >({
    queryKey: channelLinksQueryKey(channelId),
    enabled: enabled && channelId.length > 0,
    initialPageParam: undefined,
    queryFn: ({ pageParam }) =>
      listChannelLinks(channelId, { limit: PAGE_SIZE, beforePostId: pageParam }),
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
