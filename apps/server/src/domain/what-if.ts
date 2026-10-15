import { addDays, formatMoney, formatQty, fromMilli, roundMoney, servesDishes, toMilli, type WhatIfAction, type WhatIfStepDto } from '@zapas/shared';
import { compareFefo } from './fefo';
import type { RecBatch, RecLocation, RecProduct, RecVelocity } from './recommendations';
import { dishVisibleAt } from './recommendations';
import { stockKey, type StockPoint } from './stoplist';

export interface ScenarioDish {
  id: string;
  name: string;
  orgId?: string;
  items: { productId: string; qtyMilli: number }[];
}

/** Изменяемая копия того, что нужно расчётам. Исходный срез остаётся нетронутым. */
export interface Scenario {
  today: string;
  products: ReadonlyMap<string, RecProduct>;
  locations: ReadonlyMap<string, RecLocation>;
  dishes: readonly ScenarioDish[];
  batches: RecBatch[];
  velocities: Map<string, RecVelocity>;
  tracked: Set<string>;
}

export interface Applied {
  steps: WhatIfStepDto[];
}

const batchLabel = (s: Scenario, b: RecBatch): string => `${s.products.get(b.productId)?.name ?? 'Продукт'}, партия до ${b.expiresOn}`;

/** Остатки по парам продукт и точка пересчитываются из партий: так же, как при загрузке среза. */
export function stockOf(batches: readonly RecBatch[]): Map<string, StockPoint> {
  const stock = new Map<string, StockPoint>();
  for (const b of batches) {
    const key = stockKey(b.productId, b.locationId);
    const point = stock.get(key) ?? { onHandMilli: 0, availableMilli: 0 };
    point.onHandMilli += b.remainingMilli;
    if (b.daysLeft >= 0) point.availableMilli += b.remainingMilli;
    stock.set(key, point);
  }
  return stock;
}

const money = (milli: number, unitCost: number): number => roundMoney(fromMilli(milli) * unitCost);

/**
 * Применяет шаги по порядку. Шаг, который выполнить нельзя, не ломает остальные: он помечается с причиной.
 * Функция меняет переданный сценарий, поэтому вызывающий отдаёт ей копию.
 */
export function applyActions(s: Scenario, actions: readonly WhatIfAction[]): Applied {
  const steps: WhatIfStepDto[] = [];
  let hypothetical = 0;

  actions.forEach((a, index) => {
    const type = a.type;
    const fail = (text: string): void => {
      steps.push({ index, type, ok: false, text, cost: 0 });
    };
    const done = (text: string, cost = 0): void => {
      steps.push({ index, type, ok: true, text, cost });
    };
    const product = (id: string) => s.products.get(id);
    const place = (id: string) => s.locations.get(id);

    if (a.type === 'writeoff') {
      const b = s.batches.find((x) => x.id === a.batchId);
      if (!b) return fail('Партия не найдена среди доступных вам точек');
      const milli = a.quantity === undefined ? b.remainingMilli : toMilli(a.quantity);
      if (milli > b.remainingMilli) return fail(`${batchLabel(s, b)}: в партии только ${formatQty(fromMilli(b.remainingMilli), product(b.productId)?.unit ?? 'pcs')}`);
      const cost = money(milli, b.unitCost);
      b.remainingMilli -= milli;
      return done(`${batchLabel(s, b)}: списать ${formatQty(fromMilli(milli), product(b.productId)?.unit ?? 'pcs')}, потеря ${formatMoney(cost)}`, cost);
    }

    if (a.type === 'receive') {
      const p = product(a.productId);
      const loc = place(a.locationId);
      if (!p || !p.isActive) return fail('Продукт не найден или отключён');
      if (!loc || !loc.isActive) return fail('Точка не найдена или отключена');
      hypothetical += 1;
      const unitCost = a.unitCost ?? p.cost;
      s.batches.push({
        id: `what-if:${hypothetical}`,
        productId: p.id,
        locationId: loc.id,
        remainingMilli: toMilli(a.quantity),
        expiresOn: addDays(s.today, a.shelfDays),
        receivedOn: s.today,
        daysLeft: a.shelfDays,
        unitCost,
        promoPercent: null,
      });
      s.tracked.add(stockKey(p.id, loc.id));
      if (!s.velocities.has(stockKey(p.id, loc.id))) s.velocities.set(stockKey(p.id, loc.id), { perDay: 0, confidence: 0 });
      return done(`${p.name}: на ${loc.name} придёт ${formatQty(a.quantity, p.unit)} со сроком ${a.shelfDays} сут.`, roundMoney(a.quantity * unitCost));
    }

    if (a.type === 'transfer') {
      const b = s.batches.find((x) => x.id === a.batchId);
      if (!b) return fail('Партия не найдена среди доступных вам точек');
      const to = place(a.toLocationId);
      if (!to || !to.isActive) return fail('Точка назначения не найдена или отключена');
      if (to.id === b.locationId) return fail('Партия уже на этой точке');
      const milli = a.quantity === undefined ? b.remainingMilli : toMilli(a.quantity);
      if (milli > b.remainingMilli) return fail(`${batchLabel(s, b)}: в партии только ${formatQty(fromMilli(b.remainingMilli), product(b.productId)?.unit ?? 'pcs')}`);
      if (b.daysLeft < 0) return fail(`${batchLabel(s, b)}: просроченную партию перемещать нельзя`);
      hypothetical += 1;
      b.remainingMilli -= milli;
      s.batches.push({ ...b, id: `what-if:${hypothetical}`, locationId: to.id, remainingMilli: milli });
      s.tracked.add(stockKey(b.productId, to.id));
      if (!s.velocities.has(stockKey(b.productId, to.id))) s.velocities.set(stockKey(b.productId, to.id), { perDay: 0, confidence: 0 });
      return done(`${batchLabel(s, b)}: ${formatQty(fromMilli(milli), product(b.productId)?.unit ?? 'pcs')} уедет на ${to.name}`);
    }

    if (a.type === 'cook') {
      const dish = s.dishes.find((d) => d.id === a.dishId);
      const loc = place(a.locationId);
      if (!dish) return fail('Блюдо не найдено');
      if (!loc || !loc.isActive) return fail('Точка не найдена или отключена');
      if (!servesDishes(loc.kind) || !dishVisibleAt(dish, loc)) return fail(`На ${loc.name} это блюдо не готовят`);
      // сначала проверяем, хватит ли продуктов, и только потом списываем: шаг либо выполняется целиком, либо нет
      const plan: { batch: RecBatch; milli: number }[] = [];
      let cost = 0;
      for (const item of dish.items) {
        let need = item.qtyMilli * a.portions;
        const pool = s.batches
          .filter((b) => b.productId === item.productId && b.locationId === loc.id && b.daysLeft >= 0 && b.remainingMilli > 0)
          .sort(compareFefo);
        for (const b of pool) {
          if (need <= 0) break;
          const used = plan.filter((x) => x.batch === b).reduce((n, x) => n + x.milli, 0);
          const take = Math.min(b.remainingMilli - used, need);
          if (take <= 0) continue;
          plan.push({ batch: b, milli: take });
          need -= take;
          cost += fromMilli(take) * b.unitCost;
        }
        if (need > 0) {
          const have = pool.reduce((n, b) => n + b.remainingMilli, 0);
          const can = Math.floor(have / item.qtyMilli);
          return fail(`«${dish.name}» на ${loc.name}: ${product(item.productId)?.name ?? 'продукта'} хватит только на ${can} порц.`);
        }
      }
      for (const { batch, milli } of plan) batch.remainingMilli -= milli;
      return done(`«${dish.name}» на ${loc.name}: ${a.portions} порц., уйдёт продуктов на ${formatMoney(roundMoney(cost))}`, roundMoney(cost));
    }

    // demand
    const key = stockKey(a.productId, a.locationId);
    const v = s.velocities.get(key);
    const p = product(a.productId);
    const loc = place(a.locationId);
    if (!p || !loc) return fail('Продукт или точка не найдены');
    if (!v || v.perDay <= 0) return fail(`${p.name} на ${loc.name}: продаж за последнее время нет, менять нечего`);
    s.velocities.set(key, { perDay: v.perDay * a.factor, confidence: v.confidence });
    done(`${p.name} на ${loc.name}: продажи ${a.factor >= 1 ? 'вырастут' : 'упадут'} с ${formatQty(v.perDay, p.unit)} до ${formatQty(v.perDay * a.factor, p.unit)} в сутки`);
  });

  return { steps };
}
