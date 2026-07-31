import type { ComponentProps } from 'react';
import { useWindowDimensions } from 'react-native';

import type { Stack } from 'expo-router';

/**
 *  Material 3 / Jetpack WindowManager 1.5 width size classes.
 *
 *   - ``compact``    < 600dp  — phones in portrait, foldable cover screens
 *   - ``medium``    600–839dp — phones in landscape, foldable inner displays
 *                                in portrait, small tablets
 *   - ``expanded``  840–1199dp — tablets in landscape, foldable inner
 *                                displays in landscape
 *   - ``large``    1200–1599dp — large tablets, small desktops
 *   - ``extraLarge``  ≥1600dp — desktops, ultra-wide
 *
 *  Reference: https://m3.material.io/foundations/layout/applying-layout/window-size-classes
 */
export type WindowSizeClass =
  | 'compact'
  | 'medium'
  | 'expanded'
  | 'large'
  | 'extraLarge';

/**
 *  Derives a width size class from the live window width. Re-renders on
 *  fold/unfold and rotation because ``useWindowDimensions`` is reactive.
 *  Use this to gate adaptive UI decisions (single vs two-pane, bottom
 *  tabs vs navigation rail, full-bleed vs centered max-width content).
 */
export function useWindowSizeClass(): WindowSizeClass {
  const { width } = useWindowDimensions();
  if (width < 600) return 'compact';
  if (width < 840) return 'medium';
  if (width < 1200) return 'expanded';
  if (width < 1600) return 'large';
  return 'extraLarge';
}

/**
 *  Convenience for the common "phone vs anything larger" branch — true
 *  on a foldable inner display, tablet, or any window ≥600dp.
 */
export function useIsLargeWindow(): boolean {
  return useWindowSizeClass() !== 'compact';
}

type StackScreenOptions = NonNullable<ComponentProps<typeof Stack.Screen>['options']>;

/**
 *  Sheet-presentation options that adapt to the current size class.
 *
 *  At ``compact`` we keep the iOS-style bottom form sheet with a grabber
 *  and rounded corners — the right ergonomic on a phone. At ``medium+``
 *  (foldable inner display, tablet) we switch to a full-page ``modal``
 *  presentation; combined with a ``MaxWidthContent`` wrapper inside the
 *  sheet, this centers the form on the larger canvas instead of stretching
 *  the controls edge-to-edge.
 *
 *  ``compactExtras`` lets callers tack on detent / sizing overrides that
 *  only make sense in the bottom-sheet form (e.g. ``fitToContents`` for
 *  the sign-in flow).
 */
export function adaptiveSheetOptions(
  sizeClass: WindowSizeClass,
  compactExtras?: Partial<StackScreenOptions>,
): StackScreenOptions {
  if (sizeClass === 'compact') {
    return {
      presentation: 'formSheet',
      sheetGrabberVisible: true,
      sheetCornerRadius: 56,
      ...compactExtras,
    };
  }
  return {
    presentation: 'modal',
  };
}
