import {
  daysWord,
  describeDaysLeft,
  formatMoney,
  formatMoneyWhole,
  formatNumber,
  formatQty,
  fromMilli,
  servesDishes,
  type LocationKind,
  type RecommendationDto,
  type Unit,
} from '@zapas/shared';
import { compareFefo } from './fefo';
import { computeBatchRisks, LOW_CONFIDENCE, type BatchRisk } from './risk';
import { portionsPossible, stockKey, type StockPoint } from './stoplist';

export interface RecProduct {
  id: string;
  name: string;
  unit: Unit;
  price: number;
  cost: number;
  minStock: number;
  isActive: boolean;
}

export interface RecLocation {
  id: string;
  name: string;
  kind: LocationKind;
  isActive: boolean;
  /** Организация точки. Блюда другой организации на ней не готовятся. */
  orgId?: string;
}

/** Блюдо видно на точке, если обе стороны из одной организации (или организация неизвестна, как в тестах). */
export function dishVisibleAt(dish: { orgId?: string }, location: { orgId?: string }): boolean {
  return !dish.orgId || !location.orgId || dish.orgId === location.orgId;
}

export interface RecBatch {
  id: string;
  productId: string;
  locationId: string;
  remainingMilli: number;
  expiresOn: string;
  receivedOn: string;
  daysLeft: number;
  unitCost: number;
  promoPercent: number | null;
}

export interface RecVelocity {
  perDay: number;
  confidence: number;
}

export interface RecDish {
  id: string;
  name: string;
  orgId?: string;
  items: { productId: string; qtyMilli: number }[];
}

export interface RecInput {
  products: ReadonlyMap<string, RecProduct>;
  locations: ReadonlyMap<string, RecLocation>;
  /** Только партии с остатком, в том числе просроченные. */
  batches: readonly RecBatch[];
  velocities: ReadonlyMap<string, RecVelocity>;
  tracked: ReadonlySet<string>;
  dishes: readonly RecDish[];
  reorderCoverDays: number;
}

/** Скидки предлагаем только на партии, которые истекают в этом окне. */
const DISCOUNT_WINDOW_DAYS = 7;
/** Перемещение имеет смысл, пока до конца срока есть запас на дорогу и продажу. */
const TRANSFER_WINDOW_DAYS = 10;
/** Заказ нужен, если остатка хватит меньше чем на столько суток. */
const REORDER_DAYS = 2;
const MIN_DISCOUNT = 5;

const log10 = (v: number): number => Math.log10(1 + Math.max(v, 0));

function round(value: number, digits: number): number {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
}

function discountTier(daysLeft: number, riskShare: number): number {
  let tier = daysLeft <= 1 ? 50 : daysLeft <= 3 ? 30 : 15;
  if (riskShare < 0.25) tier = tier === 50 ? 30 : tier === 30 ? 15 : 10;
  return tier;
}

/** Процент скидки с учётом потолка по себестоимости. Для последних суток потолок не действует: лучше продать дешевле, чем списать. */
function discountPercent(price: number, cost: number, daysLeft: number, riskShare: number): number {
  const tier = discountTier(daysLeft, riskShare);
  if (price <= 0) return 0;
  if (daysLeft <= 1) return tier;
  const cap = Math.floor((1 - cost / price) * 100);
  const pct = Math.min(tier, cap);
  return pct >= MIN_DISCOUNT ? Math.floor(pct / 5) * 5 : 0;
}

/** Штучный товар считаем целыми, остальное до десятых: дробные «88,114 шт» выглядят странно. */
function displayQty(value: number, unit: Unit): number {
  return unit === 'pcs' ? Math.round(value) : Math.round(value * 10) / 10;
}

function stepFloor(milli: number, unit: Unit): number {
  const step = unit === 'pcs' ? 1000 : 100;
  return Math.floor(milli / step) * step;
}

function stepCeil(value: number, unit: Unit): number {
  const step = unit === 'pcs' ? 1 : 0.5;
  return Math.ceil(value / step - 1e-9) * step;
}

export type Draft = Omit<RecommendationDto, 'headline' | 'details'> & { text: () => { headline: string; details: string } };

export interface RecommendationFilter {
  /** Только эти точки. Не задано: все. */
  locationIds?: readonly string[] | null;
  /** Только эти типы. Не задано: все. Счётчики на тип не влияют. */
  types?: readonly RecommendationDto['type'][];
}

export interface RecommendationPlan {
  items: RecommendationDto[];
  /** Сколько всего рекомендаций каждого типа в выбранных точках, даже если в items попали не все. */
  counts: Record<RecommendationDto['type'], number>;
  /** Сумма counts: сколько рекомендаций в выбранных точках без учёта типа. */
  total: number;
}

/** Все рекомендации целиком. Для разбора и тестов, в приложении используется planRecommendations с ограничением. */
export function buildRecommendations(input: RecInput): RecommendationDto[] {
  return planRecommendations(input, Infinity).items;
}

export function planRecommendations(input: RecInput, limit: number, filter: RecommendationFilter = {}): RecommendationPlan {
  return selectRecommendations(draftRecommendations(input), limit, filter);
}

/**
 * Из готовых черновиков выбирает нужные точки и типы, считает счётчики по этим точкам и пишет текст
 * (с форматированием чисел) только для тех, что войдут в ответ: на больших данных рекомендаций тысячи,
 * а человеку нужны первые сотни.
 */
export function selectRecommendations(drafts: readonly Draft[], limit: number, filter: RecommendationFilter = {}): RecommendationPlan {
  const places = filter.locationIds ? new Set(filter.locationIds) : null;
  const types = filter.types ? new Set(filter.types) : null;
  const counts: RecommendationPlan['counts'] = { writeoff: 0, discount: 0, transfer: 0, promote: 0, reorder: 0 };
  const picked: Draft[] = [];
  for (const d of drafts) {
    if (places && !places.has(d.locationId)) continue;
    counts[d.type] += 1;
    if (!types || types.has(d.type)) picked.push(d);
  }
  const items = picked.slice(0, limit).map(({ text, ...rest }): RecommendationDto => ({ ...rest, ...text() }));
  return { items, counts, total: Object.values(counts).reduce((x, y) => x + y, 0) };
}

/** Лёгкие черновики рекомендаций с приоритетом, по убыванию важности. Текст ещё не написан. */
export function draftRecommendations(input: RecInput): Draft[] {
  const out: Draft[] = [];
  // сколько уже решили отправить на каждую точку, чтобы разные источники не заняли одну и ту же ёмкость
  const planned = new Map<string, number>();

  const byPair = new Map<string, RecBatch[]>();
  const stock = new Map<string, StockPoint>();
  for (const b of input.batches) {
    const key = stockKey(b.productId, b.locationId);
    const list = byPair.get(key) ?? [];
    list.push(b);
    byPair.set(key, list);
    const point = stock.get(key) ?? { onHandMilli: 0, availableMilli: 0 };
    point.onHandMilli += b.remainingMilli;
    if (b.daysLeft >= 0) point.availableMilli += b.remainingMilli;
    stock.set(key, point);
  }

  const risks = new Map<string, Map<string, BatchRisk>>();
  for (const [key, list] of byPair) {
    const v = input.velocities.get(key) ?? { perDay: 0, confidence: 0 };
    risks.set(key, computeBatchRisks(list, v.perDay, v.confidence));
  }

  for (const [key, list] of byPair) {
    const sample = list[0];
    if (!sample) continue;
    const product = input.products.get(sample.productId);
    const location = input.locations.get(sample.locationId);
    if (!product || !location || !location.isActive) continue;
    const pairRisks = risks.get(key);
    if (!pairRisks) continue;
    const velocity = input.velocities.get(key) ?? { perDay: 0, confidence: 0 };

    let promoteAtRisk = 0;
    let promoteValue = 0;
    let promoteDays = Infinity;

    for (const batch of [...list].sort(compareFefo)) {
      const risk = pairRisks.get(batch.id);
      if (!risk || risk.atRiskMilli <= 0) continue;
      const atRisk = displayQty(fromMilli(risk.atRiskMilli), product.unit);
      if (atRisk <= 0) continue;
      const atRiskValue = round(atRisk * batch.unitCost, 2);

      if (batch.daysLeft < 0) {
        out.push({
          id: `writeoff:${batch.id}:${location.id}`,
          type: 'writeoff',
          priority: 500 + log10(atRiskValue) * 10,
          locationId: location.id,
          locationName: location.name,
          productId: product.id,
          productName: product.name,
          unit: product.unit,
          batchId: batch.id,
          expiresOn: batch.expiresOn,
          daysLeft: batch.daysLeft,
          quantity: atRisk,
          atRiskValue,
          action: { kind: 'writeoff', quantity: atRisk },
          text: () => ({
            headline: `Списать ${formatQty(atRisk, product.unit)}`,
            details: `Срок истёк ${daysWord(-batch.daysLeft)} назад, продавать нельзя. Потеря ${formatMoney(atRiskValue)} по себестоимости.`,
          }),
        });
        continue;
      }

      let leftover = Math.round(atRisk * 1000);

      // перемещение на точку, где позиция расходуется быстрее, чем лежит
      if (batch.daysLeft >= 2 && batch.daysLeft <= TRANSFER_WINDOW_DAYS) {
        let best: { loc: RecLocation; moveMilli: number; v: number } | null = null;
        for (const other of input.locations.values()) {
          if (other.id === location.id || !other.isActive) continue;
          const ov = input.velocities.get(stockKey(product.id, other.id));
          if (!ov || ov.confidence < LOW_CONFIDENCE || ov.perDay <= 0) continue;
          const have = stock.get(stockKey(product.id, other.id))?.availableMilli ?? 0;
          const already = planned.get(stockKey(product.id, other.id)) ?? 0;
          const absorbMilli = Math.max(0, ov.perDay * 1000 * (batch.daysLeft - 1) - have - already);
          const moveMilli = stepFloor(Math.min(absorbMilli, atRisk * 1000), product.unit);
          if (moveMilli < Math.max(atRisk * 100, 100)) continue;
          if (!best || moveMilli > best.moveMilli) best = { loc: other, moveMilli, v: ov.perDay };
        }
        if (best) {
          const target = best;
          const qty = fromMilli(target.moveMilli);
          out.push({
            id: `transfer:${batch.id}:${location.id}`,
            type: 'transfer',
            priority: 300 - 20 * Math.min(batch.daysLeft, 10) + log10(qty * batch.unitCost) * 10,
            locationId: location.id,
            locationName: location.name,
            productId: product.id,
            productName: product.name,
            unit: product.unit,
            batchId: batch.id,
            expiresOn: batch.expiresOn,
            daysLeft: batch.daysLeft,
            quantity: qty,
            atRiskValue: round(qty * batch.unitCost, 2),
            action: { kind: 'transfer', targetLocationId: target.loc.id, quantity: qty },
            targetLocationName: target.loc.name,
            text: () => ({
              headline: `Переместить ${formatQty(qty, product.unit)} → ${target.loc.name}`,
              details: `Здесь не успеем продать: срок ${describeDaysLeft(batch.daysLeft)}. На точке «${target.loc.name}» расход около ${formatQty(round(target.v, 2), product.unit)} в сутки, остатка не хватит до конца срока.`,
            }),
          });
          leftover -= target.moveMilli;
          planned.set(stockKey(product.id, target.loc.id), (planned.get(stockKey(product.id, target.loc.id)) ?? 0) + target.moveMilli);
        }
      }

      if (leftover > 0 && batch.daysLeft <= DISCOUNT_WINDOW_DAYS) {
        const leftoverQty = fromMilli(leftover);
        const share = leftover / batch.remainingMilli;
        const pct = discountPercent(product.price, product.cost, batch.daysLeft, share);
        const covered = batch.promoPercent !== null && batch.promoPercent >= pct;
        if (pct > 0 && !covered) {
          const promoPrice = round(product.price * (1 - pct / 100), 2);
          const lossValue = round(leftoverQty * batch.unitCost, 2);
          const recovery = round(leftoverQty * promoPrice, 2);
          const basis =
            risk.basis === 'rules'
              ? 'Продаж мало для прогноза, оценка по сроку.'
              : `При текущих продажах (${formatQty(round(velocity.perDay, 2), product.unit)} в сутки) не уйдёт ${formatQty(leftoverQty, product.unit)}.`;
          out.push({
            id: `discount:${batch.id}:${location.id}`,
            type: 'discount',
            priority: 300 - 20 * Math.min(batch.daysLeft, 10) + log10(lossValue) * 10,
            locationId: location.id,
            locationName: location.name,
            productId: product.id,
            productName: product.name,
            unit: product.unit,
            batchId: batch.id,
            expiresOn: batch.expiresOn,
            daysLeft: batch.daysLeft,
            quantity: leftoverQty,
            atRiskValue: lossValue,
            action: { kind: 'discount', percent: pct },
            recoveryValue: recovery,
            text: () => ({
              headline: `Скидка ${pct}% на ${formatQty(leftoverQty, product.unit)}`,
              details: `Срок ${describeDaysLeft(batch.daysLeft)}. ${basis} Цена ${formatMoney(promoPrice)} вместо ${formatMoney(product.price)}: вернём около ${formatMoneyWhole(recovery)} вместо потери ${formatMoneyWhole(lossValue)}.`,
            }),
          });
        }
      }

      if (batch.daysLeft <= DISCOUNT_WINDOW_DAYS) {
        promoteAtRisk += atRisk;
        promoteValue += atRiskValue;
        promoteDays = Math.min(promoteDays, batch.daysLeft);
      }
    }

    // ингредиент под угрозой: предложить блюда, в которых он используется
    if (servesDishes(location.kind) && promoteAtRisk > 0) {
      const dishes = input.dishes
        .filter((d) => dishVisibleAt(d, location) && d.items.some((i) => i.productId === product.id))
        .map((d) => ({ dish: d, portions: portionsPossible(d, location.id, stock) }))
        .filter((x) => x.portions > 0)
        .sort((a, b) => b.portions - a.portions)
        .slice(0, 4);
      if (dishes.length > 0) {
        out.push({
          id: `promote:${product.id}:${location.id}`,
          type: 'promote',
          priority: 200 - 10 * Math.min(promoteDays, 10) + log10(promoteValue) * 5,
          locationId: location.id,
          locationName: location.name,
          productId: product.id,
          productName: product.name,
          unit: product.unit,
          batchId: null,
          expiresOn: null,
          daysLeft: promoteDays,
          quantity: round(promoteAtRisk, 3),
          atRiskValue: round(promoteValue, 2),
          action: { kind: 'none' },
          dishes: dishes.map((x) => ({ id: x.dish.id, name: x.dish.name, portions: x.portions })),
          text: () => ({
            headline: `Блюда дня с ингредиентом «${product.name}»`,
            details: `${formatQty(round(promoteAtRisk, 3), product.unit)} может не дойти до гостя. Продвигайте: ${dishes.map((x) => x.dish.name).join(', ')}.`,
          }),
        });
      }
    }
  }

  // что заказать
  for (const key of input.tracked) {
    const [productId, locationId] = key.split('|');
    if (!productId || !locationId) continue;
    const product = input.products.get(productId);
    const location = input.locations.get(locationId);
    if (!product || !product.isActive || !location || !location.isActive) continue;

    const available = fromMilli(stock.get(key)?.availableMilli ?? 0);
    const v = input.velocities.get(key) ?? { perDay: 0, confidence: 0 };
    const trusted = v.confidence >= LOW_CONFIDENCE && v.perDay > 0;
    const daysToZero = trusted ? round(available / v.perDay, 1) : null;

    const belowMin = product.minStock > 0 && available <= product.minStock;
    const runningOut = daysToZero !== null && daysToZero <= REORDER_DAYS;
    if (!belowMin && !runningOut) continue;

    const wanted = Math.max(
      trusted ? v.perDay * input.reorderCoverDays - available : 0,
      product.minStock * 2 - available,
    );
    if (wanted <= 0) continue;
    const suggested = stepCeil(wanted, product.unit);
    const urgency = daysToZero ?? (available <= 0 ? 0 : 4);
    out.push({
      id: `reorder:${product.id}:${location.id}`,
      type: 'reorder',
      priority: 250 - 25 * Math.min(urgency, 8),
      locationId: location.id,
      locationName: location.name,
      productId: product.id,
      productName: product.name,
      unit: product.unit,
      batchId: null,
      expiresOn: null,
      daysLeft: null,
      quantity: suggested,
      atRiskValue: 0,
      action: { kind: 'none' },
      reorder: { suggestedQty: suggested, daysToZero, velocityPerDay: round(v.perDay, 3) },
      text: () => ({
        headline: `Заказать ${formatQty(suggested, product.unit)}`,
        details: [
          `Остаток ${formatQty(available, product.unit)}`,
          daysToZero !== null
            ? `при продажах ${formatNumber(round(v.perDay, 2))} в сутки хватит ${daysToZero < 1 ? 'меньше чем на сутки' : `на ${daysWord(Math.floor(daysToZero))}`}`
            : null,
          product.minStock > 0 ? `минимальный остаток ${formatQty(product.minStock, product.unit)}` : null,
        ]
          .filter(Boolean)
          .join(', ')
          .concat('.'),
      }),
    });
  }

  out.sort((a, b) => b.priority - a.priority);
  return out;
}
