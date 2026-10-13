import { fromMilli, type Unit } from '@zapas/shared';
import { compareFefo } from './fefo';
import type { RecBatch, RecLocation, RecProduct, RecVelocity } from './recommendations';
import { LOW_CONFIDENCE } from './risk';
import { portionsPossible, stockKey, type StockPoint } from './stoplist';

/** Как далеко смотрим вперёд. Дальше прогноз без новых поставок ничего не стоит. */
export const FORECAST_HORIZON_HOURS = 7 * 24;

export interface ForecastDish {
  id: string;
  name: string;
  items: { productId: string; qtyMilli: number }[];
}

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
}

interface Curve {
  /** Сколько годного остатка будет через h часов, h от 0 до горизонта. */
  available: Float64Array;
  /** Через сколько часов истекает последняя партия, у которой есть остаток. */
  expiryHours: number[];
}

/**
 * Годный остаток позиции по часам вперёд. Партии расходуются по FEFO равномерно со скоростью продаж,
 * остаток партии пропадает в конце суток её срока. Новые поставки не учитываются.
 */
function availabilityCurve(batches: readonly RecBatch[], perDayMilli: number, nowHour: number, horizon: number): Curve {
  const usable = batches.filter((b) => b.daysLeft >= 0 && b.remainingMilli > 0).sort(compareFefo);
  const left = usable.map((b) => b.remainingMilli);
  const expireAt = usable.map((b) => b.daysLeft * 24 + (24 - nowHour));
  const perHour = perDayMilli / 24;
  const available = new Float64Array(horizon + 1);
  for (let h = 0; h <= horizon; h += 1) {
    let total = 0;
    for (let j = 0; j < usable.length; j += 1) if ((expireAt[j] as number) > h) total += left[j] as number;
    available[h] = total;
    let need = perHour;
    for (let j = 0; j < usable.length && need > 0; j += 1) {
      if ((expireAt[j] as number) <= h) continue;
      const take = Math.min(left[j] as number, need);
      left[j] = (left[j] as number) - take;
      need -= take;
    }
  }
  return { available, expiryHours: expireAt };
}

/**
 * Когда блюда кухни перестанут готовиться: по каждому ингредиенту считается, через сколько часов его годного остатка
 * станет меньше одной порции, и берётся самый ранний. Это прогноз при текущей скорости продаж и без новых поставок.
 */
export function forecastStopList(input: StopForecastInput): StopForecastItem[] {
  const horizon = input.horizonHours ?? FORECAST_HORIZON_HOURS;
  const curves = new Map<string, Curve>();
  const byPair = new Map<string, RecBatch[]>();
  for (const b of input.batches) {
    const key = stockKey(b.productId, b.locationId);
    const list = byPair.get(key);
    if (list) list.push(b);
    else byPair.set(key, [b]);
  }

  const curveFor = (productId: string, locationId: string): Curve => {
    const key = stockKey(productId, locationId);
    let curve = curves.get(key);
    if (!curve) {
      const v = input.velocities.get(key);
      // при малой истории продаж скорости не верим: остаётся только срок годности
      const perDay = v && v.confidence >= LOW_CONFIDENCE ? v.perDay : 0;
      curve = availabilityCurve(byPair.get(key) ?? [], perDay * 1000, input.nowHour, horizon);
      curves.set(key, curve);
    }
    return curve;
  };

  const out: StopForecastItem[] = [];
  for (const location of input.locations.values()) {
    if (location.kind !== 'kitchen' || !location.isActive) continue;
    for (const dish of input.dishes) {
      if (dish.items.length === 0 || input.stopped?.has(`${dish.id}|${location.id}`)) continue;
      if (dish.items.some((i) => input.blockedProducts?.has(stockKey(i.productId, location.id)))) continue;
      const portionsNow = portionsPossible(dish, location.id, input.stock);
      if (portionsNow <= 0) continue;

      let soonest: { hours: number; item: ForecastDish['items'][number] } | null = null;
      for (const item of dish.items) {
        const { available } = curveFor(item.productId, location.id);
        let stopAt = -1;
        for (let h = 0; h <= horizon; h += 1) {
          if ((available[h] as number) < item.qtyMilli) {
            stopAt = h;
            break;
          }
        }
        if (stopAt >= 0 && (!soonest || stopAt < soonest.hours)) soonest = { hours: stopAt, item };
      }
      if (!soonest) continue;

      const product = input.products.get(soonest.item.productId);
      if (!product) continue;
      const key = stockKey(soonest.item.productId, location.id);
      const curve = curveFor(soonest.item.productId, location.id);
      const v = input.velocities.get(key);
      const trusted = v !== undefined && v.confidence >= LOW_CONFIDENCE && v.perDay > 0;
      // остаток пропал из-за срока, если в последний час перед остановкой истекла какая-то партия
      const expired = curve.expiryHours.some((at) => at > soonest.hours - 1 && at <= soonest.hours);
      out.push({
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
      });
    }
  }
  return out.sort((a, b) => a.hoursLeft - b.hoursLeft || a.dishName.localeCompare(b.dishName, 'ru'));
}
