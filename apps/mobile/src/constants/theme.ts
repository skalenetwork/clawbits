/**
 * Color tokens mirror the web frontend palette in `frontend/src/index.css`
 * (warm cream in light mode, warm dark gray in dark mode). The web file is
 * authored in OKLCH; values here are sRGB approximations chosen to match.
 *
 * Key mapping (mobile → web):
 *   background        → --background
 *   text              → --foreground
 *   backgroundElement → --card
 *   backgroundSelected→ --border (subtle separator / divider)
 *   textSecondary     → --muted-foreground
 *   destructive       → --destructive
 */

import '@/global.css';

import { Platform } from 'react-native';

export const Colors = {
  light: {
    text: '#1C1C1E',
    // Pure white page surface. Cards and inputs sit on neutral light
    // greys (iOS systemGray5/6 tones) so they stay visible against the
    // bright background without reintroducing the previous cream tint.
    background: '#FFFFFF',
    backgroundElement: '#F2F2F7',
    backgroundSelected: '#E5E5EA',
    inputBg: '#F2F2F7',
    inputBorder: '#D1D1D6',
    // iOS systemGray (#8E8E93) is only 3.26:1 on white and fails WCAG AA for
    // the body-sized secondary text it's used on (previews, timestamps,
    // metadata). Nudged a touch darker to ~5.3:1 while staying a cool,
    // clearly-secondary grey.
    textSecondary: '#6B6B70',
    destructive: '#FF3B30',
  },
  dark: {
    text: '#EBE6DA',
    background: '#0F0F0F',
    backgroundElement: '#262626',
    backgroundSelected: '#3F3F3F',
    inputBg: '#262626',
    inputBorder: '#3F3F3F',
    textSecondary: '#A19D95',
    destructive: '#DC5347',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

/** Mutable copy of the palette shape — what `useTheme()` returns. */
export type Theme = { -readonly [K in ThemeColor]: string };

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
