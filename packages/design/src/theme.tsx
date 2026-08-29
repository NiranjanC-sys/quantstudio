'use client';

/**
 * Theme control.
 *
 * DESIGN.md's theme lock: dark is the default, both themes are complete, and a
 * page ground is off-black or off-white but never `#000` or `#fff`.
 *
 * `light` and `dark` write `data-theme` on `<html>`. `system` removes the
 * attribute and lets the `prefers-color-scheme` blocks in `tokens.css` decide,
 * which keeps the toggle honest in both directions.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'redquant-theme';

export interface ThemeContextValue {
  /** What the reader chose. */
  theme: ThemePreference;
  /** What is actually painted right now. */
  resolvedTheme: ResolvedTheme;
  setTheme: (next: ThemePreference) => void;
  /** Flip between light and dark. From `system`, flips away from what is painted. */
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const isPreference = (value: unknown): value is ThemePreference =>
  value === 'light' || value === 'dark' || value === 'system';

/** localStorage throws in private mode and when storage is disabled. */
function readStored(storageKey: string): ThemePreference | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    return isPreference(raw) ? raw : null;
  } catch {
    return null;
  }
}

function writeStored(storageKey: string, value: ThemePreference): void {
  try {
    window.localStorage.setItem(storageKey, value);
  } catch {
    /* Storage is unavailable. The choice lasts for this session only. */
  }
}

function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark';
  if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
  return 'dark';
}

function applyTheme(preference: ThemePreference): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (preference === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', preference);
  }
}

export interface ThemeProviderProps {
  children: ReactNode;
  /** Used when nothing is stored. Dark, per the theme lock. */
  defaultTheme?: ThemePreference;
  storageKey?: string;
  /** Skip reading and writing localStorage. Useful in tests and in previews. */
  disableStorage?: boolean;
}

export function ThemeProvider({
  children,
  defaultTheme = 'dark',
  storageKey = THEME_STORAGE_KEY,
  disableStorage = false,
}: ThemeProviderProps): ReactNode {
  const [theme, setThemeState] = useState<ThemePreference>(defaultTheme);
  const [systemResolved, setSystemResolved] = useState<ResolvedTheme>('dark');

  // Adopt the stored choice after mount so server and client markup agree.
  useEffect(() => {
    const stored = disableStorage ? null : readStored(storageKey);
    const initial = stored ?? defaultTheme;
    setThemeState(initial);
    setSystemResolved(systemTheme());
    applyTheme(initial);
  }, [defaultTheme, storageKey, disableStorage]);

  // Track the OS while the reader is on `system`.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (): void => setSystemResolved(mql.matches ? 'light' : 'dark');
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  const setTheme = useCallback(
    (next: ThemePreference) => {
      setThemeState(next);
      applyTheme(next);
      if (!disableStorage) writeStored(storageKey, next);
    },
    [storageKey, disableStorage],
  );

  const resolvedTheme: ResolvedTheme = theme === 'system' ? systemResolved : theme;

  const toggleTheme = useCallback(() => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
  }, [resolvedTheme, setTheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme, toggleTheme }),
    [theme, resolvedTheme, setTheme, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context === null) {
    throw new Error('useTheme must be used inside a ThemeProvider');
  }
  return context;
}

/**
 * Inline script for `<head>`, ahead of any stylesheet, so the first paint is
 * already the right theme.
 *
 * ```tsx
 * <head>
 *   <script dangerouslySetInnerHTML={{ __html: themeScript() }} />
 * </head>
 * ```
 */
export function themeScript(
  storageKey: string = THEME_STORAGE_KEY,
  defaultTheme: ThemePreference = 'dark',
): string {
  const key = JSON.stringify(storageKey);
  const fallback = JSON.stringify(defaultTheme);
  return (
    '(function(){try{' +
    `var s=localStorage.getItem(${key});` +
    `var t=(s==="light"||s==="dark"||s==="system")?s:${fallback};` +
    'if(t==="system"){document.documentElement.removeAttribute("data-theme");}' +
    'else{document.documentElement.setAttribute("data-theme",t);}' +
    `}catch(e){document.documentElement.setAttribute("data-theme",${fallback});}})();`
  );
}
