import { idParam, promotionBody, promotionsQuery, roundMoney, type PromotionDto } from '@zapas/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import type { Deps } from '../../lib/context';
import { notFound, unprocessable } from '../../lib/errors';
import { assertLocation, locationFilter } from '../../lib/scope';
import { businessToday } from '../../lib/time';
import { asUser, requireUser } from '../../plugins/access';
import { writeAudit } from '../audit/audit';

export const promotionRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;

    const select = () =>
      db
        .selectFrom('promotions as pr')
        .innerJoin('batches as b', 'b.id', 'pr.batch_id')
        .innerJoin('products as p', 'p.id', 'b.product_id')
        .innerJoin('locations as l', 'l.id', 'b.location_id')
        .select([
          'pr.id',
          'pr.batch_id',
          'pr.percent',
          'pr.ends_on',
          'pr.created_at',
          'pr.cancelled_at',
          'b.expires_on',
          'b.remaining_qty',
          'b.location_id',
          'p.name as product_name',
          'p.unit',
          'p.price',
          'l.name as location_name',
        ]);

    type Row = Awaited<ReturnType<ReturnType<typeof select>['execute']>>[number];
    const toDto = (r: Row): PromotionDto => {
      const base = Number(r.price);
      return {
        id: r.id,
        batchId: r.batch_id,
        productName: r.product_name,
        locationName: r.location_name,
        expiresOn: r.expires_on,
        remainingQty: Number(r.remaining_qty),
        unit: r.unit,
        percent: r.percent,
        basePrice: base,
        promoPrice: roundMoney(base * (1 - r.percent / 100)),
        endsOn: r.ends_on,
        createdAt: r.created_at.toISOString(),
        cancelledAt: r.cancelled_at?.toISOString() ?? null,
      };
    };

    app.get('/promotions', { config: asUser(), schema: { querystring: promotionsQuery } }, async (req) => {
      const principal = requireUser(req);
      const allowed = locationFilter(principal, req.query.locationId);
      const today = businessToday(deps);
      const rows = await select()
        .$if(allowed !== null, (qb) =>
          qb.where('b.location_id', 'in', (allowed as string[]).length ? (allowed as string[]) : ['00000000-0000-0000-0000-000000000000']),
        )
        .$if(req.query.active, (qb) =>
          qb
            .where('pr.cancelled_at', 'is', null)
            .where('b.remaining_qty', '>', '0')
            .where(sql<boolean>`pr.ends_on >= ${today}::date`),
        )
        .orderBy('pr.created_at', 'desc')
        .limit(500)
        .execute();
      return rows.map(toDto);
    });

    app.post('/promotions', { config: asUser('manager'), schema: { body: promotionBody } }, async (req, reply) => {
      const principal = requireUser(req);
      const today = businessToday(deps);
      const now = deps.clock();
      const id = await db.transaction().execute(async (trx) => {
        const batch = await trx
          .selectFrom('batches as b')
          .innerJoin('products as p', 'p.id', 'b.product_id')
          .select(['b.id', 'b.location_id', 'b.expires_on', 'b.remaining_qty', 'p.sellable', 'p.name'])
          .where('b.id', '=', req.body.batchId)
          .forUpdate('b')
          .executeTakeFirst();
        if (!batch) throw notFound('Партия');
        assertLocation(principal, batch.location_id);
        if (Number(batch.remaining_qty) <= 0) throw unprocessable('Партия уже распродана', undefined, 'batch_empty');
        if (batch.expires_on < today) throw unprocessable('Срок партии истёк, скидка не нужна, её нужно списать', undefined, 'batch_expired');
        if (!batch.sellable) throw unprocessable('Продукт не продаётся отдельно', undefined, 'not_sellable');

        await trx.updateTable('promotions').set({ cancelled_at: now }).where('batch_id', '=', batch.id).where('cancelled_at', 'is', null).execute();
        const created = await trx
          .insertInto('promotions')
          .values({
            batch_id: batch.id,
            percent: req.body.percent,
            ends_on: batch.expires_on,
            created_by: principal.id,
            created_at: now,
            cancelled_at: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await writeAudit(trx, {
          action: 'promotion.create',
          entity: 'promotion',
          entityId: created.id,
          principal,
          meta: req.meta,
          at: now,
          details: { batchId: batch.id, product: batch.name, percent: req.body.percent },
        });
        return created.id;
      });
      const row = await select().where('pr.id', '=', id).executeTakeFirstOrThrow();
      return reply.status(201).send(toDto(row));
    });

    app.delete('/promotions/:id', { config: asUser('manager'), schema: { params: idParam } }, async (req, reply) => {
      const principal = requireUser(req);
      const now = deps.clock();
      await db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom('promotions as pr')
          .innerJoin('batches as b', 'b.id', 'pr.batch_id')
          .select(['pr.id', 'b.location_id'])
          .where('pr.id', '=', req.params.id)
          .where('pr.cancelled_at', 'is', null)
          .forUpdate('pr')
          .executeTakeFirst();
        if (!row) throw notFound('Акция');
        assertLocation(principal, row.location_id);
        await trx.updateTable('promotions').set({ cancelled_at: now }).where('id', '=', row.id).execute();
        await writeAudit(trx, {
          action: 'promotion.cancel',
          entity: 'promotion',
          entityId: row.id,
          principal,
          meta: req.meta,
          at: now,
          details: {},
        });
      });
      return reply.status(204).send();
    });
  };
