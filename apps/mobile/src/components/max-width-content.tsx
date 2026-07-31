import { type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useIsLargeWindow } from '@/hooks/use-window-size-class';

interface MaxWidthContentProps {
  children: ReactNode;
  /**
   *  Max content width applied when the window is ≥600dp. Forms read
   *  best at ~560, settings panels at ~720, reading content at ~640.
   */
  maxWidth?: number;
  /**
   *  When ``true`` and the window is ≥600dp, pad the top of the inner
   *  container by the status-bar inset. Use this for screens that present
   *  as a full-page ``modal`` at medium+ (see ``adaptiveSheetOptions``)
   *  — those go edge-to-edge under the status bar and have no nav header
   *  to push content down. Screens with their own nav header (settings
   *  tabs, the chats stack) should leave this off so they don't
   *  double-pad.
   */
  insetTopWhenLarge?: boolean;
  /** Style merged onto the outer (centering) container. */
  style?: StyleProp<ViewStyle>;
  /** Style merged onto the inner (constrained) container. */
  contentStyle?: StyleProp<ViewStyle>;
}

/**
 *  Centers children with a max width on foldable inner displays and
 *  tablets; pass-through (no constraint) on phones in portrait.
 *
 *  Use for forms, settings, and other narrow long-form layouts that
 *  would otherwise stretch awkwardly across an 800dp+ inner display.
 *  Two-pane / dashboard layouts should NOT use this — they want to use
 *  the full width.
 */
export function MaxWidthContent({
  children,
  maxWidth = 560,
  insetTopWhenLarge = false,
  style,
  contentStyle,
}: MaxWidthContentProps) {
  const isLarge = useIsLargeWindow();
  const insets = useSafeAreaInsets();

  if (!isLarge) {
    return <View style={[styles.fill, style]}>{children}</View>;
  }

  return (
    <View style={[styles.center, style]}>
      <View
        style={[
          styles.inner,
          { maxWidth },
          insetTopWhenLarge && { paddingTop: insets.top },
          contentStyle,
        ]}>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: 'center',
    flex: 1,
  },
  fill: {
    flex: 1,
  },
  inner: {
    flex: 1,
    width: '100%',
  },
});
