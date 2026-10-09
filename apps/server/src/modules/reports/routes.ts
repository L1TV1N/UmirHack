import {
  EXPIRY_STATUS_LABELS,
  MOVEMENT_TYPE_LABELS,
  WRITEOFF_REASON_LABELS,
  UNIT_LABELS,
  reportQuery,
  type BatchDto,
  type MovementDto,
} from '@zapas/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Deps } from '../../lib/context';
import { toCsv } from '../../lib/csv';
import { locationFilter } from '../../lib/scope';
import { businessToday } from '../../lib/time';
import { asUser, requireUser } from '../../plugins/access';
import { writeAudit } from '../audit/audit';
import { listBatches, listMovements } from '../stock/queries';

const MAX_ROWS = 50_000;

const batchStatusLabel = (b: BatchDto) => (b.status === 'depleted' ? 'Израсходована' : EXPIRY_STATUS_LABELS[b.status]);
const dateTime = (iso: string) => iso.slice(0, 16).replace('T', ' ');

export const reportRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const today = () => businessToday(deps);

    async function exportCsv(
      req: Parameters<typeof requireUser>[0],
      name: string,
      body: string,
      rows: number,
    ): Promise<string> {
      await writeAudit(deps.db, {
        action: 'report.export',
        entity: 'report',
        entityId: name,
        principal: requireUser(req),
        meta: req.meta,
        at: deps.clock(),
        details: { rows },
      });
      return body;
    }

    app.get('/reports/stock.csv', { config: asUser('manager'), schema: { querystring: reportQuery } }, async (req, reply) => {
      const page = await listBatches(deps, {
        locationIds: locationFilter(requireUser(req), req.query.locationId),
        status: 'active',
        limit: MAX_ROWS,
        offset: 0,
      });
      const csv = toCsv(
        ['Точка', 'Артикул', 'Продукт', 'Принято', 'Годен до', 'Дней до срока', 'Статус', 'Остаток', 'Ед.', 'Себестоимость за ед.', 'Стоимость', 'Скидка, %'],
        page.items.map((b) => [
          b.locationName,
          b.sku,
          b.productName,
          b.receivedOn,
          b.expiresOn,
          b.daysLeft,
          batchStatusLabel(b),
          b.remainingQty,
          UNIT_LABELS[b.unit],
          b.unitCost,
          b.value,
          b.promotion?.percent ?? '',
        ]),
      );
      const out = await exportCsv(req, 'stock', csv, page.items.length);
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="stock-${today()}.csv"`)
        .send(out);
    });

    const movementRow = (m: MovementDto) => [
      dateTime(m.createdAt),
      m.documentNumber,
      MOVEMENT_TYPE_LABELS[m.type],
      m.reason ? WRITEOFF_REASON_LABELS[m.reason] : '',
      m.locationName,
      m.productName,
      m.expiresOn,
      m.quantity,
      UNIT_LABELS[m.unit],
      m.unitCost,
      Math.round(Math.abs(m.quantity) * m.unitCost * 100) / 100,
      m.unitPrice ?? '',
      m.dishName ?? '',
      m.authorName,
    ];
    const movementHeaders = [
      'Дата',
      'Документ',
      'Операция',
      'Причина',
      'Точка',
      'Продукт',
      'Годен до',
      'Количество',
      'Ед.',
      'Себестоимость за ед.',
      'Сумма по себестоимости',
      'Цена продажи',
      'Блюдо',
      'Автор',
    ];

    app.get('/reports/writeoffs.csv', { config: asUser('manager'), schema: { querystring: reportQuery } }, async (req, reply) => {
      const locationIds = locationFilter(requireUser(req), req.query.locationId);
      const base = { locationIds, from: req.query.from, to: req.query.to, limit: MAX_ROWS, offset: 0 };
      const [writeoffs, shortages] = await Promise.all([
        listMovements(deps, { ...base, type: 'writeoff' }),
        listMovements(deps, { ...base, type: 'adjustment_out' }),
      ]);
      const items = [...writeoffs.items, ...shortages.items].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      const out = await exportCsv(req, 'writeoffs', toCsv(movementHeaders, items.map(movementRow)), items.length);
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="writeoffs-${today()}.csv"`)
        .send(out);
    });

    app.get('/reports/movements.csv', { config: asUser('manager'), schema: { querystring: reportQuery } }, async (req, reply) => {
      const page = await listMovements(deps, {
        locationIds: locationFilter(requireUser(req), req.query.locationId),
        from: req.query.from,
        to: req.query.to,
        limit: MAX_ROWS,
        offset: 0,
      });
      const out = await exportCsv(req, 'movements', toCsv(movementHeaders, page.items.map(movementRow)), page.items.length);
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="movements-${today()}.csv"`)
        .send(out);
    });
  };
