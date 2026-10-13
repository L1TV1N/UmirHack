import type { PromotionChangedPayload } from '@zapas/shared';
import type { Transaction } from 'kysely';
import type { Database } from '../../db/types';
import type { Deps, Principal, RequestMeta } from '../../lib/context';
import { notFound, unprocessable } from '../../lib/errors';
import { assertLocation } from '../../lib/scope';
import { businessToday } from '../../lib/time';
import { writeAudit } from '../audit/audit';
import { enqueueEvent } from '../integrations/service';
import { nextMarkdowns } from './markdown';

/** Сообщает подписанным адресам, какая скидка теперь действует на товар. Вызывается внутри транзакции изменения. */
export async function announcePromotion(deps: Deps, trx: Transaction<Database>, batchId: string, now: Date): Promise<void> {
  const row = await trx
    .selectFrom('batches as b')
    .innerJoin('products as p', 'p.id', 'b.product_id')
    .innerJoin('locations as l', 'l.id', 'b.location_id')
    .select(['b.product_id', 'b.location_id', 'l.name as location_name', 'p.sku', 'p.barcode', 'p.name', 'p.unit', 'p.price'])
    .where('b.id', '=', batchId)
    .executeTakeFirst();
  if (!row) return;
  const markdown = (await nextMarkdowns(trx, row.location_id, businessToday(deps), [row.product_id])).get(row.product_id) ?? null;
  const payload: PromotionChangedPayload = {
    event: 'promotion.changed',
    locationId: row.location_id,
    locationName: row.location_name,
    createdAt: now.toISOString(),
    product: { sku: row.sku, barcode: row.barcode, name: row.name, unit: row.unit, price: Number(row.price) },
    markdown,
  };
  await enqueueEvent(trx, 'promotion.changed', payload, row.location_id, now);
}

/** Включает скидку на партию до конца её срока. Прежняя скидка на эту партию отменяется. Возвращает идентификатор новой. */
export async function createPromotion(
  deps: Deps,
  principal: Extract<Principal, { kind: 'user' }>,
  meta: RequestMeta,
  input: { batchId: string; percent: number },
): Promise<string> {
  const today = businessToday(deps);
  const now = deps.clock();
  return deps.db.transaction().execute(async (trx) => {
    const batch = await trx
      .selectFrom('batches as b')
      .innerJoin('products as p', 'p.id', 'b.product_id')
      .select(['b.id', 'b.location_id', 'b.expires_on', 'b.remaining_qty', 'p.sellable', 'p.name'])
      .where('b.id', '=', input.batchId)
      .forUpdate('b')
      .executeTakeFirst();
    if (!batch) throw notFound('Партия');
    assertLocation(principal, batch.location_id);
    if (Number(batch.remaining_qty) <= 0) throw unprocessable('Партия уже распродана', undefined, 'batch_empty');
    if (batch.expires_on < today) throw unprocessable('Срок партии истёк, скидка не нужна, её нужно списать', undefined, 'batch_expired');
    if (!batch.sellable) throw unprocessable('Продукт не продаётся отдельно', undefined, 'not_sellable');

    await trx.updateTable('promotions').set({ cancelled_at: now }).where('batch_id', '=', batch.id).where('cancelled_at', 'is', null).execute();
    const created = await trx
      .insertInto('promotions')
      .values({ batch_id: batch.id, percent: input.percent, ends_on: batch.expires_on, created_by: principal.id, created_at: now, cancelled_at: null })
      .returning('id')
      .executeTakeFirstOrThrow();
    await writeAudit(trx, {
      action: 'promotion.create',
      entity: 'promotion',
      entityId: created.id,
      principal,
      meta,
      at: now,
      details: { batchId: batch.id, product: batch.name, percent: input.percent },
    });
    await announcePromotion(deps, trx, batch.id, now);
    return created.id;
  });
}
