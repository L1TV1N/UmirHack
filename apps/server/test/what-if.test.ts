import type { WhatIfResultDto } from '@zapas/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDish, addProduct, createWorld, receive, seedSales, type World } from './fixtures';
import { call, createTestEnv, createUser, loginAs, type TestEnv } from './helpers';

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

const run = async (token: string, body: object): Promise<{ status: number; json: WhatIfResultDto & { error?: { code: string } } }> => {
  const res = await call(env, token)('POST', '/api/analytics/what-if', body);
  return { status: res.statusCode, json: res.json() };
};

const batchOf = async (productId: string, locationId: string) =>
  env.db.selectFrom('batches').selectAll().where('product_id', '=', productId).where('location_id', '=', locationId).where('remaining_qty', '>', '0').executeTakeFirstOrThrow();

/** Всё, что может изменить прогон, если бы он писал в базу. */
async function dbFingerprint(): Promise<string> {
  const [batches, movements, docs, state, audit] = await Promise.all([
    env.db.selectFrom('batches').select(['id', 'remaining_qty']).orderBy('id').execute(),
    env.db.selectFrom('stock_movements').select(({ fn }) => fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
    env.db.selectFrom('documents').select(({ fn }) => fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
    env.db.selectFrom('stop_list_state').select(({ fn }) => fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
    env.db.selectFrom('audit_log').select(({ fn }) => fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
  ]);
  return JSON.stringify({ batches, m: movements.n, d: docs.n, s: state.n, a: audit.n });
}

describe('«Что если»: прогон решений без записи', () => {
  it('списание партии убирает риск и показывает потерю, но в базе остаётся всё как было', async () => {
    const cheese = await addProduct(env, w.categoryId, { name: 'Сыр', unit: 'kg', cost: 400 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: cheese, quantity: 5, expiresOn: w.day(1), unitCost: 400 }]);
    const batch = await batchOf(cheese, w.locA.id);
    const before = await dbFingerprint();

    const { status, json } = await run(w.manager.token, { actions: [{ type: 'writeoff', batchId: batch.id }] });
    expect(status).toBe(200);
    expect(json.persisted).toBe(false);
    expect(json.steps[0]).toMatchObject({ ok: true, type: 'writeoff', cost: 2000 });
    expect(json.before.stockValue).toBe(2000);
    expect(json.after.stockValue).toBe(0);
    expect(json.after.atRiskValue).toBeLessThan(json.before.atRiskValue);
    expect(await dbFingerprint()).toBe(before);
  });

  it('повторный прогон даёт тот же результат, а реальные данные после прогона не искажены', async () => {
    const cheese = await addProduct(env, w.categoryId, { name: 'Сыр', unit: 'kg', cost: 400 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: cheese, quantity: 5, expiresOn: w.day(1), unitCost: 400 }]);
    const batch = await batchOf(cheese, w.locA.id);
    const body = { actions: [{ type: 'writeoff', batchId: batch.id, quantity: 2 }] };
    const a = await run(w.manager.token, body);
    const b = await run(w.manager.token, body);
    expect(b.json.after).toEqual(a.json.after);
    const real = (await call(env, w.manager.token)('GET', '/api/analytics/dashboard')).json();
    expect(Number(JSON.stringify(real).match(/"stockValue":([\d.]+)/)?.[1])).toBe(2000);
  });

  it('прогон не сбрасывает кеш расчётов', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l', cost: 60 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 5, expiresOn: w.day(5) }]);
    await call(env, w.manager.token)('GET', '/api/analytics/dashboard');
    const warm = await call(env, w.manager.token)('GET', '/api/analytics/dashboard');
    expect(warm.headers['x-cache']).toMatch(/HIT/);
    await run(w.manager.token, { actions: [{ type: 'receive', productId: p, locationId: w.locA.id, quantity: 1, shelfDays: 3 }] });
    const after = await call(env, w.manager.token)('GET', '/api/analytics/dashboard');
    expect(after.headers['x-cache']).toMatch(/HIT/);
  });

  it('продажа блюда уводит ингредиент в ноль: блюдо попадает в стоп-лист', async () => {
    const beef = await addProduct(env, w.categoryId, { name: 'Говядина', unit: 'kg', cost: 500, sellable: false });
    const dish = await addDish(env, 'Борщ', 290, [{ productId: beef, quantity: 0.1 }]);
    await receive(env, w.manager.token, w.kitchen.id, [{ productId: beef, quantity: 1, expiresOn: w.day(3), unitCost: 500 }]);
    const { json } = await run(w.manager.token, { actions: [{ type: 'cook', dishId: dish, locationId: w.kitchen.id, portions: 10 }] });
    expect(json.steps[0]).toMatchObject({ ok: true, cost: 500 });
    expect(json.stopAdded.map((s) => s.name)).toEqual(expect.arrayContaining(['Борщ']));
    expect(json.after.stopCount).toBeGreaterThan(json.before.stopCount);
  });

  it('если продуктов не хватает, шаг не выполняется и говорит, на сколько порций хватит', async () => {
    const beef = await addProduct(env, w.categoryId, { name: 'Говядина', unit: 'kg', cost: 500, sellable: false });
    const dish = await addDish(env, 'Борщ', 290, [{ productId: beef, quantity: 0.1 }]);
    await receive(env, w.manager.token, w.kitchen.id, [{ productId: beef, quantity: 1, expiresOn: w.day(3) }]);
    const { json } = await run(w.manager.token, { actions: [{ type: 'cook', dishId: dish, locationId: w.kitchen.id, portions: 11 }] });
    expect(json.steps[0]).toMatchObject({ ok: false, cost: 0 });
    expect(json.steps[0]?.text).toMatch(/хватит только на 10 порц/);
    expect(json.after.stockValue).toBe(json.before.stockValue);
  });

  it('поставка выводит блюдо из стоп-листа', async () => {
    const beef = await addProduct(env, w.categoryId, { name: 'Говядина', unit: 'kg', cost: 500, sellable: false });
    const cream = await addProduct(env, w.categoryId, { name: 'Сливки', unit: 'l', cost: 100, sellable: false });
    await addDish(env, 'Стейк', 800, [{ productId: beef, quantity: 0.2 }, { productId: cream, quantity: 0.1 }]);
    await receive(env, w.manager.token, w.kitchen.id, [{ productId: beef, quantity: 2, expiresOn: w.day(3) }]);
    await receive(env, w.manager.token, w.kitchen.id, [{ productId: cream, quantity: 1, expiresOn: w.day(3) }]);
    await call(env, w.admin.token)('POST', '/api/documents/writeoffs', { locationId: w.kitchen.id, reason: 'other', lines: [{ productId: cream, quantity: 1 }] });
    const { json } = await run(w.manager.token, { actions: [{ type: 'receive', productId: cream, locationId: w.kitchen.id, quantity: 3, shelfDays: 5 }] });
    expect(json.stopRemoved.map((s) => s.name)).toEqual(expect.arrayContaining(['Стейк']));
    expect(json.after.stopCount).toBeLessThan(json.before.stopCount);
  });

  it('перемещение переносит риск с одной точки на другую', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Ряженка', unit: 'l', cost: 60 });
    await seedSales(env, { productId: p, locationId: w.locB.id, days: 25, perDay: 10 });
    await seedSales(env, { productId: p, locationId: w.locA.id, days: 25, perDay: 0.1 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 30, expiresOn: w.day(3), unitCost: 60 }]);
    const batch = await batchOf(p, w.locA.id);
    const { json } = await run(w.manager.token, { actions: [{ type: 'transfer', batchId: batch.id, toLocationId: w.locB.id }] });
    expect(json.steps[0], JSON.stringify(json.steps)).toMatchObject({ ok: true });
    expect(json.after.atRiskValue).toBeLessThan(json.before.atRiskValue);
    expect(json.after.stockValue).toBe(json.before.stockValue);
  });

  it('рост спроса снижает риск, падение повышает', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Ряженка', unit: 'l', cost: 60 });
    await seedSales(env, { productId: p, locationId: w.locA.id, days: 25, perDay: 5 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 40, expiresOn: w.day(3), unitCost: 60 }]);
    const up = await run(w.manager.token, { actions: [{ type: 'demand', productId: p, locationId: w.locA.id, factor: 2 }] });
    const down = await run(w.manager.token, { actions: [{ type: 'demand', productId: p, locationId: w.locA.id, factor: 0.2 }] });
    expect(up.json.after.atRiskValue).toBeLessThan(up.json.before.atRiskValue);
    expect(down.json.after.atRiskValue).toBeGreaterThan(down.json.before.atRiskValue);
  });

  it('шаги применяются по порядку: после списания той же партии второе списание превышает остаток', async () => {
    const cheese = await addProduct(env, w.categoryId, { name: 'Сыр', unit: 'kg', cost: 400 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: cheese, quantity: 5, expiresOn: w.day(2), unitCost: 400 }]);
    const batch = await batchOf(cheese, w.locA.id);
    const { json } = await run(w.manager.token, { actions: [{ type: 'writeoff', batchId: batch.id, quantity: 4 }, { type: 'writeoff', batchId: batch.id, quantity: 2 }] });
    expect(json.steps.map((s) => s.ok)).toEqual([true, false]);
    expect(json.steps[1]?.text).toMatch(/только 1/);
    expect(json.before.stockValue - json.after.stockValue).toBe(1600);
  });

  it('просроченную партию переместить нельзя, чужую партию не видно', async () => {
    const cheese = await addProduct(env, w.categoryId, { name: 'Сыр', unit: 'kg', cost: 400 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: cheese, quantity: 5, expiresOn: w.day(-1) }], { allowExpired: true });
    const batch = await batchOf(cheese, w.locA.id);
    const move = await run(w.manager.token, { actions: [{ type: 'transfer', batchId: batch.id, toLocationId: w.locB.id }] });
    expect(move.json.steps[0]).toMatchObject({ ok: false });
    expect(move.json.steps[0]?.text).toMatch(/просроченную/);

    const other = await createUser(env, { role: 'storekeeper', locationIds: [w.locB.id] });
    const session = await loginAs(env, other);
    const mine = await run(session.token, { actions: [{ type: 'writeoff', batchId: batch.id }] });
    expect(mine.json.steps[0]).toMatchObject({ ok: false });
    expect(mine.json.steps[0]?.text).toMatch(/не найдена/);
  });

  it('права: наблюдатель получает 403, аноним 401; чужая точка в locationId 404', async () => {
    const body = { actions: [{ type: 'demand', productId: '11111111-1111-4111-8111-111111111111', locationId: w.locA.id, factor: 2 }] };
    expect((await run(w.viewerA.token, body)).status).toBe(403);
    expect((await call(env, null)('POST', '/api/analytics/what-if', body)).statusCode).toBe(401);
    expect((await run(w.keeperA.token, { ...body, locationId: w.locB.id })).status).toBe(404);
    expect((await run(w.keeperA.token, body)).status).toBe(200);
  });

  it('форма запроса проверяется: пустой список, лишние поля, слишком много шагов, плохие числа', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect((await run(w.manager.token, { actions: [] })).status).toBe(400);
    expect((await run(w.manager.token, { actions: [{ type: 'writeoff', batchId: id, boom: 1 }] })).status).toBe(400);
    expect((await run(w.manager.token, { actions: Array.from({ length: 11 }, () => ({ type: 'writeoff', batchId: id })) })).status).toBe(400);
    expect((await run(w.manager.token, { actions: [{ type: 'demand', productId: id, locationId: id, factor: 50 }] })).status).toBe(400);
    expect((await run(w.manager.token, { actions: [{ type: 'receive', productId: id, locationId: id, quantity: -1, shelfDays: 3 }] })).status).toBe(400);
    expect((await run(w.manager.token, { actions: [{ type: 'unknown' }] })).status).toBe(400);
  });

  it('данные другой организации недоступны', async () => {
    const cheese = await addProduct(env, w.categoryId, { name: 'Сыр', unit: 'kg', cost: 400 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: cheese, quantity: 5, expiresOn: w.day(2) }]);
    const batch = await batchOf(cheese, w.locA.id);
    const reg = await env.app.inject({ method: 'POST', url: '/api/auth/register', payload: { organizationName: 'Чужая', fullName: 'Иван Чужой', email: 'x@y.example', password: 'Хорошая-длинная-фраза-91' } });
    const token = reg.json().accessToken as string;
    const { json } = await run(token, { actions: [{ type: 'writeoff', batchId: batch.id }] });
    expect(json.steps[0]?.ok).toBe(false);
  });
});
