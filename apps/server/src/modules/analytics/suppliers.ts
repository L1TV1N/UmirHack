import { addDays, roundMoney, type SupplierRatingDto, type SupplierScoreDto, type WriteoffReason } from '@zapas/shared';
import { sql } from 'kysely';
import { supplierScore } from '../../domain/supplier-score';
import type { Deps, Principal } from '../../lib/context';
import { assertLocation, locationFilter } from '../../lib/scope';
import { businessToday } from '../../lib/time';

const NO_SCOPE = ['00000000-0000-0000-0000-000000000000'];
const inList = (ids: string[]) => sql`${sql.join(ids.map((id) => sql`${id}::uuid`))}`;
const round3 = (v: number) => Math.round(v * 1000) / 1000;

interface Acc {
  orders: number;
  timed: number;
  onTime: number;
  delay: number | null;
  ordered: number;
  received: number;
  receivedValue: number;
  freshWeighted: number;
  freshBase: number;
  losses: Map<WriteoffReason, number>;
}

const empty = (): Acc => ({ orders: 0, timed: 0, onTime: 0, delay: null, ordered: 0, received: 0, receivedValue: 0, freshWeighted: 0, freshBase: 0, losses: new Map() });

/**
 * Рейтинг поставщиков за период. Заказы берутся отправленные, срок которых уже наступил: сколько привезли от заказанного
 * и вовремя ли пришла первая поставка. Свежесть это доля срока годности, что оставалась при приёмке. Потери считаются
 * по партиям поставщика, списанным за период.
 */
export async function getSupplierRating(deps: Deps, principal: Principal, requestedLocation: string | undefined, days: number): Promise<SupplierRatingDto> {
  const allowed = locationFilter(principal);
  if (requestedLocation) assertLocation(principal, requestedLocation);
  const scopeIds = requestedLocation ? [requestedLocation] : allowed;
  const now = deps.clock();
  const from = new Date(now.getTime() - days * 86_400_000);
  const today = businessToday(deps);
  const fromDay = addDays(today, -days);
  const tz = deps.config.businessTz;
  const scoped = (column: string) => (scopeIds ? sql`AND ${sql.raw(column)} IN (${inList(scopeIds.length ? scopeIds : NO_SCOPE)})` : sql``);

  const orders = await sql<{ supplier_id: string; orders: string; timed: string; on_time: string; delay: string | null; ordered: string | null; received: string | null }>`
    WITH due AS (
      SELECT o.id, o.supplier_id, o.expected_on,
             (SELECT min((d.created_at AT TIME ZONE ${tz})::date) FROM documents d WHERE d.order_id = o.id) AS first_on
      FROM purchase_orders o
      WHERE o.status IN ('sent', 'partial', 'received')
        AND o.sent_at >= ${from}::timestamptz AND o.sent_at <= ${now}::timestamptz
        AND (o.status = 'received' OR o.expected_on IS NULL OR o.expected_on < ${today}::date)
        ${scoped('o.location_id')}
    ), money AS (
      SELECT due.supplier_id, sum(l.quantity * l.unit_cost) AS ordered, sum(least(l.received_qty, l.quantity) * l.unit_cost) AS received
      FROM due JOIN purchase_order_lines l ON l.order_id = due.id
      GROUP BY due.supplier_id
    ), timing AS (
      SELECT supplier_id, count(*) AS orders,
             count(*) FILTER (WHERE expected_on IS NOT NULL) AS timed,
             count(*) FILTER (WHERE expected_on IS NOT NULL AND first_on IS NOT NULL AND first_on <= expected_on) AS on_time,
             avg(greatest(coalesce(first_on, ${today}::date) - expected_on, 0)) FILTER (WHERE expected_on IS NOT NULL) AS delay
      FROM due
      GROUP BY supplier_id
    )
    SELECT t.supplier_id, t.orders, t.timed, t.on_time, t.delay, m.ordered, m.received
    FROM timing t LEFT JOIN money m ON m.supplier_id = t.supplier_id`.execute(deps.db);

  // перемещения тоже создают партии с тем же поставщиком, а приёмкой считается только документ прихода
  const receipts = await sql<{ supplier_id: string; received_value: string; fresh_w: string | null; fresh_base: string | null }>`
    SELECT b.supplier_id, sum(b.initial_qty * b.unit_cost) AS received_value,
           sum(b.initial_qty * b.unit_cost * least(greatest((b.expires_on - b.received_on)::numeric / p.shelf_life_days, 0), 1)) FILTER (WHERE p.shelf_life_days IS NOT NULL) AS fresh_w,
           sum(b.initial_qty * b.unit_cost) FILTER (WHERE p.shelf_life_days IS NOT NULL) AS fresh_base
    FROM batches b
    JOIN documents d ON d.id = b.origin_document_id AND d.kind = 'receipt'
    JOIN products p ON p.id = b.product_id
    WHERE b.supplier_id IS NOT NULL AND b.received_on >= ${fromDay}::date AND b.received_on <= ${today}::date ${scoped('b.location_id')}
    GROUP BY b.supplier_id`.execute(deps.db);

  const losses = await sql<{ supplier_id: string | null; reason: WriteoffReason; value: string }>`
    SELECT b.supplier_id, m.reason, sum(-m.quantity * m.unit_cost) AS value
    FROM stock_movements m
    JOIN batches b ON b.id = m.batch_id
    WHERE m.type IN ('writeoff', 'adjustment_out') AND m.reason IS NOT NULL
      AND m.created_at >= ${from}::timestamptz AND m.created_at <= ${now}::timestamptz ${scoped('m.location_id')}
    GROUP BY b.supplier_id, m.reason`.execute(deps.db);

  const acc = new Map<string, Acc>();
  const of = (id: string): Acc => {
    let a = acc.get(id);
    if (!a) {
      a = empty();
      acc.set(id, a);
    }
    return a;
  };
  for (const r of orders.rows) {
    Object.assign(of(r.supplier_id), { orders: Number(r.orders), timed: Number(r.timed), onTime: Number(r.on_time), delay: r.delay === null ? null : Number(r.delay), ordered: Number(r.ordered ?? 0), received: Number(r.received ?? 0) });
  }
  for (const r of receipts.rows) Object.assign(of(r.supplier_id), { receivedValue: Number(r.received_value), freshWeighted: Number(r.fresh_w ?? 0), freshBase: Number(r.fresh_base ?? 0) });

  const byReason = new Map<WriteoffReason, number>();
  for (const r of losses.rows) {
    const value = Number(r.value);
    byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + value);
    if (r.supplier_id) {
      const a = of(r.supplier_id);
      a.losses.set(r.reason, (a.losses.get(r.reason) ?? 0) + value);
    }
  }

  const names = acc.size ? await deps.db.selectFrom('suppliers').select(['id', 'name']).where('id', 'in', [...acc.keys()]).execute() : [];
  const nameOf = new Map(names.map((s) => [s.id, s.name]));

  const suppliers: SupplierScoreDto[] = [...acc].map(([id, a]) => {
    const spoiled = (a.losses.get('spoiled') ?? 0) + (a.losses.get('damaged') ?? 0);
    const fillRate = a.ordered > 0 ? Math.min(1, a.received / a.ordered) : null;
    const onTimeRate = a.timed > 0 ? a.onTime / a.timed : null;
    const freshness = a.freshBase > 0 ? a.freshWeighted / a.freshBase : null;
    const spoilageRate = a.receivedValue > 0 ? spoiled / a.receivedValue : null;
    const { score, grade } = supplierScore({ fillRate, onTimeRate, freshness, spoilageRate });
    const lossList = [...a.losses].map(([reason, value]) => ({ reason, value: roundMoney(value) })).sort((x, y) => y.value - x.value);
    return {
      supplierId: id,
      supplierName: nameOf.get(id) ?? 'Поставщик',
      score,
      grade,
      orders: a.orders,
      fillRate: fillRate === null ? null : round3(fillRate),
      onTimeRate: onTimeRate === null ? null : round3(onTimeRate),
      avgDelayDays: a.delay === null ? null : Math.round(a.delay * 10) / 10,
      freshness: freshness === null ? null : round3(freshness),
      receivedValue: roundMoney(a.receivedValue),
      lossValue: roundMoney(lossList.reduce((sum, l) => sum + l.value, 0)),
      spoilageRate: spoilageRate === null ? null : round3(spoilageRate),
      losses: lossList,
    };
  });
  suppliers.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.supplierName.localeCompare(b.supplierName, 'ru'));

  const lossesByReason = [...byReason].map(([reason, value]) => ({ reason, value: roundMoney(value) })).sort((a, b) => b.value - a.value);
  return { days, suppliers, lossesByReason, totalLoss: roundMoney(lossesByReason.reduce((sum, l) => sum + l.value, 0)) };
}
