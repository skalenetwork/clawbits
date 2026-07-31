import { useEffect } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { useTheme } from '@/hooks/use-theme';

interface SkeletonProps {
  width?: number | `${number}%`;
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * Pulsing placeholder block. Drives a single shared opacity value with
 * Reanimated worklets so the animation runs on the UI thread and stays
 * smooth even when JS is busy parsing the real payload that's about to
 * replace it. Pairs the base ``backgroundElement`` colour (the same one
 * card surfaces use) with the ``backgroundSelected`` highlight tone, so
 * the placeholder reads as a darker beat of the surrounding chrome
 * rather than a foreign element.
 */
export function Skeleton({ width, height = 16, radius = 6, style }: SkeletonProps) {
  const theme = useTheme();
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withRepeat(
      withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
  }, [progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: 0.55 + progress.value * 0.45,
  }));

  return (
    <Animated.View
      style={[
        styles.block,
        {
          backgroundColor: theme.backgroundElement,
          borderRadius: radius,
          height,
          width,
        },
        animatedStyle,
        style,
      ]}
    />
  );
}

/** Convenience wrapper that lays out children with a consistent gutter. */
export function SkeletonGroup({
  children,
  style,
  gap = 12,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  gap?: number;
}) {
  return <View style={[{ gap }, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  block: {
    overflow: 'hidden',
  },
});
