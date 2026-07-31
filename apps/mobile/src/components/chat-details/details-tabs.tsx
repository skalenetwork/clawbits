import { useCallback, useEffect, useState } from 'react';
import {
  LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { useTheme } from '@/hooks/use-theme';

export interface DetailsTabsTab<Value extends string> {
  value: Value;
  label: string;
  /** Optional count badge — e.g. "Media (24)". Hidden when undefined. */
  count?: number;
}

interface DetailsTabsProps<Value extends string> {
  tabs: readonly DetailsTabsTab<Value>[];
  value: Value;
  onChange: (next: Value) => void;
}

// Spring shape borrowed from PressableScale — same "lively" feel as the
// rest of the app's micro-interactions. Stiff enough that the pill
// catches up to the finger without lagging, damped enough that it
// settles instead of wobbling.
const PILL_SPRING = { mass: 0.7, damping: 18, stiffness: 240 } as const;

/**
 * iOS-style segmented control with a single sliding "pill" indicator
 * that morphs between tab positions on selection. Spring-physics
 * animation via react-native-reanimated — no LayoutAnimation, no
 * jank-prone position interpolation.
 *
 * Each tab measures its own width on layout; the pill snaps to the
 * active tab's measured rect on every tab change. This means the
 * indicator always lines up exactly under the tab label even when the
 * labels are different lengths (e.g. "Media" vs "Members") and when
 * the parent container resizes (tablet vs phone).
 *
 * No haptic on this tab change — the morphing pill is its own affordance
 * and adding a haptic per tap reads as fussy. Press-down dimming is
 * implicit via Pressable's pressed state.
 */
export function DetailsTabs<Value extends string>({
  tabs,
  value,
  onChange,
}: DetailsTabsProps<Value>) {
  const theme = useTheme();
  // ``layouts`` maps tab value → measured {x, width}. We need both per
  // tab so the indicator can be positioned with translateX (cheap on
  // the UI thread) and animate width independently.
  const [layouts, setLayouts] = useState<Record<string, { x: number; width: number }>>({});
  const pillX = useSharedValue(0);
  const pillW = useSharedValue(0);

  const onTabLayout = useCallback(
    (val: Value) => (event: LayoutChangeEvent) => {
      const { x, width } = event.nativeEvent.layout;
      setLayouts((prev) => {
        const existing = prev[val];
        if (existing && existing.x === x && existing.width === width) return prev;
        const next = { ...prev, [val]: { x, width } };
        // Seed the pill at the active tab's resting position the first
        // time its layout lands — without this, the pill stays at (0,0)
        // until the user taps something, leaving a visible jump on the
        // first interaction.
        if (val === value) {
          pillX.set(x);
          pillW.set(width);
        }
        return next;
      });
    },
    [value, pillX, pillW],
  );

  const handlePress = useCallback(
    (val: Value) => {
      onChange(val);
    },
    [onChange],
  );

  // Animate the pill whenever the active value changes — driven by the
  // `value` prop, so the pill keeps in sync whether the change came from
  // an internal tap (handlePress) or an external source (e.g. the
  // swipe-pager in chat-details). Layouts may land after the value is
  // already set, hence depending on both.
  useEffect(() => {
    const target = layouts[value];
    if (!target) return;
    pillX.set(withSpring(target.x, PILL_SPRING));
    pillW.set(withSpring(target.width, PILL_SPRING));
  }, [value, layouts, pillX, pillW]);

  const pillStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: pillX.get() }],
    width: pillW.get(),
  }));

  return (
    <View
      style={[
        styles.bar,
        { backgroundColor: theme.backgroundElement },
      ]}>
      <Animated.View
        pointerEvents="none"
        style={[
          styles.pill,
          { backgroundColor: theme.background },
          pillStyle,
        ]}
      />
      {tabs.map((tab) => {
        const isActive = tab.value === value;
        return (
          <Pressable
            key={tab.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            onPress={() => handlePress(tab.value)}
            onLayout={onTabLayout(tab.value)}
            style={({ pressed }) => [
              styles.tab,
              pressed && !isActive && styles.tabPressed,
            ]}>
            <Text
              style={[
                styles.label,
                {
                  color: isActive ? theme.text : theme.textSecondary,
                  fontWeight: isActive ? '600' : '500',
                },
              ]}
              numberOfLines={1}>
              {tab.label}
              {tab.count != null ? (
                <Text style={{ color: theme.textSecondary }}>
                  {'  '}
                  {tab.count}
                </Text>
              ) : null}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    borderRadius: 14,
    flexDirection: 'row',
    height: 40,
    padding: 4,
    position: 'relative',
  },
  label: {
    fontSize: 14,
    letterSpacing: -0.1,
  },
  pill: {
    borderRadius: 10,
    bottom: 4,
    left: 0,
    position: 'absolute',
    top: 4,
    // The pill is visually a "lifted" surface above the bar — a small
    // shadow on iOS gives it depth without looking heavy. Android skips
    // shadow here because Material 3 segmented controls are flat.
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
  },
  tab: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
  tabPressed: {
    opacity: 0.55,
  },
});
