import { daysBetween, fromMilli, servesDishes, type Unit } from '@zapas/shared';
import { compareFefo } from './fefo';
import { dishVisibleAt, type RecBatch, type RecLocation, type RecProduct, type RecVelocity } from './recommendations';
import { LOW_CONFIDENCE } from './risk';
import { portionsPossible, stockKey, type StockPoint } from './stoplist';

/** Как далеко смотрим вперёд. Дальше прогноз без новых поставок ничего не стоит. */
export const FORECAST_HORIZON_HOURS = 7 * 24;

export interface ForecastDish {
  id: string;
  name: string;
  orgId?: string;
  items: { productId: string; qtyMilli: number }[];
}

/** Поставка в пути: заказ отправлен, срок известен, часть товара ещё не принята. */
export interface IncomingDelivery {
  orderId: string;
  orderNumber: string;
  productId: string;
  locationId: string;
  /** Сколько ещё не принято по заказу. */
  qtyMilli: number;
  /** Дата поставки. */
  arrivesOn: string;
  /** Срок хранения продукта: после приёмки партия живёт столько. null: срок неизвестен, считаем, что хватит на весь прогноз. */
  shelfLifeDays: number | null;
}

/** Поставки привозят в середине дня: до этого часа остатка ещё нет, после уже есть. */
export const DELIVERY_HOUR = 12;

export interface StopForecastInput {
  locations: ReadonlyMap<string, RecLocation>;
  products: ReadonlyMap<string, RecProduct>;
  dishes: readonly ForecastDish[];
  batches: readonly RecBatch[];
  velocities: ReadonlyMap<string, RecVelocity>;
  stock: ReadonlyMap<string, StockPoint>;
  /** Сколько часов прошло с начала суток по времени бизнеса, дробное число от 0 до 24. */
  nowHour: number;
  /** Ключи dishId|locationId: блюда, которые уже в стоп-листе. */
  stopped?: ReadonlySet<string>;
  /** Ключи productId|locationId: продукты в стоп-листе, блюда с ними не прогнозируются. */
  blockedProducts?: ReadonlySet<string>;
  horizonHours?: number;
  /** Поставки в пути. Нужны вместе с today. Опоздавшие (дата в прошлом) в расчёт не берутся: неизвестно, приедут ли они. */
  incoming?: readonly IncomingDelivery[];
  /** Сегодняшняя дата по времени бизнеса, ГГГГ-ММ-ДД. */
  today?: string;
}

export interface StopForecastItem {
  dishId: string;
  dishName: string;
  locationId: string;
  locationName: string;
  /** Через сколько часов блюдо нельзя будет приготовить, если новых поставок не будет. */
  hoursLeft: number;
  /** depletion: остаток разойдётся при текущих продажах. expiry: закончится срок годности. */
  cause: 'depletion' | 'expiry';
  portionsNow: number;
  limiting: {
    productId: string;
    productName: string;
    unit: Unit;
    availableNow: number;
    perPortion: number;
    /** Расход в сутки, на котором построен прогноз. null: продаж мало для оценки, учтён только срок годности. */
    perDay: number | null;
  };
  /** Ближайшая поставка этого продукта на точку. afterStop: привезут уже после остановки. */
  incoming: { delivery: IncomingDelivery; afterStop: boolean } | null;
}

/** Блюдо, которое остановилось бы без поставки в пути, но с ней продержится весь прогноз. */
export interface StopForecastCovered {
  dishId: string;
  dishName: string;
  locationId: string;
  locationName: string;
  hoursWithoutDelivery: number;
  delivery: IncomingDelivery;
}

export interface StopForecastResult {
  warnings: StopForecastItem[];
  covered: StopForecastCovered[];
}

interface Curve {
  /** Сколько годного остатка будет через h часов, h от 0 до горизонта. */
  available: Float64Array;
  /** Через сколько часов истекает последняя партия, у которой есть остаток. */
  expiryHours: number[];
}

/**
 * Годный остаток позиции по часам вперёд. Партии расходуются по FEFO равномерно со скоростью продаж,
 * остаток партии пропадает в конце суток её срока. Поставки в пути появляются в свой час и дальше
 * расходуются так же, как остальные партии.
 */
function availabilityCurve(
  batches: readonly RecBatch[],
  perDayMilli: number,
  nowHour: number,
  horizon: number,
  deliveries: readonly { atHour: number; qtyMilli: number; shelfLifeDays: number | null }[] = [],
): Curve {
  const usable = batches.filter((b) => b.daysLeft >= 0 && b.remainingMilli > 0).sort(compareFefo);
  const pools = usable.map((b) => ({ left: b.remainingMilli, from: 0, expireAt: b.daysLeft * 24 + (24 - nowHour) }));
  for (const d of deliveries) {
    pools.push({ left: d.qtyMilli, from: d.atHour, expireAt: d.shelfLifeDays === null ? Number.POSITIVE_INFINITY : d.atHour + d.shelfLifeDays * 24 });
  }
  // расходуется то, что раньше испортится; при равных сроках порядок прежний
  pools.sort((x, y) => x.expireAt - y.expireAt);
  const perHour = perDayMilli / 24;
  const available = new Float64Array(horizon + 1);
  for (let h = 0; h <= horizon; h += 1) {
    let total = 0;
    for (const p of pools) if (p.from <= h && p.expireAt > h) total += p.left;
    available[h] = total;
    let need = perHour;
    for (const p of pools) {
      if (need <= 0) break;
      if (p.from > h || p.expireAt <= h) continue;
      const take = Math.min(p.left, need);
      p.left -= take;
      need -= take;
    }
  }
  return { available, expiryHours: pools.filter((p) => Number.isFinite(p.expireAt)).map((p) => p.expireAt) };
}

/** Час (от сейчас), в который привезут поставку. Опоздавшие и без даты не считаются: приедут ли они, неизвестно. */
function deliveryHour(arrivesOn: string, today: string, nowHour: number): number | null {
  const days = daysBetween(today, arrivesOn);
  if (days < 0) return null;
  return Math.max(0, days * 24 + DELIVERY_HOUR - nowHour);
}

/**
 * Когда блюда кухни перестанут готовиться: по каждому ингредиенту считается, через сколько часов его годного остатка
 * станет меньше одной порции, и берётся самый ранний. Это прогноз при текущей скорости продаж. Поставки в пути
 * учитываются: блюдо, которое с поставкой продержится весь прогноз, в предупреждения не попадает, а попадает в covered,
 * чтобы человек видел, что стоп не грозит только потому, что товар уже едет.
 */
export function forecastStopListDetailed(input: StopForecastInput): StopForecastResult {
  const horizon = input.horizonHours ?? FORECAST_HORIZON_HOURS;
  const curves = new Map<string, Curve>();
  const byPair = new Map<string, RecBatch[]>();
  for (const b of input.batches) {
    const key = stockKey(b.productId, b.locationId);
    const list = byPair.get(key);
    if (list) list.push(b);
    else byPair.set(key, [b]);
  }

  // поставки по позиции: только те, у которых известен будущий срок
  const deliveriesByPair = new Map<string, { delivery: IncomingDelivery; atHour: number }[]>();
  if (input.incoming && input.today) {
    for (const d of input.incoming) {
      const atHour = deliveryHour(d.arrivesOn, input.today, input.nowHour);
      if (atHour === null || d.qtyMilli <= 0) continue;
      const key = stockKey(d.productId, d.locationId);
      const list = deliveriesByPair.get(key) ?? [];
      list.push({ delivery: d, atHour });
      deliveriesByPair.set(key, list);
    }
    for (const list of deliveriesByPair.values()) list.sort((a, b) => a.atHour - b.atHour);
  }

  const curveFor = (productId: string, locationId: string, withDeliveries: boolean): Curve => {
    const key = stockKey(productId, locationId);
    const cacheKey = `${key}|${withDeliveries ? 1 : 0}`;
    let curve = curves.get(cacheKey);
    if (!curve) {
      const v = input.velocities.get(key);
      // при малой истории продаж скорости не верим: остаётся только срок годности
      const perDay = v && v.confidence >= LOW_CONFIDENCE ? v.perDay : 0;
      const extra = withDeliveries ? (deliveriesByPair.get(key) ?? []).map((d) => ({ atHour: d.atHour, qtyMilli: d.delivery.qtyMilli, shelfLifeDays: d.delivery.shelfLifeDays })) : [];
      curve = availabilityCurve(byPair.get(key) ?? [], perDay * 1000, input.nowHour, horizon, extra);
      curves.set(cacheKey, curve);
    }
    return curve;
  };

  const soonestStop = (dish: ForecastDish, locationId: string, withDeliveries: boolean) => {
    let soonest: { hours: number; item: ForecastDish['items'][number] } | null = null;
    for (const item of dish.items) {
      const { available } = curveFor(item.productId, locationId, withDeliveries);
      let stopAt = -1;
      for (let h = 0; h <= horizon; h += 1) {
        if ((available[h] as number) < item.qtyMilli) {
          stopAt = h;
          break;
        }
      }
      if (stopAt >= 0 && (!soonest || stopAt < soonest.hours)) soonest = { hours: stopAt, item };
    }
    return soonest;
  };

  const warnings: StopForecastItem[] = [];
  const covered: StopForecastCovered[] = [];
  for (const location of input.locations.values()) {
    if (!servesDishes(location.kind) || !location.isActive) continue;
    for (const dish of input.dishes) {
      if (!dishVisibleAt(dish, location) || dish.items.length === 0 || input.stopped?.has(`${dish.id}|${location.id}`)) continue;
      if (dish.items.some((i) => input.blockedProducts?.has(stockKey(i.productId, location.id)))) continue;
      const portionsNow = portionsPossible(dish, location.id, input.stock);
      if (portionsNow <= 0) continue;

      const hasDeliveries = dish.items.some((i) => deliveriesByPair.has(stockKey(i.productId, location.id)));
      const soonest = soonestStop(dish, location.id, true);
      if (!soonest) {
        // с поставкой остановки не будет: если без неё она была бы, это стоит показать
        const without = hasDeliveries ? soonestStop(dish, location.id, false) : null;
        if (without) {
          const delivery = deliveriesByPair.get(stockKey(without.item.productId, location.id))?.[0]?.delivery;
          if (delivery) covered.push({ dishId: dish.id, dishName: dish.name, locationId: location.id, locationName: location.name, hoursWithoutDelivery: without.hours, delivery });
        }
        continue;
      }

      const product = input.products.get(soonest.item.productId);
      if (!product) continue;
      const key = stockKey(soonest.item.productId, location.id);
      const curve = curveFor(soonest.item.productId, location.id, true);
      const v = input.velocities.get(key);
      const trusted = v !== undefined && v.confidence >= LOW_CONFIDENCE && v.perDay > 0;
      // остаток пропал из-за срока, если в последний час перед остановкой истекла какая-то партия
      const expired = curve.expiryHours.some((at) => at > soonest.hours - 1 && at <= soonest.hours);
      const nearest = deliveriesByPair.get(key)?.[0];
      warnings.push({
        dishId: dish.id,
        dishName: dish.name,
        locationId: location.id,
        locationName: location.name,
        hoursLeft: soonest.hours,
        cause: expired ? 'expiry' : 'depletion',
        portionsNow,
        limiting: {
          productId: product.id,
          productName: product.name,
          unit: product.unit,
          availableNow: fromMilli(input.stock.get(key)?.availableMilli ?? 0),
          perPortion: fromMilli(soonest.item.qtyMilli),
          perDay: trusted ? (v as RecVelocity).perDay : null,
        },
        incoming: nearest ? { delivery: nearest.delivery, afterStop: nearest.atHour > soonest.hours } : null,
      });
    }
  }
  const byTime = (a: { hoursLeft: number; dishName: string }, b: { hoursLeft: number; dishName: string }) => a.hoursLeft - b.hoursLeft || a.dishName.localeCompare(b.dishName, 'ru');
  warnings.sort(byTime);
  covered.sort((a, b) => a.hoursWithoutDelivery - b.hoursWithoutDelivery || a.dishName.localeCompare(b.dishName, 'ru'));
  return { warnings, covered };
}

/** Только предупреждения: блюда, которым стоп грозит даже с учётом поставок в пути. */
export function forecastStopList(input: StopForecastInput): StopForecastItem[] {
  return forecastStopListDetailed(input).warnings;
}
