import { ORDER_STATUS_LABELS, type OrderStatus, type PortalOrderPush } from '@zapas/shared';
import type { Transaction } from 'kysely';
import type { Db } from '../../db/client';
import type { Database } from '../../db/types';
import type { Deps } from '../../lib/context';

type Executor = Db | Transaction<Database>;

export async function addOrderEvent(
  db: Executor,
  orderId: string,
  side: 'buyer' | 'supplier',
  status: string,
  text: string,
  actor: string,
  at: Date,
): Promise<void> {
  await db.insertInto('purchase_order_events').values({ order_id: orderId, side, status, text, actor, created_at: at }).execute();
}

/** Заказ в том виде, в каком он виден кабинету поставщика. Черновики туда не уходят. */
export async function buildPush(deps: Deps, orderId: string): Promise<PortalOrderPush | null> {
  const o = await deps.db
    .selectFrom('purchase_orders as o')
    .innerJoin('suppliers as s', 's.id', 'o.supplier_id')
    .innerJoin('locations as l', 'l.id', 'o.location_id')
    .innerJoin('organizations as g', 'g.id', 'l.org_id')
    .select(['o.id', 'o.number', 'o.status', 'o.expected_on', 'o.comment', 'o.total', 'o.buyer_note', 'o.updated_at', 's.inn', 's.name as supplier_name', 'l.name as location_name', 'l.address', 'g.name as org_name'])
    .where('o.id', '=', orderId)
    .executeTakeFirst();
  if (!o || o.status === 'draft' || !o.inn) return null;
  const lines = await deps.db
    .selectFrom('purchase_order_lines as l')
    .innerJoin('products as p', 'p.id', 'l.product_id')
    .select(['p.sku', 'p.name', 'p.unit', 'l.quantity', 'l.unit_cost', 'l.received_qty'])
    .where('l.order_id', '=', orderId)
    .orderBy('p.name')
    .execute();
  return {
    externalId: o.id,
    number: o.number,
    status: o.status,
    statusLabel: ORDER_STATUS_LABELS[o.status as OrderStatus],
    supplierInn: o.inn,
    supplierName: o.supplier_name,
    buyer: { organization: o.org_name, location: o.location_name, address: o.address },
    expectedOn: o.expected_on,
    comment: o.comment,
    total: Number(o.total),
    lines: lines.map((l) => ({ sku: l.sku, name: l.name, unit: l.unit, quantity: Number(l.quantity), unitCost: Number(l.unit_cost), receivedQty: Number(l.received_qty) })),
    buyerNote: o.buyer_note,
    updatedAt: o.updated_at.toISOString(),
  };
}

/**
 * Отправляет заказ в кабинет поставщика. Сбой не отменяет операцию в «Запасе»: причина остаётся в заказе,
 * фоновая задача повторяет отправку. Без настроенного кабинета ничего не делает.
 */
export async function pushOrder(deps: Deps, orderId: string): Promise<void> {
  if (!deps.supplierPortal) return;
  try {
    const payload = await buildPush(deps, orderId);
    if (!payload) {
      await deps.db.updateTable('purchase_orders').set({ portal_error: 'у поставщика не указан ИНН: кабинет не узнает, кому адресован заказ' }).where('id', '=', orderId).execute();
      return;
    }
    const res = await deps.supplierPortal.push(payload);
    await deps.db
      .updateTable('purchase_orders')
      .set(res.ok ? { portal_pushed_at: deps.clock(), portal_error: null } : { portal_error: res.error })
      .where('id', '=', orderId)
      .execute();
  } catch (err) {
    deps.log.error({ err: err instanceof Error ? err.name : 'ошибка' }, 'не удалось передать заказ в кабинет поставщика');
  }
}

/** Повтор для заказов, которые не дошли до кабинета. */
export async function retryPortalPushes(deps: Deps): Promise<number> {
  if (!deps.supplierPortal) return 0;
  const rows = await deps.db
    .selectFrom('purchase_orders')
    .select('id')
    .where('status', '<>', 'draft')
    .where('portal_error', 'is not', null)
    .where('portal_error', 'not like', 'у поставщика не указан ИНН%')
    .orderBy('updated_at')
    .limit(20)
    .execute();
  for (const r of rows) await pushOrder(deps, r.id);
  return rows.length;
}
