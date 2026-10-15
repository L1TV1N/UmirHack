import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { FakeApiError, get } = vi.hoisted(() => {
  class FakeApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return { FakeApiError, get: vi.fn() };
});

vi.mock('../api/client', () => ({ ApiError: FakeApiError, get: (...a: unknown[]) => get(...a) }));
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));

import { clearWaiterCache, loadWaiterData, saveWaiterData } from './waiterCache';
import { useWaiterGet } from './useWaiterGet';

function Probe() {
  const q = useWaiterGet<string[]>('/waiter/stop-list', { locationId: 'k1' });
  return (
    <div>
      <span data-testid="data">{q.data ? q.data.join(',') : 'нет'}</span>
      <span data-testid="offline">{String(q.offline)}</span>
      <span data-testid="error">{q.error ? q.error.message : ''}</span>
    </div>
  );
}

const wrap = (node: ReactNode) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
};

beforeEach(async () => {
  get.mockReset();
  await clearWaiterCache();
});
afterEach(cleanup);

describe('запросы официанта без связи', () => {
  it('свежий ответ показывается и запоминается на телефоне', async () => {
    get.mockResolvedValue(['Борщ']);
    wrap(<Probe />);
    await waitFor(() => expect(screen.getByTestId('data').textContent).toBe('Борщ'));
    expect(screen.getByTestId('offline').textContent).toBe('false');
    await waitFor(async () => expect((await loadWaiterData<string[]>('u1', '/waiter/stop-list?{"locationId":"k1"}'))?.data).toEqual(['Борщ']));
  });

  it('при обрыве связи показывается последний сохранённый ответ и помечается как устаревший', async () => {
    await saveWaiterData('u1', '/waiter/stop-list?{"locationId":"k1"}', ['Паста']);
    get.mockRejectedValue(new TypeError('Failed to fetch'));
    wrap(<Probe />);
    await waitFor(() => expect(screen.getByTestId('data').textContent).toBe('Паста'));
    expect(screen.getByTestId('offline').textContent).toBe('true');
    expect(screen.getByTestId('error').textContent).toBe('');
  });

  it('сервер недоступен (503) тоже считается обрывом связи', async () => {
    await saveWaiterData('u1', '/waiter/stop-list?{"locationId":"k1"}', ['Паста']);
    get.mockRejectedValue(new FakeApiError(503, 'Сервис недоступен'));
    wrap(<Probe />);
    await waitFor(() => expect(screen.getByTestId('offline').textContent).toBe('true'));
  });

  it('отказ по существу кеш не подменяет: официант видит ошибку', async () => {
    await saveWaiterData('u1', '/waiter/stop-list?{"locationId":"k1"}', ['Паста']);
    get.mockRejectedValue(new FakeApiError(403, 'Нет доступа'));
    wrap(<Probe />);
    await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('Нет доступа'));
    expect(screen.getByTestId('data').textContent).toBe('нет');
    expect(screen.getByTestId('offline').textContent).toBe('false');
  });

  it('без сохранённых данных при обрыве остаётся ошибка', async () => {
    get.mockRejectedValue(new TypeError('Failed to fetch'));
    wrap(<Probe />);
    await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('Failed to fetch'));
    expect(screen.getByTestId('offline').textContent).toBe('false');
  });

  it('данные другого пользователя на этом телефоне не показываются', async () => {
    await saveWaiterData('someone-else', '/waiter/stop-list?{"locationId":"k1"}', ['Чужое']);
    get.mockRejectedValue(new TypeError('Failed to fetch'));
    wrap(<Probe />);
    await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('Failed to fetch'));
    expect(screen.getByTestId('data').textContent).toBe('нет');
  });
});
