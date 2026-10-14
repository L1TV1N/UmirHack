import { createHmac, randomInt, randomUUID } from 'node:crypto';
import {
  looksLikeOneTimeCode,
  looksLikeRecoveryCode,
  normalizeSecondFactor,
  RECOVERY_ALPHABET,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_LENGTH,
  TWO_FACTOR_CODE_LENGTH,
  TWO_FACTOR_MAX_ATTEMPTS,
  TWO_FACTOR_MAX_SENDS,
  TWO_FACTOR_RESEND_SECONDS,
  TWO_FACTOR_TTL_SECONDS,
  type TwoFactorPurpose,
} from '@zapas/shared';
import type { Transaction } from 'kysely';
import type { Db } from '../../db/client';
import type { Database } from '../../db/types';
import type { Deps } from '../../lib/context';
import { safeEqual } from '../../lib/crypto';
import { AppError } from '../../lib/errors';
import { addMilliseconds } from '../../lib/time';
import { escapeHtml } from '../notifications/notifier';
import type { Buttons } from '../telegram/api';
import { linkOfUser } from '../telegram/links';
import type { UserRow } from '../users/users';

/** Больше запросов кода за этот срок на одну запись не отправляем: чужая почта не должна заваливать чат сообщениями. */
const CHALLENGE_WINDOW_MS = 10 * 60_000;
const MAX_CHALLENGES_IN_WINDOW = 8;

export type ChallengePurpose = 'login' | TwoFactorPurpose;

/** Второй фактор доступен только администратору. */
export const isTwoFactorEligible = (role: UserRow['role']): boolean => role === 'admin';

/** Для входа нужен второй фактор: роль подходит и защита включена. */
export const needsSecondFactor = (user: Pick<UserRow, 'role' | 'two_factor_enabled'>): boolean => isTwoFactorEligible(user.role) && user.two_factor_enabled;

const mac = (deps: Deps, scope: string, value: string): string => createHmac('sha256', deps.config.jwtSecret).update(`zapas.2fa:${scope}:${value}`).digest('hex');

/** Код привязан к идентификатору запроса: хэш от одного запроса не подходит к другому. */
const otpHash = (deps: Deps, challengeId: string, code: string): string => mac(deps, 'otp', `${challengeId}:${code}`);
const recoveryHash = (deps: Deps, userId: string, code: string): string => mac(deps, 'recovery', `${userId}:${normalizeSecondFactor(code)}`);

export function newOneTimeCode(): string {
  return String(randomInt(0, 10 ** TWO_FACTOR_CODE_LENGTH)).padStart(TWO_FACTOR_CODE_LENGTH, '0');
}

function newRecoveryCode(): string {
  let out = '';
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i += 1) out += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  return out;
}

const TEXT: Record<ChallengePurpose, string> = {
  login: 'Код для входа в «Запас»',
  enable: 'Код для включения подтверждения входа',
  disable: 'Код для отключения подтверждения входа',
  recovery: 'Код для выпуска новых резервных кодов',
};

function messageFor(purpose: ChallengePurpose, code: string, ip: string | null): string {
  const where = ip ? `\nЗапрос с адреса ${escapeHtml(ip)}.` : '';
  const warn = purpose === 'login' ? '\nЕсли это были не вы, нажмите «Это не я»: вход закроется, а запись заблокируется на 15 минут.' : '';
  return `${TEXT[purpose]}: <b>${code}</b>\nДействует ${TWO_FACTOR_TTL_SECONDS / 60} минут. Никому его не сообщайте, даже сотрудникам.${where}${warn}`;
}

/** Данные кнопки бота: «Это не я» отзывает запрос на вход. */
export const DENY_PREFIX = '2fa-no:';

export interface IssuedChallenge {
  id: string;
  delivered: boolean;
  expiresIn: number;
  resendAfter: number;
}

async function deliver(deps: Deps, userId: string, text: string, buttons?: Buttons): Promise<boolean> {
  const sender = deps.codeSender ?? deps.telegram;
  if (!sender) return false;
  const link = await linkOfUser(deps.db, userId);
  if (!link) return false;
  try {
    await sender.sendMessage(link.chatId, text, buttons);
    return true;
  } catch (err) {
    deps.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'не удалось отправить код подтверждения в Telegram');
    return false;
  }
}

/** Сообщение в чат пользователя без кода: о том, что защита включена, выключена или использован резервный код. */
export async function notifyUser(deps: Deps, userId: string, text: string): Promise<void> {
  await deliver(deps, userId, text);
}

/**
 * Новый запрос кода. Прежний неиспользованный запрос того же назначения заменяется. Код уходит в Telegram;
 * если чата нет или Telegram не отвечает, запрос остаётся, и войти можно по резервному коду.
 */
export async function createChallenge(deps: Deps, user: Pick<UserRow, 'id'>, purpose: ChallengePurpose, ip: string | null): Promise<IssuedChallenge> {
  const now = deps.clock();
  const recent = await deps.db
    .selectFrom('login_challenges')
    .select(({ fn }) => fn.countAll<number>().as('n'))
    .where('user_id', '=', user.id)
    .where('created_at', '>', new Date(now.getTime() - CHALLENGE_WINDOW_MS))
    .executeTakeFirstOrThrow();
  if (Number(recent.n) >= MAX_CHALLENGES_IN_WINDOW) {
    throw new AppError(429, 'too_many_challenges', 'Слишком много запросов кода. Повторите через несколько минут.');
  }

  const id = randomUUID();
  const code = newOneTimeCode();
  await deps.db.transaction().execute(async (trx) => {
    // прежний запрос того же назначения закрываем, но не удаляем: по числу запросов считается ограничение
    await trx.updateTable('login_challenges').set({ consumed_at: now }).where('user_id', '=', user.id).where('purpose', '=', purpose).where('consumed_at', 'is', null).execute();
    await trx
      .insertInto('login_challenges')
      .values({
        id,
        user_id: user.id,
        purpose,
        code_hash: otpHash(deps, id, code),
        ip,
        created_at: now,
        last_sent_at: now,
        expires_at: addMilliseconds(now, TWO_FACTOR_TTL_SECONDS * 1000),
      })
      .execute();
  });
  const buttons: Buttons | undefined = purpose === 'login' ? [[{ text: 'Это не я', data: `${DENY_PREFIX}${id}` }]] : undefined;
  const delivered = await deliver(deps, user.id, messageFor(purpose, code, ip), buttons);
  if (!delivered) await deps.db.updateTable('login_challenges').set({ delivered: false }).where('id', '=', id).execute();
  return { id, delivered, expiresIn: TWO_FACTOR_TTL_SECONDS, resendAfter: TWO_FACTOR_RESEND_SECONDS };
}

/** Повторная отправка кода: не чаще раза в полминуты и не больше трёх раз на запрос. */
export async function resendChallenge(deps: Deps, challengeId: string, ip: string | null): Promise<IssuedChallenge> {
  const now = deps.clock();
  const row = await deps.db.selectFrom('login_challenges').selectAll().where('id', '=', challengeId).executeTakeFirst();
  if (!row || row.consumed_at || row.expires_at.getTime() <= now.getTime() || row.purpose !== 'login') {
    throw new AppError(401, 'invalid_challenge', 'Запрос устарел. Войдите заново.');
  }
  const wait = row.last_sent_at.getTime() + TWO_FACTOR_RESEND_SECONDS * 1000 - now.getTime();
  if (wait > 0) throw new AppError(429, 'resend_too_soon', `Новый код можно запросить через ${Math.ceil(wait / 1000)} с`);
  if (row.sends >= TWO_FACTOR_MAX_SENDS) throw new AppError(429, 'resend_limit', 'Код уже отправлялся три раза. Войдите заново или используйте резервный код.');

  const code = newOneTimeCode();
  await deps.db
    .updateTable('login_challenges')
    .set({ code_hash: otpHash(deps, challengeId, code), sends: row.sends + 1, last_sent_at: now, expires_at: addMilliseconds(now, TWO_FACTOR_TTL_SECONDS * 1000) })
    .where('id', '=', challengeId)
    .execute();
  const delivered = await deliver(deps, row.user_id, messageFor('login', code, ip), [[{ text: 'Это не я', data: `${DENY_PREFIX}${challengeId}` }]]);
  await deps.db.updateTable('login_challenges').set({ delivered }).where('id', '=', challengeId).execute();
  return { id: challengeId, delivered, expiresIn: TWO_FACTOR_TTL_SECONDS, resendAfter: TWO_FACTOR_RESEND_SECONDS };
}

export type CheckResult =
  | { ok: true; user: UserRow; via: 'telegram' | 'recovery'; purpose: ChallengePurpose; recoveryLeft: number }
  | { ok: false; reason: 'invalid' | 'exhausted' | 'wrong'; attemptsLeft: number; user?: { id: string; email: string } };

/**
 * Проверка кода. Запрос и счётчик попыток меняются в одной транзакции под блокировкой строки: два одновременных
 * запроса с верным кодом не пройдут оба, а неверные считаются без потерь. Пять неверных кодов закрывают запрос.
 * Резервный код принимается при входе и при отключении защиты.
 */
export async function checkChallenge(
  deps: Deps,
  challengeId: string,
  rawCode: string,
  purposes: readonly ChallengePurpose[],
  userId?: string,
): Promise<CheckResult> {
  const now = deps.clock();
  const code = normalizeSecondFactor(rawCode);
  return deps.db.transaction().execute(async (trx): Promise<CheckResult> => {
    const ch = await trx.selectFrom('login_challenges').selectAll().where('id', '=', challengeId).forUpdate().executeTakeFirst();
    if (!ch || ch.consumed_at || ch.expires_at.getTime() <= now.getTime() || !purposes.includes(ch.purpose) || (userId && ch.user_id !== userId)) {
      return { ok: false, reason: 'invalid', attemptsLeft: 0 };
    }
    const user = await trx.selectFrom('users').selectAll().where('id', '=', ch.user_id).executeTakeFirst();
    if (!user || !user.is_active) return { ok: false, reason: 'invalid', attemptsLeft: 0 };
    // запись заблокирована (в том числе кнопкой «Это не я»): код ей не поможет
    if (ch.purpose === 'login' && user.locked_until && user.locked_until.getTime() > now.getTime()) return { ok: false, reason: 'invalid', attemptsLeft: 0 };
    if (ch.attempts >= TWO_FACTOR_MAX_ATTEMPTS) return { ok: false, reason: 'exhausted', attemptsLeft: 0, user: { id: user.id, email: user.email } };

    let via: 'telegram' | 'recovery' | null = null;
    if (looksLikeOneTimeCode(code) && safeEqual(otpHash(deps, challengeId, code), ch.code_hash)) via = 'telegram';
    else if (looksLikeRecoveryCode(code) && (ch.purpose === 'login' || ch.purpose === 'disable')) {
      const used = await trx
        .updateTable('recovery_codes')
        .set({ used_at: now })
        .where('user_id', '=', ch.user_id)
        .where('code_hash', '=', recoveryHash(deps, ch.user_id, code))
        .where('used_at', 'is', null)
        .returning('code_hash')
        .executeTakeFirst();
      if (used) via = 'recovery';
    }

    if (!via) {
      await trx.updateTable('login_challenges').set({ attempts: ch.attempts + 1 }).where('id', '=', challengeId).execute();
      return { ok: false, reason: 'wrong', attemptsLeft: Math.max(0, TWO_FACTOR_MAX_ATTEMPTS - ch.attempts - 1), user: { id: user.id, email: user.email } };
    }
    await trx.updateTable('login_challenges').set({ consumed_at: now }).where('id', '=', challengeId).execute();
    const left = await trx
      .selectFrom('recovery_codes')
      .select(({ fn }) => fn.countAll<number>().as('n'))
      .where('user_id', '=', ch.user_id)
      .where('used_at', 'is', null)
      .executeTakeFirstOrThrow();
    return { ok: true, user, via, purpose: ch.purpose, recoveryLeft: Number(left.n) };
  });
}

/** Новый набор резервных кодов вместо прежнего. Возвращает коды открытым текстом: показать их можно только сейчас. */
export async function replaceRecoveryCodes(deps: Deps, trx: Transaction<Database>, userId: string): Promise<string[]> {
  const now = deps.clock();
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODE_COUNT) codes.add(newRecoveryCode());
  await trx.deleteFrom('recovery_codes').where('user_id', '=', userId).execute();
  await trx
    .insertInto('recovery_codes')
    .values([...codes].map((c) => ({ user_id: userId, code_hash: recoveryHash(deps, userId, c), created_at: now })))
    .execute();
  return [...codes];
}

export async function recoveryCodesLeft(db: Db, userId: string): Promise<number> {
  const row = await db
    .selectFrom('recovery_codes')
    .select(({ fn }) => fn.countAll<number>().as('n'))
    .where('user_id', '=', userId)
    .where('used_at', 'is', null)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

/** Выключает защиту и убирает всё, что с ней связано: резервные коды и неиспользованные запросы. */
export async function clearTwoFactor(trx: Transaction<Database>, userId: string, now: Date): Promise<void> {
  await trx.updateTable('users').set({ two_factor_enabled: false, two_factor_enabled_at: null, updated_at: now }).where('id', '=', userId).execute();
  await trx.deleteFrom('recovery_codes').where('user_id', '=', userId).execute();
  await trx.deleteFrom('login_challenges').where('user_id', '=', userId).execute();
}

/** Отзыв запроса на вход кнопкой «Это не я»: запрос закрывается, сессии отзываются, запись блокируется на 15 минут. */
export async function denyChallenge(deps: Deps, challengeId: string, chatId: number): Promise<{ ok: boolean; userId?: string; email?: string }> {
  const now = deps.clock();
  return deps.db.transaction().execute(async (trx) => {
    const ch = await trx.selectFrom('login_challenges').selectAll().where('id', '=', challengeId).forUpdate().executeTakeFirst();
    if (!ch || ch.purpose !== 'login') return { ok: false };
    // нажать может только владелец привязанного чата
    const link = await trx.selectFrom('telegram_links').select('chat_id').where('user_id', '=', ch.user_id).executeTakeFirst();
    if (!link || Number(link.chat_id) !== chatId) return { ok: false };
    const user = await trx
      .updateTable('users')
      .set({ locked_until: addMilliseconds(now, 15 * 60_000), updated_at: now })
      .where('id', '=', ch.user_id)
      .returning(['id', 'email'])
      .executeTakeFirst();
    await trx.updateTable('login_challenges').set({ consumed_at: ch.consumed_at ?? now }).where('id', '=', challengeId).execute();
    await trx.updateTable('refresh_tokens').set({ revoked_at: now }).where('user_id', '=', ch.user_id).where('revoked_at', 'is', null).execute();
    return user ? { ok: true, userId: user.id, email: user.email } : { ok: false };
  });
}
