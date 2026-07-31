import * as SecureStore from 'expo-secure-store';
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';

const PREFERENCE_KEY = 'clawbits.theme_preference.v1';

interface ThemeOverrideContextValue {
  preference: ThemePreference;
  /** The override the rest of the tree should observe — null means
   *  "follow the OS". Always null when preference === 'system'. */
  override: 'light' | 'dark' | null;
  setPreference: (next: ThemePreference) => Promise<void>;
}

const ThemeOverrideContext = createContext<ThemeOverrideContextValue | null>(null);

export function ThemeOverrideProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>('system');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await SecureStore.getItemAsync(PREFERENCE_KEY);
      if (cancelled) return;
      if (stored === 'light' || stored === 'dark' || stored === 'system') {
        setPreferenceState(stored);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setPreference = useCallback(async (next: ThemePreference) => {
    setPreferenceState(next);
    if (next === 'system') {
      await SecureStore.deleteItemAsync(PREFERENCE_KEY);
    } else {
      await SecureStore.setItemAsync(PREFERENCE_KEY, next);
    }
  }, []);

  const value = useMemo<ThemeOverrideContextValue>(
    () => ({
      preference,
      override: preference === 'system' ? null : preference,
      setPreference,
    }),
    [preference, setPreference],
  );

  return <ThemeOverrideContext value={value}>{children}</ThemeOverrideContext>;
}

export function useThemeOverride(): ThemeOverrideContextValue {
  const value = use(ThemeOverrideContext);
  if (!value) {
    throw new Error('useThemeOverride must be used inside ThemeOverrideProvider');
  }
  return value;
}
