import {
  checkPassword,
  createUserBody,
  idParam,
  setPasswordBody,
  temporaryPasswordBody,
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
import { sendTemporaryPassword } from '../auth/invite';
import { generatePassword, hashPassword } from '../auth/password';
import { clearTwoFactor, notifyUser } from '../auth/two-factor';
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

    const orgName = async (id: string): Promise<string> =>
      (await db.selectFrom('organizations').select('name').where('id', '=', id).executeTakeFirst())?.name ?? 'ваша организация';

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
        // пароль уходит письмом, если почта настроена; при сбое или без почты администратор видит его на экране
        const invite =
          temporary !== null && body.sendInvite !== false
            ? await sendTemporaryPassword(deps, { email: row.email, fullName: row.full_name, organizationName: await orgName(orgId) }, temporary, 'invite')
            : { sent: false, error: null };
        const dto: CreatedUserDto = { ...(await toDto(row)), temporaryPassword: invite.sent ? null : temporary, inviteSent: invite.sent, inviteError: invite.error };
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

    // Администратор сбрасывает подтверждение входа коллеге, который потерял доступ к Telegram и резервным кодам.
    // Себе защиту выключают через подтверждение, а не через сброс.
    app.post('/users/:id/two-factor/reset', { config: asUser('admin'), schema: { params: idParam } }, async (req, reply) => {
      const principal = requireUser(req);
      if (req.params.id === principal.id) throw badRequest('Свою защиту отключите через подтверждение в профиле', undefined, 'use_disable');
      const now = deps.clock();
      const target = await db.selectFrom('users').select(['id', 'email', 'two_factor_enabled']).where('id', '=', req.params.id).where('org_id', '=', orgOf(principal)).executeTakeFirst();
      if (!target) throw notFound('Пользователь');
      if (!target.two_factor_enabled) throw conflict('У пользователя подтверждение входа не включено', undefined, 'not_enabled');
      await db.transaction().execute(async (trx) => {
        await clearTwoFactor(trx, target.id, now);
        // сессии закрываем: после сброса человек заходит заново и сам решает, включать ли защиту снова
        await trx.updateTable('refresh_tokens').set({ revoked_at: now }).where('user_id', '=', target.id).where('revoked_at', 'is', null).execute();
        await writeAudit(trx, { action: '2fa.reset', entity: 'user', entityId: target.id, principal, meta: req.meta, at: now, details: {} });
      });
      await notifyUser(deps, target.id, 'Администратор сбросил подтверждение входа для вашей записи. Включите его заново в профиле.');
      return reply.status(204).send();
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
          await dropTelegramAccess(trx, target.id, { keepForTwoFactor: true });
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

    // Новый временный пароль: уходит письмом, а если почты нет или она не доставила, виден администратору один раз
    app.post('/users/:id/temporary-password', { config: asUser('admin'), schema: { params: idParam, body: temporaryPasswordBody } }, async (req) => {
      const principal = requireUser(req);
      const now = deps.clock();
      const target = await db.selectFrom('users').select(['id', 'email', 'full_name']).where('id', '=', req.params.id).where('org_id', '=', orgOf(principal)).executeTakeFirst();
      if (!target) throw notFound('Пользователь');
      const temporary = generatePassword({ email: target.email, fullName: target.full_name });
      const passwordHash = await hashPassword(temporary);
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('users')
          .set({ password_hash: passwordHash, password_changed_at: now, failed_attempts: 0, locked_until: null, must_change_password: true, updated_at: now })
          .where('id', '=', target.id)
          .execute();
        await trx.updateTable('refresh_tokens').set({ revoked_at: now }).where('user_id', '=', target.id).where('revoked_at', 'is', null).execute();
        await dropTelegramAccess(trx, target.id, { keepForTwoFactor: true });
        await writeAudit(trx, { action: 'user.password_reset', entity: 'user', entityId: target.id, principal, meta: req.meta, at: now, details: { byEmail: req.body.sendInvite !== false } });
      });
      const invite =
        req.body.sendInvite !== false
          ? await sendTemporaryPassword(deps, { email: target.email, fullName: target.full_name, organizationName: await orgName(orgOf(principal)) }, temporary, 'reset')
          : { sent: false, error: null };
      return { temporaryPassword: invite.sent ? null : temporary, inviteSent: invite.sent, inviteError: invite.error };
    });

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
