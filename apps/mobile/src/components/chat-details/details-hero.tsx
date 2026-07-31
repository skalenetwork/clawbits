import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { SymbolView } from 'expo-symbols';
import { type ReactNode } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { ChannelAvatar } from '@/components/channel-avatar';
import { useTheme } from '@/hooks/use-theme';
import type { MmChannel } from '@/lib/api';
import { formatChannelTitle } from '@/lib/formatting';

const AVATAR_SIZE = 112;

interface DetailsHeroProps {
  channel: MmChannel;
  /** Right side of the subtitle row — e.g. "14 members" for a channel,
   *  "Online" / "Last seen 2h ago" for a DM peer. */
  subtitleSuffix?: string;
}

/**
 * Hero block at the top of the chat-details screen.
 *
 * Composition mirrors a modern iOS / Material 3 contact-card layout: a
 * large rounded-square avatar centered above a tightly-tracked name,
 * then a "type chip" row (public/private/direct icon + subtitle) that
 * gives the channel an identity at a glance.
 *
 * On iOS 26 the surface uses ``GlassView`` for the liquid-glass
 * material; iOS 17 falls back to a system-chrome ``BlurView``; Android
 * uses a flat ``backgroundElement`` surface (Material 3 doesn't have a
 * direct glass equivalent and the tinted tonal surface reads as the
 * native idiom anyway).
 */
export function DetailsHero({ channel, subtitleSuffix }: DetailsHeroProps) {
  const theme = useTheme();
  const isDirect = channel.channel_type === 'direct';
  const rawName = channel.display_name ?? channel.name;
  const title = isDirect ? rawName : formatChannelTitle(rawName);

  const typeLabel =
    channel.channel_type === 'public'
      ? 'Public channel'
      : channel.channel_type === 'private'
        ? 'Private channel'
        : 'Direct message';

  const typeIcon =
    channel.channel_type === 'public'
      ? { ios: 'number' as const, android: 'tag' as const }
      : channel.channel_type === 'private'
        ? { ios: 'lock.fill' as const, android: 'lock' as const }
        : { ios: 'person.fill' as const, android: 'person' as const };

  return (
    <HeroSurface>
      <ChannelAvatar channel={channel} size={AVATAR_SIZE} style={styles.avatar} />
      <Text style={[styles.title, { color: theme.text }]} numberOfLines={2}>
        {title}
      </Text>
      <View style={styles.subtitleRow}>
        <SymbolView
          name={typeIcon}
          size={14}
          tintColor={theme.textSecondary}
          weight="semibold"
          style={styles.subtitleIcon}
        />
        <Text style={[styles.subtitle, { color: theme.textSecondary }]} numberOfLines={1}>
          {typeLabel}
          {subtitleSuffix ? ` · ${subtitleSuffix}` : ''}
        </Text>
      </View>
    </HeroSurface>
  );
}

/** Wraps the hero content in the right material surface for the
 *  platform — liquid glass on iOS 26, system blur on older iOS,
 *  flat tonal background on Android. */
function HeroSurface({ children }: { children: ReactNode }) {
  const theme = useTheme();

  if (Platform.OS === 'ios' && isLiquidGlassAvailable()) {
    return (
      <GlassView glassEffectStyle="regular" style={styles.surface}>
        <View style={styles.inner}>{children}</View>
      </GlassView>
    );
  }

  if (Platform.OS === 'ios') {
    return (
      <BlurView tint="systemChromeMaterial" intensity={50} style={styles.surface}>
        <View style={styles.inner}>{children}</View>
      </BlurView>
    );
  }

  return (
    <View style={[styles.surface, { backgroundColor: theme.backgroundElement }]}>
      <View style={styles.inner}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: {
    borderRadius: AVATAR_SIZE / 2,
    height: AVATAR_SIZE,
    marginBottom: 16,
    width: AVATAR_SIZE,
  },
  inner: {
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 28,
  },
  subtitle: {
    fontSize: 14,
    fontWeight: '500',
    letterSpacing: -0.1,
  },
  subtitleIcon: {
    height: 14,
    width: 14,
  },
  subtitleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  surface: {
    borderRadius: 24,
    overflow: 'hidden',
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    letterSpacing: -0.5,
    marginBottom: 8,
    textAlign: 'center',
  },
});
