import {
  addDays,
  fromMilli,
  roundMoney,
  type DashboardDto,
  type ExpiryBucketDto,
  type ForecastDto,
  type RecommendationsDto,
  type RecommendationType,
  type WriteoffReason,
  type WriteoffTrendPoint,
} from '@zapas/shared';
import { sql } from 'kysely';
import { computeBatchRisks } from '../../domain/risk';
import { draftRecommendations, selectRecommendations, type Draft, type RecommendationFilter, type RecommendationPlan } from '../../domain/recommendations';
import { stockKey } from '../../domain/stoplist';
import type { Deps, Principal } from '../../lib/context';
import { notFound } from '../../lib/errors';
import { assertLocation, locationFilter } from '../../lib/scope';
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

interface StockSummary {
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
function summarize(snap: Snapshot, scopeIds: string[] | null): StockSummary {
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
  });

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
    stopList: stopList.entries.slice(0, 8),
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
