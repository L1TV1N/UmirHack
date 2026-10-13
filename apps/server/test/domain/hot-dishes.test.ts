import { describe, expect, it } from 'vitest';
import { computeHotDishes, MAX_PUSH_PORTIONS, type HotDish, type HotInput } from '../../src/domain/hot-dishes';
import type { RecBatch, RecLocation, RecProduct, RecVelocity } from '../../src/domain/recommendations';
import { stockKey, type StockPoint } from '../../src/domain/stoplist';

const kitchen: RecLocation = { id: 'K', name: 'Кухня', kind: 'kitchen', isActive: true };
const shop: RecLocation = { id: 'S', name: 'Магазин', kind: 'shop', isActive: true };

const NAMES: Record<string, string> = {
  milk: 'Молоко',
  kefir: 'Кефир',
  cream: 'Сливки',
  butter: 'Масло',
  beef: 'Говядина',
  potato: 'Картофель',
  sour: 'Сметана',
  flour: 'Мука',
  eggs: 'Яйца',
};

const products = new Map<string, RecProduct>(
  Object.entries(NAMES).map(([id, name]) => [id, { id, name, unit: id === 'eggs' ? 'pcs' : 'kg', price: 100, cost: 50, minStock: 0, isActive: true }]),
);

function batch(id: string, productId: string, qty: number, daysLeft: number, over: Partial<RecBatch> = {}): RecBatch {
  return {
    id,
    productId,
    locationId: kitchen.id,
    remainingMilli: Math.round(qty * 1000),
    expiresOn: `2026-10-${String(10 + daysLeft).padStart(2, '0')}`,
    receivedOn: '2026-10-01',
    daysLeft,
    unitCost: 50,
    promoPercent: null,
    ...over,
  };
}

function dish(id: string, name: string, items: [string, number][]): HotDish {
  return { id, name, price: 300, items: items.map(([productId, qty]) => ({ productId, qtyMilli: Math.round(qty * 1000) })) };
}

function scene(batches: RecBatch[], dishes: HotDish[], extra: Partial<HotInput> = {}, velocity: RecVelocity | null = { perDay: 0, confidence: 1 }) {
  const stock = new Map<string, StockPoint>();
  const velocities = new Map<string, RecVelocity>();
  for (const b of batches) {
    const key = stockKey(b.productId, b.locationId);
    const point = stock.get(key) ?? { onHandMilli: 0, availableMilli: 0 };
    point.onHandMilli += b.remainingMilli;
    if (b.daysLeft >= 0) point.availableMilli += b.remainingMilli;
    stock.set(key, point);
    if (velocity) velocities.set(key, velocity);
  }
  return computeHotDishes({ products, locations: new Map([[kitchen.id, kitchen], [shop.id, shop]]), batches, velocities, dishes, stock, ...extra });
}

const byName = (list: ReturnType<typeof scene>, name: string) => list.find((d) => d.dishName === name);

describe('горячие предложения', () => {
  it('чем ближе конец срока, тем выше приоритет блюда', () => {
    const list = scene(
      [batch('B1', 'milk', 2, 0), batch('B2', 'kefir', 2, 5)],
      [dish('d1', 'Каша', [['milk', 0.1]]), dish('d2', 'Оладьи', [['kefir', 0.1]])],
    );
    const kasha = byName(list, 'Каша');
    const oladi = byName(list, 'Оладьи');
    expect(kasha).toBeDefined();
    expect(oladi).toBeDefined();
    expect(kasha!.priority).toBeGreaterThan(oladi!.priority);
    expect(list[0]?.dishName).toBe('Каша');
    expect(kasha!.daysLeft).toBe(0);
  });

  it('второй истекающий ингредиент поднимает приоритет', () => {
    const list = scene(
      [batch('B1', 'milk', 2, 2), batch('B2', 'cream', 2, 2), batch('B3', 'butter', 2, 2)],
      [dish('d1', 'Каша', [['milk', 0.1]]), dish('d2', 'Паста', [['cream', 0.1], ['butter', 0.1]])],
    );
    expect(byName(list, 'Паста')!.priority).toBeGreaterThan(byName(list, 'Каша')!.priority);
    expect(byName(list, 'Паста')!.reasons).toHaveLength(2);
    expect(byName(list, 'Паста')!.priority).toBeLessThan(101);
  });

  it('чем больше истекающего остатка, тем меньшую его часть закроет блюдо', () => {
    const list = scene(
      [batch('B1', 'milk', 2, 1), batch('B2', 'kefir', 8, 1)],
      [dish('d1', 'Каша', [['milk', 0.1]]), dish('d2', 'Оладьи', [['kefir', 0.1]])],
    );
    const small = byName(list, 'Каша')!;
    const large = byName(list, 'Оладьи')!;
    expect(small.reasons[0]?.share).toBe(1);
    expect(large.reasons[0]?.share).toBeCloseTo(0.3, 2);
    expect(small.priority).toBeGreaterThan(large.priority);
  });

  it('блюдо, которое почти не влияет на большой остаток, в список не попадает', () => {
    const list = scene([batch('B1', 'kefir', 40, 1)], [dish('d1', 'Оладьи', [['kefir', 0.1]])]);
    expect(list).toHaveLength(0);
  });

  it('учитывает, сколько ингредиента уходит на порцию', () => {
    const list = scene(
      [batch('B1', 'beef', 3, 1), batch('B2', 'potato', 3, 1)],
      [dish('d1', 'Жаркое', [['beef', 0.2]]), dish('d2', 'Пюре', [['potato', 0.02]])],
    );
    const stew = byName(list, 'Жаркое')!;
    const puree = byName(list, 'Пюре')!;
    expect(stew.reasons[0]?.portionsToUse).toBe(15);
    expect(puree.reasons[0]?.portionsToUse).toBe(MAX_PUSH_PORTIONS);
    expect(stew.priority).toBeGreaterThan(puree.priority);
  });

  it('если продажи и так выбирают партию, приоритет ниже, чем когда она не уйдёт', () => {
    const batches = [batch('B1', 'milk', 5, 2), batch('B2', 'kefir', 5, 2)];
    const dishes = [dish('d1', 'Каша', [['milk', 0.2]]), dish('d2', 'Оладьи', [['kefir', 0.2]])];
    const velocities = new Map<string, RecVelocity>([
      [stockKey('milk', 'K'), { perDay: 10, confidence: 1 }],
      [stockKey('kefir', 'K'), { perDay: 0.1, confidence: 1 }],
    ]);
    const list = scene(batches, dishes, { velocities }, null);
    expect(byName(list, 'Оладьи')!.priority).toBeGreaterThan(byName(list, 'Каша')!.priority);
    expect(byName(list, 'Каша')!.priority).toBeGreaterThan(0);
  });

  it('остаток, нужный нескольким блюдам, делится между ними', () => {
    const list = scene(
      [batch('B1', 'sour', 1, 1)],
      [dish('d1', 'Борщ', [['sour', 0.03]]), dish('d2', 'Блины', [['sour', 0.02]])],
    );
    expect(list).toHaveLength(2);
    const first = list[0]!;
    const second = list[1]!;
    expect(first.priority).toBeGreaterThan(second.priority);
    expect(first.reasons[0]?.sharedWith).toEqual([second.dishName]);
    expect(second.reasons[0]?.sharedWith).toEqual([first.dishName]);
    // вместе блюда не обещают больше, чем лежит
    const total = list.reduce((sum, d) => sum + d.reasons[0]!.share, 0);
    expect(total).toBeLessThan(1.0001);
  });

  it('когда первое блюдо забрало весь остаток, второе в список не попадает', () => {
    const list = scene(
      [batch('B1', 'sour', 0.5, 1)],
      [dish('d1', 'Борщ', [['sour', 0.02]]), dish('d2', 'Блины', [['sour', 0.01]])],
    );
    expect(list).toHaveLength(1);
    expect(list[0]?.dishName).toBe('Борщ');
  });

  it('не предлагает блюдо, которое нельзя приготовить', () => {
    const list = scene(
      [batch('B1', 'milk', 2, 1)],
      [dish('d1', 'Каша', [['milk', 0.1], ['flour', 0.05]])],
    );
    expect(list).toHaveLength(0);
  });

  it('не предлагает блюда из стоп-листа и блюда с продуктом из стоп-листа', () => {
    const batches = [batch('B1', 'milk', 2, 1), batch('B2', 'kefir', 2, 1)];
    const dishes = [dish('d1', 'Каша', [['milk', 0.1]]), dish('d2', 'Оладьи', [['kefir', 0.1]])];
    expect(scene(batches, dishes, { blockedDishes: new Set(['d1|K']) }).map((d) => d.dishName)).toEqual(['Оладьи']);
    expect(scene(batches, dishes, { blockedProducts: new Set([stockKey('kefir', 'K')]) }).map((d) => d.dishName)).toEqual(['Каша']);
  });

  it('не берёт далёкие сроки, просроченное, магазины и пустые рецептуры', () => {
    expect(scene([batch('B1', 'milk', 2, 20)], [dish('d1', 'Каша', [['milk', 0.1]])])).toHaveLength(0);
    expect(scene([batch('B1', 'milk', 2, -1)], [dish('d1', 'Каша', [['milk', 0.1]])])).toHaveLength(0);
    expect(scene([batch('B1', 'milk', 2, 1, { locationId: shop.id })], [dish('d1', 'Каша', [['milk', 0.1]])])).toHaveLength(0);
    expect(scene([batch('B1', 'milk', 2, 1)], [dish('d1', 'Пусто', [])])).toHaveLength(0);
  });

  it('смотрит на ближайшую партию, а не на последнюю', () => {
    const list = scene([batch('B1', 'milk', 1, 6), batch('B2', 'milk', 1, 0)], [dish('d1', 'Каша', [['milk', 0.1]])]);
    expect(list[0]?.daysLeft).toBe(0);
  });

  it('объясняет причину и считает деньги под угрозой', () => {
    const [top] = scene([batch('B1', 'beef', 4, 1, { unitCost: 600 })], [dish('d1', 'Борщ', [['beef', 0.12]])]);
    expect(top).toBeDefined();
    expect(top!.headline).toBe('Продвигать «Борщ»');
    expect(top!.details).toContain('Говядина: истекает завтра');
    expect(top!.details).toContain('порц');
    expect(top!.portions).toBe(33);
    expect(top!.portionsToPush).toBe(MAX_PUSH_PORTIONS);
    // 24 порции по 0,12 кг по 600 за килограмм
    expect(top!.atRiskValue).toBeCloseTo(1728, 0);
  });

  it('порядок списка стабилен и ограничивается', () => {
    const batches = [batch('B1', 'milk', 1, 1), batch('B2', 'kefir', 1, 1), batch('B3', 'cream', 1, 1)];
    const dishes = [dish('d1', 'Вафли', [['milk', 0.05]]), dish('d2', 'Блины', [['kefir', 0.05]]), dish('d3', 'Пудинг', [['cream', 0.05]])];
    const a = scene(batches, dishes).map((d) => d.dishName);
    const b = scene(batches, [...dishes].reverse()).map((d) => d.dishName);
    expect(a).toEqual(b);
    expect(a).toEqual(['Блины', 'Вафли', 'Пудинг']);
  });
});
