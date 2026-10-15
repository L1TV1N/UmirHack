import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { GuestOrderDto } from '@zapas/shared';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutboxItem } from '../../lib/outbox';

const retryItem = vi.fn().mockResolvedValue(undefined);
const removeItem = vi.fn().mockResolvedValue(undefined);
const flushOutbox = vi.fn().mockResolvedValue({ sent: 0, rejected: 0, offline: false });
let queue: OutboxItem[] = [];
let orders: GuestOrderDto[] = [];
let offline = false;
let unreachable = false;

vi.mock('../../api/client', () => ({ post: vi.fn() }));
vi.mock('../../api/hooks', () => ({
  useGet: () => ({ data: undefined, isLoading: false, error: null, refetch: vi.fn() }),
  useAction: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('../../auth/ScopeProvider', () => ({ useScope: () => ({ locationId: 'k1' }) }));
vi.mock('../../components/Toast/Toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock('../../lib/useWaiterGet', () => ({
  useWaiterGet: () => ({ data: orders, isLoading: false, error: null, refetch: vi.fn(), offline, unreachable, savedAt: offline ? Date.parse('2026-10-14T11:00:00Z') : null }),
}));
vi.mock('../../lib/outbox', () => ({
  useOutbox: () => queue,
  retryItem: (...a: unknown[]) => retryItem(...a),
  removeItem: (...a: unknown[]) => removeItem(...a),
  flushOutbox: (...a: unknown[]) => flushOutbox(...a),
}));

import WaiterOrdersPage from './WaiterOrdersPage';

const item = (over: Partial<OutboxItem> = {}): OutboxItem => ({ id: 'q1', userId: 'u1', label: 'Заказ, стол 5', path: '/guest-orders', body: {}, key: 'order-1', createdAt: Date.parse('2026-10-14T11:30:00Z'), attempts: 0, error: null, ...over });
const sent = (over: Partial<GuestOrderDto> = {}): GuestOrderDto => ({
  id: 'o1',
  number: 'ЗК-000001',
  status: 'new',
  locationId: 'k1',
  locationName: 'Кухня',
  tableLabel: '7',
  comment: null,
  waiterId: 'u1',
  waiterName: 'Соколова Мария',
  lines: [{ id: 'l1', dishId: 'd1', dishName: 'Борщ', quantity: 2, price: 290, note: null, isRemake: false }],
  total: 580,
  createdAt: '2026-10-14T11:00:00Z',
  placedAt: null,
  acceptedAt: null,
  servedAt: null,
  cancelledAt: null,
  cancelReason: null,
  openIncidents: 0,
  ...over,
});

const show = () =>
  render(
    <MemoryRouter>
      <WaiterOrdersPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  queue = [];
  orders = [];
  offline = false;
  unreachable = false;
  retryItem.mockClear();
  removeItem.mockClear();
  flushOutbox.mockClear();
});
afterEach(cleanup);

describe('мои заказы без связи', () => {
  it('ожидающий заказ показан отдельно и обещает уйти сам', () => {
    queue = [item()];
    show();
    expect(screen.getByText('Заказ, стол 5')).toBeTruthy();
    expect(screen.getByText(/Ждёт связи, уйдёт на кухню сам/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Повторить' })).toBeNull();
  });

  it('очередь другого раздела (накладные, списания) официанту не показывается', () => {
    queue = [item({ id: 'q2', path: '/documents/writeoffs', label: 'Списание' })];
    orders = [sent()];
    show();
    expect(screen.queryByText('Списание')).toBeNull();
  });

  it('заказ, который кухня не приняла, показывает причину и даёт повторить или убрать', async () => {
    queue = [item({ error: '«Борщ» в стоп-листе, принять заказ нельзя' })];
    show();
    expect(screen.getByText(/Кухня не приняла: «Борщ» в стоп-листе/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(retryItem).toHaveBeenCalledWith('q1'));
    await waitFor(() => expect(flushOutbox).toHaveBeenCalledWith('u1'));
    fireEvent.click(screen.getByRole('button', { name: 'Убрать' }));
    expect(removeItem).toHaveBeenCalledWith('q1');
  });

  it('вместо пустого экрана «Заказов пока нет» при ожидающих заказах показывается только очередь', () => {
    queue = [item()];
    show();
    expect(screen.queryByText('Заказов пока нет')).toBeNull();
  });

  it('список из памяти телефона помечен, а время заказа берётся момент приёма', () => {
    offline = true;
    orders = [sent({ placedAt: '2026-10-14T10:40:00Z' })];
    show();
    expect(screen.getByText(/Нет связи\. Данные на/)).toBeTruthy();
    expect(screen.getByText('ЗК-000001')).toBeTruthy();
  });

  it('без связи и без сохранённого списка не крутит загрузку вечно, а объясняет', () => {
    unreachable = true;
    show();
    expect(screen.getByText(/Нет связи, список заказов появится/)).toBeTruthy();
    expect(screen.queryByText(/Загружаем/)).toBeNull();
  });

  it('если в очереди есть заказ, список без связи не заменяет очередь сообщением', () => {
    unreachable = true;
    queue = [item()];
    show();
    expect(screen.getByText('Заказ, стол 5')).toBeTruthy();
    expect(screen.queryByText(/Нет связи, список заказов/)).toBeNull();
  });
});
