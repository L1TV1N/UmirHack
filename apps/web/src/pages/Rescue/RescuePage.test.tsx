import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PublicRescueDto } from '@zapas/shared';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { FakeApiError, api } = vi.hoisted(() => {
  class FakeApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return { FakeApiError, api: vi.fn() };
});
let data: PublicRescueDto | undefined;
const refetch = vi.fn();

vi.mock('../../api/client', () => ({ ApiError: FakeApiError, api: (...a: unknown[]) => api(...a) }));
vi.mock('../../api/hooks', () => ({ useGet: () => ({ data, isLoading: false, isError: false, refetch }) }));

import RescuePage, { dayText } from './RescuePage';

const OFFER = '11111111-1111-4111-8111-111111111111';
const feed = (): PublicRescueDto => ({
  holdMinutes: 120,
  venues: [
    {
      slug: 'centr',
      name: 'Магазин Центр',
      address: 'ул. Ленина, 1',
      note: 'Касса справа',
      offers: [{ id: OFFER, productName: 'Йогурт', unit: 'kg', available: 6, price: 70, oldPrice: 100, percent: 30, expiresOn: '2026-10-16', daysLeft: 2, perGuestMax: 3 }],
    },
  ],
});

const show = () =>
  render(
    <MemoryRouter>
      <RescuePage />
    </MemoryRouter>,
  );

async function fill(over: { qty?: string; consent?: boolean } = {}) {
  fireEvent.click(screen.getByRole('button', { name: 'Забронировать' }));
  fireEvent.change(await screen.findByLabelText(/Сколько/), { target: { value: over.qty ?? '2' } });
  fireEvent.change(screen.getByLabelText('Ваше имя'), { target: { value: 'Анна' } });
  fireEvent.change(screen.getByLabelText('Телефон'), { target: { value: '+7 900 123-45-67' } });
  if (over.consent !== false) fireEvent.click(screen.getByRole('checkbox'));
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  api.mockReset();
  refetch.mockReset();
  data = feed();
});
afterEach(cleanup);

describe('публичная витрина', () => {
  it('показывает точки, цену со скидкой и остаток, без входа', () => {
    show();
    expect(screen.getByText('Магазин Центр')).toBeTruthy();
    expect(screen.getByText('ул. Ленина, 1')).toBeTruthy();
    expect(screen.getByText('Йогурт')).toBeTruthy();
    expect(screen.getByText('-30%')).toBeTruthy();
    expect(screen.getByText(/осталось 6 кг/)).toBeTruthy();
  });

  it('без предложений говорит об этом по-человечески', () => {
    data = { venues: [], holdMinutes: 120 };
    show();
    expect(screen.getByText('Сейчас предложений нет')).toBeTruthy();
  });

  it('срок называется по-человечески', () => {
    expect(dayText(0, '2026-10-14')).toBe('годен сегодня');
    expect(dayText(1, '2026-10-15')).toBe('годен до завтра');
    expect(dayText(3, '2026-10-17')).toBe('годен до 17.10');
  });

  it('без согласия бронь не уходит на сервер', async () => {
    show();
    await fill({ consent: false });
    fireEvent.click(screen.getAllByRole('button', { name: 'Забронировать' }).at(-1) as HTMLElement);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(api).not.toHaveBeenCalled();
  });

  it('больше лимита на гостя нельзя', async () => {
    show();
    await fill({ qty: '5' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Забронировать' }).at(-1) as HTMLElement);
    expect((await screen.findByRole('alert')).textContent).toMatch(/не больше 3/);
    expect(api).not.toHaveBeenCalled();
  });

  it('успешная бронь показывает крупный код и время, запрос уходит без авторизации и с цифрами телефона', async () => {
    api.mockResolvedValue({ code: 'K7M2QX', expiresAt: '2026-10-14T14:00:00Z', venue: 'Магазин Центр', address: null, note: null, productName: 'Йогурт', unit: 'kg', quantity: 2, total: 140 });
    show();
    await fill();
    fireEvent.click(screen.getAllByRole('button', { name: 'Забронировать' }).at(-1) as HTMLElement);
    expect(await screen.findByLabelText('Код брони')).toBeTruthy();
    expect(screen.getByLabelText('Код брони').textContent).toBe('K7M2QX');
    const [method, path, opts] = api.mock.calls[0] as [string, string, { body: Record<string, unknown>; auth: boolean }];
    expect(method).toBe('POST');
    expect(path).toBe('/public/rescue/reservations');
    expect(opts.auth).toBe(false);
    expect(opts.body).toMatchObject({ offerId: OFFER, quantity: 2, name: 'Анна', phone: '79001234567', consent: true });
    expect(opts.body.website).toBeUndefined();
    expect(refetch).toHaveBeenCalled();
  });

  it('ошибка сервера показывается в окне брони, например когда остаток разобрали', async () => {
    api.mockRejectedValue(new FakeApiError(409, 'Осталось только 1'));
    show();
    await fill();
    fireEvent.click(screen.getAllByRole('button', { name: 'Забронировать' }).at(-1) as HTMLElement);
    expect(await screen.findByText('Осталось только 1')).toBeTruthy();
  });

  it('бронь можно отменить из квитанции тем же телефоном', async () => {
    api.mockResolvedValueOnce({ code: 'K7M2QX', expiresAt: '2026-10-14T14:00:00Z', venue: 'Магазин Центр', address: null, note: null, productName: 'Йогурт', unit: 'kg', quantity: 1, total: 70 }).mockResolvedValueOnce(undefined);
    show();
    await fill({ qty: '1' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Забронировать' }).at(-1) as HTMLElement);
    fireEvent.click(await screen.findByRole('button', { name: 'Отменить бронь' }));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
    expect(api.mock.calls[1]?.[1]).toBe('/public/rescue/reservations/cancel');
    expect((api.mock.calls[1]?.[2] as { body: object }).body).toEqual({ code: 'K7M2QX', phone: '79001234567' });
  });

  it('поле-ловушка скрыто от людей', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Забронировать' }));
    const trap = (await screen.findByLabelText('Сайт', { selector: 'input' })) as HTMLInputElement;
    expect(trap.closest('[aria-hidden="true"]')).toBeTruthy();
    expect(trap.tabIndex).toBe(-1);
  });
});
