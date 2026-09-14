import {createContext, createElement, useContext, useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode} from "react";
import {setWindowTheme} from "@/lib/desktop";

export type Theme = "system" | "light" | "dark";

interface ThemeContextValue {
    theme: Theme;
    resolvedTheme: "light" | "dark";
    setTheme: (theme: Theme) => void;
}

const STORAGE_KEY = "fc_theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function subscribeSystemTheme(onChange: () => void): () => void {
    const mql = window.matchMedia(DARK_QUERY);
    mql.addEventListener("change", onChange);
    return () => { mql.removeEventListener("change", onChange); };
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({children}: {children: ReactNode}) {
    const [theme, setThemeState] = useState<Theme>(() => {
        const stored = localStorage.getItem(STORAGE_KEY);
        return stored === "light" || stored === "dark" ? stored : "system";
    });
    const systemDark = useSyncExternalStore(subscribeSystemTheme, () => window.matchMedia(DARK_QUERY).matches);
    const resolvedTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme;

    useLayoutEffect(() => {
        document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
    }, [resolvedTheme]);

    useEffect(() => {
        void setWindowTheme(theme === "system" ? null : theme);
    }, [theme]);

    const setTheme = (next: Theme) => {
        setThemeState(next);
        if (next === "system") localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, next);
    };

    return createElement(ThemeContext.Provider, {value: {theme, resolvedTheme, setTheme}}, children);
}

export function useTheme(): ThemeContextValue {
    const ctx = useContext(ThemeContext);
    if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
    return ctx;
}
