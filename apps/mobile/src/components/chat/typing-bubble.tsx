import { memo, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { useTheme } from '@/hooks/use-theme';

const INCOMING_LIGHT = '#E9E9EB';
const INCOMING_DARK = '#262628';
const DOT_DURATION = 500;
const DOT_DELAY = 160;

export const TypingBubble = memo(function TypingBubble() {
  const theme = useTheme();
  const scheme = useColorScheme();
  const bg = scheme === 'dark' ? INCOMING_DARK : INCOMING_LIGHT;

  return (
    <View style={styles.row}>
      <View style={[styles.bubble, { backgroundColor: bg }]}>
        <Dot delay={0} color={theme.textSecondary} />
        <Dot delay={DOT_DELAY} color={theme.textSecondary} />
        <Dot delay={DOT_DELAY * 2} color={theme.textSecondary} />
      </View>
    </View>
  );
});

function Dot({ delay, color }: { delay: number; color: string }) {
  const opacity = useSharedValue(0.3);
  const translateY = useSharedValue(0);

  useEffect(() => {
    const config = { duration: DOT_DURATION, easing: Easing.inOut(Easing.quad) };
    const loop = () => {
      opacity.value = withRepeat(
        withSequence(withTiming(1, config), withTiming(0.3, config)),
        -1,
      );
      translateY.value = withRepeat(
        withSequence(withTiming(-3, config), withTiming(0, config)),
        -1,
      );
    };
    const timeout = setTimeout(loop, delay);
    return () => {
      clearTimeout(timeout);
      opacity.value = 0.3;
      translateY.value = 0;
    };
  }, [delay, opacity, translateY]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  return <Animated.View style={[styles.dot, { backgroundColor: color }, animatedStyle]} />;
}

const styles = StyleSheet.create({
  bubble: {
    alignItems: 'center',
    borderBottomLeftRadius: 5,
    borderBottomRightRadius: 18,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    flexDirection: 'row',
    gap: 5,
    height: 36,
    paddingHorizontal: 14,
  },
  dot: {
    borderRadius: 999,
    height: 7,
    width: 7,
  },
  row: {
    alignItems: 'flex-start',
    marginTop: 8,
    paddingLeft: 44,
    paddingRight: 12,
  },
});
