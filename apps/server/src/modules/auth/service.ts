import {
  checkPassword,
  type ChangePasswordBody,
  type LoginBody,
  type RegisterBody,
  type SessionDto,
} from '@zapas/shared';
import { sql, type Transaction } from 'kysely';
import type { Db } from '../../db/client';
import type { Database } from '../../db/types';
import { addMilliseconds } from '../../lib/time';
import { sha256Hex, randomToken } from '../../lib/crypto';
import type { Deps, Principal, RequestMeta } from '../../lib/context';
import { AppError, badRequest, conflict, PG_UNIQUE_VIOLATION, pgCode, unauthorized } from '../../lib/errors';
import { dropTelegramAccess } from '../telegram/links';
import { writeAudit } from '../audit/audit';
import { loadLocationIds, loadUser, toUserDto, type UserRow } from '../users/users';
import { burnVerify, hashPassword, verifyPassword } from './password';
import { signAccessToken } from './tokens';

const MAX_FAILED_ATTEMPTS = 5;
// Блокировка защищает от подбора, но не должна позволять надолго запереть чужую запись: потолок 15 минут
const MAX_LOCK_MINUTES = 15;
/** Повторное предъявление только что ротированного токена считаем гонкой вкладок, а не кражей. */
const REFRESH_GRACE_MS = 10_000;

export interface SessionResult {
  session: SessionDto;
  refreshToken: string;
  refreshExpiresAt: Date;
}

/** Считает неудачную попытку и при необходимости блокирует запись. Возвращает true, если запись заблокирована. */
async function registerFailure(deps: Deps, user: { id: string; email: string }, meta: RequestMeta, now: Date): Promise<boolean> {
  const updated = await deps.db
    .updateTable('users')
    .set({ failed_attempts: sql`failed_attempts + 1`, updated_at: now })
    .where('id', '=', user.id)
    .returning('failed_attempts')
    .executeTakeFirstOrThrow();
  if (updated.failed_attempts < MAX_FAILED_ATTEMPTS) return false;

  const minutes = Math.min(2 ** (updated.failed_attempts - MAX_FAILED_ATTEMPTS), MAX_LOCK_MINUTES);
  await deps.db
    .updateTable('users')
    .set({ locked_until: addMilliseconds(now, minutes * 60_000) })
    .where('id', '=', user.id)
    .execute();
  await writeAudit(deps.db, {
    action: 'auth.locked',
    email: user.email,
    details: { minutes, attempts: updated.failed_attempts },
    meta,
    at: now,
  });
  return true;
}

const INVALID_CREDENTIALS = () =>
  unauthorized('Неверный email или пароль, либо учётная запись временно заблокирована', 'invalid_credentials');

async function issueSession(
  deps: Deps,
  ex: Db | Transaction<Database>,
  user: UserRow,
  locationIds: string[],
  familyId: string,
  meta: RequestMeta,
): Promise<SessionResult & { tokenId: string }> {
  const now = deps.clock();
  const refreshToken = randomToken(32);
  const refreshExpiresAt = addMilliseconds(now, deps.config.refreshTokenTtlDays * 86_400_000);
  const inserted = await ex
    .insertInto('refresh_tokens')
    .values({
      user_id: user.id,
      family_id: familyId,
      token_hash: sha256Hex(refreshToken),
      expires_at: refreshExpiresAt,
      created_at: now,
      user_agent: meta.userAgent?.slice(0, 200) ?? null,
      ip: meta.ip,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const org = await ex.selectFrom('organizations').select('name').where('id', '=', user.org_id).executeTakeFirstOrThrow();

  // токен доступа привязан к семейству сессии: выход или обнаружение кражи отзывают его сразу
  const accessToken = await signAccessToken(deps.config.jwtSecret, { id: user.id, role: user.role, sid: familyId }, deps.config.accessTokenTtl, now);
  return {
    tokenId: inserted.id,
    refreshToken,
    refreshExpiresAt,
    session: {
      accessToken,
      expiresIn: deps.config.accessTokenTtl,
      user: toUserDto(user, locationIds, now, org.name),
    },
  };
}

export async function login(deps: Deps, body: LoginBody, meta: RequestMeta): Promise<SessionResult> {
  const { db } = deps;
  const now = deps.clock();
  const user = await db.selectFrom('users').selectAll().where(sql<boolean>`lower(email) = ${body.email}`).executeTakeFirst();

  const fail = async (reason: string): Promise<never> => {
    await writeAudit(db, {
      action: 'auth.login_failed',
      email: body.email,
      details: { reason },
      meta,
      at: now,
    });
    throw INVALID_CREDENTIALS();
  };

  if (!user) {
    await burnVerify(body.password);
    return fail('unknown_user');
  }
  if (!user.is_active) {
    await burnVerify(body.password);
    return fail('inactive');
  }
  if (user.locked_until && user.locked_until.getTime() > now.getTime()) {
    await burnVerify(body.password);
    return fail('locked');
  }

  const ok = await verifyPassword(user.password_hash, body.password);
  if (!ok) {
    await registerFailure(deps, user, meta, now);
    return fail('bad_password');
  }

  const refreshed = await db
    .updateTable('users')
    .set({ failed_attempts: 0, locked_until: null, last_login_at: now })
    .where('id', '=', user.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  const locationIds = await loadLocationIds(db, user.id);
  const result = await issueSession(deps, db, refreshed, locationIds, crypto.randomUUID(), meta);
  await writeAudit(db, {
    action: 'auth.login',
    entity: 'user',
    entityId: user.id,
    email: user.email,
    details: {},
    meta,
    at: now,
  });
  return result;
}

/** Новая организация и её первый администратор. Дальше он сам создаёт точки и приглашает сотрудников. */
export async function register(deps: Deps, body: RegisterBody, meta: RequestMeta): Promise<SessionResult> {
  const now = deps.clock();
  const passwordHash = await hashPassword(body.password);
  try {
    const user = await deps.db.transaction().execute(async (trx) => {
      const org = await trx.insertInto('organizations').values({ name: body.organizationName }).returning('id').executeTakeFirstOrThrow();
      const created = await trx
        .insertInto('users')
        .values({
          org_id: org.id,
          email: body.email,
          full_name: body.fullName,
          password_hash: passwordHash,
          role: 'admin',
          locked_until: null,
          last_login_at: now,
          password_changed_at: now,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        action: 'org.register',
        entity: 'organization',
        entityId: org.id,
        email: body.email,
        details: { organization: body.organizationName },
        meta,
        at: now,
      });
      return created;
    });
    return await issueSession(deps, deps.db, user, [], crypto.randomUUID(), meta);
  } catch (err) {
    if (pgCode(err) === PG_UNIQUE_VIOLATION) throw conflict('Пользователь с таким email уже есть', undefined, 'duplicate_email');
    throw err;
  }
}

export async function refresh(deps: Deps, rawToken: string, meta: RequestMeta): Promise<SessionResult> {
  const { db } = deps;
  const now = deps.clock();
  const hash = sha256Hex(rawToken);

  // Обмен идёт одной транзакцией: новый токен появляется до того, как старый считается отозванным,
  // поэтому у семейства сессии нет момента без действующего токена, и параллельные запросы не получают 401.
  const outcome = await db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('refresh_tokens')
      .selectAll()
      .where('token_hash', '=', hash)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return { kind: 'invalid' as const };

    const revokeFamily = () =>
      trx
        .updateTable('refresh_tokens')
        .set({ revoked_at: now })
        .where('family_id', '=', row.family_id)
        .where('revoked_at', 'is', null)
        .execute();

    if (row.revoked_at) {
      // отозван выходом, сменой пароля или обнаружением кражи: просто недействителен
      if (row.replaced_by === null) return { kind: 'invalid' as const };
      if (now.getTime() - row.revoked_at.getTime() < REFRESH_GRACE_MS) return { kind: 'conflict' as const };
      // токен уже обменян на новый, а его предъявляют снова: считаем, что он украден
      await revokeFamily();
      return { kind: 'reuse' as const, userId: row.user_id };
    }
    if (row.expires_at.getTime() <= now.getTime()) return { kind: 'invalid' as const };

    const user = await trx.selectFrom('users').selectAll().where('id', '=', row.user_id).executeTakeFirst();
    if (!user || !user.is_active || user.password_changed_at.getTime() > row.created_at.getTime() + 1000) {
      await revokeFamily();
      return { kind: 'invalid' as const };
    }

    const locationIds = (await trx.selectFrom('user_locations').select('location_id').where('user_id', '=', user.id).execute()).map((l) => l.location_id);
    const next = await issueSession(deps, trx, user, locationIds, row.family_id, meta);
    await trx.updateTable('refresh_tokens').set({ revoked_at: now, replaced_by: next.tokenId }).where('id', '=', row.id).execute();
    return { kind: 'rotate' as const, next };
  });

  if (outcome.kind === 'conflict') {
    throw new AppError(401, 'refresh_conflict', 'Сессия обновляется, повторите запрос');
  }
  if (outcome.kind === 'reuse') {
    await writeAudit(db, {
      action: 'auth.refresh_reuse',
      entity: 'user',
      entityId: outcome.userId,
      details: {},
      meta,
      at: now,
    });
    throw unauthorized('Сессия недействительна', 'invalid_session');
  }
  if (outcome.kind === 'invalid') throw unauthorized('Сессия недействительна', 'invalid_session');
  return outcome.next;
}

export async function logout(deps: Deps, rawToken: string | undefined, meta: RequestMeta): Promise<void> {
  if (!rawToken) return;
  const now = deps.clock();
  const row = await deps.db
    .selectFrom('refresh_tokens')
    .select(['family_id', 'user_id'])
    .where('token_hash', '=', sha256Hex(rawToken))
    .executeTakeFirst();
  if (!row) return;
  await deps.db
    .updateTable('refresh_tokens')
    .set({ revoked_at: now })
    .where('family_id', '=', row.family_id)
    .where('revoked_at', 'is', null)
    .execute();
  await writeAudit(deps.db, {
    action: 'auth.logout',
    entity: 'user',
    entityId: row.user_id,
    details: {},
    meta,
    at: now,
  });
}

export async function changePassword(
  deps: Deps,
  principal: Extract<Principal, { kind: 'user' }>,
  body: ChangePasswordBody,
  meta: RequestMeta,
): Promise<void> {
  const loaded = await loadUser(deps.db, principal.id);
  if (!loaded) throw unauthorized();
  const { row } = loaded;

  const now = deps.clock();
  // украденный токен доступа не должен давать подбирать текущий пароль без ограничений
  if (row.locked_until && row.locked_until.getTime() > now.getTime()) {
    throw new AppError(429, 'account_locked', 'Слишком много неудачных попыток. Повторите позже.');
  }
  if (!(await verifyPassword(row.password_hash, body.currentPassword))) {
    const locked = await registerFailure(deps, row, meta, now);
    if (locked) {
      await deps.db
        .updateTable('refresh_tokens')
        .set({ revoked_at: now })
        .where('user_id', '=', row.id)
        .where('revoked_at', 'is', null)
        .execute();
    }
    throw badRequest('Текущий пароль указан неверно', [{ path: ['currentPassword'], message: 'Неверный пароль' }], 'wrong_password');
  }
  const problem = checkPassword(body.newPassword, { email: row.email, fullName: row.full_name });
  if (problem) throw badRequest(problem, [{ path: ['newPassword'], message: problem }], 'weak_password');

  const passwordHash = await hashPassword(body.newPassword);
  await deps.db.transaction().execute(async (trx) => {
    await trx
      .updateTable('users')
      .set({ password_hash: passwordHash, password_changed_at: now, failed_attempts: 0, locked_until: null, must_change_password: false, updated_at: now })
      .where('id', '=', row.id)
      .execute();
    await trx
      .updateTable('refresh_tokens')
      .set({ revoked_at: now })
      .where('user_id', '=', row.id)
      .where('revoked_at', 'is', null)
      .execute();
    await dropTelegramAccess(trx, row.id);
    await writeAudit(trx, {
      action: 'auth.password_changed',
      entity: 'user',
      entityId: row.id,
      principal,
      details: {},
      meta,
      at: now,
    });
  });
}
