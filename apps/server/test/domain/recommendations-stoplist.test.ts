import { describe, expect, it } from 'vitest';
import {
  buildRecommendations,
  planRecommendations,
  type RecBatch,
  type RecInput,
  type RecLocation,
  type RecProduct,
} from '../../src/domain/recommendations';
import { evaluateAutoStops, stockKey, type StockPoint } from '../../src/domain/stoplist';

const kitchen: RecLocation = { id: 'L1', name: 'Кухня', kind: 'kitchen', isActive: true };
const shop: RecLocation = { id: 'L2', name: 'Магазин', kind: 'shop', isActive: true };
const milk: RecProduct = { id: 'P1', name: 'Молоко', unit: 'l', price: 100, cost: 60, minStock: 0, isActive: true };

function batch(over: Partial<RecBatch> & { id: string }): RecBatch {
  return {
    productId: 'P1',
    locationId: 'L1',
    remainingMilli: 20_000,
    expiresOn: '2026-10-12',
    receivedOn: '2026-10-05',
    daysLeft: 2,
    unitCost: 60,
    promoPercent: null,
    ...over,
  };
}

function input(over: Partial<RecInput> = {}): RecInput {
  return {
    products: new Map([[milk.id, milk]]),
    locations: new Map([
      [kitchen.id, kitchen],
      [shop.id, shop],
    ]),
    batches: [batch({ id: 'B1' })],
    velocities: new Map([[stockKey('P1', 'L1'), { perDay: 3, confidence: 1 }]]),
    tracked: new Set([stockKey('P1', 'L1')]),
    dishes: [],
    reorderCoverDays: 7,
    ...over,
  };
}

describe('рекомендации', () => {
  it('предлагает скидку на то, что не успеем продать', () => {
    const recs = buildRecommendations(input());
    const discount = recs.find((r) => r.type === 'discount');
    expect(discount).toBeDefined();
    // 3 в сутки, горизонт 3 дня: уйдёт 9 из 20
    expect(discount?.quantity).toBe(11);
    expect(discount?.action).toEqual({ kind: 'discount', percent: 30 });
    expect(discount?.atRiskValue).toBe(660);
    expect(discount?.recoveryValue).toBe(770);
  });

  it('штучный товар считает целыми штуками', () => {
    const bun: RecProduct = { id: 'P2', name: 'Булочка', unit: 'pcs', price: 35, cost: 17, minStock: 0, isActive: true };
    const recs = buildRecommendations(
      input({
        products: new Map([['P2', bun]]),
        batches: [batch({ id: 'B9', productId: 'P2', remainingMilli: 120_000, daysLeft: 1, unitCost: 17 })],
        velocities: new Map([[stockKey('P2', 'L1'), { perDay: 25.03, confidence: 1 }]]),
        tracked: new Set([stockKey('P2', 'L1')]),
      }),
    );
    const d = recs.find((r) => r.type === 'discount');
    // за два дня уйдёт около 50, под угрозой 69,94
    expect(d?.quantity).toBe(70);
    expect(Number.isInteger(d?.quantity)).toBe(true);
  });

  it('не предлагает переносить и уценивать товар с далёким сроком', () => {
    const rice: RecProduct = { id: 'P3', name: 'Рис', unit: 'kg', price: 150, cost: 95, minStock: 0, isActive: true };
    const recs = buildRecommendations(
      input({
        products: new Map([['P3', rice]]),
        batches: [batch({ id: 'B8', productId: 'P3', remainingMilli: 40_000, daysLeft: 500, locationId: 'L2' })],
        velocities: new Map([
          [stockKey('P3', 'L2'), { perDay: 0, confidence: 1 }],
          [stockKey('P3', 'L1'), { perDay: 5, confidence: 1 }],
        ]),
        tracked: new Set([stockKey('P3', 'L2'), stockKey('P3', 'L1')]),
      }),
    );
    expect(recs.filter((r) => r.type === 'transfer' || r.type === 'discount')).toEqual([]);
  });

  it('не повторяет скидку, если акция уже действует', () => {
    const recs = buildRecommendations(input({ batches: [batch({ id: 'B1', promoPercent: 30 })] }));
    expect(recs.find((r) => r.type === 'discount')).toBeUndefined();
  });

  it('ограничивает скидку себестоимостью, кроме последних суток', () => {
    const thin = { ...milk, cost: 97 };
    const two = buildRecommendations(input({ products: new Map([['P1', thin]]) }));
    expect(two.find((r) => r.type === 'discount')).toBeUndefined();

    const last = buildRecommendations(
      input({ products: new Map([['P1', thin]]), batches: [batch({ id: 'B1', daysLeft: 1, unitCost: 97 })] }),
    );
    expect(last.find((r) => r.type === 'discount')?.action).toEqual({ kind: 'discount', percent: 50 });
  });

  it('списывает просроченное', () => {
    const recs = buildRecommendations(input({ batches: [batch({ id: 'B1', daysLeft: -2, remainingMilli: 4000 })] }));
    const w = recs.find((r) => r.type === 'writeoff');
    expect(w?.quantity).toBe(4);
    expect(w?.atRiskValue).toBe(240);
    expect(recs.find((r) => r.type === 'discount')).toBeUndefined();
  });

  it('предлагает перемещение на точку, где продаётся быстрее', () => {
    const recs = buildRecommendations(
      input({
        batches: [batch({ id: 'B1', daysLeft: 4, expiresOn: '2026-10-14' })],
        velocities: new Map([
          [stockKey('P1', 'L1'), { perDay: 1, confidence: 1 }],
          [stockKey('P1', 'L2'), { perDay: 10, confidence: 1 }],
        ]),
      }),
    );
    const t = recs.find((r) => r.type === 'transfer');
    expect(t?.action.targetLocationId).toBe('L2');
    // под угрозой 20 − 1*5 = 15, магазин впитает 10*3 = 30
    expect(t?.quantity).toBe(15);
    // после перемещения скидка уже не нужна
    expect(recs.find((r) => r.type === 'discount')).toBeUndefined();
  });

  it('несколько источников не занимают одну и ту же ёмкость принимающей точки', () => {
    const third: RecLocation = { id: 'L3', name: 'Склад', kind: 'warehouse', isActive: true };
    const recs = buildRecommendations(
      input({
        locations: new Map([
          [kitchen.id, kitchen],
          [shop.id, shop],
          [third.id, third],
        ]),
        batches: [
          batch({ id: 'B1', daysLeft: 4, expiresOn: '2026-10-14', locationId: 'L1' }),
          batch({ id: 'B2', daysLeft: 4, expiresOn: '2026-10-14', locationId: 'L3' }),
        ],
        velocities: new Map([
          [stockKey('P1', 'L1'), { perDay: 1, confidence: 1 }],
          [stockKey('P1', 'L3'), { perDay: 1, confidence: 1 }],
          [stockKey('P1', 'L2'), { perDay: 10, confidence: 1 }],
        ]),
        tracked: new Set([stockKey('P1', 'L1'), stockKey('P1', 'L2'), stockKey('P1', 'L3')]),
      }),
    );
    const moved = recs.filter((r) => r.type === 'transfer' && r.action.targetLocationId === 'L2').reduce((s, r) => s + r.quantity, 0);
    // магазин расходует 10 в сутки, за три дня до конца срока примет не больше 30
    expect(moved).toBeLessThanOrEqual(30);
    expect(moved).toBeGreaterThan(0);
  });

  it('предлагает блюда для ингредиента под угрозой на кухне', () => {
    const recs = buildRecommendations(
      input({
        dishes: [
          { id: 'D1', name: 'Каша молочная', items: [{ productId: 'P1', qtyMilli: 200 }] },
          { id: 'D2', name: 'Суп', items: [{ productId: 'P9', qtyMilli: 100 }] },
        ],
      }),
    );
    const p = recs.find((r) => r.type === 'promote');
    expect(p?.dishes?.map((d) => d.id)).toEqual(['D1']);
  });

  it('рекомендует заказ при остатке ниже порога', () => {
    const low = { ...milk, minStock: 10 };
    const recs = buildRecommendations(
      input({ products: new Map([['P1', low]]), batches: [batch({ id: 'B1', remainingMilli: 4000, daysLeft: 20 })] }),
    );
    const r = recs.find((x) => x.type === 'reorder');
    expect(r).toBeDefined();
    // 3 в сутки на 7 дней = 21, минус 4 = 17
    expect(r?.reorder?.suggestedQty).toBe(17);
  });

  it('сортирует: списание раньше скидок', () => {
    const recs = buildRecommendations(
      input({
        batches: [batch({ id: 'B1' }), batch({ id: 'B2', daysLeft: -1, remainingMilli: 1000, expiresOn: '2026-10-09' })],
      }),
    );
    expect(recs[0]?.type).toBe('writeoff');
  });
});

describe('ограниченный список рекомендаций', () => {
  it('отдаёт самые приоритетные, а счётчики считает по всем', () => {
    const many = Array.from({ length: 40 }, (_, i) => batch({ id: `B${i}`, daysLeft: i % 2 === 0 ? -1 : 2, remainingMilli: 1000 + i * 100 }));
    const plan = planRecommendations(input({ batches: many, velocities: new Map() }), 10);
    expect(plan.items).toHaveLength(10);
    expect(plan.total).toBeGreaterThan(10);
    expect(plan.counts.writeoff + plan.counts.discount + plan.counts.transfer + plan.counts.promote + plan.counts.reorder).toBe(plan.total);
    // все десять самых важных это списания: они приоритетнее скидок
    expect(plan.items.every((r) => r.type === 'writeoff')).toBe(true);
    expect(plan.items.every((r) => r.headline.length > 0 && r.details.length > 0)).toBe(true);
  });
});

describe('выбор рекомендаций по точке и типу', () => {
  it('счётчики по точке точные, даже если в общий список она не попала', () => {
    const base = Array.from({ length: 30 }, (_, i) => batch({ id: `A${i}`, daysLeft: -1, remainingMilli: 5000 + i }));
    const other = batch({ id: 'Z1', locationId: 'L2', daysLeft: 2, remainingMilli: 1000 });
    const all = input({ batches: [...base, other], velocities: new Map() });
    const topOnly = planRecommendations(all, 5);
    expect(topOnly.items.every((r) => r.locationId !== 'L2')).toBe(true);
    const second = planRecommendations(all, 5, { locationIds: ['L2'] });
    expect(second.items).toHaveLength(1);
    expect(second.total).toBe(1);
    expect(second.counts.discount).toBe(1);
    expect(second.counts.writeoff).toBe(0);
  });

  it('фильтр по типу выбирает лучшие внутри типа и не меняет счётчики', () => {
    const many = Array.from({ length: 12 }, (_, i) => batch({ id: `B${i}`, daysLeft: i % 2 === 0 ? -1 : 2, remainingMilli: 1000 + i }));
    const plan = planRecommendations(input({ batches: many, velocities: new Map() }), 3, { types: ['discount'] });
    expect(plan.items).toHaveLength(3);
    expect(plan.items.every((r) => r.type === 'discount')).toBe(true);
    expect(plan.counts.writeoff).toBeGreaterThan(0);
    expect(plan.total).toBe(Object.values(plan.counts).reduce((a, b) => a + b, 0));
  });
});

describe('стоп-лист', () => {
  const products = new Map([
    ['P1', { id: 'P1', name: 'Молоко', unit: 'l' as const, sellable: true, isActive: true }],
    ['P2', { id: 'P2', name: 'Сыр', unit: 'kg' as const, sellable: false, isActive: true }],
    ['P3', { id: 'P3', name: 'Мука', unit: 'kg' as const, sellable: true, isActive: true }],
  ]);
  const locations = [
    { id: 'L1', name: 'Кухня', kind: 'kitchen' as const, isActive: true },
    { id: 'L2', name: 'Магазин', kind: 'shop' as const, isActive: true },
  ];

  function stock(entries: [string, number, number][]): Map<string, StockPoint> {
    return new Map(entries.map(([k, onHand, available]) => [k, { onHandMilli: onHand, availableMilli: available }]));
  }

  it('ставит в стоп продукт без доступного остатка и отличает просрочку', () => {
    const r = evaluateAutoStops({
      locations,
      products,
      dishes: [],
      stock: stock([[stockKey('P3', 'L2'), 5000, 0]]),
      tracked: new Set([stockKey('P1', 'L2'), stockKey('P3', 'L2')]),
      lowPortionThreshold: 3,
    });
    const byName = Object.fromEntries(r.stops.map((s) => [s.name, s.reasons[0]?.code]));
    expect(byName).toEqual({ Молоко: 'out_of_stock', Мука: 'all_expired' });
  });

  it('не трогает позиции, которых на точке никогда не было, и несобираемые продукты', () => {
    const r = evaluateAutoStops({
      locations,
      products,
      dishes: [],
      stock: stock([]),
      tracked: new Set([stockKey('P2', 'L2')]),
      lowPortionThreshold: 3,
    });
    expect(r.stops).toEqual([]);
  });

  it('ставит блюдо в стоп, когда не хватает ингредиента, и перечисляет нехватку', () => {
    const r = evaluateAutoStops({
      locations,
      products,
      dishes: [
        {
          id: 'D1',
          name: 'Сырники',
          isActive: true,
          items: [
            { productId: 'P1', qtyMilli: 200 },
            { productId: 'P2', qtyMilli: 150 },
          ],
        },
      ],
      stock: stock([
        [stockKey('P1', 'L1'), 5000, 5000],
        [stockKey('P2', 'L1'), 100, 100],
      ]),
      tracked: new Set([stockKey('P1', 'L1'), stockKey('P2', 'L1')]),
      lowPortionThreshold: 3,
    });
    expect(r.stops).toHaveLength(1);
    const reason = r.stops[0]?.reasons[0];
    expect(reason?.code).toBe('missing_ingredients');
    expect(reason?.missing?.[0]).toMatchObject({ name: 'Сыр', required: 0.15, available: 0.1 });
  });

  it('предупреждает, когда порций осталось мало, и не оценивает блюда вне кухонь', () => {
    const dish = { id: 'D1', name: 'Каша', isActive: true, items: [{ productId: 'P1', qtyMilli: 1000 }] };
    const r = evaluateAutoStops({
      locations,
      products,
      dishes: [dish],
      stock: stock([
        [stockKey('P1', 'L1'), 2500, 2500],
        [stockKey('P1', 'L2'), 0, 0],
      ]),
      tracked: new Set([stockKey('P1', 'L1'), stockKey('P1', 'L2')]),
      lowPortionThreshold: 3,
    });
    expect(r.warnings).toEqual([
      { dishId: 'D1', name: 'Каша', locationId: 'L1', locationName: 'Кухня', portions: 2 },
    ]);
    expect(r.stops.filter((s) => s.entityType === 'dish')).toEqual([]);
  });
});
