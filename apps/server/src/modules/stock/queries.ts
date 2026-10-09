import {
  daysBetween,
  expiryStatus,
  roundMoney,
  type BatchDto,
  type DocumentDetailDto,
  type DocumentDto,
  type MovementDto,
  type Page,
  type StockRowDto,
  type WriteoffReason,
} from '@zapas/shared';
import { sql, type RawBuilder } from 'kysely';
import type { Deps } from '../../lib/context';
import { notFound } from '../../lib/errors';
import { businessToday } from '../../lib/time';
import { getSettings } from '../settings/settings';

const likePattern = (q: string) => `%${q.replace(/[%_\\]/g, '\\$&')}%`;

function inList(ids: string[]): RawBuilder<unknown> {
  return ids.length ? sql`${sql.join(ids.map((id) => sql`${id}::uuid`))}` : sql`NULL::uuid`;
}

export interface BatchFilter {
  locationIds: string[] | null;
  id?: string | undefined;
  productId?: string | undefined;
  status: 'active' | 'expiring' | 'expired' | 'depleted' | 'any';
  q?: string | undefined;
  limit: number;
  offset: number;
}

function lifeElapsed(receivedOn: string, expiresOn: string, today: string): number {
  const span = daysBetween(receivedOn, expiresOn);
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, daysBetween(receivedOn, today) / span));
}

export async function listBatches(deps: Deps, f: BatchFilter): Promise<Page<BatchDto>> {
  const today = businessToday(deps);
  const settings = await getSettings(deps.db);
  const soonLimit = daysBetween(today, today) + settings.expiringSoonDays;

  const filtered = deps.db
    .selectFrom('batches as b')
    .innerJoin('products as p', 'p.id', 'b.product_id')
    .innerJoin('locations as l', 'l.id', 'b.location_id')
    .leftJoin('suppliers as s', 's.id', 'b.supplier_id')
    .$if(f.locationIds !== null, (qb) => qb.where('b.location_id', 'in', (f.locationIds as string[]).length ? (f.locationIds as string[]) : ['00000000-0000-0000-0000-000000000000']))
    .$if(f.id !== undefined, (qb) => qb.where('b.id', '=', f.id as string))
    .$if(f.productId !== undefined, (qb) => qb.where('b.product_id', '=', f.productId as string))
    .$if(Boolean(f.q), (qb) =>
      qb.where((eb) => eb.or([eb('p.name', 'ilike', likePattern(f.q as string)), eb('p.sku', 'ilike', likePattern(f.q as string))])),
    )
    .$if(f.status === 'depleted', (qb) => qb.where('b.remaining_qty', '=', '0'))
    .$if(f.status !== 'depleted' && f.status !== 'any', (qb) => qb.where('b.remaining_qty', '>', '0'))
    .$if(f.status === 'expired', (qb) => qb.where('b.expires_on', '<', today))
    .$if(f.status === 'expiring', (qb) =>
      qb
        .where('b.expires_on', '>=', today)
        .where(sql<boolean>`b.expires_on <= ${today}::date + ${soonLimit}::int`),
    );

  const total = await filtered.select(sql<number>`count(*)`.as('n')).executeTakeFirstOrThrow();
  const rows = await filtered
    .leftJoin('promotions as pr', (join) =>
      join
        .onRef('pr.batch_id', '=', 'b.id')
        .on('pr.cancelled_at', 'is', null)
        .on(sql<boolean>`pr.ends_on >= ${today}::date`),
    )
    .select([
      'b.id',
      'b.product_id',
      'b.location_id',
      'b.supplier_id',
      'b.document_no',
      'b.received_on',
      'b.expires_on',
      'b.initial_qty',
      'b.remaining_qty',
      'b.unit_cost',
      'p.name as product_name',
      'p.sku',
      'p.unit',
      'l.name as location_name',
      's.name as supplier_name',
      'pr.id as promo_id',
      'pr.percent as promo_percent',
      'pr.ends_on as promo_ends_on',
    ])
    .orderBy('b.expires_on')
    .orderBy('b.received_on')
    .orderBy('b.id')
    .limit(f.limit)
    .offset(f.offset)
    .execute();

  return {
    total: Number(total.n),
    limit: f.limit,
    offset: f.offset,
    items: rows.map((r) => {
      const daysLeft = daysBetween(today, r.expires_on);
      const remaining = Number(r.remaining_qty);
      return {
        id: r.id,
        productId: r.product_id,
        productName: r.product_name,
        sku: r.sku,
        unit: r.unit,
        locationId: r.location_id,
        locationName: r.location_name,
        supplierId: r.supplier_id,
        supplierName: r.supplier_name,
        documentNo: r.document_no,
        receivedOn: r.received_on,
        expiresOn: r.expires_on,
        daysLeft,
        status: remaining === 0 ? 'depleted' : expiryStatus(daysLeft, settings),
        initialQty: Number(r.initial_qty),
        remainingQty: remaining,
        unitCost: Number(r.unit_cost),
        value: roundMoney(remaining * Number(r.unit_cost)),
        lifeElapsed: lifeElapsed(r.received_on, r.expires_on, today),
        promotion: r.promo_id ? { id: r.promo_id, percent: r.promo_percent as number, endsOn: r.promo_ends_on as string } : null,
      } satisfies BatchDto;
    }),
  };
}

export async function getBatch(deps: Deps, id: string, allowed: string[] | null): Promise<BatchDto> {
  const page = await listBatches(deps, { locationIds: allowed, id, status: 'any', limit: 1, offset: 0 });
  const batch = page.items[0];
  if (!batch) throw notFound('Партия');
  return batch;
}

export interface SummaryFilter {
  locationIds: string[] | null;
  categoryId?: string | undefined;
  q?: string | undefined;
  flag: 'all' | 'low' | 'expiring' | 'expired';
  limit: number;
  offset: number;
}

interface SummaryRow {
  product_id: string;
  sku: string;
  name: string;
  category_id: string;
  category_name: string;
  unit: 'kg' | 'l' | 'pcs';
  min_stock: string;
  location_id: string;
  location_name: string;
  on_hand: string;
  available: string;
  expired: string;
  value: string;
  expired_value: string;
  batches: number;
  nearest_expiry: string | null;
}

export async function stockSummary(deps: Deps, f: SummaryFilter): Promise<Page<StockRowDto>> {
  const today = businessToday(deps);
  const settings = await getSettings(deps.db);

  const where: RawBuilder<unknown>[] = [];
  if (f.locationIds) where.push(sql`b.location_id IN (${inList(f.locationIds)})`);
  if (f.categoryId) where.push(sql`p.category_id = ${f.categoryId}::uuid`);
  if (f.q) where.push(sql`(p.name ILIKE ${likePattern(f.q)} OR p.sku ILIKE ${likePattern(f.q)})`);
  const whereSql = where.length ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``;

  const availableSum = sql`COALESCE(SUM(b.remaining_qty) FILTER (WHERE b.expires_on >= ${today}::date), 0)`;
  const having: RawBuilder<unknown>[] = [
    sql`(p.is_active OR COALESCE(SUM(b.remaining_qty) FILTER (WHERE b.remaining_qty > 0), 0) > 0)`,
  ];
  if (f.flag === 'low') having.push(sql`(p.min_stock > 0 AND ${availableSum} <= p.min_stock)`);
  if (f.flag === 'expiring') {
    having.push(sql`MIN(b.expires_on) FILTER (WHERE b.remaining_qty > 0) <= ${today}::date + ${settings.expiringSoonDays}::int`);
  }
  if (f.flag === 'expired') {
    having.push(sql`COALESCE(SUM(b.remaining_qty) FILTER (WHERE b.expires_on < ${today}::date), 0) > 0`);
  }

  const core = sql`
    SELECT p.id AS product_id, p.sku, p.name, p.category_id, c.name AS category_name, p.unit, p.min_stock,
           l.id AS location_id, l.name AS location_name,
           COALESCE(SUM(b.remaining_qty) FILTER (WHERE b.remaining_qty > 0), 0) AS on_hand,
           ${availableSum} AS available,
           COALESCE(SUM(b.remaining_qty) FILTER (WHERE b.expires_on < ${today}::date), 0) AS expired,
           COALESCE(SUM(b.remaining_qty * b.unit_cost), 0) AS value,
           COALESCE(SUM(b.remaining_qty * b.unit_cost) FILTER (WHERE b.expires_on < ${today}::date), 0) AS expired_value,
           COUNT(*) FILTER (WHERE b.remaining_qty > 0) AS batches,
           MIN(b.expires_on) FILTER (WHERE b.remaining_qty > 0) AS nearest_expiry
    FROM batches b
    JOIN products p ON p.id = b.product_id
    JOIN categories c ON c.id = p.category_id
    JOIN locations l ON l.id = b.location_id
    ${whereSql}
    GROUP BY p.id, c.name, l.id
    HAVING ${sql.join(having, sql` AND `)}`;

  const total = await sql<{ n: number }>`SELECT count(*) AS n FROM (${core}) t`.execute(deps.db);
  const rows = await sql<SummaryRow>`
    ${core}
    ORDER BY nearest_expiry ASC NULLS LAST, p.name, l.name
    LIMIT ${f.limit} OFFSET ${f.offset}`.execute(deps.db);

  return {
    total: Number(total.rows[0]?.n ?? 0),
    limit: f.limit,
    offset: f.offset,
    items: rows.rows.map((r) => {
      const onHand = Number(r.on_hand);
      const available = Number(r.available);
      const minStock = Number(r.min_stock);
      const daysLeft = r.nearest_expiry ? daysBetween(today, r.nearest_expiry) : null;
      return {
        productId: r.product_id,
        sku: r.sku,
        name: r.name,
        categoryId: r.category_id,
        categoryName: r.category_name,
        unit: r.unit,
        locationId: r.location_id,
        locationName: r.location_name,
        onHand,
        available,
        expired: Number(r.expired),
        value: roundMoney(Number(r.value)),
        expiredValue: roundMoney(Number(r.expired_value)),
        batches: Number(r.batches),
        nearestExpiry: r.nearest_expiry,
        daysLeft,
        status: onHand === 0 || daysLeft === null ? 'empty' : expiryStatus(daysLeft, settings),
        minStock,
        belowMin: minStock > 0 && available <= minStock,
      } satisfies StockRowDto;
    }),
  };
}

export interface MovementFilter {
  locationIds: string[] | null;
  productId?: string | undefined;
  type?: MovementDto['type'] | undefined;
  documentId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit: number;
  offset: number;
}

const MOVEMENT_COLUMNS = [
  'm.id',
  'm.created_at',
  'm.type',
  'm.quantity',
  'm.unit_cost',
  'm.unit_price',
  'm.reason',
  'm.comment',
  'm.product_id',
  'm.location_id',
  'm.batch_id',
  'm.document_id',
  'p.name as product_name',
  'p.unit',
  'l.name as location_name',
  'b.expires_on',
  'd.number as document_number',
  'd.actor_name',
  'di.name as dish_name',
] as const;

export async function listMovements(deps: Deps, f: MovementFilter): Promise<Page<MovementDto>> {
  const tz = deps.config.businessTz;
  const filtered = deps.db
    .selectFrom('stock_movements as m')
    .innerJoin('products as p', 'p.id', 'm.product_id')
    .innerJoin('locations as l', 'l.id', 'm.location_id')
    .innerJoin('batches as b', 'b.id', 'm.batch_id')
    .innerJoin('documents as d', 'd.id', 'm.document_id')
    .leftJoin('dishes as di', 'di.id', 'm.dish_id')
    .$if(f.locationIds !== null, (qb) => qb.where('m.location_id', 'in', (f.locationIds as string[]).length ? (f.locationIds as string[]) : ['00000000-0000-0000-0000-000000000000']))
    .$if(f.productId !== undefined, (qb) => qb.where('m.product_id', '=', f.productId as string))
    .$if(f.type !== undefined, (qb) => qb.where('m.type', '=', f.type as MovementDto['type']))
    .$if(f.documentId !== undefined, (qb) => qb.where('m.document_id', '=', f.documentId as string))
    .$if(f.from !== undefined, (qb) => qb.where(sql<boolean>`(m.created_at AT TIME ZONE ${tz})::date >= ${f.from}::date`))
    .$if(f.to !== undefined, (qb) => qb.where(sql<boolean>`(m.created_at AT TIME ZONE ${tz})::date <= ${f.to}::date`));

  const total = await filtered.select(sql<number>`count(*)`.as('n')).executeTakeFirstOrThrow();
  const rows = await filtered
    .select([...MOVEMENT_COLUMNS])
    .orderBy('m.id', 'desc')
    .limit(f.limit)
    .offset(f.offset)
    .execute();
  return { total: Number(total.n), limit: f.limit, offset: f.offset, items: rows.map(toMovementDto) };
}

interface MovementRow {
  id: number;
  created_at: Date;
  type: MovementDto['type'];
  quantity: string;
  unit_cost: string;
  unit_price: string | null;
  reason: string | null;
  comment: string | null;
  product_id: string;
  location_id: string;
  batch_id: string;
  document_id: string;
  product_name: string;
  unit: MovementDto['unit'];
  location_name: string;
  expires_on: string;
  document_number: string;
  actor_name: string;
  dish_name: string | null;
}

export function toMovementDto(r: MovementRow): MovementDto {
  return {
    id: String(r.id),
    createdAt: r.created_at.toISOString(),
    type: r.type,
    quantity: Number(r.quantity),
    unitCost: Number(r.unit_cost),
    unitPrice: r.unit_price === null ? null : Number(r.unit_price),
    reason: r.reason as WriteoffReason | null,
    comment: r.comment,
    productId: r.product_id,
    productName: r.product_name,
    unit: r.unit,
    locationId: r.location_id,
    locationName: r.location_name,
    batchId: r.batch_id,
    expiresOn: r.expires_on,
    documentId: r.document_id,
    documentNumber: r.document_number,
    dishName: r.dish_name,
    authorName: r.actor_name,
  };
}

export interface DocumentFilter {
  locationIds: string[] | null;
  kind?: DocumentDto['kind'] | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit: number;
  offset: number;
}

interface DocRow {
  id: string;
  kind: DocumentDto['kind'];
  number: string;
  location_id: string;
  location_name: string;
  created_at: Date;
  actor_name: string;
  comment: string | null;
  lines: number;
  total_amount: string;
}

export async function listDocuments(deps: Deps, f: DocumentFilter): Promise<Page<DocumentDto>> {
  const tz = deps.config.businessTz;
  const where: RawBuilder<unknown>[] = [];
  if (f.locationIds) where.push(sql`(d.location_id IN (${inList(f.locationIds)}) OR d.to_location_id IN (${inList(f.locationIds)}))`);
  if (f.kind) where.push(sql`d.kind = ${f.kind}`);
  if (f.from) where.push(sql`(d.created_at AT TIME ZONE ${tz})::date >= ${f.from}::date`);
  if (f.to) where.push(sql`(d.created_at AT TIME ZONE ${tz})::date <= ${f.to}::date`);
  const whereSql = where.length ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``;

  const total = await sql<{ n: number }>`SELECT count(*) AS n FROM documents d ${whereSql}`.execute(deps.db);
  // сначала страница документов по индексу, и только для неё считаются строки и суммы
  const rows = await sql<DocRow>`
    WITH page AS (
      SELECT d.id, d.kind, d.number, d.location_id, d.created_at, d.actor_name, d.comment
      FROM documents d
      ${whereSql}
      ORDER BY d.created_at DESC, d.number DESC
      LIMIT ${f.limit} OFFSET ${f.offset}
    )
    SELECT p.id, p.kind, p.number, p.location_id, l.name AS location_name, p.created_at, p.actor_name, p.comment,
           COUNT(m.id) FILTER (WHERE m.type <> 'transfer_in') AS lines,
           COALESCE(SUM(abs(m.quantity) * m.unit_cost) FILTER (WHERE m.type <> 'transfer_in'), 0) AS total_amount
    FROM page p
    JOIN locations l ON l.id = p.location_id
    LEFT JOIN stock_movements m ON m.document_id = p.id
    GROUP BY p.id, p.kind, p.number, p.location_id, p.created_at, p.actor_name, p.comment, l.name
    ORDER BY p.created_at DESC, p.number DESC`.execute(deps.db);

  return {
    total: Number(total.rows[0]?.n ?? 0),
    limit: f.limit,
    offset: f.offset,
    items: rows.rows.map(toDocumentDto),
  };
}

function toDocumentDto(r: DocRow): DocumentDto {
  return {
    id: r.id,
    kind: r.kind,
    number: r.number,
    locationId: r.location_id,
    locationName: r.location_name,
    createdAt: r.created_at.toISOString(),
    authorName: r.actor_name,
    comment: r.comment,
    lines: Number(r.lines),
    totalAmount: roundMoney(Number(r.total_amount)),
  };
}

export async function getDocument(deps: Deps, id: string, allowed: string[] | null): Promise<DocumentDetailDto> {
  const head = await deps.db.selectFrom('documents').select(['location_id', 'to_location_id']).where('id', '=', id).executeTakeFirst();
  const visible =
    head && (!allowed || allowed.includes(head.location_id) || (head.to_location_id !== null && allowed.includes(head.to_location_id)));
  if (!head || !visible) throw notFound('Документ');

  const rows = await sql<DocRow>`
    SELECT d.id, d.kind, d.number, d.location_id, l.name AS location_name, d.created_at, d.actor_name, d.comment,
           COUNT(m.id) FILTER (WHERE m.type <> 'transfer_in') AS lines,
           COALESCE(SUM(abs(m.quantity) * m.unit_cost) FILTER (WHERE m.type <> 'transfer_in'), 0) AS total_amount
    FROM documents d
    JOIN locations l ON l.id = d.location_id
    LEFT JOIN stock_movements m ON m.document_id = d.id
    WHERE d.id = ${id}::uuid
    GROUP BY d.id, l.name`.execute(deps.db);
  const doc = rows.rows[0];
  if (!doc) throw notFound('Документ');
  const movements = await listMovements(deps, { locationIds: null, documentId: id, limit: 200, offset: 0 });
  return { ...toDocumentDto(doc), movements: movements.items.reverse() };
}
