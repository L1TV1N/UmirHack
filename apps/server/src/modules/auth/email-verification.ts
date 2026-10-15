import { createHmac, randomInt, randomUUID } from 'node:crypto';
import {
  EMAIL_CODE_LENGTH,
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_CODE_RESEND_SECONDS,
  EMAIL_CODE_TTL_SECONDS,
  type EmailVerificationPendingDto,
} from '@zapas/shared';
import { sql } from 'kysely';
import type { Deps } from '../../lib/context';
import { safeEqual } from '../../lib/crypto';
import { AppError } from '../../lib/errors';
import { addMilliseconds } from '../../lib/time';
import { describeMailError } from '../orders/mailer';
import type { UserRow } from '../users/users';

const WINDOW_MS = 10 * 60_000;
const MAX_CODES_IN_WINDOW = 6;

/** Почту подтверждают, когда сервер умеет отправлять письма: без SMTP код доставить нечем. */
export const emailVerificationEnabled = (deps: Pick<Deps, 'mailer' | 'config'>): boolean => Boolean(deps.mailer && deps.config.smtp);

export const needsEmailVerification = (deps: Pick<Deps, 'mailer' | 'config'>, user: Pick<UserRow, 'email_verified_at'>): boolean =>
  emailVerificationEnabled(deps) && user.email_verified_at === null;

const hash = (deps: Deps, codeId: string, code: string): string =>
  createHmac('sha256', deps.config.jwtSecret).update(`zapas.email:${codeId}:${code}`).digest('hex');

const newCode = (): string => String(randomInt(0, 10 ** EMAIL_CODE_LENGTH)).padStart(EMAIL_CODE_LENGTH, '0');

function letter(code: string, fullName: string): { subject: string; text: string } {
  return {
    subject: 'Код подтверждения почты в «Запасе»',
    text: [
      `Здравствуйте, ${fullName}!`,
      '',
      `Код для подтверждения почты: ${code}`,
      `Он действует ${EMAIL_CODE_TTL_SECONDS / 60} минут. Никому его не сообщайте.`,
      '',
      'Если вы не регистрировались в «Запасе», просто проигнорируйте это письмо.',
    ].join('\n'),
  };
}

const pending = (email: string, delivered: boolean): EmailVerificationPendingDto => ({
  emailVerificationRequired: true,
  email,
  delivered,
  expiresIn: EMAIL_CODE_TTL_SECONDS,
  resendAfter: EMAIL_CODE_RESEND_SECONDS,
});

/**
 * Новый код на почту. Прежний неиспользованный закрывается. Если письмо не ушло, код остаётся в базе,
 * но войти с ним нельзя без письма, поэтому человек просто запросит его снова.
 */
export async function sendEmailCode(deps: Deps, user: Pick<UserRow, 'id' | 'email' | 'full_name'>): Promise<EmailVerificationPendingDto> {
  const now = deps.clock();
  const recent = await deps.db
    .selectFrom('email_codes')
    .select(({ fn }) => fn.countAll<number>().as('n'))
    .where('user_id', '=', user.id)
    .where('created_at', '>', new Date(now.getTime() - WINDOW_MS))
    .executeTakeFirstOrThrow();
  if (Number(recent.n) >= MAX_CODES_IN_WINDOW) throw new AppError(429, 'too_many_codes', 'Слишком много запросов кода. Повторите через несколько минут.');

  const id = randomUUID();
  const code = newCode();
  await deps.db.transaction().execute(async (trx) => {
    await trx.updateTable('email_codes').set({ consumed_at: now }).where('user_id', '=', user.id).where('consumed_at', 'is', null).execute();
    await trx
      .insertInto('email_codes')
      .values({ id, user_id: user.id, code_hash: hash(deps, id, code), created_at: now, last_sent_at: now, expires_at: addMilliseconds(now, EMAIL_CODE_TTL_SECONDS * 1000) })
      .execute();
  });
  let delivered = false;
  try {
    await deps.mailer?.send({ to: user.email, ...letter(code, user.full_name) });
    delivered = Boolean(deps.mailer);
  } catch (err) {
    deps.log.warn({ reason: describeMailError(err) }, 'не удалось отправить код подтверждения почты');
  }
  return pending(user.email, delivered);
}

/** Повторная отправка. Ответ одинаков для любого адреса, чтобы по нему нельзя было узнать, кто зарегистрирован. */
export async function resendEmailCode(deps: Deps, email: string): Promise<{ resendAfter: number }> {
  const now = deps.clock();
  const user = await deps.db.selectFrom('users').selectAll().where(sql<boolean>`lower(email) = ${email}`).executeTakeFirst();
  if (user && user.is_active && needsEmailVerification(deps, user)) {
    const last = await deps.db
      .selectFrom('email_codes')
      .select('last_sent_at')
      .where('user_id', '=', user.id)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    const wait = last ? last.last_sent_at.getTime() + EMAIL_CODE_RESEND_SECONDS * 1000 - now.getTime() : 0;
    if (wait <= 0) await sendEmailCode(deps, user);
  }
  return { resendAfter: EMAIL_CODE_RESEND_SECONDS };
}

export type ConfirmResult = { ok: true; user: UserRow } | { ok: false; reason: 'invalid' | 'exhausted' | 'wrong'; attemptsLeft: number };

/** Проверка кода. Попытки считаются в той же транзакции под блокировкой строки: параллельный перебор ничего не выигрывает. */
export async function confirmEmailCode(deps: Deps, email: string, rawCode: string): Promise<ConfirmResult> {
  const now = deps.clock();
  const code = rawCode.trim();
  return deps.db.transaction().execute(async (trx): Promise<ConfirmResult> => {
    const user = await trx.selectFrom('users').selectAll().where(sql<boolean>`lower(email) = ${email}`).executeTakeFirst();
    if (!user || !user.is_active) return { ok: false, reason: 'invalid', attemptsLeft: 0 };
    if (user.email_verified_at) return { ok: false, reason: 'invalid', attemptsLeft: 0 };
    const row = await trx
      .selectFrom('email_codes')
      .selectAll()
      .where('user_id', '=', user.id)
      .where('consumed_at', 'is', null)
      .orderBy('created_at', 'desc')
      .limit(1)
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.expires_at.getTime() <= now.getTime()) return { ok: false, reason: 'invalid', attemptsLeft: 0 };
    if (row.attempts >= EMAIL_CODE_MAX_ATTEMPTS) return { ok: false, reason: 'exhausted', attemptsLeft: 0 };
    if (!safeEqual(hash(deps, row.id, code), row.code_hash)) {
      await trx.updateTable('email_codes').set({ attempts: row.attempts + 1 }).where('id', '=', row.id).execute();
      return { ok: false, reason: 'wrong', attemptsLeft: Math.max(0, EMAIL_CODE_MAX_ATTEMPTS - row.attempts - 1) };
    }
    await trx.updateTable('email_codes').set({ consumed_at: now }).where('id', '=', row.id).execute();
    const verified = await trx.updateTable('users').set({ email_verified_at: now, updated_at: now }).where('id', '=', user.id).returningAll().executeTakeFirstOrThrow();
    return { ok: true, user: verified };
  });
}
