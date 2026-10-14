import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { OrderDetailDto } from '@zapas/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
const patch = vi.fn();
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
const confirm = vi.fn();
let detail: OrderDetailDto;

vi.mock('../../api/client', () => ({
  ApiError: class extends Error {},
  post: (...a: unknown[]) => post(...a),
  patch: (...a: unknown[]) => patch(...a),
  downloadFile: vi.fn(),
}));
vi.mock('../../api/hooks', () => ({
  useGet: () => ({ data: detail, isError: false, refetch: vi.fn() }),
  useAction: (fn: (v: never) => Promise<unknown>) => ({
    isPending: false,
    mutate: (vars: never, opts?: { onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void }) => {
      fn(vars).then((r) => opts?.onSuccess?.(r), (e) => opts?.onError?.(e));
    },
  }),
}));
vi.mock('../../components/Toast/Toast', () => ({ useToast: () => toast }));
vi.mock('../../components/Toast/Confirm', () => ({ useConfirm: () => confirm }));
vi.mock('../../components/ProductPicker/ProductPicker', () => ({ ProductPicker: () => <span>выбор продукта</span> }));

import { OrderDialog } from './OrderDialog';

const make = (over: Partial<OrderDetailDto> = {}): OrderDetailDto => ({
  id: 'o1',
  number: 'ЗК-000007',
  status: 'draft',
  supplierId: 's1',
  supplierName: 'Донской',
  supplierEmail: 'zakaz@donskoy.ru',
  locationId: 'l1',
  locationName: 'Магазин «Центр»',
  expectedOn: '2026-10-12',
  comment: null,
  total: 1440,
  lines: 1,
  createdAt: '2026-10-09T09:00:00.000Z',
  createdBy: null,
  sentAt: null,
  closedAt: null,
  emailedAt: null,
  emailError: null,
  deliveryOn: null,
  supplierNote: null,
  buyerNote: null,
  portalPushedAt: null,
  portalError: null,
  events: [],
  text: 'Заказ ЗК-000007 от 09.10.2026\n1. Яйца С1: 144 шт × 10,00 ₽',
  items: [{ productId: 'p1', productName: 'Яйца С1', sku: 'EGG-1', unit: 'pcs', shelfLifeDays: 25, quantity: 144, unitCost: 10, sum: 1440, receivedQty: 0 }],
  ...over,
});

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  for (const f of [post, patch, confirm, ...Object.values(toast)]) f.mockReset();
  detail = make();
});
afterEach(cleanup);

describe('черновик', () => {
  it('показывает, что собрал не человек, а система, и поля для правки', () => {
    render(<OrderDialog orderId="o1" onClose={() => undefined} />);
    expect(screen.getByText('собран автоматически')).toBeTruthy();
    expect((screen.getByLabelText('Количество: Яйца С1') as HTMLInputElement).value).toBe('144');
    expect(screen.getByRole('button', { name: 'Отправить поставщику' })).toBeTruthy();
  });

  it('отправка сначала сохраняет правки, потом отправляет, и сообщает, ушло ли письмо', async () => {
    confirm.mockResolvedValueOnce(true);
    patch.mockResolvedValueOnce(make());
    post.mockResolvedValueOnce(make({ status: 'sent', emailedAt: '2026-10-09T09:05:00.000Z' }));
    render(<OrderDialog orderId="o1" onClose={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Количество: Яйца С1'), { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить поставщику' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Заказ отправлен, письмо ушло поставщику'));
    expect(confirm.mock.calls[0]?.[0].message).toContain('zakaz@donskoy.ru');
    expect(patch).toHaveBeenCalledWith('/orders/o1', { lines: [{ productId: 'p1', quantity: 120, unitCost: 10 }], expectedOn: '2026-10-12', comment: null });
    expect(post).toHaveBeenCalledWith('/orders/o1/send', undefined);
    expect(patch.mock.invocationCallOrder[0]).toBeLessThan(post.mock.invocationCallOrder[0] as number);
  });

  it('если письмо не ушло, об этом честно сказано, а заказ остаётся отправленным', async () => {
    confirm.mockResolvedValueOnce(true);
    patch.mockResolvedValueOnce(make());
    post.mockResolvedValueOnce(make({ status: 'sent', emailError: 'нет соединения с почтовым сервером' }));
    render(<OrderDialog orderId="o1" onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Отправить поставщику' }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('Заказ отправлен, но письмо не ушло: нет соединения с почтовым сервером'));
  });

  it('без почты поставщика предупреждает заранее', () => {
    detail = make({ supplierEmail: null });
    render(<OrderDialog orderId="o1" onClose={() => undefined} />);
    expect(screen.getByText(/не указана почта/)).toBeTruthy();
  });

  it('неверное количество не уходит на сервер', async () => {
    render(<OrderDialog orderId="o1" onClose={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Количество: Яйца С1'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить поставщику' }));
    expect(await screen.findByText(/Строка 1: проверьте количество и цену/)).toBeTruthy();
    expect(confirm).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it('отказ в подтверждении ничего не отправляет', async () => {
    confirm.mockResolvedValueOnce(false);
    render(<OrderDialog orderId="o1" onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Отправить поставщику' }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(patch).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});

describe('отправленный заказ', () => {
  it('поля только для чтения, видно принятое, можно отправить письмо снова и закрыть заказ', async () => {
    detail = make({ status: 'partial', sentAt: '2026-10-09T09:05:00.000Z', items: [{ productId: 'p1', productName: 'Яйца С1', sku: 'EGG-1', unit: 'pcs', shelfLifeDays: 25, quantity: 144, unitCost: 10, sum: 1440, receivedQty: 100 }] });
    post.mockResolvedValue(detail);
    const onClose = vi.fn();
    render(<OrderDialog orderId="o1" onClose={onClose} />);
    expect(screen.queryByLabelText('Количество: Яйца С1')).toBeNull();
    expect(screen.getByText(/Часть заказа принята/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Отправить поставщику' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Отправить письмо ещё раз/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/orders/o1/resend', undefined));
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть заказ' }));
    fireEvent.change(screen.getByLabelText(/Почему закрываем/), { target: { value: 'Довёз меньше' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Закрыть заказ' }).at(-1)!);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/orders/o1/close', { comment: 'Довёз меньше' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('отмену просит подтвердить и предупреждает, что поставщику нужно сообщить самому', async () => {
    detail = make({ status: 'sent', sentAt: '2026-10-09T09:05:00.000Z' });
    confirm.mockResolvedValueOnce(true);
    post.mockResolvedValueOnce(make({ status: 'cancelled' }));
    render(<OrderDialog orderId="o1" onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Отменить заказ' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/orders/o1/cancel', undefined));
    expect(confirm.mock.calls[0]?.[0].message).toContain('Поставщику нужно сообщить самостоятельно');
  });

  it('текст заказа копируется в буфер', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<OrderDialog orderId="o1" onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Скопировать текст' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(detail.text));
    expect(toast.success).toHaveBeenCalledWith('Текст заказа скопирован');
  });
});
