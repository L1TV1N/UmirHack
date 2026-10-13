import type { PosConnectionCreatedDto, PosInboxDto, PosUnmatchedDto } from '@zapas/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POS_PRESETS } from '../src/modules/pos/presets';
import { addDish, addProduct, createWorld, receive, remaining, type World } from './fixtures';
import { call, createTestEnv, type TestEnv } from './helpers';

let env: TestEnv;
let w: World;

beforeAll(async () => {
  env = await createTestEnv({ ACCESS_TOKEN_TTL_SECONDS: '3600' });
});
afterAll(() => env.close());

const admin = () => call(env, w.admin.token);
const manager = () => call(env, w.manager.token);

let milk: string;
let borsch: string;

beforeEach(async () => {
  await env.reset();
  w = await createWorld(env);
  milk = await addProduct(env, w.categoryId, { name: 'Кефир 2,5%', unit: 'pcs', price: 95 });
  await env.db.updateTable('products').set({ barcode: '4607000011119' }).where('id', '=', milk).execute();
  const beet = await addProduct(env, w.categoryId, { name: 'Свёкла', unit: 'kg' });
  borsch = await addDish(env, 'Борщ с говядиной', 290, [{ productId: beet, quantity: 0.2 }]);
  await env.db.updateTable('dishes').set({ code: 'BORSCH' }).where('id', '=', borsch).execute();
  await receive(env, w.admin.token, w.locA.id, [{ productId: milk, quantity: 50, expiresOn: w.day(7) }, { productId: beet, quantity: 20, expiresOn: w.day(7) }]);
});

async function connect(vendor: string, over: Record<string, unknown> = {}): Promise<PosConnectionCreatedDto> {
  const res = await admin()('POST', '/api/pos/connections', { name: `Касса ${vendor}`, locationId: w.locA.id, vendor, ...over });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

const ingest = (key: string, body: unknown, type = 'application/json', query = '') =>
  env.app.inject({ method: 'POST', url: `/api/pos/ingest${query}`, payload: body as string, headers: { 'x-api-key': key, 'content-type': type } });

const sample = (vendor: keyof typeof POS_PRESETS) => POS_PRESETS[vendor].sample;
const documents = () => env.owner.selectFrom('documents').select(['id', 'number']).where('kind', '=', 'sale').execute();
const inbox = async (): Promise<PosInboxDto[]> => (await manager()('GET', '/api/pos/inbox')).json();

describe('подключения касс', () => {
  it('ключ виден один раз, настройка только у администратора, действие попадает в журнал', async () => {
    const c = await connect('evotor');
    expect(c.key).toMatch(/^zk_/);
    expect(c.vendor).toBe('evotor');
    expect(c.rules.format).toBe('json');
    const list = (await manager()('GET', '/api/pos/connections')).json();
    expect(JSON.stringify(list)).not.toContain(c.key);
    expect(await env.owner.selectFrom('audit_log').select('id').where('action', '=', 'pos.connect').execute()).toHaveLength(1);
    expect((await manager()('POST', '/api/pos/connections', { name: 'x', locationId: w.locA.id, vendor: 'generic' })).statusCode).toBe(403);
    expect((await call(env, w.keeperA.token)('GET', '/api/pos/connections')).statusCode).toBe(403);
    expect((await call(env, null)('GET', '/api/pos/connections')).statusCode).toBe(401);
    expect((await admin()('GET', '/api/pos/presets')).json()).toHaveLength(6);
  });

  it('ключ кассы не открывает пользовательские разделы, а пользователь не отправляет чеки', async () => {
    const c = await connect('evotor');
    expect((await env.app.inject({ method: 'GET', url: '/api/pos/inbox', headers: { 'x-api-key': c.key } })).statusCode).toBe(401);
    expect((await admin()('POST', '/api/pos/ingest', {})).statusCode).toBe(401);
  });
});

describe('приём чеков', () => {
  it('Эвотор: продажа блюда по коду и продукта по штрихкоду списывает остатки по рецептуре', async () => {
    const c = await connect('evotor');
    const before = await remaining(env, milk, w.locA.id);
    const res = await ingest(c.key, sample('evotor'));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().results[0]).toMatchObject({ externalId: 'a1b2c3d4-0001', status: 'done', duplicate: false });
    expect(await remaining(env, milk, w.locA.id)).toBe(before - 1);
    expect(await documents()).toHaveLength(1);
    const beet = await env.owner.selectFrom('dish_items').select('product_id').where('dish_id', '=', borsch).executeTakeFirstOrThrow();
    expect(await remaining(env, beet.product_id, w.locA.id)).toBeCloseTo(20 - 0.4, 3);
  });

  it('повтор того же чека не списывает второй раз', async () => {
    const c = await connect('evotor');
    await ingest(c.key, sample('evotor'));
    const again = await ingest(c.key, sample('evotor'));
    expect(again.json().results[0]).toMatchObject({ status: 'done', duplicate: true });
    expect(await documents()).toHaveLength(1);
    expect(await inbox()).toHaveLength(1);
  });

  it('Фронтол: файл CSV с несколькими чеками, возврат только записывается', async () => {
    const c = await connect('frontol');
    const res = await ingest(c.key, sample('frontol'), 'text/csv');
    expect(res.statusCode, res.body).toBe(200);
    const results = res.json().results as { externalId: string; status: string }[];
    expect(results.map((r) => [r.externalId, r.status])).toEqual([['5001', 'done'], ['5002', 'return_logged']]);
    expect(await documents()).toHaveLength(1);
    expect(await remaining(env, milk, w.locA.id)).toBe(49);
  });

  it('Фронтол: выгрузка в windows-1251 читается', async () => {
    const c = await connect('frontol');
    const csv = 'Номер чека;Тип;Код товара;Штрихкод;Наименование;Количество;Цена\n6001;Продажа;BORSCH;;Борщ;1;290\n';
    // собираем байты windows-1251 вручную
    const map = new Map<string, number>();
    const cyr = 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя';
    [...cyr].forEach((ch, i) => map.set(ch, 0xc0 + i));
    map.set('Ё', 0xa8).set('ё', 0xb8);
    const bytes = Buffer.from([...csv].map((ch) => map.get(ch) ?? ch.charCodeAt(0)));
    const res = await env.app.inject({ method: 'POST', url: '/api/pos/ingest', payload: bytes, headers: { 'x-api-key': c.key, 'content-type': 'text/csv' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().results[0].status).toBe('done');
  });

  it('АТОЛ: XML с чеком', async () => {
    const c = await connect('atol');
    const res = await ingest(c.key, sample('atol'), 'application/xml');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().results[0]).toMatchObject({ externalId: '7001', status: 'done' });
  });

  it('iiko и Sigma читаются своими пресетами', async () => {
    const i = await connect('iiko');
    const r1 = await ingest(i.key, sample('iiko').replace('OMELET', 'BORSCH'));
    expect(r1.json().results[0]).toMatchObject({ externalId: 'ord-3001', status: 'done' });
    const s = await connect('sigma');
    const r2 = await ingest(s.key, sample('sigma'));
    expect(r2.json().results[0]).toMatchObject({ externalId: 'S-401', status: 'done' });
  });

  it('любая своя касса настраивается путями к полям', async () => {
    const c = await connect('generic', { rules: { format: 'json', receipts: 'data.checks', id: ['num'], lines: 'rows', code: ['art'], quantity: ['cnt'], delimiter: ';', returnValues: ['x'] } });
    const res = await ingest(c.key, { data: { checks: [{ num: 'Z-1', rows: [{ art: 'BORSCH', cnt: '2' }] }] } });
    expect(res.json().results[0]).toMatchObject({ externalId: 'Z-1', status: 'done' });
    const beet = await env.owner.selectFrom('dish_items').select('product_id').where('dish_id', '=', borsch).executeTakeFirstOrThrow();
    expect(await remaining(env, beet.product_id, w.locA.id)).toBeCloseTo(20 - 0.4, 3);
  });

  it('нечитаемое тело получает понятное объяснение', async () => {
    const c = await connect('evotor');
    const bad = await ingest(c.key, '{"id":"x","body":{"positions":[]}}');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toContain('нет строк');
    const noQty = await ingest(c.key, { id: 'q1', body: { positions: [{ code: 'BORSCH' }] } });
    expect(noQty.statusCode).toBe(400);
    expect(noQty.json().error.message).toContain('количества');
    expect((await ingest(c.key, '', 'text/plain')).statusCode).toBe(400);
    expect(await documents()).toHaveLength(0);
  });
});

describe('неопознанные позиции и отказы', () => {
  const receiptWith = (id: string, code: string) => ({ id, type: 'SELL', body: { positions: [{ name: 'Новинка дня', code, quantity: 2, price: 100 }, { code: 'BORSCH', quantity: 1 }] } });

  it('чек с неизвестным кодом ждёт, после сопоставления проходит сам', async () => {
    const c = await connect('evotor');
    const res = await ingest(c.key, receiptWith('u1', 'NEW-1'));
    expect(res.json().results[0]).toMatchObject({ status: 'pending_match', unmatched: ['NEW-1'] });
    expect(await documents()).toHaveLength(0);
    await ingest(c.key, receiptWith('u2', 'NEW-1'));

    const list = (await manager()('GET', '/api/pos/unmatched')).json() as PosUnmatchedDto[];
    expect(list).toEqual([expect.objectContaining({ ref: 'NEW-1', name: 'Новинка дня', receipts: 2, quantity: 4 })]);

    const mapped = await manager()('PUT', '/api/pos/map', { keyId: c.id, ref: 'NEW-1', entity: 'product', entityId: milk });
    expect(mapped.statusCode, mapped.body).toBe(200);
    expect(mapped.json().replayed).toBe(2);
    expect(await documents()).toHaveLength(2);
    expect(await remaining(env, milk, w.locA.id)).toBe(46);
    expect((await manager()('GET', '/api/pos/unmatched')).json()).toHaveLength(0);
    // новые чеки с этим кодом проходят сразу
    expect((await ingest(c.key, receiptWith('u3', 'NEW-1'))).json().results[0].status).toBe('done');
  });

  it('позицию можно пометить «не считать»: остальное в чеке спишется', async () => {
    const c = await connect('evotor');
    await ingest(c.key, receiptWith('i1', 'BAG'));
    await manager()('PUT', '/api/pos/map', { keyId: c.id, ref: 'BAG', entity: 'ignore' });
    expect((await inbox())[0]?.status).toBe('done');
    expect(await documents()).toHaveLength(1);
  });

  it('нехватка остатка даёт отказ с причиной, после прихода чек можно повторить', async () => {
    const c = await connect('evotor');
    const big = { id: 'big1', type: 'SELL', body: { positions: [{ barcode: '4607000011119', quantity: 80 }] } };
    const res = await ingest(c.key, big);
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0].status).toBe('rejected');
    expect(res.json().results[0].error).toBeTruthy();
    const [row] = await inbox();
    expect(row?.status).toBe('rejected');
    expect((await manager()('POST', `/api/pos/inbox/${row!.id}/retry`)).statusCode).toBe(200);
    expect((await inbox())[0]?.status).toBe('rejected');
    await receive(env, w.admin.token, w.locA.id, [{ productId: milk, quantity: 100, expiresOn: w.day(7) }]);
    const again = await manager()('POST', `/api/pos/inbox/${row!.id}/retry`);
    expect(again.json().status).toBe('done');
    expect((await manager()('POST', `/api/pos/inbox/${row!.id}/retry`)).statusCode).toBe(409);
  });

  it('проверочный запрос ничего не записывает и показывает, что найдено', async () => {
    const c = await connect('evotor');
    const res = await ingest(c.key, receiptWith('d1', 'NEW-2'), 'application/json', '?dryRun=1');
    expect(res.statusCode).toBe(200);
    const [r] = res.json().receipts;
    expect(r.lines[0].match).toBeNull();
    expect(r.lines[1].match).toMatchObject({ entity: 'dish', name: 'Борщ с говядиной' });
    expect(await inbox()).toHaveLength(0);
    expect(await documents()).toHaveLength(0);
  });

  it('предпросмотр по образцу из мастера подключения работает от лица менеджера', async () => {
    const c = await connect('frontol');
    const res = await manager()('POST', `/api/pos/connections/${c.id}/preview`, { payload: sample('frontol') });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().receipts).toHaveLength(2);
    expect(res.json().receipts[1].kind).toBe('return');
    expect((await manager()('POST', `/api/pos/connections/${c.id}/preview`, { payload: 'мусор' })).statusCode).toBe(400);
  });
});

describe('стоп-лист в виде iiko', () => {
  it('позиции отдаются с нулевым остатком по группе терминалов точки', async () => {
    const c = await connect('iiko');
    const stop = await manager()('POST', '/api/stop-list/manual', { locationId: w.locA.id, productId: milk, reason: 'Проверка качества' });
    expect(stop.statusCode, stop.body).toBe(201);
    await env.settle();
    const res = await env.app.inject({ method: 'GET', url: '/api/pos/stop-list/iiko', headers: { 'x-api-key': c.key } });
    expect(res.statusCode, res.body).toBe(200);
    const list = res.json().terminalGroupStopLists[0];
    expect(list.organizationId).toBe(w.locA.id);
    expect(list.items[0].items).toEqual(expect.arrayContaining([expect.objectContaining({ productId: milk, balance: 0, name: 'Кефир 2,5%' })]));
    expect((await env.app.inject({ method: 'GET', url: '/api/pos/stop-list/iiko' })).statusCode).toBe(401);
  });
});
