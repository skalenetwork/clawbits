import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { SymbolView } from 'expo-symbols';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { ChannelAvatar } from '@/components/channel-avatar';
import { useTheme } from '@/hooks/use-theme';
import { formatChannelTitle } from '@/lib/formatting';
import type { MmChannel } from '@/lib/api';

const AVATAR_SIZE = 46;

interface ChatHeaderTitleProps {
  channel: MmChannel | null;
  fallbackTitle: string;
}

export function ChatHeaderTitle({ channel, fallbackTitle }: ChatHeaderTitleProps) {
  const theme = useTheme();
  const isDirect = channel?.channel_type === 'direct';
  const rawName = channel?.display_name ?? channel?.name ?? fallbackTitle;
  const title = isDirect ? rawName : formatChannelTitle(rawName);

  const openDetails = () => {
    if (!channel) return;
    router.push({
      pathname: '/chat-details/[channelId]',
      params: { channelId: channel.channel_id },
    });
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open details for ${title}`}
      onPress={openDetails}
      disabled={!channel}
      // Whole column (avatar + name pill) is the tap target — Apple
      // Contacts / iOS Phone "contact card" idiom where tapping the
      // avatar OR the name both open the same detail surface. The
      // pressed opacity applies to the whole column so the visual
      // feedback matches the expanded tap area.
      style={({ pressed }) => [
        styles.titleWrap,
        pressed && styles.titleWrapPressed,
      ]}>
      {channel ? (
        <ChannelAvatar
          channel={channel}
          size={AVATAR_SIZE}
          style={styles.avatar}
        />
      ) : (
        <Avatar name={title} size={AVATAR_SIZE} style={styles.avatar} />
      )}
      <View style={styles.namePillWrap}>
        <GlassPill>
          <Text style={[styles.name, { color: theme.text }]} numberOfLines={1}>
            {title}
          </Text>
          <SymbolView
            name={{ ios: 'chevron.forward', android: 'chevron_right' }}
            size={12}
            tintColor={theme.textSecondary}
            weight="bold"
            style={styles.chevron}
          />
        </GlassPill>
      </View>
    </Pressable>
  );
}

interface ChatHeaderBackProps {
  unreadOtherCount: number;
}

export function ChatHeaderBack({ unreadOtherCount }: ChatHeaderBackProps) {
  const theme = useTheme();
  const showBadge = unreadOtherCount > 0;
  const badgeLabel = unreadOtherCount > 999 ? '999+' : String(unreadOtherCount);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back"
      onPress={() => router.back()}
      hitSlop={10}
      style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
      <SymbolView
        name={{ ios: 'chevron.backward', android: 'chevron_left' }}
        size={20}
        tintColor={theme.text}
        weight="semibold"
        style={styles.backIcon}
      />
      {showBadge ? (
        <View style={[styles.badge, { backgroundColor: theme.text }]}>
          <Text style={[styles.badgeText, { color: theme.background }]}>{badgeLabel}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function GlassPill({ children }: { children: ReactNode }) {
  if (process.env.EXPO_OS === 'ios' && isLiquidGlassAvailable()) {
    return (
      <GlassView glassEffectStyle="regular" style={styles.namePill}>
        <View style={styles.nameRow}>{children}</View>
      </GlassView>
    );
  }

  if (process.env.EXPO_OS === 'ios') {
    return (
      <BlurView tint="systemChromeMaterial" intensity={60} style={styles.namePill}>
        <View style={styles.nameRow}>{children}</View>
      </BlurView>
    );
  }

  return <View style={[styles.namePill, styles.nameRow]}>{children}</View>;
}

const styles = StyleSheet.create({
  avatar: {
    borderRadius: AVATAR_SIZE / 2,
    // Pull the avatar visually a touch above the name pill without
    // shrinking the layout slot — using ``transform`` instead of a
    // negative ``marginTop`` means the pill below stays put.
    transform: [{ translateY: -3 }],
    zIndex: 2,
  },
  back: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  backIcon: {
    height: 20,
    width: 20,
  },
  badge: {
    alignItems: 'center',
    borderRadius: 999,
    justifyContent: 'center',
    minWidth: 22,
    paddingHorizontal: 7,
    paddingVertical: 1,
  },
  badgeText: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  chevron: {
    height: 12,
    width: 8,
  },
  name: {
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: -0.1,
    maxWidth: 200,
  },
  namePill: {
    borderRadius: 999,
    overflow: 'hidden',
  },
  nameRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 5,
  },
  pressed: {
    opacity: 0.6,
  },
  namePillWrap: {
    marginTop: -6,
  },
  titleWrap: {
    alignItems: 'center',
    flexDirection: 'column',
    justifyContent: 'center',
    transform: [{ translateY: -4 }],
  },
  titleWrapPressed: {
    opacity: 0.75,
  },
});
