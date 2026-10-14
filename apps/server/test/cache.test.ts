import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from '../src/db/client';
import { EventHub } from '../src/lib/events';
import { cacheStats, getSnapshot, invalidateSnapshots } from '../src/modules/analytics/snapshot';
import { ClusterSync } from '../src/modules/cluster/sync';
import { hubFor } from '../src/lib/events';
import { addProduct, createWorld, receive, type World } from './fixtures';
import { call, createTestEnv, createUser, type TestEnv } from './helpers';

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

const admin = () => call(env, w.admin.token);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (check: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(20);
  }
  return check();
};

async function registerOrg() {
  const res = await env.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { organizationName: 'ООО «Кеш»', fullName: 'Орлова Наталья Сергеевна', email: 'cache@example.ru', password: 'Хорошая-длинная-фраза-91' },
  });
  const token = res.json().accessToken as string;
  const loc = await call(env, token)('POST', '/api/locations', { code: 'one', name: 'Кафе «Один»', kind: 'cafe', address: 'Ростов' });
  expect(loc.statusCode, loc.body).toBe(201);
  return token;
}

describe('кеш расчётов в работе', () => {
  it('ответ помечен X-Cache: промах, попадание, после записи снова промах', async () => {
    const first = await admin()('GET', '/api/analytics/dashboard');
    expect(first.headers['x-cache']).toBe('MISS');
    expect(String(first.headers['server-timing'])).toMatch(/^cache;desc="MISS";dur=\d/);
    const second = await admin()('GET', '/api/analytics/dashboard');
    expect(second.headers['x-cache']).toBe('HIT');

    const p = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l' });
    await receive(env, w.admin.token, w.locA.id, [{ productId: p, quantity: 10, expiresOn: w.day(5) }]);
    const third = await admin()('GET', '/api/analytics/dashboard');
    expect(third.headers['x-cache']).toBe('MISS');
    // ответы без обращения к кешу заголовка не получают
    expect((await admin()('GET', '/api/health')).headers['x-cache']).toBeUndefined();
  });

  it('запись одной организации не сбрасывает срез другой', async () => {
    const other = await registerOrg();
    const asOther = call(env, other);
    expect((await asOther('GET', '/api/analytics/dashboard')).headers['x-cache']).toBe('MISS');
    expect((await asOther('GET', '/api/analytics/dashboard')).headers['x-cache']).toBe('HIT');

    // запись в организации по умолчанию
    const p = await addProduct(env, w.categoryId, { name: 'Кефир', unit: 'l' });
    await receive(env, w.admin.token, w.locA.id, [{ productId: p, quantity: 5, expiresOn: w.day(4) }]);

    expect((await asOther('GET', '/api/analytics/dashboard')).headers['x-cache']).toBe('HIT');
    expect((await admin()('GET', '/api/analytics/dashboard')).headers['x-cache']).toBe('MISS');
    expect(cacheStats(env.db).snapshots.taggedInvalidations).toBeGreaterThan(0);
  });

  it('запись самой организации сбрасывает её срез: первая точка видна сразу', async () => {
    const other = await registerOrg();
    const asOther = call(env, other);
    await asOther('GET', '/api/analytics/dashboard');
    const add = await asOther('POST', '/api/locations', { code: 'two', name: 'Кафе «Два»', kind: 'cafe' });
    expect(add.statusCode).toBe(201);
    expect((await asOther('GET', '/api/analytics/dashboard')).headers['x-cache']).toBe('MISS');
  });

  it('вход, обновление сессии и привязка Telegram кеш не сбрасывают', async () => {
    await admin()('GET', '/api/analytics/dashboard');
    const before = cacheStats(env.db).snapshots.invalidations;
    const other = await createUser(env, { role: 'manager' });
    const login = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: other.email, password: other.password } });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((c) => c.name === 'zapas_rt');
    const refresh = await env.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { zapas_rt: cookie?.value ?? '' } });
    expect(refresh.statusCode).toBe(200);
    expect((await call(env, login.json().accessToken)('POST', '/api/telegram/link-code')).statusCode).toBe(201);
    expect(cacheStats(env.db).snapshots.invalidations).toBe(before);
    expect((await admin()('GET', '/api/analytics/dashboard')).headers['x-cache']).toBe('HIT');
  });

  it('запись без пользователя (кабинет поставщика) сбрасывает всё', async () => {
    await admin()('GET', '/api/analytics/dashboard');
    invalidateSnapshots(env.db);
    expect((await admin()('GET', '/api/analytics/dashboard')).headers['x-cache']).toBe('MISS');
  });
});

describe('страница кеша для администратора', () => {
  it('отдаёт счётчики, закрыта для остальных и не раскрывает ключи', async () => {
    await admin()('GET', '/api/analytics/dashboard');
    await admin()('GET', '/api/analytics/dashboard');
    const res = await admin()('GET', '/api/admin/cache');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.snapshots.hits).toBeGreaterThanOrEqual(1);
    expect(body.snapshots.misses).toBeGreaterThanOrEqual(1);
    expect(body.snapshots.ttlSeconds).toBe(20);
    expect(body.snapshots.hitRatio).toBeGreaterThan(0);
    expect(body.cluster).toMatchObject({ enabled: false, connected: false });
    expect(JSON.stringify(body)).not.toContain(w.locA.id);

    expect((await call(env, w.manager.token)('GET', '/api/admin/cache')).statusCode).toBe(403);
    expect((await call(env, null)('GET', '/api/admin/cache')).statusCode).toBe(401);
  });

  it('сброс очищает кеш своей организации и пишется в журнал', async () => {
    await admin()('GET', '/api/analytics/dashboard');
    const before = cacheStats(env.db).snapshots.invalidations;
    const flush = await admin()('POST', '/api/admin/cache/flush');
    expect(flush.statusCode).toBe(204);
    // сам запрос сброса тоже запись и сбрасывает кеш, поэтому счётчик растёт не меньше чем на единицу
    expect(cacheStats(env.db).snapshots.invalidations).toBeGreaterThan(before);
    expect((await admin()('GET', '/api/analytics/dashboard')).headers['x-cache']).toBe('MISS');
    const audit = (await admin()('GET', '/api/audit?action=cache.flush')).json();
    expect(audit.items.length).toBe(1);
    expect((await call(env, w.manager.token)('POST', '/api/admin/cache/flush')).statusCode).toBe(403);
  });
});

describe('поток обновлений по организациям', () => {
  it('сигнал организации не будит клиентов другой, общий сигнал будит всех', async () => {
    const hub = new EventHub(10);
    const a: number[] = [];
    const b: number[] = [];
    const all: number[] = [];
    hub.subscribe(() => a.push(1), 'org-a');
    hub.subscribe(() => b.push(1), 'org-b');
    hub.subscribe(() => all.push(1));
    hub.publish('org-a');
    await sleep(40);
    expect([a.length, b.length, all.length]).toEqual([1, 0, 1]);
    hub.publish(null);
    await sleep(40);
    expect([a.length, b.length, all.length]).toEqual([2, 1, 2]);
    hub.publish('org-a');
    hub.publish('org-b');
    await sleep(40);
    expect([a.length, b.length, all.length]).toEqual([3, 2, 3]);
    hub.stop();
  });
});

describe('несколько экземпляров приложения', () => {
  let second: DbHandle;
  let syncA: ClusterSync;
  let syncB: ClusterSync;

  beforeAll(async () => {
    second = createDb(env.config.databaseUrl, 3);
    syncA = new ClusterSync(env.db, env.config.databaseUrl, console);
    syncB = new ClusterSync(second.db, env.config.databaseUrl, console);
    await syncA.start();
    await syncB.start();
  });
  afterAll(async () => {
    await syncA.stop();
    await syncB.stop();
    await second.close();
  });

  it('запись на одном экземпляре сразу сбрасывает кеш и будит клиентов другого', async () => {
    const depsB = { ...env.deps, db: second.db };
    await getSnapshot(depsB, null);
    const before = cacheStats(second.db).snapshots;
    expect(before.entries).toBe(1);
    let woken = 0;
    hubFor(second.db).subscribe(() => (woken += 1));

    invalidateSnapshots(env.db, '00000000-0000-4000-8000-000000000001');
    expect(await until(() => cacheStats(second.db).snapshots.invalidations === before.invalidations + 1)).toBe(true);
    expect(cacheStats(second.db).snapshots.taggedInvalidations).toBe(before.taggedInvalidations + 1);
    expect(await until(() => woken > 0)).toBe(true);

    // свои сообщения экземпляр не обрабатывает
    expect(syncA.status().received).toBe(0);
    expect(syncA.status().sent).toBeGreaterThan(0);
    expect(syncB.status().received).toBeGreaterThan(0);
    expect(syncB.status()).toMatchObject({ connected: true, sendErrors: 0 });
  });

  it('сброс всего кеша тоже доходит, а чужой сигнал дальше не рассылается', async () => {
    const before = cacheStats(second.db).snapshots.invalidations;
    const sentB = syncB.status().sent;
    invalidateSnapshots(env.db);
    expect(await until(() => cacheStats(second.db).snapshots.invalidations === before + 1)).toBe(true);
    await sleep(100);
    expect(syncB.status().sent).toBe(sentB);
  });

  it('админ видит состояние синхронизации на странице кеша', async () => {
    const body = (await admin()('GET', '/api/admin/cache')).json();
    expect(body.cluster).toMatchObject({ enabled: true, connected: true });
  });
});
