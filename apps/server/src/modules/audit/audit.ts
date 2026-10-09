import type { AuditEntryDto, AuditVerifyDto } from '@zapas/shared';
import { sql, type Transaction } from 'kysely';
import type { Db } from '../../db/client';
import type { Database } from '../../db/types';
import { canonicalJson, sha256Hex } from '../../lib/crypto';
import type { Principal, RequestMeta } from '../../lib/context';

const GENESIS = '0'.repeat(64);
const CHAIN_LOCK = 4_815_162_342;

export interface AuditInput {
  action: string;
  entity?: string;
  entityId?: string;
  details?: Record<string, unknown>;
  principal?: Principal | null;
  /** Для событий без пользователя, например неудачного входа. */
  email?: string | null;
  meta?: RequestMeta | null;
  at?: Date;
}

type Executor = Db | Transaction<Database>;

interface HashFields {
  prev: string;
  at: Date;
  userId: string | null;
  email: string | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  ip: string | null;
  details: unknown;
}

function hashEntry(f: HashFields): string {
  return sha256Hex(
    canonicalJson([f.prev, f.at.toISOString(), f.userId, f.email, f.action, f.entity, f.entityId, f.ip, f.details]),
  );
}

/**
 * Пишет запись аудита с продолжением цепочки хэшей. Блокировка цепочки держится до конца
 * транзакции, поэтому вызывать нужно как можно позже, когда остальная работа уже сделана.
 */
export async function writeAudit(executor: Executor, input: AuditInput): Promise<void> {
  const principal = input.principal ?? null;
  const userId = principal?.kind === 'user' ? principal.id : null;
  const email = principal?.kind === 'user' ? principal.email : (input.email ?? null);
  const at = input.at ?? new Date();
  const details = JSON.parse(JSON.stringify(input.details ?? {})) as unknown;
  const ip = input.meta?.ip ?? null;

  const write = async (trx: Transaction<Database>): Promise<void> => {
    await sql`SELECT pg_advisory_xact_lock(${CHAIN_LOCK})`.execute(trx);
    const last = await trx.selectFrom('audit_log').select('hash').orderBy('id', 'desc').limit(1).executeTakeFirst();
    const prev = last?.hash ?? GENESIS;
    const hash = hashEntry({
      prev,
      at,
      userId,
      email,
      action: input.action,
      entity: input.entity ?? null,
      entityId: input.entityId ?? null,
      ip,
      details,
    });
    await trx
      .insertInto('audit_log')
      .values({
        at,
        user_id: userId,
        user_email: email,
        action: input.action,
        entity: input.entity ?? null,
        entity_id: input.entityId ?? null,
        ip,
        user_agent: input.meta?.userAgent?.slice(0, 200) ?? null,
        details: JSON.stringify(details),
        prev_hash: prev,
        hash,
      })
      .execute();
  };

  if ('isTransaction' in executor && executor.isTransaction) {
    await write(executor as Transaction<Database>);
  } else {
    await (executor as Db).transaction().execute(write);
  }
}

export async function verifyAuditChain(db: Db): Promise<AuditVerifyDto> {
  let prev = GENESIS;
  let checked = 0;
  let lastId = 0;
  for (;;) {
    const rows = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('id', '>', lastId)
      .orderBy('id')
      .limit(1000)
      .execute();
    if (rows.length === 0) break;
    for (const r of rows) {
      const expected = hashEntry({
        prev: r.prev_hash,
        at: r.at,
        userId: r.user_id,
        email: r.user_email,
        action: r.action,
        entity: r.entity,
        entityId: r.entity_id,
        ip: r.ip,
        details: r.details,
      });
      if (r.prev_hash !== prev || r.hash !== expected) {
        return { ok: false, checked, brokenAt: r.id };
      }
      prev = r.hash;
      checked += 1;
      lastId = r.id;
    }
  }
  return { ok: true, checked, brokenAt: null };
}

export interface AuditFilter {
  action?: string;
  userEmail?: string;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
  tz: string;
}

export async function listAudit(db: Db, f: AuditFilter): Promise<{ items: AuditEntryDto[]; total: number }> {
  let q = db.selectFrom('audit_log');
  if (f.action) q = q.where('action', 'like', `${f.action.replace(/[%_\\]/g, '\\$&')}%`);
  if (f.userEmail) q = q.where('user_email', 'ilike', `%${f.userEmail.replace(/[%_\\]/g, '\\$&')}%`);
  if (f.from) q = q.where(sql<boolean>`(at AT TIME ZONE ${f.tz})::date >= ${f.from}::date`);
  if (f.to) q = q.where(sql<boolean>`(at AT TIME ZONE ${f.tz})::date <= ${f.to}::date`);

  const total = await q.select(sql<number>`count(*)`.as('n')).executeTakeFirstOrThrow();
  const rows = await q.selectAll().orderBy('id', 'desc').limit(f.limit).offset(f.offset).execute();
  return {
    total: Number(total.n),
    items: rows.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      userEmail: r.user_email,
      action: r.action,
      entity: r.entity,
      entityId: r.entity_id,
      ip: r.ip,
      details: r.details,
      hash: r.hash,
    })),
  };
}
