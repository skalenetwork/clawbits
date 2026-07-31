import { SymbolView, type AndroidSymbol } from 'expo-symbols';
import type { SFSymbol } from 'sf-symbols-typescript';
import { Pressable, StyleSheet } from 'react-native';

const DANGER = '#FF453A';

interface DangerPillProps {
  symbol: { ios: SFSymbol; android: AndroidSymbol };
  accessibilityLabel: string;
  onPress: () => void;
}

/**
 * Destructive bar-button for the native nav bar `headerRight` slot. iOS 26
 * auto-applies liquid glass to nav bar items, so we render the pressable icon
 * directly without wrapping in our own GlassView.
 */
export function DangerPill({ symbol, accessibilityLabel, onPress }: DangerPillProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
      <SymbolView
        name={symbol}
        size={20}
        tintColor={DANGER}
        weight="semibold"
        style={styles.symbol}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    height: 44,
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  pressed: {
    opacity: 0.6,
  },
  symbol: {
    height: 20,
    width: 20,
  },
});
