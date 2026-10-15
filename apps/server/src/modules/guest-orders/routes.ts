import {
  createGuestOrderBody,
  idempotencyKey,
  guestOrderStatusBody,
  guestOrdersQuery,
  idParam,
  reportIncidentBody,
  resolveIncidentBody,
  ruDate,
  waiterLocationQuery,
  type GuestOrderDetailDto,
  type GuestOrderDto,
  type WaiterDishDto,
  type WaiterHotDishDto,
  type StopListEntryDto,
  type WaiterStopDto,
} from '@zapas/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Actor, Deps } from '../../lib/context';
import { assertLocation } from '../../lib/scope';
import { asUser, requireUser } from '../../plugins/access';
import { getHotDishes } from '../analytics/service';
import { getStopList } from '../stoplist/service';
import { changeStatus, createOrder, getOrder, listOrders, openCount, reportIncident, resolveIncident } from './service';


/** Причина для зала: без количеств и остатков, только что мешает приготовить блюдо. */
function shortReason(e: StopListEntryDto): string {
  if (e.source === 'manual') return 'Снято вручную';
  const r = e.reasons[0];
  if (!r) return 'Нет в наличии';
  const base = r.code === 'missing_ingredients' && r.missing?.length ? `Не хватает: ${r.missing.map((m) => m.name).join(', ')}` : r.text;
  // официанту полезно знать, когда блюдо вернётся: поставка уже едет
  const next = e.incoming?.[0];
  return next ? `${base}. Поставка ${ruDate(next.arrivesOn)}` : base;
}

export const guestOrderRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;
    const actor = (req: FastifyRequest): Actor => ({ principal: requireUser(req), meta: req.meta });

    // Заказы гостей: официант принимает, менеджер и администратор ведут до выдачи

    app.post('/guest-orders', { config: asUser('waiter'), schema: { body: createGuestOrderBody, headers: z.object({ 'idempotency-key': idempotencyKey.optional() }) } }, async (req, reply): Promise<GuestOrderDetailDto> => {
      void reply.status(201);
      return createOrder(deps, actor(req), req.body, req.headers['idempotency-key']);
    });

    app.get('/guest-orders', { config: asUser('waiter'), schema: { querystring: guestOrdersQuery } }, async (req): Promise<GuestOrderDto[]> => {
      return listOrders(deps, requireUser(req), req.query);
    });

    app.get('/guest-orders/summary', { config: asUser('waiter') }, async (req) => {
      return openCount(deps, requireUser(req));
    });

    app.get('/guest-orders/:id', { config: asUser('waiter'), schema: { params: idParam } }, async (req): Promise<GuestOrderDetailDto> => {
      return getOrder(deps, requireUser(req), req.params.id);
    });

    app.post('/guest-orders/:id/status', { config: asUser('waiter'), schema: { params: idParam, body: guestOrderStatusBody } }, async (req): Promise<GuestOrderDetailDto> =>
      changeStatus(deps, actor(req), req.params.id, req.body.status, req.body.comment),
    );

    app.post('/guest-orders/:id/incidents', { config: asUser('waiter'), schema: { params: idParam, body: reportIncidentBody } }, async (req, reply): Promise<GuestOrderDetailDto> => {
      void reply.status(201);
      return reportIncident(deps, actor(req), req.params.id, req.body);
    });

    app.post('/guest-orders/incidents/:id/resolve', { config: asUser('manager'), schema: { params: idParam, body: resolveIncidentBody } }, async (req): Promise<GuestOrderDetailDto> =>
      resolveIncident(deps, actor(req), req.params.id, req.body),
    );

    // Экраны официанта: коротко и без разбора расчёта

    app.get('/waiter/hot-dishes', { config: asUser('waiter'), schema: { querystring: waiterLocationQuery } }, async (req): Promise<WaiterHotDishDto[]> => {
      const p = requireUser(req);
      assertLocation(p, req.query.locationId);
      const { items } = await getHotDishes(deps, p, req.query.locationId);
      return items.slice(0, 8).map((d) => ({ dishId: d.dishId, dishName: d.dishName, price: d.price, portionsToPush: d.portionsToPush, priority: d.priority }));
    });

    app.get('/waiter/stop-list', { config: asUser('waiter'), schema: { querystring: waiterLocationQuery } }, async (req): Promise<WaiterStopDto[]> => {
      const p = requireUser(req);
      assertLocation(p, req.query.locationId);
      const list = await getStopList(deps, [req.query.locationId]);
      return list.entries.map((e) => ({
        key: e.key,
        name: e.name,
        entityType: e.entityType,
        note: shortReason(e),
      }));
    });

    app.get('/waiter/menu', { config: asUser('waiter'), schema: { querystring: waiterLocationQuery } }, async (req): Promise<WaiterDishDto[]> => {
      const p = requireUser(req);
      assertLocation(p, req.query.locationId);
      const loc = await db.selectFrom('locations').select('org_id').where('id', '=', req.query.locationId).executeTakeFirstOrThrow();
      const dishes = await db.selectFrom('dishes').select(['id', 'name', 'price']).where('org_id', '=', loc.org_id).where('is_active', '=', true).orderBy('name').execute();
      if (dishes.length === 0) return [];
      const items = await db
        .selectFrom('dish_items as i')
        .innerJoin('products as p', 'p.id', 'i.product_id')
        .select(['i.dish_id', 'p.name'])
        .where('i.dish_id', 'in', dishes.map((d) => d.id))
        .orderBy('p.name')
        .execute();
      const stop = new Map((await getStopList(deps, [req.query.locationId])).entries.filter((e) => e.entityType === 'dish').map((e) => [e.entityId, e]));
      const hot = new Set((await getHotDishes(deps, p, req.query.locationId)).items.map((d) => d.dishId));
      return dishes.map((d) => {
        const s = stop.get(d.id);
        return {
          id: d.id,
          name: d.name,
          price: Number(d.price),
          stopped: Boolean(s),
          stopNote: s ? shortReason(s) : null,
          ingredients: items.filter((i) => i.dish_id === d.id).map((i) => i.name),
          hot: hot.has(d.id),
        };
      });
    });
  };
