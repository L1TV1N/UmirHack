import { ONEC_PRESET_LABELS, type ExchangeJobDto, type ExternalSystemDto, type OneCProfile } from '@zapas/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MockOneC } from '../src/emulator/onec';
import { EXCHANGE_RETRY_MS, processExchange } from '../src/modules/exchange/service';
import { ONEC_PRESET_PROFILES } from '../src/modules/exchange/presets';
import { HttpExchangeTransport } from '../src/modules/exchange/transport';
import { addProduct, createWorld, receive, type World } from './fixtures';
import { call, createTestEnv, type TestEnv } from './helpers';

let env: TestEnv;
let w: World;

beforeAll(async () => {
  env = await createTestEnv({ ACCESS_TOKEN_TTL_SECONDS: '3600', EXCHANGE_ALLOW_HOSTS: 'onec.lan,127.0.0.1' });
});
afterAll(() => env.close());

const ORG = '11111111-1111-4111-8111-111111111111';
const admin = () => call(env, w.admin.token);
const manager = () => call(env, w.manager.token);

const profile = (over: Partial<OneCProfile> = {}): OneCProfile => ({ ...ONEC_PRESET_PROFILES.bp3, organizationKey: ORG, ...over });

let mock: MockOneC;
let supplierId: string;
let milk: string;
let kefir: string;

beforeEach(async () => {
  await env.reset();
  w = await createWorld(env);
  mock = new MockOneC(profile());
  env.exchange.current = mock;
  const s = await env.db.insertInto('suppliers').values({ name: 'Молочный комбинат', inn: '6163012349', phone: null, note: null, email: null }).returning('id').executeTakeFirstOrThrow();
  supplierId = s.id;
  milk = await addProduct(env, w.categoryId, { name: 'Молоко 3,2%', unit: 'l' });
  kefir = await addProduct(env, w.categoryId, { name: 'Кефир 2,5%', unit: 'l' });
});

async function createSystem(over: Record<string, unknown> = {}): Promise<ExternalSystemDto> {
  const res = await admin()('POST', '/api/exchange/systems', {
    kind: 'onec',
    name: 'Бухгалтерия',
    baseUrl: 'https://1c.example.com',
    username: 'zapas',
    password: 'secret',
    profile: profile(),
    docKinds: ['receipt', 'writeoff', 'transfer', 'inventory'],
    ...over,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

const skuOf = async (id: string) => (await env.db.selectFrom('products').select('sku').where('id', '=', id).executeTakeFirstOrThrow()).sku;

/** Объекты 1С, которым соответствуют точка, поставщик и продукты, и связи с ними в «Запасе». */
async function linkEverything(system: ExternalSystemDto, loc = w.locA.id): Promise<void> {
  const keyOf = (entity: 'location' | 'supplier' | 'product', code: string, name: string) => mock.addCatalogItem(profile().catalogs[entity]!.entity, code, name);
  const links: [string, string, string][] = [
    ['location', loc, keyOf('location', 'L', 'Склад')],
    ['supplier', supplierId, keyOf('supplier', '6163012349', 'Молочный комбинат')],
    ['product', milk, keyOf('product', await skuOf(milk), 'Молоко')],
    ['product', kefir, keyOf('product', await skuOf(kefir), 'Кефир')],
  ];
  for (const [entity, localId, remoteKey] of links) {
    expect((await admin()('PUT', `/api/exchange/systems/${system.id}/links`, { entity, localId, remoteKey })).statusCode).toBe(200);
  }
}

const jobs = async (): Promise<ExchangeJobDto[]> => (await manager()('GET', '/api/exchange/jobs')).json();
const makeDue = () => env.owner.updateTable('exchange_jobs').set({ next_attempt_at: new Date(env.clock.now.getTime() - 1000) }).where('status', '=', 'pending').execute();
const doReceipt = (qty = 10) =>
  receive(env, w.admin.token, w.locA.id, [{ productId: milk, quantity: qty, expiresOn: w.day(5), unitCost: 70 }, { productId: kefir, quantity: 4, expiresOn: w.day(5), unitCost: 50 }], { supplierId });

describe('системы обмена', () => {
  it('пароль хранится зашифрованным и не возвращается, настройка только для администратора', async () => {
    const sys = await createSystem();
    expect(sys.hasPassword).toBe(true);
    expect(JSON.stringify(sys)).not.toContain('secret');
    const row = await env.owner.selectFrom('external_systems').select('secret_enc').executeTakeFirstOrThrow();
    expect(row.secret_enc?.startsWith('v1.')).toBe(true);
    expect(row.secret_enc).not.toContain('secret');
    expect(await env.owner.selectFrom('audit_log').select('id').where('action', '=', 'exchange.create').execute()).toHaveLength(1);

    for (const s of [w.manager, w.keeperA, w.viewerA]) {
      expect((await call(env, s.token)('POST', '/api/exchange/systems', { kind: 'onec', name: 'x', baseUrl: 'https://1c.example.com', profile: profile(), docKinds: ['receipt'] })).statusCode).toBe(403);
    }
    expect((await call(env, w.keeperA.token)('GET', '/api/exchange/systems')).statusCode).toBe(403);
    expect((await manager()('GET', '/api/exchange/systems')).statusCode).toBe(200);
    expect((await call(env, null)('GET', '/api/exchange/systems')).statusCode).toBe(401);
  });

  it('внутренние адреса и http допустимы только для разрешённых хостов', async () => {
    const body = { kind: 'onec', name: 'x', profile: profile(), docKinds: ['receipt'] };
    expect((await admin()('POST', '/api/exchange/systems', { ...body, baseUrl: 'http://10.0.0.5' })).statusCode).toBe(400);
    expect((await admin()('POST', '/api/exchange/systems', { ...body, baseUrl: 'http://1c.example.com' })).statusCode).toBe(400);
    expect((await admin()('POST', '/api/exchange/systems', { ...body, baseUrl: 'https://localhost' })).statusCode).toBe(400);
    expect((await admin()('POST', '/api/exchange/systems', { ...body, baseUrl: 'http://onec.lan:8080/base' })).statusCode).toBe(201);
  });

  it('профиль с чужими символами в именах отклоняется', async () => {
    const bad = profile({ documents: { receipt: { ...ONEC_PRESET_PROFILES.bp3.documents.receipt!, entity: "Document_X'; drop" } } });
    expect((await admin()('POST', '/api/exchange/systems', { kind: 'onec', name: 'x', baseUrl: 'https://1c.example.com', profile: bad, docKinds: ['receipt'] })).statusCode).toBe(400);
  });

  it('все типовые пресеты проходят разбор', async () => {
    const list = (await admin()('GET', '/api/exchange/presets')).json() as { preset: string; label: string }[];
    expect(list.map((p) => p.label).sort()).toEqual(Object.values(ONEC_PRESET_LABELS).sort());
  });
});

describe('проверка подключения', () => {
  it('подтверждает, что объекты и реквизиты на месте', async () => {
    const sys = await createSystem();
    const res = (await admin()('POST', `/api/exchange/systems/${sys.id}/check`)).json();
    expect(res.ok, JSON.stringify(res.items)).toBe(true);
    expect(res.items.length).toBeGreaterThan(4);
  });

  it('показывает, чего не хватает: чужое имя документа и лишний реквизит', async () => {
    const wrong = profile({ documents: { ...profile().documents, receipt: { ...profile().documents.receipt!, entity: 'Document_ПриходНоваяНакладная' } } });
    const sys = await createSystem({ profile: wrong });
    const res = (await admin()('POST', `/api/exchange/systems/${sys.id}/check`)).json();
    expect(res.ok).toBe(false);
    expect(res.items.some((i: { ok: boolean; text: string }) => !i.ok && i.text.includes('Document_ПриходНоваяНакладная'))).toBe(true);
  });

  it('сообщает про неверный пароль и про недоступный сервер', async () => {
    const sys = await createSystem({ password: 'другой' });
    let res = (await admin()('POST', `/api/exchange/systems/${sys.id}/check`)).json();
    expect(res.ok).toBe(false);
    expect(res.items[0].text).toContain('логин или пароль');
    mock.down = true;
    res = (await admin()('POST', `/api/exchange/systems/${sys.id}/check`)).json();
    expect(res.ok).toBe(false);
    expect(res.items[0].text).toContain('соединение отклонено');
    const row = await env.owner.selectFrom('external_systems').select('last_error').executeTakeFirstOrThrow();
    expect(row.last_error).toContain('соединение отклонено');
  });
});

describe('выгрузка документов', () => {
  it('приход сначала ждёт связей, после связывания уходит в 1С одним документом с правильными строками', async () => {
    const sys = await createSystem();
    const doc = await doReceipt();
    await processExchange(env.deps);
    let [job] = await jobs();
    expect(job?.status).toBe('blocked');
    expect(job?.missing.map((m) => m.entity).sort()).toEqual(['location', 'product', 'product', 'supplier']);
    expect(mock.all('Document_ПоступлениеТоваровУслуг')).toHaveLength(0);

    const unlinked = (await manager()('GET', `/api/exchange/systems/${sys.id}/unlinked`)).json();
    expect(unlinked).toHaveLength(4);

    await linkEverything(sys);
    await processExchange(env.deps);
    [job] = await jobs();
    expect(job?.status).toBe('done');
    expect(job?.remoteNumber).toBeTruthy();
    const sent = mock.all('Document_ПоступлениеТоваровУслуг');
    expect(sent).toHaveLength(1);
    const body = sent[0] as unknown as { Организация_Key: string; Posted: boolean; Комментарий: string; Товары: { Количество: number; Цена: number; Сумма: number }[] };
    expect(body.Организация_Key).toBe(ORG);
    expect(body.Posted).toBe(true);
    expect(body.Комментарий).toContain(doc.number);
    expect(body.Товары.map((l) => [l.Количество, l.Цена, l.Сумма])).toEqual([[10, 70, 700], [4, 50, 200]]);
    expect((await manager()('GET', `/api/exchange/systems/${sys.id}/unlinked`)).json()).toHaveLength(0);
  });

  it('повторная выгрузка обновляет тот же документ и не создаёт дубль', async () => {
    const sys = await createSystem();
    await linkEverything(sys);
    const doc = await doReceipt();
    await processExchange(env.deps);
    expect(mock.all('Document_ПоступлениеТоваровУслуг')).toHaveLength(1);
    const first = mock.all('Document_ПоступлениеТоваровУслуг')[0] as { Ref_Key: string };

    const res = await manager()('POST', `/api/documents/${doc.documentId}/exchange`, { systemId: sys.id });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().outcome).toBe('done');
    expect(mock.all('Document_ПоступлениеТоваровУслуг')).toHaveLength(1);
    expect((mock.all('Document_ПоступлениеТоваровУслуг')[0] as { Ref_Key: string }).Ref_Key).toBe(first.Ref_Key);
    expect(mock.requests.some((r) => r.method === 'PATCH')).toBe(true);
  });

  it('если документ удалили в 1С, при повторе он создаётся заново и связь обновляется', async () => {
    const sys = await createSystem();
    await linkEverything(sys);
    const doc = await doReceipt();
    await processExchange(env.deps);
    mock.documents.get('Document_ПоступлениеТоваровУслуг')!.clear();
    await manager()('POST', `/api/documents/${doc.documentId}/exchange`, { systemId: sys.id });
    expect(mock.all('Document_ПоступлениеТоваровУслуг')).toHaveLength(1);
    const ref = await env.owner.selectFrom('external_refs').select('remote_key').where('entity', '=', 'document').executeTakeFirstOrThrow();
    expect(ref.remote_key).toBe((mock.all('Document_ПоступлениеТоваровУслуг')[0] as { Ref_Key: string }).Ref_Key);
  });

  it('при недоступной 1С задание ждёт и повторяется с нарастающей паузой, после восстановления уходит само', async () => {
    const sys = await createSystem();
    await linkEverything(sys);
    mock.down = true;
    await doReceipt();
    await processExchange(env.deps);
    let [job] = await jobs();
    expect(job).toMatchObject({ status: 'pending', attempts: 1 });
    expect(job?.lastError).toContain('соединение отклонено');
    expect(new Date(job?.nextAttemptAt ?? 0).getTime()).toBeGreaterThanOrEqual(env.clock.now.getTime() + EXCHANGE_RETRY_MS[0]! - 1);
    expect(await processExchange(env.deps)).toBe(0);

    mock.down = false;
    await makeDue();
    await processExchange(env.deps);
    [job] = await jobs();
    expect(job?.status).toBe('done');
    expect(mock.all('Document_ПоступлениеТоваровУслуг')).toHaveLength(1);
    const sysRow = (await manager()('GET', '/api/exchange/systems')).json()[0] as ExternalSystemDto;
    expect(sysRow.lastError).toBeNull();
    expect(sysRow.lastOkAt).toBeTruthy();
    expect(sysRow.counts.done).toBe(1);
  });

  it('после всех повторов задание считается неудавшимся и его можно вернуть в очередь вручную', async () => {
    const sys = await createSystem();
    await linkEverything(sys);
    mock.down = true;
    await doReceipt();
    for (let i = 0; i <= EXCHANGE_RETRY_MS.length; i += 1) {
      await makeDue();
      await processExchange(env.deps);
    }
    let [job] = await jobs();
    expect(job).toMatchObject({ status: 'failed', attempts: EXCHANGE_RETRY_MS.length + 1 });
    mock.down = false;
    expect((await manager()('POST', `/api/exchange/jobs/${job!.id}/retry`)).statusCode).toBe(202);
    await processExchange(env.deps);
    [job] = await jobs();
    expect(job?.status).toBe('done');
    expect((await manager()('POST', `/api/exchange/jobs/${job!.id}/retry`)).statusCode).toBe(409);
    void sys;
  });

  it('отказ 1С по существу не повторяется, текст ошибки виден человеку', async () => {
    const sys = await createSystem({ profile: profile({ documents: { ...profile().documents, receipt: { ...profile().documents.receipt!, header: { ...profile().documents.receipt!.header, comment: 'ЛишнийРеквизит' } } } }) });
    await linkEverything(sys);
    mock = new MockOneC(profile());
    // сервер ещё считает прежнее описание: у него нет реквизита «ЛишнийРеквизит»
    env.exchange.current = mock;
    for (const [entity, id, code, name] of [['location', w.locA.id, 'L', 'Склад']] as const) void entity, id, code, name;
    await doReceipt();
    await env.owner.deleteFrom('external_refs').execute();
    await linkEverything(sys);
    await processExchange(env.deps);
    const [job] = await jobs();
    expect(job?.status).toBe('failed');
    expect(job?.attempts).toBe(1);
    expect(job?.lastError).toContain('ЛишнийРеквизит');
  });

  it('неверный пароль не повторяется и пишется в состоянии системы', async () => {
    const sys = await createSystem({ password: 'не тот' });
    await linkEverything(sys);
    await doReceipt();
    await processExchange(env.deps);
    const [job] = await jobs();
    expect(job?.status).toBe('failed');
    expect(job?.lastError).toContain('логин или пароль');
  });

  it('списание и перемещение выгружаются в свои документы, лишние строки не мешают', async () => {
    const sys = await createSystem();
    await linkEverything(sys);
    const keyB = mock.addCatalogItem('Catalog_Склады', 'LB', 'Склад Б');
    await admin()('PUT', `/api/exchange/systems/${sys.id}/links`, { entity: 'location', localId: w.locB.id, remoteKey: keyB });
    await receive(env, w.admin.token, w.locA.id, [{ productId: milk, quantity: 20, expiresOn: w.day(5) }, { productId: kefir, quantity: 20, expiresOn: w.day(5) }], { supplierId });
    expect((await call(env, w.admin.token)('POST', '/api/documents/writeoffs', { locationId: w.locA.id, reason: 'spoiled', lines: [{ productId: milk, quantity: 3 }] })).statusCode).toBe(201);
    expect((await call(env, w.admin.token)('POST', '/api/documents/transfers', { fromLocationId: w.locA.id, toLocationId: w.locB.id, lines: [{ productId: kefir, quantity: 5 }] })).statusCode).toBe(201);
    await processExchange(env.deps);
    await processExchange(env.deps);
    expect((await jobs()).map((j) => j.status).sort()).toEqual(['done', 'done', 'done']);
    const wo = mock.all('Document_СписаниеТоваров')[0] as unknown as { Товары: { Количество: number }[] };
    expect(wo.Товары.map((l) => l.Количество)).toEqual([3]);
    const tr = mock.all('Document_ПеремещениеТоваров')[0] as unknown as { СкладПолучатель_Key: string; СкладОтправитель_Key: string };
    expect(tr.СкладПолучатель_Key).toBe(keyB);
    expect(tr.СкладОтправитель_Key).not.toBe(keyB);
  });

  it('продажи не выгружаются, система с отбором по точке берёт только свои документы', async () => {
    const sys = await createSystem({ locationId: w.locB.id });
    await linkEverything(sys, w.locB.id);
    await doReceipt();
    expect(await jobs()).toHaveLength(0);
    await receive(env, w.admin.token, w.locB.id, [{ productId: milk, quantity: 5, expiresOn: w.day(5) }], { supplierId });
    expect(await jobs()).toHaveLength(1);
    await call(env, w.admin.token)('POST', '/api/documents/sales', { locationId: w.locB.id, lines: [{ productId: milk, quantity: 1 }] });
    expect(await jobs()).toHaveLength(1);
    void sys;
  });

  it('автосвязывание находит продукты по артикулу и не трогает неоднозначные', async () => {
    const sys = await createSystem();
    await doReceipt();
    await processExchange(env.deps);
    mock.addCatalogItem('Catalog_Номенклатура', await skuOf(milk), 'Молоко');
    mock.addCatalogItem('Catalog_Номенклатура', await skuOf(kefir), 'Кефир');
    mock.addCatalogItem('Catalog_Номенклатура', await skuOf(kefir), 'Кефир дубль');
    const res = (await admin()('POST', `/api/exchange/systems/${sys.id}/autolink`)).json();
    expect(res.linked).toBe(1);
    const left = (await manager()('GET', `/api/exchange/systems/${sys.id}/unlinked`)).json() as { entity: string; name: string }[];
    expect(left.some((m) => m.entity === 'product' && m.name.includes('Кефир'))).toBe(true);
    expect(left.some((m) => m.entity === 'product' && m.name.includes('Молоко'))).toBe(false);
  });

  it('поиск по справочнику 1С помогает связать вручную', async () => {
    const sys = await createSystem();
    mock.addCatalogItem('Catalog_Номенклатура', 'A1', 'Сметана 20%');
    mock.addCatalogItem('Catalog_Номенклатура', 'A2', 'Творог 5%');
    const res = (await admin()('GET', `/api/exchange/systems/${sys.id}/search?entity=product&q=${encodeURIComponent('смет')}`)).json();
    expect(res).toEqual([{ key: expect.any(String), code: 'A1', name: 'Сметана 20%' }]);
  });

  it('выключенная система не получает заданий, удаление убирает её вместе с очередью', async () => {
    const sys = await createSystem();
    await admin()('PATCH', `/api/exchange/systems/${sys.id}`, { enabled: false });
    await doReceipt();
    expect(await jobs()).toHaveLength(0);
    await admin()('PATCH', `/api/exchange/systems/${sys.id}`, { enabled: true });
    await doReceipt();
    expect(await jobs()).toHaveLength(1);
    expect((await admin()('DELETE', `/api/exchange/systems/${sys.id}`)).statusCode).toBe(204);
    expect(await env.owner.selectFrom('exchange_jobs').select('id').execute()).toHaveLength(0);
  });
});

describe('настоящий сетевой обмен', () => {
  it('разрешённый хост подключается по http, остальные запрещены', async () => {
    const server = await mock.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const url = `http://127.0.0.1:${port}/odata/standard.odata/$metadata`;
      const headers = { authorization: `Basic ${Buffer.from('zapas:secret').toString('base64')}` };
      const ok = await new HttpExchangeTransport({ allowHosts: ['127.0.0.1'] }).request({ method: 'GET', url, headers });
      expect(ok.status).toBe(200);
      expect(ok.body).toContain('Document_ПоступлениеТоваровУслуг');
      await expect(new HttpExchangeTransport({ allowHosts: [] }).request({ method: 'GET', url, headers })).rejects.toMatchObject({ code: 'EEXCHANGE_HTTP' });
      await expect(new HttpExchangeTransport({ allowHosts: [] }).request({ method: 'GET', url: `https://127.0.0.1:${port}/x`, headers })).rejects.toMatchObject({ code: 'ESSRF' });
    } finally {
      server.close();
    }
  });
});

describe('форматы iiko', () => {
  it('приход выгружается XML для iiko: артикулы, суммы, склад и поставщик из запроса', async () => {
    const doc = await doReceipt();
    const store = '22222222-2222-4222-8222-222222222222';
    const supplier = '33333333-3333-4333-8333-333333333333';
    const res = await manager()('GET', `/api/documents/${doc.documentId}/export/iiko.xml?store=${store}&supplier=${supplier}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain('application/xml');
    expect(res.headers['content-disposition']).toContain('filename*=UTF-8');
    const xml = res.body;
    expect(xml).toContain(`<documentNumber>${doc.number}</documentNumber>`);
    expect(xml).toContain(`<defaultStore>${store}</defaultStore>`);
    expect(xml).toContain(`<supplier>${supplier}</supplier>`);
    expect(xml).toContain(`<productArticle>${await skuOf(milk)}</productArticle>`);
    expect(xml).toMatch(/<amount>10<\/amount>\s*<price>70\.00<\/price>\s*<sum>700\.00<\/sum>/);
    expect(xml).toMatch(/<dateIncoming>\d{2}\.\d{2}\.\d{4}<\/dateIncoming>/);
  });

  it('списание не выгружается в iiko, неверный идентификатор склада отклоняется, нужны права менеджера', async () => {
    await doReceipt();
    const wo = await call(env, w.admin.token)('POST', '/api/documents/writeoffs', { locationId: w.locA.id, reason: 'spoiled', lines: [{ productId: milk, quantity: 1 }] });
    expect((await manager()('GET', `/api/documents/${wo.json().documentId}/export/iiko.xml`)).statusCode).toBe(422);
    const doc = await doReceipt();
    expect((await manager()('GET', `/api/documents/${doc.documentId}/export/iiko.xml?store=не-guid`)).statusCode).toBe(400);
    expect((await call(env, w.keeperA.token)('GET', `/api/documents/${doc.documentId}/export/iiko.xml`)).statusCode).toBe(403);
  });
});
