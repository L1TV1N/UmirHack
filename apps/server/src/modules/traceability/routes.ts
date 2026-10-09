import {
  idParam,
  marksQuery,
  redeemBody,
  reportQuery,
  vsdQuery,
  type MarkBatchDto,
  type Page,
  type TraceabilitySummaryDto,
  type VsdDto,
} from '@zapas/shared';
import { sql } from 'kysely';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Deps } from '../../lib/context';
import { toCsv } from '../../lib/csv';
import { conflict, notFound } from '../../lib/errors';
import { assertLocation, locationFilter } from '../../lib/scope';
import { asUser, requireUser } from '../../plugins/access';
import { writeAudit } from '../audit/audit';
import { inScope, traceabilitySummary } from './service';

interface VsdRow {
  id: string;
  number: string;
  status: 'pending' | 'redeemed';
  product_id: string;
  product_name: string;
  unit: 'kg' | 'l' | 'pcs';
  quantity: string;
  location_id: string;
  location_name: string;
  supplier_name: string | null;
  document_number: string | null;
  received_at: Date;
  due_at: Date;
  redeemed_at: Date | null;
  redeemed_by: string | null;
  comment: string | null;
}

export const traceabilityRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;

    const toVsd = (r: VsdRow, now: Date): VsdDto => ({
      id: r.id,
      number: r.number,
      status: r.status,
      productId: r.product_id,
      productName: r.product_name,
      unit: r.unit,
      quantity: Number(r.quantity),
      locationId: r.location_id,
      locationName: r.location_name,
      supplierName: r.supplier_name,
      documentNumber: r.document_number,
      receivedAt: r.received_at.toISOString(),
      dueAt: r.due_at.toISOString(),
      overdue: r.status === 'pending' && r.due_at.getTime() < now.getTime(),
      redeemedAt: r.redeemed_at?.toISOString() ?? null,
      redeemedBy: r.redeemed_by,
      comment: r.comment,
    });

    const vsdSelect = (scope: string[] | null, status: 'pending' | 'redeemed' | 'all') => sql<VsdRow>`
      SELECT v.id, v.number, v.status, v.product_id, p.name AS product_name, p.unit, v.quantity,
             v.location_id, l.name AS location_name, s.name AS supplier_name, d.number AS document_number,
             v.received_at, v.due_at, v.redeemed_at, u.full_name AS redeemed_by, v.comment
      FROM vet_certificates v
      JOIN products p ON p.id = v.product_id
      JOIN locations l ON l.id = v.location_id
      JOIN batches b ON b.id = v.batch_id
      LEFT JOIN documents d ON d.id = b.origin_document_id
      LEFT JOIN suppliers s ON s.id = v.supplier_id
      LEFT JOIN users u ON u.id = v.redeemed_by
      WHERE ${inScope(scope)} ${status === 'all' ? sql`` : sql`AND v.status = ${status}`}`;

    app.get('/traceability/summary', { config: asUser('storekeeper') }, async (req): Promise<TraceabilitySummaryDto> =>
      traceabilitySummary(deps, locationFilter(requireUser(req))),
    );

    app.get('/traceability/vsd', { config: asUser('storekeeper'), schema: { querystring: vsdQuery } }, async (req): Promise<Page<VsdDto>> => {
      const { status, locationId, limit, offset } = req.query;
      const scope = locationFilter(requireUser(req), locationId);
      const now = deps.clock();
      const base = vsdSelect(scope, status);
      const total = await sql<{ n: string }>`SELECT count(*) AS n FROM (${base}) t`.execute(db);
      const order = status === 'redeemed' ? sql`redeemed_at DESC` : sql`(status = 'pending') DESC, due_at ASC`;
      const rows = await sql<VsdRow>`SELECT * FROM (${base}) t ORDER BY ${order}, number LIMIT ${limit} OFFSET ${offset}`.execute(db);
      return { items: rows.rows.map((r) => toVsd(r, now)), total: Number(total.rows[0]?.n ?? 0), limit, offset };
    });

    // Погасили в «Меркурии» — отмечаем здесь: система напоминает, но в ГИС сама не ходит
    app.post('/traceability/vsd/:id/redeem', { config: asUser('storekeeper'), schema: { params: idParam, body: redeemBody } }, async (req, reply) => {
      const principal = requireUser(req);
      const now = deps.clock();
      await db.transaction().execute(async (trx) => {
        const row = await trx.selectFrom('vet_certificates').select(['id', 'location_id', 'status', 'number']).where('id', '=', req.params.id).forUpdate().executeTakeFirst();
        if (!row) throw notFound('ВСД');
        assertLocation(principal, row.location_id);
        if (row.status === 'redeemed') throw conflict('ВСД уже отмечен погашенным', undefined, 'already_redeemed');
        await trx.updateTable('vet_certificates').set({ status: 'redeemed', redeemed_at: now, redeemed_by: principal.id, comment: req.body.comment ?? null }).where('id', '=', row.id).execute();
        await writeAudit(trx, { action: 'vsd.redeem', entity: 'vet_certificate', entityId: row.id, principal, meta: req.meta, at: now, details: { number: row.number } });
      });
      return reply.status(204).send();
    });

    // Ошиблись при отметке: менеджер возвращает ВСД в очередь
    app.post('/traceability/vsd/:id/reopen', { config: asUser('manager'), schema: { params: idParam } }, async (req, reply) => {
      const principal = requireUser(req);
      const now = deps.clock();
      await db.transaction().execute(async (trx) => {
        const row = await trx.selectFrom('vet_certificates').select(['id', 'status', 'number']).where('id', '=', req.params.id).forUpdate().executeTakeFirst();
        if (!row) throw notFound('ВСД');
        if (row.status !== 'redeemed') throw conflict('ВСД и так ждёт погашения', undefined, 'not_redeemed');
        await trx.updateTable('vet_certificates').set({ status: 'pending', redeemed_at: null, redeemed_by: null, comment: null }).where('id', '=', row.id).execute();
        await writeAudit(trx, { action: 'vsd.reopen', entity: 'vet_certificate', entityId: row.id, principal, meta: req.meta, at: now, details: { number: row.number } });
      });
      return reply.status(204).send();
    });

    app.get('/traceability/marks', { config: asUser('storekeeper'), schema: { querystring: marksQuery } }, async (req): Promise<Page<MarkBatchDto>> => {
      const { locationId, limit, offset } = req.query;
      const scope = locationFilter(requireUser(req), locationId);
      const base = sql`
        SELECT b.id AS batch_id, p.id AS product_id, p.name AS product_name, p.unit, l.id AS location_id, l.name AS location_name,
               s.name AS supplier_name, d.number AS document_number, b.received_on, count(m.id) AS marks, b.remaining_qty
        FROM batch_marks m
        JOIN batches b ON b.id = m.batch_id
        JOIN products p ON p.id = b.product_id
        JOIN locations l ON l.id = b.location_id
        LEFT JOIN suppliers s ON s.id = b.supplier_id
        LEFT JOIN documents d ON d.id = b.origin_document_id
        WHERE ${inScope(scope)}
        GROUP BY b.id, p.id, l.id, s.id, d.id`;
      const total = await sql<{ n: string }>`SELECT count(*) AS n FROM (${base}) t`.execute(db);
      const rows = await sql<{
        batch_id: string; product_id: string; product_name: string; unit: 'kg' | 'l' | 'pcs'; location_id: string; location_name: string;
        supplier_name: string | null; document_number: string | null; received_on: string; marks: string; remaining_qty: string;
      }>`SELECT * FROM (${base}) t ORDER BY received_on DESC, product_name LIMIT ${limit} OFFSET ${offset}`.execute(db);
      return {
        items: rows.rows.map((r) => {
          const marks = Number(r.marks);
          const remaining = Number(r.remaining_qty);
          return {
            batchId: r.batch_id,
            productId: r.product_id,
            productName: r.product_name,
            unit: r.unit,
            locationId: r.location_id,
            locationName: r.location_name,
            supplierName: r.supplier_name,
            documentNumber: r.document_number,
            receivedOn: r.received_on,
            marks,
            remaining,
            disposed: r.unit === 'pcs' ? Math.max(0, marks - Math.ceil(remaining)) : null,
          };
        }),
        total: Number(total.rows[0]?.n ?? 0),
        limit,
        offset,
      };
    });

    // Реестр принятых марок для сверки с личным кабинетом «Честного знака»
    app.get('/reports/marks.csv', { config: asUser('manager'), schema: { querystring: reportQuery } }, async (req, reply) => {
      const principal = requireUser(req);
      const scope = locationFilter(principal, req.query.locationId);
      const { from, to } = req.query;
      const rows = await sql<{ location_name: string; product_name: string; received_on: string; document_number: string | null; gtin: string; serial: string; code: string }>`
        SELECT l.name AS location_name, p.name AS product_name, b.received_on, d.number AS document_number, m.gtin, m.serial, m.code
        FROM batch_marks m
        JOIN batches b ON b.id = m.batch_id
        JOIN products p ON p.id = b.product_id
        JOIN locations l ON l.id = b.location_id
        LEFT JOIN documents d ON d.id = b.origin_document_id
        WHERE ${inScope(scope)} ${from ? sql`AND b.received_on >= ${from}::date` : sql``} ${to ? sql`AND b.received_on <= ${to}::date` : sql``}
        ORDER BY b.received_on, p.name, m.serial
        LIMIT 50000`.execute(db);
      await writeAudit(db, { action: 'report.export', entity: 'report', entityId: 'marks', principal, meta: req.meta, at: deps.clock(), details: { rows: rows.rows.length } });
      const csv = toCsv(
        ['Точка', 'Продукт', 'Принято', 'Приход', 'GTIN', 'Серийный номер', 'Код маркировки'],
        rows.rows.map((r) => [r.location_name, r.product_name, r.received_on, r.document_number, r.gtin, r.serial, r.code]),
      );
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="marks-${deps.clock().toISOString().slice(0, 10)}.csv"`)
        .send(csv);
    });
  };
