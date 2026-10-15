import { describe, expect, it } from 'vitest';
import {
  computeHotDishes,
  dishMargin,
  marginFactor,
  MARGIN_FACTOR_MAX,
  MARGIN_FACTOR_MIN,
  MAX_PUSH_PORTIONS,
  MIN_PUSH_PORTIONS,
  remainingShare,
  TIME_FACTOR_MIN,
  timeFactor,
  type HotDish,
  type HotInput,
} from '../../src/domain/hot-dishes';
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

  it('чем больше истекающего остатка, тем меньшую его часть закроет блюдо, но деньги растут вместе с тем, что оно способно израсходовать', () => {
    const list = scene(
      [batch('B1', 'milk', 2, 1), batch('B2', 'kefir', 8, 1)],
      [dish('d1', 'Каша', [['milk', 0.1]]), dish('d2', 'Оладьи', [['kefir', 0.1]])],
    );
    const small = byName(list, 'Каша')!;
    const large = byName(list, 'Оладьи')!;
    expect(small.reasons[0]?.share).toBe(1);
    expect(large.reasons[0]?.share).toBeCloseTo(0.3, 2);
    // Оладьи израсходуют 2,4 кг, Каша 2 кг: приоритет следует за деньгами, а не за долей остатка
    expect(large.atRiskValue).toBeGreaterThan(small.atRiskValue);
    expect(large.priority).toBeGreaterThanOrEqual(small.priority);
  });

  it('приоритет считается в деньгах: столько же сырья даёт тот же приоритет и на малом, и на большом остатке', () => {
    const tiny = scene([batch('B1', 'kefir', 2.4, 1)], [dish('d1', 'Оладьи', [['kefir', 0.1]])]);
    const huge = scene([batch('B1', 'kefir', 40, 1)], [dish('d1', 'Оладьи', [['kefir', 0.1]])]);
    expect(huge[0]?.reasons[0]?.share).toBeLessThan(0.1);
    expect(huge[0]?.priority).toBe(tiny[0]?.priority);
  });

  it('копеечное блюдо на дешёвом остатке в список не попадает', () => {
    const list = scene([batch('B1', 'potato', 3, 3, { unitCost: 20 })], [dish('d1', 'Пюре', [['potato', 0.02]])]);
    expect(list).toHaveLength(0);
  });

  it('главным ингредиентом называет тот, на котором больше денег, а не тот, который почти закончился', () => {
    const list = scene(
      [batch('B1', 'beef', 12, 1, { unitCost: 600 }), batch('B2', 'cream', 0.1, 3, { unitCost: 200 })],
      [dish('d1', 'Борщ', [['beef', 0.12], ['cream', 0.01]])],
    );
    const borsch = byName(list, 'Борщ')!;
    expect(borsch.reasons[0]?.productId).toBe('beef');
    expect(borsch.details).toContain('Главный ингредиент «Говядина»');
  });

  it('партии берутся по FEFO: сначала дорогая ближняя, потом дальняя', () => {
    const list = scene(
      [batch('B1', 'milk', 1, 0, { unitCost: 100 }), batch('B2', 'milk', 1, 5, { unitCost: 10 })],
      [dish('d1', 'Каша', [['milk', 0.06]])],
    );
    // 24 порции по 60 г: 1,44 кг, из них 1 кг по 100 и 0,44 кг по 10
    expect(list[0]?.atRiskValue).toBeCloseTo(104.4, 1);
  });

  it('продукт, записанный в рецептуре двумя строками, считается один раз', () => {
    const twice = scene([batch('B1', 'milk', 2, 1)], [dish('d1', 'Каша', [['milk', 0.05], ['milk', 0.05]])]);
    const once = scene([batch('B1', 'milk', 2, 1)], [dish('d1', 'Каша', [['milk', 0.1]])]);
    expect(twice[0]?.reasons).toHaveLength(1);
    expect(twice[0]?.priority).toBe(once[0]?.priority);
    expect(twice[0]?.reasons[0]?.share).toBeLessThanOrEqual(1);
  });

  it('блюдо без приоритета не отнимает остаток у тех, кто в списке', () => {
    const batches = [batch('B1', 'sour', 3, 1, { unitCost: 300 }), batch('B2', 'butter', 1, 6, { unitCost: 5 })];
    const solo = scene(batches, [dish('d1', 'Борщ', [['sour', 0.05]])]);
    const withNoise = scene(batches, [dish('d1', 'Борщ', [['sour', 0.05]]), dish('d9', 'Тост', [['butter', 0.01], ['sour', 0.001]])]);
    expect(withNoise.find((d) => d.dishName === 'Борщ')?.priority).toBe(solo[0]?.priority);
  });

  it('учитывает, сколько ингредиента уходит на порцию', () => {
    const list = scene(
      [batch('B1', 'beef', 3, 1), batch('B2', 'potato', 3, 1, { unitCost: 400 })],
      [dish('d1', 'Жаркое', [['beef', 0.2]]), dish('d2', 'Пюре', [['potato', 0.02]])],
    );
    const stew = byName(list, 'Жаркое')!;
    const puree = byName(list, 'Пюре')!;
    expect(stew.reasons[0]?.portionsToUse).toBe(15);
    expect(puree.reasons[0]?.portionsToUse).toBe(MAX_PUSH_PORTIONS);
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
      [batch('B1', 'sour', 1, 1, { unitCost: 400 })],
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
      [batch('B1', 'sour', 0.5, 1, { unitCost: 400 })],
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

  it('известные продажи ограничивают, сколько порций стоит продвигать', () => {
    const batches = [batch('B1', 'beef', 12, 1, { unitCost: 600 })];
    const d = dish('d1', 'Жаркое', [['beef', 0.1]]);
    const demand = (perDay: number, confidence = 1) => ({ dishDemand: new Map([['d1|K', { perDay, confidence }]]) });
    // блюдо продаётся 2 порции в сутки: за двое суток ингредиента это 4 порции, меньше нижней границы не берём
    expect(scene(batches, [d], demand(2))[0]?.reasons[0]?.portionsToUse).toBe(MIN_PUSH_PORTIONS);
    // 30 порций в сутки: за двое суток 60, это больше общего потолка в 24
    expect(scene(batches, [d], demand(30))[0]?.reasons[0]?.portionsToUse).toBe(60);
    // продаж не знаем (новое блюдо): общий потолок
    expect(scene(batches, [d], demand(2, 0.1))[0]?.reasons[0]?.portionsToUse).toBe(MAX_PUSH_PORTIONS);
    expect(scene(batches, [d])[0]?.reasons[0]?.portionsToUse).toBe(MAX_PUSH_PORTIONS);
  });

  it('блюдо, которое почти не продаётся, получает меньший приоритет, чем ходовое, на том же сырье', () => {
    const batches = [batch('B1', 'beef', 12, 1, { unitCost: 600 })];
    const list = scene(batches, [dish('d1', 'Редкое', [['beef', 0.1]]), dish('d2', 'Ходовое', [['beef', 0.1]])], {
      dishDemand: new Map([
        ['d1|K', { perDay: 1, confidence: 1 }],
        ['d2|K', { perDay: 25, confidence: 1 }],
      ]),
    });
    expect(list[0]?.dishName).toBe('Ходовое');
  });
});

describe('маржа порции в горячих предложениях', () => {
  const rich = (name: string, price: number): HotDish => ({ id: name, name, price, items: [{ productId: 'milk', qtyMilli: 100 }] });

  it('считает маржу по себестоимости рецептуры', () => {
    // 0,1 кг по 50 рублей = 5 рублей на порцию
    const m = dishMargin({ id: 'd', name: 'Каша', price: 100, items: [{ productId: 'milk', qtyMilli: 100 }] }, products);
    expect(m).toEqual({ perPortion: 95, rate: 0.95, cost: 5 });
  });

  it('без цены блюда или себестоимости ингредиента маржу не считает', () => {
    expect(dishMargin({ id: 'd', name: 'Каша', price: 0, items: [{ productId: 'milk', qtyMilli: 100 }] }, products)).toBeNull();
    const noCost = new Map(products);
    noCost.set('milk', { ...products.get('milk')!, cost: 0 });
    expect(dishMargin({ id: 'd', name: 'Каша', price: 100, items: [{ productId: 'milk', qtyMilli: 100 }] }, noCost)).toBeNull();
    expect(marginFactor(null)).toBe(1);
  });

  it('убыточное блюдо получает нижнюю границу поправки, очень выгодное верхнюю, поправка не выходит за пределы', () => {
    expect(marginFactor({ perPortion: -50, rate: 0, cost: 150 })).toBe(MARGIN_FACTOR_MIN);
    expect(marginFactor({ perPortion: 100, rate: 1, cost: 0 })).toBe(MARGIN_FACTOR_MAX);
    const mid = marginFactor({ perPortion: 50, rate: 0.5, cost: 50 });
    expect(mid).toBeGreaterThan(MARGIN_FACTOR_MIN);
    expect(mid).toBeLessThan(MARGIN_FACTOR_MAX);
  });

  it('без включения маржа приоритет не двигает и не показывается', () => {
    const list = scene([batch('B1', 'milk', 2, 1)], [rich('Каша', 300)]);
    expect(list[0]?.margin).toBeNull();
    expect(list[0]?.factors).toEqual({ margin: 1, time: 1 });
  });

  it('из двух блюд с одинаковыми остатками выше то, где маржа больше, и маржа названа в описании', () => {
    const batches = [batch('B1', 'milk', 1, 1), batch('B2', 'kefir', 1, 1)];
    const cheap: HotDish = { id: 'd1', name: 'Дешёвое', price: 60, items: [{ productId: 'milk', qtyMilli: 100 }] };
    const good: HotDish = { id: 'd2', name: 'Выгодное', price: 600, items: [{ productId: 'kefir', qtyMilli: 100 }] };
    const list = scene(batches, [cheap, good], { useMargin: true });
    const c = byName(list, 'Дешёвое')!;
    const g = byName(list, 'Выгодное')!;
    expect(g.factors.margin).toBeGreaterThan(c.factors.margin);
    expect(g.priority).toBeGreaterThanOrEqual(c.priority);
    expect(g.margin!.rate).toBeCloseTo(0.992, 3);
    expect(g.details).toContain('Маржа порции 99%');
  });

  it('маржа меняет приоритет не больше чем на 15%', () => {
    const batches = [batch('B1', 'milk', 1, 1)];
    const off = scene(batches, [rich('Каша', 600)], { useMargin: false })[0]!;
    const on = scene(batches, [rich('Каша', 600)], { useMargin: true })[0]!;
    expect(on.priority).toBeLessThanOrEqual(Math.min(100, Math.round(off.priority * 1.15) + 1));
    expect(on.priority).toBeGreaterThanOrEqual(Math.round(off.priority * 0.85) - 1);
  });
});

describe('время суток в горячих предложениях', () => {
  const morning = Array.from({ length: 24 }, (_, h) => (h >= 7 && h < 11 ? 0.25 : 0));
  const evening = Array.from({ length: 24 }, (_, h) => (h >= 18 && h < 22 ? 0.25 : 0));

  it('доля продаж впереди: считается от текущего часа до конца суток', () => {
    expect(remainingShare(morning, 6)).toBeCloseTo(1);
    expect(remainingShare(morning, 9.5)).toBeCloseTo(0.5);
    expect(remainingShare(morning, 12)).toBe(0);
    expect(remainingShare(evening, 12)).toBeCloseTo(1);
  });

  it('поправка: без данных нейтральна, блюдо, которое сегодня уже не купят, теряет приоритет, но не больше половины', () => {
    expect(timeFactor(null, 0)).toBe(1);
    expect(timeFactor(1, 0)).toBe(1);
    expect(timeFactor(0, 0)).toBe(TIME_FACTOR_MIN);
  });

  it('если ингредиенты живут ещё несколько суток, время суток важно меньше', () => {
    expect(timeFactor(0, 2)).toBeGreaterThan(timeFactor(0, 0));
    expect(timeFactor(0, 2)).toBeCloseTo(1 - 0.5 / 3, 3);
    expect(timeFactor(0, 30)).toBeGreaterThan(0.98);
  });

  it('утреннее блюдо вечером уступает вечернему при одинаковых остатках', () => {
    const batches = [batch('B1', 'milk', 1, 0), batch('B2', 'kefir', 1, 0)];
    const dishes = [dish('d1', 'Каша', [['milk', 0.1]]), dish('d2', 'Стейк', [['kefir', 0.1]])];
    const hourly = new Map<string, readonly number[]>([
      ['d1|K', morning],
      ['d2|K', evening],
    ]);
    const list = scene(batches, dishes, { dishHourly: hourly, nowHour: 17 });
    const kasha = byName(list, 'Каша')!;
    const steak = byName(list, 'Стейк')!;
    expect(kasha.timeFit).toBe(0);
    expect(steak.timeFit).toBe(1);
    expect(kasha.factors.time).toBe(TIME_FACTOR_MIN);
    expect(steak.factors.time).toBe(1);
    expect(steak.priority).toBeGreaterThan(kasha.priority);
    expect(kasha.details).toContain('обычно заказывают раньше');
    expect(steak.details).not.toContain('обычно заказывают раньше');
  });

  it('утром, наоборот, выше утреннее блюдо; без часового распределения блюдо не штрафуется', () => {
    const batches = [batch('B1', 'milk', 1, 0), batch('B2', 'kefir', 1, 0)];
    const dishes = [dish('d1', 'Каша', [['milk', 0.1]]), dish('d2', 'Стейк', [['kefir', 0.1]])];
    const hourly = new Map<string, readonly number[]>([
      ['d1|K', morning],
      ['d2|K', evening],
    ]);
    const list = scene(batches, dishes, { dishHourly: hourly, nowHour: 6 });
    expect(byName(list, 'Каша')!.priority).toBeGreaterThanOrEqual(byName(list, 'Стейк')!.priority);

    const only = scene(batches, dishes, { dishHourly: new Map([['d1|K', morning]]), nowHour: 17 });
    expect(byName(only, 'Стейк')!.timeFit).toBeNull();
    expect(byName(only, 'Стейк')!.factors.time).toBe(1);
  });
});
