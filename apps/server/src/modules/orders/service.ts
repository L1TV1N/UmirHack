import {
  addDays,
  formatMoney,
  type OrderDetailDto,
  type OrderDto,
  type OrderLineDto,
  type OrderSentPayload,
  type OrderStatus,
} from '@zapas/shared';
import { sql, type Transaction } from 'kysely';
import type { Db } from '../../db/client';
import type { Database } from '../../db/types';
import type { Deps, Principal, RequestMeta } from '../../lib/context';
import { badRequest, conflict, notFound, PG_UNIQUE_VIOLATION, pgCode, pgConstraint } from '../../lib/errors';
import { assertLocation } from '../../lib/scope';
import { businessToday } from '../../lib/time';
import { writeAudit } from '../audit/audit';
import { enqueueEvent } from '../integrations/service';
import { escapeHtml } from '../notifications/notifier';
import { describeMailError } from './mailer';
import { suggestOrders } from './suggest';
import { orderText } from './text';

type Executor = Db | Transaction<Database>;
type UserPrincipal = Extract<Principal, { kind: 'user' }>;

const roundMoney = (v: number) => Math.round(v * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;

interface HeaderRow {
  id: string;
  number: string;
  status: OrderStatus;
  supplier_id: string;
  supplier_name: string;
  supplier_email: string | null;
  location_id: string;
  location_name: string;
  location_address: string | null;
  expected_on: string | null;
  comment: string | null;
  total: string;
  created_at: Date;
  created_by_name: string | null;
  sent_at: Date | null;
  closed_at: Date | null;
  emailed_at: Date | null;
  email_error: string | null;
  line_count: string;
}

export const headerSelect = (db: Executor) =>
  db
    .selectFrom('purchase_orders as o')
    .innerJoin('suppliers as s', 's.id', 'o.supplier_id')
    .innerJoin('locations as l', 'l.id', 'o.location_id')
    .leftJoin('users as u', 'u.id', 'o.created_by')
    .select([
      'o.id',
      'o.number',
      'o.status',
      'o.supplier_id',
      's.name as supplier_name',
      's.email as supplier_email',
      'o.location_id',
      'l.name as location_name',
      'l.address as location_address',
      'o.expected_on',
      'o.comment',
      'o.total',
      'o.created_at',
      'u.full_name as created_by_name',
      'o.sent_at',
      'o.closed_at',
      'o.emailed_at',
      'o.email_error',
      sql<string>`(select count(*) from purchase_order_lines x where x.order_id = o.id)`.as('line_count'),
    ]);

export function toOrderDto(r: HeaderRow): OrderDto {
  return {
    id: r.id,
    number: r.number,
    status: r.status,
    supplierId: r.supplier_id,
    supplierName: r.supplier_name,
    supplierEmail: r.supplier_email,
    locationId: r.location_id,
    locationName: r.location_name,
    expectedOn: r.expected_on,
    comment: r.comment,
    total: Number(r.total),
    lines: Number(r.line_count),
    createdAt: r.created_at.toISOString(),
    createdBy: r.created_by_name,
    sentAt: r.sent_at?.toISOString() ?? null,
    closedAt: r.closed_at?.toISOString() ?? null,
    emailedAt: r.emailed_at?.toISOString() ?? null,
    emailError: r.email_error,
  };
}

async function loadItems(db: Executor, orderId: string): Promise<OrderLineDto[]> {
  const rows = await db
    .selectFrom('purchase_order_lines as l')
    .innerJoin('products as p', 'p.id', 'l.product_id')
    .select(['l.product_id', 'p.name', 'p.sku', 'p.unit', 'p.shelf_life_days', 'l.quantity', 'l.unit_cost', 'l.received_qty'])
    .where('l.order_id', '=', orderId)
    .orderBy('p.name')
    .execute();
  return rows.map((r) => ({
    productId: r.product_id,
    productName: r.name,
    sku: r.sku,
    unit: r.unit,
    shelfLifeDays: r.shelf_life_days,
    quantity: Number(r.quantity),
    unitCost: Number(r.unit_cost),
    sum: roundMoney(Number(r.quantity) * Number(r.unit_cost)),
    receivedQty: Number(r.received_qty),
  }));
}

export async function loadOrderDetail(deps: Deps, db: Executor, id: string): Promise<(OrderDetailDto & { locationAddress: string | null }) | null> {
  const row = await headerSelect(db).where('o.id', '=', id).executeTakeFirst();
  if (!row) return null;
  const items = await loadItems(db, id);
  const dto = toOrderDto(row as HeaderRow);
  const text = orderText(
    { number: dto.number, createdAt: row.created_at, supplierName: dto.supplierName, locationName: dto.locationName, locationAddress: row.location_address, expectedOn: dto.expectedOn, comment: dto.comment, total: dto.total, timeZone: deps.config.businessTz },
    items,
  );
  return { ...dto, items, text, locationAddress: row.location_address };
}

export interface DraftLine {
  productId: string;
  quantity: number;
  unitCost: number;
}

async function assertLines(trx: Executor, lines: DraftLine[]): Promise<void> {
  const rows = await trx.selectFrom('products').select(['id', 'name', 'unit', 'is_active']).where('id', 'in', lines.map((l) => l.productId)).execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  lines.forEach((l, i) => {
    const p = byId.get(l.productId);
    if (!p || !p.is_active) throw badRequest('Продукт не найден или отключён', [{ path: ['lines', i, 'productId'], message: 'Недоступен для заказа' }]);
    if (p.unit === 'pcs' && !Number.isInteger(l.quantity)) {
      throw badRequest(`«${p.name}» считается в штуках, укажите целое количество`, [{ path: ['lines', i, 'quantity'], message: 'Нужно целое число' }], 'whole_pieces');
    }
  });
}

async function assertParties(trx: Executor, supplierId: string, locationId: string): Promise<void> {
  const supplier = await trx.selectFrom('suppliers').select('is_active').where('id', '=', supplierId).executeTakeFirst();
  if (!supplier || !supplier.is_active) throw badRequest('Поставщик не найден или отключён', [{ path: ['supplierId'], message: 'Недоступен для заказов' }]);
  const location = await trx.selectFrom('locations').select('is_active').where('id', '=', locationId).executeTakeFirst();
  if (!location || !location.is_active) throw badRequest('Точка не найдена или отключена', [{ path: ['locationId'], message: 'Недоступна' }]);
}

function assertExpected(deps: Deps, expectedOn: string | null | undefined): void {
  if (expectedOn && expectedOn < businessToday(deps)) {
    throw badRequest('Желаемая дата поставки уже прошла', [{ path: ['expectedOn'], message: 'Укажите сегодняшнюю или будущую дату' }]);
  }
}

export interface DraftInput {
  supplierId: string;
  locationId: string;
  expectedOn?: string | null | undefined;
  comment?: string | null | undefined;
  lines: DraftLine[];
  createdBy: string | null;
}

export async function createDraft(deps: Deps, trx: Transaction<Database>, input: DraftInput): Promise<{ id: string; number: string }> {
  const now = deps.clock();
  assertExpected(deps, input.expectedOn);
  await assertParties(trx, input.supplierId, input.locationId);
  await assertLines(trx, input.lines);
  const total = roundMoney(input.lines.reduce((s, l) => s + l.quantity * l.unitCost, 0));
  const row = await trx
    .insertInto('purchase_orders')
    .values({
      number: sql<string>`'ЗК-' || lpad(nextval('purchase_order_seq')::text, 6, '0')`,
      supplier_id: input.supplierId,
      location_id: input.locationId,
      expected_on: input.expectedOn ?? null,
      comment: input.comment ?? null,
      total,
      created_by: input.createdBy,
      created_at: now,
      updated_at: now,
    })
    .returning(['id', 'number'])
    .executeTakeFirstOrThrow();
  await trx.insertInto('purchase_order_lines').values(input.lines.map((l) => ({ order_id: row.id, product_id: l.productId, quantity: l.quantity, unit_cost: l.unitCost }))).execute();
  return row;
}

/** Повторное «создать» на тот же поставщик и точку открывает прежний черновик, а не плодит новые. */
export async function draftExists(db: Executor, err: unknown, supplierId: string, locationId: string): Promise<never | void> {
  if (pgCode(err) === PG_UNIQUE_VIOLATION && pgConstraint(err) === 'purchase_orders_one_draft_key') {
    const existing = await db.selectFrom('purchase_orders').select('id').where('supplier_id', '=', supplierId).where('location_id', '=', locationId).where('status', '=', 'draft').executeTakeFirst();
    throw conflict('На этого поставщика и точку уже есть черновик заказа', existing ? { orderId: existing.id } : undefined, 'draft_exists');
  }
}

export async function updateDraft(
  deps: Deps,
  trx: Transaction<Database>,
  principal: UserPrincipal,
  id: string,
  patch: { expectedOn?: string | null | undefined; comment?: string | null | undefined; lines?: DraftLine[] | undefined },
): Promise<void> {
  const row = await trx.selectFrom('purchase_orders').select(['id', 'status', 'location_id']).where('id', '=', id).forUpdate().executeTakeFirst();
  if (!row) throw notFound('Заказ');
  assertLocation(principal, row.location_id);
  if (row.status !== 'draft') throw conflict('Изменять можно только черновик', undefined, 'order_not_draft');
  assertExpected(deps, patch.expectedOn);
  const now = deps.clock();
  let total: number | undefined;
  if (patch.lines) {
    await assertLines(trx, patch.lines);
    await trx.deleteFrom('purchase_order_lines').where('order_id', '=', id).execute();
    await trx.insertInto('purchase_order_lines').values(patch.lines.map((l) => ({ order_id: id, product_id: l.productId, quantity: l.quantity, unit_cost: l.unitCost }))).execute();
    total = roundMoney(patch.lines.reduce((s, l) => s + l.quantity * l.unitCost, 0));
  }
  await trx
    .updateTable('purchase_orders')
    .set({
      ...(patch.expectedOn !== undefined ? { expected_on: patch.expectedOn } : {}),
      ...(patch.comment !== undefined ? { comment: patch.comment } : {}),
      ...(total !== undefined ? { total } : {}),
      updated_at: now,
    })
    .where('id', '=', id)
    .execute();
  await writeAudit(trx, { action: 'order.update', entity: 'purchase_order', entityId: id, principal, at: now, details: { lines: patch.lines?.length, expectedOn: patch.expectedOn, comment: patch.comment !== undefined } });
}

async function setEmailResult(db: Executor, id: string, at: Date | null, error: string | null): Promise<void> {
  await db.updateTable('purchase_orders').set({ emailed_at: at, email_error: error }).where('id', '=', id).execute();
}

/** Письмо поставщику. Сбой не отменяет заказ: причина остаётся в заказе, письмо можно отправить повторно. */
export async function emailOrder(deps: Deps, id: string, replyTo: string | null): Promise<void> {
  const detail = await loadOrderDetail(deps, deps.db, id);
  if (!detail) return;
  if (!detail.supplierEmail) return setEmailResult(deps.db, id, null, 'у поставщика не указана почта');
  if (!deps.mailer) return setEmailResult(deps.db, id, null, 'отправка почты не настроена на сервере');
  try {
    await deps.mailer.send({ to: detail.supplierEmail, subject: `Заказ ${detail.number} для «${detail.locationName}»`, text: detail.text, ...(replyTo ? { replyTo } : {}) });
    await setEmailResult(deps.db, id, deps.clock(), null);
  } catch (err) {
    deps.log.error({ err: describeMailError(err) }, 'письмо с заказом не отправлено');
    await setEmailResult(deps.db, id, null, describeMailError(err));
  }
}

export async function sendOrder(deps: Deps, principal: UserPrincipal, meta: RequestMeta | null, id: string): Promise<void> {
  const now = deps.clock();
  await deps.db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom('purchase_orders').select(['id', 'number', 'status', 'supplier_id', 'location_id']).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!row) throw notFound('Заказ');
    assertLocation(principal, row.location_id);
    if (row.status !== 'draft') throw conflict('Заказ уже отправлен или закрыт', undefined, 'order_not_draft');
    const lines = await trx
      .selectFrom('purchase_order_lines as l')
      .innerJoin('products as p', 'p.id', 'l.product_id')
      .select(['p.sku', 'p.barcode', 'p.name', 'p.unit', 'p.is_active', 'l.quantity', 'l.unit_cost'])
      .where('l.order_id', '=', id)
      .orderBy('p.name')
      .execute();
    if (lines.length === 0) throw badRequest('В заказе нет строк', undefined, 'empty_order');
    const supplier = await trx.selectFrom('suppliers').select(['id', 'name', 'email', 'is_active']).where('id', '=', row.supplier_id).executeTakeFirstOrThrow();
    if (!supplier.is_active) throw conflict('Поставщик отключён: заказ отправить нельзя', undefined, 'supplier_inactive');
    const location = await trx.selectFrom('locations').select(['id', 'name']).where('id', '=', row.location_id).executeTakeFirstOrThrow();
    const head = await trx.selectFrom('purchase_orders').select(['expected_on', 'comment']).where('id', '=', id).executeTakeFirstOrThrow();
    const total = roundMoney(lines.reduce((s, l) => s + Number(l.quantity) * Number(l.unit_cost), 0));

    await trx.updateTable('purchase_orders').set({ status: 'sent', sent_at: now, sent_by: principal.id, total, updated_at: now }).where('id', '=', id).execute();
    await writeAudit(trx, { action: 'order.send', entity: 'purchase_order', entityId: id, principal, meta, at: now, details: { number: row.number, supplier: supplier.name, locationId: row.location_id, lines: lines.length, total } });

    const payload: OrderSentPayload = {
      event: 'order.sent',
      createdAt: now.toISOString(),
      order: {
        id,
        number: row.number,
        supplier: { id: supplier.id, name: supplier.name, email: supplier.email },
        location: { id: location.id, name: location.name },
        expectedOn: head.expected_on,
        comment: head.comment,
        total,
        lines: lines.map((l) => ({ sku: l.sku, barcode: l.barcode, name: l.name, unit: l.unit, quantity: Number(l.quantity), unitCost: Number(l.unit_cost) })),
      },
    };
    await enqueueEvent(trx, 'order.sent', payload, row.location_id, now);
  });

  await emailOrder(deps, id, principal.email);
  if (deps.notifier.enabled) {
    const d = await loadOrderDetail(deps, deps.db, id);
    if (d) {
      deps.notifier
        .send(`<b>Заказ ${escapeHtml(d.number)} отправлен</b>\nПоставщик: ${escapeHtml(d.supplierName)}\nТочка: ${escapeHtml(d.locationName)}\n${d.lines} поз. на ${escapeHtml(formatMoney(d.total).replace(/ /g, ' '))}`)
        .catch((err) => deps.log.error({ err }, 'уведомление о заказе не отправлено'));
    }
  }
}

export async function cancelOrder(deps: Deps, principal: UserPrincipal, meta: RequestMeta | null, id: string): Promise<void> {
  const now = deps.clock();
  await deps.db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom('purchase_orders').select(['id', 'number', 'status', 'location_id']).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!row) throw notFound('Заказ');
    assertLocation(principal, row.location_id);
    if (row.status === 'partial') throw conflict('Часть заказа уже принята: закройте заказ вместо отмены', undefined, 'order_partial');
    if (row.status !== 'draft' && row.status !== 'sent') throw conflict('Этот заказ уже закрыт', undefined, 'order_closed');
    await trx.updateTable('purchase_orders').set({ status: 'cancelled', closed_at: now, updated_at: now }).where('id', '=', id).execute();
    await writeAudit(trx, { action: 'order.cancel', entity: 'purchase_order', entityId: id, principal, meta, at: now, details: { number: row.number, was: row.status } });
  });
}

/** Поставщик довёз меньше или не довёз: заказ закрывается, недопоставка перестаёт считаться «в пути». */
export async function closeOrder(deps: Deps, principal: UserPrincipal, meta: RequestMeta | null, id: string, comment?: string): Promise<void> {
  const now = deps.clock();
  await deps.db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom('purchase_orders').select(['id', 'number', 'status', 'location_id', 'comment']).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!row) throw notFound('Заказ');
    assertLocation(principal, row.location_id);
    if (row.status !== 'sent' && row.status !== 'partial') throw conflict('Закрыть можно отправленный заказ', undefined, 'order_not_open');
    const note = comment ? `${row.comment ? `${row.comment}\n` : ''}Закрыт: ${comment}` : row.comment;
    await trx.updateTable('purchase_orders').set({ status: 'received', closed_at: now, updated_at: now, comment: note }).where('id', '=', id).execute();
    await writeAudit(trx, { action: 'order.close', entity: 'purchase_order', entityId: id, principal, meta, at: now, details: { number: row.number, was: row.status, comment: comment ?? null } });
  });
}

export interface OrderForReceipt {
  id: string;
  number: string;
  supplierId: string;
}

/** Заказ, по которому идёт приход: должен ждать приёмки на этой же точке и у того же поставщика. */
export async function lockOrderForReceipt(trx: Transaction<Database>, orderId: string, locationId: string, supplierId: string | undefined): Promise<OrderForReceipt> {
  const row = await trx.selectFrom('purchase_orders').select(['id', 'number', 'status', 'supplier_id', 'location_id']).where('id', '=', orderId).forUpdate().executeTakeFirst();
  if (!row) throw notFound('Заказ');
  if (row.location_id !== locationId) throw badRequest('Заказ оформлен на другую точку', [{ path: ['orderId'], message: 'Другая точка' }], 'order_location_mismatch');
  if (row.status !== 'sent' && row.status !== 'partial') throw conflict('Этот заказ не ждёт приёмки', undefined, 'order_not_open');
  if (supplierId && supplierId !== row.supplier_id) throw badRequest('Поставщик прихода не совпадает с поставщиком заказа', [{ path: ['supplierId'], message: 'Другой поставщик' }], 'order_supplier_mismatch');
  return { id: row.id, number: row.number, supplierId: row.supplier_id };
}

/** Принятое количество засчитывается в заказ. Продукты, которых в заказе не было, в счёт не идут. */
export async function applyReceiptToOrder(trx: Transaction<Database>, order: OrderForReceipt, lines: { productId: string; quantity: number }[], now: Date): Promise<{ extra: number }> {
  const byProduct = new Map<string, number>();
  for (const l of lines) byProduct.set(l.productId, round3((byProduct.get(l.productId) ?? 0) + l.quantity));
  let extra = 0;
  for (const [productId, quantity] of byProduct) {
    const res = await trx
      .updateTable('purchase_order_lines')
      .set({ received_qty: sql`received_qty + ${quantity}` })
      .where('order_id', '=', order.id)
      .where('product_id', '=', productId)
      .returning('product_id')
      .executeTakeFirst();
    if (!res) extra += 1;
  }
  const state = await trx
    .selectFrom('purchase_order_lines')
    .select([sql<string>`count(*) filter (where received_qty < quantity)`.as('open'), sql<string>`coalesce(sum(received_qty), 0)`.as('received')])
    .where('order_id', '=', order.id)
    .executeTakeFirstOrThrow();
  const complete = Number(state.open) === 0;
  const status: OrderStatus = complete ? 'received' : Number(state.received) > 0 ? 'partial' : 'sent';
  await trx
    .updateTable('purchase_orders')
    .set({ status, updated_at: now, ...(complete ? { closed_at: now } : {}) })
    .where('id', '=', order.id)
    .execute();
  return { extra };
}

/**
 * Раз в сутки готовит черновики по поставщикам с включённым автозаказом. Отправляет их только человек:
 * автоматическая отправка без проверки сама по себе ошибка, которую дорого исправлять.
 */
export async function autoDraftOrders(deps: Deps): Promise<{ drafts: number; total: number }> {
  const auto = await deps.db.selectFrom('suppliers').select('id').where('auto_order', '=', true).where('is_active', '=', true).execute();
  if (auto.length === 0) return { drafts: 0, total: 0 };
  const ids = new Set(auto.map((s) => s.id));
  const groups = (await suggestOrders(deps, null)).filter((g) => ids.has(g.supplierId) && g.draftId === null);
  const today = businessToday(deps);
  const made: { supplier: string; location: string; total: number; number: string }[] = [];
  for (const g of groups) {
    try {
      const row = await deps.db.transaction().execute(async (trx) => {
        const created = await createDraft(deps, trx, {
          supplierId: g.supplierId,
          locationId: g.locationId,
          expectedOn: addDays(today, g.leadTimeDays),
          comment: 'Черновик собран автоматически по остаткам и продажам. Проверьте количества перед отправкой.',
          lines: g.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitCost: l.unitCost })),
          createdBy: null,
        });
        await writeAudit(trx, { action: 'order.auto_draft', entity: 'purchase_order', entityId: created.id, at: deps.clock(), details: { number: created.number, lines: g.lines.length, total: g.total } });
        return created;
      });
      made.push({ supplier: g.supplierName, location: g.locationName, total: g.total, number: row.number });
    } catch (err) {
      // черновик на эту пару уже появился между расчётом и записью: пропускаем
      if (pgCode(err) === PG_UNIQUE_VIOLATION) continue;
      deps.log.error({ err }, 'не удалось собрать черновик заказа');
    }
  }
  const total = roundMoney(made.reduce((s, m) => s + m.total, 0));
  if (made.length > 0 && deps.notifier.enabled) {
    const lines = made.slice(0, 10).map((m) => `• ${escapeHtml(m.number)}: ${escapeHtml(m.supplier)}, ${escapeHtml(m.location)}, ${escapeHtml(formatMoney(m.total).replace(/ /g, ' '))}`);
    await deps.notifier
      .send(`<b>Черновики заказов готовы: ${made.length}</b>\n${lines.join('\n')}${made.length > 10 ? `\nи ещё ${made.length - 10}` : ''}\nПроверьте количества и отправьте в разделе «Заказы».`)
      .catch((err) => deps.log.error({ err }, 'уведомление о черновиках заказов не отправлено'));
  }
  return { drafts: made.length, total };
}
