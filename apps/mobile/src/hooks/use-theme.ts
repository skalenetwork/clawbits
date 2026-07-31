/**
 * Default `useTheme` — used on iOS and web. Returns the static palette
 * defined in `Colors`. Android has its own `use-theme.android.ts` that
 * sources from Material 3 (wallpaper-derived on Android 12+).
 */

import { Colors, type Theme } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

export function useTheme(): Theme {
  const scheme = useColorScheme();
  const theme = scheme === 'unspecified' ? 'light' : scheme;

  return Colors[theme];
}
