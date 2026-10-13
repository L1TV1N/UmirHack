import {
  haccpActionBody,
  haccpInspectionBody,
  haccpLocationQuery,
  haccpPointBody,
  haccpPointPatch,
  haccpReadingBody,
  haccpReadingsQuery,
  idParam,
  pageQuery,
  type HaccpInspectionDto,
  type HaccpPendingBatchDto,
  type HaccpPointDto,
  type HaccpReadingDto,
  type HaccpSummaryDto,
  type Page,
} from '@zapas/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../../lib/context';
import { toCsv } from '../../lib/csv';
import { businessToday } from '../../lib/time';
import { asUser, requireUser } from '../../plugins/access';
import { writeAudit } from '../audit/audit';
import { addAction, addInspection, addReading, createPoint, listInspections, listPoints, listReadings, pendingInspections, summary, updatePoint } from './service';

const readingId = z.object({ id: z.coerce.number().int().positive() });
const inspectionsQuery = pageQuery.extend({ locationId: z.uuid().optional() });
const exportQuery = z.object({ locationId: z.uuid().optional(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
const MAX_ROWS = 50_000;
const dateTime = (iso: string) => iso.slice(0, 16).replace('T', ' ');

export const haccpRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.get('/haccp/summary', { config: asUser(), schema: { querystring: haccpLocationQuery } }, async (req): Promise<HaccpSummaryDto> => summary(deps, requireUser(req), req.query.locationId));

    app.get('/haccp/points', { config: asUser(), schema: { querystring: haccpLocationQuery } }, async (req): Promise<HaccpPointDto[]> =>
      listPoints(deps, requireUser(req), req.query.locationId, requireUser(req).role === 'admin' || requireUser(req).role === 'manager'),
    );

    app.post('/haccp/points', { config: asUser('manager'), schema: { body: haccpPointBody } }, async (req, reply) =>
      reply.status(201).send(await createPoint(deps, requireUser(req), req.meta, req.body)),
    );

    app.patch('/haccp/points/:id', { config: asUser('manager'), schema: { params: idParam, body: haccpPointPatch } }, async (req) =>
      updatePoint(deps, requireUser(req), req.meta, req.params.id, req.body),
    );

    app.get('/haccp/readings', { config: asUser(), schema: { querystring: haccpReadingsQuery } }, async (req): Promise<Page<HaccpReadingDto>> =>
      listReadings(deps, requireUser(req), req.query),
    );

    app.post('/haccp/readings', { config: asUser('storekeeper'), schema: { body: haccpReadingBody } }, async (req, reply) =>
      reply.status(201).send(await addReading(deps, requireUser(req), req.meta, req.body)),
    );

    app.post('/haccp/readings/:id/action', { config: asUser('storekeeper'), schema: { params: readingId, body: haccpActionBody } }, async (req) =>
      addAction(deps, requireUser(req), req.meta, req.params.id, req.body.action),
    );

    app.get('/haccp/inspections/pending', { config: asUser('storekeeper'), schema: { querystring: haccpLocationQuery } }, async (req): Promise<HaccpPendingBatchDto[]> =>
      pendingInspections(deps, requireUser(req), req.query.locationId),
    );

    app.get('/haccp/inspections', { config: asUser(), schema: { querystring: inspectionsQuery } }, async (req): Promise<Page<HaccpInspectionDto>> =>
      listInspections(deps, requireUser(req), req.query.locationId, req.query.limit, req.query.offset),
    );

    app.post('/haccp/inspections', { config: asUser('storekeeper'), schema: { body: haccpInspectionBody } }, async (req, reply) =>
      reply.status(201).send(await addInspection(deps, requireUser(req), req.meta, req.body)),
    );

    // Журнал для проверяющих: все замеры за период с отметкой о норме и записанными действиями
    app.get('/reports/haccp.csv', { config: asUser('manager'), schema: { querystring: exportQuery } }, async (req, reply) => {
      const page = await listReadings(deps, requireUser(req), { ...req.query, limit: 200, offset: 0 });
      const items = [...page.items];
      for (let offset = 200; offset < Math.min(page.total, MAX_ROWS); offset += 200) {
        items.push(...(await listReadings(deps, requireUser(req), { ...req.query, limit: 200, offset })).items);
      }
      const csv = toCsv(
        ['Дата и время', 'Точка', 'Контрольная точка', 'Температура, °C', 'Норма от', 'Норма до', 'В норме', 'Комментарий', 'Кто измерил', 'Корректирующее действие', 'Кто записал действие'],
        items.map((r) => [dateTime(r.measuredAt), r.locationName, r.pointName, r.value, r.minTemp, r.maxTemp, r.inRange ? 'да' : 'нет', r.comment ?? '', r.authorName, r.action?.text ?? '', r.action?.authorName ?? '']),
      );
      await writeAudit(deps.db, { action: 'report.export', entity: 'report', entityId: 'haccp', principal: requireUser(req), meta: req.meta, at: deps.clock(), details: { rows: items.length } });
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="haccp-${businessToday(deps)}.csv"`)
        .send(csv);
    });
  };
