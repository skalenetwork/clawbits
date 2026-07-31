import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { SymbolView } from 'expo-symbols';
import type { ReactNode } from 'react';
import {
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/hooks/use-theme';

/** Clearance ABOVE the home-indicator inset for the resting bar so it sits
 *  just over the iOS 26 floating tab bar (keyboard closed). Single tunable
 *  knob — bump if the bar overlaps the tab bar, lower for a tighter gap. */
export const SEARCH_BAR_REST = 13;
/** Horizontal inset on each side — tuned so the capsule's width matches the
 *  floating tab bar pill (which is inset from the screen edges). Single tunable
 *  knob — bump to narrow the bar, lower to widen it. */
export const SEARCH_BAR_SIDE_INSET = 20;
/** Height of the search capsule — exported so callers can reserve space. */
export const SEARCH_PILL_HEIGHT = 46;
/** Gap left above the keyboard when the bar is lifted (keyboard open). */
const FLOATING_GAP = 8;

/**
 * Docks its children just above the floating native tab bar, lifting to sit on
 * top of the keyboard when one is open. This is the SINGLE source of truth for
 * "where the search bar lives", so Home and Search place it identically.
 *
 * Reliability: the resting position is a STATIC ``bottom`` (``insets.bottom +
 * SEARCH_BAR_REST``), NOT the ``KeyboardStickyView`` ``closed`` offset. The old
 * approach animated the resting translate, which lagged on mount — flashing the
 * bar at ``bottom:0`` (under the tab bar) or overshooting (too high). With a
 * static anchor + ``closed: 0`` there's nothing to animate at rest, so the
 * position is rock-steady; ``KeyboardStickyView`` only adds the keyboard lift.
 */
export function SearchDock({
  children,
  onLayout,
}: {
  children: ReactNode;
  onLayout?: (e: LayoutChangeEvent) => void;
}) {
  const insets = useSafeAreaInsets();
  const restClearance = insets.bottom + SEARCH_BAR_REST;
  return (
    <KeyboardStickyView
      style={[styles.dock, { bottom: restClearance }]}
      // ``closed: 0`` → at rest no animated translate, the bar sits exactly at
      // the static ``bottom`` (no lag). ``opened`` cancels that bottom so the
      // bar still lands FLOATING_GAP above the keyboard top when it rises.
      offset={{ closed: 0, opened: restClearance - FLOATING_GAP }}
      onLayout={onLayout}>
      {children}
    </KeyboardStickyView>
  );
}

/** The liquid-glass search capsule: leading magnifier + caller content
 *  (placeholder text on Home, a TextInput on Search). */
export function SearchPill({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <GlassField style={styles.pill}>
      <SymbolView
        name={{ ios: 'magnifyingglass', android: 'search' }}
        tintColor={theme.textSecondary}
        size={16}
      />
      {children}
    </GlassField>
  );
}

/** Real iOS 26 liquid glass, with a blur fallback on older iOS and a solid
 *  surface on Android. Mirrors the nav-bar GlassPill so the field reads as
 *  native (like Apple Music's search). */
function GlassField({
  children,
  style,
}: {
  children: ReactNode;
  style: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  if (process.env.EXPO_OS === 'ios' && isLiquidGlassAvailable()) {
    return (
      <GlassView glassEffectStyle="regular" isInteractive style={style}>
        {children}
      </GlassView>
    );
  }
  if (process.env.EXPO_OS === 'ios') {
    return (
      <BlurView tint="systemChromeMaterial" intensity={70} style={style}>
        {children}
      </BlurView>
    );
  }
  return <View style={[style, { backgroundColor: theme.inputBg }]}>{children}</View>;
}

const styles = StyleSheet.create({
  dock: {
    // ``bottom`` is applied inline (static resting clearance) — see SearchDock.
    left: 0,
    paddingHorizontal: SEARCH_BAR_SIDE_INSET,
    position: 'absolute',
    right: 0,
  },
  pill: {
    alignItems: 'center',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 8,
    height: SEARCH_PILL_HEIGHT,
    // Clip the liquid-glass / blur surface to the capsule shape.
    overflow: 'hidden',
    paddingHorizontal: 14,
  },
});
