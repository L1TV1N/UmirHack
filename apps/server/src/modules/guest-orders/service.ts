import {
  GUEST_ORDER_STATUS_LABELS,
  INCIDENT_BLAME_LABELS,
  INCIDENT_KIND_LABELS,
  roundMoney,
  servesDishes,
  type CreateGuestOrderBody,
  type GuestIncidentDto,
  type GuestOrderDetailDto,
  type GuestOrderDto,
  type GuestOrderStatus,
  type ReportIncidentBody,
  type ResolveIncidentBody,
} from '@zapas/shared';
import { sql, type Selectable, type Transaction } from 'kysely';
import type { Database, GuestOrdersTable } from '../../db/types';
import type { Actor, Deps, Principal } from '../../lib/context';
import { actorName } from '../../lib/context';
import { badRequest, conflict, forbidden, notFound, PG_UNIQUE_VIOLATION, pgCode, unprocessable } from '../../lib/errors';
import { hubFor } from '../../lib/events';
import { assertLocation, locationFilter } from '../../lib/scope';
import { writeAudit } from '../audit/audit';
import { sell, writeOff } from '../stock/operations';
import { getStopList } from '../stoplist/service';

type OrderRow = Selectable<GuestOrdersTable>;
type UserPrincipal = Extract<Principal, { kind: 'user' }>;

/** Принимать заказы гостей могут официанты, менеджеры и администраторы. */
export function canTakeOrders(role: UserPrincipal['role']): boolean {
  return role === 'waiter' || role === 'manager' || role === 'admin';
}

const isManager = (p: UserPrincipal): boolean => p.role === 'manager' || p.role === 'admin';

async function addEvent(trx: Transaction<Database>, orderId: string, kind: string, text: string, actor: string, at: Date): Promise<void> {
  await trx.insertInto('guest_order_events').values({ order_id: orderId, kind, text, actor, created_at: at }).execute();
}

/** Заказ виден тем, кто видит его точку; официант видит только свои заказы. */
function assertVisible(p: UserPrincipal, row: { location_id: string; waiter_id: string }): void {
  assertLocation(p, row.location_id);
  if (p.role === 'waiter' && row.waiter_id !== p.id) throw notFound('Заказ');
}

async function loadRow(deps: Deps, id: string): Promise<OrderRow> {
  const row = await deps.db.selectFrom('guest_orders').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) throw notFound('Заказ');
  return row;
}

export async function toDtos(deps: Deps, rows: OrderRow[]): Promise<GuestOrderDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [lines, locations, waiters, open] = await Promise.all([
    deps.db
      .selectFrom('guest_order_lines as l')
      .innerJoin('dishes as d', 'd.id', 'l.dish_id')
      .select(['l.id', 'l.order_id', 'l.dish_id', 'd.name', 'l.quantity', 'l.price', 'l.note', 'l.is_remake'])
      .where('l.order_id', 'in', ids)
      .orderBy('l.is_remake')
      .execute(),
    deps.db.selectFrom('locations').select(['id', 'name']).where('id', 'in', [...new Set(rows.map((r) => r.location_id))]).execute(),
    deps.db.selectFrom('users').select(['id', 'full_name']).where('id', 'in', [...new Set(rows.map((r) => r.waiter_id))]).execute(),
    deps.db
      .selectFrom('guest_order_incidents')
      .select(['order_id', sql<string>`count(*)`.as('n')])
      .where('order_id', 'in', ids)
      .where('status', '=', 'reported')
      .groupBy('order_id')
      .execute(),
  ]);
  return rows.map((r) => {
    const own = lines.filter((l) => l.order_id === r.id);
    return {
      id: r.id,
      number: r.number,
      status: r.status,
      locationId: r.location_id,
      locationName: locations.find((l) => l.id === r.location_id)?.name ?? '-',
      tableLabel: r.table_label,
      comment: r.comment,
      waiterId: r.waiter_id,
      waiterName: waiters.find((w) => w.id === r.waiter_id)?.full_name ?? '-',
      lines: own.map((l) => ({
        id: l.id,
        dishId: l.dish_id,
        dishName: l.name,
        quantity: l.quantity,
        price: Number(l.price),
        note: l.note,
        isRemake: l.is_remake,
      })),
      total: roundMoney(own.filter((l) => !l.is_remake).reduce((s, l) => s + Number(l.price) * l.quantity, 0)),
      createdAt: r.created_at.toISOString(),
      placedAt: r.placed_at?.toISOString() ?? null,
      acceptedAt: r.accepted_at?.toISOString() ?? null,
      servedAt: r.served_at?.toISOString() ?? null,
      cancelledAt: r.cancelled_at?.toISOString() ?? null,
      cancelReason: r.cancel_reason,
      openIncidents: Number(open.find((o) => o.order_id === r.id)?.n ?? 0),
    };
  });
}

async function incidentDtos(deps: Deps, orderId: string): Promise<GuestIncidentDto[]> {
  const rows = await deps.db
    .selectFrom('guest_order_incidents as i')
    .leftJoin('guest_order_lines as l', 'l.id', 'i.line_id')
    .leftJoin('dishes as d', 'd.id', 'l.dish_id')
    .select(['i.id', 'i.order_id', 'i.line_id', 'd.name as dish_name', 'i.kind', 'i.blame', 'i.comment', 'i.status', 'i.reported_by', 'i.reported_at', 'i.resolved_by', 'i.resolved_at', 'i.resolution_comment', 'i.loss_cost'])
    .where('i.order_id', '=', orderId)
    .orderBy('i.reported_at')
    .execute();
  const userIds = [...new Set(rows.flatMap((r) => [r.reported_by, r.resolved_by].filter((x): x is string => Boolean(x))))];
  const names = userIds.length ? await deps.db.selectFrom('users').select(['id', 'full_name']).where('id', 'in', userIds).execute() : [];
  const nameOf = (id: string | null) => (id ? (names.find((n) => n.id === id)?.full_name ?? '-') : null);
  return rows.map((r) => ({
    id: r.id,
    orderId: r.order_id,
    lineId: r.line_id,
    dishName: r.dish_name,
    kind: r.kind,
    blame: r.blame,
    comment: r.comment,
    status: r.status,
    reportedBy: nameOf(r.reported_by) ?? '-',
    reportedAt: r.reported_at.toISOString(),
    resolvedBy: nameOf(r.resolved_by),
    resolvedAt: r.resolved_at?.toISOString() ?? null,
    resolutionComment: r.resolution_comment,
    lossCost: r.loss_cost === null ? null : Number(r.loss_cost),
  }));
}

export async function getOrder(deps: Deps, p: UserPrincipal, id: string): Promise<GuestOrderDetailDto> {
  const row = await loadRow(deps, id);
  assertVisible(p, row);
  const [dto] = await toDtos(deps, [row]);
  const events = await deps.db.selectFrom('guest_order_events').selectAll().where('order_id', '=', id).orderBy('seq').execute();
  return {
    ...(dto as GuestOrderDto),
    incidents: await incidentDtos(deps, id),
    events: events.map((e) => ({ id: e.id, kind: e.kind, text: e.text, actor: e.actor, at: e.created_at.toISOString() })),
  };
}

export async function listOrders(
  deps: Deps,
  p: UserPrincipal,
  q: { locationId?: string | undefined; status: GuestOrderStatus | 'open' | 'all'; mine: boolean },
): Promise<GuestOrderDto[]> {
  const scope = locationFilter(p, q.locationId);
  let query = deps.db.selectFrom('guest_orders').selectAll().orderBy('created_at', 'desc').limit(200);
  if (scope) query = query.where('location_id', 'in', scope.length ? scope : ['00000000-0000-0000-0000-000000000000']);
  if (q.status === 'open') query = query.where('status', 'in', ['new', 'in_progress']);
  else if (q.status !== 'all') query = query.where('status', '=', q.status);
  if (p.role === 'waiter' || q.mine) query = query.where('waiter_id', '=', p.id);
  return toDtos(deps, await query.execute());
}

/** Сколько заказов ждёт менеджера: для значка в меню. */
export async function openCount(deps: Deps, p: UserPrincipal): Promise<{ open: number; incidents: number }> {
  const scope = locationFilter(p);
  let orders = deps.db.selectFrom('guest_orders').select(sql<string>`count(*)`.as('n')).where('status', 'in', ['new', 'in_progress']);
  let incidents = deps.db
    .selectFrom('guest_order_incidents as i')
    .innerJoin('guest_orders as o', 'o.id', 'i.order_id')
    .select(sql<string>`count(*)`.as('n'))
    .where('i.status', '=', 'reported');
  if (scope) {
    const ids = scope.length ? scope : ['00000000-0000-0000-0000-000000000000'];
    orders = orders.where('location_id', 'in', ids);
    incidents = incidents.where('o.location_id', 'in', ids);
  }
  const [o, i] = await Promise.all([orders.executeTakeFirstOrThrow(), incidents.executeTakeFirstOrThrow()]);
  return { open: Number(o.n), incidents: Number(i.n) };
}

/** Задержка, после которой заказ считается принятым без связи и об этом пишется в ленту. */
const LATE_AFTER_MS = 60_000;
/** Заказ, принятый без связи, может прийти не позже, чем через сутки: дальше время мы уже не принимаем на веру. */
const MAX_LATE_MS = 24 * 3600_000;

/**
 * Принимает заказ гостя. Ключ идемпотентности защищает от дубля, если ответ потерялся и официантский телефон
 * отправил заказ из очереди повторно: тот же ключ того же официанта возвращает уже принятый заказ.
 */
export async function createOrder(deps: Deps, actor: Actor, body: CreateGuestOrderBody, key?: string): Promise<GuestOrderDetailDto> {
  const p = actor.principal as UserPrincipal;
  if (!canTakeOrders(p.role)) throw forbidden();
  assertLocation(p, body.locationId);
  const now = deps.clock();

  if (key) {
    const known = await deps.db.selectFrom('guest_orders').select('id').where('waiter_id', '=', p.id).where('client_key', '=', key).executeTakeFirst();
    if (known) return getOrder(deps, p, known.id);
  }
  // время приёма берём у телефона, но в разумных пределах: не из будущего и не старше суток
  const claimed = body.placedAt ? new Date(body.placedAt) : null;
  const placedAt = claimed && now.getTime() - claimed.getTime() > LATE_AFTER_MS ? new Date(Math.max(claimed.getTime(), now.getTime() - MAX_LATE_MS)) : null;

  // блюдо из стоп-листа принять нельзя: официант увидит это ещё при выборе, здесь защита от устаревшего экрана
  const wanted = new Set(body.lines.map((l) => l.dishId));
  const stopped = (await getStopList(deps, [body.locationId])).entries.find((e) => e.entityType === 'dish' && wanted.has(e.entityId));
  if (stopped) throw conflict(`«${stopped.name}» в стоп-листе, принять заказ нельзя`, [{ dishId: stopped.entityId }], 'dish_stopped');

  let id: string;
  try {
    id = await createOrderRow(deps, actor, p, body, key ?? null, placedAt, now);
  } catch (err) {
    // два одинаковых запроса одновременно: проиграл второй, отдаём то, что создал первый
    if (key && pgCode(err) === PG_UNIQUE_VIOLATION) {
      const known = await deps.db.selectFrom('guest_orders').select('id').where('waiter_id', '=', p.id).where('client_key', '=', key).executeTakeFirst();
      if (known) return getOrder(deps, p, known.id);
    }
    throw err;
  }
  hubFor(deps.db).publish();
  return getOrder(deps, p, id);
}

const clockOf = (deps: Deps, at: Date): string =>
  new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: deps.config.businessTz }).format(at);

async function createOrderRow(deps: Deps, actor: Actor, p: UserPrincipal, body: CreateGuestOrderBody, key: string | null, placedAt: Date | null, now: Date): Promise<string> {
  return deps.db.transaction().execute(async (trx) => {
    const loc = await trx.selectFrom('locations').select(['id', 'kind', 'is_active', 'org_id']).where('id', '=', body.locationId).executeTakeFirst();
    if (!loc) throw notFound('Точка');
    if (!loc.is_active) throw unprocessable('Точка отключена', undefined, 'location_inactive');
    if (!servesDishes(loc.kind)) throw unprocessable('На этой точке не готовят блюда: заказы гостей здесь не принимаются', undefined, 'not_a_kitchen');

    const dishIds = [...new Set(body.lines.map((l) => l.dishId))];
    const dishes = await trx.selectFrom('dishes').select(['id', 'name', 'price', 'is_active']).where('org_id', '=', loc.org_id).where('id', 'in', dishIds).execute();
    for (const [i, l] of body.lines.entries()) {
      const d = dishes.find((x) => x.id === l.dishId);
      if (!d || !d.is_active) throw badRequest('Блюдо не найдено или убрано из меню', [{ path: ['lines', i, 'dishId'], message: 'Недоступно' }]);
    }

    const order = await trx
      .insertInto('guest_orders')
      .values({
        number: sql<string>`'ЗК-' || lpad(nextval('guest_order_seq')::text, 6, '0')`,
        location_id: body.locationId,
        table_label: body.tableLabel,
        waiter_id: p.id,
        comment: body.comment ?? null,
        client_key: key,
        placed_at: placedAt,
        created_at: now,
        updated_at: now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('guest_order_lines')
      .values(
        body.lines.map((l) => ({
          order_id: order.id,
          dish_id: l.dishId,
          quantity: l.quantity,
          price: dishes.find((d) => d.id === l.dishId)?.price ?? 0,
          note: l.note ?? null,
        })),
      )
      .execute();
    await addEvent(
      trx,
      order.id,
      'created',
      placedAt ? `Заказ принят в ${clockOf(deps, placedAt)} без связи, дошёл в ${clockOf(deps, now)}, стол ${body.tableLabel}` : `Заказ принят, стол ${body.tableLabel}`,
      actorName(p),
      now,
    );
    await writeAudit(trx, { action: 'guest_order.create', entity: 'guest_order', entityId: order.id, principal: p, meta: actor.meta, at: now, details: { locationId: body.locationId, lines: body.lines.length } });
    return order.id;
  });
}

export async function changeStatus(
  deps: Deps,
  actor: Actor,
  id: string,
  next: 'in_progress' | 'served' | 'cancelled',
  comment: string | undefined,
): Promise<GuestOrderDetailDto> {
  const p = actor.principal as UserPrincipal;
  const row = await loadRow(deps, id);
  assertVisible(p, row);
  const now = deps.clock();

  if (!isManager(p)) {
    // официант может только отменить свой заказ, пока его не взяли в работу
    if (!(p.role === 'waiter' && next === 'cancelled' && row.status === 'new')) throw forbidden();
  }
  if (row.status === 'served' || row.status === 'cancelled') {
    throw conflict(`Заказ уже закрыт: ${GUEST_ORDER_STATUS_LABELS[row.status].toLowerCase()}`, undefined, 'order_closed');
  }
  if (row.status === next) return getOrder(deps, p, id);
  if (next === 'in_progress' && row.status !== 'new') throw conflict('Заказ уже в работе', undefined, 'bad_transition');
  if (next === 'served' && row.status !== 'in_progress') throw conflict('Сначала возьмите заказ в работу', undefined, 'bad_transition');

  if (next === 'in_progress') {
    const lines = await deps.db.selectFrom('guest_order_lines').select(['dish_id', 'quantity']).where('order_id', '=', id).where('is_remake', '=', false).execute();
    // продукты списываются здесь: если чего-то не хватает, заказ остаётся принятым, а менеджер видит что именно
    const sale = await sell(
      deps,
      actor,
      { locationId: row.location_id, comment: `Заказ гостя ${row.number}`, lines: lines.map((l) => ({ dishId: l.dish_id, quantity: l.quantity })) },
      `guest-order:${id}`,
    );
    await deps.db.transaction().execute(async (trx) => {
      await trx.updateTable('guest_orders').set({ status: 'in_progress', document_id: sale.documentId, accepted_at: now, updated_at: now }).where('id', '=', id).execute();
      await addEvent(trx, id, 'in_progress', `Взят в работу, продукты списаны документом ${sale.number}`, actorName(p), now);
      await writeAudit(trx, { action: 'guest_order.status', entity: 'guest_order', entityId: id, principal: p, meta: actor.meta, at: now, details: { to: next, document: sale.number } });
    });
  } else {
    await deps.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('guest_orders')
        .set({
          status: next,
          updated_at: now,
          ...(next === 'served' ? { served_at: now } : { cancelled_at: now, cancel_reason: comment ?? null }),
        })
        .where('id', '=', id)
        .execute();
      const text =
        next === 'served'
          ? 'Заказ выдан гостю'
          : row.status === 'in_progress'
            ? `Заказ отменён: ${comment}. Продукты уже были списаны`
            : `Заказ отменён: ${comment}`;
      await addEvent(trx, id, next, text, actorName(p), now);
      await writeAudit(trx, { action: 'guest_order.status', entity: 'guest_order', entityId: id, principal: p, meta: actor.meta, at: now, details: { to: next, comment } });
    });
  }
  hubFor(deps.db).publish();
  return getOrder(deps, p, id);
}

export async function reportIncident(deps: Deps, actor: Actor, id: string, body: ReportIncidentBody): Promise<GuestOrderDetailDto> {
  const p = actor.principal as UserPrincipal;
  const row = await loadRow(deps, id);
  assertVisible(p, row);
  if (!canTakeOrders(p.role)) throw forbidden();
  if (row.status === 'new' || row.status === 'cancelled') {
    throw conflict('Сообщить о проблеме можно по заказу, который уже готовят или выдан', undefined, 'incident_not_allowed');
  }
  const now = deps.clock();
  if (body.lineId) {
    const line = await deps.db.selectFrom('guest_order_lines').select('id').where('id', '=', body.lineId).where('order_id', '=', id).executeTakeFirst();
    if (!line) throw badRequest('Позиция не найдена в этом заказе', [{ path: ['lineId'], message: 'Не найдена' }]);
  }
  await deps.db.transaction().execute(async (trx) => {
    const incident = await trx
      .insertInto('guest_order_incidents')
      .values({ order_id: id, line_id: body.lineId ?? null, kind: body.kind, blame: body.blame, comment: body.comment, reported_by: p.id, reported_at: now })
      .returning('id')
      .executeTakeFirstOrThrow();
    await addEvent(trx, id, 'incident', `${INCIDENT_KIND_LABELS[body.kind]} (${INCIDENT_BLAME_LABELS[body.blame].toLowerCase()}): ${body.comment}`, actorName(p), now);
    await writeAudit(trx, { action: 'guest_order.incident', entity: 'guest_order', entityId: id, principal: p, meta: actor.meta, at: now, details: { incident: incident.id, kind: body.kind, blame: body.blame } });
  });
  hubFor(deps.db).publish();
  return getOrder(deps, p, id);
}

export async function resolveIncident(deps: Deps, actor: Actor, incidentId: string, body: ResolveIncidentBody): Promise<GuestOrderDetailDto> {
  const p = actor.principal as UserPrincipal;
  if (!isManager(p)) throw forbidden();
  const incident = await deps.db.selectFrom('guest_order_incidents').selectAll().where('id', '=', incidentId).executeTakeFirst();
  if (!incident) throw notFound('Обращение');
  const order = await loadRow(deps, incident.order_id);
  assertVisible(p, order);
  if (incident.status !== 'reported') throw conflict('Решение по этому обращению уже принято', undefined, 'incident_resolved');
  const now = deps.clock();

  if (body.action === 'dismiss') {
    await deps.db.transaction().execute(async (trx) => {
      await trx.updateTable('guest_order_incidents').set({ status: 'dismissed', resolved_by: p.id, resolved_at: now, resolution_comment: body.comment ?? null }).where('id', '=', incidentId).execute();
      await addEvent(trx, order.id, 'incident_dismissed', `Обращение отклонено${body.comment ? `: ${body.comment}` : ''}`, actorName(p), now);
      await writeAudit(trx, { action: 'guest_order.incident_resolve', entity: 'guest_order', entityId: order.id, principal: p, meta: actor.meta, at: now, details: { incident: incidentId, action: 'dismiss' } });
    });
    hubFor(deps.db).publish();
    return getOrder(deps, p, order.id);
  }

  // переделка: блюдо готовится заново бесплатно, а продукты на него списываются как потеря
  const lines = await deps.db.selectFrom('guest_order_lines').selectAll().where('order_id', '=', order.id).where('is_remake', '=', false).execute();
  const wantedLine = incident.line_id ?? body.lineId ?? null;
  const target = wantedLine ? lines.find((l) => l.id === wantedLine) : lines.length === 1 ? lines[0] : undefined;
  if (!target) throw badRequest('Выберите, какую позицию переделать: в обращении она не указана', [{ path: ['lineId'], message: 'Нужна позиция' }], 'incident_line_required');
  const recipe = await deps.db.selectFrom('dish_items').select(['product_id', 'quantity']).where('dish_id', '=', target.dish_id).execute();
  if (recipe.length === 0) throw unprocessable('У блюда нет состава, списывать нечего', undefined, 'dish_empty');
  const dish = await deps.db.selectFrom('dishes').select('name').where('id', '=', target.dish_id).executeTakeFirstOrThrow();

  const writeoff = await writeOff(
    deps,
    actor,
    {
      locationId: order.location_id,
      reason: 'damaged',
      comment: `Переделка ${dish.name} по заказу ${order.number}: ${INCIDENT_KIND_LABELS[incident.kind].toLowerCase()}, ${INCIDENT_BLAME_LABELS[incident.blame].toLowerCase()}. ${incident.comment}`.slice(0, 500),
      lines: recipe.map((r) => ({ productId: r.product_id, quantity: Math.round(Number(r.quantity) * target.quantity * 1000) / 1000 })),
    },
    `guest-incident:${incidentId}`,
  );
  const cost = await deps.db
    .selectFrom('stock_movements')
    .select(sql<string>`coalesce(sum(-quantity * unit_cost), 0)`.as('cost'))
    .where('document_id', '=', writeoff.documentId)
    .executeTakeFirstOrThrow();
  const loss = roundMoney(Number(cost.cost));

  await deps.db.transaction().execute(async (trx) => {
    await trx.insertInto('guest_order_lines').values({ order_id: order.id, dish_id: target.dish_id, quantity: target.quantity, price: 0, note: 'Переделка за счёт заведения', is_remake: true }).execute();
    await trx
      .updateTable('guest_order_incidents')
      .set({ status: 'remade', resolved_by: p.id, resolved_at: now, resolution_comment: body.comment ?? null, writeoff_document_id: writeoff.documentId, loss_cost: loss })
      .where('id', '=', incidentId)
      .execute();
    // выданный заказ снова в работе, пока гость не получит замену
    await trx.updateTable('guest_orders').set({ status: 'in_progress', served_at: null, updated_at: now }).where('id', '=', order.id).execute();
    await addEvent(trx, order.id, 'remade', `Переделка бесплатно: ${dish.name} × ${target.quantity}. Списано документом ${writeoff.number}, потеря ${loss} ₽ (${INCIDENT_BLAME_LABELS[incident.blame].toLowerCase()})`, actorName(p), now);
    await writeAudit(trx, { action: 'guest_order.incident_resolve', entity: 'guest_order', entityId: order.id, principal: p, meta: actor.meta, at: now, details: { incident: incidentId, action: 'remake', document: writeoff.number, loss, blame: incident.blame } });
  });
  hubFor(deps.db).publish();
  return getOrder(deps, p, order.id);
}

