import { roundMoney, type MarkdownDto } from '@zapas/shared';
import { sql } from 'kysely';
import type { Db } from '../../db/client';
import type { Database } from '../../db/types';
import type { Transaction } from 'kysely';

type Executor = Db | Transaction<Database>;

/**
 * Скидка, по которой касса продаст следующую единицу каждого товара. Расход идёт по FEFO, поэтому смотрим на ближайшую
 * непросроченную партию с остатком: если на ней действует скидка, она и есть цена на кассе. Нет скидки, нет и записи.
 */
export async function nextMarkdowns(db: Executor, locationId: string, today: string, productIds?: string[]): Promise<Map<string, MarkdownDto>> {
  if (productIds && productIds.length === 0) return new Map();
  const rows = await sql<{ product_id: string; price: string; percent: number; ends_on: string; remaining: string }>`
    SELECT DISTINCT ON (b.product_id) b.product_id, p.price, pr.percent, pr.ends_on::text AS ends_on, b.remaining_qty AS remaining
    FROM batches b
    JOIN products p ON p.id = b.product_id
    LEFT JOIN promotions pr ON pr.batch_id = b.id AND pr.cancelled_at IS NULL AND pr.ends_on >= ${today}::date
    WHERE b.location_id = ${locationId}::uuid AND b.remaining_qty > 0 AND b.expires_on >= ${today}::date
      ${productIds ? sql`AND b.product_id IN (${sql.join(productIds.map((id) => sql`${id}::uuid`))})` : sql``}
    ORDER BY b.product_id, b.expires_on, b.received_on, b.id`.execute(db);

  const out = new Map<string, MarkdownDto>();
  for (const r of rows.rows) {
    if (r.percent === null) continue;
    out.set(r.product_id, {
      percent: r.percent,
      price: roundMoney(Number(r.price) * (1 - r.percent / 100)),
      endsOn: r.ends_on,
      quantity: Number(r.remaining),
    });
  }
  return out;
}
