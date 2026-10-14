import { createLocationBody, idParam, updateLocationBody, type LocationDto } from '@zapas/shared';
import type { Selectable } from 'kysely';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { LocationsTable } from '../../db/types';
import type { Deps } from '../../lib/context';
import { badRequest, conflict, notFound, PG_UNIQUE_VIOLATION, pgCode } from '../../lib/errors';
import { locationFilter, orgOf } from '../../lib/scope';
import { asUser, requirePrincipal } from '../../plugins/access';
import { writeAudit } from '../audit/audit';

export function toLocationDto(row: Selectable<LocationsTable>): LocationDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    address: row.address,
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    isActive: row.is_active,
  };
}

export const locationRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;

    app.get('/locations', { config: asUser('waiter') }, async (req) => {
      const principal = requirePrincipal(req);
      const allowed = locationFilter(principal);
      let q = db.selectFrom('locations').selectAll().where('org_id', '=', orgOf(principal)).orderBy('name');
      if (allowed) q = q.where('id', 'in', allowed.length ? allowed : ['00000000-0000-0000-0000-000000000000']);
      return (await q.execute()).map(toLocationDto);
    });

    app.post('/locations', { config: asUser('admin'), schema: { body: createLocationBody } }, async (req, reply) => {
      const principal = requirePrincipal(req);
      try {
        const row = await db.transaction().execute(async (trx) => {
          const created = await trx
            .insertInto('locations')
            .values({
              org_id: orgOf(principal),
              code: req.body.code,
              name: req.body.name,
              kind: req.body.kind,
              address: req.body.address ?? null,
              latitude: req.body.latitude ?? null,
              longitude: req.body.longitude ?? null,
              created_at: deps.clock(),
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await writeAudit(trx, {
            action: 'location.create',
            entity: 'location',
            entityId: created.id,
            principal,
            meta: req.meta,
            at: deps.clock(),
            details: { code: created.code, name: created.name, kind: created.kind },
          });
          return created;
        });
        return reply.status(201).send(toLocationDto(row));
      } catch (err) {
        if (pgCode(err) === PG_UNIQUE_VIOLATION) throw conflict('Точка с таким кодом уже есть', undefined, 'duplicate_code');
        throw err;
      }
    });

    app.patch(
      '/locations/:id',
      { config: asUser('admin'), schema: { params: idParam, body: updateLocationBody } },
      async (req) => {
        const principal = requirePrincipal(req);
        const { name, kind, address, isActive, latitude, longitude } = req.body;
        return db.transaction().execute(async (trx) => {
          const current = await trx.selectFrom('locations').selectAll().where('id', '=', req.params.id).where('org_id', '=', orgOf(principal)).forUpdate().executeTakeFirst();
          if (!current) throw notFound('Точка');
          if (isActive === false && current.is_active) {
            // на отключённой точке запрещены любые операции, остаток нельзя было бы даже списать
            const stock = await trx.selectFrom('batches').select('id').where('location_id', '=', current.id).where('remaining_qty', '>', '0').limit(1).executeTakeFirst();
            if (stock) throw conflict('На точке есть остатки. Спишите или переместите их, затем отключайте точку.', undefined, 'location_has_stock');
          }
          // координаты задаются парой: меняется одна, вторая остаётся прежней, но пара не должна разваливаться
          const nextLat = latitude !== undefined ? latitude : current.latitude === null ? null : Number(current.latitude);
          const nextLon = longitude !== undefined ? longitude : current.longitude === null ? null : Number(current.longitude);
          if ((nextLat === null) !== (nextLon === null)) throw badRequest('Укажите широту и долготу вместе или очистите обе', [{ path: ['longitude'], message: 'Нужна пара' }]);
          const row = await trx
            .updateTable('locations')
            .set({
              ...(latitude !== undefined ? { latitude } : {}),
              ...(longitude !== undefined ? { longitude } : {}),
              ...(name !== undefined ? { name } : {}),
              ...(kind !== undefined ? { kind } : {}),
              ...(address !== undefined ? { address: address === '' ? null : address } : {}),
              ...(isActive !== undefined ? { is_active: isActive } : {}),
            })
            .where('id', '=', req.params.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await writeAudit(trx, {
            action: 'location.update',
            entity: 'location',
            entityId: row.id,
            principal,
            meta: req.meta,
            at: deps.clock(),
            details: { changes: req.body },
          });
          return toLocationDto(row);
        });
      },
    );
  };
