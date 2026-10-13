import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BANNERS, TeamBanner } from './TeamBanner';

const at = (path: string) => (
  <MemoryRouter initialEntries={[path]}>
    <TeamBanner />
  </MemoryRouter>
);

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('баннер команды', () => {
  it('появляется на выбранной странице не сразу, а через паузу', () => {
    render(at('/hot-dishes'));
    expect(screen.queryByRole('status')).toBeNull();
    act(() => void vi.advanceTimersByTime(2000));
    expect(screen.getByRole('status').textContent).toContain('CyberPink228');
  });

  it('на остальных страницах его нет', () => {
    render(at('/stock'));
    act(() => void vi.advanceTimersByTime(5000));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('после закрытия не возвращается на этой странице, пока открыта вкладка', () => {
    const first = render(at('/suppliers'));
    act(() => void vi.advanceTimersByTime(2000));
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть сообщение' }));
    expect(screen.queryByRole('status')).toBeNull();
    first.unmount();
    render(at('/suppliers'));
    act(() => void vi.advanceTimersByTime(5000));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('закрытие на одной странице не прячет баннер на другой', () => {
    const first = render(at('/'));
    act(() => void vi.advanceTimersByTime(2000));
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть сообщение' }));
    first.unmount();
    render(at('/guide'));
    act(() => void vi.advanceTimersByTime(2000));
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('тексты называют команду и не содержат длинных тире', () => {
    for (const [path, m] of Object.entries(BANNERS)) {
      expect(m.title, path).toContain('CyberPink228');
      expect(`${m.title}${m.text}`, path).not.toContain('\u2014');
    }
  });
});
