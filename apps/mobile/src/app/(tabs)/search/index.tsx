import { Stack } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { SearchView } from '@/components/search/search-view';
import { useTheme } from '@/hooks/use-theme';

/** Left-aligned header title, matching Home/Chats/Settings. */
function SearchTitle() {
  const theme = useTheme();
  return (
    <View style={styles.titleSlot}>
      <Text style={[styles.title, { color: theme.text }]} numberOfLines={1}>
        Search
      </Text>
    </View>
  );
}

export default function SearchTab() {
  return (
    <>
      <Stack.Screen options={{ headerTitle: () => <SearchTitle /> }} />
      <SearchView />
    </>
  );
}

const styles = StyleSheet.create({
  title: {
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  titleSlot: {
    alignItems: 'flex-start',
    flex: 1,
    width: '100%',
  },
});
