import type { PublicRescueDto, ReservationReceiptDto, StaffReservationDto } from '@zapas/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { purgeStorefront } from '../src/modules/storefront/service';
import { addProduct, createWorld, receive, remaining, type World } from './fixtures';
import { call, createTestEnv, createUser, loginAs, type TestEnv } from './helpers';

let env: TestEnv;
let w: World;

beforeAll(async () => {
  env = await createTestEnv({ ACCESS_TOKEN_TTL_SECONDS: '3600', STOREFRONT_HOLD_MINUTES: '120', STOREFRONT_RETENTION_DAYS: '30' });
});
afterAll(() => env.close());
beforeEach(async () => {
  await env.reset();
  w = await createWorld(env);
});

const manager = () => call(env, w.manager.token);
const keeper = () => call(env, w.keeperA.token);

const pub = (method: 'GET' | 'POST', url: string, payload?: unknown) => env.app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });
const PHONE = '+7 900 123-45-67';
const reserveBody = (offerId: string, over: Record<string, unknown> = {}) => ({ offerId, quantity: 1, name: 'Анна', phone: PHONE, consent: true, ...over });
const reserveReq = (offerId: string, over: Record<string, unknown> = {}) => pub('POST', '/api/public/rescue/reservations', reserveBody(offerId, over));

async function enable(locationId = w.locA.id, extra: Record<string, unknown> = {}) {
  const res = await manager()('PUT', '/api/storefront/settings', { locationId, enabled: true, ...extra });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { slug: string };
}

/** Партия с уценкой, выставленная на витрину. */
async function offer(opts: { qty?: number; stock?: number; days?: number; unit?: 'kg' | 'pcs'; percent?: number; max?: number; name?: string; locationId?: string } = {}): Promise<{ offerId: string; productId: string; batchId: string }> {
  const loc = opts.locationId ?? w.locA.id;
  const productId = await addProduct(env, w.categoryId, { name: opts.name ?? 'Йогурт', unit: opts.unit ?? 'kg', price: 100, cost: 60 });
  await receive(env, w.manager.token, loc, [{ productId, quantity: opts.stock ?? 10, expiresOn: w.day(opts.days ?? 2), unitCost: 60 }]);
  const batch = await env.db.selectFrom('batches').select('id').where('product_id', '=', productId).where('location_id', '=', loc).executeTakeFirstOrThrow();
  const promo = await manager()('POST', '/api/promotions', { batchId: batch.id, percent: opts.percent ?? 30 });
  expect(promo.statusCode, promo.body).toBe(201);
  const res = await manager()('POST', '/api/storefront/offers', { batchId: batch.id, quantity: opts.qty ?? 6, ...(opts.max ? { perGuestMax: opts.max } : {}) });
  expect(res.statusCode, res.body).toBe(201);
  return { offerId: res.json().id as string, productId, batchId: batch.id };
}

/** Токены живут час, а часть проверок переводит часы на дни вперёд. */
async function freshManager(): Promise<string> {
  return (await loginAs(env, await createUser(env, { role: 'manager' }))).token;
}

const rescue = async () => (await pub('GET', '/api/public/rescue')).json() as PublicRescueDto;
const reservations = async (token = w.manager.token, query = '') => (await call(env, token)('GET', `/api/storefront/reservations${query}`)).json() as StaffReservationDto[];

describe('витрина: включение и предложения', () => {
  it('адрес витрины создаётся из названия точки, а без предложений витрина пуста', async () => {
    const s = await enable();
    expect(s.slug).toBe('magazin-tsentr');
    expect((await rescue()).venues).toEqual([]);
    const list = await manager()('GET', '/api/storefront/settings');
    expect(list.json().find((x: { locationId: string }) => x.locationId === w.locA.id)).toMatchObject({ enabled: true, publicPath: '/rescue/magazin-tsentr' });
  });

  it('повторное включение сохраняет адрес, чужой занятый адрес не отдаётся', async () => {
    await enable();
    const again = await enable();
    expect(again.slug).toBe('magazin-tsentr');
    const clash = await manager()('PUT', '/api/storefront/settings', { locationId: w.locB.id, enabled: true, slug: 'magazin-tsentr' });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe('slug_taken');
    const bad = await manager()('PUT', '/api/storefront/settings', { locationId: w.locB.id, enabled: true, slug: 'Плохой адрес!' });
    expect(bad.statusCode).toBe(400);
  });

  it('в предложение попадает только уценённая партия на точке с включённой витриной', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Сыр', unit: 'kg', price: 100 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 5, expiresOn: w.day(2) }]);
    const batch = await env.db.selectFrom('batches').select('id').where('product_id', '=', p).executeTakeFirstOrThrow();
    const off = await manager()('POST', '/api/storefront/offers', { batchId: batch.id, quantity: 2 });
    expect(off.statusCode).toBe(409);
    expect(off.json().error.code).toBe('storefront_off');
    await enable();
    const noPromo = await manager()('POST', '/api/storefront/offers', { batchId: batch.id, quantity: 2 });
    expect(noPromo.json().error.code).toBe('no_promotion');
    await manager()('POST', '/api/promotions', { batchId: batch.id, percent: 25 });
    expect((await manager()('POST', '/api/storefront/offers', { batchId: batch.id, quantity: 99 })).json().error.code).toBe('too_much');
    expect((await manager()('POST', '/api/storefront/offers', { batchId: batch.id, quantity: 2 })).statusCode).toBe(201);
    expect((await manager()('POST', '/api/storefront/offers', { batchId: batch.id, quantity: 2 })).json().error.code).toBe('already_offered');
  });

  it('права: настройки и предложения только менеджеру, брони кладовщику, наблюдателю ничего', async () => {
    await enable();
    const { batchId } = await offer();
    expect((await keeper()('PUT', '/api/storefront/settings', { locationId: w.locA.id, enabled: false })).statusCode).toBe(403);
    expect((await keeper()('POST', '/api/storefront/offers', { batchId, quantity: 1 })).statusCode).toBe(403);
    expect((await keeper()('GET', '/api/storefront/offers')).statusCode).toBe(200);
    expect((await call(env, w.viewerA.token)('GET', '/api/storefront/reservations')).statusCode).toBe(403);
    expect((await call(env, w.waiterA.token)('GET', '/api/storefront/offers')).statusCode).toBe(403);
  });

  it('снятие предложения скрывает его с витрины', async () => {
    await enable();
    const { offerId } = await offer();
    expect((await rescue()).venues).toHaveLength(1);
    expect((await manager()('POST', `/api/storefront/offers/${offerId}/close`)).statusCode).toBe(204);
    expect((await rescue()).venues).toEqual([]);
  });
});

describe('витрина: что видит гость', () => {
  it('цена со скидкой, остаток и срок; без себестоимости, партий и внутренних идентификаторов', async () => {
    await enable(w.locA.id, { note: 'Касса справа, до 21:00' });
    await offer({ percent: 30, qty: 6, stock: 10 });
    const res = await pub('GET', '/api/public/rescue');
    expect(res.headers['cache-control']).toMatch(/public/);
    const data = res.json() as PublicRescueDto;
    expect(data.venues[0]).toMatchObject({ slug: 'magazin-tsentr', name: 'Магазин Центр', note: 'Касса справа, до 21:00' });
    expect(data.venues[0]?.offers[0]).toMatchObject({ productName: 'Йогурт', price: 70, oldPrice: 100, percent: 30, available: 6, daysLeft: 2, perGuestMax: 3 });
    const text = JSON.stringify(data);
    for (const secret of ['cost', 'unitCost', 'batch', 'org', 'userId', 'created']) expect(text, secret).not.toMatch(new RegExp(secret, 'i'));
  });

  it('витрина одной точки по адресу, чужой и неверный адрес пусты', async () => {
    await enable();
    await offer();
    expect(((await pub('GET', '/api/public/rescue/magazin-tsentr')).json() as PublicRescueDto).venues).toHaveLength(1);
    expect(((await pub('GET', '/api/public/rescue/net-takogo')).json() as PublicRescueDto).venues).toEqual([]);
    expect((await pub('GET', '/api/public/rescue/Плохо!')).statusCode).toBe(400);
  });

  it('выключенная витрина, вышедший срок и отменённая скидка скрывают предложение', async () => {
    await enable();
    const { batchId } = await offer({ days: 1 });
    expect((await rescue()).venues).toHaveLength(1);
    const promo = await env.db.selectFrom('promotions').select('id').where('batch_id', '=', batchId).executeTakeFirstOrThrow();
    await env.db.updateTable('promotions').set({ cancelled_at: env.clock.now }).where('id', '=', promo.id).execute();
    expect((await rescue()).venues).toEqual([]);
    await env.db.updateTable('promotions').set({ cancelled_at: null }).where('id', '=', promo.id).execute();
    expect((await rescue()).venues).toHaveLength(1);
    await manager()('PUT', '/api/storefront/settings', { locationId: w.locA.id, enabled: false });
    expect((await rescue()).venues).toEqual([]);
    await manager()('PUT', '/api/storefront/settings', { locationId: w.locA.id, enabled: true });
    env.clock.advance(3 * 86_400_000);
    expect((await rescue()).venues).toEqual([]);
  });
});

describe('витрина: бронь', () => {
  it('бронь выдаёт код, держит товар и не списывает остаток', async () => {
    await enable();
    const { offerId, productId } = await offer({ stock: 10, qty: 6 });
    const res = await reserveReq(offerId, { quantity: 2 });
    expect(res.statusCode, res.body).toBe(201);
    const receipt = res.json() as ReservationReceiptDto;
    expect(receipt.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    expect(receipt).toMatchObject({ venue: 'Магазин Центр', productName: 'Йогурт', quantity: 2, total: 140 });
    expect(new Date(receipt.expiresAt).getTime() - env.clock.now.getTime()).toBe(120 * 60_000);
    expect((await rescue()).venues[0]?.offers[0]?.available).toBe(4);
    expect(await remaining(env, productId, w.locA.id)).toBe(10);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('проверки: согласие, телефон, имя, лишние поля, ловушка для ботов, штучный товар', async () => {
    await enable();
    const { offerId } = await offer();
    expect((await reserveReq(offerId, { consent: false })).statusCode).toBe(400);
    expect((await reserveReq(offerId, { consent: undefined })).statusCode).toBe(400);
    expect((await reserveReq(offerId, { phone: '123' })).statusCode).toBe(400);
    expect((await reserveReq(offerId, { name: '' })).statusCode).toBe(400);
    expect((await reserveReq(offerId, { name: 'Анна\u0000' })).statusCode).toBe(400);
    expect((await reserveReq(offerId, { website: 'http://spam.example' })).statusCode).toBe(400);
    expect((await reserveReq(offerId, { admin: true })).statusCode).toBe(400);
    expect((await reserveReq(offerId, { quantity: -1 })).statusCode).toBe(400);
    expect((await reserveReq('не-идентификатор')).statusCode).toBe(400);
    const pcs = await offer({ unit: 'pcs', name: 'Батон', stock: 10, qty: 6 });
    expect((await reserveReq(pcs.offerId, { quantity: 1.5 })).json().error.code).toBe('bad_quantity');
    expect((await reserveReq(pcs.offerId, { quantity: 2 })).statusCode).toBe(201);
  });

  it('больше остатка и больше лимита на гостя нельзя, неизвестное предложение недоступно', async () => {
    await enable();
    const { offerId } = await offer({ qty: 4, max: 2 });
    expect((await reserveReq(offerId, { quantity: 3 })).json().error.code).toBe('too_many');
    expect((await reserveReq(offerId, { quantity: 2, phone: '+7 900 000-00-01' })).statusCode).toBe(201);
    expect((await reserveReq(offerId, { quantity: 2, phone: '+7 900 000-00-02' })).statusCode).toBe(201);
    const none = await reserveReq(offerId, { quantity: 1, phone: '+7 900 000-00-03' });
    expect(none.statusCode).toBe(409);
    expect(none.json().error.code).toBe('not_enough');
    const ghost = await reserveReq('11111111-1111-4111-8111-111111111111');
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json().error.code).toBe('offer_unavailable');
  });

  it('одновременные брони не занимают один остаток дважды', async () => {
    await enable();
    const { offerId } = await offer({ qty: 3, stock: 10 });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => reserveReq(offerId, { phone: `+7 900 111-00-${String(i).padStart(2, '0')}` })));
    const ok = results.filter((r) => r.statusCode === 201);
    expect(ok).toHaveLength(3);
    expect(new Set(ok.map((r) => r.json().code)).size).toBe(3);
    expect(results.filter((r) => r.statusCode !== 201).every((r) => r.statusCode === 409)).toBe(true);
    expect((await rescue()).venues).toEqual([]);
  });

  it('на один телефон не больше трёх действующих броней, записи телефона 8 и +7 равны', async () => {
    await enable();
    const { offerId } = await offer({ qty: 10 });
    for (const phone of ['+7 900 123-45-67', '89001234567', '7 (900) 123 45 67']) expect((await reserveReq(offerId, { phone })).statusCode).toBe(201);
    const fourth = await reserveReq(offerId, { phone: '+79001234567' });
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json().error.code).toBe('too_many_reservations');
    expect((await reserveReq(offerId, { phone: '+7 900 999-99-99' })).statusCode).toBe(201);
  });

  it('гость отменяет бронь по коду и телефону, чужой телефон и неверный код одинаково дают 404', async () => {
    await enable();
    const { offerId } = await offer({ qty: 3 });
    const code = (await reserveReq(offerId, { quantity: 3 })).json().code as string;
    expect((await rescue()).venues).toEqual([]);
    const wrongPhone = await pub('POST', '/api/public/rescue/reservations/cancel', { code, phone: '+7 900 000-00-00' });
    const wrongCode = await pub('POST', '/api/public/rescue/reservations/cancel', { code: 'ZZZZZZ', phone: PHONE });
    expect(wrongPhone.statusCode).toBe(404);
    expect(wrongCode.statusCode).toBe(404);
    expect(wrongPhone.json().error).toEqual(wrongCode.json().error);
    expect((await pub('POST', '/api/public/rescue/reservations/cancel', { code: code.toLowerCase(), phone: '8 900 123 45 67' })).statusCode).toBe(204);
    expect((await rescue()).venues[0]?.offers[0]?.available).toBe(3);
    expect((await pub('POST', '/api/public/rescue/reservations/cancel', { code, phone: PHONE })).statusCode).toBe(404);
    expect((await pub('POST', '/api/public/rescue/reservations/cancel', { code: 'abc', phone: PHONE })).statusCode).toBe(400);
  });

  it('время брони выходит: товар возвращается на витрину, забрать по такой брони нельзя', async () => {
    await enable();
    const { offerId } = await offer({ qty: 2 });
    const code = (await reserveReq(offerId, { quantity: 2 })).json().code as string;
    expect((await rescue()).venues).toEqual([]);
    env.clock.advance(121 * 60_000);
    const token = await freshManager();
    expect((await rescue()).venues[0]?.offers[0]?.available).toBe(2);
    const list = await reservations(token);
    expect(list[0]).toMatchObject({ code, status: 'expired' });
    expect((await call(env, token)('POST', `/api/storefront/reservations/${list[0]?.id}/pickup`)).statusCode).toBe(409);
    expect((await pub('POST', '/api/public/rescue/reservations/cancel', { code, phone: PHONE })).statusCode).toBe(404);
  });

  it('частые брони с одного адреса упираются в ограничение', async () => {
    const strict = await createTestEnv({ ACCESS_TOKEN_TTL_SECONDS: '3600', STOREFRONT_RESERVE_LIMIT: '3' });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const r = await strict.app.inject({ method: 'POST', url: '/api/public/rescue/reservations', payload: reserveBody('11111111-1111-4111-8111-111111111111') });
        codes.push(r.statusCode);
      }
      expect(codes.slice(0, 3)).toEqual([404, 404, 404]);
      expect(codes.slice(3)).toEqual([429, 429]);
    } finally {
      await strict.close();
    }
  });

  it('бронь не сбрасывает кеш расчётов', async () => {
    await enable();
    const { offerId } = await offer();
    await manager()('GET', '/api/analytics/dashboard');
    expect((await manager()('GET', '/api/analytics/dashboard')).headers['x-cache']).toMatch(/HIT/);
    await reserveReq(offerId);
    expect((await manager()('GET', '/api/analytics/dashboard')).headers['x-cache']).toMatch(/HIT/);
  });
});

describe('витрина: выдача и сотрудники', () => {
  it('выдача списывает товар продажей по цене со скидкой и закрывает бронь, повтор ничего не меняет', async () => {
    await enable();
    const { offerId, productId } = await offer({ stock: 10 });
    await reserveReq(offerId, { quantity: 2 });
    const [r] = await reservations();
    expect(r).toMatchObject({ status: 'reserved', quantity: 2, total: 140, guestName: 'Анна', guestPhone: '79001234567' });
    const done = await keeper()('POST', `/api/storefront/reservations/${r?.id}/pickup`);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ status: 'picked_up' });
    expect(await remaining(env, productId, w.locA.id)).toBe(8);
    const again = await keeper()('POST', `/api/storefront/reservations/${r?.id}/pickup`);
    expect(again.statusCode).toBe(200);
    expect(await remaining(env, productId, w.locA.id)).toBe(8);
    const docs = await env.db.selectFrom('documents').select('comment').where('kind', '=', 'sale').execute();
    expect(docs.filter((d) => d.comment?.startsWith('Витрина')).length).toBe(1);
    expect((await rescue()).venues[0]?.offers[0]?.available).toBe(4);
  });

  it('выданное не возвращается в остаток витрины, а закрытую бронь повторно не отменить', async () => {
    await enable();
    const { offerId } = await offer({ qty: 3, stock: 10 });
    await reserveReq(offerId, { quantity: 3 });
    const [r] = await reservations();
    await keeper()('POST', `/api/storefront/reservations/${r?.id}/pickup`);
    expect((await rescue()).venues).toEqual([]);
    const cancel = await keeper()('POST', `/api/storefront/reservations/${r?.id}/cancel`, {});
    expect(cancel.statusCode).toBe(409);
  });

  it('сотрудник отменяет бронь с причиной, товар возвращается на витрину', async () => {
    await enable();
    const { offerId } = await offer({ qty: 2 });
    await reserveReq(offerId, { quantity: 2 });
    const [r] = await reservations();
    const res = await keeper()('POST', `/api/storefront/reservations/${r?.id}/cancel`, { reason: 'Гость не пришёл' });
    expect(res.json()).toMatchObject({ status: 'cancelled', cancelReason: 'Гость не пришёл' });
    expect((await rescue()).venues[0]?.offers[0]?.available).toBe(2);
  });

  it('если на складе товара уже нет, выдача не проходит и бронь остаётся', async () => {
    await enable();
    const { offerId, batchId } = await offer({ stock: 3, qty: 3 });
    await reserveReq(offerId, { quantity: 3 });
    await env.db.updateTable('batches').set({ remaining_qty: 1 }).where('id', '=', batchId).execute();
    const [r] = await reservations();
    const res = await keeper()('POST', `/api/storefront/reservations/${r?.id}/pickup`);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('insufficient_stock');
    expect((await reservations())[0]?.status).toBe('reserved');
  });

  it('поиск по коду, чужая точка и чужая организация не видны', async () => {
    await enable();
    await enable(w.locB.id);
    const a = await offer();
    const b = await offer({ locationId: w.locB.id, name: 'Кефир' });
    await reserveReq(a.offerId, { phone: '+7 900 000-00-01' });
    await reserveReq(b.offerId, { phone: '+7 900 000-00-02' });
    expect(await reservations(w.manager.token)).toHaveLength(2);
    const mine = await reservations(w.keeperA.token);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.locationName).toBe('Магазин Центр');
    const code = mine[0]?.code as string;
    expect(await reservations(w.manager.token, `?code=${code.toLowerCase()}`)).toHaveLength(1);
    expect((await call(env, w.keeperA.token)('GET', `/api/storefront/reservations?locationId=${w.locB.id}`)).statusCode).toBe(404);

    const reg = await env.app.inject({ method: 'POST', url: '/api/auth/register', payload: { organizationName: 'Чужая', fullName: 'Иван Чужой', email: 'x@y.example', password: 'Хорошая-длинная-фраза-91' } });
    const stranger = reg.json().accessToken as string;
    expect(await reservations(stranger)).toEqual([]);
    const target = mine[0]?.id;
    expect((await call(env, stranger)('POST', `/api/storefront/reservations/${target}/pickup`)).statusCode).toBe(404);
    expect((await call(env, stranger)('POST', `/api/storefront/offers/${a.offerId}/close`)).statusCode).toBe(404);
  });

  it('кладовщик другой точки не может выдать чужую бронь', async () => {
    await enable();
    const { offerId } = await offer();
    await reserveReq(offerId);
    const [r] = await reservations();
    const other = await loginAs(env, await createUser(env, { role: 'storekeeper', locationIds: [w.locB.id] }));
    expect((await call(env, other.token)('POST', `/api/storefront/reservations/${r?.id}/pickup`)).statusCode).toBe(404);
  });
});

describe('витрина: персональные данные', () => {
  it('публичные ответы не содержат имени и телефона', async () => {
    await enable();
    const { offerId } = await offer();
    const res = await reserveReq(offerId, { name: 'Секретное Имя' });
    expect(JSON.stringify(res.json())).not.toMatch(/Секретное|79001234567/);
    expect(JSON.stringify(await rescue())).not.toMatch(/Секретное|79001234567/);
  });

  it('по истечении срока хранения имя и телефон стираются, а бронь и хэш остаются', async () => {
    await enable();
    const { offerId } = await offer({ qty: 3 });
    await reserveReq(offerId);
    const [r] = await reservations();
    await keeper()('POST', `/api/storefront/reservations/${r?.id}/cancel`, {});
    env.clock.advance(29 * 86_400_000);
    await purgeStorefront(env.deps);
    expect((await reservations(await freshManager()))[0]).toMatchObject({ guestName: 'Анна' });
    env.clock.advance(2 * 86_400_000);
    await purgeStorefront(env.deps);
    const after = (await reservations(await freshManager()))[0];
    expect(after).toMatchObject({ guestName: null, guestPhone: null, status: 'cancelled' });
    const row = await env.db.selectFrom('storefront_reservations').select('phone_hash').executeTakeFirstOrThrow();
    expect(row.phone_hash).toHaveLength(64);
  });

  it('действующая бронь персональные данные не теряет, как бы давно она ни была', async () => {
    await enable();
    const { offerId } = await offer();
    await reserveReq(offerId);
    env.clock.advance(40 * 86_400_000);
    await env.db.updateTable('storefront_reservations').set({ expires_at: new Date(env.clock.now.getTime() + 3600_000) }).execute();
    await purgeStorefront(env.deps);
    expect((await reservations(await freshManager()))[0]?.guestName).toBe('Анна');
  });

  it('журнал содержит бронь без имени и телефона', async () => {
    await enable();
    const { offerId } = await offer();
    await reserveReq(offerId, { name: 'Секретное Имя' });
    const rows = await env.db.selectFrom('audit_log').select(['action', 'details']).where('action', '=', 'storefront.reserve').execute();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toMatch(/Секретное|9001234567/);
  });
});

