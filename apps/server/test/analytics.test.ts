import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDish, addProduct, assertLedgerConsistent, createWorld, receive, seedSales, type World } from './fixtures';
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

const recs = async (token: string, query = '') => (await call(env, token)('GET', `/api/analytics/recommendations${query}`)).json().items;

describe('рекомендации', () => {
  it('предлагает скидку на то, что не успеем продать, и перестаёт после акции', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Ряженка', unit: 'l', price: 100, cost: 60 });
    await seedSales(env, { productId: p, locationId: w.locA.id, days: 25, perDay: 4 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 30, expiresOn: w.day(2), unitCost: 60 }]);

    const list = await recs(w.manager.token);
    const discount = list.find((r: { type: string }) => r.type === 'discount');
    expect(discount).toBeDefined();
    // 4 в сутки, до конца третьего дня уйдёт 12, под угрозой 18
    expect(discount.quantity).toBe(18);
    expect(discount.action).toEqual({ kind: 'discount', percent: 30 });
    expect(discount.atRiskValue).toBe(1080);

    const applied = await call(env, w.manager.token)('POST', '/api/promotions', { batchId: discount.batchId, percent: discount.action.percent });
    expect(applied.statusCode).toBe(201);
    const after = await recs(w.manager.token);
    expect(after.find((r: { type: string }) => r.type === 'discount')).toBeUndefined();
  });

  it('не тревожит, если продаж хватает до конца срока', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Хлеб', unit: 'pcs' });
    await seedSales(env, { productId: p, locationId: w.locA.id, days: 25, perDay: 10 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 20, expiresOn: w.day(3) }]);
    const list = await recs(w.manager.token);
    expect(list.filter((r: { type: string }) => r.type === 'discount' || r.type === 'transfer')).toHaveLength(0);
  });

  it('у новой позиции без истории судит по сроку', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Новинка' });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 5, expiresOn: w.day(2) }]);
    const d = (await recs(w.manager.token)).find((r: { type: string }) => r.type === 'discount');
    expect(d).toBeDefined();
    expect(d.details).toMatch(/мало для прогноза/);
  });

  it('просроченное предлагает списать, и применение рекомендации очищает список', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Сыр' });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 2, expiresOn: w.day(-1), unitCost: 500 }], { allowExpired: true });
    const w1 = (await recs(w.manager.token)).find((r: { type: string }) => r.type === 'writeoff');
    expect(w1).toMatchObject({ quantity: 2, atRiskValue: 1000, daysLeft: -1 });
    const done = await call(env, w.keeperA.token)('POST', '/api/documents/writeoffs', {
      locationId: w.locA.id,
      reason: 'expired',
      lines: [{ productId: p, batchId: w1.batchId, quantity: w1.quantity }],
    });
    expect(done.statusCode).toBe(201);
    expect((await recs(w.manager.token)).filter((r: { type: string }) => r.type === 'writeoff')).toHaveLength(0);
  });

  it('предлагает переместить на точку, где расход быстрее остатка', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Кефир', unit: 'l', price: 100, cost: 60 });
    await seedSales(env, { productId: p, locationId: w.locA.id, days: 25, perDay: 1 });
    await seedSales(env, { productId: p, locationId: w.locB.id, days: 25, perDay: 12 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 20, expiresOn: w.day(4) }]);

    const t = (await recs(w.manager.token)).find((r: { type: string }) => r.type === 'transfer');
    expect(t).toBeDefined();
    expect(t.action.targetLocationId).toBe(w.locB.id);
    expect(t.quantity).toBeGreaterThan(0);

    const done = await call(env, w.manager.token)('POST', '/api/documents/transfers', {
      fromLocationId: w.locA.id,
      toLocationId: w.locB.id,
      lines: [{ productId: p, batchId: t.batchId, quantity: t.quantity }],
    });
    expect(done.statusCode).toBe(201);
    await assertLedgerConsistent(env);
  });

  it('для ингредиента под угрозой подсказывает блюда кухни', async () => {
    const milk = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l', sellable: false, cost: 60 });
    const dish = await addDish(env, 'Каша манная', 160, [{ productId: milk, quantity: 0.2 }]);
    await seedSales(env, { productId: milk, locationId: w.kitchen.id, days: 25, perDay: 2 });
    await receive(env, w.manager.token, w.kitchen.id, [{ productId: milk, quantity: 12, expiresOn: w.day(2) }]);
    const promote = (await recs(w.manager.token)).find((r: { type: string }) => r.type === 'promote');
    expect(promote).toBeDefined();
    expect(promote.dishes[0]).toMatchObject({ id: dish, portions: 60 });
  });

  it('советует заказать при остатке ниже минимума', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Яйца', unit: 'pcs', minStock: 30 });
    await seedSales(env, { productId: p, locationId: w.locA.id, days: 25, perDay: 20 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 25, expiresOn: w.day(20) }]);
    const r = (await recs(w.manager.token)).find((x: { type: string }) => x.type === 'reorder');
    expect(r).toBeDefined();
    expect(r.reorder.suggestedQty).toBe(115);
    expect(r.reorder.daysToZero).toBe(1.3);
  });

  it('кладовщик видит рекомендации только по своей точке', async () => {
    const p = await addProduct(env, w.categoryId);
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 5, expiresOn: w.day(1) }]);
    await receive(env, w.manager.token, w.locB.id, [{ productId: p, quantity: 5, expiresOn: w.day(1) }]);
    const all = await recs(w.manager.token);
    const mine = await recs(w.keeperA.token);
    expect(new Set(all.map((r: { locationId: string }) => r.locationId)).size).toBe(2);
    expect(new Set(mine.map((r: { locationId: string }) => r.locationId))).toEqual(new Set([w.locA.id]));
    expect((await call(env, w.keeperA.token)('GET', `/api/analytics/recommendations?locationId=${w.locB.id}`)).statusCode).toBe(404);
  });
});

describe('ответ рекомендаций', () => {
  it('отдаёт список, счётчики по типам и общий итог', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Сыр' });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 2, expiresOn: w.day(-1), unitCost: 500 }], { allowExpired: true });
    const q = await addProduct(env, w.categoryId, { name: 'Кефир' });
    await receive(env, w.manager.token, w.locA.id, [{ productId: q, quantity: 9, expiresOn: w.day(1) }]);
    const res = (await call(env, w.manager.token)('GET', '/api/analytics/recommendations')).json();
    expect(Object.keys(res).sort()).toEqual(['counts', 'items', 'total']);
    expect(res.counts).toEqual({ writeoff: 1, discount: 1, transfer: 0, promote: 0, reorder: 0 });
    expect(res.total).toBe(2);
    expect(res.items[0].type).toBe('writeoff');
    expect(res.items[0].headline).toMatch(/^Списать/);
  });

  it('фильтр по типу и по точке не ломает счётчики', async () => {
    const p = await addProduct(env, w.categoryId);
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 5, expiresOn: w.day(1) }]);
    await receive(env, w.manager.token, w.locB.id, [{ productId: p, quantity: 5, expiresOn: w.day(1) }]);
    const all = (await call(env, w.manager.token)('GET', '/api/analytics/recommendations')).json();
    expect(all.counts.discount).toBe(2);
    const oneLoc = (await call(env, w.manager.token)('GET', `/api/analytics/recommendations?locationId=${w.locB.id}`)).json();
    expect(oneLoc.counts.discount).toBe(1);
    expect(oneLoc.items).toHaveLength(1);
    const typed = (await call(env, w.manager.token)('GET', '/api/analytics/recommendations?type=writeoff')).json();
    expect(typed.items).toHaveLength(0);
    expect(typed.counts.discount).toBe(2);
  });
});

describe('панель', () => {
  it('считает деньги по себестоимости и раскладывает по срокам', async () => {
    const a = await addProduct(env, w.categoryId, { name: 'Молоко', cost: 60 });
    const b = await addProduct(env, w.categoryId, { name: 'Творог', cost: 200 });
    await receive(env, w.manager.token, w.locA.id, [
      { productId: a, quantity: 10, expiresOn: w.day(1), unitCost: 60 },
      { productId: b, quantity: 2, expiresOn: w.day(-2), unitCost: 200 },
      { productId: b, quantity: 3, expiresOn: w.day(30), unitCost: 200 },
    ], { allowExpired: true });
    const res = await call(env, w.manager.token)('GET', '/api/analytics/dashboard');
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.kpis.stockValue).toBe(1600);
    expect(d.kpis.expiredValue).toBe(400);
    expect(d.kpis.expiredBatches).toBe(1);
    expect(d.kpis.expiringSoonValue).toBe(600);
    const bucket = Object.fromEntries(d.expiryBuckets.map((x: { key: string; value: number; batches: number }) => [x.key, [x.value, x.batches]]));
    expect(bucket.expired).toEqual([400, 1]);
    expect(bucket.d0_1).toEqual([600, 1]);
    expect(bucket.d15_plus).toEqual([600, 1]);
    expect(d.writeoffTrend).toHaveLength(30);
  });

  it('учитывает списания и выручку за 30 дней', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Кефир', price: 100, cost: 60 });
    await receive(env, w.manager.token, w.locA.id, [
      { productId: p, quantity: 10, expiresOn: w.day(-1), unitCost: 60 },
      { productId: p, quantity: 10, expiresOn: w.day(5), unitCost: 60 },
    ], { allowExpired: true });
    await call(env, w.keeperA.token)('POST', '/api/documents/writeoffs/expired', { locationId: w.locA.id });
    await call(env, w.keeperA.token)('POST', '/api/documents/sales', { locationId: w.locA.id, lines: [{ productId: p, quantity: 4 }] });
    const d = (await call(env, w.manager.token)('GET', '/api/analytics/dashboard')).json();
    expect(d.kpis.writeoff30dValue).toBe(600);
    expect(d.kpis.revenue30d).toBe(400);
    expect(d.writeoffByReason).toEqual([{ reason: 'expired', value: 600 }]);
    const today = d.writeoffTrend[d.writeoffTrend.length - 1];
    expect(today).toMatchObject({ date: w.today, expired: 600 });
  });

  it('фильтрует по точке, и кладовщик не заглянет в чужую', async () => {
    const p = await addProduct(env, w.categoryId, { cost: 10 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 10, expiresOn: w.day(9), unitCost: 10 }]);
    await receive(env, w.manager.token, w.locB.id, [{ productId: p, quantity: 30, expiresOn: w.day(9), unitCost: 10 }]);
    const get = async (token: string, q = '') => call(env, token)('GET', `/api/analytics/dashboard${q}`);
    expect((await get(w.manager.token)).json().kpis.stockValue).toBe(400);
    expect((await get(w.manager.token, `?locationId=${w.locB.id}`)).json().kpis.stockValue).toBe(300);
    expect((await get(w.keeperA.token)).json().kpis.stockValue).toBe(100);
    expect((await get(w.keeperA.token, `?locationId=${w.locB.id}`)).statusCode).toBe(404);
  });
});

describe('прогноз', () => {
  it('отдаёт скорость, историю и риск по партиям', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Сметана', unit: 'kg' });
    await seedSales(env, { productId: p, locationId: w.locA.id, days: 25, perDay: 3 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 20, expiresOn: w.day(3) }]);
    const res = await call(env, w.manager.token)('GET', `/api/analytics/forecast/${p}?locationId=${w.locA.id}`);
    expect(res.statusCode).toBe(200);
    const f = res.json();
    expect(f.velocityPerDay).toBe(3);
    expect(f.confidence).toBe(1);
    expect(f.history).toHaveLength(28);
    expect(f.history[27].qty).toBe(3);
    expect(f.daysToZero).toBe(6.7);
    expect(f.batches[0]).toMatchObject({ remaining: 20, atRisk: 8 });
  });
});
