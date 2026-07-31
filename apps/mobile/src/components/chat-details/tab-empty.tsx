import { SymbolView, type AndroidSymbol } from 'expo-symbols';
import { StyleSheet, Text, View } from 'react-native';
import type { SFSymbol } from 'sf-symbols-typescript';

import { useTheme } from '@/hooks/use-theme';

interface TabEmptyProps {
  symbol: { ios: SFSymbol; android: AndroidSymbol };
  title: string;
  subtitle: string;
}

/**
 * Shared empty-state row for the chat-details tab content (Media,
 * Files, Links, Members). Quiet — symbol on a circle, one-line title,
 * subtitle. Mirrors the visual register of ``SignInEmptyState`` so
 * empty tabs read as "nothing here yet", not "something is broken".
 */
export function TabEmpty({ symbol, title, subtitle }: TabEmptyProps) {
  const theme = useTheme();
  return (
    <View style={styles.wrap}>
      <View
        style={[
          styles.iconCircle,
          { backgroundColor: theme.backgroundElement },
        ]}>
        <SymbolView
          name={symbol}
          size={28}
          tintColor={theme.textSecondary}
          weight="medium"
        />
      </View>
      <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
      <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
        {subtitle}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  iconCircle: {
    alignItems: 'center',
    borderRadius: 32,
    height: 64,
    justifyContent: 'center',
    marginBottom: 16,
    width: 64,
  },
  subtitle: {
    fontSize: 14,
    letterSpacing: -0.1,
    lineHeight: 20,
    maxWidth: 280,
    textAlign: 'center',
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
    letterSpacing: -0.2,
    marginBottom: 4,
  },
  wrap: {
    alignItems: 'center',
    paddingVertical: 36,
  },
});
