import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enqueue, outboxItems, resetOutbox } from '../../lib/outbox';
import { ConfirmProvider } from '../Toast/Confirm';
import { ToastProvider } from '../Toast/Toast';
import { OfflineStatus } from './OfflineStatus';

vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
// фоновая подгрузка страниц и каталога здесь не нужна
vi.mock('../../lib/catalog', () => ({ loadCatalog: async () => undefined, refreshCatalog: async () => 'fresh' }));

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const setOnline = (value: boolean) => Object.defineProperty(navigator, 'onLine', { value, configurable: true });

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ConfirmProvider>
          <OfflineStatus />
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  await resetOutbox();
  setOnline(true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setOnline(true);
});

describe('индикатор связи и очередь', () => {
  it('пока связь есть и очередь пуста, ничего не показывает', async () => {
    const { container } = mount();
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    expect(container.textContent).toBe('');
  });

  it('при недоступном сервере не уходит в бесконечные попытки', async () => {
    await enqueue({ userId: 'u1', label: 'Приход, 1 поз.', path: '/documents/receipts', body: {}, key: 'k1' });
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    mount();
    await screen.findByText('Очередь');
    await act(async () => void (await new Promise((r) => setTimeout(r, 700))));
    // один заход при открытии, при необходимости ещё один по связи, но не десятки
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2);
    expect(outboxItems('u1')[0]?.attempts).toBeLessThanOrEqual(2);
  });

  it('когда связь вернулась, документ уходит один раз, очередь пустеет', async () => {
    await enqueue({ userId: 'u1', label: 'Продажа, 1 поз.', path: '/documents/sales', body: { lines: [] }, key: 'web-k' });
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(json(201, { number: 'ПД-1' }));
    vi.stubGlobal('fetch', fetchMock);
    mount();
    await screen.findByText('Очередь');
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await new Promise((r) => setTimeout(r, 200));
    });
    await waitFor(() => expect(outboxItems('u1')).toHaveLength(0));
    const sales = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/documents/sales'));
    expect(sales.length).toBe(2);
    const last = sales.at(-1)?.[1] as RequestInit;
    expect((last.headers as Record<string, string>)['idempotency-key']).toBe('web-k');
  });

  it('без связи показывает плашку «Нет связи»', async () => {
    setOnline(false);
    mount();
    expect(await screen.findByText('Нет связи')).toBeTruthy();
  });
});
