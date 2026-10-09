import {
  addDays,
  closeOrderBody,
  createOrderBody,
  idParam,
  orderFromSuggestionBody,
  orderSuggestionsQuery,
  ordersQuery,
  updateOrderBody,
  type OrderDetailDto,
  type OrderDto,
  type OrderSuggestionDto,
  type Page,
} from '@zapas/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Deps } from '../../lib/context';
import { toCsv } from '../../lib/csv';
import { conflict, notFound } from '../../lib/errors';
import { assertLocation, locationFilter } from '../../lib/scope';
import { businessToday } from '../../lib/time';
import { asUser, requireUser } from '../../plugins/access';
import { writeAudit } from '../audit/audit';
import {
  cancelOrder,
  closeOrder,
  createDraft,
  draftExists,
  emailOrder,
  headerSelect,
  loadOrderDetail,
  sendOrder,
  toOrderDto,
  updateDraft,
} from './service';
import { suggestOrders } from './suggest';

export const orderRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;
    const sendLimit = { rateLimit: { max: Math.max(20, Math.floor(deps.config.rateLimitMax / 30)), timeWindow: '1 minute' } };

    async function detail(id: string): Promise<OrderDetailDto> {
      const d = await loadOrderDetail(deps, db, id);
      if (!d) throw notFound('Заказ');
      const { locationAddress: _address, ...dto } = d;
      return dto;
    }

    async function visible(principal: ReturnType<typeof requireUser>, id: string): Promise<OrderDetailDto> {
      const d = await detail(id);
      assertLocation(principal, d.locationId);
      return d;
    }

    // Что заказать: считается по остаткам, продажам и тому, что уже в пути
    app.get('/orders/suggestions', { config: asUser('manager'), schema: { querystring: orderSuggestionsQuery } }, async (req): Promise<OrderSuggestionDto[]> => {
      const scope = locationFilter(requireUser(req), req.query.locationId);
      return suggestOrders(deps, scope, req.query.supplierId ? { supplierId: req.query.supplierId } : {});
    });

    app.get('/orders', { config: asUser('storekeeper'), schema: { querystring: ordersQuery } }, async (req): Promise<Page<OrderDto>> => {
      const { status, locationId, supplierId, limit, offset } = req.query;
      const scope = locationFilter(requireUser(req), locationId);
      const filtered = (qb: ReturnType<typeof headerSelect>) =>
        qb
          .$if(scope !== null, (q) => q.where('o.location_id', 'in', scope?.length ? scope : ['00000000-0000-0000-0000-000000000000']))
          .$if(supplierId !== undefined, (q) => q.where('o.supplier_id', '=', supplierId as string))
          .$if(status === 'open', (q) => q.where('o.status', 'in', ['sent', 'partial']))
          .$if(status !== 'open' && status !== 'all', (q) => q.where('o.status', '=', status as 'draft'));
      const total = await db
        .selectFrom('purchase_orders as o')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .$if(scope !== null, (q) => q.where('o.location_id', 'in', scope?.length ? scope : ['00000000-0000-0000-0000-000000000000']))
        .$if(supplierId !== undefined, (q) => q.where('o.supplier_id', '=', supplierId as string))
        .$if(status === 'open', (q) => q.where('o.status', 'in', ['sent', 'partial']))
        .$if(status !== 'open' && status !== 'all', (q) => q.where('o.status', '=', status as 'draft'))
        .executeTakeFirstOrThrow();
      const rows = await filtered(headerSelect(db)).orderBy('o.created_at', 'desc').orderBy('o.number', 'desc').limit(limit).offset(offset).execute();
      return { items: rows.map((r) => toOrderDto(r as never)), total: Number(total.n), limit, offset };
    });

    app.get('/orders/:id', { config: asUser('storekeeper'), schema: { params: idParam } }, async (req) => visible(requireUser(req), req.params.id));

    app.post('/orders', { config: asUser('manager'), schema: { body: createOrderBody } }, async (req, reply) => {
      const principal = requireUser(req);
      const b = req.body;
      assertLocation(principal, b.locationId);
      try {
        const created = await db.transaction().execute(async (trx) => {
          const row = await createDraft(deps, trx, { supplierId: b.supplierId, locationId: b.locationId, expectedOn: b.expectedOn, comment: b.comment, lines: b.lines, createdBy: principal.id });
          await writeAudit(trx, { action: 'order.create', entity: 'purchase_order', entityId: row.id, principal, meta: req.meta, at: deps.clock(), details: { number: row.number, lines: b.lines.length } });
          return row;
        });
        return reply.status(201).send(await detail(created.id));
      } catch (err) {
        await draftExists(db, err, b.supplierId, b.locationId);
        throw err;
      }
    });

    // Черновик из расчёта: количества считает сервер, а не берутся из запроса
    app.post('/orders/from-suggestion', { config: asUser('manager'), schema: { body: orderFromSuggestionBody } }, async (req, reply) => {
      const principal = requireUser(req);
      const b = req.body;
      assertLocation(principal, b.locationId);
      const group = (await suggestOrders(deps, [b.locationId], { supplierId: b.supplierId })).find((g) => g.supplierId === b.supplierId && g.locationId === b.locationId);
      if (!group) throw conflict('Сейчас у этого поставщика на эту точку заказывать нечего', undefined, 'nothing_to_order');
      if (group.draftId) throw conflict('На этого поставщика и точку уже есть черновик заказа', { orderId: group.draftId }, 'draft_exists');
      try {
        const created = await db.transaction().execute(async (trx) => {
          const row = await createDraft(deps, trx, {
            supplierId: b.supplierId,
            locationId: b.locationId,
            expectedOn: b.expectedOn ?? addDays(businessToday(deps), group.leadTimeDays),
            lines: group.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitCost: l.unitCost })),
            createdBy: principal.id,
          });
          await writeAudit(trx, { action: 'order.create', entity: 'purchase_order', entityId: row.id, principal, meta: req.meta, at: deps.clock(), details: { number: row.number, lines: group.lines.length, fromSuggestion: true } });
          return row;
        });
        return reply.status(201).send(await detail(created.id));
      } catch (err) {
        await draftExists(db, err, b.supplierId, b.locationId);
        throw err;
      }
    });

    app.patch('/orders/:id', { config: asUser('manager'), schema: { params: idParam, body: updateOrderBody } }, async (req) => {
      const principal = requireUser(req);
      await db.transaction().execute((trx) => updateDraft(deps, trx, principal, req.params.id, req.body));
      return detail(req.params.id);
    });

    app.post('/orders/:id/send', { config: { ...asUser('manager'), ...sendLimit }, schema: { params: idParam } }, async (req) => {
      await sendOrder(deps, requireUser(req), req.meta, req.params.id);
      return detail(req.params.id);
    });

    // Письмо не дошло или почту поставщика потом исправили: отправить ещё раз
    app.post('/orders/:id/resend', { config: { ...asUser('manager'), ...sendLimit }, schema: { params: idParam } }, async (req) => {
      const principal = requireUser(req);
      const current = await visible(principal, req.params.id);
      if (current.status !== 'sent' && current.status !== 'partial') throw conflict('Письмо отправляется только по отправленному заказу', undefined, 'order_not_open');
      await emailOrder(deps, current.id, principal.email);
      await writeAudit(db, { action: 'order.resend', entity: 'purchase_order', entityId: current.id, principal, meta: req.meta, at: deps.clock(), details: { number: current.number } });
      return detail(current.id);
    });

    app.post('/orders/:id/cancel', { config: asUser('manager'), schema: { params: idParam } }, async (req) => {
      await cancelOrder(deps, requireUser(req), req.meta, req.params.id);
      return detail(req.params.id);
    });

    app.post('/orders/:id/close', { config: asUser('manager'), schema: { params: idParam, body: closeOrderBody } }, async (req) => {
      await closeOrder(deps, requireUser(req), req.meta, req.params.id, req.body.comment);
      return detail(req.params.id);
    });

    app.get('/orders/:id/export.csv', { config: asUser('manager'), schema: { params: idParam } }, async (req, reply) => {
      const principal = requireUser(req);
      const o = await visible(principal, req.params.id);
      await writeAudit(db, { action: 'report.export', entity: 'report', entityId: `order:${o.number}`, principal, meta: req.meta, at: deps.clock(), details: { rows: o.items.length } });
      const csv = toCsv(
        ['Артикул', 'Наименование', 'Ед.', 'Количество', 'Цена', 'Сумма'],
        o.items.map((i) => [i.sku, i.productName, i.unit, i.quantity, i.unitCost, i.sum]),
      );
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="order-${o.number.replace(/\D/g, '')}.csv"; filename*=UTF-8''${encodeURIComponent(o.number)}.csv`)
        .send(csv);
    });
  };
