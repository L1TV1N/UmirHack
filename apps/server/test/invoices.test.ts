import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { buildUpdXml, encodeCp1251, type SampleLine } from '../src/db/seed/upd-sample';
import { MemoryNotifier } from '../src/modules/notifications/notifier';
import { createWorld, receive, type World } from './fixtures';
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

const INN = '7707083893';
const b64 = (xml: string) => Buffer.from(xml, 'utf8').toString('base64');

async function supplier(over: Record<string, unknown> = {}) {
  const res = await call(env, w.manager.token)('POST', '/api/suppliers', { name: 'Молочный комбинат «Донской»', inn: INN, ...over });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; name: string; inn: string | null };
}

async function product(over: Record<string, unknown> = {}) {
  const res = await call(env, w.manager.token)('POST', '/api/products', {
    sku: `INV-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    name: 'Молоко 3,2% пастеризованное',
    categoryId: w.categoryId,
    unit: 'l',
    price: 95,
    cost: 62,
    shelfLifeDays: 7,
    ...over,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; name: string };
}

const sampleLines: SampleLine[] = [{ name: 'Молоко «Донское» 3,2% пастеризованное 0,93 л', code: 'MLK-93', unitCode: '112', quantity: '40', price: '61.50' }];
const xml = (lines: SampleLine[] = sampleLines, over: Record<string, unknown> = {}) =>
  buildUpdXml({ number: 'ДН-100', date: '09.10.2026', supplier: { name: 'ООО «Молочный комбинат «Донской»', inn: INN }, encoding: 'UTF-8', lines, ...over } as Parameters<typeof buildUpdXml>[0]);

const parse = (token: string, text: string) => call(env, token)('POST', '/api/invoices/parse', { format: 'upd', content: b64(text) });

describe('разбор накладной через API', () => {
  it('находит поставщика по ИНН и продукт по названию, отдаёт строки готовыми к приходу', async () => {
    const s = await supplier();
    const p = await product();
    const res = await parse(w.keeperA.token, xml());
    expect(res.statusCode).toBe(200);
    const inv = res.json();
    expect(inv).toMatchObject({ source: 'upd', number: 'ДН-100', date: '2026-10-09', alreadyReceived: null });
    expect(inv.supplier).toMatchObject({ supplierId: s.id, how: 'inn', inn: INN });
    expect(inv.lines).toHaveLength(1);
    expect(inv.lines[0]).toMatchObject({ code: 'MLK-93', quantity: 40, price: 61.5, unit: 'l', unitMismatch: false, key: 'code:MLK-93' });
    expect(inv.lines[0].match).toMatchObject({ how: 'similar', product: { id: p.id, unit: 'l' } });
    expect(inv.lines[0].converted).toEqual({ quantity: 40, price: 61.5 });
  });

  it('продукт по штрихкоду из накладной важнее названия', async () => {
    await supplier();
    const byName = await product({ name: 'Молоко 3,2% пастеризованное' });
    const target = await product({ name: 'Совсем другое название', barcode: '4006381333931', unit: 'pcs' });
    const res = await parse(w.keeperA.token, xml([{ name: 'Молоко 3,2% пастеризованное', quantity: '5', price: '70', gtin: '4006381333931' }]));
    expect(res.json().lines[0].match).toMatchObject({ how: 'barcode', product: { id: target.id } });
    expect(res.json().lines[0].match.product.id).not.toBe(byName.id);
  });

  it('GTIN-14 в накладной находит продукт, записанный как EAN-13', async () => {
    await supplier();
    const p = await product({ barcode: '4006381333931', unit: 'pcs', name: 'Фломастер' });
    const res = await parse(w.keeperA.token, xml([{ name: 'Что-то непохожее', quantity: '5', price: '70', gtin: '04006381333931' }]));
    expect(res.json().lines[0].match).toMatchObject({ how: 'barcode', product: { id: p.id } });
  });

  it('точное название даёт «по названию», непохожее остаётся без продукта с подсказками', async () => {
    await supplier();
    await product({ name: 'Сметана 20%', unit: 'kg' });
    await product({ name: 'Сметана 15%', unit: 'kg' });
    const res = await parse(w.keeperA.token, xml([{ name: 'сметана 20%', unitCode: '166', quantity: '8', price: '210' }, { name: 'Ананасы консервированные', quantity: '3', price: '150' }]));
    const [a, b] = res.json().lines;
    expect(a.match).toMatchObject({ how: 'name', product: { name: 'Сметана 20%' } });
    expect(b.match).toBeNull();
    expect(res.json().warnings.join(' ')).toContain('Не нашлось продуктов для строк: 1');
  });

  it('граммы и миллилитры пересчитываются в единицы продукта', async () => {
    await supplier();
    await product({ name: 'Творог 5%', unit: 'kg' });
    const res = await parse(w.keeperA.token, xml([{ name: 'Творог 5%', unitCode: '163', quantity: '2500', price: '0.29' }]));
    expect(res.json().lines[0]).toMatchObject({ unit: 'g', quantity: 2500, converted: { quantity: 2.5, price: 290 }, unitMismatch: false });
  });

  it('штуки при весовом продукте это несовпадение единиц, а не молчаливая ошибка', async () => {
    await supplier();
    await product({ name: 'Творог 5%', unit: 'kg' });
    const res = await parse(w.keeperA.token, xml([{ name: 'Творог 5%', unitCode: '796', quantity: '10', price: '90' }]));
    expect(res.json().lines[0]).toMatchObject({ unitMismatch: true, converted: null });
    expect(res.json().warnings.join(' ')).toContain('Единицы не сходятся');
  });

  it('поставщик по названию, если ИНН не указан в справочнике, и предупреждение, если его нет совсем', async () => {
    await supplier({ inn: '' });
    const byName = await parse(w.keeperA.token, xml());
    expect(byName.json().supplier).toMatchObject({ how: 'name' });
    expect(byName.json().supplier.supplierId).toBeTruthy();

    const other = await parse(w.keeperA.token, xml(sampleLines, { supplier: { name: 'ООО «Неизвестный»', inn: '7736050003' } }));
    expect(other.json().supplier).toMatchObject({ supplierId: null, how: null, name: 'ООО «Неизвестный»' });
    expect(other.json().warnings.join(' ')).toContain('нет в справочнике');
  });

  it('повторная накладная того же поставщика с тем же номером помечается', async () => {
    const s = await supplier();
    const p = await product();
    await receive(env, w.manager.token, w.locA.id, [{ productId: p.id, quantity: 5, expiresOn: w.day(5) }], { supplierId: s.id, documentNo: 'ДН-100' });
    const inv = (await parse(w.keeperA.token, xml())).json();
    expect(inv.alreadyReceived).toMatchObject({ receivedOn: w.today });
    expect(inv.alreadyReceived.documentNumber).toMatch(/^ПР-/);
    expect(inv.warnings[0]).toContain('уже оприходована');
    // другой номер того же поставщика повторным не считается
    expect((await parse(w.keeperA.token, xml(sampleLines, { number: 'ДН-101' }))).json().alreadyReceived).toBeNull();
  });

  it('файл в windows-1251 принимается через API', async () => {
    await supplier();
    const text = buildUpdXml({ number: 'Н-1', date: '09.10.2026', supplier: { name: 'ООО «Молочный комбинат «Донской»', inn: INN }, encoding: 'windows-1251', lines: [{ name: 'Молоко «Донское»', quantity: '3', price: '60' }] });
    const res = await call(env, w.keeperA.token)('POST', '/api/invoices/parse', { format: 'upd', content: encodeCp1251(text).toString('base64') });
    expect(res.statusCode).toBe(200);
    expect(res.json().lines[0].name).toBe('Молоко «Донское»');
  });

  it('роли: наблюдателю нельзя, кладовщику и выше можно', async () => {
    expect((await parse(w.viewerA.token, xml())).statusCode).toBe(403);
    for (const s of [w.keeperA, w.manager, w.admin]) expect((await parse(s.token, xml())).statusCode).toBe(200);
    expect((await call(env, null)('POST', '/api/invoices/parse', { format: 'upd', content: b64(xml()) })).statusCode).toBe(401);
    expect((await call(env, w.viewerA.token)('GET', '/api/invoices/capabilities')).statusCode).toBe(403);
  });

  it('плохой файл это 400 с понятным текстом, а не 500', async () => {
    const notXml = await parse(w.keeperA.token, 'это вообще не xml, просто текст');
    expect(notXml.statusCode).toBe(400);
    expect(notXml.json().error.code).toBe('invoice_format');
    const other = await parse(w.keeperA.token, '<?xml version="1.0"?><Другое/>');
    expect(other.json().error.message).toContain('универсальный передаточный документ');
    const evil = await parse(w.keeperA.token, '<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><Файл/>');
    expect(evil.statusCode).toBe(400);
    expect(evil.json().error.message).toContain('DOCTYPE');
  });

  it('неверное тело и слишком большой файл отклоняются', async () => {
    expect((await call(env, w.keeperA.token)('POST', '/api/invoices/parse', { format: 'csv', content: b64(xml()) })).statusCode).toBe(400);
    expect((await call(env, w.keeperA.token)('POST', '/api/invoices/parse', { format: 'upd', content: '<xml>' })).statusCode).toBe(400);
    expect((await call(env, w.keeperA.token)('POST', '/api/invoices/parse', { format: 'upd', content: Buffer.alloc(3.2 * 1024 * 1024, 65).toString('base64') })).statusCode).toBe(400);
  });
});

describe('запоминание соответствий', () => {
  it('выбор человека сохраняется, и следующая накладная находит продукт сама «как в прошлый раз»', async () => {
    const s = await supplier();
    const p = await product({ name: 'Ряженка 4%', unit: 'l' });
    const strange = [{ name: 'Продукт кисломолочный «Топлёночка»', code: 'TOP-1', unitCode: '112', quantity: '10', price: '70' }];
    const first = (await parse(w.keeperA.token, xml(strange))).json();
    expect(first.lines[0].match).toBeNull();

    const saved = await call(env, w.keeperA.token)('PUT', `/api/suppliers/${s.id}/item-map`, { items: [{ key: first.lines[0].key, productId: p.id }] });
    expect(saved.statusCode).toBe(204);

    const second = (await parse(w.keeperA.token, xml(strange, { number: 'ДН-102' }))).json();
    expect(second.lines[0].match).toMatchObject({ how: 'mapping', product: { id: p.id } });
  });

  it('повторное сохранение заменяет прежний выбор', async () => {
    const s = await supplier();
    const a = await product({ name: 'Продукт А', unit: 'l' });
    const b = await product({ name: 'Продукт Б', unit: 'l' });
    const put = (productId: string) => call(env, w.keeperA.token)('PUT', `/api/suppliers/${s.id}/item-map`, { items: [{ key: 'code:X1', productId }] });
    await put(a.id);
    await put(b.id);
    const rows = await env.owner.selectFrom('supplier_item_map').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.product_id).toBe(b.id);
  });

  it('чужой поставщик, неизвестный продукт и роль проверяются, запись попадает в аудит', async () => {
    const s = await supplier();
    const p = await product();
    const item = { key: 'code:A', productId: p.id };
    expect((await call(env, w.viewerA.token)('PUT', `/api/suppliers/${s.id}/item-map`, { items: [item] })).statusCode).toBe(403);
    expect((await call(env, w.keeperA.token)('PUT', '/api/suppliers/00000000-0000-4000-8000-000000000000/item-map', { items: [item] })).statusCode).toBe(404);
    expect((await call(env, w.keeperA.token)('PUT', `/api/suppliers/${s.id}/item-map`, { items: [{ key: 'code:B', productId: '00000000-0000-4000-8000-000000000000' }] })).json().error.code).toBe('unknown_product');
    expect((await call(env, w.keeperA.token)('PUT', `/api/suppliers/${s.id}/item-map`, { items: [item] })).statusCode).toBe(204);
    const audit = await env.owner.selectFrom('audit_log').select('action').where('action', '=', 'supplier.item_map').execute();
    expect(audit).toHaveLength(1);
  });
});

describe('фото накладной', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]).toString('base64');
  const photo = (token: string, over: Record<string, unknown> = {}) => call(env, token)('POST', '/api/invoices/parse-photo', { mediaType: 'image/jpeg', image: jpeg, ...over });

  it('возможность видна клиенту: фото подключено, когда есть читатель', async () => {
    expect((await call(env, w.keeperA.token)('GET', '/api/invoices/capabilities')).json()).toEqual({ upd: true, photo: true });
  });

  it('читает фото через сервис распознавания и сопоставляет строки так же, как для УПД', async () => {
    const s = await supplier();
    const p = await product();
    env.invoiceReader.result = {
      number: 'Ф-5',
      date: '2026-10-09',
      supplier: { name: 'Молочный комбинат «Донской»', inn: INN },
      total: null,
      lines: [{ name: 'Молоко 3,2% пастеризованное', code: null, gtin: null, unit: 'l', quantity: 12, price: 60, expiresOn: '2026-10-16', batch: null, vsd: null, marks: [] }],
      warnings: ['Данные распознаны с фото: сверьте количество, цены и сроки с бумагой'],
    };
    const res = await photo(w.keeperA.token);
    expect(res.statusCode).toBe(200);
    const inv = res.json();
    expect(inv.source).toBe('photo');
    expect(inv.supplier).toMatchObject({ supplierId: s.id });
    expect(inv.lines[0]).toMatchObject({ expiresOn: '2026-10-16', match: { how: 'name', product: { id: p.id } } });
    expect(inv.warnings[0]).toContain('сверьте');
    expect(env.invoiceReader.calls).toEqual([{ bytes: 204, mediaType: 'image/jpeg' }]);
  });

  it('использование записывается в аудит без самой картинки', async () => {
    await photo(w.keeperA.token);
    const rows = await env.owner.selectFrom('audit_log').select(['action', 'details']).where('action', '=', 'invoice.photo').execute();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]?.details)).not.toContain('/9j');
  });

  it('сбой сервиса распознавания это 502 с понятным текстом, подробности наружу не идут', async () => {
    env.invoiceReader.failure = new Error('401 invalid x-api-key sk-ant-секрет');
    const res = await photo(w.keeperA.token);
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('invoice_reader_failed');
    expect(res.body).not.toContain('sk-ant');
  });

  it('картинка с неверным содержимым, слишком большая или не тот тип отклоняются', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50)]).toString('base64');
    expect((await photo(w.keeperA.token, { image: png })).json().error.code).toBe('invoice_format'); // заявлен jpeg, а это png
    expect((await photo(w.keeperA.token, { image: Buffer.from('<html>').toString('base64').padEnd(40, 'A') })).statusCode).toBe(400);
    expect((await photo(w.keeperA.token, { mediaType: 'application/pdf' })).statusCode).toBe(400);
    const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(5.2 * 1024 * 1024)]).toString('base64');
    expect((await photo(w.keeperA.token, { image: huge })).json().error.code).toBe('invoice_too_large');
    expect(env.invoiceReader.calls).toHaveLength(0);
  });

  it('роль: наблюдатель не может', async () => {
    expect((await photo(w.viewerA.token)).statusCode).toBe(403);
  });

  it('без ключа сервиса распознавания фото выключено, УПД работает', async () => {
    const bare = await buildApp({ db: env.db, config: env.config, clock: () => env.clock.now, notifier: new MemoryNotifier() });
    await bare.ready();
    try {
      const auth = { authorization: `Bearer ${w.keeperA.token}` };
      const caps = await bare.inject({ method: 'GET', url: '/api/invoices/capabilities', headers: auth });
      expect(caps.json()).toEqual({ upd: true, photo: false });
      const res = await bare.inject({ method: 'POST', url: '/api/invoices/parse-photo', headers: auth, payload: { mediaType: 'image/jpeg', image: jpeg } });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('invoice_photo_disabled');
      expect((await bare.inject({ method: 'POST', url: '/api/invoices/parse', headers: auth, payload: { format: 'upd', content: b64(xml()) } })).statusCode).toBe(200);
    } finally {
      await bare.close();
    }
  });
});

describe('ИНН поставщика', () => {
  it('сохраняется, отдаётся в списке и меняется', async () => {
    const s = await supplier({ name: 'ООО «Один»' });
    expect(s.inn).toBe(INN);
    const list = (await call(env, w.keeperA.token)('GET', '/api/suppliers')).json();
    expect(list[0].inn).toBe(INN);
    const patched = await call(env, w.manager.token)('PATCH', `/api/suppliers/${s.id}`, { name: 'ООО «Один»', inn: '7736050003' });
    expect(patched.json().inn).toBe('7736050003');
    // не указан в запросе: не трогаем, пустая строка: очищаем
    expect((await call(env, w.manager.token)('PATCH', `/api/suppliers/${s.id}`, { name: 'ООО «Один»' })).json().inn).toBe('7736050003');
    expect((await call(env, w.manager.token)('PATCH', `/api/suppliers/${s.id}`, { name: 'ООО «Один»', inn: '' })).json().inn).toBeNull();
  });

  it('неверный ИНН это 400, занятый это 409', async () => {
    const bad = await call(env, w.manager.token)('POST', '/api/suppliers', { name: 'ООО «Плохой»', inn: '7707083890' });
    expect(bad.statusCode).toBe(400);
    await supplier({ name: 'ООО «Первый»' });
    const dup = await call(env, w.manager.token)('POST', '/api/suppliers', { name: 'ООО «Второй»', inn: INN });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('duplicate_inn');
  });
});
