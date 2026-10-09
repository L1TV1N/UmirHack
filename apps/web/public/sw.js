/*
 * Service worker «Запаса»: приложение открывается без связи. Кешируется только оболочка (страница, скрипты,
 * стили, шрифты). Запросы к API никогда не кешируются и не перехватываются: данные и токены не оседают
 * в кеше браузера, а документы без связи ждут в очереди самого приложения.
 */
const SHELL = 'zapas-shell-v1';
const ASSETS = 'zapas-assets-v1';
const MAX_ASSETS = 160;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) =>
        Promise.all([
          // сервер отдаёт страницу только тем, кто просит HTML
          cache.add(new Request('/', { headers: { accept: 'text/html' } })),
          cache.add('/favicon.svg'),
          cache.add('/manifest.webmanifest'),
        ]),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== SHELL && n !== ASSETS).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

async function trim(cache) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(key);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // страница: сначала сеть (свежая версия), без связи последняя сохранённая
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && res.headers.get('content-type')?.includes('text/html')) {
            const copy = res.clone();
            void caches.open(SHELL).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(async () => (await caches.match('/')) ?? Response.error()),
    );
    return;
  }

  // скрипты, стили и шрифты с хэшем в имени не меняются: сначала кеш
  if (url.pathname.startsWith('/assets/') || url.pathname === '/favicon.svg' || url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              void caches.open(ASSETS).then(async (c) => {
                await c.put(req, copy);
                await trim(c);
              });
            }
            return res;
          }),
      ),
    );
  }
});
