import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDish, addProduct, assertLedgerConsistent, createWorld, receive, remaining, type World } from './fixtures';
import { call, createTestEnv, type TestEnv } from './helpers';
import { schedulerTick } from '../src/modules/notifications/scheduler';

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

const sale = (token: string, locationId: string, lines: object[]) =>
  call(env, token)('POST', '/api/documents/sales', { locationId, lines });

describe('инвентаризация', () => {
  async function setup() {
    const a = await addProduct(env, w.categoryId, { name: 'Кефир', unit: 'l', cost: 50 });
    const b = await addProduct(env, w.categoryId, { name: 'Сметана', unit: 'kg', cost: 120 });
    await receive(env, w.manager.token, w.locA.id, [
      { productId: a, quantity: 6, expiresOn: w.day(2), unitCost: 50 },
      { productId: a, quantity: 4, expiresOn: w.day(8), unitCost: 52 },
      { productId: b, quantity: 5, expiresOn: w.day(6), unitCost: 120 },
    ]);
    const created = await call(env, w.keeperA.token)('POST', '/api/inventories', { locationId: w.locA.id });
    expect(created.statusCode).toBe(201);
    return { a, b, inv: created.json() };
  }

  it('фиксирует ожидаемые остатки и не допускает вторую открытую на точке', async () => {
    const { a, b, inv } = await setup();
    const byId = Object.fromEntries(inv.lines.map((l: { productId: string; expectedQty: number }) => [l.productId, l.expectedQty]));
    expect(byId[a]).toBe(10);
    expect(byId[b]).toBe(5);
    const second = await call(env, w.keeperA.token)('POST', '/api/inventories', { locationId: w.locA.id });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('inventory_open');
  });

  it('недостача списывается по FEFO, излишек требует срок и становится новой партией', async () => {
    const { a, b, inv } = await setup();
    const save = await call(env, w.keeperA.token)('PUT', `/api/inventories/${inv.id}/lines`, {
      lines: [
        { productId: a, countedQty: 7 },
        { productId: b, countedQty: 6.5 },
      ],
    });
    expect(save.statusCode).toBe(200);

    const forbidden = await call(env, w.keeperA.token)('POST', `/api/inventories/${inv.id}/commit`);
    expect(forbidden.statusCode).toBe(403);

    const noDate = await call(env, w.manager.token)('POST', `/api/inventories/${inv.id}/commit`);
    expect(noDate.statusCode).toBe(422);
    expect(noDate.json().error.code).toBe('surplus_date_required');
    expect(await remaining(env, a, w.locA.id)).toBe(10);

    await call(env, w.keeperA.token)('PUT', `/api/inventories/${inv.id}/lines`, {
      lines: [{ productId: b, countedQty: 6.5, surplusExpiresOn: w.day(7) }],
    });
    const ok = await call(env, w.manager.token)('POST', `/api/inventories/${inv.id}/commit`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().inventory.status).toBe('committed');

    expect(await remaining(env, a, w.locA.id)).toBe(7);
    // недостача 3 л сначала сняла ближайшую партию (6 л → 3 л)
    const early = await env.db.selectFrom('batches').select('remaining_qty').where('product_id', '=', a).where('expires_on', '=', w.day(2)).executeTakeFirstOrThrow();
    expect(Number(early.remaining_qty)).toBe(3);
    expect(await remaining(env, b, w.locA.id)).toBe(6.5);
    const surplusBatch = await env.db.selectFrom('batches').select(['expires_on', 'initial_qty']).where('product_id', '=', b).orderBy('created_at', 'desc').orderBy('expires_on').execute();
    expect(surplusBatch.some((x) => x.expires_on === w.day(7) && Number(x.initial_qty) === 1.5)).toBe(true);

    const again = await call(env, w.manager.token)('POST', `/api/inventories/${inv.id}/commit`);
    expect(again.statusCode).toBe(409);
    await assertLedgerConsistent(env);
  });

  it('сравнивает факт с текущим остатком, а не со снимком на момент создания', async () => {
    const { a, inv } = await setup();
    await sale(w.keeperA.token, w.locA.id, [{ productId: a, quantity: 3 }]);
    await call(env, w.keeperA.token)('PUT', `/api/inventories/${inv.id}/lines`, { lines: [{ productId: a, countedQty: 7 }] });
    const ok = await call(env, w.manager.token)('POST', `/api/inventories/${inv.id}/commit`);
    expect(ok.statusCode).toBe(200);
    const adjustments = await env.db.selectFrom('stock_movements').select('type').where('type', 'in', ['adjustment_in', 'adjustment_out']).execute();
    expect(adjustments).toHaveLength(0);
  });

  it('позиция вне инвентаризации и закрытая сессия не принимают ввод', async () => {
    const { inv } = await setup();
    const stranger = await addProduct(env, w.categoryId);
    const bad = await call(env, w.keeperA.token)('PUT', `/api/inventories/${inv.id}/lines`, { lines: [{ productId: stranger, countedQty: 1 }] });
    expect(bad.statusCode).toBe(400);
    await call(env, w.keeperA.token)('POST', `/api/inventories/${inv.id}/cancel`);
    const closed = await call(env, w.keeperA.token)('PUT', `/api/inventories/${inv.id}/lines`, { lines: [{ productId: stranger, countedQty: 1 }] });
    expect(closed.statusCode).toBe(409);
  });

  it('точка вне доступа не видна', async () => {
    const res = await call(env, w.keeperA.token)('POST', '/api/inventories', { locationId: w.locB.id });
    expect(res.statusCode).toBe(404);
  });
});

describe('стоп-лист', () => {
  const stopList = (token: string, query = '') => call(env, token)('GET', `/api/stop-list${query}`);

  it('продукт попадает в стоп, когда закончился, и выходит после прихода', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Сливки' });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 2, expiresOn: w.day(4) }]);
    expect((await stopList(w.manager.token)).json().entries).toHaveLength(0);

    await sale(w.keeperA.token, w.locA.id, [{ productId: p, quantity: 2 }]);
    const stopped = (await stopList(w.manager.token)).json();
    expect(stopped.entries).toHaveLength(1);
    expect(stopped.entries[0]).toMatchObject({ name: 'Сливки', source: 'auto', locationId: w.locA.id });
    expect(stopped.entries[0].reasons[0].code).toBe('out_of_stock');
    const since = stopped.entries[0].since;

    env.clock.advance(1_800_000);
    expect((await stopList(w.manager.token)).json().entries[0].since).toBe(since);

    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 5, expiresOn: w.day(6) }]);
    expect((await stopList(w.manager.token)).json().entries).toHaveLength(0);
  });

  it('различает «закончился» и «весь остаток просрочен»', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Йогурт' });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 4, expiresOn: w.day(-1) }], { allowExpired: true });
    const entry = (await stopList(w.manager.token)).json().entries[0];
    expect(entry.reasons[0].code).toBe('all_expired');
  });

  it('блюдо уходит в стоп при нехватке ингредиента и предупреждает о малом остатке', async () => {
    const milk = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l', sellable: false });
    const eggs = await addProduct(env, w.categoryId, { name: 'Яйцо', unit: 'pcs', sellable: false });
    const dish = await addDish(env, 'Омлет', 220, [
      { productId: milk, quantity: 0.1 },
      { productId: eggs, quantity: 3 },
    ]);
    await receive(env, w.manager.token, w.kitchen.id, [
      { productId: milk, quantity: 5, expiresOn: w.day(3) },
      { productId: eggs, quantity: 7, expiresOn: w.day(10) },
    ]);
    const warn = (await stopList(w.manager.token)).json();
    expect(warn.entries).toHaveLength(0);
    expect(warn.warnings).toEqual([expect.objectContaining({ dishId: dish, portions: 2 })]);

    await sale(w.manager.token, w.kitchen.id, [{ dishId: dish, quantity: 2 }]);
    const stopped = (await stopList(w.manager.token)).json();
    const entry = stopped.entries.find((e: { entityId: string }) => e.entityId === dish);
    expect(entry.reasons[0].code).toBe('missing_ingredients');
    expect(entry.reasons[0].missing[0]).toMatchObject({ name: 'Яйцо', required: 3, available: 1 });
  });

  it('ручной стоп: ставит и снимает менеджер, кладовщик не может', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Масло' });
    const body = { locationId: w.locA.id, productId: p, reason: 'Проверка качества партии' };
    expect((await call(env, w.keeperA.token)('POST', '/api/stop-list/manual', body)).statusCode).toBe(403);
    const added = await call(env, w.manager.token)('POST', '/api/stop-list/manual', body);
    expect(added.statusCode).toBe(201);
    expect((await call(env, w.manager.token)('POST', '/api/stop-list/manual', body)).statusCode).toBe(409);

    const list = (await stopList(w.manager.token)).json();
    expect(list.entries[0]).toMatchObject({ source: 'manual', manualId: added.json().id, name: 'Масло' });
    expect(list.entries[0].reasons[0].text).toBe('Проверка качества партии');

    const released = await call(env, w.manager.token)('DELETE', `/api/stop-list/manual/${added.json().id}`);
    expect(released.statusCode).toBe(204);
    expect((await stopList(w.manager.token)).json().entries).toHaveLength(0);
  });

  it('ручной стоп с истёкшим сроком больше не действует', async () => {
    const p = await addProduct(env, w.categoryId);
    const until = new Date(env.clock.now.getTime() + 600_000).toISOString();
    await call(env, w.manager.token)('POST', '/api/stop-list/manual', { locationId: w.locA.id, productId: p, reason: 'До вечера', until });
    expect((await stopList(w.manager.token)).json().entries).toHaveLength(1);
    env.clock.advance(1_200_000);
    expect((await stopList(w.manager.token)).json().entries).toHaveLength(0);
    const past = await call(env, w.manager.token)('POST', '/api/stop-list/manual', {
      locationId: w.locA.id,
      productId: p,
      reason: 'Уже прошло',
      until: new Date(env.clock.now.getTime() - 1000).toISOString(),
    });
    expect(past.statusCode).toBe(400);
  });

  it('наблюдатель видит только свою точку, чужую просить нельзя', async () => {
    const p = await addProduct(env, w.categoryId);
    await receive(env, w.manager.token, w.locB.id, [{ productId: p, quantity: 1, expiresOn: w.day(3) }]);
    await sale(w.manager.token, w.locB.id, [{ productId: p, quantity: 1 }]);
    expect((await stopList(w.manager.token)).json().entries).toHaveLength(1);
    expect((await stopList(w.viewerA.token)).json().entries).toHaveLength(0);
    expect((await stopList(w.viewerA.token, `?locationId=${w.locB.id}`)).statusCode).toBe(404);
  });

  it('шлёт уведомление о новом стопе, но молчит о том, что было до первого прохода', async () => {
    const old = await addProduct(env, w.categoryId, { name: 'Давно закончился' });
    await receive(env, w.manager.token, w.locA.id, [{ productId: old, quantity: 1, expiresOn: w.day(5) }]);
    const fresh = await addProduct(env, w.categoryId, { name: 'Только что закончился' });
    await receive(env, w.manager.token, w.locA.id, [{ productId: fresh, quantity: 1, expiresOn: w.day(5) }]);
    // фоновый пересчёт после приходов должен закончиться до того, как таблицы чистятся в обход приложения
    await env.settle();
    await env.owner.deleteFrom('notification_log').execute();
    await env.owner.deleteFrom('stop_list_state').execute();
    // продажа без стоп-листа до первого прохода: имитируем систему, которую только запустили
    await env.owner.updateTable('batches').set({ remaining_qty: '0' }).where('product_id', '=', old).execute();
    await env.settle();
    env.forget();
    await schedulerTick({ db: env.db, config: env.config, clock: () => env.clock.now, notifier: env.notifier, log: console });
    expect(env.notifier.messages).toHaveLength(0);

    await sale(w.keeperA.token, w.locA.id, [{ productId: fresh, quantity: 1 }]);
    await env.settle();
    expect(env.notifier.messages).toHaveLength(1);
    expect(env.notifier.messages[0]).toContain('Только что закончился');
    expect(env.notifier.messages[0]).not.toContain('Давно');
  });
});
