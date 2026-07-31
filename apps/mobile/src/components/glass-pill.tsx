import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { SymbolView, type AndroidSymbol } from 'expo-symbols';
import type { ReactNode } from 'react';
import type { SFSymbol } from 'sf-symbols-typescript';
import { Pressable, StyleSheet, View, type ColorValue } from 'react-native';

import { useTheme } from '@/hooks/use-theme';

export interface GlassPillAction {
  symbol: { ios: SFSymbol; android: AndroidSymbol };
  accessibilityLabel: string;
  onPress: () => void;
}

interface GlassPillProps {
  actions: GlassPillAction[];
  /**
   * Visual surface for the pill. `'transparent'` (default) renders just the
   * pressable icon row — designed for use inside the native nav bar's
   * `headerRight` slot where iOS 26 auto-applies liquid glass. `'glass'`
   * wraps the row in our own glass capsule for use outside the nav bar
   * (e.g. the image lightbox toolbar), falling back to `BlurView` on
   * pre-iOS-26 devices and a plain `View` on Android.
   */
  surface?: 'transparent' | 'glass';
  /** Symbol tint override. Defaults to `theme.text`. */
  tintColor?: ColorValue;
}

/**
 * Bar-button row designed for use in the native nav bar's `headerRight` slot.
 * iOS 26 auto-applies liquid glass to nav bar items, so wrapping these in our
 * own `GlassView` produced a visible double-border. We render the pressable
 * icons directly and let UIKit handle the glass treatment — unless the caller
 * opts into `surface="glass"` for use outside a nav bar.
 */
export function GlassPill({
  actions,
  surface = 'transparent',
  tintColor,
}: GlassPillProps) {
  const theme = useTheme();
  const resolvedTint = tintColor ?? theme.text;

  const row = (
    <View style={styles.row}>
      {actions.map((action, idx) => (
        <Pressable
          key={idx}
          accessibilityRole="button"
          accessibilityLabel={action.accessibilityLabel}
          hitSlop={10}
          onPress={action.onPress}
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
          <SymbolView
            name={action.symbol}
            size={20}
            tintColor={resolvedTint}
            weight="medium"
            style={styles.symbol}
          />
        </Pressable>
      ))}
    </View>
  );

  if (surface === 'transparent') return row;
  return <GlassCapsule>{row}</GlassCapsule>;
}

function GlassCapsule({ children }: { children: ReactNode }) {
  if (process.env.EXPO_OS === 'ios' && isLiquidGlassAvailable()) {
    return (
      <GlassView glassEffectStyle="regular" isInteractive style={styles.capsule}>
        {children}
      </GlassView>
    );
  }
  if (process.env.EXPO_OS === 'ios') {
    return (
      <BlurView tint="systemChromeMaterial" intensity={60} style={styles.capsule}>
        {children}
      </BlurView>
    );
  }
  return <View style={[styles.capsule, styles.capsuleFallbackBg]}>{children}</View>;
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    height: 48,
    justifyContent: 'center',
    minWidth: 48,
    paddingHorizontal: 12,
  },
  capsule: {
    borderRadius: 999,
    overflow: 'hidden',
  },
  capsuleFallbackBg: {
    backgroundColor: 'rgba(60, 60, 67, 0.6)',
  },
  pressed: {
    opacity: 0.6,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
  },
  symbol: {
    height: 20,
    width: 20,
  },
});
