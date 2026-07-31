import { Platform, StyleSheet, View } from 'react-native';

import { useTheme } from '@/hooks/use-theme';
import { useIsLargeWindow } from '@/hooks/use-window-size-class';

/**
 * Render as the first child of any `formSheet` content. iOS gets a native
 * grabber via `sheetGrabberVisible: true` on the Stack.Screen options;
 * react-native-screens doesn't expose that prop on Android, so we draw
 * the Material 3 drag handle pill ourselves.
 *
 * Hidden at ≥600dp — at those widths the same screens present as full-page
 * ``modal`` (see ``adaptiveSheetOptions``), where a drag handle would read
 * as visual noise with no swipe-to-dismiss affordance behind it.
 */
export function SheetGrabber() {
  const theme = useTheme();
  const isLarge = useIsLargeWindow();

  if (Platform.OS !== 'android') return null;
  if (isLarge) return null;

  return (
    <View style={styles.container} pointerEvents="none">
      <View style={[styles.pill, { backgroundColor: theme.backgroundSelected }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingBottom: 6,
    paddingTop: 10,
  },
  pill: {
    borderRadius: 2,
    height: 4,
    width: 36,
  },
});
