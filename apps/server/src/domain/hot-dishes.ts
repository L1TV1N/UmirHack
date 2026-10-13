import { describeDaysLeft, formatQty, fromMilli, plural, roundMoney, type HotDishDto, type HotDishReasonDto, type Unit } from '@zapas/shared';
import { compareFefo } from './fefo';
import type { RecBatch, RecDish, RecLocation, RecProduct, RecVelocity } from './recommendations';
import { computeBatchRisks } from './risk';
import { portionsPossible, stockKey, type StockPoint } from './stoplist';

/** Ингредиент считается истекающим, если срок ближайшей партии кончается в этом окне. */
export const HOT_WINDOW_DAYS = 7;
/** Проблемой считаем ближайшую партию и те, что истекают не позже чем через столько суток после неё. */
const CLUSTER_DAYS = 2;
/** Часть срочности остаётся, даже если по продажам партия успеет уйти сама: прогноз может ошибаться. */
const BASE_PRESSURE = 0.4;
/** Больше порций одного блюда за смену продвижением не продать. */
export const MAX_PUSH_PORTIONS = 24;
/** Ниже этого приоритета блюдо в список не попадает. */
export const MIN_PRIORITY = 8;

export interface HotDish extends RecDish {
  price: number;
}

export interface HotInput {
  products: ReadonlyMap<string, RecProduct>;
  locations: ReadonlyMap<string, RecLocation>;
  /** Только партии с остатком. */
  batches: readonly RecBatch[];
  velocities: ReadonlyMap<string, RecVelocity>;
  dishes: readonly HotDish[];
  stock: ReadonlyMap<string, StockPoint>;
  /** Ключи dishId|locationId: блюда в стоп-листе. */
  blockedDishes?: ReadonlySet<string>;
  /** Ключи productId|locationId: продукты в стоп-листе, блюда с ними не предлагаем. */
  blockedProducts?: ReadonlySet<string>;
}

interface Need {
  productId: string;
  name: string;
  unit: Unit;
  /** Сутки до конца срока ближайшей партии. */
  daysLeft: number;
  /** 1 в последний день срока, 0,67 за сутки до него, 0,5 за двое. */
  urgency: number;
  /** От 0,4 до 1: растёт, когда по скорости продаж партия не успевает уйти. */
  weight: number;
  /** Сколько лежит в ближайших по сроку партиях. */
  stockMilli: number;
  unitCost: number;
}

interface Candidate {
  dish: HotDish;
  portions: number;
  push: number;
}

interface Take {
  need: Need;
  perPortionMilli: number;
  absorbMilli: number;
  share: number;
  contribution: number;
}

function expiringNeeds(locationId: string, input: HotInput): Map<string, Need> {
  const byProduct = new Map<string, RecBatch[]>();
  for (const b of input.batches) {
    if (b.locationId !== locationId) continue;
    const list = byProduct.get(b.productId);
    if (list) list.push(b);
    else byProduct.set(b.productId, [b]);
  }

  const needs = new Map<string, Need>();
  for (const [productId, list] of byProduct) {
    const product = input.products.get(productId);
    if (!product) continue;
    const expiring = list.filter((b) => b.remainingMilli > 0 && b.daysLeft >= 0 && b.daysLeft <= HOT_WINDOW_DAYS).sort(compareFefo);
    const nearest = expiring[0];
    if (!nearest) continue;
    const cluster = expiring.filter((b) => b.daysLeft <= nearest.daysLeft + CLUSTER_DAYS);

    const velocity = input.velocities.get(stockKey(productId, locationId)) ?? { perDay: 0, confidence: 0 };
    const risks = computeBatchRisks(list, velocity.perDay, velocity.confidence);
    let stock = 0;
    let atRisk = 0;
    let cost = 0;
    for (const b of cluster) {
      stock += b.remainingMilli;
      atRisk += Math.min(risks.get(b.id)?.atRiskMilli ?? 0, b.remainingMilli);
      cost += b.remainingMilli * b.unitCost;
    }
    const pressure = Math.min(1, atRisk / stock);
    needs.set(productId, {
      productId,
      name: product.name,
      unit: product.unit,
      daysLeft: nearest.daysLeft,
      urgency: 1 / (1 + nearest.daysLeft / 2),
      weight: BASE_PRESSURE + (1 - BASE_PRESSURE) * pressure,
      stockMilli: stock,
      unitCost: cost / stock,
    });
  }
  return needs;
}

/**
 * Вклад ингредиента: срочность × давление прогноза × доля истекающего остатка, которую блюдо способно израсходовать.
 * Вклады складываются как вероятности «хотя бы одно»: второй истекающий ингредиент поднимает приоритет,
 * но выше 100 он не уходит.
 */
function evaluate(c: Candidate, needs: ReadonlyMap<string, Need>, left: ReadonlyMap<string, number>): { score: number; takes: Take[] } {
  const takes: Take[] = [];
  let rest = 1;
  for (const item of c.dish.items) {
    const need = needs.get(item.productId);
    const available = left.get(item.productId) ?? 0;
    if (!need || available <= 0 || item.qtyMilli <= 0) continue;
    const absorbMilli = Math.min(available, c.push * item.qtyMilli);
    const share = absorbMilli / need.stockMilli;
    const contribution = need.urgency * need.weight * share;
    takes.push({ need, perPortionMilli: item.qtyMilli, absorbMilli, share, contribution });
    rest *= 1 - contribution;
  }
  return { score: 1 - rest, takes };
}

const round = (v: number, digits: number): number => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};

/** Штучное целыми, остальное до десятых: «88,114 шт» выглядит странно. */
const shownQty = (milli: number, unit: Unit): number => (unit === 'pcs' ? Math.round(fromMilli(milli)) : round(fromMilli(milli), 1));

function describe(dish: HotDish, portions: number, reasons: HotDishReasonDto[]): { headline: string; details: string } {
  const top = reasons[0];
  const parts = reasons.slice(0, 3).map((r) => `${r.productName}: ${describeDaysLeft(r.daysLeft)}, в ближайших партиях ${formatQty(r.stockQty, r.unit)}`);
  let details = `${parts.join('; ')}. Хватит на ${portions} ${plural(portions, ['порцию', 'порции', 'порций'])}.`;
  if (top) {
    details += ` Главный ингредиент «${top.productName}»: чтобы его использовать, нужно продать около ${top.portionsToUse} ${plural(top.portionsToUse, ['порции', 'порций', 'порций'])}.`;
    if (top.sharedWith.length > 0) details += ` Остаток делится с ${top.sharedWith.length > 1 ? 'блюдами' : 'блюдом'} «${top.sharedWith.slice(0, 2).join('», «')}».`;
  }
  return { headline: `Продвигать «${dish.name}»`, details };
}

function hotDishesAt(location: RecLocation, input: HotInput): HotDishDto[] {
  const needs = expiringNeeds(location.id, input);
  if (needs.size === 0) return [];

  const candidates: Candidate[] = [];
  for (const dish of input.dishes) {
    if (dish.items.length === 0) continue;
    if (input.blockedDishes?.has(`${dish.id}|${location.id}`)) continue;
    if (dish.items.some((i) => input.blockedProducts?.has(stockKey(i.productId, location.id)))) continue;
    if (!dish.items.some((i) => needs.has(i.productId))) continue;
    const portions = portionsPossible(dish, location.id, input.stock);
    if (portions <= 0) continue;
    candidates.push({ dish, portions, push: Math.min(portions, MAX_PUSH_PORTIONS) });
  }

  // Порядок раздачи остатка: сначала блюда, которым он нужнее всего при полном остатке
  const whole = new Map([...needs].map(([id, n]) => [id, n.stockMilli]));
  const order = candidates
    .map((c) => ({ c, raw: evaluate(c, needs, whole).score }))
    .sort((a, b) => b.raw - a.raw || a.c.dish.name.localeCompare(b.c.dish.name, 'ru'))
    .map((x) => x.c);

  const left = new Map(whole);
  const picked: { c: Candidate; priority: number; takes: Take[] }[] = [];
  for (const c of order) {
    const { score, takes } = evaluate(c, needs, left);
    for (const t of takes) left.set(t.need.productId, (left.get(t.need.productId) ?? 0) - t.absorbMilli);
    const priority = Math.round(score * 100);
    if (priority >= MIN_PRIORITY) picked.push({ c, priority, takes });
  }

  // Какие горячие блюда делят один ингредиент
  const users = new Map<string, string[]>();
  for (const p of picked) {
    for (const t of p.takes) {
      if (t.contribution <= 0) continue;
      const list = users.get(t.need.productId);
      if (list) list.push(p.c.dish.name);
      else users.set(t.need.productId, [p.c.dish.name]);
    }
  }

  return picked.map(({ c, priority, takes }): HotDishDto => {
    const reasons: HotDishReasonDto[] = takes
      .filter((t) => t.contribution > 0)
      .sort((a, b) => b.contribution - a.contribution)
      .map((t) => ({
        productId: t.need.productId,
        productName: t.need.name,
        unit: t.need.unit,
        daysLeft: t.need.daysLeft,
        stockQty: shownQty(t.need.stockMilli, t.need.unit),
        perPortion: round(fromMilli(t.perPortionMilli), 3),
        portionsToUse: Math.max(1, Math.ceil(t.absorbMilli / t.perPortionMilli - 1e-9)),
        share: round(t.share, 3),
        contribution: round(t.contribution, 3),
        value: roundMoney(fromMilli(t.absorbMilli) * t.need.unitCost),
        sharedWith: (users.get(t.need.productId) ?? []).filter((name) => name !== c.dish.name),
      }));
    const value = takes.reduce((sum, t) => sum + fromMilli(t.absorbMilli) * t.need.unitCost, 0);
    return {
      dishId: c.dish.id,
      dishName: c.dish.name,
      price: c.dish.price,
      locationId: location.id,
      locationName: location.name,
      priority,
      portions: c.portions,
      portionsToPush: reasons[0]?.portionsToUse ?? 0,
      daysLeft: Math.min(...reasons.map((r) => r.daysLeft)),
      atRiskValue: roundMoney(value),
      reasons,
      ...describe(c.dish, c.portions, reasons),
    };
  });
}

export interface HotDishOptions {
  /** Только эти точки. Не задано: все кухни. */
  locationIds?: readonly string[] | null;
  limit?: number;
}

/**
 * Блюда, продажу которых стоит стимулировать: чем меньше осталось до конца срока у их ингредиентов, тем выше приоритет.
 * Учитывается, сколько ингредиента на складе и сколько его в порции, а остаток, нужный нескольким блюдам, раздаётся по очереди.
 */
export function computeHotDishes(input: HotInput, options: HotDishOptions = {}): HotDishDto[] {
  const out: HotDishDto[] = [];
  for (const location of input.locations.values()) {
    if (location.kind !== 'kitchen' || !location.isActive) continue;
    if (options.locationIds && !options.locationIds.includes(location.id)) continue;
    out.push(...hotDishesAt(location, input));
  }
  out.sort((a, b) => b.priority - a.priority || b.atRiskValue - a.atRiskValue || a.dishName.localeCompare(b.dishName, 'ru'));
  return options.limit ? out.slice(0, options.limit) : out;
}
