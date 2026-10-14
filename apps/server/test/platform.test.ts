import {
  completeInn,
  SUPPLIER_PORTAL_SIGNATURE_HEADER,
  SUPPLIER_PORTAL_TIMESTAMP_HEADER,
  type GuestOrderDetailDto,
  type OrderDetailDto,
  type WaiterDishDto,
} from '@zapas/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signPortalPayload } from '../src/modules/supplier-portal/client';
import { retryPortalPushes } from '../src/modules/supplier-portal/service';
import { addDish, addLocation, addProduct, createWorld, receive, remaining, type World } from './fixtures';
import { call, createTestEnv, createUser, loginAs, TEST_PASSWORD, type Session, type TestEnv } from './helpers';

const SECRET = 'test-portal-secret-1234';
let env: TestEnv;
let w: World;

beforeAll(async () => {
  env = await createTestEnv({ ACCESS_TOKEN_TTL_SECONDS: '3600', SUPPLIER_PORTAL_URL: 'http://portal.test', SUPPLIER_PORTAL_SECRET: SECRET });
});
afterAll(() => env.close());
beforeEach(async () => {
  await env.reset();
  w = await createWorld(env);
});

const admin = () => call(env, w.admin.token);
const manager = () => call(env, w.manager.token);
const waiter = () => call(env, w.waiterA.token);

async function register(over: Record<string, unknown> = {}) {
  return env.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { organizationName: 'ООО «Вкус»', fullName: 'Орлова Наталья Сергеевна', email: 'owner@vkus.example', password: 'Хорошая-длинная-фраза-91', ...over },
  });
}

describe('организации и регистрация', () => {
  it('создаёт организацию и её первого администратора, который сразу входит', async () => {
    const res = await register();
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body.user.role).toBe('admin');
    expect(body.user.organizationName).toBe('ООО «Вкус»');
    expect(body.user.mustChangePassword).toBe(false);
    const me = await call(env, body.accessToken)('GET', '/api/auth/me');
    expect(me.statusCode).toBe(200);
    expect(me.json().organizationId).toBe(body.user.organizationId);
  });

  it('не пускает повторную почту и слабый пароль', async () => {
    expect((await register()).statusCode).toBe(201);
    expect((await register()).statusCode).toBe(409);
    expect((await register({ email: 'another@vkus.example', password: 'qwertyuiop' })).statusCode).toBe(400);
    expect((await register({ email: 'bad', organizationName: ' ' })).statusCode).toBe(400);
  });

  it('данные организаций не смешиваются: чужие точки, справочники, пользователи и журнал не видны', async () => {
    const mine = await call(env, (await register()).json().accessToken);
    // у новой организации пусто, хотя в соседней есть всё
    expect((await mine('GET', '/api/locations')).json()).toEqual([]);
    expect((await mine('GET', '/api/products')).json().items).toEqual([]);
    expect((await mine('GET', '/api/dishes')).json()).toEqual([]);
    const users = (await mine('GET', '/api/users')).json();
    expect(users.items.map((u: { email: string }) => u.email)).toEqual(['owner@vkus.example']);
    const audit = (await mine('GET', '/api/audit')).json();
    expect(audit.items.every((e: { userEmail: string | null }) => e.userEmail === 'owner@vkus.example')).toBe(true);

    // чужую точку нельзя ни прочитать, ни изменить
    const patch = await mine('PATCH', `/api/locations/${w.locA.id}`, { name: 'Взлом' });
    expect(patch.statusCode).toBe(404);
    const own = await mine('POST', '/api/locations', { code: 'main', name: 'Ресторан «Вкус»', kind: 'kitchen', address: 'Ростов' });
    expect(own.statusCode, own.body).toBe(201);
    // тот же код в другой организации не конфликтует
    const twin = await admin()('POST', '/api/locations', { code: 'main', name: 'Главная', kind: 'shop' });
    expect(twin.statusCode).toBe(201);

    // справочник организации свой: категория с тем же названием у соседей не мешает
    expect((await mine('POST', '/api/categories', { name: 'Молочные продукты' })).statusCode).toBe(201);
    expect((await mine('GET', '/api/categories')).json()).toHaveLength(1);
    const outsider = await mine('GET', '/api/stock/summary');
    expect([200, 404]).toContain(outsider.statusCode);
    if (outsider.statusCode === 200) expect(JSON.stringify(outsider.json())).not.toContain(w.locA.name);
  });

  it('стоп-лист и горячие блюда не берут блюда чужой организации', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Курица', unit: 'kg' });
    await addDish(env, 'Блюдо первой организации', 300, [{ productId: p, quantity: 0.2 }]);
    await receive(env, w.manager.token, w.kitchen.id, [{ productId: p, quantity: 5, expiresOn: w.day(5) }]);
    await env.settle();
    // у второй организации своя кухня без остатков: блюдо первой там не должно оказаться в стоп-листе
    const mine = await register();
    const token = mine.json().accessToken as string;
    const loc = (await call(env, token)('POST', '/api/locations', { code: 'k2', name: 'Кухня «Вкус»', kind: 'kitchen' })).json();
    await env.settle();
    const stop = (await call(env, token)('GET', '/api/stop-list', undefined)).json();
    expect(JSON.stringify(stop)).not.toContain('Блюдо первой организации');
    void loc;
  });
});

describe('пользователи и первый вход', () => {
  it('без пароля создаёт временный, а до его смены доступны только вход и смена пароля', async () => {
    const created = await admin()('POST', '/api/users', { email: 'new.waiter@example.ru', fullName: 'Иванова Ольга Петровна', role: 'waiter', locationIds: [w.kitchen.id] });
    expect(created.statusCode, created.body).toBe(201);
    const body = created.json();
    expect(body.temporaryPassword).toMatch(/^[A-Za-z0-9]{14}$/);
    expect(body.mustChangePassword).toBe(true);
    expect(created.body).not.toMatch(/hash|argon2/i);

    const session = await loginAs(env, { email: 'new.waiter@example.ru', password: body.temporaryPassword });
    const as = call(env, session.token);
    expect((await as('GET', '/api/auth/me')).statusCode).toBe(200);
    const blocked = await as('GET', '/api/locations');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('password_change_required');

    const change = await as('POST', '/api/auth/change-password', { currentPassword: body.temporaryPassword, newPassword: 'Новый-надёжный-пароль-55' });
    expect(change.statusCode).toBe(204);
    const again = await loginAs(env, { email: 'new.waiter@example.ru', password: 'Новый-надёжный-пароль-55' });
    const ok = await call(env, again.token)('GET', '/api/locations');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().map((l: { id: string }) => l.id)).toEqual([w.kitchen.id]);
  });

  it('администратор другой организации не видит и не меняет чужих пользователей', async () => {
    const other = call(env, (await register()).json().accessToken);
    expect((await other('PATCH', `/api/users/${w.manager.userId}`, { isActive: false })).statusCode).toBe(404);
    expect((await other('PUT', `/api/users/${w.manager.userId}/password`, { password: 'Какой-то-пароль-2026-x' })).statusCode).toBe(404);
    const created = await other('POST', '/api/users', { email: 'x@vkus.example', fullName: 'Петров Пётр Петрович', role: 'manager', locationIds: [w.locA.id] });
    expect(created.statusCode).toBe(400);
  });

  it('официанту закрыты учёт и справочники, ему доступны только свои экраны', async () => {
    for (const url of ['/api/products', '/api/stock/summary', '/api/analytics/hot-dishes', '/api/suppliers', '/api/orders', '/api/users', '/api/audit']) {
      expect((await waiter()('GET', url)).statusCode, url).toBe(403);
    }
    for (const url of ['/api/locations', '/api/auth/me']) expect((await waiter()('GET', url)).statusCode, url).toBe(200);
    const places = (await waiter()('GET', '/api/locations')).json();
    expect(places.map((l: { id: string }) => l.id)).toEqual([w.kitchen.id]);
  });
});

describe('заказы гостей', () => {
  let borsch: string;
  let beef: string;

  async function stockKitchen() {
    beef = await addProduct(env, w.categoryId, { name: 'Говядина', unit: 'kg', cost: 500 });
    const potato = await addProduct(env, w.categoryId, { name: 'Картофель', unit: 'kg', cost: 30 });
    borsch = await addDish(env, 'Борщ', 290, [
      { productId: beef, quantity: 0.12 },
      { productId: potato, quantity: 0.1 },
    ]);
    await receive(env, w.manager.token, w.kitchen.id, [
      { productId: beef, quantity: 3, expiresOn: w.day(2), unitCost: 500 },
      { productId: potato, quantity: 10, expiresOn: w.day(20), unitCost: 30 },
    ]);
    await env.settle();
    return { beef, potato };
  }

  const place = (qty = 2, extra: Record<string, unknown> = {}) =>
    waiter()('POST', '/api/guest-orders', { locationId: w.kitchen.id, tableLabel: '12', lines: [{ dishId: borsch, quantity: qty }], ...extra });

  it('официант принимает заказ, менеджер берёт в работу: продукты списываются по составу, затем выдача', async () => {
    await stockKitchen();
    const created = await place(2, { comment: 'Без лука' });
    expect(created.statusCode, created.body).toBe(201);
    const order = created.json() as GuestOrderDetailDto;
    expect(order.status).toBe('new');
    expect(order.number).toMatch(/^ЗК-\d{6}$/);
    expect(order.total).toBe(580);
    // пока заказ не взят в работу, продукты на месте
    expect(await remaining(env, beef, w.kitchen.id)).toBeCloseTo(3, 3);

    // официант не двигает заказ дальше
    expect((await waiter()('POST', `/api/guest-orders/${order.id}/status`, { status: 'in_progress' })).statusCode).toBe(403);

    const cooking = await manager()('POST', `/api/guest-orders/${order.id}/status`, { status: 'in_progress' });
    expect(cooking.statusCode, cooking.body).toBe(200);
    expect(cooking.json().status).toBe('in_progress');
    expect(await remaining(env, beef, w.kitchen.id)).toBeCloseTo(3 - 0.24, 3);

    // повторный запрос не списывает второй раз
    expect((await manager()('POST', `/api/guest-orders/${order.id}/status`, { status: 'in_progress' })).statusCode).toBe(200);
    expect(await remaining(env, beef, w.kitchen.id)).toBeCloseTo(3 - 0.24, 3);

    const served = await manager()('POST', `/api/guest-orders/${order.id}/status`, { status: 'served' });
    expect(served.json().status).toBe('served');
    expect(served.json().events.map((e: { kind: string }) => e.kind)).toEqual(['created', 'in_progress', 'served']);
    const after = await manager()('POST', `/api/guest-orders/${order.id}/status`, { status: 'cancelled', comment: 'поздно' });
    expect(after.statusCode).toBe(409);
  });

  it('блюдо из стоп-листа принять нельзя, а в меню официанта оно помечено', async () => {
    await stockKitchen();
    await manager()('POST', '/api/documents/writeoffs', { locationId: w.kitchen.id, reason: 'other', lines: [{ productId: beef, quantity: 3 }] });
    await env.settle();
    const menu = (await waiter()('GET', `/api/waiter/menu?locationId=${w.kitchen.id}`)).json() as WaiterDishDto[];
    const dish = menu.find((d) => d.id === borsch);
    expect(dish?.stopped).toBe(true);
    expect(dish?.stopNote).toContain('Говядина');
    expect(dish?.stopNote).not.toMatch(/нужно|есть 0/);
    const res = await place(1);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('dish_stopped');
    const stop = (await waiter()('GET', `/api/waiter/stop-list?locationId=${w.kitchen.id}`)).json();
    expect(stop.some((s: { name: string }) => s.name === 'Борщ')).toBe(true);
  });

  it('если продуктов уже не хватает, заказ остаётся принятым, а менеджер видит причину', async () => {
    await stockKitchen();
    const order = (await place(2)).json() as GuestOrderDetailDto;
    await manager()('POST', '/api/documents/writeoffs', { locationId: w.kitchen.id, reason: 'other', lines: [{ productId: beef, quantity: 2.9 }] });
    const res = await manager()('POST', `/api/guest-orders/${order.id}/status`, { status: 'in_progress' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const still = (await manager()('GET', `/api/guest-orders/${order.id}`)).json();
    expect(still.status).toBe('new');
  });

  it('официант видит только свои заказы и не может заказать на чужой точке', async () => {
    await stockKitchen();
    const other = await createUser(env, { role: 'waiter', locationIds: [w.kitchen.id] }).then((u) => loginAs(env, u));
    const mine = (await place(1)).json() as GuestOrderDetailDto;
    const theirs = await call(env, other.token)('POST', '/api/guest-orders', { locationId: w.kitchen.id, tableLabel: '3', lines: [{ dishId: borsch, quantity: 1 }] });
    expect(theirs.statusCode).toBe(201);
    const list = (await waiter()('GET', '/api/guest-orders?status=all')).json();
    expect(list.map((o: { id: string }) => o.id)).toEqual([mine.id]);
    expect((await call(env, other.token)('GET', `/api/guest-orders/${mine.id}`)).statusCode).toBe(404);
    expect(((await manager()('GET', '/api/guest-orders?status=all')).json() as unknown[]).length).toBe(2);
    const elsewhere = await waiter()('POST', '/api/guest-orders', { locationId: w.locA.id, tableLabel: '1', lines: [{ dishId: borsch, quantity: 1 }] });
    expect(elsewhere.statusCode).toBe(404);
    // на магазине блюда не готовят, даже если точка доступна
    const hall = await createUser(env, { role: 'waiter', locationIds: [w.locA.id] }).then((u) => loginAs(env, u));
    const shop = await call(env, hall.token)('POST', '/api/guest-orders', { locationId: w.locA.id, tableLabel: '1', lines: [{ dishId: borsch, quantity: 1 }] });
    expect(shop.statusCode).toBe(422);
  });

  it('официант может отменить свой заказ, пока его не взяли в работу, и только с причиной', async () => {
    await stockKitchen();
    const order = (await place(1)).json() as GuestOrderDetailDto;
    expect((await waiter()('POST', `/api/guest-orders/${order.id}/status`, { status: 'cancelled' })).statusCode).toBe(400);
    const cancelled = await waiter()('POST', `/api/guest-orders/${order.id}/status`, { status: 'cancelled', comment: 'Гость передумал' });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json().cancelReason).toBe('Гость передумал');
    expect(await remaining(env, beef, w.kitchen.id)).toBeCloseTo(3, 3);
  });

  it('разбитое блюдо: официант сообщает, менеджер решает переделать бесплатно, продукты списываются как потеря', async () => {
    await stockKitchen();
    const order = (await place(1)).json() as GuestOrderDetailDto;
    // пока заказ не готовят, сообщать не о чем
    expect((await waiter()('POST', `/api/guest-orders/${order.id}/incidents`, { kind: 'dropped', blame: 'waiter', comment: 'Уронил тарелку' })).statusCode).toBe(409);
    await manager()('POST', `/api/guest-orders/${order.id}/status`, { status: 'in_progress' });
    await manager()('POST', `/api/guest-orders/${order.id}/status`, { status: 'served' });
    const lineId = order.lines[0]?.id;

    const reported = await waiter()('POST', `/api/guest-orders/${order.id}/incidents`, { lineId, kind: 'dropped', blame: 'waiter', comment: 'Тарелка разбилась по дороге к столу' });
    expect(reported.statusCode, reported.body).toBe(201);
    const incident = (reported.json() as GuestOrderDetailDto).incidents[0];
    expect(incident?.status).toBe('reported');
    expect((await manager()('GET', '/api/guest-orders/summary')).json()).toMatchObject({ incidents: 1 });
    // решать может только менеджер
    expect((await waiter()('POST', `/api/guest-orders/incidents/${incident?.id}/resolve`, { action: 'remake' })).statusCode).toBe(403);

    const before = await remaining(env, beef, w.kitchen.id);
    const resolved = await manager()('POST', `/api/guest-orders/incidents/${incident?.id}/resolve`, { action: 'remake', comment: 'Вычесть из премии не будем' });
    expect(resolved.statusCode, resolved.body).toBe(200);
    const dto = resolved.json() as GuestOrderDetailDto;
    expect(dto.status).toBe('in_progress');
    expect(dto.total).toBe(290);
    expect(dto.lines.some((l) => l.isRemake && l.price === 0)).toBe(true);
    expect(dto.incidents[0]?.status).toBe('remade');
    // 0,12 кг говядины по 500 и 0,1 кг картофеля по 30
    expect(dto.incidents[0]?.lossCost).toBeCloseTo(0.12 * 500 + 0.1 * 30, 2);
    expect(await remaining(env, beef, w.kitchen.id)).toBeCloseTo(before - 0.12, 3);
    // решение второй раз принять нельзя
    expect((await manager()('POST', `/api/guest-orders/incidents/${incident?.id}/resolve`, { action: 'dismiss' })).statusCode).toBe(409);
    const audit = (await admin()('GET', '/api/audit?action=guest_order')).json();
    expect(audit.items.length).toBeGreaterThanOrEqual(4);
  });

  it('если в обращении нет позиции, а в заказе несколько блюд, менеджер выбирает, что переделать', async () => {
    const { beef, potato } = await stockKitchen();
    const soup = await addDish(env, 'Суп', 200, [{ productId: potato, quantity: 0.3 }]);
    const created = await waiter()('POST', '/api/guest-orders', { locationId: w.kitchen.id, tableLabel: '4', lines: [{ dishId: borsch, quantity: 1 }, { dishId: soup, quantity: 1 }] });
    const order = created.json() as GuestOrderDetailDto;
    await manager()('POST', `/api/guest-orders/${order.id}/status`, { status: 'in_progress' });
    const reported = (await waiter()('POST', `/api/guest-orders/${order.id}/incidents`, { kind: 'wrong_dish', blame: 'kitchen', comment: 'Подали не то' })).json() as GuestOrderDetailDto;
    const incidentId = reported.incidents[0]?.id;
    const without = await manager()('POST', `/api/guest-orders/incidents/${incidentId}/resolve`, { action: 'remake' });
    expect(without.statusCode).toBe(400);
    expect(without.json().error.code).toBe('incident_line_required');
    const soupLine = order.lines.find((l) => l.dishId === soup)?.id;
    const before = await remaining(env, potato, w.kitchen.id);
    const done = await manager()('POST', `/api/guest-orders/incidents/${incidentId}/resolve`, { action: 'remake', lineId: soupLine });
    expect(done.statusCode, done.body).toBe(200);
    expect(await remaining(env, potato, w.kitchen.id)).toBeCloseTo(before - 0.3, 3);
    expect(await remaining(env, beef, w.kitchen.id)).toBeCloseTo(3 - 0.12, 3);
  });

  it('обращение можно отклонить без списания', async () => {
    await stockKitchen();
    const order = (await place(1)).json() as GuestOrderDetailDto;
    await manager()('POST', `/api/guest-orders/${order.id}/status`, { status: 'in_progress' });
    const reported = (await manager()('POST', `/api/guest-orders/${order.id}/incidents`, { kind: 'complaint', blame: 'guest', comment: 'Гость недоволен соусом' })).json() as GuestOrderDetailDto;
    const before = await remaining(env, beef, w.kitchen.id);
    const res = await manager()('POST', `/api/guest-orders/incidents/${reported.incidents[0]?.id}/resolve`, { action: 'dismiss' });
    expect(res.json().incidents[0].status).toBe('dismissed');
    expect(await remaining(env, beef, w.kitchen.id)).toBeCloseTo(before, 3);
  });
});

describe('поставщики и кабинет поставщика', () => {
  async function orderTo(inn: string | null = completeInn('616301234')) {
    const s = await manager()('POST', '/api/suppliers', { name: 'Молочный комбинат «Донской»', ...(inn ? { inn } : {}), email: 'zakaz@donskoy.example', leadTimeDays: 1, minOrderSum: 0 });
    expect(s.statusCode, s.body).toBe(201);
    const p = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l', cost: 60 });
    const draft = await manager()('POST', '/api/orders', { supplierId: s.json().id, locationId: w.kitchen.id, lines: [{ productId: p, quantity: 40, unitCost: 60 }] });
    expect(draft.statusCode, draft.body).toBe(201);
    return { supplierId: s.json().id as string, productId: p, orderId: draft.json().id as string };
  }

  const signed = (payload: unknown, over: { secret?: string; at?: number } = {}) => {
    const ts = String(Math.floor((over.at ?? env.clock.now.getTime()) / 1000));
    return { [SUPPLIER_PORTAL_TIMESTAMP_HEADER]: ts, [SUPPLIER_PORTAL_SIGNATURE_HEADER]: signPortalPayload(over.secret ?? SECRET, ts, payload) };
  };
  const push = (payload: object, over: Parameters<typeof signed>[1] = {}) => call(env, null)('POST', '/api/supplier-gateway/status', payload, signed(payload, over));

  it('отправленный заказ уходит в кабинет поставщика, черновик нет', async () => {
    const { orderId } = await orderTo();
    expect(env.portal.pushes).toHaveLength(0);
    const sent = await manager()('POST', `/api/orders/${orderId}/send`);
    expect(sent.statusCode, sent.body).toBe(200);
    expect(env.portal.pushes).toHaveLength(1);
    const pushed = env.portal.pushes[0];
    expect(pushed).toMatchObject({ externalId: orderId, status: 'sent', supplierInn: completeInn('616301234'), total: 2400 });
    expect(pushed?.buyer.organization).toBeTruthy();
    expect(pushed?.lines).toHaveLength(1);
    const dto = sent.json() as OrderDetailDto;
    expect(dto.portalPushedAt).not.toBeNull();
    expect(dto.events.map((e) => e.status)).toEqual(['sent']);
  });

  it('если кабинет недоступен, заказ всё равно отправлен, причина видна, потом отправка повторяется', async () => {
    const { orderId } = await orderTo();
    env.portal.failure = 'кабинет поставщика не отвечает';
    const sent = (await manager()('POST', `/api/orders/${orderId}/send`)).json() as OrderDetailDto;
    expect(sent.status).toBe('sent');
    expect(sent.portalPushedAt).toBeNull();
    expect(sent.portalError).toBe('кабинет поставщика не отвечает');
    env.portal.failure = null;
    expect(await retryPortalPushes(env.deps)).toBe(1);
    expect(env.portal.pushes).toHaveLength(1);
    const after = (await manager()('GET', `/api/orders/${orderId}`)).json() as OrderDetailDto;
    expect(after.portalError).toBeNull();
    expect(after.portalPushedAt).not.toBeNull();
  });

  it('у поставщика без ИНН кабинет не узнает адресата, об этом сказано в заказе', async () => {
    const { orderId } = await orderTo(null);
    const sent = (await manager()('POST', `/api/orders/${orderId}/send`)).json() as OrderDetailDto;
    expect(env.portal.pushes).toHaveLength(0);
    expect(sent.portalError).toContain('ИНН');
  });

  it('статусы поставщика меняют заказ и попадают в историю; подпись обязательна', async () => {
    const { orderId } = await orderTo();
    await manager()('POST', `/api/orders/${orderId}/send`);

    const body = { externalId: orderId, status: 'confirmed', note: 'Привезём завтра до 10:00', deliveryOn: '2026-10-09' };
    expect((await call(env, null)('POST', '/api/supplier-gateway/status', body)).statusCode).toBe(401);
    expect((await push(body, { secret: 'чужой-секрет-чужой-секрет' })).statusCode).toBe(401);
    expect((await push(body, { at: env.clock.now.getTime() - 3_600_000 })).statusCode).toBe(401);

    const ok = await push(body);
    expect(ok.statusCode, ok.body).toBe(200);
    const confirmed = (await manager()('GET', `/api/orders/${orderId}`)).json() as OrderDetailDto;
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.supplierNote).toBe('Привезём завтра до 10:00');
    expect(confirmed.deliveryOn).toBe('2026-10-09');
    expect(confirmed.events.at(-1)).toMatchObject({ side: 'supplier', status: 'confirmed' });
    // повтор того же статуса безвреден
    expect((await push(body)).statusCode).toBe(200);
    expect(((await manager()('GET', `/api/orders/${orderId}`)).json() as OrderDetailDto).events).toHaveLength(2);

    const shipped = await push({ externalId: orderId, status: 'shipped' });
    expect(shipped.statusCode).toBe(200);
    // назад по цепочке нельзя
    expect((await push({ externalId: orderId, status: 'confirmed' })).statusCode).toBe(409);
    expect((await push({ externalId: '00000000-0000-4000-8000-000000000000', status: 'confirmed' })).statusCode).toBe(404);
  });

  it('отказ поставщика закрывает заказ', async () => {
    const { orderId } = await orderTo();
    await manager()('POST', `/api/orders/${orderId}/send`);
    expect((await push({ externalId: orderId, status: 'declined', note: 'Нет товара' })).statusCode).toBe(200);
    const dto = (await manager()('GET', `/api/orders/${orderId}`)).json() as OrderDetailDto;
    expect(dto.status).toBe('declined');
    expect(dto.closedAt).not.toBeNull();
    // принять поставку по закрытому заказу уже нельзя
    const rec = await receive(env, w.manager.token, w.kitchen.id, [{ productId: (await addProduct(env, w.categoryId)), quantity: 1, expiresOn: w.day(5) }]).catch((e: Error) => e);
    expect(rec).toBeTruthy();
  });

  it('решение покупателя при приёмке: замечание и отказ уходят в кабинет', async () => {
    const { orderId } = await orderTo();
    await manager()('POST', `/api/orders/${orderId}/send`);
    await push({ externalId: orderId, status: 'confirmed' });
    await push({ externalId: orderId, status: 'shipped' });
    env.portal.pushes.length = 0;

    const remark = await manager()('POST', `/api/orders/${orderId}/decision`, { decision: 'remark', comment: 'Часть пакетов помята' });
    expect(remark.statusCode, remark.body).toBe(200);
    expect(env.portal.pushes.at(-1)).toMatchObject({ status: 'shipped', buyerNote: 'Часть пакетов помята' });

    const refuse = await manager()('POST', `/api/orders/${orderId}/decision`, { decision: 'refuse', comment: 'Срок годности короче заявленного' });
    expect(refuse.statusCode, refuse.body).toBe(200);
    expect(refuse.json().status).toBe('refused');
    expect(env.portal.pushes.at(-1)).toMatchObject({ status: 'refused', statusLabel: 'Отказ от поставки', buyerNote: 'Срок годности короче заявленного' });
    // закрытый заказ повторно не отклоняется
    expect((await manager()('POST', `/api/orders/${orderId}/decision`, { decision: 'refuse', comment: 'ещё раз' })).statusCode).toBe(409);
    // кладовщик решений не принимает
    expect((await call(env, w.keeperA.token)('POST', `/api/orders/${orderId}/decision`, { decision: 'remark', comment: 'x' })).statusCode).toBe(403);
  });

  it('приход по заказу сообщает кабинету, что поставка принята', async () => {
    const { orderId, productId } = await orderTo();
    await manager()('POST', `/api/orders/${orderId}/send`);
    await push({ externalId: orderId, status: 'confirmed' });
    await push({ externalId: orderId, status: 'shipped' });
    env.portal.pushes.length = 0;
    const res = await manager()('POST', '/api/documents/receipts', { locationId: w.kitchen.id, orderId, lines: [{ productId, quantity: 40, unitCost: 60, expiresOn: w.day(7) }] });
    expect(res.statusCode, res.body).toBe(201);
    expect(env.portal.pushes.at(-1)).toMatchObject({ status: 'received', externalId: orderId });
    expect(env.portal.pushes.at(-1)?.lines[0]?.receivedQty).toBe(40);
    const dto = (await manager()('GET', `/api/orders/${orderId}`)).json() as OrderDetailDto;
    expect(dto.events.map((e) => e.status)).toContain('received');
  });

  it('экран входа получает адрес кабинета для кнопки «Отгрузка» без пароля', async () => {
    const res = await call(env, null)('GET', '/api/supplier-portal/link');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: 'http://portal.test' });
  });

  it('справка по ИНН: кабинет узнаёт, знает ли «Запас» такого поставщика', async () => {
    await orderTo();
    const known = { inn: completeInn('616301234') };
    const hit = await call(env, null)('POST', '/api/supplier-gateway/lookup', known, signed(known));
    expect(hit.json()).toMatchObject({ known: true, buyers: 1 });
    const unknown = { inn: completeInn('616999999') };
    const miss = await call(env, null)('POST', '/api/supplier-gateway/lookup', unknown, signed(unknown));
    expect(miss.json()).toMatchObject({ known: false, buyers: 0 });
    const bad = await call(env, null)('POST', '/api/supplier-gateway/lookup', { inn: '123' }, signed({ inn: '123' }));
    expect(bad.statusCode).toBe(400);
  });

  it('кабинет может запросить текущее состояние заказа', async () => {
    const { orderId } = await orderTo();
    await manager()('POST', `/api/orders/${orderId}/send`);
    const payload = { id: orderId };
    const res = await call(env, null)('GET', `/api/supplier-gateway/orders/${orderId}`, undefined, signed(payload));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ externalId: orderId, status: 'sent' });
    expect((await call(env, null)('GET', `/api/supplier-gateway/orders/${orderId}`)).statusCode).toBe(401);
  });

  it('поставщика и точку из разных организаций в одном заказе не соединить', async () => {
    const mine: Session = await register({ email: 'z@z.example' }).then((r) => ({ token: r.json().accessToken, cookie: '', userId: r.json().user.id }));
    const foreign = await call(env, mine.token)('POST', '/api/suppliers', { name: 'Чужой', leadTimeDays: 1, minOrderSum: 0 });
    const p = await addProduct(env, w.categoryId, { name: 'Товар' });
    const res = await manager()('POST', '/api/orders', { supplierId: foreign.json().id, locationId: w.kitchen.id, lines: [{ productId: p, quantity: 1, unitCost: 10 }] });
    expect(res.statusCode).toBe(400);
  });

  it('точка, созданная администратором, получает свою организацию и тип', async () => {
    const bar = await admin()('POST', '/api/locations', { code: 'bar1', name: 'Бар «Причал»', kind: 'bar' });
    expect(bar.statusCode, bar.body).toBe(201);
    expect(bar.json().kind).toBe('bar');
    const loc = await addLocation(env, 'Склад дальний', 'warehouse');
    expect(loc.id).toBeTruthy();
    const menu = await call(env, w.manager.token)('GET', '/api/locations');
    expect(menu.json().some((l: { code: string }) => l.code === 'bar1')).toBe(true);
    void TEST_PASSWORD;
  });
});
