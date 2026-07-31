import { SymbolView } from 'expo-symbols';
import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/hooks/use-theme';

/**
 *  Placeholder for the right (detail) pane of the two-pane chats layout
 *  when no channel is selected. Rendered by ``chats/index.tsx`` at
 *  ≥600dp where the actual chats list lives in the left column.
 */
export function EmptyDetailState() {
  const theme = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <SymbolView
        name={{ ios: 'message', android: 'chat' }}
        size={56}
        tintColor={theme.textSecondary}
        weight="medium"
        style={styles.symbol}
      />
      <Text style={[styles.title, { color: theme.text }]}>Select a chat</Text>
      <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
        Pick a conversation from the list to start messaging.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    flex: 1,
    gap: 8,
    justifyContent: 'center',
    paddingHorizontal: 48,
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  symbol: {
    height: 56,
    marginBottom: 12,
    width: 56,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.2,
    textAlign: 'center',
  },
});
