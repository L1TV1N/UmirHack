import type { GuestOrderDetailDto } from '@zapas/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDish, addProduct, createWorld, receive, type World } from './fixtures';
import { call, createTestEnv, createUser, loginAs, type TestEnv } from './helpers';

let env: TestEnv;
let w: World;
let borsch: string;

beforeAll(async () => {
  env = await createTestEnv({ ACCESS_TOKEN_TTL_SECONDS: '3600' });
});
afterAll(() => env.close());
beforeEach(async () => {
  await env.reset();
  w = await createWorld(env);
  const beef = await addProduct(env, w.categoryId, { name: 'Говядина', unit: 'kg', cost: 500 });
  borsch = await addDish(env, 'Борщ', 290, [{ productId: beef, quantity: 0.12 }]);
  await receive(env, w.manager.token, w.kitchen.id, [{ productId: beef, quantity: 3, expiresOn: w.day(2), unitCost: 500 }]);
  await env.settle();
});

const waiter = () => call(env, w.waiterA.token);
const body = (extra: Record<string, unknown> = {}) => ({ locationId: w.kitchen.id, tableLabel: '7', lines: [{ dishId: borsch, quantity: 2 }], ...extra });
const send = (payload: object, key?: string) => waiter()('POST', '/api/guest-orders', payload, key ? { 'idempotency-key': key } : {});
const count = async () => Number((await env.db.selectFrom('guest_orders').select(({ fn }) => fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);

describe('заказы гостей, принятые без связи', () => {
  it('повторная отправка с тем же ключом возвращает тот же заказ и не создаёт второй', async () => {
    const first = await send(body(), 'offline-order-0001');
    expect(first.statusCode, first.body).toBe(201);
    const again = await send(body(), 'offline-order-0001');
    expect(again.statusCode).toBe(201);
    expect(again.json().id).toBe(first.json().id);
    expect(await count()).toBe(1);
  });

  it('другой ключ или заказ без ключа создаёт новый заказ', async () => {
    const a = await send(body(), 'offline-order-0001');
    const b = await send(body(), 'offline-order-0002');
    const c = await send(body());
    expect(new Set([a.json().id, b.json().id, c.json().id]).size).toBe(3);
    expect(await count()).toBe(3);
  });

  it('ключ действует в пределах официанта: тот же ключ у другого официанта даёт отдельный заказ', async () => {
    const mine = await send(body(), 'offline-order-0001');
    const second = await createUser(env, { role: 'waiter', locationIds: [w.kitchen.id] });
    const session = await loginAs(env, second);
    const theirs = await call(env, session.token)('POST', '/api/guest-orders', body(), { 'idempotency-key': 'offline-order-0001' });
    expect(theirs.statusCode, theirs.body).toBe(201);
    expect(theirs.json().id).not.toBe(mine.json().id);
  });

  it('одновременные одинаковые запросы дают один заказ', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => send(body(), 'offline-order-race')));
    for (const r of results) expect(r.statusCode, r.body).toBe(201);
    expect(new Set(results.map((r) => r.json().id)).size).toBe(1);
    expect(await count()).toBe(1);
  });

  it('повтор после того, как блюдо ушло в стоп-лист, всё равно возвращает уже принятый заказ', async () => {
    const first = await send(body(), 'offline-order-0001');
    await call(env, w.manager.token)('POST', '/api/stop-list/manual', { locationId: w.kitchen.id, dishId: borsch, reason: 'Закончилось' });
    const again = await send(body(), 'offline-order-0001');
    expect(again.statusCode).toBe(201);
    expect(again.json().id).toBe(first.json().id);
  });

  it('новый заказ с блюдом из стоп-листа не принимается и в очереди остаётся причина', async () => {
    await call(env, w.manager.token)('POST', '/api/stop-list/manual', { locationId: w.kitchen.id, dishId: borsch, reason: 'Закончилось' });
    const res = await send(body(), 'offline-order-0003');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('dish_stopped');
    expect(res.json().error.message).toMatch(/в стоп-листе/);
    expect(await count()).toBe(0);
  });

  it('время приёма сохраняется и попадает в ленту заказа', async () => {
    const placed = new Date(env.clock.now.getTime() - 7 * 60_000).toISOString();
    const res = await send(body({ placedAt: placed }), 'offline-order-0004');
    const order = res.json() as GuestOrderDetailDto;
    expect(order.placedAt).toBe(placed);
    expect(order.createdAt).toBe(env.clock.now.toISOString());
    expect(order.events[0]?.text).toMatch(/без связи, дошёл в/);
  });

  it('заказ, принятый только что, не помечается как поздний', async () => {
    const res = await send(body({ placedAt: new Date(env.clock.now.getTime() - 20_000).toISOString() }));
    expect(res.json().placedAt).toBeNull();
    expect(res.json().events[0].text).not.toMatch(/без связи/);
  });

  it('время из будущего игнорируется, а слишком старое подтягивается до суток', async () => {
    const future = await send(body({ placedAt: new Date(env.clock.now.getTime() + 3600_000).toISOString() }));
    expect(future.json().placedAt).toBeNull();
    const ancient = await send(body({ placedAt: new Date(env.clock.now.getTime() - 10 * 86_400_000).toISOString() }));
    expect(ancient.json().placedAt).toBe(new Date(env.clock.now.getTime() - 86_400_000).toISOString());
  });

  it('неверный формат времени и слишком короткий ключ отклоняются', async () => {
    expect((await send(body({ placedAt: 'вчера вечером' }))).statusCode).toBe(400);
    expect((await send(body(), 'x')).statusCode).toBe(400);
  });

  it('менеджер видит поздний заказ в списке с временем приёма', async () => {
    const placed = new Date(env.clock.now.getTime() - 5 * 60_000).toISOString();
    await send(body({ placedAt: placed }), 'offline-order-0005');
    const list = await call(env, w.manager.token)('GET', '/api/guest-orders');
    expect(list.json()[0]).toMatchObject({ placedAt: placed });
  });
});
