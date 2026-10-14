import {
  checkPassword,
  createUserBody,
  idParam,
  setPasswordBody,
  updateUserBody,
  usersQuery,
  type CreatedUserDto,
  type UserDto,
} from '@zapas/shared';
import { sql, type Transaction } from 'kysely';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Database } from '../../db/types';
import type { Deps } from '../../lib/context';
import { badRequest, conflict, notFound, PG_UNIQUE_VIOLATION, pgCode } from '../../lib/errors';
import { asUser, requireUser } from '../../plugins/access';
import { orgOf } from '../../lib/scope';
import { dropTelegramAccess } from '../telegram/links';
import { writeAudit } from '../audit/audit';
import { generatePassword, hashPassword } from '../auth/password';
import { loadLocationIds, toUserDto, type UserRow } from './users';

export const userRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;

    async function assertLocationsExist(trx: Transaction<Database>, orgId: string, ids: string[]): Promise<void> {
      if (ids.length === 0) return;
      const found = await trx.selectFrom('locations').select('id').where('org_id', '=', orgId).where('id', 'in', ids).execute();
      if (found.length !== new Set(ids).size) {
        throw badRequest('Указана несуществующая точка', [{ path: ['locationIds'], message: 'Точка не найдена' }]);
      }
    }

    async function replaceLocations(trx: Transaction<Database>, userId: string, ids: string[]): Promise<void> {
      await trx.deleteFrom('user_locations').where('user_id', '=', userId).execute();
      if (ids.length > 0) {
        await trx
          .insertInto('user_locations')
          .values([...new Set(ids)].map((location_id) => ({ user_id: userId, location_id })))
          .execute();
      }
    }

    async function toDto(row: UserRow): Promise<UserDto> {
      return toUserDto(row, await loadLocationIds(db, row.id), deps.clock());
    }

    /** Нельзя оставить систему без действующего администратора. */
    async function assertNotLastAdmin(trx: Transaction<Database>, orgId: string, id: string): Promise<void> {
      const others = await trx
        .selectFrom('users')
        .select(sql<number>`count(*)`.as('n'))
        .where('org_id', '=', orgId)
        .where('role', '=', 'admin')
        .where('is_active', '=', true)
        .where('id', '<>', id)
        .executeTakeFirstOrThrow();
      if (Number(others.n) === 0) {
        throw conflict('Нельзя отключить или понизить последнего администратора', undefined, 'last_admin');
      }
    }

    app.get('/users', { config: asUser('admin'), schema: { querystring: usersQuery } }, async (req) => {
      const { q, limit, offset } = req.query;
      let base = db.selectFrom('users').where('org_id', '=', orgOf(requireUser(req)));
      if (q) {
        const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
        base = base.where((eb) => eb.or([eb('email', 'ilike', like), eb('full_name', 'ilike', like)]));
      }
      const total = await base.select(sql<number>`count(*)`.as('n')).executeTakeFirstOrThrow();
      const rows = await base.selectAll().orderBy('full_name').limit(limit).offset(offset).execute();
      const links = rows.length
        ? await db.selectFrom('user_locations').selectAll().where('user_id', 'in', rows.map((r) => r.id)).execute()
        : [];
      const now = deps.clock();
      return {
        total: Number(total.n),
        limit,
        offset,
        items: rows.map((r) =>
          toUserDto(
            r,
            links.filter((l) => l.user_id === r.id).map((l) => l.location_id),
            now,
          ),
        ),
      };
    });

    app.post('/users', { config: asUser('admin'), schema: { body: createUserBody } }, async (req, reply) => {
      const principal = requireUser(req);
      const orgId = orgOf(principal);
      const body = req.body;
      // без пароля создаём временный: показываем его один раз, а при первом входе человек выберет свой
      const temporary = body.password === undefined ? generatePassword({ email: body.email, fullName: body.fullName }) : null;
      const passwordHash = await hashPassword(body.password ?? (temporary as string));
      const now = deps.clock();
      try {
        const row = await db.transaction().execute(async (trx) => {
          await assertLocationsExist(trx, orgId, body.locationIds);
          const created = await trx
            .insertInto('users')
            .values({
              org_id: orgId,
              email: body.email,
              full_name: body.fullName,
              password_hash: passwordHash,
              role: body.role,
              must_change_password: true,
              locked_until: null,
              last_login_at: null,
              password_changed_at: now,
              created_at: now,
              updated_at: now,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await replaceLocations(trx, created.id, body.locationIds);
          await writeAudit(trx, {
            action: 'user.create',
            entity: 'user',
            entityId: created.id,
            principal,
            meta: req.meta,
            at: now,
            details: { email: created.email, role: created.role, locationIds: body.locationIds, generatedPassword: temporary !== null },
          });
          return created;
        });
        const dto: CreatedUserDto = { ...(await toDto(row)), temporaryPassword: temporary };
        return reply.status(201).send(dto);
      } catch (err) {
        if (pgCode(err) === PG_UNIQUE_VIOLATION) throw conflict('Пользователь с таким email уже есть', undefined, 'duplicate_email');
        throw err;
      }
    });

    app.patch('/users/:id', { config: asUser('admin'), schema: { params: idParam, body: updateUserBody } }, async (req) => {
      const principal = requireUser(req);
      const { fullName, role, isActive, locationIds } = req.body;
      const now = deps.clock();
      const row = await db.transaction().execute(async (trx) => {
        const current = await trx.selectFrom('users').selectAll().where('id', '=', req.params.id).where('org_id', '=', orgOf(principal)).forUpdate().executeTakeFirst();
        if (!current) throw notFound('Пользователь');

        const losesAdmin =
          current.role === 'admin' && current.is_active && ((role !== undefined && role !== 'admin') || isActive === false);
        if (losesAdmin) await assertNotLastAdmin(trx, current.org_id, current.id);
        if (locationIds) await assertLocationsExist(trx, current.org_id, locationIds);

        const updated = await trx
          .updateTable('users')
          .set({
            ...(fullName !== undefined ? { full_name: fullName } : {}),
            ...(role !== undefined ? { role } : {}),
            ...(isActive !== undefined ? { is_active: isActive } : {}),
            updated_at: now,
          })
          .where('id', '=', current.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        if (locationIds) await replaceLocations(trx, current.id, locationIds);
        if (isActive === false) {
          await trx
            .updateTable('refresh_tokens')
            .set({ revoked_at: now })
            .where('user_id', '=', current.id)
            .where('revoked_at', 'is', null)
            .execute();
          await dropTelegramAccess(trx, current.id);
        }
        await writeAudit(trx, {
          action: 'user.update',
          entity: 'user',
          entityId: current.id,
          principal,
          meta: req.meta,
          at: now,
          details: { changes: req.body, previousRole: current.role, previousActive: current.is_active },
        });
        return updated;
      });
      return toDto(row);
    });

    app.put(
      '/users/:id/password',
      { config: asUser('admin'), schema: { params: idParam, body: setPasswordBody } },
      async (req, reply) => {
        const principal = requireUser(req);
        const now = deps.clock();
        const target = await db.selectFrom('users').select(['id', 'email', 'full_name']).where('id', '=', req.params.id).where('org_id', '=', orgOf(principal)).executeTakeFirst();
        if (!target) throw notFound('Пользователь');
        const problem = checkPassword(req.body.password, { email: target.email, fullName: target.full_name });
        if (problem) throw badRequest(problem, [{ path: ['password'], message: problem }], 'weak_password');
        const passwordHash = await hashPassword(req.body.password);
        await db.transaction().execute(async (trx) => {
          await trx
            .updateTable('users')
            .set({ password_hash: passwordHash, password_changed_at: now, failed_attempts: 0, locked_until: null, must_change_password: true, updated_at: now })
            .where('id', '=', target.id)
            .execute();
          await trx
            .updateTable('refresh_tokens')
            .set({ revoked_at: now })
            .where('user_id', '=', target.id)
            .where('revoked_at', 'is', null)
            .execute();
          // чат Telegram тоже доступ к данным: после сброса пароля его нужно привязать заново
          await dropTelegramAccess(trx, target.id);
          await writeAudit(trx, {
            action: 'user.password_set',
            entity: 'user',
            entityId: target.id,
            principal,
            meta: req.meta,
            at: now,
            details: {},
          });
        });
        return reply.status(204).send();
      },
    );

    app.post('/users/:id/unlock', { config: asUser('admin'), schema: { params: idParam } }, async (req) => {
      const principal = requireUser(req);
      const now = deps.clock();
      const row = await db.transaction().execute(async (trx) => {
        const updated = await trx
          .updateTable('users')
          .set({ failed_attempts: 0, locked_until: null, updated_at: now })
          .where('id', '=', req.params.id)
          .where('org_id', '=', orgOf(principal))
          .returningAll()
          .executeTakeFirst();
        if (!updated) throw notFound('Пользователь');
        await writeAudit(trx, {
          action: 'user.unlock',
          entity: 'user',
          entityId: updated.id,
          principal,
          meta: req.meta,
          at: now,
          details: {},
        });
        return updated;
      });
      return toDto(row);
    });
  };
