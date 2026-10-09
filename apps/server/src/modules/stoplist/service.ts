import type { StopListDto, StopListEntryDto, StopReason } from '@zapas/shared';
import { sql } from 'kysely';
import { evaluateAutoStops, type AutoStop } from '../../domain/stoplist';
import type { Db } from '../../db/client';
import { retryOnConflict } from '../../lib/retry';
import type { Deps } from '../../lib/context';
import { escapeHtml } from '../notifications/notifier';
import { getSnapshot, restrictSnapshot, type Snapshot } from '../analytics/snapshot';
import { publishStopList } from '../integrations/service';

const NO_ROWS = ['00000000-0000-0000-0000-000000000000'];

type Evaluation = ReturnType<typeof evaluateAutoStops>;
interface SyncResult extends Evaluation {
  since: Map<string, Date>;
}

// Срез не меняется после загрузки, поэтому оценку по нему делаем один раз
const evaluated = new WeakMap<Snapshot, Evaluation>();

function evaluate(snap: Snapshot): Evaluation {
  const known = evaluated.get(snap);
  if (known) return known;
  const result = evaluateAutoStops({
    locations: [...snap.locations.values()],
    products: snap.products,
    dishes: snap.dishes.map((d) => ({ ...d, isActive: true })),
    stock: snap.stock,
    tracked: snap.tracked,
    lowPortionThreshold: snap.settings.lowPortionThreshold,
  });
  evaluated.set(snap, result);
  return result;
}

const stateKey = (s: Pick<AutoStop, 'locationId' | 'entityType' | 'entityId'>) =>
  `${s.locationId}:${s.entityType}:${s.entityId}`;

// Запросы страницы стоп-листа и панели, пришедшие на один и тот же срез, делят один пересчёт.
const syncs = new WeakMap<Snapshot, Promise<SyncResult>>();

// Какой срез последним записал состояние по каждой точке. Устаревший срез (его отдаёт кеш, пока тяжёлый
// пересчитывается) не должен затирать то, что уже записал более свежий: иначе позиции мигали бы в стопе
// и в чат приходили бы повторные уведомления.
const written = new WeakMap<Db, Map<string, number>>();

/**
 * Приводит сохранённое состояние автоматического стоп-листа к текущему и сообщает о новых позициях.
 * Вызывается после операций с остатками, страницей стоп-листа и планировщиком.
 */
export function syncStopList(
  deps: Deps,
  locationIds: string[] | null,
  precomputed?: Snapshot,
  fresh = false,
): Promise<SyncResult> {
  return (async () => {
    const snap = precomputed ?? (await getSnapshot(deps, locationIds, { fresh }));
    let run = syncs.get(snap);
    if (!run) {
      run = writeStopState(deps, snap);
      syncs.set(snap, run);
      run.catch(() => {
        if (syncs.get(snap) === run) syncs.delete(snap);
      });
    }
    return run;
  })();
}

async function writeStopState(deps: Deps, snap: Snapshot): Promise<SyncResult> {
  const { stops, warnings } = evaluate(snap);
  const scope = [...snap.locations.keys()];
  const now = deps.clock();
  if (scope.length === 0) return { stops, warnings, since: new Map() };
  const baselined = await ensureBaseline(deps, scope, now);

  const newest = written.get(deps.db) ?? new Map<string, number>();
  written.set(deps.db, newest);

  const { added, since } = await retryOnConflict(() => deps.db.transaction().execute(async (trx) => {
    // пересчёты идут по одному: так не бывает гонки между «прочитал состояние» и «записал»
    await sql`SELECT pg_advisory_xact_lock(hashtext('zapas.stoplist'))`.execute(trx);
    const writable = new Set(scope.filter((id) => (newest.get(id) ?? -1) <= snap.seq));
    const existing = await trx
      .selectFrom('stop_list_state')
      .selectAll()
      .where('location_id', 'in', scope.length ? scope : NO_ROWS)
      .orderBy('location_id')
      .orderBy('entity_type')
      .orderBy('entity_id')
      .execute();
    const sinceMap = new Map<string, Date>();
    for (const e of existing) sinceMap.set(`${e.location_id}:${e.entity_type}:${e.entity_id}`, e.since);
    const existingByKey = new Map(existing.map((e) => [`${e.location_id}:${e.entity_type}:${e.entity_id}`, e]));
    const mine = stops.filter((s) => writable.has(s.locationId));
    const currentKeys = new Set(mine.map(stateKey));

    for (const e of existing) {
      if (!writable.has(e.location_id)) continue;
      const key = `${e.location_id}:${e.entity_type}:${e.entity_id}`;
      if (!currentKeys.has(key)) {
        await trx
          .deleteFrom('stop_list_state')
          .where('location_id', '=', e.location_id)
          .where('entity_type', '=', e.entity_type)
          .where('entity_id', '=', e.entity_id)
          .execute();
        sinceMap.delete(key);
      }
    }

    const fresh = mine.filter((s) => !existingByKey.has(stateKey(s)));
    const inserted: AutoStop[] = [];
    for (const s of fresh) {
      const res = await trx
        .insertInto('stop_list_state')
        .values({
          location_id: s.locationId,
          entity_type: s.entityType,
          entity_id: s.entityId,
          since: now,
          reasons: JSON.stringify(s.reasons),
        })
        .onConflict((oc) => oc.doNothing())
        .returning('entity_id')
        .executeTakeFirst();
      if (res) inserted.push(s);
    }
    // причины могли измениться (например, закончился другой ингредиент)
    for (const s of mine) {
      const prev = existingByKey.get(stateKey(s));
      if (prev && JSON.stringify(prev.reasons) !== JSON.stringify(s.reasons)) {
        await trx
          .updateTable('stop_list_state')
          .set({ reasons: JSON.stringify(s.reasons) })
          .where('location_id', '=', s.locationId)
          .where('entity_type', '=', s.entityType)
          .where('entity_id', '=', s.entityId)
          .execute();
      }
    }
    for (const s of inserted) sinceMap.set(stateKey(s), now);
    for (const id of writable) newest.set(id, snap.seq);
    return { added: inserted, since: sinceMap };
  }));

  const reportable = added.filter((a) => !baselined.has(a.locationId));
  if (reportable.length > 0 && deps.notifier.enabled) await notifyNewStops(deps, reportable);
  return { stops, warnings, since };
}

/**
 * Первый проход по точке только запоминает состояние: позиции, которые уже были в стопе до запуска
 * системы, не должны засыпать чат. Возвращает точки, для которых базовая линия создана прямо сейчас.
 */
async function ensureBaseline(deps: Deps, scope: string[], now: Date): Promise<Set<string>> {
  const fresh = new Set<string>();
  for (const id of scope) {
    const marker = await deps.db
      .insertInto('notification_log')
      .values({ kind: 'stoplist_init', dedupe_key: id, sent_at: now })
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .executeTakeFirst();
    if (marker) fresh.add(id);
  }
  return fresh;
}

async function notifyNewStops(deps: Deps, reportable: AutoStop[]): Promise<void> {
  const lines = reportable.slice(0, 15).map(
    (a) => `• <b>${escapeHtml(a.name)}</b> (${escapeHtml(a.locationName)}): ${escapeHtml(a.reasons[0]?.text ?? '')}`,
  );
  const more = reportable.length > 15 ? `\nи ещё ${reportable.length - 15}` : '';
  try {
    await deps.notifier.send(`<b>Новые позиции в стоп-листе</b>\n${lines.join('\n')}${more}`);
  } catch (err) {
    deps.log.error({ err }, 'не удалось отправить уведомление о стоп-листе');
  }
}

/** Если срез шире нужного (например, у панели), передайте его: второй раз данные загружаться не будут. */
export async function getStopList(deps: Deps, locationIds: string[] | null, wide?: Snapshot): Promise<StopListDto> {
  const snap = wide ? restrictSnapshot(wide, locationIds) : await getSnapshot(deps, locationIds);
  const { stops, warnings, since } = await syncStopList(deps, locationIds, snap);
  const now = deps.clock();

  const entries: StopListEntryDto[] = stops.map((s) => ({
    key: `auto:${stateKey(s)}`,
    entityType: s.entityType,
    entityId: s.entityId,
    name: s.name,
    locationId: s.locationId,
    locationName: s.locationName,
    source: 'auto',
    reasons: s.reasons,
    since: (since.get(stateKey(s)) ?? now).toISOString(),
    manualId: null,
    until: null,
    createdBy: null,
  }));

  const scope = [...snap.locations.keys()];
  if (scope.length > 0) {
    const manual = await deps.db
      .selectFrom('stop_list_manual as m')
      .innerJoin('locations as l', 'l.id', 'm.location_id')
      .leftJoin('products as p', 'p.id', 'm.product_id')
      .leftJoin('dishes as d', 'd.id', 'm.dish_id')
      .leftJoin('users as u', 'u.id', 'm.created_by')
      .select([
        'm.id',
        'm.location_id',
        'm.product_id',
        'm.dish_id',
        'm.reason',
        'm.created_at',
        'm.until',
        'l.name as location_name',
        'p.name as product_name',
        'd.name as dish_name',
        'u.full_name as author',
      ])
      .where('m.location_id', 'in', scope)
      .where('m.released_at', 'is', null)
      .where((eb) => eb.or([eb('m.until', 'is', null), eb('m.until', '>', now)]))
      .execute();
    for (const m of manual) {
      const reason: StopReason = { code: 'manual', text: m.reason };
      entries.push({
        key: `manual:${m.id}`,
        entityType: m.product_id ? 'product' : 'dish',
        entityId: (m.product_id ?? m.dish_id) as string,
        name: (m.product_name ?? m.dish_name) as string,
        locationId: m.location_id,
        locationName: m.location_name,
        source: 'manual',
        reasons: [reason],
        since: m.created_at.toISOString(),
        manualId: m.id,
        until: m.until?.toISOString() ?? null,
        createdBy: m.author,
      });
    }
  }

  entries.sort((a, b) => (a.since < b.since ? 1 : a.since > b.since ? -1 : a.name.localeCompare(b.name, 'ru')));
  return { entries, warnings };
}

export async function countStopList(deps: Deps, locationIds: string[] | null): Promise<number> {
  const list = await getStopList(deps, locationIds);
  return list.entries.length;
}

export async function activeLocationIds(deps: Deps): Promise<string[]> {
  const rows = await deps.db.selectFrom('locations').select('id').where('is_active', '=', true).execute();
  return rows.map((r) => r.id);
}


// Пересчёт после операций идёт в фоне и склеивает частые вызовы: кассе незачем ждать, пока по всей номенклатуре
// обновится стоп-лист, а десяток продаж подряд достаточно обработать одним проходом.
interface SyncState {
  pending: Set<string>;
  timer: NodeJS.Timeout | null;
  running: Promise<void> | null;
}

const syncers = new WeakMap<Deps['db'], SyncState>();

function stateFor(deps: Deps): SyncState {
  let st = syncers.get(deps.db);
  if (!st) {
    st = { pending: new Set(), timer: null, running: null };
    syncers.set(deps.db, st);
  }
  return st;
}

async function runPending(deps: Deps, st: SyncState): Promise<void> {
  st.timer = null;
  const ids = [...st.pending];
  st.pending.clear();
  if (ids.length === 0) return;
  try {
    await syncStopList(deps, ids, undefined, true);
    await publishStopList(deps, ids);
  } catch (err) {
    deps.log.error({ err }, 'не удалось пересчитать стоп-лист');
  }
}

export function scheduleStopListSync(deps: Deps, locationIds: string[]): void {
  const st = stateFor(deps);
  for (const id of locationIds) st.pending.add(id);
  if (st.timer || st.running) return;
  st.timer = setTimeout(() => {
    st.running = runPending(deps, st).finally(() => {
      st.running = null;
      // за время пересчёта могли добавиться новые точки
      if (st.pending.size > 0) scheduleStopListSync(deps, []);
    });
  }, deps.config.stopListSyncDelayMs);
  st.timer.unref();
}

/** Дожидается фонового пересчёта. Нужен тестам и корректной остановке сервера. */
export async function drainStopListSync(deps: Deps): Promise<void> {
  const st = stateFor(deps);
  for (let guard = 0; guard < 20 && (st.timer || st.running || st.pending.size > 0); guard += 1) {
    if (st.timer) {
      clearTimeout(st.timer);
      st.timer = null;
    }
    if (!st.running && st.pending.size > 0) st.running = runPending(deps, st).finally(() => (st.running = null));
    await st.running;
  }
}
