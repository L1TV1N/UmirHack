import { toMilli } from '@zapas/shared';
import { sql, type Transaction } from 'kysely';
import type { Database } from '../../db/types';
import { compareFefo } from '../../domain/fefo';

export interface Candidate {
  id: string;
  productId: string;
  locationId: string;
  remainingMilli: number;
  expiresOn: string;
  receivedOn: string;
  unitCost: number;
  supplierId: string | null;
  documentNo: string | null;
}

export interface LockOptions {
  locationId: string;
  today: string;
  productIds?: string[];
  includeExpired: boolean;
  expiredOnly?: boolean;
}

/**
 * Блокирует партии с остатком одним запросом в детерминированном порядке. Два параллельных документа
 * всегда берут блокировки в одной последовательности, поэтому взаимной блокировки не бывает.
 */
export async function lockCandidates(trx: Transaction<Database>, o: LockOptions): Promise<Candidate[]> {
  if (o.productIds && o.productIds.length === 0) return [];
  const rows = await trx
    .selectFrom('batches')
    .select([
      'id',
      'product_id',
      'location_id',
      'remaining_qty',
      'expires_on',
      'received_on',
      'unit_cost',
      'supplier_id',
      'document_no',
    ])
    .where('location_id', '=', o.locationId)
    .where('remaining_qty', '>', '0')
    .$if(Boolean(o.productIds), (qb) => qb.where('product_id', 'in', o.productIds as string[]))
    .$if(o.expiredOnly === true, (qb) => qb.where('expires_on', '<', o.today))
    .$if(!o.includeExpired && o.expiredOnly !== true, (qb) => qb.where('expires_on', '>=', o.today))
    .orderBy('product_id')
    .orderBy('expires_on')
    .orderBy('received_on')
    .orderBy('id')
    .forUpdate()
    .execute();
  return rows.map((r) => ({
    id: r.id,
    productId: r.product_id,
    locationId: r.location_id,
    remainingMilli: toMilli(Number(r.remaining_qty)),
    expiresOn: r.expires_on,
    receivedOn: r.received_on,
    unitCost: Number(r.unit_cost),
    supplierId: r.supplier_id,
    documentNo: r.document_no,
  }));
}

export interface Need {
  productId: string;
  milli: number;
  /** Если задано, берём только из этой партии. */
  batchId?: string;
  /** Откуда пришла потребность: номер строки документа, для разбора результата. */
  line: number;
}

export interface Allocation {
  need: Need;
  candidate: Candidate;
  milli: number;
}

export interface Shortage {
  need: Need;
  shortMilli: number;
  availableMilli: number;
}

/** Раздаёт потребности по партиям. Остатки в candidates уменьшаются на месте. */
export function allocateNeeds(
  needs: readonly Need[],
  candidates: Candidate[],
): { allocations: Allocation[]; shortages: Shortage[] } {
  const byProduct = new Map<string, Candidate[]>();
  for (const c of [...candidates].sort(compareFefo)) {
    const list = byProduct.get(c.productId) ?? [];
    list.push(c);
    byProduct.set(c.productId, list);
  }

  const allocations: Allocation[] = [];
  const shortages: Shortage[] = [];

  for (const need of needs) {
    const pool = (byProduct.get(need.productId) ?? []).filter((c) => (need.batchId ? c.id === need.batchId : true));
    const available = pool.reduce((sum, c) => sum + c.remainingMilli, 0);
    let left = need.milli;
    for (const c of pool) {
      if (left <= 0) break;
      if (c.remainingMilli <= 0) continue;
      const take = Math.min(c.remainingMilli, left);
      c.remainingMilli -= take;
      left -= take;
      allocations.push({ need, candidate: c, milli: take });
    }
    if (left > 0) shortages.push({ need, shortMilli: left, availableMilli: available });
  }
  return { allocations, shortages };
}

export const toDecimal3 = (milli: number): string => (milli / 1000).toFixed(3);

/** Списывает выданные количества с партий: по одному UPDATE на партию. */
export async function applyDecrements(trx: Transaction<Database>, allocations: readonly Allocation[]): Promise<void> {
  const perBatch = new Map<string, number>();
  for (const a of allocations) perBatch.set(a.candidate.id, (perBatch.get(a.candidate.id) ?? 0) + a.milli);
  for (const [id, milli] of perBatch) {
    await trx
      .updateTable('batches')
      .set({ remaining_qty: sql`remaining_qty - ${toDecimal3(milli)}::numeric` })
      .where('id', '=', id)
      .execute();
  }
}
