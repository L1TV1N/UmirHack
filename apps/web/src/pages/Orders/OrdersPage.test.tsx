import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { OrderDto, OrderSuggestionDto } from '@zapas/shared';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
let suggestions: OrderSuggestionDto[] = [];
let orders: OrderDto[] = [];

vi.mock('../../api/client', () => ({
  ApiError: class ApiError extends Error {
    code: string;
    details: unknown;
    constructor(message: string, code = 'error', details?: unknown) {
      super(message);
      this.code = code;
      this.details = details;
    }
  },
  post: (...a: unknown[]) => post(...a),
}));
vi.mock('../../api/hooks', () => ({
  useGet: (path: string, query?: { status?: string }) => {
    if (path === '/orders/suggestions') return { data: suggestions, isLoading: false, isError: false };
    if (path === '/orders') {
      const items = query?.status === 'draft' ? orders.filter((o) => o.status === 'draft') : orders;
      return { data: { items, total: items.length, limit: 30, offset: 0 }, isLoading: false, isError: false };
    }
    return { data: undefined, isLoading: false, isError: false };
  },
  useAction: (fn: (v: never) => Promise<unknown>) => ({
    isPending: false,
    mutate: (vars: never, opts?: { onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void }) => {
      fn(vars).then((r) => opts?.onSuccess?.(r), (e) => opts?.onError?.(e));
    },
  }),
}));
vi.mock('../../auth/ScopeProvider', () => ({ useScope: () => ({ locationId: undefined, nameOf: () => '—' }) }));
vi.mock('../../components/Toast/Toast', () => ({ useToast: () => toast }));
vi.mock('./OrderDialog', () => ({
  STATUS_TONE: { draft: 'neutral', sent: 'info', partial: 'amber', received: 'ok', cancelled: 'neutral' },
  OrderDialog: ({ orderId }: { orderId: string | null }) => (orderId ? <div role="dialog">Открыт заказ {orderId}</div> : null),
}));

import { ApiError } from '../../api/client';
import OrdersPage from './OrdersPage';

const group = (over: Partial<OrderSuggestionDto> = {}): OrderSuggestionDto => ({
  supplierId: 's1',
  supplierName: 'Молочный комбинат «Донской»',
  supplierEmail: 'zakaz@donskoy.ru',
  leadTimeDays: 2,
  minOrderSum: 0,
  locationId: 'l1',
  locationName: 'Магазин «Центр»',
  total: 1440,
  belowMinimum: false,
  draftId: null,
  lines: [{ productId: 'p1', productName: 'Яйца С1', sku: 'EGG-1', unit: 'pcs', quantity: 144, unitCost: 10, sum: 1440, available: 25, incoming: 0, perDay: 20, daysCover: 1.3, packSize: 12, reason: 'Хватит на 1 день, поставка занимает 2 дня' }],
  ...over,
});

const order = (over: Partial<OrderDto> = {}): OrderDto => ({
  id: 'o1',
  number: 'ЗК-000001',
  status: 'sent',
  supplierId: 's1',
  supplierName: 'Донской',
  supplierEmail: null,
  locationId: 'l1',
  locationName: 'Магазин «Центр»',
  expectedOn: '2026-10-12',
  comment: null,
  total: 1440,
  lines: 1,
  createdAt: '2026-10-09T09:00:00.000Z',
  createdBy: 'Белова',
  sentAt: null,
  closedAt: null,
  emailedAt: null,
  emailError: null,
  ...over,
});

const show = (url = '/orders') =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <OrdersPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  post.mockReset();
  Object.values(toast).forEach((f) => f.mockReset());
  suggestions = [];
  orders = [];
});
afterEach(cleanup);

describe('что заказать', () => {
  it('показывает группы по поставщику и точке: строки, суммы, причину и срок поставки', () => {
    suggestions = [group()];
    show();
    expect(screen.getByText('Молочный комбинат «Донской» · Магазин «Центр»')).toBeTruthy();
    expect(screen.getByText(/1 поз\. на 1\s440\s₽, поставка занимает 2 сут\./)).toBeTruthy();
    expect(screen.getByText('Яйца С1')).toBeTruthy();
    expect(screen.getByText('Хватит на 1 день, поставка занимает 2 дня')).toBeTruthy();
    expect(screen.queryByText(/почта не указана/)).toBeNull();
  });

  it('предупреждает, если до минимального заказа не хватает, и если нет почты', () => {
    suggestions = [group({ minOrderSum: 5000, belowMinimum: true, supplierEmail: null })];
    show();
    expect(screen.getByText(/до минимального заказа 5\s000\s₽ не хватает 3\s560\s₽/)).toBeTruthy();
    expect(screen.getByText(/почта не указана/)).toBeTruthy();
  });

  it('создание черновика отправляет поставщика и точку, а не количества, и открывает заказ', async () => {
    suggestions = [group()];
    post.mockResolvedValueOnce({ id: 'new-order' });
    show();
    fireEvent.click(screen.getByRole('button', { name: /Создать черновик/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/orders/from-suggestion', { supplierId: 's1', locationId: 'l1' }));
    expect(await screen.findByText('Открыт заказ new-order')).toBeTruthy();
  });

  it('если черновик уже есть, открывается он, а не показывается ошибка', async () => {
    suggestions = [group()];
    post.mockRejectedValueOnce(new (ApiError as unknown as new (m: string, c: string, d: unknown) => Error)('уже есть', 'draft_exists', { orderId: 'old-draft' }));
    show();
    fireEvent.click(screen.getByRole('button', { name: /Создать черновик/ }));
    expect(await screen.findByText('Открыт заказ old-draft')).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('у группы с черновиком кнопка открывает его', async () => {
    suggestions = [group({ draftId: 'draft-1' })];
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Открыть черновик' }));
    expect(await screen.findByText('Открыт заказ draft-1')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it('когда заказывать нечего, объясняет почему и куда зайти', () => {
    show();
    expect(screen.getByText('Сейчас ничего заказывать не нужно')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Номенклатура' }).getAttribute('href')).toBe('/products');
  });
});

describe('список заказов', () => {
  it('показывает статусы, число черновиков во вкладке и открывает заказ по клику', async () => {
    orders = [order(), order({ id: 'o2', number: 'ЗК-000002', status: 'draft' })];
    show('/orders?tab=orders');
    expect(screen.getByRole('tab', { name: /Заказы \(черновиков 1\)/ })).toBeTruthy();
    expect(screen.getByText('Отправлен')).toBeTruthy();
    expect(screen.getByText('Черновик', { selector: 'span' })).toBeTruthy();
    fireEvent.click(screen.getByText('ЗК-000001'));
    expect(await screen.findByText('Открыт заказ o1')).toBeTruthy();
  });
});
