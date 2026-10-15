import { describeDaysLeft, formatMoney, formatQty, fromMilli, plural, roundMoney, servesDishes, type HotDishDto, type HotDishReasonDto, type Unit } from '@zapas/shared';
import { compareFefo } from './fefo';
import { dishVisibleAt, type RecBatch, type RecDish, type RecLocation, type RecProduct, type RecVelocity } from './recommendations';
import { computeBatchRisks } from './risk';
import { portionsPossible, stockKey, type StockPoint } from './stoplist';

/** Ингредиент считается истекающим, если срок партии кончается в этом окне. */
export const HOT_WINDOW_DAYS = 7;
/** Часть вероятности потери остаётся, даже если по продажам партия успеет уйти сама: прогноз может ошибаться. */
const BASE_PRESSURE = 0.3;
/** Если о продажах блюда ничего не известно, больше порций за смену продвижением не продать. */
export const MAX_PUSH_PORTIONS = 24;
/** Когда продажи блюда известны, продвигать можно столько порций, сколько оно обычно продаётся за оставшиеся сутки, но не меньше этого. */
export const MIN_PUSH_PORTIONS = 4;
/** ...и не больше этого: на сотнях порций оценка уже ничего не значит. */
const MAX_DEMAND_PUSH = 120;
/** Ниже этой уверенности в скорости продаж блюда (новое блюдо) ей не верим. */
const DEMAND_MIN_CONFIDENCE = 0.3;
/** Ниже этого приоритета блюдо в список не попадает. */
export const MIN_PRIORITY = 8;
/** Сколько рублей «срочных» денег даёт приоритет около 63: чем меньше, тем строже блюда отбираются по деньгам. */
const MONEY_SCALE = 300;
/** Если у партии нет себестоимости, считаем по рублю за единицу: деньги в приоритет почти не попадают, но блюдо не теряется. */
const FALLBACK_COST = 1;
/**
 * Маржа порции двигает приоритет не сильнее чем на 15% в каждую сторону: ингредиенты истекают и пропадут при любой марже,
 * поэтому деньги по-прежнему решают, а маржа только выбирает между близкими блюдами.
 */
export const MARGIN_FACTOR_MIN = 0.85;
export const MARGIN_FACTOR_MAX = 1.15;
/** Блюдо, которое обычно не заказывают в оставшиеся часы суток, теряет до половины приоритета (если срок ингредиентов близок). */
export const TIME_FACTOR_MIN = 0.5;
/** Часы, у которых нет продаж, дают пустую картину: с меньшим числом продаж по часам распределению не верим. */
export const MIN_HOURLY_SALES = 10;

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
  /** Сколько порций блюда продаётся в сутки: ключи dishId|locationId. Нет данных: берём общий потолок. */
  dishDemand?: ReadonlyMap<string, RecVelocity>;
  /** Ключи dishId|locationId: блюда в стоп-листе. */
  blockedDishes?: ReadonlySet<string>;
  /** Ключи productId|locationId: продукты в стоп-листе, блюда с ними не предлагаем. */
  blockedProducts?: ReadonlySet<string>;
  /**
   * Доли продаж блюда по часам суток (24 числа, в сумме 1): ключи dishId|locationId. Вместе с nowHour позволяют
   * учесть, подходит ли блюдо к оставшейся части дня. Нет данных: время суток не учитывается.
   */
  dishHourly?: ReadonlyMap<string, readonly number[]>;
  /** Сколько часов прошло с начала суток по времени бизнеса. */
  nowHour?: number;
  /** Учитывать маржу порции. По умолчанию выключено: так считали раньше. */
  useMargin?: boolean;
}

/** Партия с истекающим сроком: у каждой своя срочность и своя вероятность потери. */
interface Slice {
  id: string;
  daysLeft: number;
  remainingMilli: number;
  unitCost: number;
  /** 1 в последний день срока, 0,67 за сутки до него, 0,5 за двое. */
  urgency: number;
  /** От 0,3 до 1: растёт, когда по скорости продаж партия не успевает уйти. */
  weight: number;
}

/** Истекающий запас одного продукта на кухне, партии идут по FEFO. */
interface Pool {
  productId: string;
  name: string;
  unit: Unit;
  slices: Slice[];
  totalMilli: number;
  nearestDays: number;
}

interface Candidate {
  /** Множитель приоритета от маржи (1 без поправки) и от времени суток. */
  marginFactor: number;
  timeFactor: number;
  margin: HotDishDto['margin'];
  timeFit: number | null;
  dish: HotDish;
  /** Рецептура, где повторяющийся продукт сложен в одну строку. */
  items: { productId: string; qtyMilli: number }[];
  portions: number;
  push: number;
}

interface Take {
  pool: Pool;
  perPortionMilli: number;
  absorbMilli: number;
  /** Себестоимость поглощённого. */
  value: number;
  /** Вклад ингредиента в приоритет: «срочные» деньги, делённые на масштаб. */
  contribution: number;
  /** Сколько партий и в каком количестве блюдо забирает (для списания остатка). */
  taken: Map<string, number>;
}

function expiringPools(locationId: string, input: HotInput): Map<string, Pool> {
  const byProduct = new Map<string, RecBatch[]>();
  for (const b of input.batches) {
    if (b.locationId !== locationId) continue;
    const list = byProduct.get(b.productId);
    if (list) list.push(b);
    else byProduct.set(b.productId, [b]);
  }

  const pools = new Map<string, Pool>();
  for (const [productId, list] of byProduct) {
    const product = input.products.get(productId);
    if (!product) continue;
    const expiring = list.filter((b) => b.remainingMilli > 0 && b.daysLeft >= 0 && b.daysLeft <= HOT_WINDOW_DAYS).sort(compareFefo);
    if (expiring.length === 0) continue;

    const velocity = input.velocities.get(stockKey(productId, locationId)) ?? { perDay: 0, confidence: 0 };
    const risks = computeBatchRisks(list, velocity.perDay, velocity.confidence);
    const slices: Slice[] = expiring.map((b) => {
      const atRisk = Math.min(risks.get(b.id)?.atRiskMilli ?? 0, b.remainingMilli);
      return {
        id: b.id,
        daysLeft: b.daysLeft,
        remainingMilli: b.remainingMilli,
        unitCost: b.unitCost > 0 ? b.unitCost : product.cost > 0 ? product.cost : FALLBACK_COST,
        urgency: 1 / (1 + b.daysLeft / 2),
        weight: BASE_PRESSURE + (1 - BASE_PRESSURE) * (atRisk / b.remainingMilli),
      };
    });
    pools.set(productId, {
      productId,
      name: product.name,
      unit: product.unit,
      slices,
      totalMilli: slices.reduce((sum, x) => sum + x.remainingMilli, 0),
      nearestDays: slices[0]?.daysLeft ?? 0,
    });
  }
  return pools;
}

/**
 * Что блюдо заберёт из истекающего запаса и сколько это стоит. Партии берём по FEFO, как и при продаже.
 * Вклад ингредиента считается в деньгах: себестоимость забранного × вероятность, что партия иначе пропадёт × срочность.
 * Чем дороже и ближе к концу срока то, что блюдо способно израсходовать, тем выше приоритет. Деньги разных
 * ингредиентов складываются, а в 0-100 приводятся плавно: 100 · (1 − e^(−сумма / MONEY_SCALE)).
 */
function evaluate(c: Candidate, pools: ReadonlyMap<string, Pool>, left: ReadonlyMap<string, number>): { total: number; takes: Take[] } {
  const takes: Take[] = [];
  let total = 0;
  for (const item of c.items) {
    const pool = pools.get(item.productId);
    if (!pool || item.qtyMilli <= 0) continue;
    let want = c.push * item.qtyMilli;
    let absorb = 0;
    let value = 0;
    let urgentMoney = 0;
    const taken = new Map<string, number>();
    for (const slice of pool.slices) {
      if (want <= 0) break;
      const t = Math.min(left.get(slice.id) ?? 0, want);
      if (t <= 0) continue;
      want -= t;
      absorb += t;
      taken.set(slice.id, t);
      const money = fromMilli(t) * slice.unitCost;
      value += money;
      urgentMoney += money * slice.weight * slice.urgency;
    }
    if (absorb <= 0) continue;
    const contribution = urgentMoney / MONEY_SCALE;
    total += contribution;
    takes.push({ pool, perPortionMilli: item.qtyMilli, absorbMilli: absorb, value, contribution, taken });
  }
  return { total, takes };
}

const toPriority = (total: number): number => Math.round(100 * (1 - Math.exp(-total)));

const round = (v: number, digits: number): number => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};

/** Штучное целыми, остальное до десятых: «88,114 шт» выглядит странно. */
const shownQty = (milli: number, unit: Unit): number => (unit === 'pcs' ? Math.round(fromMilli(milli)) : round(fromMilli(milli), 1));

function describe(dish: HotDish, portions: number, reasons: HotDishReasonDto[], c: Pick<Candidate, 'margin' | 'timeFit' | 'timeFactor'>): { headline: string; details: string } {
  const top = reasons[0];
  const parts = reasons.slice(0, 3).map((r) => `${r.productName}: ${describeDaysLeft(r.daysLeft)}, в истекающих партиях ${formatQty(r.stockQty, r.unit)}`);
  let details = `${parts.join('; ')}. Хватит на ${portions} ${plural(portions, ['порцию', 'порции', 'порций'])}.`;
  if (top) {
    details += ` Главный ингредиент «${top.productName}»: чтобы его использовать, нужно продать около ${top.portionsToUse} ${plural(top.portionsToUse, ['порции', 'порций', 'порций'])}.`;
    if (top.sharedWith.length > 0) details += ` Остаток делится с ${top.sharedWith.length > 1 ? 'блюдами' : 'блюдом'} «${top.sharedWith.slice(0, 2).join('», «')}».`;
  }
  if (c.margin) details += ` Маржа порции ${Math.round(c.margin.rate * 100)}%: ${formatMoney(c.margin.perPortion)} при себестоимости ${formatMoney(c.margin.cost)}.`;
  if (c.timeFit !== null && c.timeFactor < 0.95) details += ` Это блюдо обычно заказывают раньше: на остаток дня приходится около ${Math.round(c.timeFit * 100)}% его продаж, поэтому приоритет снижен.`;
  return { headline: `Продвигать «${dish.name}»`, details };
}

/** Маржа порции по себестоимости рецептуры. Без цены блюда или себестоимости любого ингредиента маржу не считаем. */
export function dishMargin(dish: HotDish, products: ReadonlyMap<string, RecProduct>): HotDishDto['margin'] {
  if (!(dish.price > 0)) return null;
  let cost = 0;
  for (const i of dish.items) {
    const p = products.get(i.productId);
    if (!p || !(p.cost > 0)) return null;
    cost += fromMilli(i.qtyMilli) * p.cost;
  }
  const perPortion = dish.price - cost;
  return { perPortion: roundMoney(perPortion), rate: round(Math.max(0, Math.min(1, perPortion / dish.price)), 3), cost: roundMoney(cost) };
}

export function marginFactor(margin: HotDishDto['margin']): number {
  if (!margin) return 1;
  return round(MARGIN_FACTOR_MIN + (MARGIN_FACTOR_MAX - MARGIN_FACTOR_MIN) * margin.rate, 4);
}

/** Какая доля продаж блюда приходится на текущий час и оставшуюся часть суток. */
export function remainingShare(hourly: readonly number[], nowHour: number): number {
  const from = Math.min(23, Math.max(0, Math.floor(nowHour)));
  let sum = 0;
  for (let h = from; h < 24; h += 1) sum += hourly[h] ?? 0;
  return Math.min(1, Math.max(0, sum));
}

/**
 * Поправка на время суток. Если ингредиенты живут ещё несколько суток, блюдо успеет продаться и завтра, поэтому
 * поправка тает: за двое суток до конца срока она втрое слабее.
 */
export function timeFactor(share: number | null, nearestDays: number): number {
  if (share === null) return 1;
  const raw = TIME_FACTOR_MIN + (1 - TIME_FACTOR_MIN) * share;
  return round(1 - (1 - raw) / (1 + Math.max(0, nearestDays)), 4);
}

function pushLimit(portions: number, demand: RecVelocity | undefined, horizonDays: number): number {
  if (!demand || demand.confidence < DEMAND_MIN_CONFIDENCE || !Number.isFinite(horizonDays)) return Math.min(portions, MAX_PUSH_PORTIONS);
  const plausible = Math.ceil(demand.perDay * horizonDays);
  return Math.min(portions, Math.min(MAX_DEMAND_PUSH, Math.max(MIN_PUSH_PORTIONS, plausible)));
}

function hotDishesAt(location: RecLocation, input: HotInput): HotDishDto[] {
  const pools = expiringPools(location.id, input);
  if (pools.size === 0) return [];

  const candidates: Candidate[] = [];
  for (const dish of input.dishes) {
    if (dish.items.length === 0 || !dishVisibleAt(dish, location)) continue;
    if (input.blockedDishes?.has(`${dish.id}|${location.id}`)) continue;
    if (dish.items.some((i) => input.blockedProducts?.has(stockKey(i.productId, location.id)))) continue;
    if (!dish.items.some((i) => pools.has(i.productId))) continue;
    // Один продукт мог попасть в рецептуру двумя строками: считаем его одной, иначе остаток обещался бы дважды
    const merged = new Map<string, number>();
    for (const i of dish.items) merged.set(i.productId, (merged.get(i.productId) ?? 0) + i.qtyMilli);
    const items = [...merged].map(([productId, qtyMilli]) => ({ productId, qtyMilli }));
    const portions = portionsPossible({ items }, location.id, input.stock);
    if (portions <= 0) continue;
    // Сколько порций реально можно продвинуть: не больше, чем блюдо обычно продаётся за время, пока ингредиенты живы
    const horizon = 1 + Math.min(...items.map((i) => pools.get(i.productId)?.nearestDays ?? Infinity));
    const margin = input.useMargin ? dishMargin(dish, input.products) : null;
    const hourly = input.dishHourly?.get(`${dish.id}|${location.id}`);
    const timeFit = hourly && input.nowHour !== undefined ? round(remainingShare(hourly, input.nowHour), 3) : null;
    candidates.push({
      dish,
      items,
      portions,
      push: pushLimit(portions, input.dishDemand?.get(`${dish.id}|${location.id}`), horizon),
      margin,
      timeFit,
      marginFactor: marginFactor(margin),
      timeFactor: timeFactor(timeFit, horizon - 1),
    });
  }

  // Остаток, нужный нескольким блюдам, раздаём по очереди: каждый раз берём блюдо, которому он сейчас нужнее всего.
  // Блюдо ниже порога ничего не забирает: его в списке нет, значит и остаток остаётся другим.
  const left = new Map<string, number>();
  for (const pool of pools.values()) for (const slice of pool.slices) left.set(slice.id, slice.remainingMilli);

  const picked: { c: Candidate; priority: number; takes: Take[] }[] = [];
  const rest = [...candidates].sort((a, b) => a.dish.name.localeCompare(b.dish.name, 'ru') || a.dish.id.localeCompare(b.dish.id));
  while (rest.length > 0) {
    let bestIndex = -1;
    let best: ReturnType<typeof evaluate> | null = null;
    rest.forEach((c, index) => {
      const raw = evaluate(c, pools, left);
      const ev = { ...raw, total: raw.total * c.marginFactor * c.timeFactor };
      if (!best || ev.total > best.total + 1e-12) {
        best = ev;
        bestIndex = index;
      }
    });
    if (!best || bestIndex < 0) break;
    const { total, takes } = best as ReturnType<typeof evaluate>;
    const priority = toPriority(total);
    if (priority < MIN_PRIORITY) break;
    const [c] = rest.splice(bestIndex, 1);
    if (!c) break;
    for (const t of takes) for (const [id, qty] of t.taken) left.set(id, (left.get(id) ?? 0) - qty);
    picked.push({ c, priority, takes });
  }

  // Какие горячие блюда делят один ингредиент
  const users = new Map<string, string[]>();
  for (const p of picked) {
    for (const t of p.takes) {
      if (t.contribution <= 0) continue;
      const list = users.get(t.pool.productId);
      if (list) list.push(p.c.dish.name);
      else users.set(t.pool.productId, [p.c.dish.name]);
    }
  }

  return picked.map(({ c, priority, takes }): HotDishDto => {
    const reasons: HotDishReasonDto[] = takes
      .filter((t) => t.contribution > 0)
      .sort((a, b) => b.contribution - a.contribution || a.pool.name.localeCompare(b.pool.name, 'ru'))
      .map((t) => ({
        productId: t.pool.productId,
        productName: t.pool.name,
        unit: t.pool.unit,
        daysLeft: t.pool.nearestDays,
        stockQty: shownQty(t.pool.totalMilli, t.pool.unit),
        perPortion: round(fromMilli(t.perPortionMilli), 3),
        portionsToUse: Math.max(1, Math.ceil(t.absorbMilli / t.perPortionMilli - 1e-9)),
        share: round(Math.min(1, t.absorbMilli / t.pool.totalMilli), 3),
        contribution: round(Math.min(1, t.contribution), 3),
        value: roundMoney(t.value),
        sharedWith: (users.get(t.pool.productId) ?? []).filter((name) => name !== c.dish.name),
      }));
    const value = takes.reduce((sum, t) => sum + t.value, 0);
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
      ...describe(c.dish, c.portions, reasons, c),
      margin: c.margin,
      timeFit: c.timeFit,
      factors: { margin: c.marginFactor, time: c.timeFactor },
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
    if (!servesDishes(location.kind) || !location.isActive) continue;
    if (options.locationIds && !options.locationIds.includes(location.id)) continue;
    out.push(...hotDishesAt(location, input));
  }
  out.sort((a, b) => b.priority - a.priority || b.atRiskValue - a.atRiskValue || a.dishName.localeCompare(b.dishName, 'ru'));
  return options.limit ? out.slice(0, options.limit) : out;
}
