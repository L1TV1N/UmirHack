import { describe, expect, it } from 'vitest';
import type { RecBatch, RecLocation, RecProduct, RecVelocity } from '../../src/domain/recommendations';
import { forecastStopList, forecastStopListDetailed, type ForecastDish, type IncomingDelivery, type StopForecastInput } from '../../src/domain/stoplist-forecast';
import { stockKey, type StockPoint } from '../../src/domain/stoplist';

const kitchen: RecLocation = { id: 'K', name: 'Кухня', kind: 'kitchen', isActive: true };
const shop: RecLocation = { id: 'S', name: 'Магазин', kind: 'shop', isActive: true };
const names: Record<string, string> = { milk: 'Молоко', eggs: 'Яйца', flour: 'Мука', beef: 'Говядина' };
const products = new Map<string, RecProduct>(
  Object.entries(names).map(([id, name]) => [id, { id, name, unit: id === 'eggs' ? 'pcs' : 'kg', price: 0, cost: 0, minStock: 0, isActive: true }]),
);

const batch = (id: string, productId: string, kg: number, daysLeft: number, locationId = 'K'): RecBatch => ({
  id,
  productId,
  locationId,
  remainingMilli: Math.round(kg * 1000),
  expiresOn: `2026-10-${10 + daysLeft}`,
  receivedOn: '2026-10-01',
  daysLeft,
  unitCost: 0,
  promoPercent: null,
});
const dish = (id: string, name: string, items: [string, number][]): ForecastDish => ({ id, name, items: items.map(([productId, q]) => ({ productId, qtyMilli: Math.round(q * 1000) })) });

function scene(batches: RecBatch[], dishes: ForecastDish[], perDay: Record<string, number | RecVelocity> = {}, extra: Partial<StopForecastInput> = {}) {
  const stock = new Map<string, StockPoint>();
  for (const b of batches) {
    const key = stockKey(b.productId, b.locationId);
    const p = stock.get(key) ?? { onHandMilli: 0, availableMilli: 0 };
    p.onHandMilli += b.remainingMilli;
    if (b.daysLeft >= 0) p.availableMilli += b.remainingMilli;
    stock.set(key, p);
  }
  const velocities = new Map<string, RecVelocity>();
  for (const [productId, v] of Object.entries(perDay)) velocities.set(stockKey(productId, 'K'), typeof v === 'number' ? { perDay: v, confidence: 1 } : v);
  return forecastStopList({ locations: new Map([[kitchen.id, kitchen], [shop.id, shop]]), products, dishes, batches, velocities, stock, nowHour: 12, ...extra });
}

describe('прогноз стоп-листа', () => {
  it('считает момент, когда остаток разойдётся при текущих продажах', () => {
    // 2 кг, уходит 2 кг в сутки, на порцию нужно 0,5 кг: через 18 часов останется меньше порции
    const [f] = scene([batch('B1', 'milk', 2, 30)], [dish('d1', 'Каша', [['milk', 0.5]])], { milk: 2 });
    expect(f?.hoursLeft).toBe(19);
    expect(f?.cause).toBe('depletion');
    expect(f?.limiting).toMatchObject({ productName: 'Молоко', perDay: 2, availableNow: 2, perPortion: 0.5 });
    expect(f?.portionsNow).toBe(4);
  });

  it('без продаж ждёт только окончания срока годности и называет это причиной', () => {
    // сейчас 20:00, партия годна до конца завтрашнего дня: 4 часа сегодня и 24 завтра
    const [f] = scene([batch('B1', 'milk', 5, 1)], [dish('d1', 'Каша', [['milk', 0.5]])], {}, { nowHour: 20 });
    expect(f?.hoursLeft).toBe(28);
    expect(f?.cause).toBe('expiry');
    expect(f?.limiting.perDay).toBeNull();
  });

  it('малой истории продаж не верит: учитывает только срок', () => {
    const v: RecVelocity = { perDay: 50, confidence: 0.2 };
    expect(scene([batch('B1', 'milk', 2, 30)], [dish('d1', 'Каша', [['milk', 0.5]])], { milk: v })).toHaveLength(0);
  });

  it('берёт самый ранний из ингредиентов блюда', () => {
    const [f] = scene(
      [batch('B1', 'milk', 20, 30), batch('B2', 'eggs', 6, 30)],
      [dish('d1', 'Омлет', [['milk', 0.1], ['eggs', 1]])],
      { milk: 1, eggs: 6 },
    );
    expect(f?.limiting.productName).toBe('Яйца');
    expect(f?.hoursLeft).toBeLessThan(24);
  });

  it('вторая партия продлевает срок, пока она годна', () => {
    // первая партия уйдёт и истечёт, но вторая лежит долго и покрывает расход
    expect(scene([batch('B1', 'milk', 1, 1), batch('B2', 'milk', 100, 20)], [dish('d1', 'Каша', [['milk', 0.5]])], { milk: 1 })).toHaveLength(0);
  });

  it('остаток дальше горизонта не попадает, уже остановленные блюда пропускаются', () => {
    const d = dish('d1', 'Каша', [['milk', 0.5]]);
    expect(scene([batch('B1', 'milk', 1000, 100)], [d], { milk: 1 })).toHaveLength(0);
    expect(scene([batch('B1', 'milk', 1, 5)], [d], {}, { stopped: new Set(['d1|K']) })).toHaveLength(0);
  });

  it('блюдо, которое уже нельзя приготовить, не прогнозируется, магазины не смотрим', () => {
    expect(scene([batch('B1', 'milk', 0.2, 5)], [dish('d1', 'Каша', [['milk', 0.5]])], { milk: 1 })).toHaveLength(0);
    expect(scene([batch('B1', 'milk', 1, 1, 'S')], [dish('d1', 'Каша', [['milk', 0.5]])])).toHaveLength(0);
  });

  it('список упорядочен по близости остановки', () => {
    const list = scene(
      [batch('B1', 'milk', 1, 30), batch('B2', 'flour', 5, 30), batch('B3', 'beef', 5, 2)],
      [dish('d1', 'Каша', [['milk', 0.5]]), dish('d2', 'Блины', [['flour', 0.5]]), dish('d3', 'Борщ', [['beef', 0.5]])],
      { milk: 2, flour: 1 },
    );
    expect(list.map((f) => f.dishName)).toEqual(['Каша', 'Борщ', 'Блины']);
    for (let i = 1; i < list.length; i += 1) expect(list[i]!.hoursLeft).toBeGreaterThanOrEqual(list[i - 1]!.hoursLeft);
  });
});

describe('прогноз стоп-листа с поставками в пути', () => {
  const milk = { productId: 'milk', locationId: 'K' };
  const delivery = (over: Partial<IncomingDelivery> = {}): IncomingDelivery => ({
    orderId: 'o1',
    orderNumber: 'ЗК-000100',
    ...milk,
    qtyMilli: 20_000,
    arrivesOn: '2026-10-11',
    shelfLifeDays: null,
    ...over,
  });
  const run = (incoming: IncomingDelivery[], batches: RecBatch[] = [batch('B1', 'milk', 4, 30)], extra: Partial<StopForecastInput> = {}) => {
    const stock = new Map<string, StockPoint>([[stockKey('milk', 'K'), { onHandMilli: 4000, availableMilli: 4000 }]]);
    return forecastStopListDetailed({
      locations: new Map([[kitchen.id, kitchen]]),
      products,
      dishes: [dish('d1', 'Каша', [['milk', 0.5]])],
      batches,
      velocities: new Map([[stockKey('milk', 'K'), { perDay: 2, confidence: 1 }]]),
      stock,
      nowHour: 12,
      incoming,
      today: '2026-10-10',
      ...extra,
    });
  };

  it('без поставки блюдо остановится через двое суток (опорный случай)', () => {
    const r = run([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]?.hoursLeft).toBe(42);
    expect(r.covered).toEqual([]);
  });

  it('поставка, которая успевает, снимает предупреждение и попадает в «выручит поставка»', () => {
    const r = run([delivery()]);
    expect(r.warnings).toEqual([]);
    expect(r.covered).toHaveLength(1);
    expect(r.covered[0]).toMatchObject({ dishName: 'Каша', hoursWithoutDelivery: 42 });
    expect(r.covered[0]?.delivery.orderNumber).toBe('ЗК-000100');
  });

  it('поставка, которая не успевает, предупреждение не снимает и помечена как опоздавшая к остановке', () => {
    // привезут через три дня, а блюдо встанет через двое суток
    const r = run([delivery({ arrivesOn: '2026-10-13' })]);
    expect(r.warnings[0]?.hoursLeft).toBe(42);
    expect(r.warnings[0]?.incoming?.afterStop).toBe(true);
    expect(r.warnings[0]?.incoming?.delivery.arrivesOn).toBe('2026-10-13');
    expect(r.covered).toEqual([]);
  });

  it('малая поставка сдвигает остановку, но не отменяет её', () => {
    const base = run([]).warnings[0]?.hoursLeft as number;
    const r = run([delivery({ qtyMilli: 6000 })]);
    const later = r.warnings[0]?.hoursLeft as number;
    expect(later).toBeGreaterThan(base);
    expect(r.warnings[0]?.incoming?.afterStop).toBe(false);
    expect(r.covered).toEqual([]);
  });

  it('опоздавшая поставка (дата в прошлом) в расчёт не берётся', () => {
    const r = run([delivery({ arrivesOn: '2026-10-08' })]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]?.hoursLeft).toBe(42);
    expect(r.warnings[0]?.incoming).toBeNull();
    expect(r.covered).toEqual([]);
  });

  it('у поставки короткий срок хранения: привезённое пропадёт, и блюдо всё равно встанет', () => {
    // 20 кг с неограниченным сроком закрывают прогноз целиком, а те же 20 кг со сроком хранения сутки уже нет
    expect(run([delivery({ shelfLifeDays: null })]).warnings).toEqual([]);
    const r = run([delivery({ shelfLifeDays: 1 })]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]?.hoursLeft).toBeGreaterThan(42);
    expect(r.covered).toEqual([]);
  });

  it('поставка не на ту точку или не того продукта ничего не меняет', () => {
    const r = run([delivery({ productId: 'eggs' }), delivery({ locationId: 'S' })]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]?.hoursLeft).toBe(42);
    expect(r.covered).toEqual([]);
  });

  it('без сегодняшней даты поставки игнорируются, прежнее поведение не меняется', () => {
    const r = run([delivery()], undefined, { today: undefined });
    expect(r.warnings).toHaveLength(1);
    expect(r.covered).toEqual([]);
  });

  it('несколько поставок: ближайшая названа в предупреждении', () => {
    const r = run([delivery({ orderId: 'o2', orderNumber: 'ЗК-000102', arrivesOn: '2026-10-14', qtyMilli: 1000 }), delivery({ orderId: 'o1', orderNumber: 'ЗК-000100', arrivesOn: '2026-10-12', qtyMilli: 1000 })]);
    expect(r.warnings[0]?.incoming?.delivery.orderNumber).toBe('ЗК-000100');
  });
});
