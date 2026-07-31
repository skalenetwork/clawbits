import { router } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';

import { SearchDock, SearchPill } from '@/components/search/search-dock';
import { useTheme } from '@/hooks/use-theme';
import { requestSearchFocus } from '@/lib/search-focus';

/** The home search entry — the SAME docked liquid-glass capsule the Search tab
 *  uses (shared via ``SearchDock``/``SearchPill``), so it sits in the exact
 *  same spot above the tab bar. Tapping it switches to the Search tab and
 *  immediately focuses the input. */
export function CommandBar() {
  const theme = useTheme();

  return (
    <SearchDock>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Search or jump to anything"
        onPress={() => {
          requestSearchFocus();
          router.navigate('/search');
        }}>
        <SearchPill>
          <Text
            style={[styles.placeholder, { color: theme.textSecondary }]}
            numberOfLines={1}>
            Search or jump to anything…
          </Text>
        </SearchPill>
      </Pressable>
    </SearchDock>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    flex: 1,
    fontSize: 16,
    letterSpacing: -0.2,
  },
});
