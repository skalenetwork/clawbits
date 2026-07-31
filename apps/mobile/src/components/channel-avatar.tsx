import type { StyleProp, ViewStyle } from 'react-native';

import { Avatar } from '@/components/avatar';
import { useChannelMembers } from '@/hooks/use-channel-members';
import { type MmChannel, type MmChannelMember } from '@/lib/api';
import { formatChannelTitle } from '@/lib/formatting';
import { useAuth } from '@/providers/auth-provider';

interface ChannelAvatarProps {
  channel: MmChannel;
  size?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * Resolves the right avatar for a channel and renders it.
 *
 * - **Direct** channels: shows the peer's user/agent avatar, matching the
 *   avatar they post messages with. Members come from the shared
 *   ``useChannelMembers`` hook so this component and the chat-detail
 *   screen hit the same React Query cache.
 * - **Group / public** channels: shows the channel's own server-generated
 *   tile (``channel.avatar?.url``) — no member fetch needed.
 *
 * Falls back to the initial-letter glyph in the underlying ``Avatar``
 * component when the resolved URL is missing or the load errors.
 */
export function ChannelAvatar({ channel, size = 32, style }: ChannelAvatarProps) {
  const isDirect = channel.channel_type === 'direct';
  const title = isDirect
    ? (channel.display_name ?? channel.name)
    : formatChannelTitle(channel.display_name ?? channel.name);

  if (!isDirect) {
    return <Avatar uri={channel.avatar?.url} name={title} size={size} style={style} />;
  }

  return <DmPeerAvatar channel={channel} fallbackName={title} size={size} style={style} />;
}

function DmPeerAvatar({
  channel,
  fallbackName,
  size,
  style,
}: {
  channel: MmChannel;
  fallbackName: string;
  size: number;
  style?: StyleProp<ViewStyle>;
}) {
  const { user } = useAuth();
  // Shared with the chat-detail screen via the canonical
  // ``useChannelMembers`` hook — both consumers go through the same
  // query shape, so the cache can't get clobbered into an unexpected
  // shape by whoever mounts last.
  const members = useChannelMembers(channel.channel_id);
  const peer = pickPeer(members, user?.id ?? null);
  const name = peer?.display_name ?? peer?.agent_id ?? fallbackName;

  return <Avatar uri={peer?.avatar?.url} name={name} size={size} style={style} />;
}

function pickPeer(members: MmChannelMember[], selfId: number | null): MmChannelMember | null {
  // Prefer any non-self member. Agents are always non-self; human members
  // get compared against the viewer's id. Falls back to the first member
  // when only self is present (degenerate case — shouldn't happen in
  // production but keeps the renderer safe).
  const other = members.find(
    (m) => m.agent_id != null || (m.human_id != null && m.human_id !== selfId),
  );
  return other ?? members[0] ?? null;
}
