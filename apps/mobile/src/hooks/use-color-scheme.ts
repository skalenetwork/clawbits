import { useColorScheme as useRNColorScheme } from 'react-native';

import { useThemeOverride } from '@/providers/theme-override-provider';

/** Project-wide ``useColorScheme``: returns the user's override when one
 *  is set in settings, otherwise the OS scheme. All consumers — theme
 *  hook, message-bubble tinting, navigation theme — go through this so
 *  flipping the preference once propagates everywhere. */
export function useColorScheme() {
  const { override } = useThemeOverride();
  const scheme = useRNColorScheme();
  return override ?? scheme;
}
