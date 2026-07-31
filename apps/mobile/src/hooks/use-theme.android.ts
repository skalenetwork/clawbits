/**
 * Android `useTheme` — derives the app's 8 theme keys from the device's
 * Material 3 palette via `@expo/ui/jetpack-compose`. On Android 12+
 * (Pixel, Samsung One UI 5+, etc.) the palette is wallpaper-derived via
 * Material You / Monet, so the app adapts to whatever the user has set.
 * On older Android it falls back to the static M3 baseline. Either way
 * the surface tiers give a richer, native-feeling background hierarchy
 * than the static greys in `Colors`.
 *
 * `useMaterialColors()` subscribes to the system color scheme internally,
 * so light/dark mode flips trigger a re-render automatically — no need to
 * call `useColorScheme` here.
 */

import { useMaterialColors } from '@expo/ui/jetpack-compose';

import type { Theme } from '@/constants/theme';

export function useTheme(): Theme {
  const m3 = useMaterialColors();
  return {
    background: m3.background,
    backgroundElement: m3.surfaceContainer,
    backgroundSelected: m3.surfaceContainerHigh,
    inputBg: m3.surfaceContainerHighest,
    inputBorder: m3.outlineVariant,
    text: m3.onSurface,
    textSecondary: m3.onSurfaceVariant,
    destructive: m3.error,
  };
}
