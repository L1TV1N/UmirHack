import type { PromotionChangedPayload, StopListChangedPayload, WebhookCreatedDto, WebhookDeliveryDto } from '@zapas/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signBody } from '../src/lib/crypto';
import { DISABLE_AFTER_FAILURES, processDeliveries, publishStopList, RETRY_DELAYS_MS } from '../src/modules/integrations/service';
import { schedulerTick } from '../src/modules/notifications/scheduler';
import { addProduct, createWorld, receive, type World } from './fixtures';
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
});

const admin = () => call(env, w.admin.token);
const manager = () => call(env, w.manager.token);
const URL_OK = 'https://hooks.example.com/zapas';

async function createHook(over: Record<string, unknown> = {}): Promise<WebhookCreatedDto> {
  const res = await admin()('POST', '/api/integrations/webhooks', { name: 'Доставка', url: URL_OK, events: ['stoplist.changed'], ...over });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

/** Подписчик создан, базовое состояние точек запомнено: дальше любое изменение становится событием. */
async function armed(over: Record<string, unknown> = {}): Promise<WebhookCreatedDto> {
  const hook = await createHook(over);
  await env.settle();
  await publishStopList(env.deps, null);
  return hook;
}

async function deliveries(endpointId?: string) {
  let q = env.owner.selectFrom('webhook_deliveries').selectAll().orderBy('created_at').orderBy('id');
  if (endpointId) q = q.where('endpoint_id', '=', endpointId);
  return q.execute();
}

const manualStop = async (productId: string, locationId = w.locA.id, reason = 'Проверка качества') => {
  const res = await manager()('POST', '/api/stop-list/manual', { locationId, productId, reason });
  expect(res.statusCode, res.body).toBe(201);
  await env.settle();
  // события разных операций различаются по времени, поэтому порядок в журнале предсказуем
  env.clock.advance(1000);
  return res.json().id as string;
};

/** Ждущие события «подошло время»: без перемотки часов, иначе истекает сессия администратора. */
const makeDue = () => env.owner.updateTable('webhook_deliveries').set({ next_attempt_at: new Date(env.clock.now.getTime() - 1000) }).where('status', '=', 'pending').execute();
const endpointRow = () => env.owner.selectFrom('webhook_endpoints').selectAll().executeTakeFirstOrThrow();

describe('адреса для вебхуков', () => {
  it('администратор создаёт адрес, секрет виден один раз и в базе лежит только в зашифрованном виде', async () => {
    const hook = await createHook();
    expect(hook.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const list = (await admin()('GET', '/api/integrations/webhooks')).json();
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(hook.secret);
    expect(list[0]).not.toHaveProperty('secret');
    const row = await env.owner.selectFrom('webhook_endpoints').select('secret_enc').executeTakeFirstOrThrow();
    expect(row.secret_enc).not.toContain(hook.secret);
    expect(row.secret_enc.startsWith('v1.')).toBe(true);
    expect(await env.owner.selectFrom('audit_log').select('details').where('action', '=', 'webhook.create').execute()).toHaveLength(1);
    const audit = await env.owner.selectFrom('audit_log').select('details').where('action', '=', 'webhook.create').executeTakeFirstOrThrow();
    expect(JSON.stringify(audit.details)).not.toContain(hook.secret);
  });

  it('все маршруты только для администратора', async () => {
    const hook = await createHook();
    const attempts: [string, string, unknown?][] = [
      ['GET', '/api/integrations/webhooks'],
      ['POST', '/api/integrations/webhooks', { name: 'x', url: URL_OK, events: ['stoplist.changed'] }],
      ['PATCH', `/api/integrations/webhooks/${hook.id}`, { name: 'y' }],
      ['DELETE', `/api/integrations/webhooks/${hook.id}`],
      ['POST', `/api/integrations/webhooks/${hook.id}/test`],
      ['POST', `/api/integrations/webhooks/${hook.id}/sync`],
      ['POST', `/api/integrations/webhooks/${hook.id}/rotate-secret`],
      ['GET', `/api/integrations/webhooks/${hook.id}/deliveries`],
    ];
    for (const s of [w.manager, w.keeperA, w.viewerA]) {
      for (const [m, u, b] of attempts) expect((await call(env, s.token)(m as 'GET', u, b)).statusCode, `${s.token.slice(0, 4)} ${m} ${u}`).toBe(403);
    }
    for (const [m, u, b] of attempts) expect((await call(env, null)(m as 'GET', u, b)).statusCode).toBe(401);
  });

  it('адреса во внутренней сети и чужие схемы не принимаются', async () => {
    const bad = [
      'https://localhost/x', 'http://127.0.0.1:8080/x', 'https://10.1.1.1/x', 'http://169.254.169.254/latest/meta-data', 'https://[::1]/x',
      'https://kassa/x', 'https://db.internal/x', 'ftp://hooks.example.com/x', 'https://user:pw@hooks.example.com/x', 'https://hooks.example.com/x#a',
    ];
    for (const url of bad) {
      const res = await admin()('POST', '/api/integrations/webhooks', { name: 'Плохой', url, events: ['stoplist.changed'] });
      expect(res.statusCode, url).toBe(400);
    }
    expect((await env.owner.selectFrom('webhook_endpoints').select('id').execute()).length).toBe(0);
  });

  it('проверка адреса действует и при изменении', async () => {
    const hook = await createHook();
    const res = await admin()('PATCH', `/api/integrations/webhooks/${hook.id}`, { url: 'http://192.168.0.5/x' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_webhook_url');
    const ok = await admin()('PATCH', `/api/integrations/webhooks/${hook.id}`, { url: 'https://other.example.com/y', name: 'Новая доставка' });
    expect(ok.json()).toMatchObject({ url: 'https://other.example.com/y', name: 'Новая доставка' });
  });

  it('число адресов ограничено, неизвестная точка и неизвестный адрес дают понятные ошибки', async () => {
    const res = await admin()('POST', '/api/integrations/webhooks', { name: 'x', url: URL_OK, events: ['stoplist.changed'], locationId: '00000000-0000-4000-8000-000000000000' });
    expect(res.statusCode).toBe(400);
    for (let i = 0; i < 20; i += 1) await createHook({ name: `Адрес ${i}` });
    const over = await admin()('POST', '/api/integrations/webhooks', { name: 'лишний', url: URL_OK, events: ['stoplist.changed'] });
    expect(over.statusCode).toBe(409);
    expect(over.json().error.code).toBe('too_many_webhooks');
    expect((await admin()('PATCH', '/api/integrations/webhooks/00000000-0000-4000-8000-000000000000', { name: 'x' })).statusCode).toBe(404);
    expect((await admin()('DELETE', '/api/integrations/webhooks/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });

  it('удаление убирает адрес и его журнал доставок', async () => {
    const hook = await armed();
    await manualStop(await addProduct(env, w.categoryId));
    expect((await deliveries()).length).toBe(1);
    expect((await admin()('DELETE', `/api/integrations/webhooks/${hook.id}`)).statusCode).toBe(204);
    expect((await deliveries()).length).toBe(0);
    expect((await admin()('GET', '/api/integrations/webhooks')).json()).toHaveLength(0);
  });

  it('смена секрета выдаёт новый, и подпись дальше считается по нему', async () => {
    const hook = await armed();
    const rotated = (await admin()('POST', `/api/integrations/webhooks/${hook.id}/rotate-secret`)).json();
    expect(rotated.secret).not.toBe(hook.secret);
    await admin()('POST', `/api/integrations/webhooks/${hook.id}/test`);
    const req = env.webhooks.requests[0];
    const ts = Number(req?.headers['x-zapas-timestamp']);
    expect(req?.headers['x-zapas-signature']).toBe(`sha256=${signBody(rotated.secret, ts, req?.body ?? '')}`);
    expect(req?.headers['x-zapas-signature']).not.toBe(`sha256=${signBody(hook.secret, ts, req?.body ?? '')}`);
  });
});

describe('события стоп-листа', () => {
  it('ручной стоп уходит подписчику с артикулом, штрихкодом и подписью', async () => {
    const hook = await armed();
    const p = await addProduct(env, w.categoryId, { name: 'Масло' });
    await env.owner.updateTable('products').set({ barcode: '4607000010006' }).where('id', '=', p).execute();
    const sku = (await env.owner.selectFrom('products').select('sku').where('id', '=', p).executeTakeFirstOrThrow()).sku;
    await manualStop(p);

    const queued = await deliveries(hook.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.status).toBe('pending');
    expect(await processDeliveries(env.deps)).toBe(1);

    expect(env.webhooks.requests).toHaveLength(1);
    const req = env.webhooks.requests[0]!;
    expect(req.url).toBe(URL_OK);
    expect(req.headers['x-zapas-event']).toBe('stoplist.changed');
    const ts = Number(req.headers['x-zapas-timestamp']);
    expect(ts).toBe(Math.floor(env.clock.now.getTime() / 1000));
    expect(req.headers['x-zapas-signature']).toBe(`sha256=${signBody(hook.secret, ts, req.body)}`);
    expect(req.headers['x-zapas-delivery']).toBe(queued[0]?.id);

    const payload = JSON.parse(req.body) as StopListChangedPayload;
    expect(payload).toMatchObject({ event: 'stoplist.changed', locationId: w.locA.id, locationName: w.locA.name, truncated: false, removed: [] });
    expect(payload.added).toHaveLength(1);
    expect(payload.added[0]).toMatchObject({ id: p, type: 'product', code: sku, barcode: '4607000010006', name: 'Масло', source: 'manual', reason: 'Проверка качества' });
    expect(payload.entries).toEqual(payload.added);

    const done = await deliveries(hook.id);
    expect(done[0]).toMatchObject({ status: 'delivered', attempts: 1, last_status: 200 });
    const endpoint = (await admin()('GET', '/api/integrations/webhooks')).json()[0];
    expect(endpoint).toMatchObject({ failureStreak: 0, enabled: true });
    expect(endpoint.lastSuccessAt).toBeTruthy();
  });

  it('снятие стопа приходит как removed, а в entries остаётся то, что ещё в стопе', async () => {
    await armed();
    const a = await addProduct(env, w.categoryId, { name: 'Масло' });
    const b = await addProduct(env, w.categoryId, { name: 'Сыр' });
    await manualStop(a);
    const stopB = await manualStop(b);
    await manager()('DELETE', `/api/stop-list/manual/${stopB}`);
    await env.settle();
    env.clock.advance(1000);
    const all = await deliveries();
    expect(all).toHaveLength(3);
    const last = all[2]?.payload as StopListChangedPayload;
    expect(last.added).toEqual([]);
    expect(last.removed.map((e) => e.name)).toEqual(['Сыр']);
    expect(last.entries.map((e) => e.name)).toEqual(['Масло']);
  });

  it('автоматический стоп (товар закончился) тоже становится событием', async () => {
    await armed();
    const p = await addProduct(env, w.categoryId, { name: 'Сливки' });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 2, expiresOn: w.day(5) }]);
    await env.settle();
    expect(await deliveries()).toHaveLength(0);
    await manager()('POST', '/api/documents/sales', { locationId: w.locA.id, lines: [{ productId: p, quantity: 2 }] });
    await env.settle();
    const queued = await deliveries();
    expect(queued).toHaveLength(1);
    const payload = queued[0]?.payload as StopListChangedPayload;
    expect(payload.added[0]).toMatchObject({ name: 'Сливки', source: 'auto' });
    expect(payload.added[0]?.reason).toBe('Нет в наличии');
  });

  it('код блюда попадает в событие, а повторяющийся код отклоняется', async () => {
    const milk = await addProduct(env, w.categoryId, { name: 'Молоко', sellable: false });
    const dishA = await manager()('POST', '/api/dishes', { name: 'Омлет', code: 'IIKO-1001', price: 200, items: [{ productId: milk, quantity: 0.1 }] });
    expect(dishA.statusCode, dishA.body).toBe(201);
    expect(dishA.json().code).toBe('IIKO-1001');
    const dup = await manager()('POST', '/api/dishes', { name: 'Блин', code: 'iiko-1001', price: 100, items: [{ productId: milk, quantity: 0.1 }] });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('duplicate_code');
    await armed();
    const res = await manager()('POST', '/api/stop-list/manual', { locationId: w.locA.id, dishId: dishA.json().id, reason: 'Нет повара' });
    expect(res.statusCode).toBe(201);
    await env.settle();
    const payload = (await deliveries())[0]?.payload as StopListChangedPayload;
    expect(payload.added[0]).toMatchObject({ type: 'dish', code: 'IIKO-1001', barcode: null, name: 'Омлет' });
    const cleared = await manager()('PATCH', `/api/dishes/${dishA.json().id}`, { code: null });
    expect(cleared.json().code).toBeNull();
  });

  it('подписчик на одну точку не получает события другой, подписчик на все получает обе', async () => {
    const onlyB = await armed({ name: 'Только Б', locationId: w.locB.id });
    const everything = await createHook({ name: 'Все' });
    await publishStopList(env.deps, null);
    await manualStop(await addProduct(env, w.categoryId), w.locA.id);
    await manualStop(await addProduct(env, w.categoryId), w.locB.id);
    expect((await deliveries(onlyB.id)).map((d) => (d.payload as StopListChangedPayload).locationId)).toEqual([w.locB.id]);
    expect((await deliveries(everything.id)).map((d) => (d.payload as StopListChangedPayload).locationId).sort()).toEqual([w.locA.id, w.locB.id].sort());
  });

  it('без изменений событий нет, выключенный адрес ничего не получает', async () => {
    const hook = await armed();
    await publishStopList(env.deps, null);
    await publishStopList(env.deps, null);
    expect(await deliveries()).toHaveLength(0);
    await admin()('PATCH', `/api/integrations/webhooks/${hook.id}`, { enabled: false });
    await manualStop(await addProduct(env, w.categoryId));
    expect(await deliveries()).toHaveLength(0);
  });

  it('до первого прохода по точке событие не шлётся, текущее состояние отправляет кнопка синхронизации', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Масло' });
    await manualStop(p);
    const hook = await createHook();
    await env.settle();
    await publishStopList(env.deps, null);
    expect(await deliveries()).toHaveLength(0);
    const synced = await admin()('POST', `/api/integrations/webhooks/${hook.id}/sync`);
    expect(synced.statusCode).toBe(200);
    const rows = await deliveries();
    expect(rows.length).toBe(synced.json().queued);
    const withEntries = rows.map((r) => r.payload as StopListChangedPayload).find((x) => x.locationId === w.locA.id);
    expect(withEntries).toMatchObject({ added: [], removed: [] });
    expect(withEntries?.entries.map((e) => e.name)).toEqual(['Масло']);
  });

  it('ручной стоп с истёкшим сроком снимается событием от планировщика', async () => {
    await armed();
    const p = await addProduct(env, w.categoryId);
    const until = new Date(env.clock.now.getTime() + 600_000).toISOString();
    await manager()('POST', '/api/stop-list/manual', { locationId: w.locA.id, productId: p, reason: 'До вечера', until });
    await env.settle();
    expect(await deliveries()).toHaveLength(1);
    env.clock.advance(1_200_000);
    env.forget();
    await schedulerTick(env.deps);
    const rows = await deliveries();
    expect(rows).toHaveLength(2);
    expect((rows[1]?.payload as StopListChangedPayload).removed).toHaveLength(1);
  });

  it('одновременные публикации не отправляют одну разницу дважды', async () => {
    await armed();
    const p = await addProduct(env, w.categoryId);
    await manager()('POST', '/api/stop-list/manual', { locationId: w.locA.id, productId: p, reason: 'Причина' });
    await env.settle();
    const before = (await deliveries()).length;
    await Promise.all([publishStopList(env.deps, null), publishStopList(env.deps, null), publishStopList(env.deps, [w.locA.id])]);
    expect((await deliveries()).length).toBe(before);
  });
});

describe('доставка и повторы', () => {
  async function oneEvent() {
    const hook = await armed();
    await manualStop(await addProduct(env, w.categoryId));
    return hook;
  }

  it('при сбое событие остаётся в очереди и повторяется с нарастающей паузой', async () => {
    const hook = await oneEvent();
    env.webhooks.failNext = 1;
    await processDeliveries(env.deps);
    let [row] = await deliveries(hook.id);
    expect(row).toMatchObject({ status: 'pending', attempts: 1, last_error: 'соединение отклонено' });
    expect(row?.next_attempt_at.getTime()).toBe(env.clock.now.getTime() + RETRY_DELAYS_MS[0]!);

    expect(await processDeliveries(env.deps)).toBe(0);
    env.clock.advance(RETRY_DELAYS_MS[0]! + 1000);
    expect(await processDeliveries(env.deps)).toBe(1);
    [row] = await deliveries(hook.id);
    expect(row).toMatchObject({ status: 'delivered', attempts: 2, last_error: null });
  });

  it('ответ не 2xx считается неудачей и пишется в журнал', async () => {
    const hook = await oneEvent();
    env.webhooks.failNext = 1;
    env.webhooks.failStatus = 503;
    await processDeliveries(env.deps);
    const [row] = await deliveries(hook.id);
    expect(row).toMatchObject({ status: 'pending', last_status: 503, last_error: 'ответ 503' });
  });

  it('после всех повторов событие помечается проваленным, серия неудач выключает адрес', async () => {
    const hook = await armed();
    env.webhooks.failNext = 1000;
    for (let n = 1; n <= DISABLE_AFTER_FAILURES; n += 1) {
      await manualStop(await addProduct(env, w.categoryId));
      for (let i = 0; i <= RETRY_DELAYS_MS.length; i += 1) {
        await makeDue();
        await processDeliveries(env.deps);
      }
      expect((await endpointRow()).failure_streak).toBe(n);
    }
    const failed = (await deliveries(hook.id)).filter((d) => d.status === 'failed');
    expect(failed).toHaveLength(DISABLE_AFTER_FAILURES);
    expect(failed[0]?.attempts).toBe(RETRY_DELAYS_MS.length + 1);
    const row = await endpointRow();
    expect(row.enabled).toBe(false);
    expect(row.disabled_reason).toContain(String(DISABLE_AFTER_FAILURES));

    // выключенному адресу новые события не ставятся, а включение вручную начинает серию заново
    const sent = env.webhooks.requests.length;
    await manualStop(await addProduct(env, w.categoryId));
    expect((await deliveries(hook.id)).length).toBe(DISABLE_AFTER_FAILURES);
    expect(env.webhooks.requests.length).toBe(sent);
    const back = await admin()('PATCH', `/api/integrations/webhooks/${hook.id}`, { enabled: true });
    expect(back.json()).toMatchObject({ enabled: true, failureStreak: 0, disabledReason: null });
  });

  it('успешная доставка обнуляет серию неудач', async () => {
    const hook = await armed();
    env.webhooks.failNext = RETRY_DELAYS_MS.length + 1;
    await manualStop(await addProduct(env, w.categoryId));
    for (let i = 0; i <= RETRY_DELAYS_MS.length; i += 1) {
      await makeDue();
      await processDeliveries(env.deps);
    }
    expect((await endpointRow()).failure_streak).toBe(1);
    await manualStop(await addProduct(env, w.categoryId));
    await processDeliveries(env.deps);
    expect((await endpointRow()).failure_streak).toBe(0);
    expect((await deliveries(hook.id)).at(-1)?.status).toBe('delivered');
  });

  it('два обработчика одного события не отправляют его дважды', async () => {
    await oneEvent();
    const [a, b] = await Promise.all([processDeliveries(env.deps), processDeliveries(env.deps)]);
    expect(a + b).toBe(1);
    expect(env.webhooks.requests).toHaveLength(1);
  });

  it('событие, ждавшее в очереди, не уходит на выключенный адрес', async () => {
    const hook = await oneEvent();
    await admin()('PATCH', `/api/integrations/webhooks/${hook.id}`, { enabled: false });
    await processDeliveries(env.deps);
    expect(env.webhooks.requests).toHaveLength(0);
    expect((await deliveries(hook.id))[0]).toMatchObject({ status: 'failed', last_error: 'адрес выключен' });
  });

  it('проверка связи: один заход, результат в ответе, серию неудач не трогает', async () => {
    const hook = await armed();
    const ok = (await admin()('POST', `/api/integrations/webhooks/${hook.id}/test`)).json() as WebhookDeliveryDto;
    expect(ok).toMatchObject({ event: 'ping', status: 'delivered', attempts: 1 });
    expect(JSON.parse(env.webhooks.requests[0]!.body)).toMatchObject({ event: 'ping' });

    env.webhooks.failNext = 1;
    const bad = (await admin()('POST', `/api/integrations/webhooks/${hook.id}/test`)).json() as WebhookDeliveryDto;
    expect(bad).toMatchObject({ status: 'failed', attempts: 1, lastError: 'соединение отклонено', nextAttemptAt: null });
    const row = (await admin()('GET', '/api/integrations/webhooks')).json()[0];
    expect(row.failureStreak).toBe(0);
    expect(row.lastFailureAt).toBeTruthy();
    expect(await processDeliveries(env.deps)).toBe(0);
  });

  it('журнал доставок отдаёт последние записи без тела события', async () => {
    const hook = await armed();
    for (let i = 0; i < 3; i += 1) await manualStop(await addProduct(env, w.categoryId));
    await processDeliveries(env.deps);
    const list = (await admin()('GET', `/api/integrations/webhooks/${hook.id}/deliveries?limit=2`)).json() as WebhookDeliveryDto[];
    expect(list).toHaveLength(2);
    expect(list[0]).not.toHaveProperty('payload');
    expect(list[0]?.createdAt >= list[1]!.createdAt).toBe(true);
    expect((await admin()('GET', `/api/integrations/webhooks/${hook.id}/deliveries?limit=500`)).statusCode).toBe(400);
  });

  it('старые отработанные доставки чистятся планировщиком, ожидающие остаются', async () => {
    const hook = await armed();
    await manualStop(await addProduct(env, w.categoryId));
    await processDeliveries(env.deps);
    await manualStop(await addProduct(env, w.categoryId));
    env.clock.advance(31 * 86_400_000);
    env.forget();
    await schedulerTick(env.deps);
    const rows = await deliveries(hook.id);
    expect(rows.map((r) => r.status)).toEqual(['pending']);
  });
});

describe('уценка в кассу', () => {
  async function key(locationId: string) {
    const res = await admin()('POST', '/api/api-keys', { name: 'Касса', locationId });
    return res.json().key as string;
  }
  const productsFeed = async (k: string) => (await env.app.inject({ method: 'GET', url: '/api/pos/products', headers: { 'x-api-key': k } })).json().items as { name: string; price: number; markdown: { percent: number; price: number; endsOn: string; quantity: number } | null }[];

  it('лента показывает скидку на ближайшую партию и перестаёт, когда её отменили', async () => {
    const milk = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l', price: 100, cost: 60 });
    await receive(env, w.manager.token, w.locA.id, [
      { productId: milk, quantity: 10, expiresOn: w.day(2) },
      { productId: milk, quantity: 30, expiresOn: w.day(9) },
    ]);
    const k = await key(w.locA.id);
    expect((await productsFeed(k))[0]?.markdown).toBeNull();

    const batch = (await env.owner.selectFrom('batches').select('id').where('expires_on', '=', w.day(2)).executeTakeFirstOrThrow()).id;
    const created = await manager()('POST', '/api/promotions', { batchId: batch, percent: 30 });
    expect(created.statusCode).toBe(201);
    const item = (await productsFeed(k))[0];
    expect(item).toMatchObject({ name: 'Молоко', price: 100 });
    expect(item?.markdown).toEqual({ percent: 30, price: 70, endsOn: w.day(2), quantity: 10 });
    // на другой точке этого товара нет и скидки нет
    expect((await productsFeed(await key(w.locB.id)))[0]?.markdown).toBeNull();

    expect((await manager()('DELETE', `/api/promotions/${created.json().id}`)).statusCode).toBe(204);
    expect((await productsFeed(k))[0]?.markdown).toBeNull();
  });

  it('скидка на более позднюю партию кассе не показывается, пока не разойдётся ближайшая', async () => {
    const milk = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l', price: 100, cost: 60 });
    await receive(env, w.manager.token, w.locA.id, [
      { productId: milk, quantity: 10, expiresOn: w.day(2) },
      { productId: milk, quantity: 30, expiresOn: w.day(9) },
    ]);
    const later = (await env.owner.selectFrom('batches').select('id').where('expires_on', '=', w.day(9)).executeTakeFirstOrThrow()).id;
    expect((await manager()('POST', '/api/promotions', { batchId: later, percent: 15 })).statusCode).toBe(201);
    expect((await productsFeed(await key(w.locA.id)))[0]?.markdown).toBeNull();
  });

  it('подписанный адрес получает событие о скидке и об её отмене', async () => {
    const hook = await createHook({ events: ['promotion.changed'] });
    const milk = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l', price: 100, cost: 60 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: milk, quantity: 10, expiresOn: w.day(2) }]);
    const batch = (await env.owner.selectFrom('batches').select('id').executeTakeFirstOrThrow()).id;

    const created = await manager()('POST', '/api/promotions', { batchId: batch, percent: 30 });
    env.clock.advance(1000);
    await manager()('DELETE', `/api/promotions/${created.json().id}`);
    expect(await processDeliveries(env.deps)).toBe(2);

    // доставки уходят параллельно, порядок между ними не гарантирован
    const sent = env.webhooks.requests.map((r) => JSON.parse(r.body) as PromotionChangedPayload);
    const on = sent.find((p) => p.markdown !== null);
    const off = sent.find((p) => p.markdown === null);
    expect(env.webhooks.requests.every((r) => r.headers['x-zapas-event'] === 'promotion.changed')).toBe(true);
    expect(on).toMatchObject({ event: 'promotion.changed', locationId: w.locA.id, product: { name: 'Молоко', price: 100 } });
    expect(on?.markdown).toEqual({ percent: 30, price: 70, endsOn: w.day(2), quantity: 10 });
    expect(off?.markdown).toBeNull();
    expect((await deliveries(hook.id)).every((d) => d.status === 'delivered')).toBe(true);
  });
});

describe('ленты для кассы', () => {
  async function key(locationId: string) {
    const res = await admin()('POST', '/api/api-keys', { name: 'Касса', locationId });
    expect(res.statusCode).toBe(201);
    return res.json().key as string;
  }
  const feed = (k: string | null, path: string) => env.app.inject({ method: 'GET', url: path, headers: k ? { 'x-api-key': k } : {} });

  it('стоп-лист точки отдаётся по ключу кассы и только по её точке', async () => {
    const a = await addProduct(env, w.categoryId, { name: 'Масло' });
    const b = await addProduct(env, w.categoryId, { name: 'Сыр' });
    await manualStop(a, w.locA.id);
    await manualStop(b, w.locB.id);
    const res = await feed(await key(w.locA.id), '/api/pos/stop-list');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.locationId).toBe(w.locA.id);
    expect(body.entries.map((e: { name: string }) => e.name)).toEqual(['Масло']);
    expect(body.entries[0]).toMatchObject({ type: 'product', source: 'manual', reason: 'Проверка качества', locationName: w.locA.name });
    expect(typeof body.generatedAt).toBe('string');
  });

  it('без ключа, с чужим ключом и с токеном пользователя лента закрыта', async () => {
    expect((await feed(null, '/api/pos/stop-list')).statusCode).toBe(401);
    expect((await feed('zk_abcdefgh_' + 'x'.repeat(32), '/api/pos/stop-list')).statusCode).toBe(401);
    expect((await call(env, w.admin.token)('GET', '/api/pos/stop-list')).statusCode).toBe(401);
    expect((await call(env, w.admin.token)('GET', '/api/pos/products')).statusCode).toBe(401);
  });

  it('отозванный ключ перестаёт работать', async () => {
    const created = (await admin()('POST', '/api/api-keys', { name: 'Касса', locationId: w.locA.id })).json();
    expect((await feed(created.key, '/api/pos/stop-list')).statusCode).toBe(200);
    await admin()('DELETE', `/api/api-keys/${created.id}`);
    expect((await feed(created.key, '/api/pos/stop-list')).statusCode).toBe(401);
  });

  it('каталог для кассы: артикул, штрихкод, цена числом, постранично', async () => {
    for (let i = 0; i < 3; i += 1) await addProduct(env, w.categoryId, { name: `Товар ${i}`, price: 99.5 });
    const k = await key(w.locA.id);
    const first = (await feed(k, '/api/pos/products?limit=2')).json();
    expect(first).toMatchObject({ total: 3, limit: 2, offset: 0 });
    expect(first.items).toHaveLength(2);
    expect(first.items[0]).toMatchObject({ price: 99.5, unit: 'kg', sellable: true, isActive: true });
    expect(first.items[0]).not.toHaveProperty('cost');
    const second = (await feed(k, '/api/pos/products?limit=2&offset=2')).json();
    expect(second.items).toHaveLength(1);
    expect((await feed(k, '/api/pos/products?limit=9999')).statusCode).toBe(400);
  });
});
