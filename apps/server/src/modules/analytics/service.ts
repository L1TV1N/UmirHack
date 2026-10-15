import {
  addDays,
  fromMilli,
  roundMoney,
  type DashboardDto,
  type ExpiryBucketDto,
  type ForecastDto,
  type HotDishDto,
  type HotDishesDto,
  type RecommendationsDto,
  type RecommendationType,
  type RescuedProductDto,
  type RescuedStatsDto,
  type ShortageIngredientDto,
  type ShortageStatsDto,
  type StopListDto,
  type WriteoffReason,
  type Unit,
  type WriteoffTrendPoint,
} from '@zapas/shared';
import { sql } from 'kysely';
import { computeHotDishes } from '../../domain/hot-dishes';
import { computeBatchRisks } from '../../domain/risk';
import { draftRecommendations, selectRecommendations, type Draft, type RecommendationFilter, type RecommendationPlan } from '../../domain/recommendations';
import { stockKey } from '../../domain/stoplist';
import type { Deps, Principal } from '../../lib/context';
import { notFound } from '../../lib/errors';
import { assertLocation, locationFilter } from '../../lib/scope';
import { businessHour } from '../../lib/time';
import { getStopList } from '../stoplist/service';
import { cachedAggregate, getSnapshot, scopeKey, type Snapshot } from './snapshot';

/** Сверх этого человек всё равно не прочитает, а на больших данных список весит мегабайты. */
export const MAX_RECOMMENDATIONS = 500;

// Срез не меняется после загрузки, поэтому черновики рекомендаций по нему считаем один раз,
// а готовые ответы для одинаковых точек и типов запоминаем
const drafts = new WeakMap<Snapshot, Draft[]>();
const answers = new WeakMap<Snapshot, Map<string, RecommendationPlan>>();
const MAX_ANSWERS_PER_SNAPSHOT = 32;

function recommendationsFrom(snap: Snapshot, filter: RecommendationFilter = {}): RecommendationPlan {
  let list = drafts.get(snap);
  if (!list) {
    list = draftRecommendations({
      products: snap.products,
      locations: snap.locations,
      batches: snap.batches,
      velocities: snap.velocities,
      tracked: snap.tracked,
      dishes: snap.dishes,
      reorderCoverDays: snap.settings.reorderCoverDays,
    });
    drafts.set(snap, list);
  }
  const key = `${scopeKey(filter.locationIds ? [...filter.locationIds] : null)}|${(filter.types ?? []).join(',')}`;
  let byKey = answers.get(snap);
  if (!byKey) {
    byKey = new Map();
    answers.set(snap, byKey);
  }
  const known = byKey.get(key);
  if (known) return known;
  const plan = selectRecommendations(list, MAX_RECOMMENDATIONS, filter);
  if (byKey.size >= MAX_ANSWERS_PER_SNAPSHOT) byKey.clear();
  byKey.set(key, plan);
  return plan;
}

export async function getRecommendations(
  deps: Deps,
  principal: Principal,
  requestedLocation?: string,
  type?: RecommendationType,
): Promise<RecommendationsDto> {
  const allowed = locationFilter(principal);
  if (requestedLocation) assertLocation(principal, requestedLocation);
  // для переноса нужны все доступные точки, поэтому срез шире запрошенной
  const snap = await getSnapshot(deps, allowed);
  return recommendationsFrom(snap, {
    ...(requestedLocation ? { locationIds: [requestedLocation] } : {}),
    ...(type ? { types: [type] } : {}),
  });
}

/** Длиннее список человек не прочитает. */
export const MAX_HOT_DISHES = 30;

/** Горячие блюда для выбранных точек. Блюда и продукты из стоп-листа в список не попадают. */
export function hotDishesFrom(snap: Snapshot, stop: StopListDto, scopeIds: string[] | null, nowHour: number): HotDishDto[] {
  const blockedDishes = new Set<string>();
  const blockedProducts = new Set<string>();
  for (const e of stop.entries) (e.entityType === 'dish' ? blockedDishes : blockedProducts).add(`${e.entityId}|${e.locationId}`);
  return computeHotDishes(
    { products: snap.products, locations: snap.locations, batches: snap.batches, velocities: snap.velocities, dishes: snap.dishes, dishDemand: snap.dishDemand, dishHourly: snap.dishHourly, nowHour, useMargin: true, stock: snap.stock, blockedDishes, blockedProducts },
    { locationIds: scopeIds, limit: MAX_HOT_DISHES },
  );
}

export async function getHotDishes(deps: Deps, principal: Principal, requestedLocation?: string): Promise<HotDishesDto> {
  const allowed = locationFilter(principal);
  if (requestedLocation) assertLocation(principal, requestedLocation);
  const scopeIds = requestedLocation ? [requestedLocation] : allowed;
  const snap = await getSnapshot(deps, allowed);
  const stop = await getStopList(deps, scopeIds, snap);
  return { asOf: deps.clock().toISOString(), locationId: requestedLocation ?? null, items: hotDishesFrom(snap, stop, scopeIds, businessHour(deps)) };
}

const BUCKETS: { key: ExpiryBucketDto['key']; label: string; test: (d: number) => boolean }[] = [
  { key: 'expired', label: 'Просрочено', test: (d) => d < 0 },
  { key: 'd0_1', label: '0–1 дн.', test: (d) => d >= 0 && d <= 1 },
  { key: 'd2_3', label: '2–3 дн.', test: (d) => d >= 2 && d <= 3 },
  { key: 'd4_7', label: '4–7 дн.', test: (d) => d >= 4 && d <= 7 },
  { key: 'd8_14', label: '8–14 дн.', test: (d) => d >= 8 && d <= 14 },
  { key: 'd15_plus', label: '15+ дн.', test: (d) => d >= 15 },
];

const TREND_DAYS = 30;

function inList(ids: string[]) {
  return sql`${sql.join(ids.map((id) => sql`${id}::uuid`))}`;
}

export interface StockSummary {
  stockValue: number;
  expiringSoonValue: number;
  expiringSoonBatches: number;
  expiredValue: number;
  expiredBatches: number;
  atRiskValue: number;
  lowStockCount: number;
  buckets: Map<ExpiryBucketDto['key'], { value: number; batches: number }>;
}

const MAX_SUMMARIES_PER_SNAPSHOT = 16;
const summaries = new WeakMap<Snapshot, Map<string, StockSummary>>();

/** Все суммы панели, зависящие только от среза. На больших данных это основная стоимость запроса, поэтому считаем раз на срез. */
export function summarize(snap: Snapshot, scopeIds: string[] | null): StockSummary {
  const key = scopeKey(scopeIds);
  let byScope = summaries.get(snap);
  if (!byScope) {
    byScope = new Map();
    summaries.set(snap, byScope);
  }
  const known = byScope.get(key);
  if (known) return known;

  const { settings } = snap;
  const inScope = (locationId: string) => !scopeIds || scopeIds.includes(locationId);
  const batches = snap.batches.filter((b) => inScope(b.locationId));

  let stockValue = 0;
  let expiringSoonValue = 0;
  let expiringSoonBatches = 0;
  let expiredValue = 0;
  let expiredBatches = 0;
  const buckets = new Map(BUCKETS.map((b) => [b.key, { value: 0, batches: 0 }]));
  const byPair = new Map<string, typeof batches>();

  for (const b of batches) {
    const value = fromMilli(b.remainingMilli) * b.unitCost;
    stockValue += value;
    if (b.daysLeft < 0) {
      expiredValue += value;
      expiredBatches += 1;
    } else if (b.daysLeft <= settings.expiringSoonDays) {
      expiringSoonValue += value;
      expiringSoonBatches += 1;
    }
    const bucket = BUCKETS.find((x) => x.test(b.daysLeft));
    const total = bucket && buckets.get(bucket.key);
    if (total) {
      total.value += value;
      total.batches += 1;
    }
    const pair = stockKey(b.productId, b.locationId);
    const list = byPair.get(pair);
    if (list) list.push(b);
    else byPair.set(pair, [b]);
  }

  let atRiskValue = 0;
  for (const [pair, list] of byPair) {
    const v = snap.velocities.get(pair) ?? { perDay: 0, confidence: 0 };
    const risks = computeBatchRisks(list, v.perDay, v.confidence);
    for (const b of list) {
      const risk = risks.get(b.id);
      if (risk) atRiskValue += fromMilli(risk.atRiskMilli) * b.unitCost;
    }
  }

  let lowStockCount = 0;
  for (const pair of snap.tracked) {
    const [productId, locationId] = pair.split('|');
    if (!productId || !locationId || !inScope(locationId)) continue;
    const product = snap.products.get(productId);
    const location = snap.locations.get(locationId);
    if (!product?.isActive || !location?.isActive || product.minStock <= 0) continue;
    const available = fromMilli(snap.stock.get(pair)?.availableMilli ?? 0);
    if (available <= product.minStock) lowStockCount += 1;
  }

  const summary: StockSummary = { stockValue, expiringSoonValue, expiringSoonBatches, expiredValue, expiredBatches, atRiskValue, lowStockCount, buckets };
  if (byScope.size >= MAX_SUMMARIES_PER_SNAPSHOT) byScope.clear();
  byScope.set(key, summary);
  return summary;
}

export async function getDashboard(deps: Deps, principal: Principal, requestedLocation?: string): Promise<DashboardDto> {
  const allowed = locationFilter(principal);
  if (requestedLocation) assertLocation(principal, requestedLocation);
  const scopeIds = requestedLocation ? [requestedLocation] : allowed;

  const snap = await getSnapshot(deps, allowed);
  const { today } = snap;
  const {
    stockValue,
    expiringSoonValue,
    expiringSoonBatches,
    expiredValue,
    expiredBatches,
    atRiskValue,
    lowStockCount,
    buckets: bucketTotals,
  } = summarize(snap, scopeIds);

  const tz = deps.config.businessTz;
  const from = addDays(today, -(TREND_DAYS - 1));
  const scopeSql = scopeIds ? sql`AND location_id IN (${inList(scopeIds.length ? scopeIds : ['00000000-0000-0000-0000-000000000000'])})` : sql``;

  const owners = principal.orgId ? [principal.orgId] : undefined;
  const { losses, revenue } = await cachedAggregate(deps, `dashboard|${scopeKey(scopeIds)}`, async () => {
    const lossRows = await sql<{ day: string; reason: WriteoffReason; value: string }>`
      SELECT (created_at AT TIME ZONE ${tz})::date::text AS day, reason, SUM(-quantity * unit_cost) AS value
      FROM stock_movements
      WHERE type IN ('writeoff', 'adjustment_out')
        AND reason IS NOT NULL
        AND (created_at AT TIME ZONE ${tz})::date >= ${from}::date
        ${scopeSql}
      GROUP BY 1, 2`.execute(deps.db);
    const revenueRow = await sql<{ value: string | null }>`
      SELECT SUM(-quantity * unit_price) AS value
      FROM stock_movements
      WHERE type = 'sale' AND unit_price IS NOT NULL
        AND (created_at AT TIME ZONE ${tz})::date >= ${from}::date
        ${scopeSql}`.execute(deps.db);
    return { losses: lossRows.rows, revenue: Number(revenueRow.rows[0]?.value ?? 0) };
  }, owners);

  const trendByDay = new Map<string, WriteoffTrendPoint>();
  for (let i = 0; i < TREND_DAYS; i += 1) {
    const date = addDays(from, i);
    trendByDay.set(date, { date, expired: 0, spoiled: 0, other: 0 });
  }
  const byReason = new Map<WriteoffReason, number>();
  let writeoff30dValue = 0;
  for (const r of losses) {
    const value = Number(r.value);
    writeoff30dValue += value;
    byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + value);
    const point = trendByDay.get(r.day);
    if (!point) continue;
    if (r.reason === 'expired') point.expired += value;
    else if (r.reason === 'spoiled' || r.reason === 'damaged') point.spoiled += value;
    else point.other += value;
  }

  const recs = recommendationsFrom(snap, { locationIds: scopeIds, types: ['writeoff', 'discount', 'transfer'] }).items;
  const stopList = await getStopList(deps, scopeIds, snap);

  return {
    asOf: deps.clock().toISOString(),
    locationId: requestedLocation ?? null,
    kpis: {
      stockValue: roundMoney(stockValue),
      expiringSoonValue: roundMoney(expiringSoonValue),
      expiringSoonBatches,
      expiredValue: roundMoney(expiredValue),
      expiredBatches,
      atRiskValue: roundMoney(atRiskValue),
      stopListCount: stopList.entries.length,
      lowStockCount,
      writeoff30dValue: roundMoney(writeoff30dValue),
      revenue30d: roundMoney(revenue),
    },
    expiryBuckets: BUCKETS.map((b) => ({
      key: b.key,
      label: b.label,
      value: roundMoney(bucketTotals.get(b.key)?.value ?? 0),
      batches: bucketTotals.get(b.key)?.batches ?? 0,
    })),
    writeoffTrend: [...trendByDay.values()].map((p) => ({
      date: p.date,
      expired: roundMoney(p.expired),
      spoiled: roundMoney(p.spoiled),
      other: roundMoney(p.other),
    })),
    writeoffByReason: [...byReason]
      .map(([reason, value]) => ({ reason, value: roundMoney(value) }))
      .sort((a, b) => b.value - a.value),
    topRisks: recs.slice(0, 6),
    hotDishes: hotDishesFrom(snap, stopList, scopeIds, businessHour(deps)).slice(0, 5),
    stopList: stopList.entries.slice(0, 8),
  };
}

const RESCUED_TOP = 8;

/** Сколько выручили с товара, который продали по скидке, пока не истёк срок. Скидка считается действующей на момент продажи. */
export async function getRescuedStats(deps: Deps, principal: Principal, requestedLocation: string | undefined, days: number): Promise<RescuedStatsDto> {
  const allowed = locationFilter(principal);
  if (requestedLocation) assertLocation(principal, requestedLocation);
  const scopeIds = requestedLocation ? [requestedLocation] : allowed;
  const now = deps.clock();
  const from = new Date(now.getTime() - days * 86_400_000);
  const scope = scopeIds ? sql`AND m.location_id IN (${inList(scopeIds.length ? scopeIds : NO_SCOPE)})` : sql``;

  const rows = await sql<{ product_id: string; name: string; unit: Unit; qty: string; revenue: string; cost: string; discount: string; batches: string }>`
    SELECT m.product_id, p.name, p.unit,
           sum(-m.quantity) AS qty,
           sum(-m.quantity * m.unit_price) AS revenue,
           sum(-m.quantity * m.unit_cost) AS cost,
           sum(-m.quantity * greatest(p.price - m.unit_price, 0)) AS discount,
           count(DISTINCT m.batch_id) AS batches
    FROM stock_movements m
    JOIN products p ON p.id = m.product_id
    WHERE m.type = 'sale' AND m.dish_id IS NULL AND m.unit_price IS NOT NULL
      AND m.created_at >= ${from}::timestamptz AND m.created_at <= ${now}::timestamptz
      AND EXISTS (
        SELECT 1 FROM promotions pr
        WHERE pr.batch_id = m.batch_id AND pr.created_at <= m.created_at AND (pr.cancelled_at IS NULL OR pr.cancelled_at > m.created_at)
      )
      ${scope}
    GROUP BY m.product_id, p.name, p.unit`.execute(deps.db);

  const products: RescuedProductDto[] = rows.rows
    .map((r) => ({ productId: r.product_id, productName: r.name, unit: r.unit, quantity: Math.round(Number(r.qty) * 1000) / 1000, revenue: roundMoney(Number(r.revenue)), cost: roundMoney(Number(r.cost)) }))
    .sort((a, b) => b.revenue - a.revenue);
  return {
    days,
    revenue: roundMoney(rows.rows.reduce((sum, r) => sum + Number(r.revenue), 0)),
    cost: roundMoney(rows.rows.reduce((sum, r) => sum + Number(r.cost), 0)),
    discountGiven: roundMoney(rows.rows.reduce((sum, r) => sum + Number(r.discount), 0)),
    batches: rows.rows.reduce((sum, r) => sum + Number(r.batches), 0),
    products: products.slice(0, RESCUED_TOP),
  };
}

const NO_SCOPE = ['00000000-0000-0000-0000-000000000000'];
const SHORTAGES_LIMIT = 10;

/** Самые дефицитные ингредиенты за период: сколько времени не давали готовить блюда и сколько заказов из-за них отклонено. */
export async function getShortageStats(deps: Deps, principal: Principal, requestedLocation: string | undefined, days: number): Promise<ShortageStatsDto> {
  const allowed = locationFilter(principal);
  if (requestedLocation) assertLocation(principal, requestedLocation);
  const scopeIds = requestedLocation ? [requestedLocation] : allowed;
  const now = deps.clock();
  const from = new Date(now.getTime() - days * 86_400_000);
  const scoped = (column: string) => (scopeIds ? sql`AND ${sql.raw(column)} IN (${inList(scopeIds.length ? scopeIds : NO_SCOPE)})` : sql``);

  const episodes = await sql<{ product_id: string; name: string; unit: Unit; episodes: string; hours: string; dishes: number; ongoing: boolean }>`
    SELECT e.product_id, p.name, p.unit, count(*) AS episodes,
           sum(extract(epoch FROM (least(coalesce(e.ended_at, ${now}::timestamptz), ${now}::timestamptz) - greatest(e.started_at, ${from}::timestamptz))) / 3600.0) AS hours,
           max(e.dishes_blocked) AS dishes, bool_or(e.ended_at IS NULL) AS ongoing
    FROM shortage_episodes e
    JOIN products p ON p.id = e.product_id
    WHERE e.started_at <= ${now}::timestamptz AND coalesce(e.ended_at, ${now}::timestamptz) > ${from}::timestamptz ${scoped('e.location_id')}
    GROUP BY e.product_id, p.name, p.unit`.execute(deps.db);

  const refusals = await sql<{ product_id: string; orders: string; lost: string }>`
    SELECT m AS product_id, count(*) AS orders, sum(r.order_total) AS lost
    FROM sale_refusals r
    CROSS JOIN LATERAL unnest(r.missing) AS m
    WHERE r.created_at >= ${from}::timestamptz AND r.created_at <= ${now}::timestamptz ${scoped('r.location_id')}
    GROUP BY m`.execute(deps.db);
  const refusalTotals = await sql<{ orders: string; lost: string | null }>`
    SELECT count(*) AS orders, sum(r.order_total) AS lost
    FROM sale_refusals r
    WHERE r.created_at >= ${from}::timestamptz AND r.created_at <= ${now}::timestamptz ${scoped('r.location_id')}`.execute(deps.db);

  const refusalBy = new Map(refusals.rows.map((r) => [r.product_id, { orders: Number(r.orders), lost: Number(r.lost) }]));
  const byProduct = new Map<string, ShortageIngredientDto>();
  for (const e of episodes.rows) {
    const refused = refusalBy.get(e.product_id);
    byProduct.set(e.product_id, {
      productId: e.product_id,
      productName: e.name,
      unit: e.unit,
      episodes: Number(e.episodes),
      hours: Math.round(Number(e.hours) * 10) / 10,
      dishesBlocked: Number(e.dishes),
      refusedOrders: refused?.orders ?? 0,
      lostRevenue: roundMoney(refused?.lost ?? 0),
      ongoing: e.ongoing,
    });
  }
  // продукт мог не дойти до остановки блюда, но уже срывать заказы
  const onlyRefused = [...refusalBy.keys()].filter((id) => !byProduct.has(id));
  if (onlyRefused.length > 0) {
    const rows = await deps.db.selectFrom('products').select(['id', 'name', 'unit']).where('id', 'in', onlyRefused).execute();
    for (const p of rows) {
      const refused = refusalBy.get(p.id) as { orders: number; lost: number };
      byProduct.set(p.id, { productId: p.id, productName: p.name, unit: p.unit, episodes: 0, hours: 0, dishesBlocked: 0, refusedOrders: refused.orders, lostRevenue: roundMoney(refused.lost), ongoing: false });
    }
  }

  const all = [...byProduct.values()];
  return {
    days,
    ingredients: all.sort((a, b) => b.hours - a.hours || b.refusedOrders - a.refusedOrders || a.productName.localeCompare(b.productName, 'ru')).slice(0, SHORTAGES_LIMIT),
    totals: {
      episodes: all.reduce((sum, i) => sum + i.episodes, 0),
      hours: Math.round(all.reduce((sum, i) => sum + i.hours, 0) * 10) / 10,
      refusedOrders: Number(refusalTotals.rows[0]?.orders ?? 0),
      lostRevenue: roundMoney(Number(refusalTotals.rows[0]?.lost ?? 0)),
    },
  };
}

export async function getForecast(deps: Deps, principal: Principal, productId: string, locationId: string): Promise<ForecastDto> {
  assertLocation(principal, locationId);
  const snap = await getSnapshot(deps, [locationId]);
  const product = snap.products.get(productId);
  if (!product) throw notFound('Продукт');

  const key = stockKey(productId, locationId);
  const velocity = snap.velocities.get(key) ?? { perDay: 0, confidence: 0 };
  const list = snap.batches.filter((b) => b.productId === productId && b.locationId === locationId);
  const risks = computeBatchRisks(list, velocity.perDay, velocity.confidence);
  const available = fromMilli(snap.stock.get(key)?.availableMilli ?? 0);

  const tz = deps.config.businessTz;
  const from = addDays(snap.today, -28);
  const rows = await sql<{ day: string; qty: string }>`
    SELECT (created_at AT TIME ZONE ${tz})::date::text AS day, SUM(-quantity) AS qty
    FROM stock_movements
    WHERE type IN ('sale', 'transfer_out') AND product_id = ${productId}::uuid AND location_id = ${locationId}::uuid
      AND (created_at AT TIME ZONE ${tz})::date >= ${from}::date
    GROUP BY 1`.execute(deps.db);
  const byDay = new Map(rows.rows.map((r) => [r.day, Number(r.qty)]));
  const history = Array.from({ length: 28 }, (_, i) => {
    const date = addDays(from, i);
    return { date, qty: byDay.get(date) ?? 0 };
  });

  return {
    productId,
    productName: product.name,
    unit: product.unit,
    locationId,
    velocityPerDay: Math.round(velocity.perDay * 1000) / 1000,
    confidence: Math.round(velocity.confidence * 100) / 100,
    available,
    daysToZero: velocity.perDay > 0 ? Math.round((available / velocity.perDay) * 10) / 10 : null,
    history,
    batches: list
      .sort((a, b) => (a.expiresOn < b.expiresOn ? -1 : 1))
      .map((b) => ({
        batchId: b.id,
        expiresOn: b.expiresOn,
        daysLeft: b.daysLeft,
        remaining: fromMilli(b.remainingMilli),
        atRisk: fromMilli(risks.get(b.id)?.atRiskMilli ?? 0),
      })),
  };
}
