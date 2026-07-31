import { useIsRestoring } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import * as Linking from 'expo-linking';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import { SystemBars } from 'react-native-edge-to-edge';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { useTheme } from '@/hooks/use-theme';
import {
  adaptiveSheetOptions,
  useWindowSizeClass,
} from '@/hooks/use-window-size-class';
import { formatAvatarCacheStats } from '@/lib/avatar-cache';
import { persistOptions, queryClient } from '@/lib/query-client';
import { AuthProvider, useAuth } from '@/providers/auth-provider';
import { RealtimeProvider } from '@/providers/realtime-provider';
import { TabBarVisibilityProvider } from '@/providers/tab-bar-visibility';
import { ThemeOverrideProvider } from '@/providers/theme-override-provider';

// Hold the native splash open until the app has restored both auth and
// the persisted query cache. Without this, a logged-in user sees a
// "sign-in" empty state for the 300ms it takes ``getMe`` to resolve.
//
// `preventAutoHideAsync` is fire-and-forget at module scope per Expo
// SDK 56 guidance — awaiting it inside an effect is racy because
// the native splash can dismiss before the effect runs.
SplashScreen.preventAutoHideAsync();
SplashScreen.setOptions({ duration: 250, fade: true });

export default function RootLayout() {
  useAvatarCacheDiagnostics();

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SystemBars style="auto" />
      <KeyboardProvider>
        <ThemeOverrideProvider>
          <ThemedRouterShell />
        </ThemeOverrideProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

function ThemedRouterShell() {
  const colorScheme = useColorScheme();
  // Sheet presentation adapts to window size — bottom form sheet on a
  // phone, full-page modal on a foldable inner display / tablet. See
  // ``adaptiveSheetOptions`` for the rationale.
  const sizeClass = useWindowSizeClass();
  const sheetOptions = adaptiveSheetOptions(sizeClass);
  const signInSheetOptions = adaptiveSheetOptions(sizeClass, {
    // Android's formSheet measures ``fitToContents`` incorrectly when a
    // child has ``flex: 1`` — the sheet ends up too short and clips the
    // bottom content. Pin Android to an explicit 90% detent. iOS handles
    // ``fitToContents`` reliably.
    sheetAllowedDetents: Platform.OS === 'android' ? [0.9] : 'fitToContents',
  });

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
        <AuthProvider>
          <RealtimeProvider>
            <RootBackgroundSync />
            <SplashGate />
            <SocialDeepLinkBridge />
            <TabBarVisibilityProvider>
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="index" />
                <Stack.Screen name="(tabs)" />
                <Stack.Screen name="sign-in" options={signInSheetOptions} />
                <Stack.Screen name="new-channel" options={sheetOptions} />
                <Stack.Screen name="new-dm" options={sheetOptions} />
                <Stack.Screen name="add-agent" options={sheetOptions} />
                <Stack.Screen name="browse-channels" options={sheetOptions} />
                <Stack.Screen name="pin-chat-picker" options={sheetOptions} />
                <Stack.Screen name="chat-details/[channelId]" options={sheetOptions} />
                <Stack.Screen name="add-channel-member/[channelId]" options={sheetOptions} />
              </Stack>
            </TabBarVisibilityProvider>
          </RealtimeProvider>
        </AuthProvider>
      </PersistQueryClientProvider>
    </ThemeProvider>
  );
}

/** Keeps the Android root view background in sync with `theme.background`.
 *
 *  Without this, any area the app doesn't actively paint (system gesture
 *  area below the composer, splash-to-app handoff gap) shows Android's
 *  default window background — typically black in dark mode — which reads
 *  as a visible band against the M3-derived `theme.background`. `expo-
 *  system-ui` writes the root `View`'s color, so those untouched areas
 *  blend with the rest of the screen.
 *
 *  Lives inside `ThemeProvider` so it observes color-scheme flips and
 *  re-runs when the M3 palette changes (wallpaper change on Android 12+).
 *  No-op on iOS — the platform doesn't expose an equivalent and the iOS
 *  safe-area handling already keeps the screen edge-to-edge. */
function RootBackgroundSync() {
  const theme = useTheme();
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(theme.background);
  }, [theme.background]);
  return null;
}

/** Hides the native splash once both gates are open:
 *   1. AuthProvider has resolved (token restored, ``getMe`` returned, or
 *      we've decided the user is anonymous).
 *   2. PersistQueryClient has finished rehydrating from AsyncStorage —
 *      otherwise the first paint would show empty lists right before
 *      the cache snaps in, defeating the purpose of persistence. */
function SplashGate() {
  const { status } = useAuth();
  const isRestoring = useIsRestoring();
  const ready = status !== 'loading' && !isRestoring;

  useEffect(() => {
    if (ready) {
      void SplashScreen.hideAsync();
    }
  }, [ready]);

  return null;
}

/** Defensive cold-start fallback for the social OAuth deep link.
 *
 *  The happy path is handled by ``WebBrowser.openAuthSessionAsync``
 *  inside ``socialSignIn``: the in-app browser captures
 *  ``clawbits://oauth-callback?token=…`` and returns it directly to
 *  the awaiting promise. But if the OS suspends or terminates the app
 *  while the auth session is open, the callback URL may instead arrive
 *  via Linking — either as the *initial* URL on a fresh launch, or as
 *  a delivered ``url`` event after the in-app browser was torn down.
 *  This component completes the sign-in in either case so the user
 *  never sees a silent no-op.
 *
 *  Lives under ``AuthProvider`` so it can call ``completeSocialFromUrl``;
 *  the call is idempotent and ignores URLs that don't carry a token. */
function SocialDeepLinkBridge() {
  const { completeSocialFromUrl, status } = useAuth();

  useEffect(() => {
    if (status === 'authenticated') return;
    let cancelled = false;

    const handle = (url: string | null) => {
      if (cancelled || !url) return;
      void completeSocialFromUrl(url);
    };

    void Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener('url', (event) => handle(event.url));

    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [completeSocialFromUrl, status]);

  return null;
}

/** Logs avatar cache stats to the JS console every time the app comes
 *  back to the foreground. ``__DEV__``-only — production users never see
 *  this. Helps quickly verify the disk cache is doing its job after a
 *  session of normal use (expect hit-rate to climb toward 100% as the
 *  cache warms). */
function useAvatarCacheDiagnostics(): void {
  useEffect(() => {
    if (!__DEV__) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      const line = formatAvatarCacheStats();
      if (line) console.log(`[avatar-cache] ${line}`);
    });
    return () => sub.remove();
  }, []);
}
