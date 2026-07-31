import { router, useSegments } from 'expo-router';
import { SymbolView, type AndroidSymbol } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { SFSymbol } from 'sf-symbols-typescript';

import { useTheme } from '@/hooks/use-theme';

interface RailItem {
  key: 'home' | 'chats' | 'search' | 'settings';
  href: '/home' | '/chats' | '/search' | '/settings';
  label: string;
  symbol: { ios: SFSymbol; android: AndroidSymbol };
  symbolSelected: { ios: SFSymbol; android: AndroidSymbol };
}

const RAIL_ITEMS: readonly RailItem[] = [
  {
    key: 'home',
    href: '/home',
    label: 'Home',
    symbol: { ios: 'circle.grid.2x2', android: 'apps' },
    symbolSelected: { ios: 'circle.grid.2x2.fill', android: 'apps' },
  },
  {
    key: 'chats',
    href: '/chats',
    label: 'Chats',
    symbol: { ios: 'message', android: 'chat' },
    symbolSelected: { ios: 'message.fill', android: 'chat' },
  },
  {
    key: 'search',
    href: '/search',
    label: 'Search',
    symbol: { ios: 'magnifyingglass', android: 'search' },
    symbolSelected: { ios: 'magnifyingglass', android: 'search' },
  },
  {
    key: 'settings',
    href: '/settings',
    label: 'Settings',
    symbol: { ios: 'gearshape.2', android: 'settings_suggest' },
    symbolSelected: { ios: 'gearshape.2.fill', android: 'settings_suggest' },
  },
];

export const NAVIGATION_RAIL_WIDTH = 80;

/**
 * Material 3 navigation rail — vertical sidebar that replaces the bottom
 * tab bar at ≥600dp. Reads the active tab from ``useSegments()`` (the
 * second segment under the ``(tabs)`` group), tap → ``router.navigate``.
 *
 * Sits as a sibling of a hidden ``NativeTabs`` in ``(tabs)/_layout.tsx``
 * so the native navigator continues to own per-tab screen state — the
 * rail is purely a presentation surface that issues navigation events.
 */
export function NavigationRail() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  // Cast to a plain string array: with typed routes, `useSegments()` is a
  // union of per-route tuples (some length 1), so indexing `[1]` doesn't
  // typecheck even though the runtime value is always present here.
  const segments = useSegments() as string[];
  // Inside the (tabs) layout the segments look like:
  //   /home               → ['(tabs)', 'home']
  //   /chats/xyz          → ['(tabs)', 'chats', 'xyz']
  //   /settings/profile   → ['(tabs)', 'settings', 'profile']
  // segment[1] is the active top-level tab.
  const activeKey = (segments[1] ?? 'home') as RailItem['key'];

  return (
    <View
      style={[
        styles.rail,
        {
          backgroundColor: theme.background,
          borderRightColor: theme.backgroundSelected,
          paddingTop: insets.top + 12,
          paddingBottom: insets.bottom + 12,
          paddingLeft: insets.left,
        },
      ]}>
      {RAIL_ITEMS.map((item) => {
        const selected = activeKey === item.key;
        return (
          <Pressable
            key={item.key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={item.label}
            onPress={() => router.navigate(item.href)}
            style={({ pressed }) => [
              styles.item,
              pressed && styles.itemPressed,
            ]}>
            <View
              style={[
                styles.indicator,
                selected && { backgroundColor: theme.backgroundSelected },
              ]}>
              <SymbolView
                name={selected ? item.symbolSelected : item.symbol}
                size={22}
                tintColor={selected ? theme.text : theme.textSecondary}
                weight={selected ? 'semibold' : 'regular'}
              />
            </View>
            <Text
              style={[
                styles.label,
                { color: selected ? theme.text : theme.textSecondary },
              ]}
              numberOfLines={1}>
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  indicator: {
    alignItems: 'center',
    borderRadius: 18,
    height: 36,
    justifyContent: 'center',
    width: 56,
  },
  item: {
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    width: '100%',
  },
  itemPressed: {
    opacity: 0.7,
  },
  label: {
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: -0.1,
  },
  rail: {
    alignItems: 'center',
    borderRightWidth: StyleSheet.hairlineWidth,
    gap: 12,
    width: NAVIGATION_RAIL_WIDTH,
  },
});
