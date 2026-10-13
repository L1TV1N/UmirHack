import {
  addDays,
  roundMoney,
  toMilli,
  type ReceiptBody,
  type SaleBody,
  type TransferBody,
  type WriteoffBody,
  type WriteoffExpiredBody,
} from '@zapas/shared';
import { sql, type Transaction } from 'kysely';
import type { Database } from '../../db/types';
import { actorName, actorUserId, type Actor, type Deps } from '../../lib/context';
import {
  AppError,
  badRequest,
  PG_UNIQUE_VIOLATION,
  pgCode,
  pgConstraint,
  unprocessable,
} from '../../lib/errors';
import { canonicalJson, sha256Hex } from '../../lib/crypto';
import { retryOnConflict } from '../../lib/retry';
import { assertLocation } from '../../lib/scope';
import { businessToday } from '../../lib/time';
import { writeAudit } from '../audit/audit';
import { invalidateSnapshots } from '../analytics/snapshot';
import { scheduleStopListSync } from '../stoplist/service';
import { enqueueExchange } from '../exchange/service';
import { applyReceiptToOrder, lockOrderForReceipt } from '../orders/service';
import { recordReceiptTraceability } from '../traceability/service';
import {
  allocateNeeds,
  applyDecrements,
  lockCandidates,
  toDecimal3,
  type Allocation,
  type Need,
} from './allocation';

export interface DocResult {
  documentId: string;
  number: string;
  duplicate: boolean;
}

type DocKind = 'receipt' | 'sale' | 'writeoff' | 'transfer' | 'inventory';

const PREFIX: Record<DocKind, string> = {
  receipt: 'ПР',
  sale: 'ПД',
  writeoff: 'СП',
  transfer: 'ПМ',
  inventory: 'ИН',
};

const MAX_SHELF_DAYS = 3650;

interface DocOptions {
  kind: DocKind;
  locationId: string;
  toLocationId?: string;
  comment?: string | undefined;
  idempotencyKey?: string | undefined;
  /** Тело запроса: по нему отличаем настоящий повтор от попытки подменить данные под старым ключом. */
  fingerprint?: unknown;
  auditAction: string;
}

interface WorkResult {
  details: Record<string, unknown>;
  /** Точки, на которых изменились остатки. */
  locations: string[];
}

type Work = (trx: Transaction<Database>, doc: { id: string; number: string }) => Promise<WorkResult>;

function idempotencyScope(actor: Actor): string {
  const p = actor.principal;
  return p.kind === 'user' ? `u:${p.id}` : p.kind === 'apikey' ? `k:${p.id}` : 'system';
}

async function findByKey(deps: Deps, scope: string, key: string, hash: string): Promise<DocResult | null> {
  const row = await deps.db
    .selectFrom('documents')
    .select(['id', 'number', 'idempotency_hash'])
    .where('idempotency_scope', '=', scope)
    .where('idempotency_key', '=', key)
    .executeTakeFirst();
  if (!row) return null;
  if (row.idempotency_hash && row.idempotency_hash !== hash) {
    throw unprocessable('Этот ключ уже использован для другой операции', undefined, 'idempotency_conflict');
  }
  return { documentId: row.id, number: row.number, duplicate: true };
}

export async function activeLocation(trx: Transaction<Database>, id: string): Promise<void> {
  const loc = await trx.selectFrom('locations').select(['id', 'is_active']).where('id', '=', id).executeTakeFirst();
  if (!loc) throw badRequest('Точка не найдена', [{ path: ['locationId'], message: 'Не найдена' }]);
  if (!loc.is_active) throw unprocessable('Точка отключена, операции запрещены', undefined, 'location_inactive');
}

/** Общая обвязка документа: идемпотентность, транзакция, номер, аудит, пересчёт стоп-листа. */
async function runDocument(deps: Deps, actor: Actor, opts: DocOptions, work: Work): Promise<DocResult> {
  assertLocation(actor.principal, opts.locationId);
  if (opts.toLocationId) assertLocation(actor.principal, opts.toLocationId);

  const scope = idempotencyScope(actor);
  const key = opts.idempotencyKey;
  const hash = sha256Hex(canonicalJson(opts.fingerprint ?? null));
  if (key) {
    const existing = await findByKey(deps, scope, key, hash);
    if (existing) return existing;
  }

  try {
    const now = deps.clock();
    const { doc, locations } = await retryOnConflict(() => deps.db.transaction().execute(async (trx) => {
      await activeLocation(trx, opts.locationId);
      if (opts.toLocationId) await activeLocation(trx, opts.toLocationId);

      const created = await trx
        .insertInto('documents')
        .values({
          kind: opts.kind,
          number: sql<string>`${PREFIX[opts.kind]} || '-' || lpad(nextval('document_number_seq')::text, 6, '0')`,
          location_id: opts.locationId,
          to_location_id: opts.toLocationId ?? null,
          created_by: actorUserId(actor.principal),
          actor_name: actorName(actor.principal),
          comment: opts.comment ?? null,
          idempotency_scope: key ? scope : null,
          idempotency_key: key ?? null,
          idempotency_hash: key ? hash : null,
          created_at: now,
        })
        .returning(['id', 'number'])
        .executeTakeFirstOrThrow();

      const result = await work(trx, created);
      await enqueueExchange(trx, { id: created.id, kind: opts.kind, locationId: opts.locationId, toLocationId: opts.toLocationId }, now);
      await writeAudit(trx, {
        action: opts.auditAction,
        entity: 'document',
        entityId: created.id,
        principal: actor.principal,
        meta: actor.meta,
        at: now,
        details: { number: created.number, locationId: opts.locationId, ...result.details },
      });
      return { doc: created, locations: result.locations };
    }));

    // касса шлёт продажи потоком: сбрасывать кеш на каждую значило бы отключить его, там хватает фонового пересчёта
    if (actor.principal.kind !== 'apikey') invalidateSnapshots(deps.db);
    scheduleStopListSync(deps, locations);
    return { documentId: doc.id, number: doc.number, duplicate: false };
  } catch (err) {
    if (key && pgCode(err) === PG_UNIQUE_VIOLATION && pgConstraint(err) === 'documents_idempotency_key') {
      const existing = await findByKey(deps, scope, key, hash);
      if (existing) return existing;
    }
    throw err;
  }
}

interface ProductInfo {
  id: string;
  name: string;
  unit: 'kg' | 'l' | 'pcs';
  price: number;
  cost: number;
  sellable: boolean;
  isActive: boolean;
  shelfLifeDays: number | null;
}

async function loadProducts(trx: Transaction<Database>, ids: string[]): Promise<Map<string, ProductInfo>> {
  if (ids.length === 0) return new Map();
  const rows = await trx
    .selectFrom('products')
    .select(['id', 'name', 'unit', 'price', 'cost', 'sellable', 'is_active', 'shelf_life_days'])
    .where('id', 'in', ids)
    .execute();
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        name: r.name,
        unit: r.unit,
        price: Number(r.price),
        cost: Number(r.cost),
        sellable: r.sellable,
        isActive: r.is_active,
        shelfLifeDays: r.shelf_life_days,
      },
    ]),
  );
}

/** Штучный товар нельзя оформить дробным количеством: половины булочки на складе не бывает. */
export function assertWholePieces(
  products: Map<string, ProductInfo>,
  lines: { productId?: string | undefined; quantity: number }[],
  field: 'lines' = 'lines',
): void {
  lines.forEach((l, i) => {
    const p = l.productId ? products.get(l.productId) : undefined;
    if (p?.unit === 'pcs' && !Number.isInteger(l.quantity)) {
      throw badRequest(`«${p.name}» считается в штуках, укажите целое количество`, [{ path: [field, i, 'quantity'], message: 'Нужно целое число' }], 'whole_pieces');
    }
  });
}

function shortageError(
  shortages: ReturnType<typeof allocateNeeds>['shortages'],
  products: Map<string, ProductInfo>,
): never {
  const merged = new Map<string, { requested: number; available: number }>();
  for (const s of shortages) {
    const m = merged.get(s.need.productId) ?? { requested: 0, available: s.availableMilli };
    m.requested += s.need.milli;
    merged.set(s.need.productId, m);
  }
  const details = [...merged].map(([productId, m]) => ({
    productId,
    name: products.get(productId)?.name ?? productId,
    unit: products.get(productId)?.unit,
    requested: m.requested / 1000,
    available: m.available / 1000,
  }));
  throw unprocessable('Недостаточно остатка', details, 'insufficient_stock');
}

// Приход

export function receive(deps: Deps, actor: Actor, body: ReceiptBody, idempotencyKey?: string): Promise<DocResult> {
  const today = businessToday(deps);
  return runDocument(
    deps,
    actor,
    {
      kind: 'receipt',
      locationId: body.locationId,
      comment: body.comment,
      idempotencyKey,
      fingerprint: body,
      auditAction: 'document.receipt',
    },
    async (trx, doc) => {
      const now = deps.clock();
      const products = await loadProducts(trx, [...new Set(body.lines.map((l) => l.productId))]);
      // срок годности: дата из запроса, иначе день приёмки плюс срок хранения (из строки или из карточки продукта)
      const lines = body.lines.map((l, i) => {
        const p = products.get(l.productId);
        if (!p || !p.isActive) {
          throw badRequest('Продукт не найден или отключён', [{ path: ['lines', i, 'productId'], message: 'Недоступен для прихода' }]);
        }
        const shelf = l.shelfLifeDays ?? p.shelfLifeDays;
        const expiresOn = l.expiresOn ?? (shelf ? addDays(today, shelf) : null);
        if (!expiresOn) {
          throw badRequest(`Для «${p.name}» не указан срок годности`, [{ path: ['lines', i, 'expiresOn'], message: 'Укажите дату или срок хранения в днях' }], 'shelf_life_required');
        }
        if (expiresOn < today && !body.allowExpired) {
          throw unprocessable('Срок годности уже истёк', [{ path: ['lines', i, 'expiresOn'], message: 'Срок в прошлом' }], 'already_expired');
        }
        if (expiresOn > addDays(today, MAX_SHELF_DAYS)) {
          throw badRequest('Срок годности слишком далёкий', [{ path: ['lines', i, 'expiresOn'], message: 'Слишком далёкая дата' }]);
        }
        return { ...l, expiresOn };
      });
      assertWholePieces(products, lines);
      // приход по заказу: поставщик берётся из заказа, а принятое засчитывается в заказ
      const order = body.orderId ? await lockOrderForReceipt(trx, body.orderId, body.locationId, body.supplierId) : null;
      if (order) await trx.updateTable('documents').set({ order_id: order.id }).where('id', '=', doc.id).execute();
      const supplierId = body.supplierId ?? order?.supplierId ?? null;
      if (supplierId) {
        const s = await trx.selectFrom('suppliers').select('id').where('id', '=', supplierId).where('is_active', '=', true).executeTakeFirst();
        if (!s) throw badRequest('Поставщик не найден', [{ path: ['supplierId'], message: 'Не найден' }]);
      }

      const userId = actorUserId(actor.principal);
      const batchRows = lines.map((l) => ({
        id: crypto.randomUUID(),
        product_id: l.productId,
        location_id: body.locationId,
        supplier_id: supplierId,
        origin_document_id: doc.id,
        document_no: body.documentNo ?? null,
        received_on: today,
        expires_on: l.expiresOn,
        initial_qty: l.quantity,
        remaining_qty: l.quantity,
        unit_cost: l.unitCost,
        created_by: userId,
        created_at: now,
      }));
      await trx.insertInto('batches').values(batchRows).execute();
      await trx
        .insertInto('stock_movements')
        .values(
          batchRows.map((b) => ({
            document_id: doc.id,
            batch_id: b.id,
            product_id: b.product_id,
            location_id: body.locationId,
            type: 'receipt' as const,
            quantity: b.initial_qty,
            unit_cost: b.unit_cost,
            unit_price: null,
            reason: null,
            dish_id: null,
            comment: null,
            created_by: userId,
            created_at: now,
          })),
        )
        .execute();

      const trace = await recordReceiptTraceability(trx, {
        lines: lines,
        batches: batchRows,
        products,
        supplierId,
        locationId: body.locationId,
        now,
      });
      const ordered = order ? await applyReceiptToOrder(trx, order, lines, now) : null;

      const total = roundMoney(lines.reduce((s, l) => s + l.quantity * l.unitCost, 0));
      return {
        details: { lines: lines.length, supplierId, totalCost: total, ...(order ? { order: order.number, ...(ordered && ordered.extra > 0 ? { outsideOrder: ordered.extra } : {}) } : {}), ...(trace.marks > 0 ? { marks: trace.marks } : {}), ...(trace.vsd > 0 ? { vsd: trace.vsd } : {}) },
        locations: [body.locationId],
      };
    },
  );
}

// Продажа

interface SaleGroup {
  productId?: string;
  dish?: { id: string; name: string; price: number };
  quantity: number;
}

type SaleInput = { locationId: string; comment?: string | undefined; lines: SaleBody['lines'] };

/**
 * Продажа или заказ блюд. Отказ из-за нехватки запоминается: по таким отказам считается статистика
 * дефицитных ингредиентов и упущенная выручка. Сам документ при отказе не создаётся.
 */
export async function sell(deps: Deps, actor: Actor, input: SaleInput, idempotencyKey?: string): Promise<DocResult> {
  try {
    return await sellDocument(deps, actor, input, idempotencyKey);
  } catch (err) {
    if (err instanceof AppError && err.code === 'insufficient_stock') {
      await recordRefusal(deps, actor, input, err).catch((e) => deps.log.error({ err: e }, 'не удалось записать отказ в заказе'));
    }
    throw err;
  }
}

async function recordRefusal(deps: Deps, actor: Actor, input: SaleInput, err: AppError): Promise<void> {
  const missing = [...new Set((Array.isArray(err.details) ? (err.details as { productId?: unknown }[]) : []).flatMap((d) => (typeof d.productId === 'string' ? [d.productId] : [])))];
  if (missing.length === 0) return;
  const dishIds = [...new Set(input.lines.flatMap((l) => ('dishId' in l ? [l.dishId] : [])))];
  const productIds = [...new Set(input.lines.flatMap((l) => ('productId' in l ? [l.productId] : [])))];
  const dishes = dishIds.length ? await deps.db.selectFrom('dishes').select(['id', 'price']).where('id', 'in', dishIds).execute() : [];
  const products = productIds.length ? await deps.db.selectFrom('products').select(['id', 'price']).where('id', 'in', productIds).execute() : [];
  const price = new Map<string, number>([...dishes, ...products].map((r) => [r.id, Number(r.price)]));
  const total = input.lines.reduce((sum, l) => sum + l.quantity * (price.get('dishId' in l ? l.dishId : l.productId) ?? 0), 0);
  await deps.db
    .insertInto('sale_refusals')
    .values({ location_id: input.locationId, created_at: deps.clock(), order_total: roundMoney(total), missing, source: actor.principal.kind === 'apikey' ? 'pos' : 'user' })
    .execute();
}

function sellDocument(deps: Deps, actor: Actor, input: SaleInput, idempotencyKey?: string): Promise<DocResult> {
  const today = businessToday(deps);
  return runDocument(
    deps,
    actor,
    {
      kind: 'sale',
      locationId: input.locationId,
      comment: input.comment,
      idempotencyKey,
      fingerprint: input,
      auditAction: 'document.sale',
    },
    async (trx, doc) => {
      const now = deps.clock();
      const dishIds = [...new Set(input.lines.flatMap((l) => ('dishId' in l ? [l.dishId] : [])))];
      const dishRows = dishIds.length
        ? await trx.selectFrom('dishes').select(['id', 'name', 'price', 'is_active']).where('id', 'in', dishIds).execute()
        : [];
      const dishItems = dishIds.length
        ? await trx.selectFrom('dish_items').select(['dish_id', 'product_id', 'quantity']).where('dish_id', 'in', dishIds).execute()
        : [];

      const groups: SaleGroup[] = [];
      const needs: Need[] = [];
      input.lines.forEach((l, i) => {
        if ('dishId' in l) {
          const dish = dishRows.find((d) => d.id === l.dishId);
          if (!dish || !dish.is_active) {
            throw badRequest('Блюдо не найдено или отключено', [{ path: ['lines', i, 'dishId'], message: 'Недоступно для продажи' }]);
          }
          groups.push({ dish: { id: dish.id, name: dish.name, price: Number(dish.price) }, quantity: l.quantity });
          for (const item of dishItems.filter((x) => x.dish_id === dish.id)) {
            needs.push({ productId: item.product_id, milli: Math.round(Number(item.quantity) * l.quantity * 1000), line: groups.length - 1 });
          }
        } else {
          groups.push({ productId: l.productId, quantity: l.quantity });
          needs.push({ productId: l.productId, milli: toMilli(l.quantity), line: groups.length - 1 });
        }
      });

      const productIds = [...new Set(needs.map((n) => n.productId))].sort();
      const products = await loadProducts(trx, productIds);
      input.lines.forEach((l, i) => {
        if (!('productId' in l)) return;
        const p = products.get(l.productId);
        if (!p || !p.isActive) throw badRequest('Продукт не найден или отключён', [{ path: ['lines', i, 'productId'], message: 'Недоступен' }]);
        if (!p.sellable) throw unprocessable(`«${p.name}» не продаётся отдельно`, [{ path: ['lines', i, 'productId'], message: 'Не для продажи' }], 'not_sellable');
      });
      assertWholePieces(products, input.lines.map((l) => ({ productId: 'productId' in l ? l.productId : undefined, quantity: l.quantity })));
      input.lines.forEach((l, i) => {
        if ('dishId' in l && !Number.isInteger(l.quantity)) {
          throw badRequest('Блюда продаются целыми порциями', [{ path: ['lines', i, 'quantity'], message: 'Нужно целое число' }], 'whole_pieces');
        }
      });

      const candidates = await lockCandidates(trx, { locationId: input.locationId, today, productIds, includeExpired: false });
      const { allocations, shortages } = allocateNeeds(needs, candidates);
      if (shortages.length > 0) shortageError(shortages, products);

      await applyDecrements(trx, allocations);

      const batchIds = [...new Set(allocations.map((a) => a.candidate.id))];
      const promos = batchIds.length
        ? await trx
            .selectFrom('promotions')
            .select(['batch_id', 'percent'])
            .where('batch_id', 'in', batchIds)
            .where('cancelled_at', 'is', null)
            .where('ends_on', '>=', today)
            .execute()
        : [];
      const promoByBatch = new Map(promos.map((p) => [p.batch_id, p.percent]));

      // выручка блюда делится между ингредиентами пропорционально себестоимости
      const dishRevenueShare = new Map<number, number>();
      groups.forEach((g, idx) => {
        if (!g.dish) return;
        const own = allocations.filter((a) => a.need.line === idx);
        const weights = own.map((a) => (a.milli / 1000) * a.candidate.unitCost);
        const total = weights.reduce((s, w) => s + w, 0);
        const revenue = g.dish.price * g.quantity;
        own.forEach((a, k) => {
          const share = total > 0 ? (weights[k] ?? 0) / total : a.milli / own.reduce((s, x) => s + x.milli, 0);
          dishRevenueShare.set(allocations.indexOf(a), revenue * share);
        });
      });

      const userId = actorUserId(actor.principal);
      const movements = allocations.map((a, idx) => {
        const group = groups[a.need.line];
        let unitPrice: number;
        if (group?.dish) {
          unitPrice = roundMoney((dishRevenueShare.get(idx) ?? 0) / (a.milli / 1000));
        } else {
          const base = products.get(a.need.productId)?.price ?? 0;
          const pct = promoByBatch.get(a.candidate.id) ?? 0;
          unitPrice = roundMoney(base * (1 - pct / 100));
        }
        return {
          document_id: doc.id,
          batch_id: a.candidate.id,
          product_id: a.need.productId,
          location_id: input.locationId,
          type: 'sale' as const,
          quantity: `-${toDecimal3(a.milli)}`,
          unit_cost: a.candidate.unitCost,
          unit_price: unitPrice,
          reason: null,
          dish_id: group?.dish?.id ?? null,
          comment: null,
          created_by: userId,
          created_at: now,
        };
      });
      await trx.insertInto('stock_movements').values(movements).execute();

      const revenue = roundMoney(movements.reduce((s, m) => s + Number(m.quantity.slice(1)) * m.unit_price, 0));
      return { details: { lines: input.lines.length, revenue }, locations: [input.locationId] };
    },
  );
}

// Списание

function writeoffMovements(
  doc: { id: string },
  allocations: readonly Allocation[],
  locationId: string,
  reason: NonNullable<WriteoffBody['reason']>,
  userId: string | null,
  now: Date,
) {
  return allocations.map((a) => ({
    document_id: doc.id,
    batch_id: a.candidate.id,
    product_id: a.need.productId,
    location_id: locationId,
    type: 'writeoff' as const,
    quantity: `-${toDecimal3(a.milli)}`,
    unit_cost: a.candidate.unitCost,
    unit_price: null,
    reason,
    dish_id: null,
    comment: null,
    created_by: userId,
    created_at: now,
  }));
}

export function writeOff(deps: Deps, actor: Actor, body: WriteoffBody, idempotencyKey?: string): Promise<DocResult> {
  const today = businessToday(deps);
  return runDocument(
    deps,
    actor,
    {
      kind: 'writeoff',
      locationId: body.locationId,
      comment: body.comment,
      idempotencyKey,
      fingerprint: body,
      auditAction: 'document.writeoff',
    },
    async (trx, doc) => {
      const now = deps.clock();
      const productIds = [...new Set(body.lines.map((l) => l.productId))].sort();
      const products = await loadProducts(trx, productIds);
      body.lines.forEach((l, i) => {
        if (!products.has(l.productId)) {
          throw badRequest('Продукт не найден', [{ path: ['lines', i, 'productId'], message: 'Не найден' }]);
        }
      });
      assertWholePieces(products, body.lines);
      const needs: Need[] = body.lines.map((l, i) => ({
        productId: l.productId,
        milli: toMilli(l.quantity),
        ...(l.batchId ? { batchId: l.batchId } : {}),
        line: i,
      }));
      const candidates = await lockCandidates(trx, { locationId: body.locationId, today, productIds, includeExpired: true });
      const { allocations, shortages } = allocateNeeds(needs, candidates);
      if (shortages.length > 0) shortageError(shortages, products);

      await applyDecrements(trx, allocations);
      await trx
        .insertInto('stock_movements')
        .values(writeoffMovements(doc, allocations, body.locationId, body.reason, actorUserId(actor.principal), now))
        .execute();

      const value = roundMoney(allocations.reduce((s, a) => s + (a.milli / 1000) * a.candidate.unitCost, 0));
      return { details: { reason: body.reason, lines: body.lines.length, value }, locations: [body.locationId] };
    },
  );
}

export function writeOffExpired(deps: Deps, actor: Actor, body: WriteoffExpiredBody, idempotencyKey?: string): Promise<DocResult> {
  const today = businessToday(deps);
  return runDocument(
    deps,
    actor,
    {
      kind: 'writeoff',
      locationId: body.locationId,
      comment: body.comment ?? 'Списание просроченного',
      idempotencyKey,
      fingerprint: body,
      auditAction: 'document.writeoff_expired',
    },
    async (trx, doc) => {
      const now = deps.clock();
      const candidates = await lockCandidates(trx, { locationId: body.locationId, today, includeExpired: true, expiredOnly: true });
      if (candidates.length === 0) throw unprocessable('Просроченных остатков нет', undefined, 'nothing_to_write_off');
      const needs: Need[] = candidates.map((c, i) => ({ productId: c.productId, milli: c.remainingMilli, batchId: c.id, line: i }));
      const { allocations } = allocateNeeds(needs, candidates.map((c) => ({ ...c })));

      await applyDecrements(trx, allocations);
      await trx
        .insertInto('stock_movements')
        .values(writeoffMovements(doc, allocations, body.locationId, 'expired', actorUserId(actor.principal), now))
        .execute();

      const value = roundMoney(allocations.reduce((s, a) => s + (a.milli / 1000) * a.candidate.unitCost, 0));
      return { details: { reason: 'expired', batches: allocations.length, value }, locations: [body.locationId] };
    },
  );
}

// Перемещение

export function transfer(deps: Deps, actor: Actor, body: TransferBody, idempotencyKey?: string): Promise<DocResult> {
  const today = businessToday(deps);
  return runDocument(
    deps,
    actor,
    {
      kind: 'transfer',
      locationId: body.fromLocationId,
      toLocationId: body.toLocationId,
      comment: body.comment,
      idempotencyKey,
      fingerprint: body,
      auditAction: 'document.transfer',
    },
    async (trx, doc) => {
      const now = deps.clock();
      const productIds = [...new Set(body.lines.map((l) => l.productId))].sort();
      const products = await loadProducts(trx, productIds);
      body.lines.forEach((l, i) => {
        const p = products.get(l.productId);
        if (!p || !p.isActive) throw badRequest('Продукт не найден или отключён', [{ path: ['lines', i, 'productId'], message: 'Недоступен' }]);
      });
      assertWholePieces(products, body.lines);
      const needs: Need[] = body.lines.map((l, i) => ({
        productId: l.productId,
        milli: toMilli(l.quantity),
        ...(l.batchId ? { batchId: l.batchId } : {}),
        line: i,
      }));
      const candidates = await lockCandidates(trx, { locationId: body.fromLocationId, today, productIds, includeExpired: false });
      const { allocations, shortages } = allocateNeeds(needs, candidates);
      if (shortages.length > 0) shortageError(shortages, products);

      await applyDecrements(trx, allocations);

      const userId = actorUserId(actor.principal);
      const incoming = allocations.map((a) => ({ allocation: a, batchId: crypto.randomUUID() }));
      await trx
        .insertInto('batches')
        .values(
          incoming.map(({ allocation: a, batchId }) => ({
            id: batchId,
            product_id: a.need.productId,
            location_id: body.toLocationId,
            supplier_id: a.candidate.supplierId,
            origin_document_id: doc.id,
            document_no: a.candidate.documentNo,
            received_on: today,
            expires_on: a.candidate.expiresOn,
            initial_qty: toDecimal3(a.milli),
            remaining_qty: toDecimal3(a.milli),
            unit_cost: a.candidate.unitCost,
            created_by: userId,
            created_at: now,
          })),
        )
        .execute();

      const out = allocations.map((a) => ({
        document_id: doc.id,
        batch_id: a.candidate.id,
        product_id: a.need.productId,
        location_id: body.fromLocationId,
        type: 'transfer_out' as const,
        quantity: `-${toDecimal3(a.milli)}`,
        unit_cost: a.candidate.unitCost,
        unit_price: null,
        reason: null,
        dish_id: null,
        comment: null,
        created_by: userId,
        created_at: now,
      }));
      const inn = incoming.map(({ allocation: a, batchId }) => ({
        document_id: doc.id,
        batch_id: batchId,
        product_id: a.need.productId,
        location_id: body.toLocationId,
        type: 'transfer_in' as const,
        quantity: toDecimal3(a.milli),
        unit_cost: a.candidate.unitCost,
        unit_price: null,
        reason: null,
        dish_id: null,
        comment: null,
        created_by: userId,
        created_at: now,
      }));
      await trx.insertInto('stock_movements').values([...out, ...inn]).execute();

      const value = roundMoney(allocations.reduce((s, a) => s + (a.milli / 1000) * a.candidate.unitCost, 0));
      return {
        details: { toLocationId: body.toLocationId, lines: body.lines.length, value },
        locations: [body.fromLocationId, body.toLocationId],
      };
    },
  );
}

export { runDocument };
