import { describe, expect, it } from 'vitest';
import { dailyDemand, makeRng, nextDelay, pickWeighted, planOrder, planSupply, type EmuDish, type EmuProduct } from '../../src/emulator/engine';

const product = (id: string, over: Partial<EmuProduct> = {}): EmuProduct => ({ id, name: id, unit: 'kg', cost: 100, shelfLifeDays: 5, packSize: 1, ...over });
const dish = (id: string, perDay: number, items: [string, number][]): EmuDish => ({ id, name: id, perDay, items: items.map(([productId, quantity]) => ({ productId, quantity })) });

describe('генератор событий: выбор', () => {
  it('один seed даёт одну и ту же ленту', () => {
    const a = makeRng(7);
    const b = makeRng(7);
    expect(Array.from({ length: 5 }, a)).toEqual(Array.from({ length: 5 }, b));
    expect(makeRng(8)()).not.toBe(makeRng(7)());
  });

  it('взвешенный выбор: частый вариант выпадает чаще, нулевой вес не выпадает', () => {
    const rng = makeRng(1);
    const hits = { a: 0, b: 0, z: 0 };
    for (let i = 0; i < 2000; i += 1) hits[pickWeighted(rng, ['a', 'b', 'z'] as const, (k) => ({ a: 9, b: 1, z: 0 })[k]) as 'a' | 'b' | 'z'] += 1;
    expect(hits.a).toBeGreaterThan(1600);
    expect(hits.z).toBe(0);
    expect(pickWeighted(rng, [], () => 1)).toBeUndefined();
    expect(['x', 'y']).toContain(pickWeighted(rng, ['x', 'y'], () => 0));
  });

  it('считает суточный расход ингредиентов по блюдам', () => {
    const demand = dailyDemand([dish('d1', 10, [['milk', 0.2], ['egg', 1]]), dish('d2', 5, [['milk', 0.1]])]);
    expect(demand.get('milk')).toBeCloseTo(2.5, 6);
    expect(demand.get('egg')).toBe(10);
  });
});

describe('генератор событий: поставки', () => {
  const demand = new Map([['milk', 3], ['eggs', 40], ['flour', 1]]);
  const products = new Map<string, EmuProduct>([
    ['milk', product('milk', { unit: 'l', shelfLifeDays: 7 })],
    ['eggs', product('eggs', { unit: 'pcs', shelfLifeDays: 20, packSize: 30 })],
    ['flour', product('flour', { shelfLifeDays: 365 })],
  ]);

  it('штучное целыми упаковками, остальное кратно полукилограмму', () => {
    const rng = makeRng(3);
    for (let i = 0; i < 300; i += 1) {
      const plan = planSupply(rng, products, demand);
      expect(plan).not.toBeNull();
      if (!plan) continue;
      if (plan.product.id === 'eggs') {
        expect(Number.isInteger(plan.quantity)).toBe(true);
        expect(plan.quantity % 30).toBe(0);
      } else {
        expect(plan.quantity * 2).toBe(Math.round(plan.quantity * 2));
      }
      expect(plan.quantity).toBeGreaterThan(0);
    }
  });

  it('чаще везёт то, что расходуется быстрее', () => {
    const rng = makeRng(5);
    const counts = new Map<string, number>();
    for (let i = 0; i < 1000; i += 1) {
      const id = planSupply(rng, products, demand)?.product.id as string;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    expect(counts.get('eggs') ?? 0).toBeGreaterThan(counts.get('milk') ?? 0);
    expect(counts.get('milk') ?? 0).toBeGreaterThan(counts.get('flour') ?? 0);
  });

  it('часть партий приезжает с урезанным сроком, но не у долгохранимого', () => {
    const rng = makeRng(11);
    let short = 0;
    let total = 0;
    for (let i = 0; i < 2000; i += 1) {
      const plan = planSupply(rng, products, demand);
      if (!plan) continue;
      total += 1;
      expect(plan.shelfLifeDays).toBeGreaterThanOrEqual(1);
      if (plan.product.id === 'flour') {
        expect(plan.shortDated).toBe(false);
        expect(plan.shelfLifeDays).toBe(365);
      }
      if (plan.shortDated) {
        short += 1;
        expect(plan.shelfLifeDays).toBeLessThanOrEqual(plan.product.shelfLifeDays as number);
      }
    }
    expect(short / total).toBeGreaterThan(0.12);
    expect(short / total).toBeLessThan(0.3);
  });

  it('без срока в карточке берёт неделю, без ингредиентов ничего не планирует', () => {
    const plain = new Map([['x', product('x', { shelfLifeDays: null })]]);
    const plan = planSupply(makeRng(2), plain, new Map([['x', 2]]));
    expect(plan?.shelfLifeDays === 7 || plan?.shortDated === true).toBe(true);
    expect(planSupply(makeRng(2), new Map(), new Map())).toBeNull();
  });
});

describe('генератор событий: заказы', () => {
  const dishes = [dish('borsch', 26, [['beef', 0.12]]), dish('omelet', 22, [['eggs', 3]]), dish('pasta', 12, [['pasta', 0.1]]), dish('salad', 17, [['tomato', 0.1]])];

  it('в заказе до трёх разных блюд, количества положительные', () => {
    const rng = makeRng(4);
    for (let i = 0; i < 500; i += 1) {
      const plan = planOrder(rng, dishes, 0);
      expect(plan?.burst).toBe(false);
      const ids = plan?.lines.map((l) => l.dish.id) ?? [];
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBeGreaterThanOrEqual(1);
      expect(ids.length).toBeLessThanOrEqual(3);
      for (const l of plan?.lines ?? []) expect(l.quantity).toBeGreaterThanOrEqual(1);
    }
  });

  it('большие заказы встречаются с заданной частотой и упираются в нехватку', () => {
    const rng = makeRng(9);
    let bursts = 0;
    for (let i = 0; i < 2000; i += 1) {
      const plan = planOrder(rng, dishes, 0.2);
      if (plan?.burst) {
        bursts += 1;
        expect(plan.lines).toHaveLength(1);
        expect(plan.lines[0]?.quantity).toBeGreaterThanOrEqual(8);
        expect(plan.lines[0]?.quantity).toBeLessThanOrEqual(25);
      }
    }
    expect(bursts / 2000).toBeGreaterThan(0.15);
    expect(bursts / 2000).toBeLessThan(0.25);
    expect(planOrder(makeRng(1), [], 0.5)).toBeNull();
  });

  it('популярные блюда заказывают чаще', () => {
    const rng = makeRng(13);
    const counts = new Map<string, number>();
    for (let i = 0; i < 2000; i += 1) for (const l of planOrder(rng, dishes, 0)?.lines ?? []) counts.set(l.dish.id, (counts.get(l.dish.id) ?? 0) + 1);
    expect(counts.get('borsch') ?? 0).toBeGreaterThan(counts.get('pasta') ?? 0);
  });

  it('пауза между событиями колеблется вокруг среднего', () => {
    const rng = makeRng(21);
    for (let i = 0; i < 200; i += 1) {
      const d = nextDelay(rng, 1000);
      expect(d).toBeGreaterThanOrEqual(400);
      expect(d).toBeLessThanOrEqual(1600);
    }
  });
});
