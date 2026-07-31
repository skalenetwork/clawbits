import { SymbolView, type AndroidSymbol } from 'expo-symbols';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import type { SFSymbol } from 'sf-symbols-typescript';

import { PressableScale } from '@/components/pressable-scale';
import { useTheme } from '@/hooks/use-theme';

export interface DetailsAction {
  /** Stable id — used as the React key. */
  key: string;
  symbol: { ios: SFSymbol; android: AndroidSymbol };
  label: string;
  /** Tapping the button. Pass a no-op to render the button as a visual
   *  placeholder (still announces "button" to a11y, still scales on
   *  press — but does nothing). */
  onPress: () => void;
  /** Tint the action red for destructive operations like Leave / Block.
   *  Affects both the icon and the label color. */
  destructive?: boolean;
  /** Dim the action to ~50% to indicate it isn't wired up yet. The
   *  current pass renders these as visual placeholders; the prop is
   *  here so we can dim them in dev builds without changing the layout. */
  disabled?: boolean;
  /** Replace the icon with a spinner and suppress further taps while
   *  the underlying mutation is in flight. Used for actions whose
   *  network round trip is user-visible (Leave, Add) so the row never
   *  reads as "did my tap register?". */
  loading?: boolean;
}

interface DetailsActionRowProps {
  actions: readonly DetailsAction[];
}

/**
 * Horizontal row of large circular icon buttons under the hero — Mute,
 * Search, Pin, Leave, etc. Each button is a square tile with a circular
 * icon affordance and a tiny label below it (Apple Contacts / iOS Music
 * detail-screen idiom).
 *
 * Buttons grow to fill the row evenly, so the same component works for
 * 3 actions (DM) or 5 actions (channel) without per-call sizing. Up to
 * 5 actions fit comfortably on a 360dp phone; beyond that the labels
 * will start to truncate.
 */
export function DetailsActionRow({ actions }: DetailsActionRowProps) {
  const theme = useTheme();

  return (
    <View style={styles.row}>
      {actions.map((action) => {
        const tint = action.destructive ? theme.destructive : theme.text;
        const opacity = action.disabled ? 0.45 : 1;
        // Suppress taps while a mutation is in flight so a double-tap
        // can't queue a second request that races the first.
        const onPress = action.loading ? undefined : action.onPress;
        return (
          <PressableScale
            key={action.key}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            accessibilityState={{ busy: action.loading, disabled: action.disabled }}
            onPress={onPress}
            pressedScale={0.92}
            style={[styles.tile, { opacity }]}>
            <View
              style={[
                styles.icon,
                { backgroundColor: theme.backgroundElement },
              ]}>
              {action.loading ? (
                <ActivityIndicator color={tint} />
              ) : (
                <SymbolView
                  name={action.symbol}
                  size={22}
                  tintColor={tint}
                  weight="semibold"
                  style={styles.symbol}
                />
              )}
            </View>
            <Text
              style={[styles.label, { color: tint }]}
              numberOfLines={1}>
              {action.label}
            </Text>
          </PressableScale>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  icon: {
    alignItems: 'center',
    borderRadius: 22,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  label: {
    fontSize: 12,
    fontWeight: '500',
    letterSpacing: -0.05,
    marginTop: 6,
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
  },
  symbol: {
    height: 22,
    width: 22,
  },
  tile: {
    alignItems: 'center',
    flex: 1,
    paddingVertical: 4,
  },
});
