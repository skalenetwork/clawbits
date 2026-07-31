import { createContext, use, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';

interface TabBarVisibilityValue {
  /** True whenever at least one screen has an active hide request. */
  hidden: boolean;
  /**
   * Request the tab bar be hidden. Returns a release function that
   * decrements the request count — call it on cleanup/unmount.
   *
   * Counter semantics avoid the flicker that a bare `hidden: boolean`
   * setter creates during stack push/pop: when one screen releases and
   * another grabs in the same animation frame the underlying count
   * never reaches zero, so the bar stays hidden across the handoff.
   */
  requestHidden: () => () => void;
}

const TabBarVisibilityContext = createContext<TabBarVisibilityValue>({
  hidden: false,
  requestHidden: () => () => {},
});

export function TabBarVisibilityProvider({ children }: { children: ReactNode }) {
  const countRef = useRef(0);
  const [hidden, setHiddenState] = useState(false);

  const requestHidden = useCallback((): (() => void) => {
    countRef.current += 1;
    if (countRef.current === 1) setHiddenState(true);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      countRef.current = Math.max(0, countRef.current - 1);
      if (countRef.current === 0) setHiddenState(false);
    };
  }, []);

  const value = useMemo<TabBarVisibilityValue>(
    () => ({ hidden, requestHidden }),
    [hidden, requestHidden],
  );
  return <TabBarVisibilityContext value={value}>{children}</TabBarVisibilityContext>;
}

export function useTabBarVisibility(): TabBarVisibilityValue {
  return use(TabBarVisibilityContext);
}
