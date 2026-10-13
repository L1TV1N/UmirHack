import type { SupplierRatingDto } from '@zapas/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addProduct, createWorld, type World } from './fixtures';
import { call, createTestEnv, type TestEnv } from './helpers';

let env: TestEnv;
let w: World;

beforeAll(async () => {
  env = await createTestEnv({ ACCESS_TOKEN_TTL_SECONDS: '3600' });
});
afterAll(() => env.close());
beforeEach(async () => {
  await env.reset();
  w = await createWorld(env);
});

const manager = () => call(env, w.manager.token);
const rating = async (token = w.manager.token, query = '') => (await call(env, token)('GET', `/api/analytics/suppliers${query}`)).json() as SupplierRatingDto;

async function supplier(name = 'Молокозавод') {
  const res = await manager()('POST', '/api/suppliers', { name, email: 'zakaz@milk.example', leadTimeDays: 1, minOrderSum: 0 });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

/** Заказ на 10 штук по 100 рублей, отправленный поставщику. expectedOn подменяется в базе, чтобы проверить опоздание. */
async function sentOrder(supplierId: string, productId: string, expectedOn: string, quantity = 10) {
  const created = await manager()('POST', '/api/orders', { supplierId, locationId: w.locA.id, lines: [{ productId, quantity, unitCost: 100 }] });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().id as string;
  expect((await manager()('POST', `/api/orders/${id}/send`)).statusCode).toBe(200);
  await env.owner.updateTable('purchase_orders').set({ expected_on: expectedOn }).where('id', '=', id).execute();
  return id;
}

const receive = (orderId: string, productId: string, quantity: number, shelfLifeDays = 10) =>
  manager()('POST', '/api/documents/receipts', { locationId: w.locA.id, orderId, lines: [{ productId, quantity, unitCost: 100, shelfLifeDays }] });

describe('рейтинг поставщиков', () => {
  it('приход по заказу запоминает заказ в документе', async () => {
    const s = await supplier();
    const p = await addProduct(env, w.categoryId, { name: 'Кефир', unit: 'pcs', cost: 100 });
    const o = await sentOrder(s, p, w.day(1));
    expect((await receive(o, p, 10)).statusCode).toBe(201);
    const doc = await env.owner.selectFrom('documents').select('order_id').where('kind', '=', 'receipt').executeTakeFirstOrThrow();
    expect(doc.order_id).toBe(o);
  });

  it('считает выполнение заказа по стоимости и вовремя ли пришла поставка', async () => {
    const s = await supplier();
    const p = await addProduct(env, w.categoryId, { name: 'Кефир', unit: 'pcs', cost: 100, shelfLifeDays: 10 });

    // первый заказ привезли целиком в обещанный день
    const first = await sentOrder(s, p, w.day(0));
    await receive(first, p, 10);
    // второй пообещали на вчера, привезли сегодня 6 из 10 и закрыли недопоставку
    const second = await sentOrder(s, p, w.day(-1));
    await receive(second, p, 6);
    expect((await manager()('POST', `/api/orders/${second}/close`, { comment: 'Довезти не смогли' })).statusCode).toBe(200);

    const r = await rating();
    expect(r.suppliers).toHaveLength(1);
    const row = r.suppliers[0]!;
    expect(row).toMatchObject({ supplierName: 'Молокозавод', orders: 2, receivedValue: 1600 });
    // заказано на 2000, привезено на 1600
    expect(row.fillRate).toBeCloseTo(0.8, 3);
    expect(row.onTimeRate).toBeCloseTo(0.5, 3);
    expect(row.avgDelayDays).toBeCloseTo(0.5, 1);
    expect(row.freshness).toBeCloseTo(1, 3);
    expect(row.grade).toBeTruthy();
    expect(row.score).toBeLessThan(100);
  });

  it('заказ, срок которого ещё не наступил, в расчёт не идёт; не привезённый вовремя считается опоздавшим', async () => {
    const s = await supplier();
    const p = await addProduct(env, w.categoryId, { name: 'Кефир', unit: 'pcs', cost: 100 });
    await sentOrder(s, p, w.day(3));
    expect((await rating()).suppliers).toEqual([]);

    await sentOrder(s, p, w.day(-2));
    const row = (await rating()).suppliers[0]!;
    expect(row).toMatchObject({ orders: 1, fillRate: 0, onTimeRate: 0 });
    expect(row.avgDelayDays).toBeCloseTo(2, 1);
  });

  it('потери по причинам относятся к поставщику партии, порча и бой снижают оценку', async () => {
    const s = await supplier();
    const p = await addProduct(env, w.categoryId, { name: 'Кефир', unit: 'pcs', cost: 100 });
    const o = await sentOrder(s, p, w.day(0));
    await receive(o, p, 10);
    const clean = (await rating()).suppliers[0]!;

    expect((await call(env, w.keeperA.token)('POST', '/api/documents/writeoffs', { locationId: w.locA.id, reason: 'spoiled', lines: [{ productId: p, quantity: 2 }] })).statusCode).toBe(201);
    expect((await call(env, w.keeperA.token)('POST', '/api/documents/writeoffs', { locationId: w.locA.id, reason: 'expired', lines: [{ productId: p, quantity: 1 }] })).statusCode).toBe(201);

    const r = await rating();
    const row = r.suppliers[0]!;
    expect(row.losses).toEqual([
      { reason: 'spoiled', value: 200 },
      { reason: 'expired', value: 100 },
    ]);
    expect(row.lossValue).toBe(300);
    // порча и бой: 200 из принятых 1000
    expect(row.spoilageRate).toBeCloseTo(0.2, 3);
    expect(row.score).toBeLessThan(clean.score as number);
    expect(r.totalLoss).toBe(300);
    expect(r.lossesByReason[0]).toEqual({ reason: 'spoiled', value: 200 });
  });

  it('короткий остаток срока при приёмке снижает свежесть', async () => {
    const s = await supplier();
    const p = await addProduct(env, w.categoryId, { name: 'Кефир', unit: 'pcs', cost: 100, shelfLifeDays: 10 });
    const o = await sentOrder(s, p, w.day(0));
    // из десяти суток срока привезли с двумя
    await receive(o, p, 10, 2);
    expect((await rating()).suppliers[0]?.freshness).toBeCloseTo(0.2, 3);
  });

  it('видят менеджер и администратор; кладовщику и наблюдателю закрыто, чужая точка не видна', async () => {
    expect((await call(env, w.keeperA.token)('GET', '/api/analytics/suppliers')).statusCode).toBe(403);
    expect((await call(env, w.viewerA.token)('GET', '/api/analytics/suppliers')).statusCode).toBe(403);
    expect((await call(env, w.admin.token)('GET', '/api/analytics/suppliers')).statusCode).toBe(200);
    expect((await call(env, w.manager.token)('GET', '/api/analytics/suppliers?days=3')).statusCode).toBe(400);

    const s = await supplier();
    const p = await addProduct(env, w.categoryId, { name: 'Кефир', unit: 'pcs', cost: 100 });
    await receive(await sentOrder(s, p, w.day(0)), p, 10);
    expect((await rating(w.manager.token, `?locationId=${w.locB.id}`)).suppliers).toEqual([]);
    expect((await rating(w.manager.token, `?locationId=${w.locA.id}`)).suppliers).toHaveLength(1);
  });
});
