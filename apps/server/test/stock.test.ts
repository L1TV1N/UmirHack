import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDish, addProduct, assertLedgerConsistent, createWorld, receive, remaining, type World } from './fixtures';
import { call, createTestEnv, type TestEnv } from './helpers';

let env: TestEnv;
let w: World;

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(() => env.close());
beforeEach(async () => {
  await env.reset();
  w = await createWorld(env);
});

const sale = (token: string, locationId: string, lines: object[], key?: string) =>
  call(env, token)('POST', '/api/documents/sales', { locationId, lines }, key ? { 'idempotency-key': key } : {});

describe('приход', () => {
  it('создаёт партию и движение, номер документа читаемый', async () => {
    const milk = await addProduct(env, w.categoryId, { name: 'Молоко 3,2%', unit: 'l' });
    const doc = await receive(env, w.keeperA.token, w.locA.id, [{ productId: milk, quantity: 24.5, expiresOn: w.day(5), unitCost: 61.9 }], {
      documentNo: 'УПД-118',
    });
    expect(doc.number).toMatch(/^ПР-\d{6}$/);
    const batch = await env.db.selectFrom('batches').selectAll().executeTakeFirstOrThrow();
    expect(Number(batch.initial_qty)).toBe(24.5);
    expect(batch.expires_on).toBe(w.day(5));
    expect(batch.received_on).toBe(w.today);
    expect(batch.document_no).toBe('УПД-118');
    const moves = await env.db.selectFrom('stock_movements').selectAll().execute();
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ type: 'receipt', quantity: '24.500', unit_cost: '61.90' });
  });

  it('не принимает просроченный товар без явного разрешения', async () => {
    const p = await addProduct(env, w.categoryId);
    const body = { locationId: w.locA.id, lines: [{ productId: p, quantity: 1, unitCost: 10, expiresOn: w.day(-1) }] };
    const res = await call(env, w.keeperA.token)('POST', '/api/documents/receipts', body);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('already_expired');
    const ok = await call(env, w.keeperA.token)('POST', '/api/documents/receipts', { ...body, allowExpired: true });
    expect(ok.statusCode).toBe(201);
  });

  it('отклоняет отключённый продукт и точку вне доступа', async () => {
    const off = await addProduct(env, w.categoryId, { isActive: false });
    const bad = await call(env, w.keeperA.token)('POST', '/api/documents/receipts', {
      locationId: w.locA.id,
      lines: [{ productId: off, quantity: 1, unitCost: 10, expiresOn: w.day(3) }],
    });
    expect(bad.statusCode).toBe(400);
    const p = await addProduct(env, w.categoryId);
    const foreign = await call(env, w.keeperA.token)('POST', '/api/documents/receipts', {
      locationId: w.locB.id,
      lines: [{ productId: p, quantity: 1, unitCost: 10, expiresOn: w.day(3) }],
    });
    expect(foreign.statusCode).toBe(404);
  });
});

describe('продажа по FEFO', () => {
  it('расходует сначала партию с ближайшим сроком и переходит на следующую', async () => {
    const p = await addProduct(env, w.categoryId, { price: 100, cost: 60 });
    await receive(env, w.manager.token, w.locA.id, [
      { productId: p, quantity: 5, expiresOn: w.day(10) },
      { productId: p, quantity: 4, expiresOn: w.day(2) },
      { productId: p, quantity: 6, expiresOn: w.day(5) },
    ]);
    const res = await sale(w.keeperA.token, w.locA.id, [{ productId: p, quantity: 7 }]);
    expect(res.statusCode).toBe(201);

    const batches = await env.db.selectFrom('batches').select(['expires_on', 'remaining_qty']).orderBy('expires_on').execute();
    expect(batches.map((b) => [b.expires_on, Number(b.remaining_qty)])).toEqual([
      [w.day(2), 0],
      [w.day(5), 3],
      [w.day(10), 5],
    ]);
    const moves = await env.db.selectFrom('stock_movements').select(['type', 'quantity', 'unit_price']).where('type', '=', 'sale').orderBy('id').execute();
    expect(moves.map((m) => Number(m.quantity))).toEqual([-4, -3]);
    expect(moves.every((m) => Number(m.unit_price) === 100)).toBe(true);
    await assertLedgerConsistent(env);
  });

  it('не продаёт просроченное и сообщает, чего не хватает', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Творог' });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 10, expiresOn: w.day(-2) }], { allowExpired: true });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 2, expiresOn: w.day(3) }]);
    const res = await sale(w.keeperA.token, w.locA.id, [{ productId: p, quantity: 3 }]);
    expect(res.statusCode).toBe(422);
    const err = res.json().error;
    expect(err.code).toBe('insufficient_stock');
    expect(err.details[0]).toMatchObject({ name: 'Творог', requested: 3, available: 2 });
    expect(await remaining(env, p, w.locA.id)).toBe(12);
  });

  it('применяется целиком или не применяется вовсе', async () => {
    const a = await addProduct(env, w.categoryId);
    const b = await addProduct(env, w.categoryId);
    await receive(env, w.manager.token, w.locA.id, [
      { productId: a, quantity: 10, expiresOn: w.day(5) },
      { productId: b, quantity: 1, expiresOn: w.day(5) },
    ]);
    const res = await sale(w.keeperA.token, w.locA.id, [
      { productId: a, quantity: 4 },
      { productId: b, quantity: 2 },
    ]);
    expect(res.statusCode).toBe(422);
    expect(await remaining(env, a, w.locA.id)).toBe(10);
    const docs = await env.db.selectFrom('documents').select('kind').where('kind', '=', 'sale').execute();
    expect(docs).toHaveLength(0);
  });

  it('складывает повторы одного продукта в строках', async () => {
    const p = await addProduct(env, w.categoryId);
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 5, expiresOn: w.day(5) }]);
    const res = await sale(w.keeperA.token, w.locA.id, [
      { productId: p, quantity: 3 },
      { productId: p, quantity: 3 },
    ]);
    expect(res.statusCode).toBe(422);
    expect(await remaining(env, p, w.locA.id)).toBe(5);
  });

  it('не продаёт продукт, который только ингредиент', async () => {
    const flour = await addProduct(env, w.categoryId, { sellable: false, name: 'Мука' });
    await receive(env, w.manager.token, w.locA.id, [{ productId: flour, quantity: 5, expiresOn: w.day(50) }]);
    const res = await sale(w.keeperA.token, w.locA.id, [{ productId: flour, quantity: 1 }]);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('not_sellable');
  });

  it('списывает ингредиенты блюда по рецептуре и делит выручку без потерь', async () => {
    const milk = await addProduct(env, w.categoryId, { unit: 'l', cost: 60, sellable: false });
    const oats = await addProduct(env, w.categoryId, { unit: 'kg', cost: 120, sellable: false });
    const dish = await addDish(env, 'Овсяная каша', 190, [
      { productId: milk, quantity: 0.2 },
      { productId: oats, quantity: 0.05 },
    ]);
    await receive(env, w.manager.token, w.kitchen.id, [
      { productId: milk, quantity: 10, expiresOn: w.day(4), unitCost: 60 },
      { productId: oats, quantity: 2, expiresOn: w.day(100), unitCost: 120 },
    ]);
    const res = await sale(w.manager.token, w.kitchen.id, [{ dishId: dish, quantity: 3 }]);
    expect(res.statusCode).toBe(201);
    expect(await remaining(env, milk, w.kitchen.id)).toBeCloseTo(9.4, 6);
    expect(await remaining(env, oats, w.kitchen.id)).toBeCloseTo(1.85, 6);

    const moves = await env.db.selectFrom('stock_movements').select(['quantity', 'unit_price', 'dish_id']).where('type', '=', 'sale').execute();
    expect(moves.every((m) => m.dish_id === dish)).toBe(true);
    const revenue = moves.reduce((s, m) => s + -Number(m.quantity) * Number(m.unit_price), 0);
    expect(revenue).toBeCloseTo(570, 0);
  });

  it('ограничивает ввод: нулевое и отрицательное количество, лишние поля', async () => {
    const p = await addProduct(env, w.categoryId);
    for (const bad of [{ productId: p, quantity: 0 }, { productId: p, quantity: -1 }, { productId: p, quantity: 1, price: 1 }]) {
      const res = await sale(w.keeperA.token, w.locA.id, [bad]);
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('идемпотентность и гонки', () => {
  it('повтор с тем же ключом возвращает тот же документ и не списывает дважды', async () => {
    const p = await addProduct(env, w.categoryId);
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 10, expiresOn: w.day(5) }]);
    const first = await sale(w.keeperA.token, w.locA.id, [{ productId: p, quantity: 2 }], 'pos-0001-retry');
    const second = await sale(w.keeperA.token, w.locA.id, [{ productId: p, quantity: 2 }], 'pos-0001-retry');
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ documentId: first.json().documentId, duplicate: true });
    expect(await remaining(env, p, w.locA.id)).toBe(8);
  });

  it('параллельные повторы с одним ключом тоже создают один документ', async () => {
    const p = await addProduct(env, w.categoryId);
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 10, expiresOn: w.day(5) }]);
    const results = await Promise.all(Array.from({ length: 6 }, () => sale(w.keeperA.token, w.locA.id, [{ productId: p, quantity: 1 }], 'same-key-parallel')));
    const ids = new Set(results.map((r) => r.json().documentId));
    expect(ids.size).toBe(1);
    expect(await remaining(env, p, w.locA.id)).toBe(9);
  });

  it('двадцать параллельных продаж на остаток в десять продают ровно десять', async () => {
    const p = await addProduct(env, w.categoryId);
    await receive(env, w.manager.token, w.locA.id, [
      { productId: p, quantity: 6, expiresOn: w.day(3) },
      { productId: p, quantity: 4, expiresOn: w.day(9) },
    ]);
    const results = await Promise.all(Array.from({ length: 20 }, () => sale(w.keeperA.token, w.locA.id, [{ productId: p, quantity: 1 }])));
    const ok = results.filter((r) => r.statusCode === 201).length;
    const failed = results.filter((r) => r.statusCode === 422).length;
    expect(ok).toBe(10);
    expect(failed).toBe(10);
    expect(await remaining(env, p, w.locA.id)).toBe(0);
    const sold = await env.db.selectFrom('stock_movements').select(sql<string>`sum(-quantity)`.as('s')).where('type', '=', 'sale').executeTakeFirstOrThrow();
    expect(Number(sold.s)).toBe(10);
    await assertLedgerConsistent(env);
  });

  it('встречные многострочные продажи не уходят во взаимную блокировку', async () => {
    const a = await addProduct(env, w.categoryId);
    const b = await addProduct(env, w.categoryId);
    await receive(env, w.manager.token, w.locA.id, [
      { productId: a, quantity: 100, expiresOn: w.day(9) },
      { productId: b, quantity: 100, expiresOn: w.day(9) },
    ]);
    const jobs = Array.from({ length: 12 }, (_, i) =>
      sale(w.keeperA.token, w.locA.id, i % 2 === 0 ? [{ productId: a, quantity: 1 }, { productId: b, quantity: 1 }] : [{ productId: b, quantity: 1 }, { productId: a, quantity: 1 }]),
    );
    const results = await Promise.all(jobs);
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    expect(await remaining(env, a, w.locA.id)).toBe(88);
  });
});

describe('списание', () => {
  it('списывает из указанной партии с причиной и не даёт списать больше остатка', async () => {
    const p = await addProduct(env, w.categoryId);
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 5, expiresOn: w.day(5) }, { productId: p, quantity: 5, expiresOn: w.day(8) }]);
    const later = await env.db.selectFrom('batches').select('id').where('expires_on', '=', w.day(8)).executeTakeFirstOrThrow();
    const ok = await call(env, w.keeperA.token)('POST', '/api/documents/writeoffs', {
      locationId: w.locA.id,
      reason: 'spoiled',
      lines: [{ productId: p, batchId: later.id, quantity: 2 }],
    });
    expect(ok.statusCode).toBe(201);
    const batch = await env.db.selectFrom('batches').select('remaining_qty').where('id', '=', later.id).executeTakeFirstOrThrow();
    expect(Number(batch.remaining_qty)).toBe(3);

    const over = await call(env, w.keeperA.token)('POST', '/api/documents/writeoffs', {
      locationId: w.locA.id,
      reason: 'damaged',
      lines: [{ productId: p, batchId: later.id, quantity: 4 }],
    });
    expect(over.statusCode).toBe(422);
    const noReason = await call(env, w.keeperA.token)('POST', '/api/documents/writeoffs', {
      locationId: w.locA.id,
      lines: [{ productId: p, quantity: 1 }],
    });
    expect(noReason.statusCode).toBe(400);
    await assertLedgerConsistent(env);
  });

  it('«списать просроченное» убирает только просроченные партии', async () => {
    const p = await addProduct(env, w.categoryId);
    const q = await addProduct(env, w.categoryId);
    await receive(env, w.manager.token, w.locA.id, [
      { productId: p, quantity: 3, expiresOn: w.day(-3) },
      { productId: q, quantity: 2, expiresOn: w.day(-1) },
      { productId: p, quantity: 7, expiresOn: w.day(4) },
    ], { allowExpired: true });
    const res = await call(env, w.keeperA.token)('POST', '/api/documents/writeoffs/expired', { locationId: w.locA.id });
    expect(res.statusCode).toBe(201);
    expect(await remaining(env, p, w.locA.id)).toBe(7);
    expect(await remaining(env, q, w.locA.id)).toBe(0);
    const moves = await env.db.selectFrom('stock_movements').select('reason').where('type', '=', 'writeoff').execute();
    expect(moves.every((m) => m.reason === 'expired')).toBe(true);

    const again = await call(env, w.keeperA.token)('POST', '/api/documents/writeoffs/expired', { locationId: w.locA.id });
    expect(again.statusCode).toBe(422);
    expect(again.json().error.code).toBe('nothing_to_write_off');
  });
});

describe('перемещение', () => {
  it('переносит остаток вместе со сроком и себестоимостью', async () => {
    const p = await addProduct(env, w.categoryId);
    await receive(env, w.manager.token, w.locA.id, [
      { productId: p, quantity: 4, expiresOn: w.day(3), unitCost: 55 },
      { productId: p, quantity: 6, expiresOn: w.day(9), unitCost: 58 },
    ]);
    const res = await call(env, w.manager.token)('POST', '/api/documents/transfers', {
      fromLocationId: w.locA.id,
      toLocationId: w.locB.id,
      lines: [{ productId: p, quantity: 6 }],
    });
    expect(res.statusCode).toBe(201);
    expect(await remaining(env, p, w.locA.id)).toBe(4);
    const target = await env.db.selectFrom('batches').select(['expires_on', 'remaining_qty', 'unit_cost']).where('location_id', '=', w.locB.id).orderBy('expires_on').execute();
    expect(target.map((b) => [b.expires_on, Number(b.remaining_qty), Number(b.unit_cost)])).toEqual([
      [w.day(3), 4, 55],
      [w.day(9), 2, 58],
    ]);
    const kinds = await env.db.selectFrom('stock_movements').select('type').where('document_id', '=', res.json().documentId).execute();
    expect(kinds.filter((k) => k.type === 'transfer_out')).toHaveLength(2);
    expect(kinds.filter((k) => k.type === 'transfer_in')).toHaveLength(2);
    await assertLedgerConsistent(env);
  });

  it('требует доступ к обеим точкам и не переносит просроченное', async () => {
    const p = await addProduct(env, w.categoryId);
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 5, expiresOn: w.day(-1) }], { allowExpired: true });
    const denied = await call(env, w.keeperA.token)('POST', '/api/documents/transfers', {
      fromLocationId: w.locA.id,
      toLocationId: w.locB.id,
      lines: [{ productId: p, quantity: 1 }],
    });
    expect(denied.statusCode).toBe(404);
    const expired = await call(env, w.manager.token)('POST', '/api/documents/transfers', {
      fromLocationId: w.locA.id,
      toLocationId: w.locB.id,
      lines: [{ productId: p, quantity: 1 }],
    });
    expect(expired.statusCode).toBe(422);
  });
});

describe('журнал неизменяем', () => {
  it('прикладная роль не может менять и удалять движения и аудит', async () => {
    const p = await addProduct(env, w.categoryId);
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 5, expiresOn: w.day(5) }]);
    await expect(sql`UPDATE stock_movements SET quantity = 999`.execute(env.db)).rejects.toThrow(/permission denied/i);
    await expect(sql`DELETE FROM stock_movements`.execute(env.db)).rejects.toThrow(/permission denied/i);
    await expect(sql`UPDATE audit_log SET action = 'x'`.execute(env.db)).rejects.toThrow(/permission denied/i);
    await expect(sql`DELETE FROM audit_log`.execute(env.db)).rejects.toThrow(/permission denied/i);
    await expect(sql`TRUNCATE stock_movements`.execute(env.db)).rejects.toThrow(/permission denied/i);
  });

  it('даже владелец схемы упирается в триггер', async () => {
    const p = await addProduct(env, w.categoryId);
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 5, expiresOn: w.day(5) }]);
    await expect(sql`UPDATE stock_movements SET quantity = 999`.execute(env.owner)).rejects.toThrow(/только для добавления/);
    await expect(sql`DELETE FROM audit_log`.execute(env.owner)).rejects.toThrow(/только для добавления/);
  });

  it('база не допускает отрицательный остаток и несогласованный знак движения', async () => {
    const p = await addProduct(env, w.categoryId);
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 5, expiresOn: w.day(5) }]);
    await expect(sql`UPDATE batches SET remaining_qty = -1`.execute(env.db)).rejects.toThrow(/check/i);
    const batch = await env.db.selectFrom('batches').select('id').executeTakeFirstOrThrow();
    const doc = await env.db.selectFrom('documents').select('id').executeTakeFirstOrThrow();
    await expect(
      env.db
        .insertInto('stock_movements')
        .values({
          document_id: doc.id,
          batch_id: batch.id,
          product_id: p,
          location_id: w.locA.id,
          type: 'sale',
          quantity: '5.000',
          unit_cost: 1,
          unit_price: null,
          reason: null,
          dish_id: null,
          comment: null,
          created_by: null,
          created_at: env.clock.now,
        })
        .execute(),
    ).rejects.toThrow(/check/i);
  });
});

describe('акции', () => {
  it('скидка на партию отражается в цене следующей продажи и снимается', async () => {
    const p = await addProduct(env, w.categoryId, { price: 200, cost: 100 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 10, expiresOn: w.day(2), unitCost: 100 }]);
    const batch = await env.db.selectFrom('batches').select('id').executeTakeFirstOrThrow();

    const denied = await call(env, w.keeperA.token)('POST', '/api/promotions', { batchId: batch.id, percent: 30 });
    expect(denied.statusCode).toBe(403);
    const promo = await call(env, w.manager.token)('POST', '/api/promotions', { batchId: batch.id, percent: 30 });
    expect(promo.statusCode).toBe(201);
    expect(promo.json()).toMatchObject({ percent: 30, basePrice: 200, promoPrice: 140 });

    await sale(w.keeperA.token, w.locA.id, [{ productId: p, quantity: 1 }]);
    await call(env, w.manager.token)('DELETE', `/api/promotions/${promo.json().id}`);
    await sale(w.keeperA.token, w.locA.id, [{ productId: p, quantity: 1 }]);
    const prices = await env.db.selectFrom('stock_movements').select('unit_price').where('type', '=', 'sale').orderBy('id').execute();
    expect(prices.map((r) => Number(r.unit_price))).toEqual([140, 200]);
  });

  it('не создаёт акцию на просроченную партию', async () => {
    const p = await addProduct(env, w.categoryId);
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 3, expiresOn: w.day(-1) }], { allowExpired: true });
    const batch = await env.db.selectFrom('batches').select('id').executeTakeFirstOrThrow();
    const res = await call(env, w.manager.token)('POST', '/api/promotions', { batchId: batch.id, percent: 50 });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('batch_expired');
  });
});
