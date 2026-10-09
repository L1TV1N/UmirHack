import type { StopFeedEntryDto, StopListChangedPayload, StopListEntryDto, WebhookDeliveryDto, WebhookDto, WebhookEvent } from '@zapas/shared';
import { sql, type Selectable, type Transaction } from 'kysely';
import type { Database, WebhookDeliveriesTable, WebhookEndpointsTable } from '../../db/types';
import type { Deps } from '../../lib/context';
import { decryptSecret, signBody } from '../../lib/crypto';
import { activeLocationIds, getStopList } from '../stoplist/service';
import { describeSendError } from './sender';

export const STOPLIST_EVENT = 'stoplist.changed' as const;

/** Паузы перед повторами: после каждой неудачи ждём дольше. Шесть попыток всего. */
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000];
/** Столько доставок подряд должны провалиться (после всех повторов), чтобы адрес выключился сам. */
export const DISABLE_AFTER_FAILURES = 5;
const LEASE_MS = 2 * 60_000;
const MAX_ENTRIES = 1000;
const MAX_CHANGES = 500;
const BATCH = 10;

type EndpointRow = Selectable<WebhookEndpointsTable>;
type DeliveryRow = Selectable<WebhookDeliveriesTable>;

export function toWebhookDto(row: EndpointRow, locationName: string | null): WebhookDto {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    events: row.events as WebhookEvent[],
    locationId: row.location_id,
    locationName,
    enabled: row.enabled,
    failureStreak: row.failure_streak,
    disabledReason: row.disabled_reason,
    lastSuccessAt: row.last_success_at?.toISOString() ?? null,
    lastFailureAt: row.last_failure_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export function toDeliveryDto(row: Omit<DeliveryRow, 'payload' | 'endpoint_id'>): WebhookDeliveryDto {
  return {
    id: row.id,
    event: row.event,
    status: row.status,
    attempts: row.attempts,
    lastStatus: row.last_status,
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
    deliveredAt: row.delivered_at?.toISOString() ?? null,
    nextAttemptAt: row.status === 'pending' ? row.next_attempt_at.toISOString() : null,
  };
}

/** Строки стоп-листа в том виде, в каком их ждёт касса: с артикулом, кодом блюда и штрихкодом. */
export async function toFeedEntries(deps: Deps, entries: StopListEntryDto[]): Promise<StopFeedEntryDto[]> {
  if (entries.length === 0) return [];
  const productIds = [...new Set(entries.filter((e) => e.entityType === 'product').map((e) => e.entityId))];
  const dishIds = [...new Set(entries.filter((e) => e.entityType === 'dish').map((e) => e.entityId))];
  const products = productIds.length ? await deps.db.selectFrom('products').select(['id', 'sku', 'barcode']).where('id', 'in', productIds).execute() : [];
  const dishes = dishIds.length ? await deps.db.selectFrom('dishes').select(['id', 'code']).where('id', 'in', dishIds).execute() : [];
  const productById = new Map(products.map((p) => [p.id, p]));
  const dishById = new Map(dishes.map((d) => [d.id, d]));
  return entries.map((e) => {
    const p = e.entityType === 'product' ? productById.get(e.entityId) : undefined;
    return {
      id: e.entityId,
      type: e.entityType,
      code: e.entityType === 'product' ? (p?.sku ?? null) : (dishById.get(e.entityId)?.code ?? null),
      barcode: p?.barcode ?? null,
      name: e.name,
      locationId: e.locationId,
      locationName: e.locationName,
      source: e.source,
      reason: e.reasons[0]?.text ?? '',
      since: e.since,
    };
  });
}

const identity = (e: Pick<StopFeedEntryDto, 'type' | 'id' | 'source'>) => `${e.type}:${e.id}:${e.source}`;

/** Ставит событие в очередь всем включённым адресам, подписанным на него и слушающим эту точку. Вызывается внутри транзакции. */
export async function enqueueEvent(trx: Transaction<Database>, event: WebhookEvent, payload: unknown, locationId: string | null, now: Date): Promise<number> {
  const endpoints = await trx
    .selectFrom('webhook_endpoints')
    .select('id')
    .where('enabled', '=', true)
    .where(sql<boolean>`${event} = ANY(events)`)
    .where((eb) => (locationId ? eb.or([eb('location_id', 'is', null), eb('location_id', '=', locationId)]) : eb('location_id', 'is', null)))
    .execute();
  for (const e of endpoints) await insertDelivery(trx, e.id, event, payload, now);
  return endpoints.length;
}

function insertDelivery(trx: Transaction<Database> | Deps['db'], endpointId: string, event: string, payload: unknown, now: Date, dueAt = now) {
  return trx
    .insertInto('webhook_deliveries')
    .values({ endpoint_id: endpointId, event, payload: JSON.stringify(payload), next_attempt_at: dueAt, created_at: now })
    .returning('id')
    .executeTakeFirstOrThrow();
}

/** Полное состояние точки как событие: для первой синхронизации приёмника. */
export async function enqueueFullState(deps: Deps, endpoint: Pick<EndpointRow, 'id' | 'location_id'>): Promise<number> {
  const scope = endpoint.location_id ? [endpoint.location_id] : await activeLocationIds(deps);
  if (scope.length === 0) return 0;
  const list = await getStopList(deps, scope);
  const feed = await toFeedEntries(deps, list.entries);
  const names = new Map(list.entries.map((e) => [e.locationId, e.locationName]));
  const locations = await deps.db.selectFrom('locations').select(['id', 'name']).where('id', 'in', scope).execute();
  const now = deps.clock();
  for (const l of locations) names.set(l.id, l.name);
  for (const locationId of scope) {
    const entries = feed.filter((e) => e.locationId === locationId);
    const payload: StopListChangedPayload = {
      event: STOPLIST_EVENT,
      locationId,
      locationName: names.get(locationId) ?? '',
      createdAt: now.toISOString(),
      added: [],
      removed: [],
      entries: entries.slice(0, MAX_ENTRIES),
      truncated: entries.length > MAX_ENTRIES,
    };
    await insertDelivery(deps.db, endpoint.id, STOPLIST_EVENT, payload, now);
  }
  return scope.length;
}

async function publishLocation(deps: Deps, locationId: string, locationName: string, current: StopFeedEntryDto[]): Promise<number> {
  const now = deps.clock();
  return deps.db.transaction().execute(async (trx) => {
    // публикации идут по одной, иначе два одновременных пересчёта отправили бы одну и ту же разницу дважды
    await sql`SELECT pg_advisory_xact_lock(hashtext('zapas.stoplist.publish'))`.execute(trx);
    const prev = await trx.selectFrom('stoplist_published').select('entries').where('location_id', '=', locationId).executeTakeFirst();
    await trx
      .insertInto('stoplist_published')
      .values({ location_id: locationId, entries: JSON.stringify(current), published_at: now })
      .onConflict((oc) => oc.column('location_id').doUpdateSet({ entries: JSON.stringify(current), published_at: now }))
      .execute();
    // первый проход по точке только запоминает состояние: приёмник получает его кнопкой «Отправить текущее состояние»
    if (!prev) return 0;

    const before = prev.entries as StopFeedEntryDto[];
    const beforeKeys = new Set(before.map(identity));
    const nowKeys = new Set(current.map(identity));
    const added = current.filter((e) => !beforeKeys.has(identity(e)));
    const removed = before.filter((e) => !nowKeys.has(identity(e)));
    if (added.length === 0 && removed.length === 0) return 0;

    const payload: StopListChangedPayload = {
      event: STOPLIST_EVENT,
      locationId,
      locationName,
      createdAt: now.toISOString(),
      added: added.slice(0, MAX_CHANGES),
      removed: removed.slice(0, MAX_CHANGES),
      entries: current.slice(0, MAX_ENTRIES),
      truncated: current.length > MAX_ENTRIES || added.length > MAX_CHANGES || removed.length > MAX_CHANGES,
    };
    return enqueueEvent(trx, STOPLIST_EVENT, payload, locationId, now);
  });
}

/**
 * Сравнивает стоп-лист точек с тем, что отправлялось в прошлый раз, и ставит в очередь событие для подписчиков.
 * Вызывается после пересчёта, ручных изменений и планировщиком. Без подписчиков ничего не считает.
 */
export async function publishStopList(deps: Deps, locationIds: string[] | null): Promise<number> {
  const endpoints = await deps.db
    .selectFrom('webhook_endpoints')
    .select('location_id')
    .where('enabled', '=', true)
    .where(sql<boolean>`${STOPLIST_EVENT} = ANY(events)`)
    .execute();
  if (endpoints.length === 0) return 0;

  const scope = locationIds ?? (await activeLocationIds(deps));
  const wantAll = endpoints.some((e) => e.location_id === null);
  const wanted = new Set(endpoints.map((e) => e.location_id));
  const relevant = scope.filter((id) => wantAll || wanted.has(id));
  if (relevant.length === 0) return 0;

  const list = await getStopList(deps, relevant);
  const feed = await toFeedEntries(deps, list.entries);
  const locations = await deps.db.selectFrom('locations').select(['id', 'name']).where('id', 'in', relevant).execute();
  let queued = 0;
  for (const l of locations) queued += await publishLocation(deps, l.id, l.name, feed.filter((e) => e.locationId === l.id));
  return queued;
}

/** Ставит проверочное событие и сразу пробует отправить его один раз, без повторов. */
export async function sendPing(deps: Deps, endpointId: string): Promise<WebhookDeliveryDto> {
  const now = deps.clock();
  const { id } = await insertDelivery(deps.db, endpointId, 'ping', { event: 'ping', createdAt: now.toISOString(), message: 'Проверка связи из «Запаса»' }, now, new Date(now.getTime() + LEASE_MS));
  await attemptDelivery(deps, id, true);
  const row = await deps.db.selectFrom('webhook_deliveries').select(['id', 'event', 'status', 'attempts', 'last_status', 'last_error', 'created_at', 'delivered_at', 'next_attempt_at']).where('id', '=', id).executeTakeFirstOrThrow();
  return toDeliveryDto(row);
}

async function attemptDelivery(deps: Deps, deliveryId: string, single = false): Promise<void> {
  const sender = deps.webhookSender;
  const row = await deps.db
    .selectFrom('webhook_deliveries as d')
    .innerJoin('webhook_endpoints as e', 'e.id', 'd.endpoint_id')
    .select(['d.id', 'd.event', 'd.payload', 'd.attempts', 'd.created_at', 'e.id as endpoint_id', 'e.url', 'e.secret_enc', 'e.enabled'])
    .where('d.id', '=', deliveryId)
    .where('d.status', '=', 'pending')
    .executeTakeFirst();
  if (!row) return;
  const now = deps.clock();

  let status: number | null = null;
  let error: string | null = null;
  if (!sender) {
    error = 'отправка не настроена на сервере';
  } else if (!row.enabled && row.event !== 'ping') {
    // адрес выключили, пока событие ждало: отправлять уже не надо
    await deps.db.updateTable('webhook_deliveries').set({ status: 'failed', last_error: 'адрес выключен' }).where('id', '=', row.id).execute();
    return;
  } else {
    const body = JSON.stringify(row.payload);
    const timestamp = Math.floor(now.getTime() / 1000);
    try {
      const secret = decryptSecret(deps.config.jwtSecret, row.secret_enc);
      const res = await sender.send({
        url: row.url,
        body,
        headers: {
          'x-zapas-event': row.event,
          'x-zapas-delivery': row.id,
          'x-zapas-timestamp': String(timestamp),
          'x-zapas-signature': `sha256=${signBody(secret, timestamp, body)}`,
        },
      });
      status = res.status;
      if (res.status < 200 || res.status >= 300) error = `ответ ${res.status}`;
    } catch (err) {
      error = describeSendError(err);
    }
  }

  const attempts = row.attempts + 1;
  if (!error) {
    await deps.db.transaction().execute(async (trx) => {
      await trx.updateTable('webhook_deliveries').set({ status: 'delivered', attempts, last_status: status, last_error: null, delivered_at: now }).where('id', '=', row.id).execute();
      await trx.updateTable('webhook_endpoints').set({ failure_streak: 0, last_success_at: now }).where('id', '=', row.endpoint_id).execute();
    });
    return;
  }

  const delay = RETRY_DELAYS_MS[attempts - 1];
  const final = single || delay === undefined;
  await deps.db.transaction().execute(async (trx) => {
    await trx
      .updateTable('webhook_deliveries')
      .set({ status: final ? 'failed' : 'pending', attempts, last_status: status, last_error: error, next_attempt_at: new Date(now.getTime() + (delay ?? 0)) })
      .where('id', '=', row.id)
      .execute();
    if (!final) return;
    // проверочное событие в счёт серии неудач не идёт: человек просто смотрит, отвечает ли адрес
    if (row.event === 'ping') {
      await trx.updateTable('webhook_endpoints').set({ last_failure_at: now }).where('id', '=', row.endpoint_id).execute();
      return;
    }
    const updated = await trx
      .updateTable('webhook_endpoints')
      .set({ failure_streak: sql`failure_streak + 1`, last_failure_at: now })
      .where('id', '=', row.endpoint_id)
      .returning(['failure_streak'])
      .executeTakeFirst();
    if (updated && updated.failure_streak >= DISABLE_AFTER_FAILURES) {
      await trx
        .updateTable('webhook_endpoints')
        .set({ enabled: false, disabled_reason: `Отправка выключена: ${DISABLE_AFTER_FAILURES} доставок подряд не удались`, updated_at: now })
        .where('id', '=', row.endpoint_id)
        .where('enabled', '=', true)
        .execute();
    }
  });
}

/** Берёт события, которым пора уходить, и отправляет. Возвращает, сколько обработано. */
export async function processDeliveries(deps: Deps, limit = BATCH): Promise<number> {
  const now = deps.clock();
  // аренда: пока идёт отправка, другой экземпляр это событие не возьмёт, а при падении процесса оно вернётся само
  const claimed = await deps.db
    .updateTable('webhook_deliveries')
    .set({ next_attempt_at: new Date(now.getTime() + LEASE_MS) })
    .where(
      'id',
      'in',
      deps.db.selectFrom('webhook_deliveries').select('id').where('status', '=', 'pending').where('next_attempt_at', '<=', now).orderBy('next_attempt_at').limit(limit).forUpdate().skipLocked(),
    )
    .returning('id')
    .execute();
  for (const c of claimed) {
    try {
      await attemptDelivery(deps, c.id);
    } catch (err) {
      deps.log.error({ err }, 'сбой при отправке вебхука');
    }
  }
  return claimed.length;
}

const WORKER_TICK_MS = 5000;

export function startWebhookWorker(deps: Deps): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    processDeliveries(deps)
      .catch((err) => deps.log.error({ err }, 'ошибка отправки вебхуков'))
      .finally(() => {
        running = false;
      });
  }, WORKER_TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
