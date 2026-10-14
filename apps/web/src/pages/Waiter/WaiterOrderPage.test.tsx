import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { WaiterDishDto } from '@zapas/shared';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
let menu: WaiterDishDto[] = [];

vi.mock('../../api/client', () => ({ post: (...a: unknown[]) => post(...a) }));
vi.mock('../../api/hooks', () => ({
  useGet: () => ({ data: menu, isLoading: false, error: null, refetch: vi.fn() }),
  useAction: (fn: (v: never) => Promise<unknown>) => ({
    isPending: false,
    mutate: (vars: never, opts?: { onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void }) => {
      fn(vars).then((r) => opts?.onSuccess?.(r), (e) => opts?.onError?.(e));
    },
  }),
}));
vi.mock('../../auth/ScopeProvider', () => ({ useScope: () => ({ locationId: 'k1' }) }));
vi.mock('../../components/Toast/Toast', () => ({ useToast: () => toast }));

import WaiterOrderPage from './WaiterOrderPage';

const dish = (over: Partial<WaiterDishDto>): WaiterDishDto => ({ id: 'd1', name: 'Борщ', price: 290, stopped: false, stopNote: null, ingredients: ['Говядина', 'Свёкла'], hot: false, ...over });

const show = () =>
  render(
    <MemoryRouter>
      <WaiterOrderPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  post.mockReset();
  menu = [dish({ id: 'd1', name: 'Борщ', hot: true }), dish({ id: 'd2', name: 'Омлет', price: 240 }), dish({ id: 'd3', name: 'Паста', stopped: true, stopNote: 'Не хватает: Сливки', price: 590 })];
});
afterEach(cleanup);

describe('заказ официанта', () => {
  it('блюдо из стоп-листа выбрать нельзя, причина видна', () => {
    show();
    expect(screen.getByText('Недоступно')).toBeTruthy();
    expect(screen.getByText(/Не хватает: Сливки/)).toBeTruthy();
    expect(screen.queryByLabelText('Добавить Паста')).toBeNull();
    expect(screen.getByLabelText('Добавить Борщ')).toBeTruthy();
  });

  it('горячие блюда помечены и стоят выше обычных', () => {
    show();
    expect(screen.getByText('горячее')).toBeTruthy();
    const names = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(names[0]).toContain('Борщ');
    expect(names.at(-1)).toContain('Паста');
  });

  it('считает сумму заказа и не отправляет без стола и без блюд', () => {
    show();
    fireEvent.click(screen.getByText('Отправить на кухню'));
    expect(screen.getByText('Укажите стол или номер заказа')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Например, 12'), { target: { value: '7' } });
    fireEvent.click(screen.getByText('Отправить на кухню'));
    expect(screen.getByText('Добавьте хотя бы одно блюдо')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Добавить Борщ'));
    fireEvent.click(screen.getByLabelText('Добавить Борщ'));
    fireEvent.click(screen.getByLabelText('Добавить Омлет'));
    expect(screen.getByText('3 порц.')).toBeTruthy();
    expect(screen.getByText(/820/)).toBeTruthy();
  });

  it('отправляет заказ с блюдами, количеством и столом', async () => {
    post.mockResolvedValue({ number: 'ЗК-000001' });
    show();
    fireEvent.change(screen.getByPlaceholderText('Например, 12'), { target: { value: '7' } });
    fireEvent.click(screen.getByLabelText('Добавить Борщ'));
    fireEvent.click(screen.getByLabelText('Добавить Борщ'));
    fireEvent.click(screen.getByText('Отправить на кухню'));
    await vi.waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0]?.[0]).toBe('/guest-orders');
    expect(post.mock.calls[0]?.[1]).toMatchObject({ locationId: 'k1', tableLabel: '7', lines: [{ dishId: 'd1', quantity: 2 }] });
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith('Заказ ЗК-000001 принят'));
  });
});
