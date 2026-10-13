import { idParam, locationScopeQuery, manualStopBody } from '@zapas/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Deps } from '../../lib/context';
import { badRequest, conflict, notFound, PG_UNIQUE_VIOLATION, pgCode } from '../../lib/errors';
import { assertLocation, locationFilter } from '../../lib/scope';
import { asUser, requireUser } from '../../plugins/access';
import { writeAudit } from '../audit/audit';
import { escapeHtml } from '../notifications/notifier';
import { getStopForecast, getStopList, scheduleStopListSync } from './service';

export const stopListRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;

    app.get('/stop-list', { config: asUser(), schema: { querystring: locationScopeQuery } }, async (req) =>
      getStopList(deps, locationFilter(requireUser(req), req.query.locationId)),
    );

    // Когда блюда перестанут готовиться при текущих продажах и без новых поставок
    app.get('/stop-list/forecast', { config: asUser(), schema: { querystring: locationScopeQuery } }, async (req) =>
      getStopForecast(deps, requireUser(req), req.query.locationId),
    );

    app.post('/stop-list/manual', { config: asUser('manager'), schema: { body: manualStopBody } }, async (req, reply) => {
      const principal = requireUser(req);
      const b = req.body;
      assertLocation(principal, b.locationId);
      const now = deps.clock();
      if (b.until && new Date(b.until).getTime() <= now.getTime()) {
        throw badRequest('Срок действия уже прошёл', [{ path: ['until'], message: 'Укажите будущее время' }]);
      }

      let name = '';
      let locationName = '';
      try {
        const id = await db.transaction().execute(async (trx) => {
          const loc = await trx.selectFrom('locations').select(['name', 'is_active']).where('id', '=', b.locationId).executeTakeFirst();
          if (!loc) throw notFound('Точка');
          locationName = loc.name;
          if (b.productId) {
            const p = await trx.selectFrom('products').select('name').where('id', '=', b.productId).executeTakeFirst();
            if (!p) throw notFound('Продукт');
            name = p.name;
          } else if (b.dishId) {
            const d = await trx.selectFrom('dishes').select('name').where('id', '=', b.dishId).executeTakeFirst();
            if (!d) throw notFound('Блюдо');
            name = d.name;
          }
          const row = await trx
            .insertInto('stop_list_manual')
            .values({
              location_id: b.locationId,
              product_id: b.productId ?? null,
              dish_id: b.dishId ?? null,
              reason: b.reason,
              created_by: principal.id,
              created_at: now,
              until: b.until ? new Date(b.until) : null,
              released_at: null,
              released_by: null,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await writeAudit(trx, {
            action: 'stoplist.add',
            entity: 'stop_list_manual',
            entityId: row.id,
            principal,
            meta: req.meta,
            at: now,
            details: { locationId: b.locationId, productId: b.productId, dishId: b.dishId, reason: b.reason, until: b.until },
          });
          return row.id;
        });
        scheduleStopListSync(deps, [b.locationId]);
        if (deps.notifier.enabled) {
          deps.notifier
            .send(`<b>В стоп-лист вручную:</b> ${escapeHtml(name)} (${escapeHtml(locationName)})\n${escapeHtml(b.reason)}`)
            .catch((err) => deps.log.error({ err }, 'уведомление о ручном стопе не отправлено'));
        }
        return reply.status(201).send({ id });
      } catch (err) {
        if (pgCode(err) === PG_UNIQUE_VIOLATION) throw conflict('Позиция уже в стоп-листе на этой точке', undefined, 'duplicate');
        throw err;
      }
    });

    app.delete('/stop-list/manual/:id', { config: asUser('manager'), schema: { params: idParam } }, async (req, reply) => {
      const principal = requireUser(req);
      const now = deps.clock();
      let releasedLocation: string | null = null;
      await db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom('stop_list_manual')
          .select(['id', 'location_id'])
          .where('id', '=', req.params.id)
          .where('released_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (!row) throw notFound('Запись стоп-листа');
        assertLocation(principal, row.location_id);
        releasedLocation = row.location_id;
        await trx.updateTable('stop_list_manual').set({ released_at: now, released_by: principal.id }).where('id', '=', row.id).execute();
        await writeAudit(trx, {
          action: 'stoplist.release',
          entity: 'stop_list_manual',
          entityId: row.id,
          principal,
          meta: req.meta,
          at: now,
          details: {},
        });
      });
      if (releasedLocation) scheduleStopListSync(deps, [releasedLocation]);
      return reply.status(204).send();
    });
  };
