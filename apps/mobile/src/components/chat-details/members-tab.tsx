import { StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { useChannelMembers } from '@/hooks/use-channel-members';
import { useTheme } from '@/hooks/use-theme';
import type { MmChannelMember } from '@/lib/api';

import { TabEmpty } from './tab-empty';

interface MembersTabProps {
  channelId: string;
}

/**
 * Member roster for non-DM channels. Each row: avatar + name + role
 * subtitle ("Online" / "Joined Mar 2026"). Sorted with humans first
 * then agents — matches the @mention picker's idiom so the same chat's
 * member list reads consistently across surfaces.
 *
 * No pagination: the underlying ``useChannelMembers`` query returns the
 * full member list in one call (channels are bounded; the server
 * doesn't paginate this endpoint). If a channel ever grows to
 * thousands of members we'll add cursor pagination there first.
 */
export function MembersTab({ channelId }: MembersTabProps) {
  const theme = useTheme();
  const members = useChannelMembers(channelId);

  if (members.length === 0) {
    return (
      <TabEmpty
        symbol={{ ios: 'person.2', android: 'group' }}
        title="No members yet"
        subtitle="People who join this channel will appear here."
      />
    );
  }

  const ordered = [...members].sort(orderMembers);

  return (
    <View>
      {ordered.map((member) => (
        <View
          key={memberKey(member)}
          style={[
            styles.row,
            { backgroundColor: theme.backgroundElement },
          ]}>
          <Avatar
            uri={member.avatar?.url}
            name={member.display_name}
            size={40}
          />
          <View style={styles.meta}>
            <Text style={[styles.name, { color: theme.text }]} numberOfLines={1}>
              {member.display_name ?? 'Unknown'}
            </Text>
            <Text
              style={[styles.subtitle, { color: theme.textSecondary }]}
              numberOfLines={1}>
              {memberSubtitle(member)}
            </Text>
          </View>
          {member.status === 'online' ? (
            <View style={[styles.statusDot, { backgroundColor: '#34C759' }]} />
          ) : null}
        </View>
      ))}
    </View>
  );
}

function memberKey(m: MmChannelMember): string {
  return m.human_id != null ? `h:${m.human_id}` : `a:${m.agent_id ?? 'unknown'}`;
}

function memberSubtitle(m: MmChannelMember): string {
  if (m.agent_id != null) return 'Agent';
  if (m.status === 'online') return 'Online';
  if (m.status === 'idle') return 'Idle';
  if (m.last_seen_at) {
    const then = new Date(m.last_seen_at).getTime();
    if (!Number.isNaN(then)) {
      const diff = Date.now() - then;
      if (diff < 60_000) return 'Active just now';
      if (diff < 3_600_000) return `Active ${Math.floor(diff / 60_000)}m ago`;
      if (diff < 86_400_000) return `Active ${Math.floor(diff / 3_600_000)}h ago`;
      return `Last seen ${new Date(m.last_seen_at).toLocaleDateString()}`;
    }
  }
  return 'Offline';
}

function orderMembers(a: MmChannelMember, b: MmChannelMember): number {
  // Humans before agents — matches the mention picker, where the
  // "you can talk to" set leads and the "you can summon" set follows.
  const aIsHuman = a.human_id != null;
  const bIsHuman = b.human_id != null;
  if (aIsHuman !== bIsHuman) return aIsHuman ? -1 : 1;
  // Within the same kind, online status first, then alphabetical.
  const aOnline = a.status === 'online' ? 0 : 1;
  const bOnline = b.status === 'online' ? 0 : 1;
  if (aOnline !== bOnline) return aOnline - bOnline;
  const aName = (a.display_name ?? '').toLowerCase();
  const bName = (b.display_name ?? '').toLowerCase();
  return aName.localeCompare(bName);
}

const styles = StyleSheet.create({
  meta: {
    flex: 1,
    gap: 2,
    marginLeft: 12,
  },
  name: {
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: -0.1,
  },
  row: {
    alignItems: 'center',
    borderRadius: 16,
    flexDirection: 'row',
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  statusDot: {
    borderRadius: 5,
    height: 10,
    width: 10,
  },
  subtitle: {
    fontSize: 12,
    letterSpacing: -0.05,
  },
});
