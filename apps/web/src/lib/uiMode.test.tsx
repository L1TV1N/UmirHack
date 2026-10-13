import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../styles/pro.scss', () => ({}));

import { readUiMode, UiModeProvider, useUiMode } from './uiMode';

function Probe() {
  const { mode, setMode } = useUiMode();
  return (
    <>
      <span data-testid="m">{mode}</span>
      <button onClick={() => setMode('pro')}>pro</button>
      <button onClick={() => setMode('basic')}>basic</button>
    </>
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-ui');
});
afterEach(cleanup);

describe('вид интерфейса', () => {
  it('по умолчанию обычный', () => {
    render(<UiModeProvider><Probe /></UiModeProvider>);
    expect(screen.getByTestId('m').textContent).toBe('basic');
    expect(document.documentElement.getAttribute('data-ui')).toBe('basic');
  });

  it('расширенный выбирается, запоминается и переключается обратно', () => {
    render(<UiModeProvider><Probe /></UiModeProvider>);
    act(() => screen.getByText('pro').click());
    expect(document.documentElement.getAttribute('data-ui')).toBe('pro');
    expect(localStorage.getItem('zapas.ui')).toBe('pro');
    expect(readUiMode()).toBe('pro');
    act(() => screen.getByText('basic').click());
    expect(document.documentElement.getAttribute('data-ui')).toBe('basic');
    expect(readUiMode()).toBe('basic');
  });

  it('мусор в хранилище даёт обычный вид', () => {
    localStorage.setItem('zapas.ui', 'turbo');
    expect(readUiMode()).toBe('basic');
  });
});
