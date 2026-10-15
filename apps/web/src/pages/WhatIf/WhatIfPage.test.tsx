import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { BatchDto, DishDto, LocationDto, ProductDto, WhatIfResultDto } from '@zapas/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();

vi.mock('../../api/client', () => ({ post: (...a: unknown[]) => post(...a) }));
vi.mock('../../auth/ScopeProvider', () => ({ useScope: () => ({ locationId: '33333333-3333-4333-8333-333333333333' }) }));
vi.mock('../../api/hooks', () => ({
  useGet: (path: string) => {
    if (path === '/stock/batches') return { data: { items: [batch] }, error: null };
    if (path === '/products') return { data: { items: [product] }, error: null };
    if (path === '/locations') return { data: locations, error: null };
    return { data: [dish], error: null };
  },
  useAction: (fn: (v: never) => Promise<unknown>) => ({
    isPending: false,
    mutate: (vars: never, opts?: { onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void }) => {
      fn(vars).then((r) => opts?.onSuccess?.(r), (e) => opts?.onError?.(e));
    },
  }),
}));

import WhatIfPage, { buildBody, Delta, emptyDraft, WhatIfResult } from './WhatIfPage';

const BATCH_ID = '11111111-1111-4111-8111-111111111111';
const PRODUCT_ID = '22222222-2222-4222-8222-222222222222';
const LOC = '33333333-3333-4333-8333-333333333333';
const LOC2 = '44444444-4444-4444-8444-444444444444';
const DISH = '55555555-5555-4555-8555-555555555555';

const batch = { id: BATCH_ID, productId: PRODUCT_ID, productName: 'Сыр', unit: 'kg', locationId: LOC, locationName: 'Центр', expiresOn: '2026-10-16', remainingQty: 5 } as unknown as BatchDto;
const product = { id: PRODUCT_ID, name: 'Сыр', unit: 'kg' } as unknown as ProductDto;
const locations = [
  { id: LOC, name: 'Центр', kind: 'shop', isActive: true },
  { id: LOC2, name: 'Кухня', kind: 'kitchen', isActive: true },
] as unknown as LocationDto[];
const dish = { id: DISH, name: 'Борщ', isActive: true, items: [] } as unknown as DishDto;

const metrics = { stockValue: 2000, atRiskValue: 1500, expiredValue: 0, expiringSoonValue: 2000, stopCount: 1, hotCount: 2 };
const result = (over: Partial<WhatIfResultDto> = {}): WhatIfResultDto => ({
  persisted: false,
  asOf: '2026-10-15T09:00:00Z',
  steps: [{ index: 0, type: 'writeoff', ok: true, text: 'Сыр: списать 5 кг, потеря 2 000 ₽', cost: 2000 }],
  before: metrics,
  after: { ...metrics, stockValue: 0, atRiskValue: 0, stopCount: 2 },
  stopAdded: [{ entityType: 'dish', entityId: DISH, name: 'Борщ', locationId: LOC2, locationName: 'Кухня', reason: 'Нет в наличии' }],
  stopRemoved: [],
  hotBefore: [{ dishId: DISH, dishName: 'Борщ', locationName: 'Кухня', priority: 70 }],
  hotAfter: [],
  notes: ['Это прогон в сухую: в базу ничего не записывается.'],
  ...over,
});

beforeEach(() => post.mockReset());
afterEach(cleanup);

describe('сборка сценария', () => {
  it('списание без количества означает всю партию', () => {
    const d = { ...emptyDraft('writeoff'), batchId: BATCH_ID };
    expect(buildBody([emptyDraft('writeoff')], LOC).body).toBeUndefined();
    const ok = buildBody([d], LOC);
    expect(ok.body?.actions).toEqual([{ type: 'writeoff', batchId: BATCH_ID }]);
    expect(ok.body?.locationId).toBe(LOC);
  });

  it('количество принимается с запятой', () => {
    const ok = buildBody([{ ...emptyDraft('writeoff'), batchId: BATCH_ID, quantity: '1,5' }], undefined);
    expect(ok.body?.actions[0]).toMatchObject({ quantity: 1.5 });
  });

  it('незаполненные шаги называются по номеру', () => {
    expect(buildBody([emptyDraft('writeoff')], undefined).error).toBe('Шаг 1: выберите партию');
    expect(buildBody([{ ...emptyDraft('writeoff'), batchId: BATCH_ID }, emptyDraft('transfer')], undefined).error).toBe('Шаг 2: выберите партию');
    expect(buildBody([{ ...emptyDraft('receive'), productId: PRODUCT_ID, locationId: LOC }], undefined).error).toMatch(/Шаг 1: укажите количество/);
    expect(buildBody([{ ...emptyDraft('receive'), productId: PRODUCT_ID, locationId: LOC, quantity: '3' }], undefined).error).toMatch(/срок годности/);
    expect(buildBody([{ ...emptyDraft('cook'), dishId: DISH, locationId: LOC2, portions: '2,5' }], undefined).error).toMatch(/число порций/);
    expect(buildBody([{ ...emptyDraft('demand'), productId: PRODUCT_ID, locationId: LOC, factor: '9' }], undefined).error).toMatch(/от 0,1 до 5/);
  });

  it('каждый тип шага собирается в тело запроса', () => {
    const body = buildBody(
      [
        { ...emptyDraft('receive'), productId: PRODUCT_ID, locationId: LOC, quantity: '3', shelfDays: '5' },
        { ...emptyDraft('transfer'), batchId: BATCH_ID, toLocationId: LOC2 },
        { ...emptyDraft('cook'), dishId: DISH, locationId: LOC2, portions: '4' },
        { ...emptyDraft('demand'), productId: PRODUCT_ID, locationId: LOC, factor: '1,5' },
      ],
      undefined,
    ).body;
    expect(body?.actions.map((a) => a.type)).toEqual(['receive', 'transfer', 'cook', 'demand']);
    expect(body?.actions[3]).toMatchObject({ factor: 1.5 });
  });
});

describe('показ результата', () => {
  it('рост риска красный, падение зелёное, без изменений серое', () => {
    const { container } = render(
      <>
        <Delta before={100} after={50} money upIsBad />
        <Delta before={1} after={3} money={false} upIsBad />
        <Delta before={5} after={5} money upIsBad />
      </>,
    );
    const spans = [...container.querySelectorAll('span')];
    expect(spans[0]?.className).toMatch(/good/);
    expect(spans[0]?.textContent).toMatch(/^-/);
    expect(spans[1]?.className).toMatch(/bad/);
    expect(spans[1]?.textContent).toBe('+2');
    expect(spans[2]?.textContent).toBe('без изменений');
  });

  it('показывает, что ничего не записано, шаги, стоп-лист и сравнение горячих блюд', () => {
    render(<WhatIfResult result={result()} />);
    expect(screen.getByText(/Ничего не записано/)).toBeTruthy();
    expect(screen.getByText(/Сыр: списать 5 кг/)).toBeTruthy();
    expect(screen.getByText('Уйдёт в стоп-лист')).toBeTruthy();
    expect(screen.getAllByText(/Борщ/).length).toBeGreaterThan(1);
    expect(screen.getByText('Ничего')).toBeTruthy();
  });

  it('невыполненный шаг показан отдельно', () => {
    render(<WhatIfResult result={result({ steps: [{ index: 0, type: 'cook', ok: false, text: 'Борщ: хватит только на 3 порц.', cost: 0 }] })} />);
    expect(screen.getByText(/хватит только на 3 порц/).closest('li')?.className).toMatch(/stepFail/);
  });
});

describe('страница', () => {
  it('без выбора партии не отправляет запрос и говорит, чего не хватает', () => {
    render(<WhatIfPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Посчитать' }));
    expect(screen.getByText('Шаг 1: выберите партию')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it('отправляет сценарий по выбранной точке и показывает ответ', async () => {
    post.mockResolvedValue(result());
    render(<WhatIfPage />);
    fireEvent.change(screen.getByLabelText('Партия'), { target: { value: BATCH_ID } });
    fireEvent.click(screen.getByRole('button', { name: 'Посчитать' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/analytics/what-if', { locationId: LOC, actions: [{ type: 'writeoff', batchId: BATCH_ID }] }));
    expect(await screen.findByText(/Ничего не записано/)).toBeTruthy();
  });

  it('шаги можно добавлять и убирать, но не больше десяти', () => {
    render(<WhatIfPage />);
    for (let i = 0; i < 12; i += 1) fireEvent.click(screen.getByRole('button', { name: 'Добавить шаг' }));
    expect(screen.getAllByText(/^Шаг \d+$/)).toHaveLength(10);
    expect((screen.getByRole('button', { name: 'Добавить шаг' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Убрать шаг 10' }));
    expect(screen.getAllByText(/^Шаг \d+$/)).toHaveLength(9);
  });

  it('смена типа шага меняет поля', () => {
    render(<WhatIfPage />);
    fireEvent.change(screen.getByLabelText('Шаг 1: действие'), { target: { value: 'cook' } });
    expect(screen.getByLabelText('Блюдо')).toBeTruthy();
    expect(screen.getByLabelText('Порций')).toBeTruthy();
    expect(screen.queryByLabelText('Партия')).toBeNull();
  });
});
