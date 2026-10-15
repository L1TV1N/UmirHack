import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDish, addProduct, assertLedgerConsistent, createWorld, receive, seedSales, type World } from './fixtures';
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

describe('горячие блюда', () => {
  const hot = async (token: string, query = '') => (await call(env, token)('GET', `/api/analytics/hot-dishes${query}`)).json();

  it('ставит выше блюдо, у которого ингредиент скоро истекает, и объясняет причину', async () => {
    const milk = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l', sellable: false, cost: 60 });
    const kefir = await addProduct(env, w.categoryId, { name: 'Кефир', unit: 'l', sellable: false, cost: 60 });
    const soon = await addDish(env, 'Каша манная', 160, [{ productId: milk, quantity: 0.2 }]);
    await addDish(env, 'Оладьи', 190, [{ productId: kefir, quantity: 0.2 }]);
    await seedSales(env, { productId: milk, locationId: w.kitchen.id, days: 25, perDay: 2 });
    await seedSales(env, { productId: kefir, locationId: w.kitchen.id, days: 25, perDay: 2 });
    await receive(env, w.manager.token, w.kitchen.id, [{ productId: milk, quantity: 12, expiresOn: w.day(1) }]);
    await receive(env, w.manager.token, w.kitchen.id, [{ productId: kefir, quantity: 12, expiresOn: w.day(6) }]);

    const res = await hot(w.manager.token);
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items[0]).toMatchObject({ dishId: soon, dishName: 'Каша манная', daysLeft: 1, portions: 60 });
    expect(res.items[0].reasons[0]).toMatchObject({ productName: 'Молоко', daysLeft: 1 });
    expect(res.items[0].details).toMatch(/Молоко: истекает завтра/);
    const later = res.items.find((d: { dishName: string }) => d.dishName === 'Оладьи');
    if (later) expect(later.priority).toBeLessThan(res.items[0].priority);
  });

  it('обновляется после расхода: когда ингредиента не осталось, блюдо уходит из списка', async () => {
    const milk = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l', sellable: false, cost: 60 });
    await addDish(env, 'Каша манная', 160, [{ productId: milk, quantity: 0.2 }]);
    await seedSales(env, { productId: milk, locationId: w.kitchen.id, days: 25, perDay: 2 });
    await receive(env, w.manager.token, w.kitchen.id, [{ productId: milk, quantity: 12, expiresOn: w.day(1) }]);
    expect((await hot(w.manager.token)).items).toHaveLength(1);

    const done = await call(env, w.manager.token)('POST', '/api/documents/writeoffs', {
      locationId: w.kitchen.id,
      reason: 'other',
      lines: [{ productId: milk, quantity: 12 }],
    });
    expect(done.statusCode).toBe(201);
    expect((await hot(w.manager.token)).items).toHaveLength(0);
  });

  it('не предлагает блюдо, снятое с продажи вручную', async () => {
    const milk = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l', sellable: false, cost: 60 });
    const dish = await addDish(env, 'Каша манная', 160, [{ productId: milk, quantity: 0.2 }]);
    await receive(env, w.manager.token, w.kitchen.id, [{ productId: milk, quantity: 12, expiresOn: w.day(1) }]);
    expect((await hot(w.manager.token)).items).toHaveLength(1);

    const stop = await call(env, w.manager.token)('POST', '/api/stop-list/manual', { locationId: w.kitchen.id, dishId: dish, reason: 'Нет повара' });
    expect(stop.statusCode).toBe(201);
    expect((await hot(w.manager.token)).items).toHaveLength(0);
  });

  it('маржа и время суток двигают приоритет, но в пределах разумного', async () => {
    const milk = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l', sellable: false, cost: 60 });
    const beef = await addProduct(env, w.categoryId, { name: 'Говядина', unit: 'kg', sellable: false, cost: 60 });
    const morning = await addDish(env, 'Каша манная', 160, [{ productId: milk, quantity: 0.2 }]);
    const evening = await addDish(env, 'Стейк', 160, [{ productId: beef, quantity: 0.2 }]);
    // часы бизнеса: Москва, в тесте сейчас 12:00. Утреннее блюдо продавали в 8, вечернее в 19
    await seedSales(env, { productId: milk, locationId: w.kitchen.id, days: 25, perDay: 0.2, dishId: morning, hourUtc: 5 });
    await seedSales(env, { productId: beef, locationId: w.kitchen.id, days: 25, perDay: 0.2, dishId: evening, hourUtc: 16 });
    await receive(env, w.manager.token, w.kitchen.id, [{ productId: milk, quantity: 12, expiresOn: w.day(1) }]);
    await receive(env, w.manager.token, w.kitchen.id, [{ productId: beef, quantity: 12, expiresOn: w.day(1) }]);

    const res = await hot(w.manager.token);
    const a = res.items.find((d: { dishName: string }) => d.dishName === 'Каша манная');
    const b = res.items.find((d: { dishName: string }) => d.dishName === 'Стейк');
    expect(a.timeFit).toBe(0);
    expect(b.timeFit).toBe(1);
    expect(a.factors.time).toBeLessThan(1);
    expect(b.factors.time).toBe(1);
    expect(b.priority).toBeGreaterThan(a.priority);
    expect(a.details).toMatch(/обычно заказывают раньше/);
    expect(b.margin).toMatchObject({ perPortion: 148, cost: 12 });
    expect(b.margin.rate).toBeCloseTo(0.925, 3);

    // в семь утра продажи каши ещё впереди, штрафа нет
    env.clock.advance(-5 * 3600_000);
    const early = await hot(w.manager.token);
    const a2 = early.items.find((d: { dishName: string }) => d.dishName === 'Каша манная');
    expect(a2.timeFit).toBe(1);
    expect(a2.factors.time).toBe(1);
  });

  it('кладовщик не видит чужую кухню, а панель отдаёт первые блюда', async () => {
    const milk = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l', sellable: false, cost: 60 });
    await addDish(env, 'Каша манная', 160, [{ productId: milk, quantity: 0.2 }]);
    await receive(env, w.manager.token, w.kitchen.id, [{ productId: milk, quantity: 12, expiresOn: w.day(1) }]);

    expect((await hot(w.keeperA.token)).items).toHaveLength(0);
    expect((await call(env, w.keeperA.token)('GET', `/api/analytics/hot-dishes?locationId=${w.kitchen.id}`)).statusCode).toBe(404);
    expect((await call(env, w.manager.token)('GET', '/api/analytics/dashboard')).json().hotDishes[0]).toMatchObject({ dishName: 'Каша манная' });
  });
});

/** Токен менеджера на текущий момент часов теста: токены живут час, а тесты ниже переводят время на дни. */
async function managerNow(): Promise<string> {
  return (await loginAs(env, await createUser(env, { role: 'manager' }))).token;
}

describe('спасено уценкой', () => {
  const rescued = async (token: string, query = '') => (await call(env, token)('GET', `/api/analytics/rescued${query}`)).json();
  const buy = (productId: string, quantity: number) => call(env, w.keeperA.token)('POST', '/api/documents/sales', { locationId: w.locA.id, lines: [{ productId, quantity }] });

  it('считает выручку с товара, проданного по скидке, и не считает продажи без неё', async () => {
    const milk = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l', price: 100, cost: 60 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: milk, quantity: 20, expiresOn: w.day(2), unitCost: 60 }]);
    expect((await buy(milk, 2)).statusCode).toBe(201);
    expect((await rescued(w.manager.token)).batches).toBe(0);
    env.clock.advance(1000);

    const batch = (await env.owner.selectFrom('batches').select('id').executeTakeFirstOrThrow()).id;
    expect((await call(env, w.manager.token)('POST', '/api/promotions', { batchId: batch, percent: 30 })).statusCode).toBe(201);
    env.clock.advance(1000);
    expect((await buy(milk, 5)).statusCode).toBe(201);

    const r = await rescued(w.manager.token);
    // 5 л по 70 рублей, себестоимость 300, скидка стоила 150
    expect(r).toMatchObject({ days: 30, batches: 1, revenue: 350, cost: 300, discountGiven: 150 });
    expect(r.products[0]).toMatchObject({ productName: 'Молоко', quantity: 5, revenue: 350 });
  });

  it('выгрузка в CSV: строка по продукту, итог, права и запись в журнал', async () => {
    const milk = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l', price: 100, cost: 60 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: milk, quantity: 20, expiresOn: w.day(2), unitCost: 60 }]);
    const batch = (await env.owner.selectFrom('batches').select('id').executeTakeFirstOrThrow()).id;
    await call(env, w.manager.token)('POST', '/api/promotions', { batchId: batch, percent: 30 });
    await buy(milk, 5);

    const res = await call(env, w.manager.token)('GET', '/api/reports/rescued.csv?days=30');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(String(res.headers['content-disposition'])).toMatch(/rescued-30d-\d{4}-\d{2}-\d{2}\.csv/);
    const lines = res.body.replace('\uFEFF', '').trim().split('\r\n');
    expect(lines[0]).toBe('Продукт;Ед.;Продано по скидке;Выручка;Себестоимость;Выручка минус себестоимость');
    expect(lines[1]).toBe('Молоко;л;5;350;300;50');
    expect(lines[2]).toBe('Итого;;;350;300;50');

    expect((await call(env, w.keeperA.token)('GET', '/api/reports/rescued.csv')).statusCode).toBe(403);
    expect((await call(env, w.viewerA.token)('GET', '/api/reports/rescued.csv')).statusCode).toBe(403);
    expect((await call(env, null)('GET', '/api/reports/rescued.csv')).statusCode).toBe(401);
    expect((await call(env, w.manager.token)('GET', '/api/reports/rescued.csv?days=0')).statusCode).toBe(400);
    const audit = await env.owner.selectFrom('audit_log').select(['entity_id', 'details']).where('action', '=', 'report.export').execute();
    expect(audit.some((r) => r.entity_id === 'rescued')).toBe(true);
  });

  it('после отмены скидки продажи по обычной цене в отчёт не попадают', async () => {
    const milk = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l', price: 100, cost: 60 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: milk, quantity: 20, expiresOn: w.day(2), unitCost: 60 }]);
    const batch = (await env.owner.selectFrom('batches').select('id').executeTakeFirstOrThrow()).id;
    const promo = await call(env, w.manager.token)('POST', '/api/promotions', { batchId: batch, percent: 30 });
    await buy(milk, 3);
    env.clock.advance(60_000);
    await call(env, w.manager.token)('DELETE', `/api/promotions/${promo.json().id}`);
    env.clock.advance(60_000);
    await buy(milk, 4);
    expect(await rescued(w.manager.token)).toMatchObject({ revenue: 210, discountGiven: 90 });
  });

  it('блюда и чужие точки не учитываются, период ограничивает выборку', async () => {
    const milk = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l', price: 100, cost: 60 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: milk, quantity: 20, expiresOn: w.day(2), unitCost: 60 }]);
    const batch = (await env.owner.selectFrom('batches').select('id').executeTakeFirstOrThrow()).id;
    await call(env, w.manager.token)('POST', '/api/promotions', { batchId: batch, percent: 30 });
    await buy(milk, 5);

    expect((await rescued(w.manager.token, `?locationId=${w.locB.id}`)).batches).toBe(0);
    expect((await rescued(w.keeperA.token)).batches).toBe(1);
    expect((await rescued(w.viewerA.token)).batches).toBe(1);
    expect((await call(env, w.keeperA.token)('GET', `/api/analytics/rescued?locationId=${w.locB.id}`)).statusCode).toBe(404);

    env.clock.advance(40 * 86_400_000);
    const later = await managerNow();
    expect((await rescued(later, '?days=30')).batches).toBe(0);
    expect((await rescued(later, '?days=90')).batches).toBe(1);
  });
});

describe('дефицитные ингредиенты', () => {
  const stats = async (token: string, query = '') => (await call(env, token)('GET', `/api/analytics/shortages${query}`)).json();
  const order = (dishId: string, quantity: number) => call(env, w.manager.token)('POST', '/api/documents/sales', { locationId: w.kitchen.id, lines: [{ dishId, quantity }] });

  it('нехватка открывает эпизод, поставка закрывает его, часы считаются по времени', async () => {
    const milk = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l', sellable: false });
    await addDish(env, 'Каша манная', 160, [{ productId: milk, quantity: 0.5 }]);
    // 0,3 л меньше порции: блюдо в стопе, молоко в дефиците
    await receive(env, w.manager.token, w.kitchen.id, [{ productId: milk, quantity: 0.3, expiresOn: w.day(30) }]);
    await env.settle();
    const during = await stats(w.manager.token);
    expect(during.ingredients[0]).toMatchObject({ productName: 'Молоко', episodes: 1, ongoing: true, dishesBlocked: 1 });

    env.clock.advance(5 * 3_600_000);
    const later = await managerNow();
    await receive(env, later, w.kitchen.id, [{ productId: milk, quantity: 10, expiresOn: w.day(30) }]);
    await env.settle();
    const after = await stats(later);
    expect(after.ingredients[0]).toMatchObject({ productName: 'Молоко', episodes: 1, ongoing: false });
    expect(after.ingredients[0].hours).toBeCloseTo(5, 0);
    expect(after.totals).toMatchObject({ episodes: 1, refusedOrders: 0 });
  });

  it('отклонённый заказ запоминается с упущенной выручкой и называет недостающий продукт', async () => {
    const milk = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l', sellable: false });
    const dish = await addDish(env, 'Каша манная', 160, [{ productId: milk, quantity: 0.5 }]);
    await receive(env, w.manager.token, w.kitchen.id, [{ productId: milk, quantity: 1, expiresOn: w.day(30) }]);

    const refused = await order(dish, 5);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe('insufficient_stock');
    expect((await order(dish, 1)).statusCode).toBe(201);

    const s = await stats(w.manager.token);
    expect(s.totals).toMatchObject({ refusedOrders: 1, lostRevenue: 800 });
    expect(s.ingredients[0]).toMatchObject({ productName: 'Молоко', refusedOrders: 1, lostRevenue: 800 });
  });

  it('выгрузка в CSV: ингредиент, итог и права', async () => {
    const milk = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l', sellable: false });
    const dish = await addDish(env, 'Каша манная', 160, [{ productId: milk, quantity: 0.5 }]);
    await receive(env, w.manager.token, w.kitchen.id, [{ productId: milk, quantity: 1, expiresOn: w.day(30) }]);
    await order(dish, 5);

    const res = await call(env, w.manager.token)('GET', '/api/reports/shortages.csv');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.body.replace('\uFEFF', '').trim().split('\r\n');
    expect(lines[0]).toBe('Продукт;Ед.;Нехваток;Часов без остатка;Блюд остановлено (максимум);Отклонено заказов;Потеряно выручки;Нехватка сейчас');
    expect(lines[1]).toMatch(/^Молоко;л;\d+;[\d,]+;\d+;1;800;(да|нет)$/);
    expect(lines.at(-1)).toMatch(/^Итого;;\d+;[\d,]+;;1;800;$/);
    expect((await call(env, w.keeperA.token)('GET', '/api/reports/shortages.csv')).statusCode).toBe(403);
    expect((await call(env, null)('GET', '/api/reports/shortages.csv')).statusCode).toBe(401);
    expect((await call(env, w.manager.token)('GET', '/api/reports/shortages.csv?days=100')).statusCode).toBe(400);
  });

  it('учитывает период и точку, кладовщик не видит чужую кухню', async () => {
    const milk = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l', sellable: false });
    const dish = await addDish(env, 'Каша манная', 160, [{ productId: milk, quantity: 0.5 }]);
    await receive(env, w.manager.token, w.kitchen.id, [{ productId: milk, quantity: 1, expiresOn: w.day(60) }]);
    await order(dish, 5);
    expect((await stats(w.manager.token, '?days=7')).totals.refusedOrders).toBe(1);

    expect((await stats(w.manager.token, `?locationId=${w.locA.id}`)).totals.refusedOrders).toBe(0);
    expect((await stats(w.keeperA.token)).ingredients).toEqual([]);
    expect((await call(env, w.keeperA.token)('GET', `/api/analytics/shortages?locationId=${w.kitchen.id}`)).statusCode).toBe(404);
    expect((await call(env, w.manager.token)('GET', '/api/analytics/shortages?days=0')).statusCode).toBe(400);

    env.clock.advance(10 * 86_400_000);
    const later = await managerNow();
    expect((await stats(later, '?days=7')).totals.refusedOrders).toBe(0);
    expect((await stats(later, '?days=30')).totals.refusedOrders).toBe(1);
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
