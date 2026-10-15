import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { StaffOfferDto, StaffReservationDto, StorefrontSettingsDto } from '@zapas/shared';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
const put = vi.fn();
const confirm = vi.fn();
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
const LOC = '33333333-3333-4333-8333-333333333333';
let role: 'manager' | 'keeper' = 'manager';
let reservations: StaffReservationDto[] = [];
let offers: StaffOfferDto[] = [];
let settings: StorefrontSettingsDto[] = [];

vi.mock('../../api/client', () => ({ post: (...a: unknown[]) => post(...a), put: (...a: unknown[]) => put(...a), ApiError: class ApiError extends Error {} }));
vi.mock('../../api/hooks', () => ({
  useGet: (path: string) => {
    if (path === '/storefront/reservations') return { data: reservations, isLoading: false, error: null, refetch: vi.fn() };
    if (path === '/storefront/offers') return { data: offers, isLoading: false, error: null, refetch: vi.fn() };
    if (path === '/storefront/settings') return { data: settings, isLoading: false, error: null, refetch: vi.fn() };
    return { data: { items: [] }, isLoading: false, isSuccess: true, error: null };
  },
  useAction: (fn: (v: never) => Promise<unknown>) => ({
    isPending: false,
    variables: undefined,
    mutate: (vars: never, opts?: { onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void }) => {
      fn(vars).then((r) => opts?.onSuccess?.(r), (e) => opts?.onError?.(e));
    },
  }),
}));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ can: (r: string) => (r === 'manager' ? role === 'manager' : true) }) }));
vi.mock('../../auth/ScopeProvider', () => ({ useScope: () => ({ locationId: 'loc1' }) }));
vi.mock('../../lib/useLiveUpdates', () => ({ useLiveUpdates: () => ({ live: true }) }));
vi.mock('../../components/Toast/Toast', () => ({ useToast: () => toast }));
vi.mock('../../components/Toast/Confirm', () => ({ useConfirm: () => confirm }));

import StorefrontPage, { STATUS_TEXT } from './StorefrontPage';

const reservation = (over: Partial<StaffReservationDto> = {}): StaffReservationDto => ({
  id: 'r1',
  code: 'K7M2QX',
  status: 'reserved',
  locationId: 'loc1',
  locationName: 'Магазин Центр',
  productName: 'Йогурт',
  unit: 'kg',
  quantity: 2,
  total: 140,
  guestName: 'Анна',
  guestPhone: '79001234567',
  createdAt: '2026-10-14T10:00:00Z',
  expiresAt: '2026-10-14T12:00:00Z',
  closedAt: null,
  cancelReason: null,
  ...over,
});

const show = () =>
  render(
    <MemoryRouter>
      <StorefrontPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  post.mockReset().mockResolvedValue({});
  put.mockReset().mockResolvedValue({});
  confirm.mockReset().mockResolvedValue(true);
  Object.values(toast).forEach((f) => f.mockReset());
  role = 'manager';
  reservations = [reservation()];
  offers = [];
  settings = [{ locationId: LOC, locationName: 'Магазин Центр', enabled: true, slug: 'centr', note: null, publicPath: '/rescue/centr' }];
});
afterEach(cleanup);

describe('витрина для сотрудников', () => {
  it('бронь показана с кодом, гостем и суммой', () => {
    show();
    expect(screen.getByText('K7M2QX')).toBeTruthy();
    expect(screen.getByText(/Анна, \+79001234567/)).toBeTruthy();
    expect(screen.getByText('Ждёт гостя')).toBeTruthy();
  });

  it('выдача просит подтверждение и вызывает нужный адрес', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Выдать' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/storefront/reservations/r1/pickup'));
    expect(confirm.mock.calls[0]?.[0].message).toMatch(/спишется со склада/);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Бронь K7M2QX выдана'));
  });

  it('отказ в подтверждении ничего не отправляет', async () => {
    confirm.mockResolvedValue(false);
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Выдать' }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(post).not.toHaveBeenCalled();
  });

  it('закрытая бронь без кнопок, данные гостя, стёртые по сроку, объяснены', () => {
    reservations = [reservation({ status: 'picked_up', guestName: null, guestPhone: null })];
    show();
    expect(screen.queryByRole('button', { name: 'Выдать' })).toBeNull();
    expect(screen.getByText(/данные гостя стёрты/)).toBeTruthy();
    expect(STATUS_TEXT.picked_up.label).toBe('Выдано');
  });

  it('ошибка выдачи (нет товара) показывается сообщением', async () => {
    post.mockRejectedValue(new Error('Недостаточно товара'));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Выдать' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it('менеджер видит настройки и может сохранить их, кладовщик нет', async () => {
    show();
    expect(screen.getByText('Настройки по точкам')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/storefront/settings', { locationId: LOC, enabled: true, slug: 'centr' }));
    cleanup();
    role = 'keeper';
    show();
    expect(screen.queryByText('Настройки по точкам')).toBeNull();
    expect(screen.queryByRole('button', { name: /Выставить/ })).toBeNull();
  });

  it('предложение показывает остаток и причину, по которой оно скрыто', () => {
    offers = [
      {
        id: 'o1',
        batchId: 'b1',
        locationId: 'loc1',
        locationName: 'Магазин Центр',
        productName: 'Сыр',
        unit: 'kg',
        offered: 5,
        reserved: 2,
        sold: 1,
        available: 2,
        price: 350,
        percent: 30,
        expiresOn: '2026-10-16',
        daysLeft: 2,
        perGuestMax: 3,
        createdAt: '2026-10-14T09:00:00Z',
        closedAt: null,
        hiddenReason: 'Уценка закончилась или отменена',
      },
    ];
    show();
    expect(screen.getByText(/Выставлено 5 кг, в брони 2, выдано 1, свободно 2/)).toBeTruthy();
    expect(screen.getByText('Уценка закончилась или отменена')).toBeTruthy();
  });
});
