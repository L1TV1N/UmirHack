import type { ExchangeDocKind, ExchangeJobDto, ExchangeMissingDto, ExternalSystemDto, LinkEntity, OneCProfile } from '@zapas/shared';
import { oneCProfile } from '@zapas/shared';
import { sql, type Selectable, type Transaction } from 'kysely';
import type { Database, ExternalSystemsTable } from '../../db/types';
import type { Deps } from '../../lib/context';
import { decryptSecret } from '../../lib/crypto';
import { checkConnection, findByCode, OneCError, planDocument, sendDocument, type CanonicalDoc, type Connection, type Refs } from './onec';
import { describeExchangeError } from './transport';

type SystemRow = Selectable<ExternalSystemsTable>;

/** Паузы перед повторами: после каждой неудачи ждём дольше. Шесть попыток всего. */
export const EXCHANGE_RETRY_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000];
const LEASE_MS = 2 * 60_000;
const BATCH = 10;

export function parseProfile(raw: unknown): OneCProfile {
  return oneCProfile.parse(raw);
}

export function connectionOf(deps: Deps, row: SystemRow): Connection {
  return {
    baseUrl: row.base_url,
    username: row.username,
    password: row.secret_enc ? decryptSecret(deps.config.jwtSecret, row.secret_enc) : null,
    profile: parseProfile(row.profile),
  };
}

export async function toSystemDto(deps: Deps, row: SystemRow): Promise<ExternalSystemDto> {
  const loc = row.location_id ? await deps.db.selectFrom('locations').select('name').where('id', '=', row.location_id).executeTakeFirst() : null;
  const counts = await deps.db
    .selectFrom('exchange_jobs')
    .select(['status', (eb) => eb.fn.countAll<string>().as('n')])
    .where('system_id', '=', row.id)
    .groupBy('status')
    .execute();
  const n = (s: string) => Number(counts.find((c) => c.status === s)?.n ?? 0);
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    baseUrl: row.base_url,
    username: row.username,
    hasPassword: Boolean(row.secret_enc),
    profile: parseProfile(row.profile),
    docKinds: row.doc_kinds as ExchangeDocKind[],
    locationId: row.location_id,
    locationName: loc?.name ?? null,
    enabled: row.enabled,
    lastOkAt: row.last_ok_at?.toISOString() ?? null,
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
    counts: { pending: n('pending'), blocked: n('blocked'), failed: n('failed'), done: n('done') },
  };
}

/** Ставит выгрузку документа во все подходящие системы. Вызывается внутри транзакции проведения, поэтому документ и задание появляются вместе. */
export async function enqueueExchange(trx: Transaction<Database>, doc: { id: string; kind: string; locationId: string; toLocationId?: string | null }, now: Date): Promise<number> {
  if (!['receipt', 'writeoff', 'transfer', 'inventory'].includes(doc.kind)) return 0;
  const systems = await trx
    .selectFrom('external_systems')
    .select('id')
    .where('enabled', '=', true)
    .where(sql<boolean>`${doc.kind} = ANY(doc_kinds)`)
    .where((eb) => eb.or([eb('location_id', 'is', null), eb('location_id', '=', doc.locationId), ...(doc.toLocationId ? [eb('location_id', '=', doc.toLocationId)] : [])]))
    .execute();
  for (const s of systems) {
    await trx
      .insertInto('exchange_jobs')
      .values({ system_id: s.id, document_id: doc.id, next_attempt_at: now, created_at: now })
      .onConflict((oc) => oc.columns(['system_id', 'document_id']).doNothing())
      .execute();
  }
  return systems.length;
}

export async function loadCanonical(deps: Deps, documentId: string): Promise<CanonicalDoc | null> {
  const doc = await deps.db
    .selectFrom('documents as d')
    .innerJoin('locations as l', 'l.id', 'd.location_id')
    .leftJoin('locations as tl', 'tl.id', 'd.to_location_id')
    .select(['d.id', 'd.number', 'd.kind', 'd.created_at', 'd.comment', 'l.id as lid', 'l.name as lname', 'tl.id as tid', 'tl.name as tname'])
    .where('d.id', '=', documentId)
    .executeTakeFirst();
  if (!doc) return null;
  const rows = await deps.db
    .selectFrom('stock_movements as m')
    .innerJoin('products as p', 'p.id', 'm.product_id')
    .innerJoin('batches as b', 'b.id', 'm.batch_id')
    .leftJoin('suppliers as s', 's.id', 'b.supplier_id')
    .select(['m.type', 'm.quantity', 'm.unit_cost', 'p.id as product_id', 'p.sku', 'p.name', 'p.unit', 'b.expires_on', 's.id as sid', 's.name as sname', 's.inn as sinn'])
    .where('m.document_id', '=', documentId)
    .orderBy('m.id')
    .execute();
  const wantType = doc.kind === 'receipt' ? 'receipt' : doc.kind === 'writeoff' ? 'writeoff' : doc.kind === 'transfer' ? 'transfer_out' : 'adjustment_out';
  const toLine = (r: (typeof rows)[number]) => ({ productId: r.product_id, sku: r.sku, name: r.name, unit: r.unit, quantity: Math.abs(Number(r.quantity)), unitCost: Number(r.unit_cost), expiresOn: r.expires_on });
  const first = rows.find((r) => r.sid);
  return {
    id: doc.id,
    number: doc.number,
    kind: doc.kind as ExchangeDocKind,
    createdAt: doc.created_at,
    comment: doc.comment,
    location: { id: doc.lid, name: doc.lname },
    toLocation: doc.tid ? { id: doc.tid, name: doc.tname ?? '' } : null,
    supplier: doc.kind === 'receipt' && first?.sid ? { id: first.sid, name: first.sname ?? '', inn: first.sinn } : null,
    lines: rows.filter((r) => r.type === wantType).map(toLine),
    surplus: doc.kind === 'inventory' ? rows.filter((r) => r.type === 'adjustment_in').map((r) => ({ ...toLine(r) })) : [],
  };
}

async function loadRefs(deps: Deps, systemId: string): Promise<Refs> {
  const rows = await deps.db.selectFrom('external_refs').select(['entity', 'local_id', 'remote_key']).where('system_id', '=', systemId).where('entity', '<>', 'document').execute();
  const refs: Refs = { product: new Map(), supplier: new Map(), location: new Map() };
  for (const r of rows) refs[r.entity as LinkEntity].set(r.local_id, r.remote_key);
  return refs;
}

async function markSystem(deps: Deps, id: string, error: string | null): Promise<void> {
  const now = deps.clock();
  await deps.db.updateTable('external_systems').set(error ? { last_error: error, updated_at: now } : { last_ok_at: now, last_error: null }).where('id', '=', id).execute();
}

/** Одна попытка выгрузки. Возвращает итог для вызывающего: ручная выгрузка показывает его сразу. */
async function attempt(deps: Deps, jobId: string, manual: boolean): Promise<'done' | 'blocked' | 'retry' | 'failed' | 'skipped'> {
  const row = await deps.db
    .selectFrom('exchange_jobs as j')
    .innerJoin('external_systems as s', 's.id', 'j.system_id')
    .select(['j.id', 'j.attempts', 'j.document_id', 'j.system_id', 's.enabled'])
    .where('j.id', '=', jobId)
    .where('j.status', '=', 'pending')
    .executeTakeFirst();
  if (!row) return 'skipped';
  const now = deps.clock();
  const system = await deps.db.selectFrom('external_systems').selectAll().where('id', '=', row.system_id).executeTakeFirstOrThrow();
  const fail = async (message: string, retryable: boolean) => {
    const attempts = row.attempts + 1;
    const delay = EXCHANGE_RETRY_MS[attempts - 1];
    const final = !retryable || delay === undefined || manual;
    await deps.db
      .updateTable('exchange_jobs')
      .set({ status: final ? 'failed' : 'pending', attempts, last_error: message, next_attempt_at: new Date(now.getTime() + (delay ?? 0)) })
      .where('id', '=', row.id)
      .execute();
    await markSystem(deps, system.id, message);
    return final ? ('failed' as const) : ('retry' as const);
  };

  if (!row.enabled) {
    await deps.db.updateTable('exchange_jobs').set({ status: 'failed', last_error: 'Обмен с этой системой выключен' }).where('id', '=', row.id).execute();
    return 'failed';
  }
  const transport = deps.exchangeTransport;
  if (!transport) return fail('Отправка не настроена на сервере', true);

  try {
    const doc = await loadCanonical(deps, row.document_id);
    if (!doc) return fail('Документ не найден', false);
    const connection = connectionOf(deps, system);
    const refs = await loadRefs(deps, system.id);
    const plan = planDocument(doc, connection.profile, refs, deps.config.businessTz);
    if (!plan.ok) {
      if (plan.missing.length === 0) return fail(plan.reason ?? 'Документ нельзя выгрузить', false);
      await deps.db
        .updateTable('exchange_jobs')
        .set({ status: 'blocked', missing: JSON.stringify(plan.missing), last_error: `Нужно связать с 1С: ${plan.missing.length}` })
        .where('id', '=', row.id)
        .execute();
      return 'blocked';
    }
    const prior = await deps.db.selectFrom('external_refs').select('remote_key').where('system_id', '=', system.id).where('entity', '=', 'document').where('local_id', '=', doc.id).executeTakeFirst();
    const sent = await sendDocument(transport, connection, plan, prior?.remote_key ?? null);
    await deps.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('external_refs')
        .values({ system_id: system.id, entity: 'document', local_id: doc.id, remote_key: sent.remoteKey, remote_number: sent.remoteNumber, updated_at: now })
        .onConflict((oc) => oc.columns(['system_id', 'entity', 'local_id']).doUpdateSet({ remote_key: sent.remoteKey, remote_number: sent.remoteNumber, updated_at: now }))
        .execute();
      await trx
        .updateTable('exchange_jobs')
        .set({ status: 'done', attempts: row.attempts + 1, last_error: null, remote_key: sent.remoteKey, remote_number: sent.remoteNumber, missing: null, done_at: now })
        .where('id', '=', row.id)
        .execute();
    });
    await markSystem(deps, system.id, null);
    return 'done';
  } catch (err) {
    if (err instanceof OneCError) return fail(err.message, err.retryable);
    return fail(describeExchangeError(err), true);
  }
}

/** Берёт задания, которым пора уходить, и отправляет. Возвращает, сколько обработано. */
export async function processExchange(deps: Deps, limit = BATCH): Promise<number> {
  const now = deps.clock();
  // аренда: пока идёт отправка, другой экземпляр это задание не возьмёт, а при падении процесса оно вернётся само
  const claimed = await deps.db
    .updateTable('exchange_jobs')
    .set({ next_attempt_at: new Date(now.getTime() + LEASE_MS) })
    .where('id', 'in', deps.db.selectFrom('exchange_jobs').select('id').where('status', '=', 'pending').where('next_attempt_at', '<=', now).orderBy('next_attempt_at').limit(limit).forUpdate().skipLocked())
    .returning('id')
    .execute();
  for (const c of claimed) {
    try {
      await attempt(deps, c.id, false);
    } catch (err) {
      deps.log.error({ err }, 'сбой при выгрузке в учётную систему');
    }
  }
  return claimed.length;
}

/** Ручная выгрузка: одна попытка без повторов, итог сразу виден человеку. */
export async function pushNow(deps: Deps, systemId: string, documentId: string): Promise<{ jobId: string; outcome: Awaited<ReturnType<typeof attempt>> }> {
  const now = deps.clock();
  const job = await deps.db
    .insertInto('exchange_jobs')
    .values({ system_id: systemId, document_id: documentId, next_attempt_at: new Date(now.getTime() + LEASE_MS), created_at: now })
    .onConflict((oc) => oc.columns(['system_id', 'document_id']).doUpdateSet({ status: 'pending', last_error: null, next_attempt_at: new Date(now.getTime() + LEASE_MS) }))
    .returning('id')
    .executeTakeFirstOrThrow();
  return { jobId: job.id, outcome: await attempt(deps, job.id, true) };
}

/** Возвращает задание в очередь немедленно. */
export async function retryJob(deps: Deps, jobId: string): Promise<boolean> {
  const res = await deps.db
    .updateTable('exchange_jobs')
    .set({ status: 'pending', attempts: 0, last_error: null, next_attempt_at: deps.clock() })
    .where('id', '=', jobId)
    .where('status', 'in', ['failed', 'blocked'])
    .returning('id')
    .executeTakeFirst();
  return Boolean(res);
}

/** Сохраняет связь и возвращает в очередь ждавшие её задания этой системы. */
export async function saveLink(deps: Deps, systemId: string, entity: LinkEntity, localId: string, remoteKey: string): Promise<number> {
  const now = deps.clock();
  await deps.db
    .insertInto('external_refs')
    .values({ system_id: systemId, entity, local_id: localId, remote_key: remoteKey, remote_number: null, updated_at: now })
    .onConflict((oc) => oc.columns(['system_id', 'entity', 'local_id']).doUpdateSet({ remote_key: remoteKey, updated_at: now }))
    .execute();
  const woke = await deps.db.updateTable('exchange_jobs').set({ status: 'pending', last_error: null, next_attempt_at: now }).where('system_id', '=', systemId).where('status', '=', 'blocked').returning('id').execute();
  return woke.length;
}

/** Всё, что мешает выгрузке: объекты из ждущих заданий, которым ещё не найдено соответствие. */
export async function listUnlinked(deps: Deps, systemId: string): Promise<ExchangeMissingDto[]> {
  const jobs = await deps.db.selectFrom('exchange_jobs').select('missing').where('system_id', '=', systemId).where('status', 'in', ['blocked', 'pending']).where('missing', 'is not', null).execute();
  const refs = await loadRefs(deps, systemId);
  const seen = new Map<string, ExchangeMissingDto>();
  for (const j of jobs) {
    for (const m of (j.missing as ExchangeMissingDto[] | null) ?? []) {
      if (refs[m.entity].has(m.localId)) continue;
      seen.set(`${m.entity}:${m.localId}`, m);
    }
  }
  return [...seen.values()].sort((a, b) => a.entity.localeCompare(b.entity) || a.name.localeCompare(b.name, 'ru'));
}

/** Автоматическая связка продуктов по артикулу: связываем только однозначные совпадения. */
export async function autolink(deps: Deps, systemId: string): Promise<{ linked: number; left: number }> {
  const transport = deps.exchangeTransport;
  if (!transport) throw new OneCError('Отправка не настроена на сервере', true);
  const system = await deps.db.selectFrom('external_systems').selectAll().where('id', '=', systemId).executeTakeFirstOrThrow();
  const connection = connectionOf(deps, system);
  const todo = await listUnlinked(deps, systemId);
  let linked = 0;
  for (const m of todo) {
    const code = m.entity === 'product' ? m.code : m.entity === 'supplier' ? m.code : null;
    if (!code) continue;
    const key = await findByCode(transport, connection, m.entity, code);
    if (key) {
      await saveLink(deps, systemId, m.entity, m.localId, key);
      linked += 1;
    }
  }
  return { linked, left: (await listUnlinked(deps, systemId)).length };
}

export async function checkSystem(deps: Deps, systemId: string) {
  const transport = deps.exchangeTransport;
  if (!transport) throw new OneCError('Отправка не настроена на сервере', true);
  const system = await deps.db.selectFrom('external_systems').selectAll().where('id', '=', systemId).executeTakeFirstOrThrow();
  try {
    const result = await checkConnection(transport, connectionOf(deps, system), system.doc_kinds as ExchangeDocKind[]);
    await markSystem(deps, systemId, result.ok ? null : (result.items.find((i) => !i.ok)?.text ?? 'Проверка не пройдена'));
    return result;
  } catch (err) {
    const text = err instanceof OneCError ? err.message : describeExchangeError(err);
    await markSystem(deps, systemId, text);
    return { ok: false, items: [{ ok: false, text: `Не удалось подключиться: ${text}` }] };
  }
}

export async function listJobs(deps: Deps, f: { systemId?: string; status?: string; limit: number }): Promise<ExchangeJobDto[]> {
  let q = deps.db
    .selectFrom('exchange_jobs as j')
    .innerJoin('external_systems as s', 's.id', 'j.system_id')
    .innerJoin('documents as d', 'd.id', 'j.document_id')
    .innerJoin('locations as l', 'l.id', 'd.location_id')
    .select(['j.id', 'j.system_id', 's.name as system_name', 'j.document_id', 'd.number', 'd.kind', 'l.name as location_name', 'j.status', 'j.attempts', 'j.next_attempt_at', 'j.last_error', 'j.remote_number', 'j.missing', 'j.created_at', 'j.done_at']);
  if (f.systemId) q = q.where('j.system_id', '=', f.systemId);
  if (f.status) q = q.where('j.status', '=', f.status as 'pending');
  const rows = await q.orderBy('j.created_at', 'desc').limit(f.limit).execute();
  return rows.map((r) => ({
    id: r.id,
    systemId: r.system_id,
    systemName: r.system_name,
    documentId: r.document_id,
    documentNumber: r.number,
    documentKind: r.kind,
    locationName: r.location_name,
    status: r.status,
    attempts: r.attempts,
    nextAttemptAt: r.status === 'pending' ? r.next_attempt_at.toISOString() : null,
    lastError: r.last_error,
    remoteNumber: r.remote_number,
    missing: (r.missing as ExchangeMissingDto[] | null) ?? [],
    createdAt: r.created_at.toISOString(),
    doneAt: r.done_at?.toISOString() ?? null,
  }));
}

const WORKER_TICK_MS = 5000;

export function startExchangeWorker(deps: Deps): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    processExchange(deps)
      .catch((err) => deps.log.error({ err }, 'ошибка выгрузки в учётные системы'))
      .finally(() => {
        running = false;
      });
  }, WORKER_TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
