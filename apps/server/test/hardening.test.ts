import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config';
import { schedulerTick } from '../src/modules/notifications/scheduler';
import { addDish, addLocation, addProduct, createWorld, receive, remaining, type World } from './fixtures';
import { call, createTestEnv, createUser, loginAs, TEST_PASSWORD, type TestEnv } from './helpers';

let env: TestEnv;
let w: World;

beforeAll(async () => {
  env = await createTestEnv({ APP_ORIGINS: 'http://localhost:5173', ACCESS_TOKEN_TTL_SECONDS: '3600' });
});
afterAll(() => env.close());
beforeEach(async () => {
  await env.reset();
  w = await createWorld(env);
});

describe('недопустимые символы в тексте', () => {
  const hostile = [
    ['нулевой байт', 'a\u0000b'],
    ['одинокий суррогат', 'a\ud800b'],
    ['символ смены направления текста', 'abc‮гиф.exe'],
    ['перевод строки', 'a\nb'],
    ['табуляция', 'a\tb'],
    ['невидимый пробел нулевой ширины', 'a​b'],
  ] as const;

  it.each(hostile)('название продукта: %s отклоняется с 400', async (_, name) => {
    const res = await call(env, w.manager.token)('POST', '/api/products', { sku: 'T-1', name, categoryId: w.categoryId, unit: 'kg', price: 1, cost: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('то же правило действует для категорий, поставщиков, точек, блюд, причин и комментариев', async () => {
    const manager = call(env, w.manager.token);
    const bad = 'x\u0000y';
    expect((await manager('POST', '/api/categories', { name: bad })).statusCode).toBe(400);
    expect((await manager('POST', '/api/suppliers', { name: bad })).statusCode).toBe(400);
    expect((await call(env, w.admin.token)('POST', '/api/locations', { code: 'ABC', name: bad, kind: 'shop' })).statusCode).toBe(400);
    const p = await addProduct(env, w.categoryId, { sellable: false });
    expect((await manager('POST', '/api/dishes', { name: bad, price: 1, items: [{ productId: p, quantity: 1 }] })).statusCode).toBe(400);
    expect((await manager('POST', '/api/stop-list/manual', { locationId: w.locA.id, productId: p, reason: bad })).statusCode).toBe(400);
    expect(
      (await call(env, w.keeperA.token)('POST', '/api/documents/receipts', { locationId: w.locA.id, comment: bad, lines: [{ productId: p, quantity: 1, unitCost: 1, expiresOn: w.day(3) }] })).statusCode,
    ).toBe(400);
  });

  it('поиск с нулевым байтом это 400, а не 500', async () => {
    const api = call(env, w.manager.token);
    for (const url of ['/api/products?q=%00', '/api/stock/summary?q=a%00b', '/api/stock/batches?q=%00', '/api/audit?action=%00']) {
      const res = await api('GET', url);
      expect(res.statusCode, url).toBe(url.startsWith('/api/audit') ? 403 : 400);
    }
    expect((await call(env, w.admin.token)('GET', '/api/audit?userEmail=%00')).statusCode).toBe(400);
  });

  it('артикул с буквой «Ё» принимается', async () => {
    const res = await call(env, w.manager.token)('POST', '/api/products', { sku: 'ЁЖ-1', name: 'Ёжик в тумане', categoryId: w.categoryId, unit: 'pcs', price: 10, cost: 5 });
    expect(res.statusCode).toBe(201);
  });
});

describe('штучные товары только целыми', () => {
  it('приход, продажа, списание и перемещение отклоняют дробное количество', async () => {
    const bun = await addProduct(env, w.categoryId, { name: 'Булочка', unit: 'pcs' });
    const keeper = call(env, w.manager.token);
    const line = { productId: bun, quantity: 1.5 };

    const rec = await keeper('POST', '/api/documents/receipts', { locationId: w.locA.id, lines: [{ ...line, unitCost: 10, expiresOn: w.day(2) }] });
    expect(rec.statusCode).toBe(400);
    expect(rec.json().error.code).toBe('whole_pieces');
    expect(rec.json().error.details[0].path).toEqual(['lines', 0, 'quantity']);

    await receive(env, w.manager.token, w.locA.id, [{ productId: bun, quantity: 10, expiresOn: w.day(2) }]);
    expect((await keeper('POST', '/api/documents/sales', { locationId: w.locA.id, lines: [line] })).statusCode).toBe(400);
    expect((await keeper('POST', '/api/documents/writeoffs', { locationId: w.locA.id, reason: 'spoiled', lines: [line] })).statusCode).toBe(400);
    expect((await keeper('POST', '/api/documents/transfers', { fromLocationId: w.locA.id, toLocationId: w.locB.id, lines: [line] })).statusCode).toBe(400);
    expect(await remaining(env, bun, w.locA.id)).toBe(10);
  });

  it('вес и объём дробными оставаться могут', async () => {
    const cheese = await addProduct(env, w.categoryId, { unit: 'kg' });
    await receive(env, w.manager.token, w.locA.id, [{ productId: cheese, quantity: 2.35, expiresOn: w.day(20) }]);
    const res = await call(env, w.manager.token)('POST', '/api/documents/sales', { locationId: w.locA.id, lines: [{ productId: cheese, quantity: 0.125 }] });
    expect(res.statusCode).toBe(201);
  });

  it('блюда только целыми порциями, штучные ингредиенты только целыми на порцию', async () => {
    const egg = await addProduct(env, w.categoryId, { unit: 'pcs', sellable: false });
    const flour = await addProduct(env, w.categoryId, { unit: 'kg', sellable: false });
    const manager = call(env, w.manager.token);
    const badRecipe = await manager('POST', '/api/dishes', { name: 'Омлет', price: 100, items: [{ productId: egg, quantity: 0.5 }] });
    expect(badRecipe.statusCode).toBe(400);
    expect(badRecipe.json().error.code).toBe('whole_pieces');
    const dish = await addDish(env, 'Блин', 80, [{ productId: flour, quantity: 0.1 }]);
    await receive(env, w.manager.token, w.kitchen.id, [{ productId: flour, quantity: 5, expiresOn: w.day(30) }]);
    const half = await manager('POST', '/api/documents/sales', { locationId: w.kitchen.id, lines: [{ dishId: dish, quantity: 1.5 }] });
    expect(half.statusCode).toBe(400);
  });

  it('при инвентаризации штучный товар считается целыми', async () => {
    const bun = await addProduct(env, w.categoryId, { unit: 'pcs' });
    await receive(env, w.manager.token, w.locA.id, [{ productId: bun, quantity: 10, expiresOn: w.day(3) }]);
    const inv = (await call(env, w.keeperA.token)('POST', '/api/inventories', { locationId: w.locA.id })).json();
    const res = await call(env, w.keeperA.token)('PUT', `/api/inventories/${inv.id}/lines`, { lines: [{ productId: bun, countedQty: 9.5 }] });
    expect(res.statusCode).toBe(400);
  });
});

describe('ключ идемпотентности', () => {
  it('тот же ключ с другими данными это конфликт, а не молчаливый возврат чужого документа', async () => {
    const p = await addProduct(env, w.categoryId);
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 20, expiresOn: w.day(5) }]);
    const sale = (qty: number) =>
      call(env, w.keeperA.token)('POST', '/api/documents/sales', { locationId: w.locA.id, lines: [{ productId: p, quantity: qty }] }, { 'idempotency-key': 'kassa-0001-abc' });
    const first = await sale(2);
    expect(first.statusCode).toBe(201);
    const same = await sale(2);
    expect(same.statusCode).toBe(200);
    const other = await sale(7);
    expect(other.statusCode).toBe(422);
    expect(other.json().error.code).toBe('idempotency_conflict');
    expect(await remaining(env, p, w.locA.id)).toBe(18);
  });

  it('ключ одного пользователя не пересекается с ключом другого', async () => {
    const p = await addProduct(env, w.categoryId);
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 20, expiresOn: w.day(5) }]);
    const body = { locationId: w.locA.id, lines: [{ productId: p, quantity: 1 }] };
    const key = { 'idempotency-key': 'shared-key-1234' };
    const a = await call(env, w.keeperA.token)('POST', '/api/documents/sales', body, key);
    const b = await call(env, w.manager.token)('POST', '/api/documents/sales', body, key);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json().documentId).not.toBe(b.json().documentId);
    expect(await remaining(env, p, w.locA.id)).toBe(18);
  });

  it('ключ с недопустимыми символами отклоняется', async () => {
    const p = await addProduct(env, w.categoryId);
    const body = { locationId: w.locA.id, lines: [{ productId: p, quantity: 1 }] };
    for (const key of ['короткий', 'ab', 'a b c d e f g h', 'x'.repeat(129), 'ключ-на-русском-языке']) {
      expect((await call(env, w.manager.token)('POST', '/api/documents/sales', body, { 'idempotency-key': key })).statusCode, key).toBe(400);
    }
  });
});

describe('вход и источник запроса', () => {
  it('вход с чужого источника отклоняется, со своего и без заголовка проходит', async () => {
    const user = await createUser(env, { role: 'viewer' });
    const login = (headers: Record<string, string>) => env.app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { email: user.email, password: user.password } });
    const foreign = await login({ origin: 'https://evil.example' });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error.code).toBe('bad_origin');
    expect(foreign.cookies).toHaveLength(0);
    expect((await login({ origin: 'http://localhost:5173' })).statusCode).toBe(200);
    expect((await login({})).statusCode).toBe(200);
    expect((await login({ origin: 'null' })).statusCode).toBe(403);
  });
});

describe('подбор текущего пароля через смену пароля', () => {
  it('после пяти неудач запись блокируется, сессии закрываются, верный пароль уже не помогает', async () => {
    const user = await createUser(env, { role: 'manager' });
    const session = await loginAs(env, user);
    const change = (current: string) => call(env, session.token)('POST', '/api/auth/change-password', { currentPassword: current, newPassword: 'Совершенно-Новая-Фраза-77' });

    for (let i = 0; i < 5; i += 1) expect((await change('Неверный-пароль-1')).statusCode).toBe(400);
    // пятая неудача блокирует запись и закрывает сессии, поэтому токен доступа сразу перестаёт действовать
    expect((await change(TEST_PASSWORD)).statusCode).toBe(401);
    const row = await env.db.selectFrom('users').select(['locked_until', 'failed_attempts']).where('id', '=', user.id).executeTakeFirstOrThrow();
    expect(row.locked_until).not.toBeNull();
    expect(row.failed_attempts).toBe(5);
    const live = await env.db.selectFrom('refresh_tokens').select('id').where('user_id', '=', user.id).where('revoked_at', 'is', null).execute();
    expect(live).toHaveLength(0);

    const refresh = await env.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { zapas_rt: session.cookie } });
    expect(refresh.statusCode).toBe(401);
    const login = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password: user.password } });
    expect(login.statusCode).toBe(401);
  });
});

describe('блокировка при смене пароля без предела частоты', () => {
  it('запись заблокирована: даже верный текущий пароль отклоняется кодом account_locked', async () => {
    const roomy = await createTestEnv();
    try {
      const user = await createUser(roomy, { role: 'manager' });
      const session = await loginAs(roomy, user);
      const change = (current: string) => call(roomy, session.token)('POST', '/api/auth/change-password', { currentPassword: current, newPassword: 'Совершенно-Новая-Фраза-77' });
      // предел частоты для смены пароля зашит в маршрут (5 в минуту), поэтому блокируем напрямую, как это сделали бы пять неудач
      await roomy.db.updateTable('users').set({ locked_until: new Date(roomy.clock.now.getTime() + 600_000), failed_attempts: 5 }).where('id', '=', user.id).execute();
      const res = await change(TEST_PASSWORD);
      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe('account_locked');
    } finally {
      await roomy.close();
    }
  });
});

describe('точки', () => {
  it('точку с остатками отключить нельзя', async () => {
    const p = await addProduct(env, w.categoryId);
    await receive(env, w.manager.token, w.locB.id, [{ productId: p, quantity: 3, expiresOn: w.day(4) }]);
    const res = await call(env, w.admin.token)('PATCH', `/api/locations/${w.locB.id}`, { isActive: false });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('location_has_stock');
    const empty = await addLocation(env, 'Пустой склад');
    expect((await call(env, w.admin.token)('PATCH', `/api/locations/${empty.id}`, { isActive: false })).statusCode).toBe(200);
  });
});

describe('акции', () => {
  it('распроданная партия не остаётся в списке действующих акций', async () => {
    const p = await addProduct(env, w.categoryId, { price: 100, cost: 60 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 2, expiresOn: w.day(2) }]);
    const batch = await env.db.selectFrom('batches').select('id').executeTakeFirstOrThrow();
    await call(env, w.manager.token)('POST', '/api/promotions', { batchId: batch.id, percent: 30 });
    expect((await call(env, w.manager.token)('GET', '/api/promotions')).json()).toHaveLength(1);
    await call(env, w.keeperA.token)('POST', '/api/documents/sales', { locationId: w.locA.id, lines: [{ productId: p, quantity: 2 }] });
    expect((await call(env, w.manager.token)('GET', '/api/promotions')).json()).toHaveLength(0);
  });
});

describe('планировщик', () => {
  const deps = () => ({ db: env.db, config: env.config, clock: () => env.clock.now, notifier: env.notifier, log: console });

  it('убирает давно отработавшие сессии и не трогает действующие', async () => {
    const user = await createUser(env, { role: 'viewer' });
    const old = new Date(env.clock.now.getTime() - 5 * 86_400_000);
    const row = (hash: string, expires: Date, revoked: Date | null) => ({
      user_id: user.id,
      family_id: crypto.randomUUID(),
      token_hash: hash.padEnd(64, '0'),
      expires_at: expires,
      revoked_at: revoked,
      replaced_by: null,
      created_at: old,
      user_agent: null,
      ip: null,
    });
    await env.db
      .insertInto('refresh_tokens')
      .values([
        row('aa', old, null),
        row('bb', new Date(env.clock.now.getTime() + 86_400_000), old),
        row('cc', new Date(env.clock.now.getTime() + 86_400_000), null),
      ])
      .execute();
    env.clock.advance(2 * 3_600_000);
    await schedulerTick(deps());
    const left = await env.db.selectFrom('refresh_tokens').select('token_hash').where('user_id', '=', user.id).execute();
    expect(left.map((r) => r.token_hash.slice(0, 2))).toEqual(['cc']);
  });

  it('если сводку не удалось отправить, метка откатывается и отправка повторяется', async () => {
    await call(env, w.admin.token)('PUT', '/api/settings', { expiringSoonDays: 3, criticalDays: 1, forecastWindowDays: 28, reorderCoverDays: 7, lowPortionThreshold: 3, digestHour: 12 });
    const failing = { enabled: true, async send() { throw new Error('Telegram недоступен'); } };
    await expect(schedulerTick({ ...deps(), notifier: failing })).rejects.toThrow(/Telegram недоступен/);
    expect(await env.db.selectFrom('notification_log').select('id').where('kind', '=', 'digest').execute()).toHaveLength(0);
    await schedulerTick(deps());
    expect(env.notifier.messages.filter((m) => m.includes('Сводка на'))).toHaveLength(1);
  });
});

describe('настройка доверия к прокси', () => {
  const base = { NODE_ENV: 'development', DATABASE_URL: 'postgres://x', JWT_SECRET: 'x'.repeat(40) };
  const trust = (v?: string) => parseConfig({ ...base, ...(v === undefined ? {} : { TRUST_PROXY: v }) }).trustProxy;

  it('понимает «выкл», «вкл», число прыжков и список адресов', () => {
    expect(trust()).toBe(false);
    expect(trust('false')).toBe(false);
    expect(trust('true')).toBe(true);
    expect(trust('2')).toBe(2);
    expect(trust('10.0.0.1, 172.16.0.0/12')).toEqual(['10.0.0.1', '172.16.0.0/12']);
  });

  it('отвергает мусор', () => {
    expect(() => trust('все подряд')).toThrow(/TRUST_PROXY/);
    expect(() => trust('1.2.3.4; rm -rf')).toThrow(/TRUST_PROXY/);
  });
});

describe('подделка адреса клиента', () => {
  it('при выключенном доверии к прокси заголовок X-Forwarded-For не помогает обойти ограничение входа', async () => {
    const limited = await createTestEnv({ LOGIN_RATE_LIMIT_MAX: '3' });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        const r = await limited.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { 'x-forwarded-for': `203.0.113.${i + 1}` },
          payload: { email: 'a@example.ru', password: 'Неверный-пароль-1' },
        });
        codes.push(r.statusCode);
      }
      expect(codes).toEqual([401, 401, 401, 429, 429, 429]);
    } finally {
      await limited.close();
    }
  });
});

describe('кеш расчётов и фоновый стоп-лист', () => {
  it('запись сразу сбрасывает кеш: следующее чтение видит новые остатки', async () => {
    const p = await addProduct(env, w.categoryId, { cost: 10 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 10, expiresOn: w.day(9), unitCost: 10 }]);
    const dash = async () => (await call(env, w.manager.token)('GET', '/api/analytics/dashboard')).json().kpis.stockValue;
    expect(await dash()).toBe(100);
    expect(await dash()).toBe(100);
    await call(env, w.keeperA.token)('POST', '/api/documents/sales', { locationId: w.locA.id, lines: [{ productId: p, quantity: 4 }] });
    expect(await dash()).toBe(60);
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 1, expiresOn: w.day(9), unitCost: 10 }]);
    expect(await dash()).toBe(70);
  });

  it('цена в карточке тоже сбрасывает кеш', async () => {
    const p = await addProduct(env, w.categoryId, { price: 100, cost: 60 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 5, expiresOn: w.day(2), unitCost: 60 }]);
    const find = async () => (await call(env, w.manager.token)('GET', '/api/analytics/recommendations')).json().items.find((r: { type: string }) => r.type === 'discount');
    expect((await find()).action.percent).toBe(30);
    await call(env, w.manager.token)('PATCH', `/api/products/${p}`, { cost: 99 });
    // себестоимость почти равна цене: скидка в 30% уже ниже себестоимости, рекомендации быть не должно
    expect(await find()).toBeUndefined();
  });

  it('много операций подряд склеиваются в один пересчёт, а результат в итоге верный', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Редкий товар' });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 6, expiresOn: w.day(5) }]);
    await env.settle();
    await Promise.all(Array.from({ length: 6 }, () => call(env, w.keeperA.token)('POST', '/api/documents/sales', { locationId: w.locA.id, lines: [{ productId: p, quantity: 1 }] })));
    await env.settle();
    const stop = (await call(env, w.manager.token)('GET', '/api/stop-list')).json();
    expect(stop.entries.map((e: { name: string }) => e.name)).toEqual(['Редкий товар']);
    expect(await env.db.selectFrom('stop_list_state').select('entity_id').execute()).toHaveLength(1);
  });
});

describe('устаревший срез и стоп-лист', () => {
  const runtime = () => ({ db: env.db, config: env.config, clock: () => env.clock.now, notifier: env.notifier, log: console });

  it('старый срез не затирает состояние, записанное более свежим, и не дублирует уведомление', async () => {
    const { loadSnapshot } = await import('../src/modules/analytics/snapshot');
    const { syncStopList } = await import('../src/modules/stoplist/service');
    const p = await addProduct(env, w.categoryId, { name: 'Пельмени' });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 1, expiresOn: w.day(5) }]);
    await env.settle();
    await syncStopList(runtime(), [w.locA.id], await loadSnapshot(runtime(), [w.locA.id]), true); // первый проход: тихий
    env.notifier.messages.length = 0;

    const before = await loadSnapshot(runtime(), [w.locA.id]);
    await call(env, w.keeperA.token)('POST', '/api/documents/sales', { locationId: w.locA.id, lines: [{ productId: p, quantity: 1 }] });
    await env.settle();
    const after = await loadSnapshot(runtime(), [w.locA.id]);
    expect(after.seq).toBeGreaterThan(before.seq);

    await syncStopList(runtime(), [w.locA.id], after, true);
    expect(await env.db.selectFrom('stop_list_state').select('entity_id').execute()).toHaveLength(1);
    const notified = env.notifier.messages.length;

    // срез «до продажи» приходит позже: позиция уже в стопе, удалять её нельзя
    const late = await syncStopList(runtime(), [w.locA.id], before);
    expect(await env.db.selectFrom('stop_list_state').select('entity_id').execute()).toHaveLength(1);
    expect(late.since.size).toBe(1);

    // и следующий пересчёт по свежему срезу ничего нового не объявляет
    await syncStopList(runtime(), [w.locA.id], await loadSnapshot(runtime(), [w.locA.id]), true);
    expect(env.notifier.messages).toHaveLength(notified);
  });

  it('параллельные запросы стоп-листа и панели дают одно и то же и не плодят записей', async () => {
    const products = await Promise.all(Array.from({ length: 4 }, (_, i) => addProduct(env, w.categoryId, { name: `Позиция ${i}` })));
    for (const p of products) await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 1, expiresOn: w.day(5) }]);
    for (const p of products) await call(env, w.keeperA.token)('POST', '/api/documents/sales', { locationId: w.locA.id, lines: [{ productId: p, quantity: 1 }] });
    await env.settle();
    const answers = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        i % 2 === 0
          ? call(env, w.manager.token)('GET', '/api/stop-list')
          : call(env, w.manager.token)('GET', '/api/analytics/dashboard'),
      ),
    );
    expect(answers.every((r) => r.statusCode === 200)).toBe(true);
    const lists = answers.filter((_, i) => i % 2 === 0).map((r) => r.json().entries.map((e: { entityId: string }) => e.entityId).sort());
    expect(new Set(lists.map((l) => l.join())).size).toBe(1);
    expect(lists[0]).toHaveLength(4);
    expect(answers.filter((_, i) => i % 2 === 1).every((r) => r.json().kpis.stopListCount === 4)).toBe(true);
    expect(await env.db.selectFrom('stop_list_state').select('entity_id').execute()).toHaveLength(4);
  });
});

describe('повторы при взаимной блокировке', () => {
  it('временный отказ базы повторяется, постоянная ошибка нет', async () => {
    const { retryOnConflict } = await import('../src/lib/retry');
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
      return 'готово';
    };
    await expect(retryOnConflict(flaky)).resolves.toBe('готово');
    expect(calls).toBe(3);

    let hard = 0;
    await expect(retryOnConflict(async () => { hard += 1; throw Object.assign(new Error('нарушение'), { code: '23505' }); })).rejects.toThrow('нарушение');
    expect(hard).toBe(1);

    let always = 0;
    await expect(retryOnConflict(async () => { always += 1; throw Object.assign(new Error('снова'), { code: '40001' }); }, 3)).rejects.toThrow('снова');
    expect(always).toBe(3);
  });
});

describe('поиск продукта по штрихкоду', () => {
  async function product(barcode: string | null, over: Record<string, unknown> = {}) {
    const res = await call(env, w.manager.token)('POST', '/api/products', {
      sku: `BC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      name: 'Йогурт',
      categoryId: w.categoryId,
      unit: 'pcs',
      price: 80,
      cost: 50,
      ...(barcode ? { barcode } : {}),
      ...over,
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; name: string };
  }

  it('находит продукт по EAN-13 и по тому же товару в записи GTIN-14 или UPC-A', async () => {
    const p = await product('4006381333931', { name: 'Фломастер' });
    for (const code of ['4006381333931', '04006381333931']) {
      const res = await call(env, w.keeperA.token)('GET', `/api/products/by-barcode/${code}`);
      expect(res.statusCode, code).toBe(200);
      expect(res.json().id).toBe(p.id);
    }
    const upc = await product('036000291452', { name: 'Американский товар' });
    expect((await call(env, w.keeperA.token)('GET', '/api/products/by-barcode/0036000291452')).json().id).toBe(upc.id);
    expect((await call(env, w.keeperA.token)('GET', '/api/products/by-barcode/036000291452')).json().id).toBe(upc.id);
  });

  it('неизвестный код это 404, неверный формат это 400, без входа 401', async () => {
    expect((await call(env, w.keeperA.token)('GET', '/api/products/by-barcode/5901234123457')).statusCode).toBe(404);
    expect((await call(env, w.keeperA.token)('GET', '/api/products/by-barcode/123')).statusCode).toBe(400);
    expect((await call(env, w.keeperA.token)('GET', '/api/products/by-barcode/abcdefgh')).statusCode).toBe(400);
    expect((await call(env, null)('GET', '/api/products/by-barcode/4006381333931')).statusCode).toBe(401);
  });

  it('поиск доступен всем ролям, включая наблюдателя', async () => {
    await product('5901234123457');
    for (const s of [w.viewerA, w.keeperA, w.manager, w.admin]) {
      expect((await call(env, s.token)('GET', '/api/products/by-barcode/5901234123457')).statusCode).toBe(200);
    }
  });

  it('отключённый продукт находится, только если активного с этим кодом нет', async () => {
    const old = await product('4006381333931', { name: 'Старый' });
    await call(env, w.manager.token)('PATCH', `/api/products/${old.id}`, { isActive: false });
    expect((await call(env, w.keeperA.token)('GET', '/api/products/by-barcode/4006381333931')).json().name).toBe('Старый');
  });

  it('каталог для сканера: только активные продукты со штрихкодом', async () => {
    const a = await product('4006381333931', { name: 'С кодом' });
    await product(null, { name: 'Без кода' });
    const off = await product('5901234123457', { name: 'Отключён' });
    await call(env, w.manager.token)('PATCH', `/api/products/${off.id}`, { isActive: false });
    const res = await call(env, w.keeperA.token)('GET', '/api/products/scan-index');
    expect(res.statusCode).toBe(200);
    const names = res.json().items.map((i: { name: string }) => i.name);
    expect(names).toEqual(['С кодом']);
    expect(res.json().items[0].id).toBe(a.id);
    expect((await call(env, null)('GET', '/api/products/scan-index')).statusCode).toBe(401);
  });

  it('поиск по подстроке в списке продуктов по-прежнему понимает штрихкод', async () => {
    await product('4006381333931', { name: 'Фломастер' });
    const res = await call(env, w.keeperA.token)('GET', '/api/products?q=40063813');
    expect(res.json().items.map((i: { name: string }) => i.name)).toContain('Фломастер');
  });
});

describe('демо-штрихкоды', () => {
  it('все коды демо-данных проходят проверку контрольной цифры и различаются', async () => {
    const { demoBarcode } = await import('../src/db/seed/run');
    const { isValidGtin } = await import('@zapas/shared');
    const codes = Array.from({ length: 40 }, (_, i) => demoBarcode(i));
    expect(codes.every((c) => c.length === 13 && isValidGtin(c))).toBe(true);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
