import {createContext, useContext, useState, useEffect, createElement, type ReactNode} from "react";

export type Theme = "system" | "light" | "dark";

interface ThemeContextValue {
    theme: Theme;
    resolvedTheme: "light" | "dark";
    setTheme: (theme: Theme) => void;
}

const STORAGE_KEY = "reef_theme";
const DARK_CLASS = "dark";
const mediaQuery = "(prefers-color-scheme: dark)";

function getSystemTheme(): "light" | "dark" {
    return window.matchMedia(mediaQuery).matches ? "dark" : "light";
}

function resolveTheme(theme: Theme): "light" | "dark" {
    return theme === "system" ? getSystemTheme() : theme;
}

function applyTheme(resolved: "light" | "dark") {
    document.documentElement.classList.toggle(DARK_CLASS, resolved === "dark");
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({children}: {children: ReactNode}) {
    const [theme, setThemeState] = useState<Theme>(() => {
        const stored = localStorage.getItem(STORAGE_KEY);
        // reef is an operator tool — default to dark when there's no stored pref
        // (vs. clawbits' "system"). index.html sets class="dark" to avoid a flash.
        return stored === "light" || stored === "dark" ? stored : "dark";
    });
    const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(() => resolveTheme(theme));

    const setTheme = (next: Theme) => {
        setThemeState(next);
        if (next === "system") {
            localStorage.removeItem(STORAGE_KEY);
        } else {
            localStorage.setItem(STORAGE_KEY, next);
        }
        const resolved = resolveTheme(next);
        setResolvedTheme(resolved);
        applyTheme(resolved);
    };

    // Apply on mount
    useEffect(() => {
        applyTheme(resolveTheme(theme));
    }, []); // eslint-disable-line react-hooks/exhaustive-deps -- mount only

    // Listen for system theme changes when in "system" mode
    useEffect(() => {
        if (theme !== "system") return;
        const mql = window.matchMedia(mediaQuery);
        const handler = () => {
            const resolved = getSystemTheme();
            setResolvedTheme(resolved);
            applyTheme(resolved);
        };
        mql.addEventListener("change", handler);
        return () => { mql.removeEventListener("change", handler); };
    }, [theme]);

    return createElement(
        ThemeContext.Provider,
        {value: {theme, resolvedTheme, setTheme}},
        children,
    );
}

export function useTheme(): ThemeContextValue {
    const ctx = useContext(ThemeContext);
    if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
    return ctx;
}
