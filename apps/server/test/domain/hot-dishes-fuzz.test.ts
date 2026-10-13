import { describe, expect, it } from 'vitest';
import { computeHotDishes, type HotDish, type HotInput } from '../../src/domain/hot-dishes';
import type { RecBatch, RecLocation, RecProduct, RecVelocity } from '../../src/domain/recommendations';
import { stockKey, type StockPoint } from '../../src/domain/stoplist';

/** Повторяемый генератор: один и тот же seed даёт один и тот же набор, упавший случай можно воспроизвести. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const kitchen: RecLocation = { id: 'K', name: 'Кухня', kind: 'kitchen', isActive: true };

interface World {
  input: HotInput;
}

/** Случайная кухня: продукты с партиями разных сроков, блюда из 1-4 ингредиентов, где-то продукт в рецептуре повторяется. */
function world(seed: number, opts: { duplicates?: boolean } = {}): World {
  const r = rng(seed);
  const pick = (n: number) => Math.floor(r() * n);
  const productCount = 6 + pick(8);
  const products = new Map<string, RecProduct>();
  const batches: RecBatch[] = [];
  const velocities = new Map<string, RecVelocity>();
  const stock = new Map<string, StockPoint>();
  for (let p = 0; p < productCount; p++) {
    const id = `p${p}`;
    const unit = r() < 0.2 ? 'pcs' : 'kg';
    products.set(id, { id, name: `Продукт ${p}`, unit, price: 100, cost: 20 + pick(400), minStock: 0, isActive: true });
    let on = 0;
    let avail = 0;
    for (let b = 0; b < 1 + pick(4); b++) {
      const qty = unit === 'pcs' ? 1 + pick(200) : Math.round((0.2 + r() * 30) * 10) / 10;
      const daysLeft = r() < 0.1 ? -1 - pick(2) : pick(14);
      batches.push({
        id: `b${p}-${b}`,
        productId: id,
        locationId: kitchen.id,
        remainingMilli: qty * 1000,
        expiresOn: '2026-10-20',
        receivedOn: `2026-10-0${1 + pick(8)}`,
        daysLeft,
        unitCost: 20 + pick(400),
        promoPercent: null,
      });
      on += qty * 1000;
      if (daysLeft >= 0) avail += qty * 1000;
    }
    stock.set(stockKey(id, kitchen.id), { onHandMilli: on, availableMilli: avail });
    velocities.set(stockKey(id, kitchen.id), r() < 0.2 ? { perDay: 0, confidence: 0 } : { perDay: r() * 6, confidence: 0.3 + r() * 0.7 });
  }
  const dishes: HotDish[] = [];
  for (let d = 0; d < 4 + pick(10); d++) {
    const items: { productId: string; qtyMilli: number }[] = [];
    for (let i = 0; i < 1 + pick(4); i++) {
      const productId = `p${pick(productCount)}`;
      if (!opts.duplicates && items.some((x) => x.productId === productId)) continue;
      const unit = products.get(productId)?.unit;
      items.push({ productId, qtyMilli: unit === 'pcs' ? (1 + pick(3)) * 1000 : 20 + pick(300) });
    }
    dishes.push({ id: `d${d}`, name: `Блюдо ${d}`, price: 250 + pick(500), items });
  }
  const dishDemand = new Map<string, RecVelocity>();
  for (const d of dishes) if (r() < 0.7) dishDemand.set(`${d.id}|${kitchen.id}`, { perDay: r() * 40, confidence: r() });
  return { input: { products, locations: new Map([[kitchen.id, kitchen]]), batches, velocities, dishes, dishDemand, stock } };
}

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

describe('горячие предложения: свойства на случайных данных', () => {
  it('числа конечные, приоритет целый от 8 до 100, доли от 0 до 1, порции согласованы', () => {
    for (const seed of SEEDS) {
      const list = computeHotDishes(world(seed).input);
      for (const h of list) {
        expect(Number.isInteger(h.priority), `seed ${seed}`).toBe(true);
        expect(h.priority, `seed ${seed}`).toBeGreaterThanOrEqual(8);
        expect(h.priority, `seed ${seed}`).toBeLessThanOrEqual(100);
        expect(Number.isFinite(h.atRiskValue), `seed ${seed}`).toBe(true);
        expect(h.portionsToPush, `seed ${seed}`).toBeLessThanOrEqual(h.portions);
        for (const x of h.reasons) {
          expect(x.share, `seed ${seed}`).toBeGreaterThanOrEqual(0);
          expect(x.share, `seed ${seed}`).toBeLessThanOrEqual(1.001);
          expect(Number.isFinite(x.value), `seed ${seed}`).toBe(true);
        }
      }
    }
  });

  it('один и тот же остаток не обещан дважды: доли блюд по продукту в сумме не больше единицы', () => {
    for (const seed of SEEDS) {
      const list = computeHotDishes(world(seed, { duplicates: true }).input);
      const total = new Map<string, number>();
      for (const h of list) for (const x of h.reasons) total.set(x.productId, (total.get(x.productId) ?? 0) + x.share);
      for (const [productId, sum] of total) expect(sum, `seed ${seed}, ${productId}`).toBeLessThanOrEqual(1.01);
    }
  });

  it('порядок входных данных не влияет на результат', () => {
    for (const seed of SEEDS.slice(0, 120)) {
      const { input } = world(seed);
      const a = computeHotDishes(input);
      const r = rng(seed * 7);
      const shuffled = (list: readonly unknown[]) => [...list].sort(() => r() - 0.5);
      const b = computeHotDishes({ ...input, batches: shuffled(input.batches) as RecBatch[], dishes: shuffled(input.dishes) as HotDish[] });
      expect(b.map((x) => [x.dishId, x.priority]), `seed ${seed}`).toEqual(a.map((x) => [x.dishId, x.priority]));
    }
  });

  it('невыбранное блюдо не отнимает остаток у выбранных: удаление блюда без приоритета ничего не меняет', () => {
    for (const seed of SEEDS) {
      const { input } = world(seed);
      const all = computeHotDishes(input);
      const shown = new Set(all.map((h) => h.dishId));
      const hidden = input.dishes.filter((d) => !shown.has(d.id));
      if (hidden.length === 0) continue;
      const without = computeHotDishes({ ...input, dishes: input.dishes.filter((d) => shown.has(d.id)) });
      expect(without.map((h) => [h.dishId, h.priority]), `seed ${seed}`).toEqual(all.map((h) => [h.dishId, h.priority]));
    }
  });

  it('причины идут по убыванию вклада, главный ингредиент первый', () => {
    let checked = 0;
    for (const seed of SEEDS) {
      for (const h of computeHotDishes(world(seed).input)) {
        for (let k = 1; k < h.reasons.length; k++) {
          expect(h.reasons[k - 1]!.contribution, `seed ${seed}, ${h.dishName}`).toBeGreaterThanOrEqual(h.reasons[k]!.contribution);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('без конкуренции блюд: чем меньше срок у ингредиента, тем приоритет не ниже', () => {
    let checked = 0;
    for (const seed of SEEDS) {
      // продажи блюд не задаём: при известном спросе ближе срок значит меньше порций, и приоритет вправе упасть
      const { dishDemand: _skip, ...input } = world(seed).input;
      for (const dish of input.dishes) {
        const alone = { ...input, dishes: [dish] };
        const base = computeHotDishes(alone)[0];
        const reason = base?.reasons[0];
        if (!base || !reason) continue;
        // главный ингредиент становится на сутки ближе к концу срока (но не просроченным)
        const closer = input.batches.map((b) => (b.productId === reason.productId && b.daysLeft > 0 && b.daysLeft <= 7 ? { ...b, daysLeft: b.daysLeft - 1 } : b));
        const after = computeHotDishes({ ...alone, batches: closer })[0];
        expect(after?.priority ?? 0, `seed ${seed}, ${dish.name}`).toBeGreaterThanOrEqual(base.priority);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});

describe('горячие предложения: скорость', () => {
  it('большое меню и много партий считаются быстро', () => {
    const products = new Map<string, RecProduct>();
    const batches: RecBatch[] = [];
    const velocities = new Map<string, RecVelocity>();
    const stock = new Map<string, StockPoint>();
    for (let p = 0; p < 300; p++) {
      const id = `p${p}`;
      products.set(id, { id, name: `Продукт ${p}`, unit: 'kg', price: 100, cost: 100, minStock: 0, isActive: true });
      let on = 0;
      for (let b = 0; b < 4; b++) {
        batches.push({ id: `b${p}-${b}`, productId: id, locationId: kitchen.id, remainingMilli: 5000, expiresOn: '2026-10-20', receivedOn: '2026-10-01', daysLeft: (p + b) % 9, unitCost: 100, promoPercent: null });
        on += 5000;
      }
      stock.set(stockKey(id, kitchen.id), { onHandMilli: on, availableMilli: on });
      velocities.set(stockKey(id, kitchen.id), { perDay: 1, confidence: 1 });
    }
    const dishes: HotDish[] = Array.from({ length: 600 }, (_, d) => ({
      id: `d${d}`,
      name: `Блюдо ${d}`,
      price: 300,
      items: [0, 1, 2, 3].map((k) => ({ productId: `p${(d * 7 + k * 13) % 300}`, qtyMilli: 100 })),
    }));
    const started = Date.now();
    const list = computeHotDishes({ products, locations: new Map([[kitchen.id, kitchen]]), batches, velocities, dishes, stock }, { limit: 30 });
    expect(list.length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
