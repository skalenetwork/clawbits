import { Link } from 'expo-router';
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ChannelAvatar } from '@/components/channel-avatar';
import { GlassCard } from '@/components/home/glass-card';
import { PressableScale } from '@/components/pressable-scale';
import { useTheme } from '@/hooks/use-theme';
import { type MmChannel } from '@/lib/api';
import { formatChannelTitle } from '@/lib/formatting';
import { rankJumpBackIn } from '@/lib/jump-back-in';
import { useAuth } from '@/providers/auth-provider';

const AVATAR_SIZE = 40;
const CARD_RADIUS = 20;

interface JumpBackInProps {
  channels: MmChannel[];
}

/** "Jump back in" — a compact 2-column grid of the top conversations to
 *  resume, mirroring the web home. Each card is a liquid-glass surface.
 *  Hidden entirely when there's nothing to surface. */
export function JumpBackIn({ channels }: JumpBackInProps) {
  const { user } = useAuth();
  const ranked = useMemo(
    () => rankJumpBackIn(channels, user?.id ?? null),
    [channels, user?.id],
  );

  if (ranked.length === 0) return null;

  return (
    <View style={styles.grid}>
      {ranked.map((channel) => (
        <JumpCard key={channel.channel_id} channel={channel} />
      ))}
    </View>
  );
}

function JumpCard({ channel }: { channel: MmChannel }) {
  const theme = useTheme();
  const isDirect = channel.channel_type === 'direct';
  const raw = channel.display_name ?? channel.name;
  const title = isDirect ? raw : formatChannelTitle(raw);

  const unread = channel.unread_count ?? 0;
  const muted = channel.muted ?? false;
  const showBadge = unread > 0;
  const strongUnread = showBadge && !muted;

  return (
    <Link
      href={{
        pathname: '/chats/[channelId]',
        params: { channelId: channel.channel_id },
      }}
      asChild>
      <PressableScale
        accessibilityRole="link"
        accessibilityLabel={title}
        pressedScale={0.97}
        pressedOpacity={0.92}
        style={styles.cardWrap}>
        <GlassCard radius={CARD_RADIUS} style={styles.card}>
          <View style={styles.avatarWrap}>
            <ChannelAvatar
              channel={channel}
              size={AVATAR_SIZE}
              style={styles.avatar}
            />
            {showBadge && (
              <View
                style={[
                  styles.badge,
                  {
                    backgroundColor: strongUnread
                      ? theme.text
                      : theme.backgroundSelected,
                    borderColor: theme.background,
                  },
                ]}>
                <Text
                  style={[
                    styles.badgeText,
                    {
                      color: strongUnread ? theme.background : theme.textSecondary,
                    },
                  ]}>
                  {unread > 99 ? '99+' : unread}
                </Text>
              </View>
            )}
          </View>
          <Text
            style={[
              styles.title,
              { color: theme.text, fontWeight: strongUnread ? '600' : '500' },
            ]}
            numberOfLines={1}>
            {title}
          </Text>
          <Text
            style={[styles.preview, { color: theme.textSecondary }]}
            numberOfLines={1}>
            {previewText(channel)}
          </Text>
        </GlassCard>
      </PressableScale>
    </Link>
  );
}

function previewText(channel: MmChannel): string {
  const text = channel.last_message_text?.trim();
  if (text) return text;
  const count = channel.last_message_attachment_count ?? 0;
  if (count > 0) return count === 1 ? 'Attachment' : `${count} attachments`;
  return 'No messages yet';
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    justifyContent: 'space-between',
  },
  cardWrap: {
    width: '48%',
  },
  card: {
    gap: 10,
    padding: 14,
  },
  avatarWrap: {
    position: 'relative',
    width: AVATAR_SIZE,
  },
  avatar: {
    borderRadius: AVATAR_SIZE / 2,
  },
  badge: {
    alignItems: 'center',
    borderRadius: 9,
    borderWidth: 2,
    height: 18,
    justifyContent: 'center',
    minWidth: 18,
    paddingHorizontal: 4,
    position: 'absolute',
    right: -7,
    top: -7,
  },
  badgeText: {
    fontSize: 10,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  title: {
    fontSize: 15,
    letterSpacing: -0.2,
  },
  preview: {
    fontSize: 12,
    letterSpacing: -0.1,
  },
});
