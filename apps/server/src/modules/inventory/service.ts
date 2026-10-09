import {
  roundMoney,
  toMilli,
  type CreateInventoryBody,
  type InventoryDetailDto,
  type InventoryDto,
  type InventoryLinesBody,
  type InventoryStatus,
  type Page,
} from '@zapas/shared';
import { sql } from 'kysely';
import type { Actor, Deps, Principal } from '../../lib/context';
import { actorUserId } from '../../lib/context';
import { badRequest, conflict, notFound, PG_UNIQUE_VIOLATION, pgCode, unprocessable } from '../../lib/errors';
import { assertLocation, locationFilter } from '../../lib/scope';
import { businessToday } from '../../lib/time';
import { writeAudit } from '../audit/audit';
import { allocateNeeds, applyDecrements, lockCandidates, toDecimal3, type Need } from '../stock/allocation';
import { activeLocation, runDocument, type DocResult } from '../stock/operations';

interface HeadRow {
  id: string;
  location_id: string;
  location_name: string;
  status: InventoryStatus;
  comment: string | null;
  created_at: Date;
  committed_at: Date | null;
  author: string;
  document_id: string | null;
  lines_total: number;
  lines_counted: number;
}

function toDto(r: HeadRow): InventoryDto {
  return {
    id: r.id,
    locationId: r.location_id,
    locationName: r.location_name,
    status: r.status,
    comment: r.comment,
    createdAt: r.created_at.toISOString(),
    committedAt: r.committed_at?.toISOString() ?? null,
    authorName: r.author,
    documentId: r.document_id,
    linesTotal: Number(r.lines_total),
    linesCounted: Number(r.lines_counted),
  };
}

const HEAD = sql`
  SELECT i.id, i.location_id, l.name AS location_name, i.status, i.comment, i.created_at, i.committed_at,
         u.full_name AS author, i.document_id,
         (SELECT count(*) FROM inventory_lines x WHERE x.inventory_id = i.id) AS lines_total,
         (SELECT count(*) FROM inventory_lines x WHERE x.inventory_id = i.id AND x.counted_qty IS NOT NULL) AS lines_counted
  FROM inventories i
  JOIN locations l ON l.id = i.location_id
  JOIN users u ON u.id = i.created_by`;

export async function listInventories(
  deps: Deps,
  principal: Principal,
  f: { locationId?: string | undefined; status?: InventoryStatus | undefined; limit: number; offset: number },
): Promise<Page<InventoryDto>> {
  const allowed = locationFilter(principal, f.locationId);
  const conds = [];
  if (allowed) {
    conds.push(allowed.length ? sql`i.location_id IN (${sql.join(allowed.map((id) => sql`${id}::uuid`))})` : sql`FALSE`);
  }
  if (f.status) conds.push(sql`i.status = ${f.status}`);
  const where = conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``;

  const total = await sql<{ n: number }>`SELECT count(*) AS n FROM inventories i ${where}`.execute(deps.db);
  const rows = await sql<HeadRow>`${HEAD} ${where} ORDER BY i.created_at DESC LIMIT ${f.limit} OFFSET ${f.offset}`.execute(deps.db);
  return { total: Number(total.rows[0]?.n ?? 0), limit: f.limit, offset: f.offset, items: rows.rows.map(toDto) };
}

export async function getInventory(deps: Deps, principal: Principal, id: string): Promise<InventoryDetailDto> {
  const head = await sql<HeadRow>`${HEAD} WHERE i.id = ${id}::uuid`.execute(deps.db);
  const row = head.rows[0];
  if (!row) throw notFound('Инвентаризация');
  assertLocation(principal, row.location_id);

  const lines = await deps.db
    .selectFrom('inventory_lines as il')
    .innerJoin('products as p', 'p.id', 'il.product_id')
    .select(['il.product_id', 'il.expected_qty', 'il.counted_qty', 'il.surplus_expires_on', 'p.sku', 'p.name', 'p.unit', 'p.cost'])
    .where('il.inventory_id', '=', id)
    .orderBy('p.name')
    .execute();

  return {
    ...toDto(row),
    lines: lines.map((l) => {
      const expected = Number(l.expected_qty);
      const counted = l.counted_qty === null ? null : Number(l.counted_qty);
      return {
        productId: l.product_id,
        sku: l.sku,
        productName: l.name,
        unit: l.unit,
        expectedQty: expected,
        countedQty: counted,
        surplusExpiresOn: l.surplus_expires_on,
        difference: counted === null ? null : Math.round((counted - expected) * 1000) / 1000,
        unitCost: Number(l.cost),
      };
    }),
  };
}

export async function createInventory(deps: Deps, actor: Actor, body: CreateInventoryBody): Promise<string> {
  assertLocation(actor.principal, body.locationId);
  const now = deps.clock();
  const userId = actorUserId(actor.principal);
  if (!userId) throw badRequest('Только для пользователей');
  try {
    return await deps.db.transaction().execute(async (trx) => {
      await activeLocation(trx, body.locationId);
      const inv = await trx
        .insertInto('inventories')
        .values({
          location_id: body.locationId,
          comment: body.comment ?? null,
          created_by: userId,
          created_at: now,
          committed_at: null,
          document_id: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const stock = await trx
        .selectFrom('batches as b')
        .innerJoin('products as p', 'p.id', 'b.product_id')
        .select(['b.product_id', sql<string>`COALESCE(SUM(b.remaining_qty), 0)`.as('on_hand')])
        .where('b.location_id', '=', body.locationId)
        .groupBy(['b.product_id', 'p.is_active'])
        .having(sql<boolean>`p.is_active OR COALESCE(SUM(b.remaining_qty), 0) > 0`)
        .execute();
      if (stock.length === 0) throw unprocessable('На точке нет позиций для пересчёта', undefined, 'empty_location');
      await trx
        .insertInto('inventory_lines')
        .values(
          stock.map((s) => ({
            inventory_id: inv.id,
            product_id: s.product_id,
            expected_qty: s.on_hand,
            counted_qty: null,
            surplus_expires_on: null,
          })),
        )
        .execute();
      await writeAudit(trx, {
        action: 'inventory.create',
        entity: 'inventory',
        entityId: inv.id,
        principal: actor.principal,
        meta: actor.meta,
        at: now,
        details: { locationId: body.locationId, lines: stock.length },
      });
      return inv.id;
    });
  } catch (err) {
    if (pgCode(err) === PG_UNIQUE_VIOLATION) {
      throw conflict('На этой точке уже есть незавершённая инвентаризация', undefined, 'inventory_open');
    }
    throw err;
  }
}

export async function saveLines(deps: Deps, actor: Actor, id: string, body: InventoryLinesBody): Promise<void> {
  await deps.db.transaction().execute(async (trx) => {
    const inv = await trx.selectFrom('inventories').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!inv) throw notFound('Инвентаризация');
    assertLocation(actor.principal, inv.location_id);
    if (inv.status !== 'draft') throw conflict('Инвентаризация уже закрыта', undefined, 'inventory_closed');

    const known = new Set(
      (await trx.selectFrom('inventory_lines').select('product_id').where('inventory_id', '=', id).execute()).map((l) => l.product_id),
    );
    const units = new Map(
      (await trx.selectFrom('products').select(['id', 'unit']).where('id', 'in', body.lines.map((l) => l.productId)).execute()).map((p) => [p.id, p.unit]),
    );
    body.lines.forEach((l, i) => {
      if (l.countedQty !== null && units.get(l.productId) === 'pcs' && !Number.isInteger(l.countedQty)) {
        throw badRequest('Штучный товар считается целыми штуками', [{ path: ['lines', i, 'countedQty'], message: 'Нужно целое число' }], 'whole_pieces');
      }
    });
    body.lines.forEach((l, i) => {
      if (!known.has(l.productId)) {
        throw badRequest('Позиции нет в этой инвентаризации', [{ path: ['lines', i, 'productId'], message: 'Нет в списке' }]);
      }
    });
    for (const l of body.lines) {
      await trx
        .updateTable('inventory_lines')
        .set({ counted_qty: l.countedQty, surplus_expires_on: l.surplusExpiresOn ?? null })
        .where('inventory_id', '=', id)
        .where('product_id', '=', l.productId)
        .execute();
    }
  });
}

export async function cancelInventory(deps: Deps, actor: Actor, id: string): Promise<void> {
  const now = deps.clock();
  await deps.db.transaction().execute(async (trx) => {
    const inv = await trx.selectFrom('inventories').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!inv) throw notFound('Инвентаризация');
    assertLocation(actor.principal, inv.location_id);
    if (inv.status !== 'draft') throw conflict('Инвентаризация уже закрыта', undefined, 'inventory_closed');
    await trx.updateTable('inventories').set({ status: 'cancelled' }).where('id', '=', id).execute();
    await writeAudit(trx, {
      action: 'inventory.cancel',
      entity: 'inventory',
      entityId: id,
      principal: actor.principal,
      meta: actor.meta,
      at: now,
      details: {},
    });
  });
}

export async function commitInventory(deps: Deps, actor: Actor, id: string, idempotencyKey?: string): Promise<DocResult> {
  const head = await deps.db.selectFrom('inventories').select(['location_id', 'status']).where('id', '=', id).executeTakeFirst();
  if (!head) throw notFound('Инвентаризация');
  assertLocation(actor.principal, head.location_id);
  const today = businessToday(deps);

  return runDocument(
    deps,
    actor,
    {
      kind: 'inventory',
      locationId: head.location_id,
      comment: 'Инвентаризация',
      idempotencyKey,
      fingerprint: { inventoryId: id },
      auditAction: 'inventory.commit',
    },
    async (trx, doc) => {
      const now = deps.clock();
      const inv = await trx.selectFrom('inventories').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!inv) throw notFound('Инвентаризация');
      if (inv.status !== 'draft') throw conflict('Инвентаризация уже закрыта', undefined, 'inventory_closed');

      const lines = await trx
        .selectFrom('inventory_lines as il')
        .innerJoin('products as p', 'p.id', 'il.product_id')
        .select(['il.product_id', 'il.counted_qty', 'il.surplus_expires_on', 'p.name', 'p.cost'])
        .where('il.inventory_id', '=', id)
        .where('il.counted_qty', 'is not', null)
        .execute();
      if (lines.length === 0) throw unprocessable('Ни одна позиция не пересчитана', undefined, 'nothing_counted');

      const productIds = lines.map((l) => l.product_id).sort();
      const candidates = await lockCandidates(trx, { locationId: inv.location_id, today, productIds, includeExpired: true });
      const current = new Map<string, number>();
      for (const c of candidates) current.set(c.productId, (current.get(c.productId) ?? 0) + c.remainingMilli);

      const needs: Need[] = [];
      const surplus: { productId: string; milli: number; expiresOn: string; cost: number }[] = [];
      const missingDates: { path: (string | number)[]; message: string }[] = [];

      lines.forEach((l, i) => {
        const counted = toMilli(Number(l.counted_qty));
        const diff = counted - (current.get(l.product_id) ?? 0);
        if (diff < 0) needs.push({ productId: l.product_id, milli: -diff, line: i });
        if (diff > 0) {
          if (!l.surplus_expires_on) {
            missingDates.push({ path: ['lines', l.name], message: `Укажите срок годности излишка: ${l.name}` });
          } else if (l.surplus_expires_on < today) {
            missingDates.push({ path: ['lines', l.name], message: `Срок излишка уже истёк: ${l.name}` });
          } else {
            surplus.push({ productId: l.product_id, milli: diff, expiresOn: l.surplus_expires_on, cost: Number(l.cost) });
          }
        }
      });
      if (missingDates.length > 0) throw unprocessable('Заполните сроки годности излишков', missingDates, 'surplus_date_required');

      const { allocations } = allocateNeeds(needs, candidates);
      await applyDecrements(trx, allocations);

      const userId = actorUserId(actor.principal);
      const out = allocations.map((a) => ({
        document_id: doc.id,
        batch_id: a.candidate.id,
        product_id: a.need.productId,
        location_id: inv.location_id,
        type: 'adjustment_out' as const,
        quantity: `-${toDecimal3(a.milli)}`,
        unit_cost: a.candidate.unitCost,
        unit_price: null,
        reason: 'shortage' as const,
        dish_id: null,
        comment: 'Недостача по инвентаризации',
        created_by: userId,
        created_at: now,
      }));

      const newBatches = surplus.map((s) => ({ ...s, batchId: crypto.randomUUID() }));
      if (newBatches.length > 0) {
        await trx
          .insertInto('batches')
          .values(
            newBatches.map((b) => ({
              id: b.batchId,
              product_id: b.productId,
              location_id: inv.location_id,
              supplier_id: null,
              origin_document_id: doc.id,
              document_no: null,
              received_on: today,
              expires_on: b.expiresOn,
              initial_qty: toDecimal3(b.milli),
              remaining_qty: toDecimal3(b.milli),
              unit_cost: b.cost,
              created_by: userId,
              created_at: now,
            })),
          )
          .execute();
      }
      const inn = newBatches.map((b) => ({
        document_id: doc.id,
        batch_id: b.batchId,
        product_id: b.productId,
        location_id: inv.location_id,
        type: 'adjustment_in' as const,
        quantity: toDecimal3(b.milli),
        unit_cost: b.cost,
        unit_price: null,
        reason: null,
        dish_id: null,
        comment: 'Излишек по инвентаризации',
        created_by: userId,
        created_at: now,
      }));
      const movements = [...out, ...inn];
      if (movements.length > 0) await trx.insertInto('stock_movements').values(movements).execute();

      await trx
        .updateTable('inventories')
        .set({ status: 'committed', committed_at: now, document_id: doc.id })
        .where('id', '=', id)
        .execute();

      const shortageValue = roundMoney(allocations.reduce((s, a) => s + (a.milli / 1000) * a.candidate.unitCost, 0));
      const surplusValue = roundMoney(surplus.reduce((s, x) => s + (x.milli / 1000) * x.cost, 0));
      return {
        details: {
          inventoryId: id,
          counted: lines.length,
          shortageLines: new Set(allocations.map((a) => a.need.productId)).size,
          surplusLines: surplus.length,
          shortageValue,
          surplusValue,
        },
        locations: [inv.location_id],
      };
    },
  );
}
