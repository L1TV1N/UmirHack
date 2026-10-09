import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { parseScan, type ProductDto } from '@zapas/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScanHit } from '../../components/Scanner/ScanButton';
import type { ScanFeedback } from '../../components/Scanner/ScannerDialog';

const submit = vi.fn();
const getOrder = vi.fn();
let openOrders: object[] = [];
let feedback: ScanFeedback[] = [];

vi.mock('../../api/documents', () => ({ submitDocument: (...args: unknown[]) => submit(...args) }));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('../../api/hooks', () => ({
  STOCK_PREFIXES: [],
  useGet: (path: string) => (path === '/orders' ? { data: { items: openOrders, total: openOrders.length } } : { data: [] }),
  useAction: (fn: (v: object) => Promise<unknown>) => ({
    isPending: false,
    mutate: (vars: object, opts?: { onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void }) => {
      fn(vars).then((r) => opts?.onSuccess?.(r), (e) => opts?.onError?.(e));
    },
  }),
}));
vi.mock('../../api/client', () => ({ ApiError: class extends Error {}, put: vi.fn(), get: (...a: unknown[]) => getOrder(...a), newIdempotencyKey: () => 'key' }));
vi.mock('../../components/Toast/Toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock('./common', async () => {
  const actual = await vi.importActual<typeof import('./common')>('./common');
  return { ...actual, useOperationLocation: () => ['loc-1', vi.fn(), [{ id: 'loc-1', name: 'Центр' }]] };
});
vi.mock('./InvoiceImportDialog', () => ({ InvoiceImportDialog: () => null }));
vi.mock('../../components/ProductPicker/ProductPicker', () => ({
  ProductPicker: ({ value }: { value: { name: string } | null }) => <span>{value ? value.name : 'нет продукта'}</span>,
}));
vi.mock('../../components/Scanner/ScanButton', () => ({
  ScanButton: ({ onProduct }: { onProduct: (hit: ScanHit) => ScanFeedback }) => (
    <button type="button" onClick={() => feedback.push(onProduct((window as unknown as { __hit: ScanHit }).__hit))}>
      Скан
    </button>
  ),
}));

import { ReceiptForm } from './ReceiptForm';

const GS = '\u001d';
const product = (over: Partial<ProductDto> = {}): ProductDto => ({
  id: 'p1',
  sku: 'MLK',
  barcode: '4607000010006',
  name: 'Молоко',
  categoryId: 'c',
  categoryName: 'Молочные',
  unit: 'pcs',
  minStock: 0,
  shelfLifeDays: 7,
  price: 95,
  cost: 62,
  sellable: true,
  requiresVsd: true,
  requiresMarking: true,
  defaultSupplierId: null,
  defaultSupplierName: null,
  packSize: 1,
  isActive: true,
  ...over,
});
const code = (serial: string) => `0104607000010006${'21'}${serial}${GS}91EE11${GS}92dGVzdHRlc3Q=`;
const scan = (p: ProductDto, raw: string) => {
  (window as unknown as { __hit: ScanHit }).__hit = { product: p, scan: parseScan(raw) };
  fireEvent.click(screen.getByRole('button', { name: 'Скан' }));
};

beforeEach(() => {
  openOrders = [];
  getOrder.mockReset();
  feedback = [];
  submit.mockReset();
  submit.mockResolvedValue({ queued: false, result: { number: 'ПР-1' } });
});
afterEach(cleanup);

describe('приход с маркировкой и ВСД', () => {
  it('каждая отсканированная марка добавляет единицу и сохраняется в строке', async () => {
    render(<ReceiptForm />);
    const p = product();
    scan(p, code('AAAAAAAA1'));
    scan(p, code('AAAAAAAA2'));
    expect(feedback.map((f) => f.ok)).toEqual([true, true]);
    expect(feedback[1]?.message).toContain('марок: 2');
    expect((screen.getByLabelText('Количество') as HTMLInputElement).value).toBe('2');
    expect(await screen.findByText('марок: 2 из 2')).toBeTruthy();
  });

  it('та же марка во второй раз отклоняется и не меняет количество', () => {
    render(<ReceiptForm />);
    const p = product();
    scan(p, code('AAAAAAAA1'));
    scan(p, `${GS}${code('AAAAAAAA1')}`);
    expect(feedback[1]).toMatchObject({ ok: false });
    expect(feedback[1]?.message).toContain('уже отсканирована');
    expect((screen.getByLabelText('Количество') as HTMLInputElement).value).toBe('1');
  });

  it('марки и ВСД уходят на сервер, номер ВСД приводится к нижнему регистру', async () => {
    render(<ReceiptForm />);
    const p = product();
    const raw = code('AAAAAAAA1');
    scan(p, raw);
    fireEvent.change(screen.getByLabelText('Номер ВСД'), { target: { value: '1A2B3C4D-1234-5678-9ABC-DEF012345678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Провести приход' }));
    await waitFor(() => expect(submit).toHaveBeenCalled());
    const body = submit.mock.calls[0]?.[1].body as { lines: { vsd?: string; marks?: string[] }[] };
    expect(body.lines[0]).toMatchObject({ vsd: '1a2b3c4d-1234-5678-9abc-def012345678', marks: [raw] });
  });

  it('неверный номер ВСД не отправляется', async () => {
    render(<ReceiptForm />);
    scan(product(), code('AAAAAAAA1'));
    fireEvent.change(screen.getByLabelText('Номер ВСД'), { target: { value: 'не номер' } });
    fireEvent.click(screen.getByRole('button', { name: 'Провести приход' }));
    expect(await screen.findByText(/Номер ВСД это UUID/)).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
  });

  it('марок не может быть больше штук', async () => {
    render(<ReceiptForm />);
    scan(product(), code('AAAAAAAA1'));
    scan(product(), code('AAAAAAAA2'));
    fireEvent.change(screen.getByLabelText('Количество'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Провести приход' }));
    expect(await screen.findByText(/Марок \(2\) больше, чем штук \(1\)/)).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
  });

  it('один ВСД в двух строках не принимается', async () => {
    render(<ReceiptForm />);
    const a = product();
    const b = product({ id: 'p2', name: 'Кефир', barcode: '4006381333931' });
    scan(a, code('AAAAAAAA1'));
    // вторая строка: другой срок годности, поэтому отдельная
    scan(b, '4006381333931');
    const inputs = screen.getAllByLabelText('Номер ВСД');
    expect(inputs).toHaveLength(2);
    for (const input of inputs) fireEvent.change(input, { target: { value: '1a2b3c4d-1234-5678-9abc-def012345678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Провести приход' }));
    expect(await screen.findByText('Этот ВСД уже указан в другой строке')).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
  });

  it('товар без признаков ВСД и маркировки не получает лишних полей', () => {
    render(<ReceiptForm />);
    scan(product({ requiresVsd: false, requiresMarking: false }), '4607000010006');
    expect(screen.queryByLabelText('Номер ВСД')).toBeNull();
    expect(screen.queryByText(/нужны марки/)).toBeNull();
  });

  it('сброс марок убирает их из строки', async () => {
    render(<ReceiptForm />);
    scan(product(), code('AAAAAAAA1'));
    fireEvent.click(await screen.findByRole('button', { name: /Сбросить марки/ }));
    expect(await screen.findByText(/нужны марки/)).toBeTruthy();
    expect(within(document.body).queryByText(/марок: 1/)).toBeNull();
  });
});

describe('приход по заказу', () => {
  const summary = { id: 'o1', number: 'ЗК-000005', supplierName: 'Донской', total: 1440, status: 'sent' };
  const detail = {
    ...summary,
    supplierId: 's1',
    locationId: 'loc-1',
    items: [
      { productId: 'p1', productName: 'Яйца С1', sku: 'EGG', unit: 'pcs', shelfLifeDays: 20, quantity: 144, unitCost: 10, sum: 1440, receivedQty: 100 },
      { productId: 'p2', productName: 'Молоко', sku: 'MLK', unit: 'l', shelfLifeDays: null, quantity: 20, unitCost: 62, sum: 1240, receivedQty: 20 },
    ],
  };

  it('без открытых заказов выбора нет', () => {
    render(<ReceiptForm />);
    expect(screen.queryByLabelText(/Принять по заказу/)).toBeNull();
  });

  it('выбор заказа заполняет строки остатком к приёмке и уходит на сервер вместе с номером заказа', async () => {
    openOrders = [summary];
    getOrder.mockResolvedValue(detail);
    render(<ReceiptForm />);
    fireEvent.change(screen.getByLabelText(/Принять по заказу/), { target: { value: 'o1' } });
    await waitFor(() => expect((screen.getByLabelText('Количество') as HTMLInputElement).value).toBe('44'));
    // уже принятое полностью не возвращается в форму
    expect(screen.getAllByLabelText('Количество')).toHaveLength(1);
    expect(screen.getByText('Яйца С1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Провести приход' }));
    await waitFor(() => expect(submit).toHaveBeenCalled());
    const body = submit.mock.calls[0]?.[1].body as { orderId?: string; supplierId?: string; lines: { productId: string; quantity: number; unitCost: number }[] };
    expect(body).toMatchObject({ orderId: 'o1', supplierId: 's1' });
    expect(body.lines).toEqual([expect.objectContaining({ productId: 'p1', quantity: 44, unitCost: 10 })]);
  });

  it('заказ, по которому всё принято, в форму ничего не добавляет', async () => {
    openOrders = [summary];
    getOrder.mockResolvedValue({ ...detail, items: [detail.items[1]] });
    render(<ReceiptForm />);
    fireEvent.change(screen.getByLabelText(/Принять по заказу/), { target: { value: 'o1' } });
    await waitFor(() => expect(getOrder).toHaveBeenCalled());
    expect((screen.getByLabelText('Принять по заказу') as HTMLSelectElement).value).toBe('');
    expect(screen.getAllByLabelText('Количество')).toHaveLength(1);
    expect((screen.getByLabelText('Количество') as HTMLInputElement).value).toBe('');
  });
});
