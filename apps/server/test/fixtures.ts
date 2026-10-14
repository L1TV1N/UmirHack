import { addDays, todayIn } from '@zapas/shared';
import { call, createUser, loginAs, type Session, type TestEnv } from './helpers';

export interface Loc {
  id: string;
  name: string;
}

export interface World {
  locA: Loc;
  locB: Loc;
  kitchen: Loc;
  categoryId: string;
  admin: Session;
  manager: Session;
  keeperA: Session;
  viewerA: Session;
  waiterA: Session;
  today: string;
  day(offset: number): string;
}

let locSeq = 0;

export async function addLocation(env: TestEnv, name: string, kind: 'warehouse' | 'kitchen' | 'shop' = 'shop'): Promise<Loc> {
  locSeq += 1;
  const row = await env.db
    .insertInto('locations')
    .values({ code: `L${locSeq}`, name, kind, address: null, created_at: env.clock.now })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id, name };
}

let skuSeq = 0;

export async function addProduct(
  env: TestEnv,
  categoryId: string,
  over: Partial<{
    name: string;
    unit: 'kg' | 'l' | 'pcs';
    price: number;
    cost: number;
    minStock: number;
    sellable: boolean;
    isActive: boolean;
    shelfLifeDays: number;
  }> = {},
): Promise<string> {
  skuSeq += 1;
  const row = await env.db
    .insertInto('products')
    .values({
      sku: `T-${skuSeq}`,
      barcode: null,
      name: over.name ?? `Продукт ${skuSeq}`,
      category_id: categoryId,
      unit: over.unit ?? 'kg',
      min_stock: over.minStock ?? 0,
      shelf_life_days: over.shelfLifeDays ?? null,
      price: over.price ?? 100,
      cost: over.cost ?? 60,
      sellable: over.sellable ?? true,
      is_active: over.isActive ?? true,
      created_at: env.clock.now,
      updated_at: env.clock.now,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function addDish(
  env: TestEnv,
  name: string,
  price: number,
  items: { productId: string; quantity: number }[],
): Promise<string> {
  const dish = await env.db
    .insertInto('dishes')
    .values({ name, price, created_at: env.clock.now, updated_at: env.clock.now })
    .returning('id')
    .executeTakeFirstOrThrow();
  await env.db
    .insertInto('dish_items')
    .values(items.map((i) => ({ dish_id: dish.id, product_id: i.productId, quantity: i.quantity })))
    .execute();
  return dish.id;
}

export async function createWorld(env: TestEnv): Promise<World> {
  const locA = await addLocation(env, 'Магазин Центр');
  const locB = await addLocation(env, 'Магазин Северный');
  const kitchen = await addLocation(env, 'Кухня', 'kitchen');
  const cat = await env.db.insertInto('categories').values({ name: 'Молочные продукты' }).returning('id').executeTakeFirstOrThrow();

  const [admin, manager, keeper, viewer, waiter] = await Promise.all([
    createUser(env, { role: 'admin' }).then((u) => loginAs(env, u)),
    createUser(env, { role: 'manager' }).then((u) => loginAs(env, u)),
    createUser(env, { role: 'storekeeper', locationIds: [locA.id] }).then((u) => loginAs(env, u)),
    createUser(env, { role: 'viewer', locationIds: [locA.id] }).then((u) => loginAs(env, u)),
    createUser(env, { role: 'waiter', locationIds: [kitchen.id] }).then((u) => loginAs(env, u)),
  ]);
  const today = todayIn(env.config.businessTz, env.clock.now);
  return { locA, locB, kitchen, categoryId: cat.id, admin, manager, keeperA: keeper, viewerA: viewer, waiterA: waiter, today, day: (n) => addDays(today, n) };
}

export interface ReceiptLine {
  productId: string;
  quantity: number;
  expiresOn: string;
  unitCost?: number;
}

export async function receive(env: TestEnv, token: string, locationId: string, lines: ReceiptLine[], extra: object = {}) {
  const res = await call(env, token)('POST', '/api/documents/receipts', {
    locationId,
    lines: lines.map((l) => ({ unitCost: 60, ...l })),
    ...extra,
  });
  if (res.statusCode >= 300) throw new Error(`Приход не прошёл: ${res.statusCode} ${res.body}`);
  return res.json() as { documentId: string; number: string; duplicate: boolean };
}

export async function remaining(env: TestEnv, productId: string, locationId: string): Promise<number> {
  const rows = await env.db
    .selectFrom('batches')
    .select('remaining_qty')
    .where('product_id', '=', productId)
    .where('location_id', '=', locationId)
    .execute();
  return rows.reduce((s, r) => s + Number(r.remaining_qty), 0);
}

/** Проверка главного инварианта: остаток партии равен приходу плюс сумма движений по ней. */
export async function assertLedgerConsistent(env: TestEnv): Promise<void> {
  const rows = await env.owner
    .selectFrom('batches as b')
    .leftJoin('stock_movements as m', 'm.batch_id', 'b.id')
    .select(['b.id', 'b.remaining_qty'])
    .select((eb) => eb.fn.coalesce(eb.fn.sum<string>('m.quantity'), eb.val('0')).as('moved'))
    .groupBy(['b.id', 'b.remaining_qty'])
    .execute();
  for (const r of rows) {
    if (Math.abs(Number(r.remaining_qty) - Number(r.moved)) > 1e-9) {
      throw new Error(`Остаток партии ${r.id} (${r.remaining_qty}) не сходится с журналом (${r.moved})`);
    }
  }
}

let histSeq = 0;

/**
 * Готовая история: партия приходит давно и полностью продаётся по дням.
 * Нужна, чтобы прогноз скорости работал на данных, а не на пустоте.
 */
export async function seedSales(
  env: TestEnv,
  o: { productId: string; locationId: string; days: number; perDay: number | ((age: number) => number); price?: number; cost?: number },
): Promise<void> {
  const today = todayIn(env.config.businessTz, env.clock.now);
  const start = addDays(today, -o.days);
  const qtyFor = (age: number) => (typeof o.perDay === 'number' ? o.perDay : o.perDay(age));
  const sales = Array.from({ length: o.days }, (_, i) => ({ date: addDays(start, i), qty: qtyFor(o.days - 1 - i) }));
  const total = sales.reduce((s, x) => s + x.qty, 0);
  const cost = o.cost ?? 60;
  const price = o.price ?? 100;

  histSeq += 1;
  const receiptDoc = await env.owner
    .insertInto('documents')
    .values({
      kind: 'receipt',
      number: `H-R-${histSeq}`,
      location_id: o.locationId,
      to_location_id: null,
      created_by: null,
      actor_name: 'История',
      comment: null,
      idempotency_scope: null,
      idempotency_key: null,
      created_at: new Date(`${start}T06:00:00Z`),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const batch = await env.owner
    .insertInto('batches')
    .values({
      product_id: o.productId,
      location_id: o.locationId,
      supplier_id: null,
      origin_document_id: receiptDoc.id,
      document_no: null,
      received_on: start,
      expires_on: addDays(today, 400),
      initial_qty: total,
      remaining_qty: 0,
      unit_cost: cost,
      created_by: null,
      created_at: new Date(`${start}T06:00:00Z`),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await env.owner
    .insertInto('stock_movements')
    .values({
      document_id: receiptDoc.id,
      batch_id: batch.id,
      product_id: o.productId,
      location_id: o.locationId,
      type: 'receipt',
      quantity: total,
      unit_cost: cost,
      unit_price: null,
      reason: null,
      dish_id: null,
      comment: null,
      created_by: null,
      created_at: new Date(`${start}T06:00:00Z`),
    })
    .execute();

  for (const s of sales) {
    if (s.qty <= 0) continue;
    histSeq += 1;
    const doc = await env.owner
      .insertInto('documents')
      .values({
        kind: 'sale',
        number: `H-S-${histSeq}`,
        location_id: o.locationId,
        to_location_id: null,
        created_by: null,
        actor_name: 'История',
        comment: null,
        idempotency_scope: null,
        idempotency_key: null,
        created_at: new Date(`${s.date}T09:00:00Z`),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await env.owner
      .insertInto('stock_movements')
      .values({
        document_id: doc.id,
        batch_id: batch.id,
        product_id: o.productId,
        location_id: o.locationId,
        type: 'sale',
        quantity: -s.qty,
        unit_cost: cost,
        unit_price: price,
        reason: null,
        dish_id: null,
        comment: null,
        created_by: null,
        created_at: new Date(`${s.date}T09:00:00Z`),
      })
      .execute();
  }
}
