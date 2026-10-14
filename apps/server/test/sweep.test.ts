import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROLE_RANK, type Role } from '@zapas/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RouteInfo } from '../src/plugins/access';
import { createWorld, type World } from './fixtures';
import { createTestEnv, type TestEnv } from './helpers';

let env: TestEnv;
let w: World;
const UUID = '5b3f6a52-5d6e-4f55-9d0b-1f7f8f0f7a11';

beforeAll(async () => {
  env = await createTestEnv();
  await env.reset();
  w = await createWorld(env);
});
afterAll(() => env.close());

const concrete = (url: string, value = UUID) => url.replace(/:[A-Za-z]+/g, value);
const routes = (): RouteInfo[] => env.app.routeTable;
/** Поток событий не завершается сам, через inject его не обойти: он проверяется отдельно в events.test.ts. */
const isStream = (r: RouteInfo): boolean => r.method === 'GET' && r.url === '/api/events';
const tokens = (): Record<Role, string> => ({ viewer: w.viewerA.token, waiter: w.waiterA.token, storekeeper: w.keeperA.token, manager: w.manager.token, admin: w.admin.token });
const send = (token: string | null, r: RouteInfo, url = concrete(r.url), payload?: string) =>
  env.app.inject({
    method: r.method as 'GET',
    url,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(payload !== undefined ? { payload } : r.method === 'GET' || r.method === 'DELETE' ? {} : { payload: {} }),
  });

describe('таблица маршрутов', () => {
  it('открытыми без входа остаются только те, что должны', () => {
    const open = routes().filter((r) => r.access.kind === 'public').map((r) => `${r.method} ${r.url}`).sort();
    expect(open).toEqual([
      'GET /api/health',
      'GET /api/health/ready',
      'GET /api/supplier-gateway/orders/:id',
      'GET /api/supplier-portal/link',
      'POST /api/auth/login',
      'POST /api/auth/logout',
      'POST /api/auth/refresh',
      'POST /api/auth/register',
      'POST /api/supplier-gateway/lookup',
      'POST /api/supplier-gateway/status',
    ]);
  });

  it('маршрутов достаточно много, чтобы проверка что-то значила', () => {
    expect(routes().length).toBeGreaterThan(60);
  });
});

describe('права на всех маршрутах', () => {
  it('аноним получает 401, роль ниже требуемой 403, достаточная роль не получает отказа в правах', async () => {
    const bad: string[] = [];
    for (const r of routes()) {
      if (r.access.kind === 'public') continue;
      const label = `${r.method} ${r.url}`;

      const anon = await send(null, r);
      if (anon.statusCode !== 401) bad.push(`${label}: аноним ${anon.statusCode}`);
      if (isStream(r)) continue;

      for (const [role, token] of Object.entries(tokens()) as [Role, string][]) {
        const res = await send(token, r);
        if (r.access.kind === 'pos') {
          if (res.statusCode !== 401) bad.push(`${label}: пользователь ${role} получил ${res.statusCode} на маршруте кассы`);
          continue;
        }
        const allowed = ROLE_RANK[role] >= ROLE_RANK[r.access.minRole];
        if (!allowed && res.statusCode !== 403) bad.push(`${label}: ${role} без прав получил ${res.statusCode}`);
        if (allowed && (res.statusCode === 401 || res.statusCode === 403)) bad.push(`${label}: ${role} с правами получил ${res.statusCode}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('устойчивость к мусорным данным', () => {
  const bodies = [
    'null',
    '[]',
    '"строка"',
    '123',
    'true',
    '{}',
    '{"__proto__":{"polluted":"yes"}}',
    '{"constructor":{"prototype":{"polluted":"yes"}}}',
    `{"a":${'['.repeat(400)}${']'.repeat(400)}}`,
    JSON.stringify({ lines: Array.from({ length: 5000 }, (_, i) => ({ productId: UUID, quantity: i })) }),
    JSON.stringify(Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`k${i}`, i]))),
    JSON.stringify({ name: '\u0000', reason: '\ud800', comment: '‮', email: '\u0000@a.ru', password: '\u0000', q: '\u0000' }),
    JSON.stringify({ locationId: UUID, lines: [{ productId: UUID, quantity: 1e308 }, { productId: UUID, quantity: -0 }, { productId: UUID, quantity: 'NaN' }] }),
    '{"name":',
    '\u0000\u0001\u0002',
  ];

  it('ни один маршрут не отвечает 5xx на плохое тело, а ошибки приходят в общем формате', async () => {
    const problems: string[] = [];
    for (const r of routes()) {
      if (r.access.kind !== 'user' || r.method === 'GET' || r.method === 'DELETE') continue;
      for (const body of bodies) {
        const res = await send(w.admin.token, r, concrete(r.url), body);
        if (res.statusCode >= 500) problems.push(`${r.method} ${r.url} [${body.slice(0, 40)}] → ${res.statusCode}`);
        else if (res.statusCode >= 400) {
          try {
            const json = res.json();
            if (!json?.error?.code || !json?.requestId) problems.push(`${r.method} ${r.url}: нестандартный формат ошибки ${res.body.slice(0, 80)}`);
          } catch {
            problems.push(`${r.method} ${r.url}: ответ не JSON`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('ни один маршрут не падает на плохих параметрах пути и строки запроса', async () => {
    const pathValues = ['%00', 'не-uuid', '../../etc/passwd', 'a'.repeat(300), "' OR 1=1--", '%F0%9F%92%A9', '0'.repeat(36)];
    const query = '?limit=-1&offset=abc&q=%00&locationId=%00&status=%27%3B--&from=9999-99-99&to=x&type=%00&flag[]=x&__proto__=1&documentId=zz&productId=%00&active=maybe';
    const problems: string[] = [];
    for (const r of routes()) {
      if (r.access.kind !== 'user' || isStream(r)) continue;
      for (const value of pathValues) {
        const res = await send(w.admin.token, r, concrete(r.url, value));
        if (res.statusCode >= 500) problems.push(`${r.method} ${r.url} путь «${value.slice(0, 20)}» → ${res.statusCode}`);
      }
      if (r.method === 'GET') {
        const res = await send(w.admin.token, r, concrete(r.url) + query);
        if (res.statusCode >= 500) problems.push(`${r.method} ${r.url} запрос → ${res.statusCode}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('любая ошибка разбора адреса возвращается в общем формате', async () => {
    for (const url of ['/api/%', '/api/products/%E0%A4%A', '/%', '/api/%00']) {
      const res = await env.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, url).toBeLessThan(500);
      expect(res.json().error?.code, url).toBeTruthy();
    }
  });
});

describe('раздача собранного интерфейса', () => {
  let site: TestEnv;
  let dir: string;
  const secret = 'ЭТО-СЕКРЕТ-ВНЕ-ПАПКИ';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'zapas-web-'));
    mkdirSync(join(dir, 'dist', 'assets'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'index.html'), '<!doctype html><title>SPA-OK</title>');
    writeFileSync(join(dir, 'dist', 'assets', 'app-abc123.js'), 'console.log(1)');
    writeFileSync(join(dir, 'secret.txt'), secret);
    writeFileSync(join(dir, 'dist', '.env'), 'TOKEN=скрытый');
    site = await createTestEnv({ WEB_DIST: join(dir, 'dist') });
  });
  afterAll(async () => {
    await site.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (url: string, accept = 'text/html') => site.app.inject({ method: 'GET', url, headers: { accept } });

  it('отдаёт страницу и ресурсы с правильным кешированием', async () => {
    const page = await get('/stock');
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('SPA-OK');
    expect(page.headers['cache-control']).toBe('no-cache');
    const asset = await get('/assets/app-abc123.js', '*/*');
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');
    expect(asset.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('не выдаёт файлы вне папки и служебные файлы', async () => {
    for (const url of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/assets/../../secret.txt', '/assets/%2e%2e/%2e%2e/secret.txt', '/.env', '/%2eenv', '/assets/..%5c..%5csecret.txt']) {
      const res = await get(url, '*/*');
      expect(res.body, url).not.toContain(secret);
      expect(res.body, url).not.toContain('TOKEN=');
    }
  });

  it('неизвестный адрес API это JSON 404, а не страница', async () => {
    const res = await get('/api/unknown', 'text/html');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    const post = await site.app.inject({ method: 'POST', url: '/anything', payload: {} });
    expect(post.statusCode).toBe(404);
  });
});

describe('рабочая роль базы данных', () => {
  const denied = async (query: string) => {
    await expect(sql.raw(query).execute(env.db), query).rejects.toThrow(/permission denied|must be owner|must be superuser|нет доступа/i);
  };

  it('не может менять схему, права и служебные таблицы', async () => {
    await denied('CREATE TABLE hack (id int)');
    await denied('DROP TABLE users');
    await denied('ALTER TABLE users ADD COLUMN x int');
    await denied('ALTER TABLE users DISABLE TRIGGER ALL');
    await denied('CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql');
    await denied('SELECT * FROM schema_migrations');
    await denied("UPDATE schema_migrations SET checksum = 'x'");
    await denied('DROP TRIGGER stock_movements_immutable ON stock_movements');
    await denied('ALTER TABLE stock_movements DISABLE TRIGGER stock_movements_immutable');
  });

  it('не может раздавать права: команда GRANT проходит с предупреждением, но ничего не меняет', async () => {
    await sql.raw('GRANT ALL ON users TO PUBLIC').execute(env.db);
    await sql.raw('GRANT ALL ON stock_movements TO PUBLIC').execute(env.db);
    const granted = await sql<{ n: number }>`
      SELECT count(*) AS n FROM information_schema.role_table_grants WHERE grantee = 'PUBLIC' AND table_schema = 'public'`.execute(env.owner);
    expect(Number(granted.rows[0]?.n)).toBe(0);
  });

  it('не может удалять записи там, где предусмотрено только отключение', async () => {
    for (const table of ['users', 'locations', 'products', 'batches', 'documents', 'promotions', 'api_keys', 'inventories', 'stop_list_manual', 'settings']) {
      await denied(`DELETE FROM ${table}`);
    }
  });

  it('не может читать файлы и запускать программы на сервере', async () => {
    await denied("COPY (SELECT 1) TO PROGRAM 'id'");
    await denied("SELECT pg_read_file('/etc/passwd')");
    await denied('CREATE EXTENSION IF NOT EXISTS dblink');
  });

  it('не имеет права суперпользователя и создания ролей', async () => {
    const r = await sql<{ rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean }>`
      SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user`.execute(env.db);
    expect(r.rows[0]).toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false });
  });
});
