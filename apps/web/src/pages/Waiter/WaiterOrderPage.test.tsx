import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { WaiterDishDto } from '@zapas/shared';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const submit = vi.fn();
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
let menu: WaiterDishDto[] = [];
let offline = false;

vi.mock('../../api/documents', () => ({ submitDocument: (...a: unknown[]) => submit(...a) }));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('../../lib/useWaiterGet', () => ({ useWaiterGet: () => ({ data: menu, isLoading: false, error: null, refetch: vi.fn(), offline, savedAt: offline ? Date.parse('2026-10-14T11:02:00Z') : null }) }));
vi.mock('../../api/hooks', () => ({
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
  submit.mockReset();
  offline = false;
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
    submit.mockResolvedValue({ queued: false, result: { number: 'ЗК-000001' } });
    show();
    fireEvent.change(screen.getByPlaceholderText('Например, 12'), { target: { value: '7' } });
    fireEvent.click(screen.getByLabelText('Добавить Борщ'));
    fireEvent.click(screen.getByLabelText('Добавить Борщ'));
    fireEvent.click(screen.getByText('Отправить на кухню'));
    await vi.waitFor(() => expect(submit).toHaveBeenCalled());
    const [userId, doc] = submit.mock.calls[0] as [string, { path: string; body: object; key: string; label: string }];
    expect(userId).toBe('u1');
    expect(doc.path).toBe('/guest-orders');
    expect(doc.body).toMatchObject({ locationId: 'k1', tableLabel: '7', lines: [{ dishId: 'd1', quantity: 2 }] });
    expect(doc.key).toMatch(/^order-[0-9a-f-]{36}$/);
    expect(doc.label).toBe('Заказ, стол 7');
    expect(Date.now() - Date.parse((doc.body as { placedAt: string }).placedAt)).toBeLessThan(5000);
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith('Заказ ЗК-000001 принят'));
  });

  it('без связи заказ уходит в очередь, об этом сказано, а следующий заказ получает новый ключ', async () => {
    submit.mockResolvedValue({ queued: true });
    show();
    const order = async () => {
      fireEvent.change(screen.getByPlaceholderText('Например, 12'), { target: { value: '3' } });
      fireEvent.click(screen.getByLabelText('Добавить Омлет'));
      fireEvent.click(screen.getByText('Отправить на кухню'));
    };
    await order();
    await vi.waitFor(() => expect(toast.info).toHaveBeenCalledWith(expect.stringContaining('сохранён на телефоне')));
    expect(toast.success).not.toHaveBeenCalled();
    await vi.waitFor(() => expect((screen.getByPlaceholderText('Например, 12') as HTMLInputElement).value).toBe(''));
    await order();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[0]?.[1].key).not.toBe(submit.mock.calls[1]?.[1].key);
  });

  it('повторная попытка того же заказа после ошибки уходит с тем же ключом', async () => {
    submit.mockRejectedValueOnce(new Error('кухня отказала')).mockResolvedValue({ queued: false, result: { number: 'ЗК-000002' } });
    show();
    fireEvent.change(screen.getByPlaceholderText('Например, 12'), { target: { value: '9' } });
    fireEvent.click(screen.getByLabelText('Добавить Борщ'));
    fireEvent.click(screen.getByText('Отправить на кухню'));
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText('Отправить на кухню'));
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[0]?.[1].key).toBe(submit.mock.calls[1]?.[1].key);
  });

  it('меню из памяти телефона помечено: видно, на какое время данные', () => {
    offline = true;
    show();
    expect(screen.getByText(/Нет связи\. Данные на/)).toBeTruthy();
    expect(screen.getByLabelText('Добавить Борщ')).toBeTruthy();
  });

  it('блюдо ушло в стоп-лист, пока собирали заказ: его убирают из заказа и говорят об этом', () => {
    const view = show();
    fireEvent.click(screen.getByLabelText('Добавить Борщ'));
    fireEvent.click(screen.getByLabelText('Добавить Омлет'));
    expect(screen.getByText('2 порц.')).toBeTruthy();
    menu = [dish({ id: 'd1', name: 'Борщ', hot: true, stopped: true, stopNote: 'Не хватает: Сметана' }), dish({ id: 'd2', name: 'Омлет', price: 240 }), dish({ id: 'd3', name: 'Паста', stopped: true, stopNote: 'Не хватает: Сливки', price: 590 })];
    view.rerender(
      <MemoryRouter>
        <WaiterOrderPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('1 порц.')).toBeTruthy();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Борщ'));
    expect(screen.queryByLabelText('Добавить Борщ')).toBeNull();
  });
});
