import type { ImportPreviewDto, ImportResultDto } from '@zapas/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeCp1251 } from '../src/db/seed/upd-sample';
import { toCsv } from '../src/lib/csv';
import { decodeCsv, detectDelimiter, parseCsv } from '../src/modules/catalog/import';
import { addProduct, createWorld, type World } from './fixtures';
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

const b64 = (data: string | Buffer) => Buffer.from(data).toString('base64');
const manager = () => call(env, w.manager.token);
const preview = async (data: string | Buffer, createCategories = true, token = w.manager.token) =>
  call(env, token)('POST', '/api/products/import/preview', { content: b64(data), createCategories });
const apply = async (data: string | Buffer, createCategories = true, token = w.manager.token) =>
  call(env, token)('POST', '/api/products/import', { content: b64(data), createCategories });

const HEAD = 'Код;Наименование;Группа;Ед. изм.;Цена;Себестоимость;Штрихкод';
const file = (...rows: string[]) => [HEAD, ...rows].join('\r\n');
const rowOf = (p: ImportPreviewDto, line: number) => p.rows.find((r) => r.line === line);
const products = () => env.owner.selectFrom('products').selectAll().orderBy('sku').execute();

describe('разбор CSV', () => {
  it('кавычки, разделитель и перевод строки внутри ячейки, удвоенные кавычки', () => {
    const rows = parseCsv('a;b;c\r\n"x;1";"два ""слова""";"строка\nвторая"\r\n', ';');
    expect(rows).toEqual([
      { line: 1, cells: ['a', 'b', 'c'] },
      { line: 2, cells: ['x;1', 'два "слова"', 'строка\nвторая'] },
    ]);
  });

  it('пустые строки пропускаются, а номера строк совпадают с Excel', () => {
    const rows = parseCsv('a;b\n\n1;2\n;\n3;4', ';');
    expect(rows.map((r) => r.line)).toEqual([1, 3, 5]);
  });

  it('разделитель определяется по заголовку', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(detectDelimiter('"a;b",c,d\n')).toBe(',');
  });

  it('кодировка: utf-8 с BOM и без, иначе windows-1251', () => {
    expect(decodeCsv(Buffer.from('﻿Код;Имя', 'utf8'))).toEqual({ text: 'Код;Имя', encoding: 'utf-8' });
    expect(decodeCsv(Buffer.from('Код;Имя', 'utf8')).encoding).toBe('utf-8');
    expect(decodeCsv(encodeCp1251('Код;Молоко «Донское»'))).toEqual({ text: 'Код;Молоко «Донское»', encoding: 'windows-1251' });
  });
});

describe('предпросмотр', () => {
  it('разбирает выгрузку: что создастся, что изменится, что без изменений и что с ошибкой', async () => {
    const cat = (await env.owner.insertInto('categories').values({ name: 'Молочные' }).returning('id').executeTakeFirstOrThrow()).id;
    const sameId = await addProduct(env, cat, { name: 'Кефир 2,5%', unit: 'l', price: 90, cost: 55 });
    const changedId = await addProduct(env, cat, { name: 'Сметана', unit: 'kg', price: 300, cost: 200 });
    const [same, changed] = await env.owner.selectFrom('products').select(['id', 'sku']).where('id', 'in', [sameId, changedId]).execute().then((r) => [r.find((x) => x.id === sameId)!, r.find((x) => x.id === changedId)!]);

    const res = await preview(
      file(
        `${same.sku};Кефир 2,5%;Молочные;л;90,00;55;`,
        `${changed.sku};Сметана 20%;Молочные;кг;329,90;200;`,
        'NEW-1;Йогурт греческий;Молочные;шт;120;70;4607000010006',
        'NEW-2;Булочка;Выпечка;шт;35;18;',
        `NEW-3;Без единицы;Молочные;;10;5;`,
      ),
    );
    expect(res.statusCode, res.body).toBe(200);
    const p = res.json() as ImportPreviewDto;
    expect(p).toMatchObject({ total: 5, create: 2, update: 1, skip: 1, errors: 1, encoding: 'utf-8', delimiter: ';' });
    expect(p.newCategories).toEqual(['Выпечка']);
    expect(p.columns.map((c) => c.field)).toEqual(['sku', 'name', 'category', 'unit', 'price', 'cost', 'barcode']);
    expect(rowOf(p, 3)).toMatchObject({ action: 'update', changes: ['название: «Сметана» → «Сметана 20%»', 'цена: 300 → 329,9'] });
    expect(rowOf(p, 2)?.action).toBe('skip');
    expect(rowOf(p, 4)?.action).toBe('create');
    expect(rowOf(p, 6)?.messages.join(' ')).toContain('Не указана единица');
    // ошибки показываются первыми
    expect(p.rows[0]?.action).toBe('error');
    // предпросмотр ничего не записывает
    expect(await products()).toHaveLength(2);
    expect((await env.owner.selectFrom('categories').select('name').execute()).map((c) => c.name).sort()).toEqual(['Молочные', 'Молочные продукты']);
  });

  it('понимает windows-1251, запятую, табуляцию и английские названия колонок', async () => {
    const cp = await preview(encodeCp1251(file('A-1;Молоко «Донское»;Молочные;л;95;60;')));
    expect(cp.json()).toMatchObject({ encoding: 'windows-1251', create: 1 });
    expect(cp.json().rows[0].name).toBe('Молоко «Донское»');

    const comma = await preview('sku,name,category,unit,price,cost\nB-1,Milk,Dairy,l,95.5,60\n');
    expect(comma.json()).toMatchObject({ delimiter: ',', create: 1, errors: 0 });
    const tab = await preview('Артикул\tНазвание\tКатегория\tЕдиница\tЦена\nC-1\tСыр\tМолочные\tкг\t500');
    expect(tab.json()).toMatchObject({ delimiter: '\t', create: 1 });
  });

  it('ошибки по строкам: повторы в файле, чужой штрихкод, неверные значения, лишние символы', async () => {
    const cat = (await env.owner.insertInto('categories').values({ name: 'Молочные' }).returning('id').executeTakeFirstOrThrow()).id;
    const owner = await addProduct(env, cat, { name: 'Владелец штрихкода' });
    await env.owner.updateTable('products').set({ barcode: '4006381333931' }).where('id', '=', owner).execute();

    const res = await preview(
      file(
        'D-1;Первый;Молочные;шт;10;5;',
        'd-1;Второй с тем же артикулом;Молочные;шт;10;5;',
        'D-2;Чужой штрихкод;Молочные;шт;10;5;4006381333931',
        'D-3;Новый штрихкод;Молочные;шт;10;5;4607000010006',
        'D-4;Тот же штрихкод в файле;Молочные;шт;10;5;4607000010006',
        'D-5;Цена текстом;Молочные;шт;дорого;5;',
        'D-6;Отрицательная;Молочные;шт;-5;5;',
        'D-7;Неизвестная единица;Молочные;пачка;10;5;',
        'D-8;Строка с ‮обратным текстом;Молочные;шт;10;5;',
        'Д 9 с пробелами;Артикул с пробелами;Молочные;шт;10;5;',
        ';Без артикула;Молочные;шт;10;5;',
        'D-11;;Молочные;шт;10;5;',
      ),
      false,
    );
    const p = res.json() as ImportPreviewDto;
    expect(p.create).toBe(2);
    expect(p.errors).toBe(10);
    const msg = (line: number) => rowOf(p, line)?.messages.join(' ') ?? '';
    expect(msg(3)).toContain('Артикул повторяется');
    expect(msg(4)).toContain('Штрихкод 4006381333931 уже у продукта «Владелец штрихкода»');
    expect(msg(6)).toContain('Штрихкод 4607000010006 повторяется');
    expect(msg(7)).toContain('Цена');
    expect(msg(8)).toContain('Цена');
    expect(msg(9)).toContain('Единица');
    expect(msg(10)).toContain('Недопустимые символы');
    expect(msg(11)).toMatch(/Артикул/);
    expect(msg(12)).toContain('Не указан артикул');
    expect(msg(13)).toContain('Не указано название');
  });

  it('категории: неизвестная без разрешения это ошибка, с разрешением создаётся, регистр не важен', async () => {
    await env.owner.insertInto('categories').values({ name: 'Молочные' }).execute();
    const csv = file('E-1;А;молочные;шт;1;1;', 'E-2;Б;Бакалея;шт;1;1;', 'E-3;В;БАКАЛЕЯ;шт;1;1;');
    const strict = (await preview(csv, false)).json() as ImportPreviewDto;
    expect(strict).toMatchObject({ create: 1, errors: 2 });
    expect(rowOf(strict, 3)?.messages.join(' ')).toContain('Категории «Бакалея» нет');
    const open = (await preview(csv, true)).json() as ImportPreviewDto;
    expect(open).toMatchObject({ create: 3, errors: 0, newCategories: ['Бакалея'] });
  });

  it('у существующего продукта единица не меняется, а нераспознанная единица только предупреждает', async () => {
    const cat = (await env.owner.insertInto('categories').values({ name: 'Молочные' }).returning('id').executeTakeFirstOrThrow()).id;
    await addProduct(env, cat, { name: 'Кефир', unit: 'l' });
    const sku = (await products())[0]!.sku;
    const p = (await preview(file(`${sku};Кефир;Молочные;шт;;;`, `${sku.toLowerCase()};Кефир;Молочные;пачка;;;`), true)).json() as ImportPreviewDto;
    expect(p.errors).toBe(1); // второй раз тот же артикул
    expect(rowOf(p, 2)).toMatchObject({ action: 'skip' });
    expect(rowOf(p, 2)?.messages.join(' ')).toContain('Единица не меняется (в базе л)');
  });

  it('артикул сравнивается без учёта регистра', async () => {
    const cat = (await env.owner.insertInto('categories').values({ name: 'Молочные' }).returning('id').executeTakeFirstOrThrow()).id;
    await addProduct(env, cat, { name: 'Кефир', price: 50 });
    const sku = (await products())[0]!.sku;
    const p = (await preview(file(`${sku.toLowerCase()};Кефир;Молочные;кг;70;;`))).json() as ImportPreviewDto;
    expect(p).toMatchObject({ update: 1, create: 0, errors: 0 });
  });

  it('файлы, которые не подходят, отклоняются понятной ошибкой', async () => {
    const bad = async (data: string | Buffer, text: RegExp) => {
      const res = await preview(data);
      expect(res.statusCode, String(data).slice(0, 30)).toBe(400);
      expect(res.json().error.message).toMatch(text);
    };
    await bad('Название;Цена\nМолоко;10', /артикул/i);
    await bad(HEAD, /только заголовок/);
    await bad('\n\n', /нет строк/);
    await bad('Код;Имя\n"незакрытая;1', /кавычка/);
    await bad(`Код;Имя\n${Array.from({ length: 5001 }, (_, i) => `K${i};Товар`).join('\n')}`, /Больше 5000/);
    await bad(`Код;Имя\nK1;${'я'.repeat(1001)}`, /длиннее/);
    await bad(Array.from({ length: 61 }, (_, i) => `c${i}`).join(';'), /колонок/);
  });

  it('слишком большое и пустое тело отклоняет проверка запроса', async () => {
    expect((await preview(Buffer.alloc(2_100_000, 97))).statusCode).toBe(400);
    expect((await manager()('POST', '/api/products/import/preview', { content: '' })).statusCode).toBe(400);
    expect((await manager()('POST', '/api/products/import/preview', { content: 'QQ==', lost: 1 })).statusCode).toBe(400);
  });

  it('только менеджер и выше', async () => {
    const csv = file('F-1;А;Молочные;шт;1;1;');
    expect((await preview(csv, true, w.keeperA.token)).statusCode).toBe(403);
    expect((await preview(csv, true, w.viewerA.token)).statusCode).toBe(403);
    expect((await apply(csv, true, w.keeperA.token)).statusCode).toBe(403);
    expect((await call(env, null)('POST', '/api/products/import', { content: b64(csv) })).statusCode).toBe(401);
    expect((await preview(csv, true, w.admin.token)).statusCode).toBe(200);
  });
});

describe('применение', () => {
  it('создаёт продукты и категории, меняет существующие, пишет аудит', async () => {
    const cat = (await env.owner.insertInto('categories').values({ name: 'Молочные' }).returning('id').executeTakeFirstOrThrow()).id;
    const id = await addProduct(env, cat, { name: 'Сметана', unit: 'kg', price: 300, cost: 200 });
    const sku = (await env.owner.selectFrom('products').select('sku').where('id', '=', id).executeTakeFirstOrThrow()).sku;

    const res = await apply(file(`${sku};Сметана 20%;Молочные;кг;329,90;;`, 'NEW-1;Булочка;Выпечка;шт;35,5;18;4607000010006', 'BAD;Ошибочная;Молочные;пачка;1;1;'));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json() as ImportResultDto).toEqual({ created: 1, updated: 1, skipped: 1, categoriesCreated: 1 });

    const rows = await products();
    expect(rows.map((r) => r.sku)).toEqual(['NEW-1', sku].sort());
    const bun = rows.find((r) => r.sku === 'NEW-1')!;
    expect(bun).toMatchObject({ name: 'Булочка', unit: 'pcs', barcode: '4607000010006', sellable: true, is_active: true });
    expect(Number(bun.price)).toBe(35.5);
    const cats = await env.owner.selectFrom('categories').select(['id', 'name']).execute();
    expect(cats.find((c) => c.id === bun.category_id)?.name).toBe('Выпечка');
    const upd = rows.find((r) => r.id === id)!;
    expect(upd).toMatchObject({ name: 'Сметана 20%' });
    expect(Number(upd.price)).toBe(329.9);
    expect(Number(upd.cost)).toBe(200); // колонка пустая: не трогаем

    const audit = await env.owner.selectFrom('audit_log').select('details').where('action', '=', 'product.import').executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({ created: 1, updated: 1, errors: 1, categories: 1, createdSkus: ['NEW-1'] });
  });

  it('повторная загрузка того же файла ничего не меняет и честно об этом говорит', async () => {
    const csv = file('G-1;Булочка;Выпечка;шт;35;18;');
    expect((await apply(csv)).statusCode).toBe(200);
    const again = await apply(csv);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('nothing_to_import');
    expect(await products()).toHaveLength(1);
    expect(((await preview(csv)).json() as ImportPreviewDto).skip).toBe(1);
  });

  it('изменение цены сразу видно в карточке и не трогает остатки и партии', async () => {
    const cat = (await env.owner.insertInto('categories').values({ name: 'Молочные' }).returning('id').executeTakeFirstOrThrow()).id;
    const id = await addProduct(env, cat, { name: 'Кефир', unit: 'l', price: 90, cost: 55 });
    const sku = (await products())[0]!.sku;
    await env.owner.insertInto('batches').values({ product_id: id, location_id: w.locA.id, supplier_id: null, received_on: w.today, expires_on: w.day(5), initial_qty: 10, remaining_qty: 10, unit_cost: 55, origin_document_id: null, created_at: env.clock.now }).execute().catch(() => undefined);
    const before = await env.owner.selectFrom('batches').select('remaining_qty').where('product_id', '=', id).execute();
    await apply(file(`${sku};;;;99;;`));
    const dto = (await manager()('GET', `/api/products?q=${encodeURIComponent(sku)}`)).json().items[0];
    expect(dto.price).toBe(99);
    expect(await env.owner.selectFrom('batches').select('remaining_qty').where('product_id', '=', id).execute()).toEqual(before);
  });

  it('одновременная загрузка одного файла не создаёт дублей и не падает ошибкой сервера', async () => {
    const csv = file('H-1;Булочка;Выпечка;шт;35;18;', 'H-2;Круассан;Выпечка;шт;55;30;');
    const [a, b] = await Promise.all([apply(csv), apply(csv)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(await products()).toHaveLength(2);
    // категория мира плюс одна «Выпечка», созданная ровно один раз
    expect((await env.owner.selectFrom('categories').select('id').execute()).length).toBe(2);
  });

  it('если артикул завели вручную между просмотром и применением, продукт не дублируется', async () => {
    const csv = file('I-1;Булочка;Выпечка;шт;35;18;');
    const seen = (await preview(csv)).json() as ImportPreviewDto;
    expect(seen.create).toBe(1);
    const cat = (await env.owner.insertInto('categories').values({ name: 'Выпечка' }).returning('id').executeTakeFirstOrThrow()).id;
    await env.owner.insertInto('products').values({ sku: 'I-1', name: 'Булочка', category_id: cat, unit: 'pcs', min_stock: 0, price: 35, cost: 18, sellable: true, created_at: env.clock.now, updated_at: env.clock.now }).execute();
    const res = await apply(csv);
    expect(res.statusCode).toBe(409);
    expect(await products()).toHaveLength(1);
  });

  it('формулы в названиях сохраняются как обычный текст, а в выгрузках экранируются', async () => {
    const res = await apply(file('J-1;"=HYPERLINK(""http://x"";""y"")";Выпечка;шт;1;1;'));
    expect(res.statusCode, res.body).toBe(200);
    const stored = (await products())[0]!;
    expect(stored.name).toBe('=HYPERLINK("http://x";"y")');
    expect(toCsv(['Название'], [[stored.name]])).toContain("'=HYPERLINK");
  });
});
