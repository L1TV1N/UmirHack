import { addDays, daysBetween, toMilli, type SettingsBody } from '@zapas/shared';
import type { Db } from '../../db/client';
import { hubFor } from '../../lib/events';
import { SnapshotCache } from '../../lib/snapshot-cache';
import { sql } from 'kysely';
import { observedDays, velocityFromWeightedSum } from '../../domain/forecast';
import type { RecBatch, RecDish, RecLocation, RecProduct, RecVelocity } from '../../domain/recommendations';
import { stockKey, type StockPoint } from '../../domain/stoplist';
import type { Deps } from '../../lib/context';
import { businessToday } from '../../lib/time';
import { getSettings } from '../settings/settings';

export interface SnapshotProduct extends RecProduct {
  sku: string;
  sellable: boolean;
}

export interface SnapshotDish extends RecDish {
  price: number;
}

export interface Snapshot {
  /** Порядковый номер загрузки: у более свежих данных он больше. */
  seq: number;
  today: string;
  settings: SettingsBody;
  locations: Map<string, RecLocation>;
  products: Map<string, SnapshotProduct>;
  batches: RecBatch[];
  /** Пары productId|locationId, для которых когда-либо была партия. */
  tracked: Set<string>;
  dishes: SnapshotDish[];
  velocities: Map<string, RecVelocity>;
  /** Сколько порций блюда продаётся в сутки: ключи dishId|locationId. */
  dishDemand: Map<string, RecVelocity>;
  stock: Map<string, StockPoint>;
}

const NO_ROWS = ['00000000-0000-0000-0000-000000000000'];

let loads = 0;

/**
 * Единый срез данных для рекомендаций, стоп-листа и панели. ids = null означает все точки.
 */
export async function loadSnapshot(deps: Deps, locationIds: string[] | null): Promise<Snapshot> {
  const { db } = deps;
  const seq = (loads += 1);
  const today = businessToday(deps);
  const settings = await getSettings(db);
  const scope = locationIds === null ? null : locationIds.length ? locationIds : NO_ROWS;

  const locationRows = await db
    .selectFrom('locations')
    .select(['id', 'name', 'kind', 'is_active'])
    .$if(scope !== null, (qb) => qb.where('id', 'in', scope as string[]))
    .execute();
  const locations = new Map<string, RecLocation>(
    locationRows.map((l) => [l.id, { id: l.id, name: l.name, kind: l.kind, isActive: l.is_active }]),
  );

  const productRows = await db
    .selectFrom('products')
    .select(['id', 'sku', 'name', 'unit', 'price', 'cost', 'min_stock', 'sellable', 'is_active'])
    .execute();
  const products = new Map<string, SnapshotProduct>(
    productRows.map((p) => [
      p.id,
      {
        id: p.id,
        sku: p.sku,
        name: p.name,
        unit: p.unit,
        price: Number(p.price),
        cost: Number(p.cost),
        minStock: Number(p.min_stock),
        sellable: p.sellable,
        isActive: p.is_active,
      },
    ]),
  );

  const batchRows = await db
    .selectFrom('batches as b')
    .leftJoin('promotions as pr', (join) =>
      join
        .onRef('pr.batch_id', '=', 'b.id')
        .on('pr.cancelled_at', 'is', null)
        .on(sql<boolean>`pr.ends_on >= ${today}::date`),
    )
    .select([
      'b.id',
      'b.product_id',
      'b.location_id',
      'b.remaining_qty',
      'b.expires_on',
      'b.received_on',
      'b.unit_cost',
      'pr.percent as promo_percent',
    ])
    .where('b.remaining_qty', '>', '0')
    .$if(scope !== null, (qb) => qb.where('b.location_id', 'in', scope as string[]))
    .execute();

  const batches: RecBatch[] = batchRows.map((r) => ({
    id: r.id,
    productId: r.product_id,
    locationId: r.location_id,
    remainingMilli: toMilli(Number(r.remaining_qty)),
    expiresOn: r.expires_on,
    receivedOn: r.received_on,
    daysLeft: daysBetween(today, r.expires_on),
    unitCost: Number(r.unit_cost),
    promoPercent: r.promo_percent,
  }));

  const stock = new Map<string, StockPoint>();
  for (const b of batches) {
    const key = stockKey(b.productId, b.locationId);
    const point = stock.get(key) ?? { onHandMilli: 0, availableMilli: 0 };
    point.onHandMilli += b.remainingMilli;
    if (b.daysLeft >= 0) point.availableMilli += b.remainingMilli;
    stock.set(key, point);
  }

  const pairRows = await db
    .selectFrom('batches')
    .select(['product_id', 'location_id', sql<string>`min(received_on)`.as('since')])
    .$if(scope !== null, (qb) => qb.where('location_id', 'in', scope as string[]))
    .groupBy(['product_id', 'location_id'])
    .execute();
  const tracked = new Set(pairRows.map((r) => stockKey(r.product_id, r.location_id)));

  // Скорость считаем в базе: одна строка на позицию вместо одной строки на каждые сутки.
  // Условие по created_at, а не по дате, чтобы работал индекс. Сегодняшние сутки не берём, они не закончились.
  const tz = deps.config.businessTz;
  const from = addDays(today, -settings.forecastWindowDays);
  const sums = await sql<{ product_id: string; location_id: string; wsum: string }>`
    SELECT product_id, location_id,
           SUM(-quantity * CASE WHEN (${today}::date - 1) - (created_at AT TIME ZONE ${tz})::date < 7 THEN 2 ELSE 1 END) AS wsum
    FROM stock_movements
    WHERE type IN ('sale', 'transfer_out')
      AND created_at >= ((${from}::date)::timestamp AT TIME ZONE ${tz})
      AND created_at < ((${today}::date)::timestamp AT TIME ZONE ${tz})
      ${scope !== null ? sql`AND location_id IN (${sql.join(scope.map((id) => sql`${id}::uuid`))})` : sql``}
    GROUP BY product_id, location_id`.execute(db);
  const weighted = new Map(sums.rows.map((r) => [stockKey(r.product_id, r.location_id), Number(r.wsum)]));

  const velocities = new Map<string, RecVelocity>();
  for (const r of pairRows) {
    const key = stockKey(r.product_id, r.location_id);
    const v = velocityFromWeightedSum(weighted.get(key) ?? 0, observedDays(today, settings.forecastWindowDays, r.since));
    velocities.set(key, { perDay: v.perDay, confidence: v.confidence });
  }

  // Поправка на день недели, праздники, погоду и акции: её раз в час считает прогноз спроса, здесь только читаем
  if (settings.useDemandModel) {
    const outlook = await db
      .selectFrom('demand_outlook')
      .select(['product_id', 'location_id', 'factor'])
      .where('computed_for', '=', today)
      .$if(scope !== null, (qb) => qb.where('location_id', 'in', scope as string[]))
      .execute();
    for (const o of outlook) {
      const key = stockKey(o.product_id, o.location_id);
      const v = velocities.get(key);
      if (v) velocities.set(key, { perDay: v.perDay * Number(o.factor), confidence: v.confidence });
    }
  }

  const dishRows = await db.selectFrom('dishes').select(['id', 'name', 'price']).where('is_active', '=', true).execute();
  const itemRows = dishRows.length
    ? await db
        .selectFrom('dish_items')
        .select(['dish_id', 'product_id', 'quantity'])
        .where('dish_id', 'in', dishRows.map((d) => d.id))
        .execute()
    : [];
  const dishes: SnapshotDish[] = dishRows.map((d) => ({
    id: d.id,
    name: d.name,
    price: Number(d.price),
    items: itemRows.filter((i) => i.dish_id === d.id).map((i) => ({ productId: i.product_id, qtyMilli: toMilli(Number(i.quantity)) })),
  }));

  // Порции блюд: по расходу ингредиентов под этим блюдом. Через каждый ингредиент выходит одно и то же число порций,
  // берём середину, чтобы случайная правка рецептуры одного продукта не искажала результат
  const dishDemand = new Map<string, RecVelocity>();
  if (dishes.length > 0) {
    const dishSums = await sql<{ dish_id: string; location_id: string; product_id: string; wsum: string }>`
      SELECT dish_id, location_id, product_id,
             SUM(-quantity * CASE WHEN (${today}::date - 1) - (created_at AT TIME ZONE ${tz})::date < 7 THEN 2 ELSE 1 END) AS wsum
      FROM stock_movements
      WHERE type = 'sale' AND dish_id IS NOT NULL
        AND created_at >= ((${from}::date)::timestamp AT TIME ZONE ${tz})
        AND created_at < ((${today}::date)::timestamp AT TIME ZONE ${tz})
        ${scope !== null ? sql`AND location_id IN (${sql.join(scope.map((id) => sql`${id}::uuid`))})` : sql``}
      GROUP BY dish_id, location_id, product_id`.execute(db);
    const recipe = new Map<string, number>();
    for (const d of dishes) for (const i of d.items) recipe.set(`${d.id}|${i.productId}`, (recipe.get(`${d.id}|${i.productId}`) ?? 0) + i.qtyMilli / 1000);
    const since = new Map(pairRows.map((r) => [stockKey(r.product_id, r.location_id), String(r.since)]));
    const perDish = new Map<string, { portions: number[]; since: string | null }>();
    for (const r of dishSums.rows) {
      const perPortion = recipe.get(`${r.dish_id}|${r.product_id}`);
      if (!perPortion) continue;
      const key = `${r.dish_id}|${r.location_id}`;
      const entry = perDish.get(key) ?? { portions: [], since: null };
      entry.portions.push(Number(r.wsum) / perPortion);
      const first = since.get(stockKey(r.product_id, r.location_id)) ?? null;
      if (first && (!entry.since || first < entry.since)) entry.since = first;
      perDish.set(key, entry);
    }
    for (const [key, e] of perDish) {
      const sorted = [...e.portions].sort((a, b) => a - b);
      const mid = sorted[Math.floor(sorted.length / 2)] ?? 0;
      const v = velocityFromWeightedSum(mid, observedDays(today, settings.forecastWindowDays, e.since));
      dishDemand.set(key, { perDay: v.perDay, confidence: v.confidence });
    }
  }

  return { seq, today, settings, locations, products, batches, tracked, dishes, velocities, dishDemand, stock };
}

const MAX_SCOPES_PER_SNAPSHOT = 16;
const restricted = new WeakMap<Snapshot, Map<string, Snapshot>>();

export const scopeKey = (ids: string[] | null): string => (ids === null ? '*' : [...ids].sort().join(','));

/**
 * Оставляет в срезе только указанные точки. Для одного среза и одного набора точек результат один и тот же
 * объект: на нём держатся запомненные расчёты (стоп-лист, рекомендации).
 */
export function restrictSnapshot(snap: Snapshot, ids: string[] | null): Snapshot {
  if (ids === null) return snap;
  const key = scopeKey(ids);
  let byScope = restricted.get(snap);
  if (!byScope) {
    byScope = new Map();
    restricted.set(snap, byScope);
  }
  const known = byScope.get(key);
  if (known) return known;

  const keep = new Set(ids);
  const inScope = (k: string) => keep.has(k.split('|')[1] as string);
  const pick = <T,>(m: Map<string, T>) => new Map([...m].filter(([k]) => inScope(k)));
  const narrowed: Snapshot = {
    ...snap,
    locations: new Map([...snap.locations].filter(([id]) => keep.has(id))),
    batches: snap.batches.filter((b) => keep.has(b.locationId)),
    tracked: new Set([...snap.tracked].filter(inScope)),
    velocities: pick(snap.velocities),
    stock: pick(snap.stock),
  };
  if (byScope.size >= MAX_SCOPES_PER_SNAPSHOT) byScope.clear();
  byScope.set(key, narrowed);
  return narrowed;
}

const caches = new WeakMap<Db, SnapshotCache<Snapshot>>();

function cacheFor(db: Db): SnapshotCache<Snapshot> {
  let c = caches.get(db);
  if (!c) {
    c = new SnapshotCache<Snapshot>({ ttlMs: 20_000, heavyMs: 250, maxEntries: 8 });
    caches.set(db, c);
  }
  return c;
}

const aggregates = new WeakMap<Db, SnapshotCache<unknown>>();

/**
 * Небольшие запросы-агрегаты панели (потери и выручка за 30 дней). Параллельные запросы делят один расчёт,
 * а любая запись сбрасывает его так же, как срез: после операции человек видит свежие цифры.
 */
export function cachedAggregate<T>(deps: Deps, key: string, load: () => Promise<T>): Promise<T> {
  let c = aggregates.get(deps.db);
  if (!c) {
    c = new SnapshotCache<unknown>({ ttlMs: 20_000, heavyMs: Number.POSITIVE_INFINITY, maxEntries: 32 });
    aggregates.set(deps.db, c);
  }
  return c.get(`${businessToday(deps)}|${key}`, load) as Promise<T>;
}

/** Любая запись, которая могла изменить остатки, цены, рецептуры или настройки. */
export function invalidateSnapshots(db: Db): void {
  cacheFor(db).invalidate();
  aggregates.get(db)?.invalidate();
  hubFor(db).publish();
}

/**
 * Срез из кеша (см. SnapshotCache). fresh: true требует данных не старше этого вызова: так делает фоновый
 * пересчёт стоп-листа после продаж с кассы, которые кеш намеренно не сбрасывают.
 */
export function getSnapshot(deps: Deps, locationIds: string[] | null, options: { fresh?: boolean } = {}): Promise<Snapshot> {
  const key = `${businessToday(deps)}|${scopeKey(locationIds)}`;
  return cacheFor(deps.db).get(key, () => loadSnapshot(deps, locationIds), options.fresh === true);
}
