import type { Unit } from '@zapas/shared';

export type Rng = () => number;

/** Детерминированный генератор случайных чисел: один и тот же seed даёт одну и ту же ленту событий. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface EmuProduct {
  id: string;
  name: string;
  unit: Unit;
  cost: number;
  shelfLifeDays: number | null;
  packSize: number;
}

export interface EmuDish {
  id: string;
  name: string;
  /** Сколько порций в сутки продаётся в среднем. */
  perDay: number;
  items: { productId: string; quantity: number }[];
}

export function pickWeighted<T>(rng: Rng, items: readonly T[], weight: (item: T) => number): T | undefined {
  const total = items.reduce((sum, item) => sum + Math.max(weight(item), 0), 0);
  if (items.length === 0) return undefined;
  if (total <= 0) return items[Math.floor(rng() * items.length)];
  let left = rng() * total;
  for (const item of items) {
    left -= Math.max(weight(item), 0);
    if (left <= 0) return item;
  }
  return items.at(-1);
}

/** Суточный расход каждого ингредиента при средних продажах блюд. */
export function dailyDemand(dishes: readonly EmuDish[]): Map<string, number> {
  const demand = new Map<string, number>();
  for (const dish of dishes) {
    for (const item of dish.items) demand.set(item.productId, (demand.get(item.productId) ?? 0) + dish.perDay * item.quantity);
  }
  return demand;
}

export interface SupplyPlan {
  product: EmuProduct;
  quantity: number;
  shelfLifeDays: number;
  /** Партия приехала с урезанным сроком: поставщики такое делают, а система должна справляться. */
  shortDated: boolean;
}

const SHORT_DATED_SHARE = 0.25;
const DEFAULT_SHELF_DAYS = 7;
/** Урезанный срок имеет смысл только у скоропортящегося. */
const SHORT_DATED_MAX_SHELF = 30;

/** Поставка ингредиента: чаще того, что расходуется быстрее, на один–три дня работы кухни. */
export function planSupply(rng: Rng, products: ReadonlyMap<string, EmuProduct>, demand: ReadonlyMap<string, number>): SupplyPlan | null {
  const candidates = [...demand].filter(([id]) => products.has(id));
  const picked = pickWeighted(rng, candidates, ([, perDay]) => perDay);
  if (!picked) return null;
  const product = products.get(picked[0]) as EmuProduct;
  const days = 1 + rng() * 2;
  const raw = picked[1] * days;

  let quantity: number;
  if (product.unit === 'pcs') quantity = Math.max(1, Math.round(raw));
  else quantity = Math.max(0.5, Math.round(raw * 2) / 2);
  if (product.packSize > 1) quantity = Math.ceil(quantity / product.packSize) * product.packSize;

  const base = product.shelfLifeDays ?? DEFAULT_SHELF_DAYS;
  const shortDated = base <= SHORT_DATED_MAX_SHELF && rng() < SHORT_DATED_SHARE;
  const shelfLifeDays = shortDated ? Math.min(base, Math.max(1, Math.round(base * (0.15 + rng() * 0.25)))) : base;
  return { product, quantity, shelfLifeDays, shortDated };
}

export interface OrderPlan {
  lines: { dish: EmuDish; quantity: number }[];
  /** Банкет или наплыв гостей: много порций одного блюда сразу. */
  burst: boolean;
}

/** Заказ гостей: одна–три позиции по популярности, иногда большой заказ на одно блюдо, чтобы упереться в нехватку. */
export function planOrder(rng: Rng, dishes: readonly EmuDish[], pressure: number): OrderPlan | null {
  if (dishes.length === 0) return null;
  if (rng() < pressure) {
    const dish = pickWeighted(rng, dishes, (d) => d.perDay) as EmuDish;
    return { lines: [{ dish, quantity: 8 + Math.floor(rng() * 18) }], burst: true };
  }
  const count = 1 + Math.floor(rng() * 3);
  const lines: OrderPlan['lines'] = [];
  for (let i = 0; i < count; i += 1) {
    const dish = pickWeighted(
      rng,
      dishes.filter((d) => !lines.some((l) => l.dish.id === d.id)),
      (d) => d.perDay,
    );
    if (!dish) break;
    lines.push({ dish, quantity: 1 + Math.floor(rng() * rng() * 3) });
  }
  return { lines, burst: false };
}

/** Пауза до следующего события: вокруг среднего значения, чтобы поток не выглядел метрономом. */
export function nextDelay(rng: Rng, averageMs: number): number {
  return Math.round(averageMs * (0.4 + rng() * 1.2));
}
