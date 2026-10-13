import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTheme, ThemeProvider, useTheme } from './theme';

function Probe() {
  const { theme, setTheme } = useTheme();
  return (
    <>
      <span data-testid="t">{theme}</span>
      <button onClick={() => setTheme('colorful')}>цветная</button>
      <button onClick={() => setTheme('dark')}>тёмная</button>
    </>
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe('тема оформления', () => {
  it('по умолчанию светлая и записывается в разметку', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('t').textContent).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('выбор сохраняется и применяется сразу', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    act(() => screen.getByText('цветная').click());
    expect(document.documentElement.getAttribute('data-theme')).toBe('colorful');
    expect(localStorage.getItem('zapas.theme')).toBe('colorful');
    expect(readTheme()).toBe('colorful');
  });

  it('сохранённая тема побеждает системную', () => {
    localStorage.setItem('zapas.theme', 'dark');
    window.matchMedia = ((q: string) => ({ matches: false, media: q })) as unknown as typeof window.matchMedia;
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('t').textContent).toBe('dark');
  });

  it('если система тёмная и выбора не было, берётся тёмная', () => {
    window.matchMedia = ((q: string) => ({ matches: true, media: q })) as unknown as typeof window.matchMedia;
    expect(readTheme()).toBe('dark');
  });

  it('мусор в хранилище игнорируется', () => {
    localStorage.setItem('zapas.theme', 'neon');
    expect(readTheme()).toBe('light');
  });
});
