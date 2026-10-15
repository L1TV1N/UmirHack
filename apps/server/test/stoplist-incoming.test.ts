import type { StopForecastCoveredDto, StopForecastDto, StopListDto } from '@zapas/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDish, addProduct, createWorld, receive, seedSales, type World } from './fixtures';
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
  known = null;
});

const manager = () => call(env, w.manager.token);

let known: { id: string } | null = null;
async function supplier() {
  if (known) return known;
  const res = await manager()('POST', '/api/suppliers', { name: 'Молочный комбинат', email: 'zakaz@donskoy.ru', leadTimeDays: 1, minOrderSum: 0 });
  expect(res.statusCode, res.body).toBe(201);
  known = res.json() as { id: string };
  return known;
}

/** Отправленный заказ на кухню с желаемой датой поставки. */
async function sentOrder(productId: string, quantity: number, expectedOn: string | undefined, extra: Record<string, unknown> = {}) {
  const s = await supplier();
  const created = await manager()('POST', '/api/orders', { supplierId: s.id, locationId: w.kitchen.id, ...(expectedOn ? { expectedOn } : {}), lines: [{ productId, quantity, unitCost: 60 }], ...extra });
  expect(created.statusCode, created.body).toBe(201);
  const sent = await manager()('POST', `/api/orders/${created.json().id}/send`);
  expect(sent.statusCode, sent.body).toBe(200);
  return sent.json() as { id: string; number: string };
}

const forecast = async () => (await manager()('GET', '/api/stop-list/forecast')).json() as StopForecastDto[];
const covered = async () => (await manager()('GET', '/api/stop-list/covered')).json() as StopForecastCoveredDto[];
const stopList = async () => (await manager()('GET', '/api/stop-list')).json() as StopListDto;

/** Кухня: молоко уходит по 4 л в сутки, остаток 3 л, на порцию каши 0,5 л. */
async function scene() {
  const milk = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l', sellable: false });
  await addDish(env, 'Каша манная', 160, [{ productId: milk, quantity: 0.5 }]);
  await seedSales(env, { productId: milk, locationId: w.kitchen.id, days: 25, perDay: 4 });
  await receive(env, w.manager.token, w.kitchen.id, [{ productId: milk, quantity: 3, expiresOn: w.day(30) }]);
  env.forget();
  return milk;
}

describe('поставки в пути в прогнозе стоп-листа', () => {
  it('без заказов прогноз прежний: блюдо остановится через полдня', async () => {
    await scene();
    const list = await forecast();
    expect(list).toHaveLength(1);
    expect(list[0]?.incoming).toBeNull();
    expect(await covered()).toEqual([]);
  });

  it('отправленный заказ с поставкой на сегодня успевает: предупреждения нет, блюдо в списке «выручит поставка»', async () => {
    const milk = await scene();
    const order = await sentOrder(milk, 40, w.day(0));
    expect(await forecast()).toEqual([]);
    const list = await covered();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ dishName: 'Каша манная' });
    expect(list[0]?.incoming).toMatchObject({ orderNumber: order.number, productName: 'Молоко', quantity: 40, arrivesOn: w.day(0) });
    expect(list[0]?.hoursWithoutDelivery).toBeGreaterThanOrEqual(13);
  });

  it('поставка завтра не успевает: блюдо встанет раньше, предупреждение остаётся и называет заказ', async () => {
    const milk = await scene();
    const order = await sentOrder(milk, 40, w.day(1));
    const list = await forecast();
    expect(list).toHaveLength(1);
    expect(list[0]?.incoming).toMatchObject({ orderNumber: order.number, afterStop: true, arrivesOn: w.day(1) });
    expect(await covered()).toEqual([]);
  });

  it('обещанная поставщиком дата важнее желаемой: поставщик сдвинул поставку на неделю, и предупреждение вернулось', async () => {
    const milk = await scene();
    const order = await sentOrder(milk, 40, w.day(0));
    expect(await forecast()).toEqual([]);
    await env.owner.updateTable('purchase_orders').set({ delivery_on: w.day(8) }).where('id', '=', order.id).execute();
    env.forget();
    const list = await forecast();
    expect(list).toHaveLength(1);
    expect(list[0]?.incoming).toMatchObject({ arrivesOn: w.day(8), afterStop: true });
    expect(await covered()).toEqual([]);
  });

  it('черновик поставку не обещает, отправка обещает, отмена снимает обещание', async () => {
    const milk = await scene();
    const s = await supplier();
    const draft = await manager()('POST', '/api/orders', { supplierId: s.id, locationId: w.kitchen.id, expectedOn: w.day(0), lines: [{ productId: milk, quantity: 40, unitCost: 60 }] });
    expect(draft.statusCode).toBe(201);
    expect(await forecast()).toHaveLength(1);

    expect((await manager()('POST', `/api/orders/${draft.json().id}/send`)).statusCode).toBe(200);
    expect(await forecast()).toEqual([]);
    expect((await manager()('POST', `/api/orders/${draft.json().id}/cancel`)).statusCode).toBe(200);
    expect(await forecast()).toHaveLength(1);
  });

  it('заказ без даты поставки в расчёт не берётся', async () => {
    const milk = await scene();
    await sentOrder(milk, 40, undefined);
    const list = await forecast();
    expect(list).toHaveLength(1);
    expect(list[0]?.incoming).toBeNull();
  });

  it('принятая поставка перестаёт быть «в пути»: после прихода остаток считается обычным', async () => {
    const milk = await scene();
    const order = await sentOrder(milk, 40, w.day(0));
    expect(await forecast()).toEqual([]);
    const receipt = await manager()('POST', '/api/documents/receipts', { locationId: w.kitchen.id, orderId: order.id, lines: [{ productId: milk, quantity: 40, unitCost: 60, expiresOn: w.day(10) }] });
    expect(receipt.statusCode, receipt.body).toBe(201);
    expect(await covered()).toEqual([]);
    expect((await manager()('GET', '/api/orders/' + order.id)).json().status).toBe('received');
  });

  it('другая точка и чужие права: кладовщик не видит кухню, а чужая организация не видит поставки', async () => {
    const milk = await scene();
    await sentOrder(milk, 40, w.day(1));
    const keeper = call(env, w.keeperA.token);
    expect((await keeper('GET', '/api/stop-list/covered')).json()).toEqual([]);
    expect((await keeper('GET', `/api/stop-list/covered?locationId=${w.kitchen.id}`)).statusCode).toBe(404);

    const other = await env.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { organizationName: 'ООО «Соседи»', fullName: 'Орлова Наталья Сергеевна', email: 'neighbour@example.ru', password: 'Хорошая-длинная-фраза-91' },
    });
    const asOther = call(env, other.json().accessToken);
    expect((await asOther('GET', '/api/stop-list/covered')).json()).toEqual([]);
  });
});

describe('поставки в пути рядом с текущим стопом', () => {
  it('позиция в стопе помечена едущей поставкой, а блюдо называет недостающий продукт', async () => {
    const milk = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l', sellable: false });
    const dish = await addDish(env, 'Каша манная', 160, [{ productId: milk, quantity: 0.5 }]);
    // молоко приходило и закончилось: блюдо в стопе
    await receive(env, w.manager.token, w.kitchen.id, [{ productId: milk, quantity: 0.3, expiresOn: w.day(30) }]);
    const order = await sentOrder(milk, 20, w.day(1));
    env.forget();

    const entries = (await stopList()).entries;
    const entry = entries.find((e) => e.entityId === dish);
    expect(entry).toBeDefined();
    expect(entry?.incoming).toHaveLength(1);
    expect(entry?.incoming?.[0]).toMatchObject({ orderNumber: order.number, productName: 'Молоко', quantity: 20, arrivesOn: w.day(1) });
  });

  it('опоздавшая поставка (дата уже прошла) не обещается', async () => {
    const milk = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l', sellable: false });
    const dish = await addDish(env, 'Каша манная', 160, [{ productId: milk, quantity: 0.5 }]);
    await receive(env, w.manager.token, w.kitchen.id, [{ productId: milk, quantity: 0.3, expiresOn: w.day(30) }]);
    const order = await sentOrder(milk, 20, w.day(1));
    await env.owner.updateTable('purchase_orders').set({ expected_on: w.day(-2) }).where('id', '=', order.id).execute();
    env.forget();
    const entry = (await stopList()).entries.find((e) => e.entityId === dish);
    expect(entry?.incoming).toBeUndefined();
  });
});

describe('поставки в пути у официанта и в боте', () => {
  async function stoppedDish() {
    const milk = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l', sellable: false });
    const dish = await addDish(env, 'Каша манная', 160, [{ productId: milk, quantity: 0.5 }]);
    await receive(env, w.manager.token, w.kitchen.id, [{ productId: milk, quantity: 0.3, expiresOn: w.day(30) }]);
    return { milk, dish };
  }

  it('официанту в причине стопа написано, когда привезут', async () => {
    const { milk } = await stoppedDish();
    await sentOrder(milk, 20, w.day(1));
    env.forget();
    const waiter = call(env, w.waiterA.token);
    const list = (await waiter('GET', `/api/waiter/stop-list?locationId=${w.kitchen.id}`)).json() as { note: string }[];
    expect(list.some((e) => e.note.includes('Не хватает: Молоко') && e.note.includes('Поставка 09.10.2026'))).toBe(true);
    const menu = (await waiter('GET', `/api/waiter/menu?locationId=${w.kitchen.id}`)).json() as { name: string; stopped: boolean; stopNote: string }[];
    expect(menu.find((d) => d.name === 'Каша манная')?.stopNote).toContain('Поставка 09.10.2026');
  });

  it('без заказа причина прежняя, без даты поставки', async () => {
    await stoppedDish();
    const waiter = call(env, w.waiterA.token);
    const list = (await waiter('GET', `/api/waiter/stop-list?locationId=${w.kitchen.id}`)).json() as { note: string }[];
    expect(list.some((e) => e.note === 'Не хватает: Молоко')).toBe(true);
  });

  it('бот в /stoplist пишет, что поставка уже едет', async () => {
    const { milk } = await stoppedDish();
    await sentOrder(milk, 20, w.day(1));
    env.forget();
    await env.db.insertInto('telegram_links').values({ user_id: w.manager.userId, chat_id: 4242, username: null, linked_at: env.clock.now }).execute();
    const reply = await env.chat(4242, '/stoplist');
    expect(reply).toContain('Каша манная');
    expect(reply).toContain('Едет поставка 09.10.2026');
  });
});
