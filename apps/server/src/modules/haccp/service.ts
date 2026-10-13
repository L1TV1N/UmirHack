import {
  addDays,
  haccpDue,
  inHaccpRange,
  type HaccpInspectionBody,
  type HaccpInspectionDto,
  type HaccpPendingBatchDto,
  type HaccpPointBody,
  type HaccpPointDto,
  type HaccpPointPatch,
  type HaccpReadingBody,
  type HaccpReadingDto,
  type HaccpSummaryDto,
  type Page,
  type Unit,
} from '@zapas/shared';
import { sql } from 'kysely';
import type { Deps, Principal, RequestMeta } from '../../lib/context';
import { actorName } from '../../lib/context';
import { hubFor } from '../../lib/events';
import { badRequest, conflict, notFound, PG_UNIQUE_VIOLATION, pgCode } from '../../lib/errors';
import { assertLocation, locationFilter } from '../../lib/scope';
import { businessToday } from '../../lib/time';
import { writeAudit } from '../audit/audit';
import { escapeHtml } from '../notifications/notifier';

type UserPrincipal = Extract<Principal, { kind: 'user' }>;

const NO_ROWS = ['00000000-0000-0000-0000-000000000000'];
const inList = (ids: string[]) => sql`${sql.join((ids.length ? ids : NO_ROWS).map((id) => sql`${id}::uuid`))}`;
const num = (v: string | number | null): number => Number(v);
/** За сколько дней приёмки показывать партии, ожидающие бракеража. */
const PENDING_DAYS = 3;
/** Продукты, которые обязательно осматривают при приёмке: с ветеринарным документом и скоропортящиеся. */
const PERISHABLE_DAYS = 10;

function pointDto(row: {
  id: string;
  location_id: string;
  location_name: string;
  name: string;
  kind: HaccpPointDto['kind'];
  min_temp: string;
  max_temp: string;
  every_hours: number;
  is_active: boolean;
  created_at: Date;
  last_value: string | null;
  last_at: Date | null;
  last_in_range: boolean | null;
  open: string | null;
}, now: Date): HaccpPointDto {
  const due = haccpDue(row.every_hours, row.last_at, row.created_at, now);
  return {
    id: row.id,
    locationId: row.location_id,
    locationName: row.location_name,
    name: row.name,
    kind: row.kind,
    minTemp: num(row.min_temp),
    maxTemp: num(row.max_temp),
    everyHours: row.every_hours,
    isActive: row.is_active,
    last: row.last_at && row.last_value !== null ? { value: num(row.last_value), at: row.last_at.toISOString(), inRange: Boolean(row.last_in_range) } : null,
    dueAt: due.dueAt.toISOString(),
    // отключённая точка замеров не ждёт
    overdue: row.is_active && due.overdue,
    openDeviations: Number(row.open ?? 0),
  };
}

export async function listPoints(deps: Deps, principal: Principal, requestedLocation?: string, includeInactive = false): Promise<HaccpPointDto[]> {
  const scope = locationFilter(principal, requestedLocation);
  const rows = await sql<Parameters<typeof pointDto>[0]>`
    SELECT p.id, p.location_id, l.name AS location_name, p.name, p.kind, p.min_temp, p.max_temp, p.every_hours, p.is_active, p.created_at,
           last.value AS last_value, last.measured_at AS last_at, last.in_range AS last_in_range, coalesce(op.n, 0) AS open
    FROM haccp_points p
    JOIN locations l ON l.id = p.location_id
    LEFT JOIN LATERAL (
      SELECT r.value, r.measured_at, r.in_range FROM haccp_readings r WHERE r.point_id = p.id ORDER BY r.measured_at DESC, r.id DESC LIMIT 1
    ) last ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS n FROM haccp_readings r LEFT JOIN haccp_actions a ON a.reading_id = r.id WHERE r.point_id = p.id AND NOT r.in_range AND a.reading_id IS NULL
    ) op ON true
    WHERE (${includeInactive} OR p.is_active) ${scope ? sql`AND p.location_id IN (${inList(scope)})` : sql``}
    ORDER BY l.name, p.name`.execute(deps.db);
  const now = deps.clock();
  return rows.rows.map((r) => pointDto(r, now));
}

async function loadPoint(deps: Deps, principal: Principal, id: string): Promise<HaccpPointDto> {
  const found = (await listPoints(deps, principal, undefined, true)).find((p) => p.id === id);
  if (!found) throw notFound('Контрольная точка');
  return found;
}

export async function createPoint(deps: Deps, principal: UserPrincipal, meta: RequestMeta, body: HaccpPointBody): Promise<HaccpPointDto> {
  assertLocation(principal, body.locationId);
  const now = deps.clock();
  const id = await deps.db.transaction().execute(async (trx) => {
    const loc = await trx.selectFrom('locations').select('is_active').where('id', '=', body.locationId).executeTakeFirst();
    if (!loc) throw notFound('Точка');
    const row = await trx
      .insertInto('haccp_points')
      .values({ location_id: body.locationId, name: body.name, kind: body.kind, min_temp: body.minTemp, max_temp: body.maxTemp, every_hours: body.everyHours, created_at: now })
      .returning('id')
      .executeTakeFirstOrThrow();
    await writeAudit(trx, { action: 'haccp.point_create', entity: 'haccp_point', entityId: row.id, principal, meta, at: now, details: { name: body.name, min: body.minTemp, max: body.maxTemp } });
    return row.id;
  });
  return loadPoint(deps, principal, id);
}

export async function updatePoint(deps: Deps, principal: UserPrincipal, meta: RequestMeta, id: string, patch: HaccpPointPatch): Promise<HaccpPointDto> {
  const current = await loadPoint(deps, principal, id);
  assertLocation(principal, current.locationId);
  const min = patch.minTemp ?? current.minTemp;
  const max = patch.maxTemp ?? current.maxTemp;
  if (min > max) throw badRequest('Верхняя граница ниже нижней', [{ path: ['maxTemp'], message: 'Верхняя граница не ниже нижней' }]);
  const now = deps.clock();
  await deps.db.transaction().execute(async (trx) => {
    await trx
      .updateTable('haccp_points')
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.minTemp !== undefined ? { min_temp: patch.minTemp } : {}),
        ...(patch.maxTemp !== undefined ? { max_temp: patch.maxTemp } : {}),
        ...(patch.everyHours !== undefined ? { every_hours: patch.everyHours } : {}),
        ...(patch.isActive !== undefined ? { is_active: patch.isActive } : {}),
      })
      .where('id', '=', id)
      .execute();
    await writeAudit(trx, { action: 'haccp.point_update', entity: 'haccp_point', entityId: id, principal, meta, at: now, details: { ...patch } });
  });
  return loadPoint(deps, principal, id);
}

const readingSelect = (deps: Deps) =>
  deps.db
    .selectFrom('haccp_readings as r')
    .innerJoin('haccp_points as p', 'p.id', 'r.point_id')
    .innerJoin('locations as l', 'l.id', 'r.location_id')
    .leftJoin('haccp_actions as a', 'a.reading_id', 'r.id')
    .select([
      'r.id',
      'r.point_id',
      'p.name as point_name',
      'r.location_id',
      'l.name as location_name',
      'r.measured_at',
      'r.value',
      'r.min_temp',
      'r.max_temp',
      'r.in_range',
      'r.comment',
      'r.actor_name',
      'a.action',
      'a.actor_name as action_by',
      'a.created_at as action_at',
    ]);

type ReadingRow = Awaited<ReturnType<ReturnType<typeof readingSelect>['execute']>>[number];

function readingDto(r: ReadingRow): HaccpReadingDto {
  return {
    id: Number(r.id),
    pointId: r.point_id,
    pointName: r.point_name,
    locationId: r.location_id,
    locationName: r.location_name,
    measuredAt: r.measured_at.toISOString(),
    value: num(r.value),
    minTemp: num(r.min_temp),
    maxTemp: num(r.max_temp),
    inRange: r.in_range,
    comment: r.comment,
    authorName: r.actor_name,
    action: r.action && r.action_by && r.action_at ? { text: r.action, authorName: r.action_by, at: r.action_at.toISOString() } : null,
  };
}

async function oneReading(deps: Deps, id: number): Promise<HaccpReadingDto> {
  const row = await readingSelect(deps).where('r.id', '=', id).executeTakeFirstOrThrow();
  return readingDto(row);
}

/** Записывает замер. Температура вне границ это отклонение: оно остаётся открытым, пока по нему не записано действие. */
export async function addReading(deps: Deps, principal: UserPrincipal, meta: RequestMeta, body: HaccpReadingBody): Promise<HaccpReadingDto> {
  const now = deps.clock();
  let pointName = '';
  let locationName = '';
  const { id, inRange, min, max } = await deps.db.transaction().execute(async (trx) => {
    const point = await trx
      .selectFrom('haccp_points as p')
      .innerJoin('locations as l', 'l.id', 'p.location_id')
      .select(['p.id', 'p.location_id', 'p.name', 'p.min_temp', 'p.max_temp', 'p.is_active', 'l.name as location_name'])
      .where('p.id', '=', body.pointId)
      .executeTakeFirst();
    if (!point) throw notFound('Контрольная точка');
    assertLocation(principal, point.location_id);
    if (!point.is_active) throw conflict('Контрольная точка отключена', undefined, 'point_inactive');
    pointName = point.name;
    locationName = point.location_name;
    const lo = num(point.min_temp);
    const hi = num(point.max_temp);
    const ok = inHaccpRange(body.value, lo, hi);
    const row = await trx
      .insertInto('haccp_readings')
      .values({
        point_id: point.id,
        location_id: point.location_id,
        measured_at: now,
        value: body.value,
        min_temp: lo,
        max_temp: hi,
        in_range: ok,
        comment: body.comment ?? null,
        created_by: principal.id,
        actor_name: actorName(principal),
        created_at: now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (!ok && body.action) {
      await trx.insertInto('haccp_actions').values({ reading_id: row.id, action: body.action, created_by: principal.id, actor_name: actorName(principal), created_at: now }).execute();
    }
    await writeAudit(trx, { action: 'haccp.reading', entity: 'haccp_reading', entityId: String(row.id), principal, meta, at: now, details: { point: point.name, value: body.value, inRange: ok } });
    return { id: Number(row.id), inRange: ok, min: lo, max: hi };
  });

  hubFor(deps.db).publish();
  if (!inRange && deps.notifier.enabled) {
    const text = `<b>Отклонение температуры</b>\n${escapeHtml(pointName)} (${escapeHtml(locationName)}): ${body.value} °C при норме от ${min} до ${max} °C.${body.action ? `\nДействие: ${escapeHtml(body.action)}` : '\nДействие пока не записано.'}`;
    await deps.notifier.send(text).catch((err) => deps.log.error({ err }, 'не удалось сообщить об отклонении температуры'));
  }
  return oneReading(deps, id);
}

/** Записывает, что сделали с отклонением. На один замер одно действие. */
export async function addAction(deps: Deps, principal: UserPrincipal, meta: RequestMeta, readingId: number, action: string): Promise<HaccpReadingDto> {
  const now = deps.clock();
  await deps.db.transaction().execute(async (trx) => {
    const reading = await trx.selectFrom('haccp_readings').select(['id', 'location_id', 'in_range']).where('id', '=', readingId).executeTakeFirst();
    if (!reading) throw notFound('Замер');
    assertLocation(principal, reading.location_id);
    if (reading.in_range) throw conflict('Замер в норме, действие не требуется', undefined, 'not_a_deviation');
    try {
      await trx.insertInto('haccp_actions').values({ reading_id: readingId, action, created_by: principal.id, actor_name: actorName(principal), created_at: now }).execute();
    } catch (err) {
      if (pgCode(err) === PG_UNIQUE_VIOLATION) throw conflict('По этому отклонению действие уже записано', undefined, 'action_exists');
      throw err;
    }
    await writeAudit(trx, { action: 'haccp.action', entity: 'haccp_reading', entityId: String(readingId), principal, meta, at: now, details: { action } });
  });
  hubFor(deps.db).publish();
  return oneReading(deps, readingId);
}

export interface ReadingFilter {
  locationId?: string | undefined;
  pointId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  deviations?: boolean | undefined;
  limit: number;
  offset: number;
}

export async function listReadings(deps: Deps, principal: Principal, f: ReadingFilter): Promise<Page<HaccpReadingDto>> {
  const scope = locationFilter(principal, f.locationId);
  const tz = deps.config.businessTz;
  const base = () =>
    readingSelect(deps)
      .$if(scope !== null, (qb) => qb.where('r.location_id', 'in', (scope as string[]).length ? (scope as string[]) : NO_ROWS))
      .$if(f.pointId !== undefined, (qb) => qb.where('r.point_id', '=', f.pointId as string))
      .$if(f.from !== undefined, (qb) => qb.where(sql<boolean>`(r.measured_at AT TIME ZONE ${tz})::date >= ${f.from}::date`))
      .$if(f.to !== undefined, (qb) => qb.where(sql<boolean>`(r.measured_at AT TIME ZONE ${tz})::date <= ${f.to}::date`))
      .$if(f.deviations === true, (qb) => qb.where('r.in_range', '=', false));
  const total = await deps.db
    .selectFrom(base().as('x'))
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .executeTakeFirstOrThrow();
  const rows = await base().orderBy('r.measured_at', 'desc').orderBy('r.id', 'desc').limit(f.limit).offset(f.offset).execute();
  return { items: rows.map(readingDto), total: Number(total.n), limit: f.limit, offset: f.offset };
}

export async function summary(deps: Deps, principal: Principal, requestedLocation?: string): Promise<HaccpSummaryDto> {
  const points = await listPoints(deps, principal, requestedLocation);
  return {
    points: points.length,
    overdue: points.filter((p) => p.overdue).length,
    openDeviations: points.reduce((sum, p) => sum + p.openDeviations, 0),
  };
}

/** Партии последних дней, которые осматривают при приёмке и по которым бракераж ещё не записан. */
export async function pendingInspections(deps: Deps, principal: Principal, requestedLocation?: string): Promise<HaccpPendingBatchDto[]> {
  const scope = locationFilter(principal, requestedLocation);
  const from = addDays(businessToday(deps), -PENDING_DAYS);
  const rows = await sql<{ id: string; name: string; unit: Unit; initial_qty: string; location_id: string; location_name: string; received_on: string; expires_on: string; document_no: string | null; supplier: string | null }>`
    SELECT b.id, p.name, p.unit, b.initial_qty, b.location_id, l.name AS location_name, b.received_on::text AS received_on, b.expires_on::text AS expires_on, b.document_no, s.name AS supplier
    FROM batches b
    JOIN documents d ON d.id = b.origin_document_id AND d.kind = 'receipt'
    JOIN products p ON p.id = b.product_id
    JOIN locations l ON l.id = b.location_id
    LEFT JOIN suppliers s ON s.id = b.supplier_id
    WHERE b.received_on >= ${from}::date AND (p.requires_vsd OR p.shelf_life_days <= ${PERISHABLE_DAYS})
      AND NOT EXISTS (SELECT 1 FROM haccp_inspections i WHERE i.batch_id = b.id)
      ${scope ? sql`AND b.location_id IN (${inList(scope)})` : sql``}
    ORDER BY b.created_at DESC, b.id
    LIMIT 100`.execute(deps.db);
  return rows.rows.map((r) => ({
    batchId: r.id,
    productName: r.name,
    unit: r.unit,
    quantity: num(r.initial_qty),
    locationId: r.location_id,
    locationName: r.location_name,
    receivedOn: r.received_on,
    expiresOn: r.expires_on,
    documentNo: r.document_no,
    supplierName: r.supplier,
  }));
}

export async function addInspection(deps: Deps, principal: UserPrincipal, meta: RequestMeta, body: HaccpInspectionBody): Promise<HaccpInspectionDto> {
  const now = deps.clock();
  let productName = '';
  let locationName = '';
  try {
    const id = await deps.db.transaction().execute(async (trx) => {
      const batch = await trx
        .selectFrom('batches as b')
        .innerJoin('products as p', 'p.id', 'b.product_id')
        .innerJoin('locations as l', 'l.id', 'b.location_id')
        .select(['b.id', 'b.location_id', 'p.name', 'l.name as location_name'])
        .where('b.id', '=', body.batchId)
        .executeTakeFirst();
      if (!batch) throw notFound('Партия');
      assertLocation(principal, batch.location_id);
      productName = batch.name;
      locationName = batch.location_name;
      const row = await trx
        .insertInto('haccp_inspections')
        .values({
          batch_id: batch.id,
          location_id: batch.location_id,
          temperature: body.temperature ?? null,
          appearance_ok: body.appearanceOk,
          packaging_ok: body.packagingOk,
          decision: body.decision,
          comment: body.comment ?? null,
          created_by: principal.id,
          actor_name: actorName(principal),
          created_at: now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await writeAudit(trx, { action: 'haccp.inspection', entity: 'batch', entityId: batch.id, principal, meta, at: now, details: { product: batch.name, decision: body.decision, temperature: body.temperature ?? null } });
      return Number(row.id);
    });
    if (body.decision === 'rejected' && deps.notifier.enabled) {
      await deps.notifier
        .send(`<b>Партия не принята при бракераже</b>\n${escapeHtml(productName)} (${escapeHtml(locationName)})${body.comment ? `: ${escapeHtml(body.comment)}` : ''}. Оформите возврат или списание.`)
        .catch((err) => deps.log.error({ err }, 'не удалось сообщить о забракованной партии'));
    }
    hubFor(deps.db).publish();
    return (await listInspections(deps, principal, undefined, 1, 0, id)).items[0] as HaccpInspectionDto;
  } catch (err) {
    if (pgCode(err) === PG_UNIQUE_VIOLATION) throw conflict('Эта партия уже осмотрена', undefined, 'already_inspected');
    throw err;
  }
}

export async function listInspections(deps: Deps, principal: Principal, requestedLocation: string | undefined, limit: number, offset: number, onlyId?: number): Promise<Page<HaccpInspectionDto>> {
  const scope = locationFilter(principal, requestedLocation);
  const base = () =>
    deps.db
      .selectFrom('haccp_inspections as i')
      .innerJoin('batches as b', 'b.id', 'i.batch_id')
      .innerJoin('products as p', 'p.id', 'b.product_id')
      .innerJoin('locations as l', 'l.id', 'i.location_id')
      .$if(scope !== null, (qb) => qb.where('i.location_id', 'in', (scope as string[]).length ? (scope as string[]) : NO_ROWS))
      .$if(onlyId !== undefined, (qb) => qb.where('i.id', '=', onlyId as number));
  const total = await base().select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
  const rows = await base()
    .select(['i.id', 'i.batch_id', 'p.name as product_name', 'l.name as location_name', 'i.temperature', 'i.appearance_ok', 'i.packaging_ok', 'i.decision', 'i.comment', 'i.actor_name', 'i.created_at'])
    .orderBy('i.created_at', 'desc')
    .orderBy('i.id', 'desc')
    .limit(limit)
    .offset(offset)
    .execute();
  return {
    items: rows.map((r) => ({
      id: Number(r.id),
      batchId: r.batch_id,
      productName: r.product_name,
      locationName: r.location_name,
      temperature: r.temperature === null ? null : num(r.temperature),
      appearanceOk: r.appearance_ok,
      packagingOk: r.packaging_ok,
      decision: r.decision,
      comment: r.comment,
      authorName: r.actor_name,
      createdAt: r.created_at.toISOString(),
    })),
    total: Number(total.n),
    limit,
    offset,
  };
}
