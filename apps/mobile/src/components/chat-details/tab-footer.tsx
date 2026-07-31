import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { PressableScale } from '@/components/pressable-scale';
import { useTheme } from '@/hooks/use-theme';

interface TabFooterProps {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}

/**
 * Inline "Load more" footer at the bottom of each chat-details tab.
 * Three states:
 *   - ``loading``: spinner. Shown while ``fetchNextPage`` is in flight.
 *   - ``hasMore``: tappable pill that triggers ``onLoadMore``.
 *   - neither: hidden. The list ends naturally without a "no more"
 *     message — a "no more" line under a paginated list reads as
 *     clutter and the user already knows when they've scrolled to the
 *     end.
 */
export function TabFooter({ hasMore, loading, onLoadMore }: TabFooterProps) {
  const theme = useTheme();

  if (loading) {
    return (
      <View style={styles.wrap}>
        <ActivityIndicator />
      </View>
    );
  }
  if (!hasMore) return null;
  return (
    <View style={styles.wrap}>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel="Load more"
        onPress={onLoadMore}
        pressedScale={0.96}
        style={[
          styles.pill,
          { backgroundColor: theme.backgroundElement },
        ]}>
        <Text style={[styles.label, { color: theme.text }]}>Load more</Text>
      </PressableScale>
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: -0.1,
  },
  pill: {
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 9,
  },
  wrap: {
    alignItems: 'center',
    paddingVertical: 20,
  },
});
