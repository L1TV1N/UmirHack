// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Service worker запускается здесь с подставными self, caches и fetch. Живой браузер проверяет его регистрацию,
 * а решения о том, что кешировать, а что нет, проверяем тут.
 */
const source = readFileSync(fileURLToPath(new URL('../public/sw.js', import.meta.url)), 'utf8');

type Handler = (event: Record<string, unknown>) => void;

class FakeCache {
  entries = new Map<string, Response>();
  private key(req: Request | string) {
    return typeof req === 'string' ? new URL(req, 'https://app.test').toString() : req.url;
  }
  async add(req: Request | string) {
    this.entries.set(this.key(req), new Response('shell'));
  }
  async put(req: Request | string, res: Response) {
    this.entries.set(this.key(req), res);
  }
  async match(req: Request | string) {
    return this.entries.get(this.key(req))?.clone();
  }
  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
  async delete(req: Request | string) {
    return this.entries.delete(this.key(req));
  }
}

function boot() {
  const handlers = new Map<string, Handler>();
  const stores = new Map<string, FakeCache>();
  const caches = {
    open: async (name: string) => stores.get(name) ?? stores.set(name, new FakeCache()).get(name)!,
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (req: Request | string) => {
      for (const store of stores.values()) {
        const hit = await store.match(req);
        if (hit) return hit;
      }
      return undefined;
    },
  };
  const self = {
    location: { origin: 'https://app.test' },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
    addEventListener: (type: string, fn: Handler) => handlers.set(type, fn),
  };
  const fetchMock = vi.fn();
  // в браузере относительный адрес разрешается по адресу страницы, в Node нужен абсолютный
  class PageRequest extends Request {
    constructor(input: string | Request, init?: RequestInit) {
      super(typeof input === 'string' ? new URL(input, 'https://app.test').toString() : input, init);
    }
  }
  new Function('self', 'caches', 'fetch', 'Request', 'Response', 'URL', source)(self, caches, fetchMock, PageRequest, Response, URL);
  return { handlers, stores, caches, self, fetchMock };
}

/** Запрос к обработчику fetch: возвращает ответ, который тот отдал через respondWith, или undefined, если не вмешался. */
async function ask(env: ReturnType<typeof boot>, url: string, init: { method?: string; mode?: string } = {}) {
  const req = new Request(url, { method: init.method ?? 'GET' });
  Object.defineProperty(req, 'mode', { value: init.mode ?? 'cors' });
  let responded: Promise<Response> | undefined;
  env.handlers.get('fetch')?.({ request: req, respondWith: (p: Promise<Response>) => (responded = p) });
  return responded ? await responded : undefined;
}

let env: ReturnType<typeof boot>;
beforeEach(() => {
  env = boot();
});

describe('service worker', () => {
  it('при установке сохраняет страницу (запросив HTML), значок и манифест', async () => {
    let done: Promise<unknown> | undefined;
    env.handlers.get('install')?.({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    const shell = env.stores.get('zapas-shell-v1');
    expect([...(shell?.entries.keys() ?? [])].sort()).toEqual(['https://app.test/', 'https://app.test/favicon.svg', 'https://app.test/manifest.webmanifest']);
    expect(env.self.skipWaiting).toHaveBeenCalled();
  });

  it('при активации убирает чужие кеши и забирает управление страницами', async () => {
    await env.caches.open('zapas-shell-v1');
    await env.caches.open('zapas-assets-v1');
    await env.caches.open('старый-кеш');
    let done: Promise<unknown> | undefined;
    env.handlers.get('activate')?.({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    expect([...env.stores.keys()].sort()).toEqual(['zapas-assets-v1', 'zapas-shell-v1']);
    expect(env.self.clients.claim).toHaveBeenCalled();
  });

  it('запросы к API не перехватывает и не кеширует никогда', async () => {
    for (const path of ['/api/stock/summary', '/api/auth/refresh', '/api/products/scan-index']) {
      expect(await ask(env, `https://app.test${path}`)).toBeUndefined();
    }
    expect(env.fetchMock).not.toHaveBeenCalled();
    expect([...env.stores.values()].every((s) => s.entries.size === 0)).toBe(true);
  });

  it('не вмешивается в запись и в чужие адреса', async () => {
    expect(await ask(env, 'https://app.test/assets/a.js', { method: 'POST' })).toBeUndefined();
    expect(await ask(env, 'https://cdn.example/lib.js')).toBeUndefined();
  });

  it('страница: при связи берёт свежую и запоминает, без связи отдаёт последнюю сохранённую', async () => {
    env.fetchMock.mockResolvedValueOnce(new Response('<html>v2</html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
    const online = await ask(env, 'https://app.test/operations', { mode: 'navigate' });
    expect(await online?.text()).toBe('<html>v2</html>');
    await new Promise((r) => setTimeout(r, 10));

    env.fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const offline = await ask(env, 'https://app.test/inventory/123', { mode: 'navigate' });
    expect(await offline?.text()).toBe('<html>v2</html>');
  });

  it('ответ не-HTML (например, 404 в виде JSON) оболочку не затирает', async () => {
    await (await env.caches.open('zapas-shell-v1')).put('/', new Response('<html>good</html>'));
    env.fetchMock.mockResolvedValueOnce(new Response('{"error":1}', { status: 404, headers: { 'content-type': 'application/json' } }));
    await ask(env, 'https://app.test/nope', { mode: 'navigate' });
    await new Promise((r) => setTimeout(r, 10));
    expect(await (await env.caches.match('/'))?.text()).toBe('<html>good</html>');
  });

  it('скрипты и стили с хэшем: первый раз из сети с сохранением, потом из кеша без сети', async () => {
    env.fetchMock.mockResolvedValueOnce(new Response('console.log(1)', { status: 200 }));
    const first = await ask(env, 'https://app.test/assets/app-abc123.js');
    expect(await first?.text()).toBe('console.log(1)');
    await new Promise((r) => setTimeout(r, 10));
    env.fetchMock.mockRejectedValue(new TypeError('offline'));
    const second = await ask(env, 'https://app.test/assets/app-abc123.js');
    expect(await second?.text()).toBe('console.log(1)');
    expect(env.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('неудачные ответы ресурсов не сохраняются', async () => {
    env.fetchMock.mockResolvedValueOnce(new Response('нет', { status: 404 }));
    await ask(env, 'https://app.test/assets/missing.js');
    await new Promise((r) => setTimeout(r, 10));
    expect((await env.caches.open('zapas-assets-v1')).entries.size).toBe(0);
  });

  it('кеш ресурсов не растёт бесконечно', async () => {
    for (let i = 0; i < 175; i += 1) {
      env.fetchMock.mockResolvedValueOnce(new Response(`f${i}`, { status: 200 }));
      await ask(env, `https://app.test/assets/f${i}.js`);
      await new Promise((r) => setTimeout(r, 1));
    }
    await new Promise((r) => setTimeout(r, 30));
    expect((await env.caches.open('zapas-assets-v1')).entries.size).toBeLessThanOrEqual(160);
  });
});
