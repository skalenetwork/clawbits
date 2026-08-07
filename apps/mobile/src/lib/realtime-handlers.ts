import type { QueryClient } from '@tanstack/react-query';

import { insertCreatedPost } from '@/hooks/use-channel-posts';
import {
  type MmChannel,
  type MmChannelMember,
  type MmPost,
} from '@/lib/api';
import {
  type ChannelMutedEvent,
  type ChannelPinnedEvent,
  type ChannelReadEvent,
  type MmEvent,
} from '@/lib/sse';

/** Cached shape returned by ``listMmChannels``. Kept narrow on purpose
 *  — we want to ignore unfamiliar top-level keys rather than fail to
 *  patch the list if the server adds a sibling field later. */
interface ChannelsCache {
  channels: MmChannel[];
  total: number;
}

const CHANNELS_KEY = ['channels'] as const;

/**
 * Route an event from the global per-user SSE stream into the right
 * TanStack Query cache mutations. Pure with respect to the
 * ``queryClient`` argument — every mutation is a ``setQueriesData`` or
 * ``invalidateQueries`` call, no side effects beyond that.
 *
 * ``activeChannelId`` is whichever channel the user has open in the
 * foreground (``null`` if none). It's used by ``post.created`` to
 * decide whether to bump the unread badge — bumping the channel you're
 * actively reading would be a UX bug.
 */
export function applyRealtimeEvent(
  queryClient: QueryClient,
  event: MmEvent,
  activeChannelId: string | null,
): void {
  switch (event.type) {
    case 'post.created':
      applyPostCreated(queryClient, event, activeChannelId);
      return;
    case 'channel.added':
      applyChannelAdded(queryClient, event);
      return;
    case 'channel.removed':
      applyChannelRemoved(queryClient, event);
      return;
    case 'channel.muted':
      applyChannelMuted(queryClient, event);
      return;
    case 'channel.pinned':
      applyChannelPinned(queryClient, event);
      return;
    case 'channel.read':
      applyChannelRead(queryClient, event);
      return;
    case 'post.deleted':
      // The deleted post may have been the channel's denormalised
      // last-message snapshot. We can't recompute the replacement
      // preview from the event payload (it only carries the post id),
      // so refetch the list and let the server answer. Cheap and rare
      // — deletes are user-initiated, never streamed.
      void queryClient.invalidateQueries({ queryKey: CHANNELS_KEY });
      return;
    // Events handled elsewhere or intentionally ignored on the global
    // stream:
    // - 'post.updated': only matters inside a channel, which has its
    //   own per-channel SSE consumer.
    // - 'member.status'/'member.read'/'presence.snapshot': per-channel
    //   only; never arrive here.
    // - 'user.status': no UI consumes presence cross-channel yet.
    default:
      return;
  }
}

function applyPostCreated(
  queryClient: QueryClient,
  event: MmEvent,
  activeChannelId: string | null,
): void {
  const channelId = event.channel_id;
  if (!channelId) return;
  const post = event.data as MmPost;
  const isActive = activeChannelId === channelId;

  queryClient.setQueriesData<ChannelsCache>(
    { queryKey: CHANNELS_KEY },
    (prev) => patchChannel(prev, channelId, (channel) => ({
      ...channel,
      last_message_at: post.created_at,
      last_message_text: post.message,
      last_message_author_human_id: post.human_id,
      last_message_author_agent_id: post.agent_id,
      // Only overwrite preview-author fields when the SSE payload
      // actually carries them. The backend currently always
      // populates ``post.avatar`` / ``poster_display_name``, but a
      // future publish path that omits either would wipe the chat-
      // list preview avatar/name on every incoming message and
      // leave it broken until the next refetch — that's the kind of
      // silent UI rot we want to refuse at the boundary.
      last_message_author_display_name:
        post.poster_display_name ?? channel.last_message_author_display_name,
      last_message_author_avatar:
        post.avatar ?? channel.last_message_author_avatar,
      last_message_attachment_count: post.files?.length ?? 0,
      // Bumping unread on the channel the user is currently reading
      // would race against the read-pointer flush from
      // use-mark-read.ts and flash a "1" before zeroing it back out.
      // Trust the active-channel registry and skip the bump.
      unread_count: isActive
        ? channel.unread_count ?? 0
        : (channel.unread_count ?? 0) + 1,
    })),
  );

  // Second delivery path for the open conversation: fold the post into the
  // channel's message cache too. In-channel ``post.created`` normally rides
  // the per-channel socket, but if that socket is down (e.g. a silent
  // half-open connection) while this global stream is alive, the message would
  // otherwise never appear in the open chat — only bump the sidebar. Deduped
  // by post_id, so when both sockets deliver it the second call is a no-op; a
  // no-op too when the channel's posts cache isn't loaded.
  insertCreatedPost(queryClient, channelId, post);
}

function applyChannelAdded(queryClient: QueryClient, event: MmEvent): void {
  // ``channel.added`` is rare (joins, new DMs), and the payload doesn't
  // carry org context the way the list endpoint computes it — easiest
  // and least risky to refetch the channels list. The invalidation is
  // a no-op for any unmounted query, so it only costs network on
  // whichever channel cache is in active use.
  void queryClient.invalidateQueries({ queryKey: CHANNELS_KEY });
}

function applyChannelRemoved(queryClient: QueryClient, event: MmEvent): void {
  const channelId = event.channel_id;
  if (!channelId) return;

  queryClient.setQueriesData<ChannelsCache>(
    { queryKey: CHANNELS_KEY },
    (prev) => {
      if (!prev) return prev;
      if (!prev.channels.some((c) => c.channel_id === channelId)) return prev;
      const filtered = prev.channels.filter((c) => c.channel_id !== channelId);
      return {
        ...prev,
        channels: filtered,
        total: Math.max(0, prev.total - 1),
      };
    },
  );
  // Discard the dependent caches so any screen still holding the
  // removed channel's data re-renders against empty state rather than
  // stale rows. No invalidate needed because the queries shouldn't
  // refetch — the channel is gone.
  queryClient.removeQueries({ queryKey: ['mm-posts', channelId] });
  queryClient.removeQueries({ queryKey: ['mm-channel-members', channelId] });
}

function applyChannelMuted(queryClient: QueryClient, event: MmEvent): void {
  const channelId = event.channel_id;
  if (!channelId) return;
  const { muted } = event.data as ChannelMutedEvent;

  queryClient.setQueriesData<ChannelsCache>(
    { queryKey: CHANNELS_KEY },
    (prev) => patchChannel(prev, channelId, (channel) => ({
      ...channel,
      muted,
    })),
  );
}

function applyChannelPinned(queryClient: QueryClient, event: MmEvent): void {
  const channelId = event.channel_id;
  if (!channelId) return;
  const { pinned } = event.data as ChannelPinnedEvent;

  queryClient.setQueriesData<ChannelsCache>(
    { queryKey: CHANNELS_KEY },
    (prev) => patchChannel(prev, channelId, (channel) => ({
      ...channel,
      pinned,
    })),
  );
}

function applyChannelRead(queryClient: QueryClient, event: MmEvent): void {
  const channelId = event.channel_id;
  if (!channelId) return;
  const { last_read_post_id, human_id } = event.data as ChannelReadEvent;

  queryClient.setQueriesData<ChannelsCache>(
    { queryKey: CHANNELS_KEY },
    (prev) => patchChannel(prev, channelId, (channel) => {
      if ((channel.unread_count ?? 0) === 0) return channel;
      return { ...channel, unread_count: 0 };
    }),
  );

  // Mirror the read pointer onto the in-channel members cache so any
  // currently-open chat detail also reflects the cross-device read.
  // Monotonic — never let an out-of-order event drag the pointer back.
  //
  // ``Array.isArray`` is the safety net: this cache key used to host
  // two incompatible shapes (the wrapper-object version got fixed in
  // channel-avatar.tsx, but a defensive guard here ensures any future
  // accidental shape collision can't crash this handler and break the
  // SSE event loop for the rest of the session.
  if (human_id != null) {
    queryClient.setQueryData<MmChannelMember[]>(
      ['mm-channel-members', channelId],
      (prev) => {
        if (!Array.isArray(prev)) return prev;
        let changed = false;
        const next = prev.map((m) => {
          if (m.human_id !== human_id) return m;
          const current = m.last_read_post_id ?? 0;
          if (last_read_post_id <= current) return m;
          changed = true;
          return { ...m, last_read_post_id };
        });
        return changed ? next : prev;
      },
    );
  }
}

/** Apply ``mutator`` to whichever channel in this cache matches
 *  ``channelId``. Returns the same cache reference when nothing
 *  matches, so TanStack's referential-equality check skips a re-render
 *  on every other org's channel list. */
function patchChannel(
  prev: ChannelsCache | undefined,
  channelId: string,
  mutator: (channel: MmChannel) => MmChannel,
): ChannelsCache | undefined {
  if (!prev) return prev;
  let changed = false;
  const next = prev.channels.map((c) => {
    if (c.channel_id !== channelId) return c;
    const updated = mutator(c);
    if (updated !== c) changed = true;
    return updated;
  });
  return changed ? { ...prev, channels: next } : prev;
}
