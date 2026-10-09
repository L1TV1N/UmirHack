import { canonicalBarcode, parseScan, VSD_REDEEM_HOURS, type ReceiptBody, type TraceabilitySummaryDto } from '@zapas/shared';
import { sql, type Transaction } from 'kysely';
import type { Database } from '../../db/types';
import type { Deps } from '../../lib/context';
import { badRequest, conflict, pgCode, PG_UNIQUE_VIOLATION, unprocessable } from '../../lib/errors';

interface Args {
  lines: ReceiptBody['lines'];
  /** Партии, созданные приходом, в том же порядке, что и строки. */
  batches: { id: string; product_id: string }[];
  products: Map<string, { name: string; unit: 'kg' | 'l' | 'pcs' }>;
  supplierId: string | null;
  locationId: string;
  now: Date;
}

interface ParsedMark {
  line: number;
  index: number;
  gtin: string;
  serial: string;
  code: string;
}

const CHUNK = 500;

/**
 * Записывает при приходе коды маркировки и ВСД, если они были указаны. Всё внутри транзакции прихода: приход либо
 * проходит целиком вместе с марками, либо не проходит совсем.
 */
export async function recordReceiptTraceability(trx: Transaction<Database>, a: Args): Promise<{ marks: number; vsd: number }> {
  const marks: ParsedMark[] = [];
  const seen = new Map<string, ParsedMark>();
  const withMarks = a.lines.map((l, i) => ({ l, i })).filter(({ l }) => l.marks?.length);

  if (withMarks.length > 0) {
    const ids = [...new Set(withMarks.map(({ l }) => l.productId))];
    const barcodes = new Map(
      (await trx.selectFrom('products').select(['id', 'barcode']).where('id', 'in', ids).execute()).map((r) => [r.id, r.barcode ? canonicalBarcode(r.barcode) : null]),
    );

    for (const { l, i } of withMarks) {
      const product = a.products.get(l.productId);
      if (product?.unit === 'pcs' && (l.marks?.length ?? 0) > Math.ceil(l.quantity)) {
        throw unprocessable(
          `Марок больше, чем штук в строке: ${l.marks?.length} при ${l.quantity}`,
          [{ path: ['lines', i, 'marks'], message: 'Марок больше количества' }],
          'too_many_marks',
        );
      }
      (l.marks ?? []).forEach((code, j) => {
        const scan = parseScan(code);
        if (scan.kind !== 'gs1' || !scan.gtin || !scan.serial) {
          throw badRequest('Это не код маркировки: нет GTIN и серийного номера', [{ path: ['lines', i, 'marks', j], message: 'Не код маркировки' }], 'bad_mark');
        }
        const own = barcodes.get(l.productId);
        if (own && own !== scan.gtin) {
          throw unprocessable(
            `Марка другого товара: GTIN ${scan.gtin.replace(/^0+/, '')} не совпадает со штрихкодом «${product?.name ?? 'продукта'}»`,
            [{ path: ['lines', i, 'marks', j], message: 'Марка другого товара' }],
            'mark_gtin_mismatch',
          );
        }
        const key = `${scan.gtin}|${scan.serial}`;
        const dup = seen.get(key);
        if (dup) {
          throw badRequest('Одна и та же марка отсканирована дважды', [{ path: ['lines', i, 'marks', j], message: 'Повтор марки' }], 'mark_duplicate');
        }
        const parsed: ParsedMark = { line: i, index: j, gtin: scan.gtin, serial: scan.serial, code: code.split('\u001d').join('') };
        seen.set(key, parsed);
        marks.push(parsed);
      });
    }

    // марку принимают один раз: повтор значит дубль накладной, чужая партия или подделку
    const existing = new Set<string>();
    for (let from = 0; from < marks.length; from += CHUNK) {
      const part = marks.slice(from, from + CHUNK);
      const rows = await trx
        .selectFrom('batch_marks')
        .select(['gtin', 'serial'])
        .where(sql<boolean>`(gtin, serial) IN (${sql.join(part.map((m) => sql`(${m.gtin}, ${m.serial})`))})`)
        .execute();
      for (const r of rows) existing.add(`${r.gtin}|${r.serial}`);
    }
    if (existing.size > 0) {
      const first = marks.filter((m) => existing.has(`${m.gtin}|${m.serial}`));
      throw conflict(
        `Эти марки уже были приняты раньше: ${first.length}. Возможно, накладная оприходована повторно`,
        first.slice(0, 20).map((m) => ({ path: ['lines', m.line, 'marks', m.index], message: 'Марка уже принята' })),
        'mark_duplicate',
      );
    }
  }

  const certs: { number: string; lineIndex: number }[] = [];
  const numbers = new Set<string>();
  a.lines.forEach((l, i) => {
    if (!l.vsd) return;
    if (numbers.has(l.vsd)) throw badRequest('Один ВСД указан в двух строках', [{ path: ['lines', i, 'vsd'], message: 'ВСД уже указан выше' }], 'vsd_duplicate');
    numbers.add(l.vsd);
    certs.push({ number: l.vsd, lineIndex: i });
  });
  if (certs.length > 0) {
    const taken = await trx.selectFrom('vet_certificates').select('number').where('number', 'in', [...numbers]).execute();
    if (taken.length > 0) {
      const takenSet = new Set(taken.map((t) => t.number));
      throw conflict(
        'Этот ВСД уже принят раньше',
        certs.filter((c) => takenSet.has(c.number)).map((c) => ({ path: ['lines', c.lineIndex, 'vsd'], message: 'ВСД уже принят' })),
        'vsd_duplicate',
      );
    }
  }

  try {
    for (let from = 0; from < marks.length; from += CHUNK) {
      await trx
        .insertInto('batch_marks')
        .values(marks.slice(from, from + CHUNK).map((m) => ({ batch_id: (a.batches[m.line] as { id: string }).id, gtin: m.gtin, serial: m.serial, code: m.code, created_at: a.now })))
        .execute();
    }
    if (certs.length > 0) {
      const due = new Date(a.now.getTime() + VSD_REDEEM_HOURS * 3_600_000);
      await trx
        .insertInto('vet_certificates')
        .values(
          certs.map((c) => {
            const line = a.lines[c.lineIndex] as ReceiptBody['lines'][number];
            const batch = a.batches[c.lineIndex] as { id: string };
            return { number: c.number, batch_id: batch.id, product_id: line.productId, supplier_id: a.supplierId, location_id: a.locationId, quantity: line.quantity, received_at: a.now, due_at: due };
          }),
        )
        .execute();
    }
  } catch (err) {
    // две приёмки одной марки или одного ВСД одновременно: выигрывает первая
    if (pgCode(err) === PG_UNIQUE_VIOLATION) throw conflict('Марка или ВСД уже приняты другим документом', undefined, 'mark_duplicate');
    throw err;
  }
  return { marks: marks.length, vsd: certs.length };
}

/** Условие «точка из доступных»: у псевдонима l таблицы точек. null означает все точки. */
export const inScope = (ids: string[] | null) =>
  ids === null ? sql`TRUE` : ids.length ? sql`l.id IN (${sql.join(ids.map((i) => sql`${i}::uuid`))})` : sql`FALSE`;

export async function traceabilitySummary(deps: Deps, scope: string[] | null): Promise<TraceabilitySummaryDto> {
  const now = deps.clock();
  const vsd = await sql<{ pending: string; overdue: string }>`
    SELECT count(*) FILTER (WHERE v.status = 'pending') AS pending,
           count(*) FILTER (WHERE v.status = 'pending' AND v.due_at < ${now}) AS overdue
    FROM vet_certificates v JOIN locations l ON l.id = v.location_id WHERE ${inScope(scope)}`.execute(deps.db);
  const marks = await sql<{ n: string }>`
    SELECT count(*) AS n FROM batch_marks m JOIN batches b ON b.id = m.batch_id JOIN locations l ON l.id = b.location_id WHERE ${inScope(scope)}`.execute(deps.db);
  return { vsdPending: Number(vsd.rows[0]?.pending ?? 0), vsdOverdue: Number(vsd.rows[0]?.overdue ?? 0), marksTotal: Number(marks.rows[0]?.n ?? 0) };
}
