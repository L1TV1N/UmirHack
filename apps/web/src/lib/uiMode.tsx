import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/** basic: основной интерфейс. pro: расширенный, с более богатым оформлением и палитрой команд. Он тяжелее, поэтому подгружается только по выбору. */
export type UiMode = 'basic' | 'pro';
export const UI_MODES: { value: UiMode; label: string; hint: string }[] = [
  { value: 'basic', label: 'Обычный', hint: 'Лёгкий и быстрый' },
  { value: 'pro', label: 'Расширенный', hint: 'Анимации, глубина, палитра команд' },
];

const KEY = 'zapas.ui';

export function readUiMode(): UiMode {
  try {
    return localStorage.getItem(KEY) === 'pro' ? 'pro' : 'basic';
  } catch {
    return 'basic';
  }
}

interface Value {
  mode: UiMode;
  setMode: (m: UiMode) => void;
}

const Ctx = createContext<Value>({ mode: 'basic', setMode: () => undefined });

export function UiModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<UiMode>(readUiMode);

  useEffect(() => {
    document.documentElement.setAttribute('data-ui', mode);
    // тяжёлые стили расширенного вида подгружаются один раз и только когда он нужен
    if (mode === 'pro') void import('../styles/pro.scss');
  }, [mode]);

  const setMode = useCallback((m: UiMode) => {
    setModeState(m);
    try {
      localStorage.setItem(KEY, m);
    } catch {
      /* выбор останется до перезагрузки страницы */
    }
  }, []);

  const value = useMemo(() => ({ mode, setMode }), [mode, setMode]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useUiMode = (): Value => useContext(Ctx);
