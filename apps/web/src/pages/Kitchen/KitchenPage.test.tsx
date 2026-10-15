import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { GuestOrderDto } from '@zapas/shared';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
let orders: GuestOrderDto[] = [];
let loading = false;

vi.mock('../../api/client', () => ({ post: (...a: unknown[]) => post(...a), ApiError: class ApiError extends Error {} }));
vi.mock('../../api/hooks', () => ({
  STOCK_PREFIXES: [],
  useGet: () => ({ data: loading ? undefined : orders, isLoading: loading, error: null, refetch: vi.fn() }),
  useAction: (fn: (v: never) => Promise<unknown>) => ({
    isPending: false,
    mutate: (vars: never, opts?: { onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void }) => {
      fn(vars).then((r) => opts?.onSuccess?.(r), (e) => opts?.onError?.(e));
    },
  }),
}));
vi.mock('../../auth/ScopeProvider', () => ({ useScope: () => ({ locationId: 'k1', selected: { id: 'k1', name: 'Кухня «Набережная»' } }) }));
vi.mock('../../lib/useLiveUpdates', () => ({ useLiveUpdates: () => ({ live: true }) }));

import KitchenPage, { LATE_MINUTES, minutesSince, urgencyOf, WARN_MINUTES } from './KitchenPage';

const NOW = new Date('2026-10-14T12:00:00Z').getTime();
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const order = (over: Partial<GuestOrderDto> = {}): GuestOrderDto => ({
  id: 'o1',
  number: 'ЗК-000010',
  status: 'new',
  locationId: 'k1',
  locationName: 'Кухня',
  tableLabel: '7',
  comment: null,
  waiterId: 'w1',
  waiterName: 'Соколова Мария',
  lines: [{ id: 'l1', dishId: 'd1', dishName: 'Борщ с говядиной', quantity: 2, price: 290, note: null, isRemake: false }],
  total: 580,
  createdAt: at(2),
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
      <KitchenPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  post.mockReset();
  post.mockResolvedValue({});
  loading = false;
  orders = [];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('срочность по времени ожидания', () => {
  it('считает минуты и меняет цвет на границах', () => {
    expect(minutesSince(at(0), NOW)).toBe(0);
    expect(minutesSince(at(5), NOW)).toBe(5);
    expect(minutesSince(new Date(NOW + 60_000).toISOString(), NOW)).toBe(0);
    expect(urgencyOf(WARN_MINUTES - 1)).toBe('ok');
    expect(urgencyOf(WARN_MINUTES)).toBe('warn');
    expect(urgencyOf(LATE_MINUTES - 1)).toBe('warn');
    expect(urgencyOf(LATE_MINUTES)).toBe('late');
  });
});

describe('экран кухни', () => {
  it('без заказов говорит, что новые появятся сами', () => {
    show();
    expect(screen.getByText(/Заказов нет/)).toBeTruthy();
  });

  it('показывает новые и готовящиеся заказы раздельно, крупно, с пожеланиями и пометкой переделки', () => {
    orders = [
      order({ id: 'a', number: 'ЗК-000010', tableLabel: '7', comment: 'Гости торопятся', lines: [{ id: 'l1', dishId: 'd1', dishName: 'Борщ с говядиной', quantity: 2, price: 290, note: 'без сметаны', isRemake: false }] }),
      order({ id: 'b', number: 'ЗК-000011', tableLabel: '3', status: 'in_progress', acceptedAt: at(9), lines: [{ id: 'l2', dishId: 'd2', dishName: 'Куриное филе', quantity: 1, price: 420, note: null, isRemake: true }], openIncidents: 1 }),
    ];
    show();
    expect(screen.getByText('Стол 7')).toBeTruthy();
    expect(screen.getByText('без сметаны')).toBeTruthy();
    expect(screen.getByText('Гости торопятся')).toBeTruthy();
    expect(screen.getByText('ПЕРЕДЕЛКА')).toBeTruthy();
    expect(screen.getByText(/Есть обращение/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Взять в работу' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Готово/ })).toBeTruthy();
    // время ожидания считается от приёма в работу, а не от создания заказа
    expect(screen.getByTestId('order-ЗК-000011').textContent).toContain('9 мин');
    expect(screen.getByTestId('order-ЗК-000010').textContent).toContain('2 мин');
  });

  it('карточки окрашены по времени ожидания', () => {
    orders = [order({ id: 'a', number: 'ЗК-000001', createdAt: at(1) }), order({ id: 'b', number: 'ЗК-000002', createdAt: at(10) }), order({ id: 'c', number: 'ЗК-000003', createdAt: at(20) })];
    show();
    expect(screen.getByTestId('order-ЗК-000001').className).toMatch(/ok/);
    expect(screen.getByTestId('order-ЗК-000002').className).toMatch(/warn/);
    expect(screen.getByTestId('order-ЗК-000003').className).toMatch(/late/);
  });

  it('заказ, принятый без связи, ждёт с момента приёма, а не с момента, когда дошёл до сервера', () => {
    orders = [order({ id: 'a', number: 'ЗК-000030', createdAt: at(1), placedAt: at(20) })];
    show();
    expect(screen.getByTestId('order-ЗК-000030').className).toMatch(/late/);
  });

  it('старые заказы идут первыми', () => {
    orders = [order({ id: 'a', number: 'ЗК-000020', tableLabel: '20', createdAt: at(1) }), order({ id: 'b', number: 'ЗК-000021', tableLabel: '21', createdAt: at(5) })];
    show();
    const tables = screen.getAllByText(/^Стол \d+$/).map((el) => el.textContent);
    expect(tables).toEqual(['Стол 21', 'Стол 20']);
  });

  it('«Взять в работу» и «Готово» отправляют нужные статусы', async () => {
    orders = [order({ id: 'new1' }), order({ id: 'cook1', number: 'ЗК-000012', tableLabel: '5', status: 'in_progress', acceptedAt: at(3) })];
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Взять в работу' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/guest-orders/new1/status', { status: 'in_progress' }));
    fireEvent.click(screen.getByRole('button', { name: /Готово/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/guest-orders/cook1/status', { status: 'served' }));
  });

  it('ошибка сервера показывается на экране', async () => {
    post.mockRejectedValueOnce(new Error('Не хватает ингредиентов'));
    orders = [order()];
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Взять в работу' }));
    expect((await screen.findByRole('alert')).textContent).toBeTruthy();
  });

  it('показывает загрузку, а не пустой экран, пока заказы не пришли', () => {
    loading = true;
    show();
    expect(screen.getByText(/Загружаем/)).toBeTruthy();
    expect(screen.queryByText(/Заказов нет/)).toBeNull();
  });

  it('звук: сигнал только когда включён и пришёл новый заказ, не при первой загрузке', () => {
    const start = vi.fn();
    const ctor = vi.fn(function Ctx(this: Record<string, unknown>) {
      this.createOscillator = () => ({ frequency: { value: 0 }, connect: () => ({ connect: () => undefined }), start, stop: () => undefined, onended: null });
      this.createGain = () => ({ gain: { value: 0 }, connect: () => undefined });
      this.destination = {};
      this.currentTime = 0;
      this.close = () => Promise.resolve();
    });
    vi.stubGlobal('AudioContext', ctor);
    orders = [order({ id: 'a' })];
    const view = show();
    expect(start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Включить звук' }));
    orders = [order({ id: 'a' }), order({ id: 'b', number: 'ЗК-000011' })];
    act(() => {
      view.rerender(
        <MemoryRouter>
          <KitchenPage />
        </MemoryRouter>,
      );
    });
    expect(start).toHaveBeenCalledTimes(1);
    // тот же набор заказов сигнала не даёт
    orders = [order({ id: 'a' }), order({ id: 'b', number: 'ЗК-000011' })];
    act(() => {
      view.rerender(
        <MemoryRouter>
          <KitchenPage />
        </MemoryRouter>,
      );
    });
    expect(start).toHaveBeenCalledTimes(1);
  });
});
