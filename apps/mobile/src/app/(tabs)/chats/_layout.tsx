import Stack from 'expo-router/stack';
import { useSegments } from 'expo-router';
import { StyleSheet, View, useWindowDimensions } from 'react-native';

import { ChannelListPane } from '@/components/chats/channel-list-pane';
import { useIsLargeWindow } from '@/hooks/use-window-size-class';
import { useTheme } from '@/hooks/use-theme';

/**
 *  At ≥600dp we render a two-pane layout: the chats list pinned to a
 *  left column, the existing Stack on the right hosting either the
 *  empty-detail state (``chats/index.tsx`` swaps to it at medium+) or
 *  the active chat (``chats/[channelId].tsx``). At compact we keep the
 *  single-Stack behavior so the phone UX is unchanged.
 *
 *  The Stack JSX is intentionally inlined in both branches rather than
 *  hoisted to a shared constant — ``react-navigation`` reads Stack
 *  children directly (not through ``React.Children.map``), so wrapping
 *  the Screens in a Fragment crashes it with "Cannot convert Symbol to
 *  string" when it tries to read the Fragment's symbol type as a name.
 */
export default function ChatsLayout() {
  const theme = useTheme();
  const isLarge = useIsLargeWindow();
  const { width: windowWidth } = useWindowDimensions();
  // Cast to a plain string array: with typed routes, `useSegments()` is a
  // union of per-route tuples (some length 2), so indexing `[2]` doesn't
  // typecheck even though the channel id is present at runtime.
  const segments = useSegments() as string[];
  // segments inside ``(tabs)/chats/_layout`` look like:
  //   /chats          → ['(tabs)', 'chats']
  //   /chats/xyz      → ['(tabs)', 'chats', 'xyz']
  // We pluck the channel id from index 2.
  const selectedChannelId = segments[2];
  // Drop the ``[channelId]`` placeholder that expo-router occasionally
  // surfaces when no concrete route is matched yet.
  const activeChannelId =
    selectedChannelId && !selectedChannelId.startsWith('[')
      ? selectedChannelId
      : undefined;

  const stackScreenOptions = {
    headerTransparent: true,
    headerTitleAlign: 'left' as const,
    headerShadowVisible: false,
    scrollEdgeEffects: { top: 'soft' as const },
  };

  if (!isLarge) {
    return (
      <Stack screenOptions={stackScreenOptions}>
        <Stack.Screen name="index" />
        <Stack.Screen name="[channelId]" options={{ title: 'Chat' }} />
      </Stack>
    );
  }

  const listPaneWidth = pickListPaneWidth(windowWidth);

  return (
    <View style={styles.row}>
      <View
        style={[
          styles.listColumn,
          {
            width: listPaneWidth,
            borderRightColor: theme.backgroundSelected,
          },
        ]}>
        <ChannelListPane
          variant="sidebar"
          selectedChannelId={activeChannelId}
          paneWidth={listPaneWidth}
        />
      </View>
      <View style={styles.flex}>
        <Stack screenOptions={stackScreenOptions}>
          <Stack.Screen name="index" />
          <Stack.Screen name="[channelId]" options={{ title: 'Chat' }} />
        </Stack>
      </View>
    </View>
  );
}

/**
 *  Sizes the list pane so the chat detail on the right stays usable
 *  even on smaller foldable inner displays. Hand-tuned breakpoints:
 *
 *   - <700dp (Fold inner portrait, ~673dp): 260dp list → ~333dp detail
 *   - <900dp (small tablet portrait):       300dp list → ~520dp detail
 *   - ≥900dp (tablet landscape, desktop):   360dp list → 540dp+ detail
 *
 *  Assumes the navigation rail on the parent already consumes ~80dp.
 */
function pickListPaneWidth(windowWidth: number): number {
  if (windowWidth < 700) return 260;
  if (windowWidth < 900) return 300;
  return 360;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  listColumn: {
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  row: { flex: 1, flexDirection: 'row' },
});
