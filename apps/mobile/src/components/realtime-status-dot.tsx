import { SymbolView } from 'expo-symbols';
import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { useTheme } from '@/hooks/use-theme';
import { useRealtimeStatus } from '@/providers/realtime-provider';

const VISIBLE_AFTER_MS = 2000;
const FADE_IN_MS = 200;
const FADE_OUT_MS = 150;
const ROTATE_MS = 1100;
const GLYPH_SIZE = 13;

/**
 * Tiny rotating "syncing" indicator that appears next to the screen
 * title while the realtime connection is taking longer than 2s to
 * (re)connect. Reads as "we're working on it" rather than the previous
 * amber dot — which felt alarming for the common case of a brief
 * network blip.
 *
 * Stays invisible during the normal sub-second handshake so quick
 * reconnects don't flicker the UI. Fades back out the instant the
 * stream goes ``open`` — or the user signs out / backgrounds the app
 * (status ``idle``). The component name is kept as ``RealtimeStatusDot``
 * for import-stability across the screens that mount it; the dot is
 * just no longer literally a dot.
 */
export function RealtimeStatusDot() {
  const theme = useTheme();
  const status = useRealtimeStatus();
  const isReconnecting = status === 'connecting' || status === 'reconnecting';
  const opacity = useSharedValue(0);
  const rotation = useSharedValue(0);

  useEffect(() => {
    if (!isReconnecting) {
      opacity.value = withTiming(0, { duration: FADE_OUT_MS });
      cancelAnimation(rotation);
      return undefined;
    }
    const timer = setTimeout(() => {
      opacity.value = withTiming(1, { duration: FADE_IN_MS });
      rotation.value = 0;
      rotation.value = withRepeat(
        withTiming(360, { duration: ROTATE_MS, easing: Easing.linear }),
        -1,
        false,
      );
    }, VISIBLE_AFTER_MS);
    return () => {
      clearTimeout(timer);
      opacity.value = withTiming(0, { duration: FADE_OUT_MS });
      cancelAnimation(rotation);
    };
  }, [isReconnecting, opacity, rotation]);

  const containerStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  const spinnerStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.wrap, containerStyle]}
      accessibilityRole="image"
      accessibilityLabel="Reconnecting">
      <Animated.View style={spinnerStyle}>
        <SymbolView
          name={{ ios: 'arrow.triangle.2.circlepath', android: 'sync' }}
          size={GLYPH_SIZE}
          tintColor={theme.textSecondary}
          weight="semibold"
        />
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
  },
});
