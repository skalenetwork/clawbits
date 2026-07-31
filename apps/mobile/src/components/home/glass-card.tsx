import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '@/hooks/use-theme';

interface GlassCardProps {
  children: ReactNode;
  /** Corner radius for the surface. */
  radius?: number;
  /** Extra styles merged into the card wrapper — padding, gap, width, etc. */
  style?: StyleProp<ViewStyle>;
}

/**
 * iOS-26 liquid glass surface with graceful fallbacks.
 *
 * On iOS 26+ uses ``GlassView`` (true SwiftUI liquid glass); on older iOS
 * falls back to ``BlurView`` with ``systemChromeMaterial``; on Android —
 * where neither effect is available — renders as a flat themed surface so
 * the layout still reads as a card.
 */
export function GlassCard({ children, radius = 24, style }: GlassCardProps) {
  const theme = useTheme();

  if (process.env.EXPO_OS === 'ios' && isLiquidGlassAvailable()) {
    return (
      <GlassView
        glassEffectStyle="regular"
        style={[styles.card, { borderRadius: radius }, style]}>
        {children}
      </GlassView>
    );
  }

  if (process.env.EXPO_OS === 'ios') {
    return (
      <BlurView
        tint="systemChromeMaterial"
        intensity={70}
        style={[styles.card, { borderRadius: radius }, style]}>
        {children}
      </BlurView>
    );
  }

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.backgroundElement, borderRadius: radius },
        style,
      ]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    overflow: 'hidden',
  },
});
