import { randomInt } from 'node:crypto';
import type { Transaction } from 'kysely';
import type { Db } from '../../db/client';
import type { Database } from '../../db/types';
import { sha256Hex } from '../../lib/crypto';
import type { Deps, Principal } from '../../lib/context';
import { pgCode, PG_UNIQUE_VIOLATION } from '../../lib/errors';
import { writeAudit } from '../audit/audit';
import { loadUser, userPrincipal, type UserRow } from '../users/users';

/** Без похожих знаков (0 и O, 1 и I): код вводят и читают с экрана. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
export const CODE_TTL_MS = 10 * 60_000;

const BOT_META = { ip: null, userAgent: 'telegram-bot', requestId: 'telegram' } as const;

function newCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** Код вводят руками: пробелы, дефисы и регистр не должны мешать. */
export function normalizeCode(value: string): string {
  return value.replace(/[\s-]/g, '').toUpperCase();
}

export function looksLikeCode(value: string): boolean {
  return value.length === CODE_LENGTH && [...value].every((ch) => ALPHABET.includes(ch));
}

/** Новый код привязки. Прежний код пользователя перестаёт действовать. */
export async function createLinkCode(deps: Deps, userId: string): Promise<{ code: string; expiresAt: Date }> {
  const now = deps.clock();
  const code = newCode();
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
  await deps.db.transaction().execute(async (trx) => {
    await trx.deleteFrom('telegram_link_codes').where((eb) => eb.or([eb('user_id', '=', userId), eb('expires_at', '<', now)])).execute();
    await trx.insertInto('telegram_link_codes').values({ code_hash: sha256Hex(code), user_id: userId, expires_at: expiresAt }).execute();
  });
  return { code, expiresAt };
}

export type LinkResult =
  | { ok: true; user: UserRow; replaced: boolean }
  | { ok: false; reason: 'invalid' | 'inactive' | 'chat_taken' | 'two_factor' };

/** Погашает код и привязывает чат. Код одноразовый, его проверка и погашение идут одной транзакцией. */
export async function consumeLinkCode(deps: Deps, rawCode: string, chat: { id: number; username?: string | undefined }): Promise<LinkResult> {
  const now = deps.clock();
  const code = normalizeCode(rawCode);
  if (!looksLikeCode(code)) return { ok: false, reason: 'invalid' };

  try {
    return await deps.db.transaction().execute(async (trx): Promise<LinkResult> => {
      const found = await trx
        .deleteFrom('telegram_link_codes')
        .where('code_hash', '=', sha256Hex(code))
        .where('expires_at', '>', now)
        .returning('user_id')
        .executeTakeFirst();
      if (!found) return { ok: false, reason: 'invalid' };

      const loaded = await loadUser(trx as unknown as Db, found.user_id);
      if (!loaded || !loaded.row.is_active) return { ok: false, reason: 'inactive' };

      // чат нельзя подменить, пока он служит вторым фактором: сначала защиту выключают, подтвердив её кодом
      if (loaded.row.two_factor_enabled) return { ok: false, reason: 'two_factor' };

      const taken = await trx.selectFrom('telegram_links').select('user_id').where('chat_id', '=', String(chat.id)).executeTakeFirst();
      if (taken && taken.user_id !== found.user_id) return { ok: false, reason: 'chat_taken' };

      const previous = await trx.selectFrom('telegram_links').select('chat_id').where('user_id', '=', found.user_id).executeTakeFirst();
      await trx
        .insertInto('telegram_links')
        .values({ user_id: found.user_id, chat_id: chat.id, username: chat.username ?? null, linked_at: now })
        .onConflict((oc) => oc.column('user_id').doUpdateSet({ chat_id: chat.id, username: chat.username ?? null, linked_at: now }))
        .execute();
      await writeAudit(trx, {
        action: 'telegram.link',
        entity: 'user',
        entityId: found.user_id,
        principal: userPrincipal(loaded),
        meta: BOT_META,
        at: now,
        details: { replaced: Boolean(previous) },
      });
      return { ok: true, user: loaded.row, replaced: Boolean(previous) };
    });
  } catch (err) {
    // два чата одновременно предъявили разные коды одного человека, или один чат успел занять другой
    if (pgCode(err) === PG_UNIQUE_VIOLATION) return { ok: false, reason: 'chat_taken' };
    throw err;
  }
}

export interface LinkedChat {
  userId: string;
  chatId: number;
  username: string | null;
  linkedAt: Date;
}

export async function linkOfUser(db: Db, userId: string): Promise<LinkedChat | null> {
  const row = await db.selectFrom('telegram_links').selectAll().where('user_id', '=', userId).executeTakeFirst();
  return row ? { userId: row.user_id, chatId: Number(row.chat_id), username: row.username, linkedAt: row.linked_at } : null;
}

/** Пользователь, чей чат пишет боту, вместе с его правами. Отключённого пользователя бот не слушает. */
export async function principalOfChat(deps: Deps, chatId: number): Promise<{ principal: Principal; row: UserRow } | 'inactive' | null> {
  const link = await deps.db.selectFrom('telegram_links').select('user_id').where('chat_id', '=', String(chatId)).executeTakeFirst();
  if (!link) return null;
  const loaded = await loadUser(deps.db, link.user_id);
  if (!loaded || !loaded.row.is_active) {
    await deps.db.deleteFrom('telegram_links').where('chat_id', '=', String(chatId)).execute();
    return 'inactive';
  }
  return { principal: userPrincipal(loaded), row: loaded.row };
}

/**
 * Отвязка внутри чужой транзакции: смена пароля и отключение учётной записи уничтожают и этот доступ.
 * Чат, который служит вторым фактором, при смене пароля остаётся (keepForTwoFactor): иначе после смены пароля
 * администратор остался бы без защиты. При настоящей отвязке подтверждение входа выключается вместе с чатом.
 */
export async function dropTelegramAccess(trx: Transaction<Database>, userId: string, options: { keepForTwoFactor?: boolean } = {}): Promise<boolean> {
  if (options.keepForTwoFactor) {
    const user = await trx.selectFrom('users').select('two_factor_enabled').where('id', '=', userId).executeTakeFirst();
    if (user?.two_factor_enabled) return false;
  }
  const removed = await trx.deleteFrom('telegram_links').where('user_id', '=', userId).returning('user_id').execute();
  await trx.deleteFrom('telegram_link_codes').where('user_id', '=', userId).execute();
  await trx.updateTable('users').set({ two_factor_enabled: false, two_factor_enabled_at: null }).where('id', '=', userId).where('two_factor_enabled', '=', true).execute();
  await trx.deleteFrom('recovery_codes').where('user_id', '=', userId).execute();
  await trx.deleteFrom('login_challenges').where('user_id', '=', userId).execute();
  return removed.length > 0;
}

/** Отвязка по просьбе пользователя. Пока включено подтверждение входа, чат отвязать нельзя. */
export async function unlink(deps: Deps, userId: string, principal: Principal | null, meta: typeof BOT_META | import('../../lib/context').RequestMeta): Promise<boolean | 'two_factor'> {
  return deps.db.transaction().execute(async (trx) => {
    const user = await trx.selectFrom('users').select('two_factor_enabled').where('id', '=', userId).forUpdate().executeTakeFirst();
    if (user?.two_factor_enabled) return 'two_factor';
    const had = await dropTelegramAccess(trx, userId);
    if (had) {
      await writeAudit(trx, { action: 'telegram.unlink', entity: 'user', entityId: userId, principal, meta, at: deps.clock(), details: {} });
    }
    return had;
  });
}

export async function purgeExpiredCodes(db: Db, now: Date): Promise<void> {
  await db.deleteFrom('telegram_link_codes').where('expires_at', '<', now).execute();
  // запросы кода для входа живут пять минут, сутки храним для разбора инцидентов
  await db.deleteFrom('login_challenges').where('expires_at', '<', new Date(now.getTime() - 24 * 3_600_000)).execute();
  await db.deleteFrom('recovery_codes').where('used_at', '<', new Date(now.getTime() - 90 * 86_400_000)).execute();
}

export { BOT_META };
