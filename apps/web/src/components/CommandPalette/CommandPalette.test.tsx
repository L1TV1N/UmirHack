import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ can: (r: string) => r !== 'admin' }) }));
vi.mock('../../styles/pro.scss', () => ({}));

import { ThemeProvider } from '../../lib/theme';
import { UiModeProvider } from '../../lib/uiMode';
import CommandPalette from './CommandPalette';

function Where() {
  const l = useLocation();
  return <span data-testid="where">{l.pathname + l.hash}</span>;
}

const onClose = vi.fn();
const mount = () =>
  render(
    <ThemeProvider>
      <UiModeProvider>
        <MemoryRouter initialEntries={['/']}>
          <CommandPalette onClose={onClose} />
          <Where />
        </MemoryRouter>
      </UiModeProvider>
    </ThemeProvider>,
  );

beforeEach(() => {
  onClose.mockReset();
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  Element.prototype.scrollIntoView = () => undefined;
});
afterEach(cleanup);

describe('палитра команд', () => {
  it('показывает разделы без тех, на которые нет прав', () => {
    mount();
    expect(screen.getByRole('option', { name: /Остатки/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Администрирование/ })).toBeNull();
  });

  it('ищет по разделам и руководству, Enter открывает выбранное', () => {
    mount();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'стоп' } });
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('where').textContent).toBe('/stop-list');
    expect(onClose).toHaveBeenCalled();
  });

  it('стрелки двигают выбор', () => {
    mount();
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]?.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getAllByRole('option')[0]?.getAttribute('aria-selected')).toBe('true');
  });

  it('статья руководства открывается по якорю, тема меняется командой', () => {
    mount();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'горячие' } });
    fireEvent.click(screen.getAllByRole('option').find((o) => o.id === 'palette-help:hot') as HTMLElement);
    expect(screen.getByTestId('where').textContent).toBe('/guide#hot');
    cleanup();
    mount();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'тёмная' } });
    fireEvent.click(screen.getByRole('option', { name: /Тёмная тема/ }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('пустой поиск сообщает, что ничего нет', () => {
    mount();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzzzzz' } });
    expect(screen.getByText('Ничего не нашлось')).toBeTruthy();
  });
});
