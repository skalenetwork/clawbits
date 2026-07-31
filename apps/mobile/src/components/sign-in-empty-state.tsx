import { SymbolView, type AndroidSymbol } from 'expo-symbols';
import { router } from 'expo-router';
import type { SFSymbol } from 'sf-symbols-typescript';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/hooks/use-theme';

interface SignInEmptyStateProps {
  symbol: { ios: SFSymbol; android: AndroidSymbol };
  title: string;
  subtitle: string;
  buttonLabel?: string;
}

export function SignInEmptyState({
  symbol,
  title,
  subtitle,
  buttonLabel = 'Sign In or Create Account',
}: SignInEmptyStateProps) {
  const theme = useTheme();

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <SymbolView
          name={symbol}
          size={64}
          tintColor={theme.textSecondary}
          weight="medium"
          style={styles.symbol}
        />
        <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
        <Text style={[styles.subtitle, { color: theme.textSecondary }]}>{subtitle}</Text>
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={() => router.push('/sign-in')}
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: theme.text, opacity: pressed ? 0.85 : 1 },
        ]}>
        <Text style={[styles.buttonLabel, { color: theme.background }]}>{buttonLabel}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    alignSelf: 'center',
    borderRadius: 999,
    justifyContent: 'center',
    minHeight: 52,
    paddingHorizontal: 28,
  },
  buttonLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
  container: {
    alignItems: 'center',
    flex: 1,
    gap: 24,
    justifyContent: 'center',
    paddingBottom: 64,
    paddingHorizontal: 32,
  },
  content: {
    alignItems: 'center',
    gap: 12,
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  symbol: {
    height: 64,
    marginBottom: 8,
    width: 64,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
  },
});
