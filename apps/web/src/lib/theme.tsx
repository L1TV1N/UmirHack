import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Theme = 'light' | 'dark' | 'colorful';
export const THEMES: { value: Theme; label: string }[] = [
  { value: 'light', label: 'Светлая' },
  { value: 'dark', label: 'Тёмная' },
  { value: 'colorful', label: 'Разноцветная' },
];

const KEY = 'zapas.theme';
const META_COLOR: Record<Theme, string> = { light: '#111827', dark: '#0a0f18', colorful: '#2a0f4a' };

export function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'colorful') return saved;
  } catch {
    /* хранилище недоступно */
  }
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function apply(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', META_COLOR[theme]);
}

interface ThemeValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
}

const Ctx = createContext<ThemeValue>({ theme: 'light', setTheme: () => undefined });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readTheme);
  useEffect(() => apply(theme), [theme]);
  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    try {
      localStorage.setItem(KEY, t);
    } catch {
      /* тема останется до перезагрузки страницы */
    }
  }, []);
  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useTheme = (): ThemeValue => useContext(Ctx);
