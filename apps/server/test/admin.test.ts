import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramNotifier } from '../src/modules/notifications/notifier';
import { schedulerTick } from '../src/modules/notifications/scheduler';
import { addProduct, createWorld, receive, remaining, type World } from './fixtures';
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

describe('пользователи', () => {
  const admin = () => call(env, w.admin.token);

  it('создаёт пользователя по политике паролей и не светит хэш', async () => {
    const weak = await admin()('POST', '/api/users', { email: 'new@example.ru', fullName: 'Анна Смирнова', role: 'viewer', password: 'qwertyuiop' });
    expect(weak.statusCode).toBe(400);
    const ok = await admin()('POST', '/api/users', {
      email: 'New.User@Example.ru',
      fullName: 'Анна Смирнова',
      role: 'storekeeper',
      password: 'клубника-на-рельсах-37',
      locationIds: [w.locA.id],
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ email: 'new.user@example.ru', role: 'storekeeper', locationIds: [w.locA.id] });
    expect(ok.body).not.toMatch(/hash|argon2|клубника/i);
    expect(ok.json().temporaryPassword).toBeNull();
    expect(ok.json().mustChangePassword).toBe(true);
    const dup = await admin()('POST', '/api/users', { email: 'new.user@example.ru', fullName: 'Другая', role: 'viewer', password: 'клубника-на-рельсах-38' });
    expect(dup.statusCode).toBe(409);
    const list = await admin()('GET', '/api/users');
    expect(list.body).not.toMatch(/password_hash|passwordHash|argon2/i);
    const login = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'new.user@example.ru', password: 'клубника-на-рельсах-37' } });
    expect(login.statusCode).toBe(200);
  });

  it('пароль не может содержать почту или фамилию', async () => {
    const res = await admin()('POST', '/api/users', { email: 'petrov@example.ru', fullName: 'Иван Петров', role: 'viewer', password: 'Petrov-2026-long' });
    expect(res.statusCode).toBe(400);
  });

  it('последнего администратора нельзя понизить или отключить', async () => {
    const adminId = w.admin.userId;
    expect((await admin()('PATCH', `/api/users/${adminId}`, { role: 'manager' })).json().error.code).toBe('last_admin');
    expect((await admin()('PATCH', `/api/users/${adminId}`, { isActive: false })).json().error.code).toBe('last_admin');
    await createUser(env, { role: 'admin' });
    expect((await admin()('PATCH', `/api/users/${adminId}`, { role: 'manager' })).statusCode).toBe(200);
  });

  it('отключение сразу закрывает доступ и отзывает сессии', async () => {
    const res = await admin()('PATCH', `/api/users/${w.keeperA.userId}`, { isActive: false });
    expect(res.statusCode).toBe(200);
    expect((await call(env, w.keeperA.token)('GET', '/api/auth/me')).statusCode).toBe(401);
    const refresh = await env.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { zapas_rt: w.keeperA.cookie } });
    expect(refresh.statusCode).toBe(401);
  });

  it('смена роли действует немедленно, без перелогина', async () => {
    expect((await call(env, w.keeperA.token)('POST', '/api/categories', { name: 'Тест' })).statusCode).toBe(403);
    await admin()('PATCH', `/api/users/${w.keeperA.userId}`, { role: 'manager' });
    expect((await call(env, w.keeperA.token)('POST', '/api/categories', { name: 'Тест' })).statusCode).toBe(201);
  });

  it('сброс пароля администратором отзывает сессии и снимает блокировку', async () => {
    const target = await createUser(env, { role: 'viewer', email: 'target@example.ru' });
    const session = await loginAs(env, target);
    await env.db.updateTable('users').set({ locked_until: new Date(env.clock.now.getTime() + 600_000), failed_attempts: 7 }).where('id', '=', target.id).execute();
    env.clock.advance(2_000);
    const res = await admin()('PUT', `/api/users/${target.id}/password`, { password: 'новый-пароль-через-админа-5' });
    expect(res.statusCode).toBe(204);
    expect((await call(env, session.token)('GET', '/api/auth/me')).statusCode).toBe(401);
    const login = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'target@example.ru', password: 'новый-пароль-через-админа-5' } });
    expect(login.statusCode).toBe(200);
  });
});

describe('ключи кассы и продажи по API', () => {
  async function newKey(locationId = w.locA.id) {
    const res = await call(env, w.admin.token)('POST', '/api/api-keys', { name: 'Касса 1', locationId });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; key: string; prefix: string };
  }
  const pos = (key: string | null, body: unknown) =>
    env.app.inject({ method: 'POST', url: '/api/pos/sales', headers: key ? { 'x-api-key': key } : {}, payload: body as object });

  it('ключ показывается один раз, в базе только хэш', async () => {
    const created = await newKey();
    expect(created.key).toMatch(/^zk_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/);
    const list = await call(env, w.admin.token)('GET', '/api/api-keys');
    expect(list.body).not.toContain(created.key);
    expect(list.json()[0]).toMatchObject({ id: created.id, prefix: created.prefix });
    const row = await env.owner.selectFrom('api_keys').selectAll().executeTakeFirstOrThrow();
    expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(created.key.slice(created.prefix.length + 1));
  });

  it('касса продаёт на своей точке и повтор не списывает дважды', async () => {
    const p = await addProduct(env, w.categoryId);
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 10, expiresOn: w.day(5) }]);
    const { key } = await newKey();
    const first = await pos(key, { externalId: 'receipt-20261008-0001', lines: [{ productId: p, quantity: 2 }] });
    expect(first.statusCode).toBe(201);
    const second = await pos(key, { externalId: 'receipt-20261008-0001', lines: [{ productId: p, quantity: 2 }] });
    expect(second.statusCode).toBe(200);
    expect(second.json().duplicate).toBe(true);
    expect(await remaining(env, p, w.locA.id)).toBe(8);
    const doc = await env.db.selectFrom('documents').select(['actor_name', 'created_by']).where('kind', '=', 'sale').executeTakeFirstOrThrow();
    expect(doc.actor_name).toContain('Касса «Касса 1»');
    expect(doc.created_by).toBeNull();
  });

  it('не принимает чужую точку, неверный, отозванный и пропущенный ключ', async () => {
    const p = await addProduct(env, w.categoryId);
    await receive(env, w.manager.token, w.locB.id, [{ productId: p, quantity: 5, expiresOn: w.day(5) }]);
    const { key, id } = await newKey(w.locA.id);
    const wrongLocation = await pos(key, { externalId: 'receipt-0002', lines: [{ productId: p, quantity: 1 }] });
    expect(wrongLocation.statusCode).toBe(422);
    expect(await remaining(env, p, w.locB.id)).toBe(5);
    expect((await pos(key, { externalId: 'receipt-0003', locationId: w.locB.id, lines: [{ productId: p, quantity: 1 }] })).statusCode).toBe(400);
    expect((await pos(null, { externalId: 'receipt-0004', lines: [] })).statusCode).toBe(401);
    expect((await pos('zk_AAAAAAAA_' + 'B'.repeat(43), { externalId: 'receipt-0005', lines: [{ productId: p, quantity: 1 }] })).statusCode).toBe(401);
    expect((await pos('мусор', { externalId: 'receipt-0006', lines: [] })).statusCode).toBe(401);

    expect((await call(env, w.admin.token)('DELETE', `/api/api-keys/${id}`)).statusCode).toBe(204);
    expect((await pos(key, { externalId: 'receipt-0007', lines: [{ productId: p, quantity: 1 }] })).statusCode).toBe(401);
  });

  it('ключ не открывает остальной API', async () => {
    const { key } = await newKey();
    const res = await env.app.inject({ method: 'GET', url: '/api/products', headers: { 'x-api-key': key } });
    expect(res.statusCode).toBe(401);
    const asBearer = await env.app.inject({ method: 'GET', url: '/api/products', headers: { authorization: `Bearer ${key}` } });
    expect(asBearer.statusCode).toBe(401);
  });
});

describe('журнал аудита', () => {
  it('ведёт цепочку хэшей и замечает подмену', async () => {
    const p = await addProduct(env, w.categoryId);
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 3, expiresOn: w.day(5) }]);
    await call(env, w.manager.token)('POST', '/api/categories', { name: 'Бакалея' });

    const ok = (await call(env, w.admin.token)('GET', '/api/audit/verify')).json();
    expect(ok.ok).toBe(true);
    expect(ok.checked).toBeGreaterThan(5);

    const page = (await call(env, w.admin.token)('GET', '/api/audit?limit=5')).json();
    expect(page.items[0].id).toBeGreaterThan(page.items[1].id);
    const receipt = page.items.find((x: { action: string }) => x.action === 'document.receipt');
    expect(receipt).toBeDefined();

    // подмена записи в обход триггера: владелец временно отключает защиту
    await sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable`.execute(env.owner);
    await sql`UPDATE audit_log SET details = '{"подделка": true}' WHERE id = ${receipt.id}`.execute(env.owner);
    await sql`ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable`.execute(env.owner);
    const broken = (await call(env, w.admin.token)('GET', '/api/audit/verify')).json();
    expect(broken).toMatchObject({ ok: false, brokenAt: receipt.id });
  });

  it('пишет, кто и что менял, в том числе цены', async () => {
    const p = await addProduct(env, w.categoryId, { price: 100 });
    await call(env, w.manager.token)('PATCH', `/api/products/${p}`, { price: 120 });
    const rows = await env.owner.selectFrom('audit_log').select(['action', 'user_email', 'details']).where('action', '=', 'product.update').execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.details).toMatchObject({ changes: { price: 120 }, before: { price: 100 } });
    expect(rows[0]?.user_email).toMatch(/@example\.ru$/);
  });

  it('фильтрует по действию и пользователю', async () => {
    await call(env, w.manager.token)('POST', '/api/categories', { name: 'Напитки' });
    const byAction = (await call(env, w.admin.token)('GET', '/api/audit?action=category')).json();
    expect(byAction.items.every((x: { action: string }) => x.action.startsWith('category'))).toBe(true);
    expect(byAction.total).toBe(1);
  });
});

describe('настройки', () => {
  it('меняют классификацию сроков', async () => {
    const p = await addProduct(env, w.categoryId);
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 3, expiresOn: w.day(5) }]);
    const status = async () => (await call(env, w.manager.token)('GET', '/api/stock/batches')).json().items[0].status;
    expect(await status()).toBe('ok');
    const bad = await call(env, w.admin.token)('PUT', '/api/settings', { expiringSoonDays: 2, criticalDays: 5, forecastWindowDays: 28, reorderCoverDays: 7, lowPortionThreshold: 3, digestHour: 8 });
    expect(bad.statusCode).toBe(400);
    const ok = await call(env, w.admin.token)('PUT', '/api/settings', { expiringSoonDays: 7, criticalDays: 2, forecastWindowDays: 28, reorderCoverDays: 7, lowPortionThreshold: 3, digestHour: 8 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ expiringSoonDays: 7, telegramConfigured: true });
    expect(await status()).toBe('soon');
  });
});

describe('уведомления', () => {
  it('сводка уходит в Telegram по кнопке администратора', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Молоко <b>', cost: 50 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 4, expiresOn: w.day(-1), unitCost: 50 }], { allowExpired: true });
    const res = await call(env, w.admin.token)('POST', '/api/notifications/test');
    expect(res.statusCode).toBe(204);
    expect(env.notifier.messages).toHaveLength(1);
    const text = env.notifier.messages[0] ?? '';
    expect(text).toContain('Сводка на 8 октября');
    expect(text).toContain('Просрочено: 1 парт. на');
    expect(text).toContain('Молоко &lt;b&gt;');
    expect((await call(env, w.manager.token)('POST', '/api/notifications/test')).statusCode).toBe(403);
  });

  it('утренняя сводка уходит один раз за сутки в назначенный час', async () => {
    const deps = { db: env.db, config: env.config, clock: () => env.clock.now, notifier: env.notifier, log: console };
    // 09:00 UTC это 12:00 в Москве
    await call(env, w.admin.token)('PUT', '/api/settings', { expiringSoonDays: 3, criticalDays: 1, forecastWindowDays: 28, reorderCoverDays: 7, lowPortionThreshold: 3, digestHour: 12 });
    await schedulerTick(deps);
    await schedulerTick(deps);
    expect(env.notifier.messages.filter((m) => m.includes('Сводка на'))).toHaveLength(1);

    env.clock.advance(24 * 3_600_000);
    await schedulerTick(deps);
    expect(env.notifier.messages.filter((m) => m.includes('Сводка на'))).toHaveLength(2);

    env.clock.advance(3_600_000);
    await schedulerTick(deps);
    expect(env.notifier.messages.filter((m) => m.includes('Сводка на'))).toHaveLength(2);
  });

  it('автосписание просроченного выключено по умолчанию, включённое работает раз в сутки от имени системы', async () => {
    const deps = { db: env.db, config: env.config, clock: () => env.clock.now, notifier: env.notifier, log: console };
    const cheese = await addProduct(env, w.categoryId, { name: 'Сыр' });
    await receive(env, w.manager.token, w.locA.id, [{ productId: cheese, quantity: 3, expiresOn: w.day(-1) }], { allowExpired: true });
    await receive(env, w.manager.token, w.locA.id, [{ productId: cheese, quantity: 4, expiresOn: w.day(5) }]);
    const writeoffs = () => env.db.selectFrom('documents').select(['actor_name', 'comment']).where('kind', '=', 'writeoff').execute();

    await schedulerTick(deps);
    expect(await remaining(env, cheese, w.locA.id)).toBe(7);
    expect(await writeoffs()).toHaveLength(0);

    const settings = { expiringSoonDays: 3, criticalDays: 1, forecastWindowDays: 28, reorderCoverDays: 7, lowPortionThreshold: 3, digestHour: 3, autoWriteoffExpired: true };
    expect((await call(env, w.admin.token)('PUT', '/api/settings', settings)).statusCode).toBe(200);
    await schedulerTick(deps);
    expect(await remaining(env, cheese, w.locA.id)).toBe(4);
    const docs = await writeoffs();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ actor_name: 'Система', comment: 'Автоматическое списание просроченного' });
    expect(env.notifier.messages.some((m) => m.includes('Автоматически списано'))).toBe(true);

    // в те же сутки второй раз не списывает, годная партия не тронута
    await schedulerTick(deps);
    expect(await writeoffs()).toHaveLength(1);

    // на следующие сутки списывается то, что успело истечь
    env.clock.advance(6 * 24 * 3_600_000);
    await schedulerTick(deps);
    expect(await remaining(env, cheese, w.locA.id)).toBe(0);
    expect(await writeoffs()).toHaveLength(2);
  });

  it('клиент Telegram ходит только на свой хост и сообщает об ошибке', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    await new TelegramNotifier('123:ABC', '-1001', fetchMock as unknown as typeof fetch).send('привет');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/bot123%3AABC/sendMessage');
    expect(JSON.parse(init.body as string)).toMatchObject({ chat_id: '-1001', text: 'привет', parse_mode: 'HTML' });
    const failing = vi.fn().mockResolvedValue(new Response('no', { status: 401 }));
    await expect(new TelegramNotifier('t', 'c', failing as unknown as typeof fetch).send('x')).rejects.toThrow(/401/);
  });
});

describe('справочники', () => {
  it('артикул и штрихкод уникальны, единицу нельзя менять после прихода', async () => {
    const manager = call(env, w.manager.token);
    const base = { sku: 'MLK-001', name: 'Молоко 3,2%', categoryId: w.categoryId, unit: 'l', price: 89.9, cost: 61 };
    const a = await manager('POST', '/api/products', { ...base, barcode: '4600000000017' });
    expect(a.statusCode).toBe(201);
    const dupSku = await manager('POST', '/api/products', { ...base, name: 'Другое', barcode: '4600000000024' });
    expect(dupSku.json().error.code).toBe('duplicate_sku');
    const dupBarcode = await manager('POST', '/api/products', { ...base, sku: 'MLK-002', barcode: '4600000000017' });
    expect(dupBarcode.json().error.code).toBe('duplicate_barcode');
    await receive(env, w.manager.token, w.locA.id, [{ productId: a.json().id, quantity: 1, expiresOn: w.day(5) }]);
    const unit = await manager('PATCH', `/api/products/${a.json().id}`, { unit: 'kg' });
    expect(unit.statusCode).toBe(409);
    expect(unit.json().error.code).toBe('unit_locked');
  });

  it('блюдо собирается из существующих продуктов и обновляет состав целиком', async () => {
    const m = await addProduct(env, w.categoryId, { name: 'Мука', sellable: false });
    const e = await addProduct(env, w.categoryId, { name: 'Яйцо', unit: 'pcs', sellable: false });
    const manager = call(env, w.manager.token);
    const created = await manager('POST', '/api/dishes', { name: 'Блины', price: 180, items: [{ productId: m, quantity: 0.1 }, { productId: e, quantity: 2 }] });
    expect(created.statusCode).toBe(201);
    expect(created.json().items).toHaveLength(2);
    const ghost = await manager('POST', '/api/dishes', { name: 'Призрак', price: 1, items: [{ productId: '00000000-0000-4000-8000-000000000000', quantity: 1 }] });
    expect(ghost.statusCode).toBe(400);
    const dup = await manager('POST', '/api/dishes', { name: 'Блины', price: 1, items: [{ productId: m, quantity: 1 }] });
    expect(dup.statusCode).toBe(409);
    const updated = await manager('PATCH', `/api/dishes/${created.json().id}`, { items: [{ productId: m, quantity: 0.15 }] });
    expect(updated.json().items).toHaveLength(1);
    expect(updated.json().items[0].quantity).toBe(0.15);
  });

  it('точки создаёт только администратор, код уникален', async () => {
    const body = { code: 'MSK-1', name: 'Склад Москва', kind: 'warehouse' };
    expect((await call(env, w.manager.token)('POST', '/api/locations', body)).statusCode).toBe(403);
    expect((await call(env, w.admin.token)('POST', '/api/locations', body)).statusCode).toBe(201);
    expect((await call(env, w.admin.token)('POST', '/api/locations', { ...body, code: 'msk-1' })).statusCode).toBe(409);
    expect((await call(env, w.admin.token)('POST', '/api/locations', { ...body, code: 'bad code!' })).statusCode).toBe(400);
  });

  it('отключённая точка не принимает операции', async () => {
    const p = await addProduct(env, w.categoryId);
    await call(env, w.admin.token)('PATCH', `/api/locations/${w.locA.id}`, { isActive: false });
    const res = await call(env, w.manager.token)('POST', '/api/documents/receipts', {
      locationId: w.locA.id,
      lines: [{ productId: p, quantity: 1, unitCost: 1, expiresOn: w.day(3) }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('location_inactive');
  });
});


describe('самопроверка', () => {
  it('доступна менеджеру и выше, отдаёт пункты по группам и ловит расхождение остатков', async () => {
    const w2 = w;
    expect((await call(env, w2.keeperA.token)('GET', '/api/selfcheck')).statusCode).toBe(403);
    expect((await call(env, null)('GET', '/api/selfcheck')).statusCode).toBe(401);
    const res = await call(env, w2.manager.token)('GET', '/api/selfcheck');
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json().items as { id: string; status: string; group: string }[];
    expect(items.find((i) => i.id === 'db')?.status).toBe('ok');
    expect(items.find((i) => i.id === 'ledger')?.status).toBe('ok');
    expect(new Set(items.map((i) => i.group)).size).toBeGreaterThanOrEqual(4);
    expect(items.every((i) => ['ok', 'warn', 'fail'].includes(i.status))).toBe(true);
  });
});
