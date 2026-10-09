import { gtinCheckDigit } from '@zapas/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildUpdXml } from '../src/db/seed/upd-sample';
import { createWorld, type World } from './fixtures';
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

const EAN = '4607000010006';
const GTIN = `0${EAN}`;
const OTHER_EAN = '4006381333931';
const GS = '\u001d';
let serialSeq = 0;
const mark = (gtin = GTIN, serial = `SN${(serialSeq += 1)}x${Math.random().toString(36).slice(2, 8)}`) => `01${gtin}21${serial}${GS}91EE11${GS}92dGVzdHRlc3R0ZXN0dGVzdHRlc3R0ZXN0`;
const vsdId = () => crypto.randomUUID();

async function product(over: Record<string, unknown> = {}) {
  const res = await call(env, w.manager.token)('POST', '/api/products', {
    sku: `TR-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    name: 'Молоко',
    categoryId: w.categoryId,
    unit: 'pcs',
    price: 95,
    cost: 62,
    barcode: EAN,
    requiresVsd: true,
    requiresMarking: true,
    ...over,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; requiresVsd: boolean; requiresMarking: boolean };
}

const receipt = (token: string, locationId: string, lines: object[], key?: string) =>
  call(env, token)('POST', '/api/documents/receipts', { locationId, lines }, key ? { 'idempotency-key': key } : {});
const line = (productId: string, over: Record<string, unknown> = {}) => ({ productId, quantity: 3, unitCost: 60, expiresOn: w.day(7), ...over });

const count = async (table: 'batch_marks' | 'vet_certificates' | 'documents') => (await env.owner.selectFrom(table).select('id').execute()).length;

describe('приём марок и ВСД', () => {
  it('приход со ВСД и марками сохраняет их вместе с партией, срок на погашение сутки', async () => {
    const p = await product();
    const vsd = vsdId();
    const marks = [mark(), mark(), mark()];
    const res = await receipt(w.keeperA.token, w.locA.id, [line(p.id, { vsd, marks })]);
    expect(res.statusCode).toBe(201);
    const cert = await env.owner.selectFrom('vet_certificates').selectAll().executeTakeFirstOrThrow();
    expect(cert).toMatchObject({ number: vsd, status: 'pending', location_id: w.locA.id, product_id: p.id });
    expect(cert.due_at.getTime() - cert.received_at.getTime()).toBe(24 * 3_600_000);
    const saved = await env.owner.selectFrom('batch_marks').selectAll().execute();
    expect(saved).toHaveLength(3);
    expect(saved[0]).toMatchObject({ gtin: GTIN });
    expect(saved[0]?.code).not.toContain(GS);
    const audit = await env.owner.selectFrom('audit_log').select('details').where('action', '=', 'document.receipt').executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({ marks: 3, vsd: 1 });
  });

  it('ВСД в верхнем регистре сохраняется в нижнем', async () => {
    const p = await product();
    const vsd = vsdId();
    await receipt(w.keeperA.token, w.locA.id, [line(p.id, { vsd: vsd.toUpperCase() })]);
    expect((await env.owner.selectFrom('vet_certificates').select('number').executeTakeFirstOrThrow()).number).toBe(vsd);
  });

  it('одна и та же марка дважды в приходе это ошибка, ничего не создаётся', async () => {
    const p = await product();
    const m = mark();
    const res = await receipt(w.keeperA.token, w.locA.id, [line(p.id, { marks: [m, m] })]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('mark_duplicate');
    expect(await count('documents')).toBe(0);
    expect(await count('batch_marks')).toBe(0);
  });

  it('марка, принятая раньше, не принимается снова: повтор накладной не создаёт вторую партию', async () => {
    const p = await product();
    const marks = [mark(), mark()];
    expect((await receipt(w.keeperA.token, w.locA.id, [line(p.id, { quantity: 2, marks })])).statusCode).toBe(201);
    const again = await receipt(w.keeperA.token, w.locA.id, [line(p.id, { quantity: 2, marks })]);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('mark_duplicate');
    expect(again.json().error.details[0].path).toEqual(['lines', 0, 'marks', 0]);
    expect(await count('documents')).toBe(1);
    expect(await count('batch_marks')).toBe(2);
  });

  it('повтор запроса с тем же ключом возвращает прежний документ, а не ошибку о повторе марок', async () => {
    const p = await product();
    const body = [line(p.id, { quantity: 2, marks: [mark(), mark()], vsd: vsdId() })];
    const first = await receipt(w.keeperA.token, w.locA.id, body, 'retry-key-0001');
    const second = await receipt(w.keeperA.token, w.locA.id, body, 'retry-key-0001');
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().duplicate).toBe(true);
    expect(await count('batch_marks')).toBe(2);
  });

  it('марка другого товара отклоняется по GTIN', async () => {
    const p = await product();
    const gtin = `0${OTHER_EAN}`;
    const res = await receipt(w.keeperA.token, w.locA.id, [line(p.id, { marks: [mark(gtin)] })]);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('mark_gtin_mismatch');
    expect(await count('documents')).toBe(0);
  });

  it('обычный штрихкод вместо кода маркировки отклоняется', async () => {
    const p = await product();
    const res = await receipt(w.keeperA.token, w.locA.id, [line(p.id, { marks: [`0${EAN}`.padEnd(24, '0')] })]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_mark');
  });

  it('служебные символы кроме разделителя GS1 в коде не допускаются', async () => {
    const p = await product();
    expect((await receipt(w.keeperA.token, w.locA.id, [line(p.id, { marks: [`${mark()}\u0000`] })])).statusCode).toBe(400);
    expect((await receipt(w.keeperA.token, w.locA.id, [line(p.id, { marks: [`${mark()}‮`] })])).statusCode).toBe(400);
  });

  it('марок не может быть больше штук в строке', async () => {
    const p = await product();
    const res = await receipt(w.keeperA.token, w.locA.id, [line(p.id, { quantity: 2, marks: [mark(), mark(), mark()] })]);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('too_many_marks');
  });

  it('у весового товара марок может быть больше килограммов: одна марка на упаковку', async () => {
    const p = await product({ unit: 'kg', barcode: '4006381333931' });
    const gtin = `0${OTHER_EAN}`;
    const res = await receipt(w.keeperA.token, w.locA.id, [line(p.id, { quantity: 1.5, marks: [mark(gtin), mark(gtin), mark(gtin)] })]);
    expect(res.statusCode).toBe(201);
  });

  it('у продукта без штрихкода GTIN марки не проверяется', async () => {
    const p = await product({ barcode: undefined });
    expect((await receipt(w.keeperA.token, w.locA.id, [line(p.id, { marks: [mark(`0${OTHER_EAN}`)] })])).statusCode).toBe(201);
  });

  it('неверный номер ВСД это 400, занятый это 409, один ВСД в двух строках это 400', async () => {
    const p = await product();
    expect((await receipt(w.keeperA.token, w.locA.id, [line(p.id, { vsd: 'не-uuid' })])).statusCode).toBe(400);
    const vsd = vsdId();
    expect((await receipt(w.keeperA.token, w.locA.id, [line(p.id, { vsd })])).statusCode).toBe(201);
    const dup = await receipt(w.keeperA.token, w.locA.id, [line(p.id, { vsd })]);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('vsd_duplicate');
    const same = vsdId();
    const twice = await receipt(w.keeperA.token, w.locA.id, [line(p.id, { vsd: same }), line(p.id, { vsd: same })]);
    expect(twice.statusCode).toBe(400);
    expect(twice.json().error.code).toBe('vsd_duplicate');
  });

  it('слишком много марок в одном приходе отклоняется', async () => {
    const p = await product({ unit: 'kg', barcode: '4006381333931' });
    const gtin = `0${OTHER_EAN}`;
    const many = Array.from({ length: 400 }, () => mark(gtin));
    const lines = [line(p.id, { quantity: 1000, marks: many }), line(p.id, { quantity: 1000, marks: many.map(() => mark(gtin)) }), line(p.id, { quantity: 1000, marks: many.map(() => mark(gtin)) }), line(p.id, { quantity: 1000, marks: many.map(() => mark(gtin)) })];
    expect((await receipt(w.keeperA.token, w.locA.id, lines)).statusCode).toBe(400);
  });

  it('приход без марок и ВСД работает как прежде', async () => {
    const p = await product({ requiresVsd: false, requiresMarking: false });
    expect((await receipt(w.keeperA.token, w.locA.id, [line(p.id)])).statusCode).toBe(201);
    expect(await count('vet_certificates')).toBe(0);
  });

  it('признаки продукта создаются и меняются', async () => {
    const p = await product({ requiresVsd: false, requiresMarking: false });
    expect(p).toMatchObject({ requiresVsd: false, requiresMarking: false });
    const patched = await call(env, w.manager.token)('PATCH', `/api/products/${p.id}`, { requiresVsd: true });
    expect(patched.json()).toMatchObject({ requiresVsd: true, requiresMarking: false });
  });
});

describe('погашение ВСД', () => {
  async function pendingVsd(location = w.locA.id) {
    const p = await product({ barcode: undefined });
    const vsd = vsdId();
    await receipt(w.manager.token, location, [line(p.id, { vsd })]);
    return vsd;
  }
  const list = (token: string, query = '') => call(env, token)('GET', `/api/traceability/vsd${query}`);

  it('список ждущих погашения, срок и просрочка по часам', async () => {
    const vsd = await pendingVsd();
    let items = (await list(w.keeperA.token)).json().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ number: vsd, status: 'pending', overdue: false, locationName: w.locA.name });
    await env.owner.updateTable('vet_certificates').set({ due_at: new Date(env.clock.now.getTime() - 3_600_000) }).execute();
    items = (await list(w.keeperA.token)).json().items;
    expect(items[0].overdue).toBe(true);
    const summary = (await call(env, w.keeperA.token)('GET', '/api/traceability/summary')).json();
    expect(summary).toMatchObject({ vsdPending: 1, vsdOverdue: 1 });
  });

  it('кладовщик видит только свои точки, менеджер все, наблюдатель ничего', async () => {
    await pendingVsd(w.locA.id);
    await pendingVsd(w.locB.id);
    expect((await list(w.keeperA.token)).json().total).toBe(1);
    expect((await list(w.manager.token)).json().total).toBe(2);
    expect((await list(w.keeperA.token, `?locationId=${w.locB.id}`)).statusCode).toBe(404);
    expect((await list(w.viewerA.token)).statusCode).toBe(403);
    expect((await list(w.manager.token, `?locationId=${w.locB.id}`)).json().total).toBe(1);
  });

  it('отметка о погашении: один раз, с комментарием, с аудитом и привязкой к пользователю', async () => {
    const vsd = await pendingVsd();
    const id = (await list(w.keeperA.token)).json().items[0].id;
    const done = await call(env, w.keeperA.token)('POST', `/api/traceability/vsd/${id}/redeem`, { comment: 'Погашен в Меркурии в 14:05' });
    expect(done.statusCode).toBe(204);
    expect((await list(w.keeperA.token)).json().total).toBe(0);
    const redeemed = (await list(w.keeperA.token, '?status=redeemed')).json().items[0];
    expect(redeemed).toMatchObject({ number: vsd, status: 'redeemed', comment: 'Погашен в Меркурии в 14:05', overdue: false });
    expect(redeemed.redeemedAt).toBeTruthy();
    expect((await call(env, w.keeperA.token)('POST', `/api/traceability/vsd/${id}/redeem`, {})).json().error.code).toBe('already_redeemed');
    expect(await env.owner.selectFrom('audit_log').select('id').where('action', '=', 'vsd.redeem').execute()).toHaveLength(1);
  });

  it('погасить чужой точки нельзя (404), наблюдателю нельзя, несуществующий это 404', async () => {
    await pendingVsd(w.locB.id);
    const id = (await list(w.manager.token)).json().items[0].id;
    expect((await call(env, w.keeperA.token)('POST', `/api/traceability/vsd/${id}/redeem`, {})).statusCode).toBe(404);
    expect((await call(env, w.viewerA.token)('POST', `/api/traceability/vsd/${id}/redeem`, {})).statusCode).toBe(403);
    expect((await call(env, w.manager.token)('POST', '/api/traceability/vsd/00000000-0000-4000-8000-000000000000/redeem', {})).statusCode).toBe(404);
  });

  it('ошибочную отметку возвращает менеджер, кладовщик не может', async () => {
    await pendingVsd();
    const id = (await list(w.keeperA.token)).json().items[0].id;
    await call(env, w.keeperA.token)('POST', `/api/traceability/vsd/${id}/redeem`, {});
    expect((await call(env, w.keeperA.token)('POST', `/api/traceability/vsd/${id}/reopen`)).statusCode).toBe(403);
    expect((await call(env, w.manager.token)('POST', `/api/traceability/vsd/${id}/reopen`)).statusCode).toBe(204);
    expect((await list(w.keeperA.token)).json().total).toBe(1);
    expect((await call(env, w.manager.token)('POST', `/api/traceability/vsd/${id}/reopen`)).json().error.code).toBe('not_redeemed');
  });

  it('просроченные ВСД попадают в утреннюю сводку', async () => {
    await pendingVsd();
    env.clock.advance(30 * 3_600_000);
    const { buildDigest } = await import('../src/modules/notifications/digest');
    const text = await buildDigest({ db: env.db, config: env.config, clock: () => env.clock.now, notifier: env.notifier, log: console });
    expect(text).toContain('ВСД ждут погашения: 1, просрочено: 1');
  });
});

describe('реестр марок', () => {
  it('партии с марками: сколько принято, сколько осталось и сколько должно выбыть', async () => {
    const p = await product();
    await receipt(w.manager.token, w.locA.id, [line(p.id, { quantity: 5, marks: [mark(), mark(), mark(), mark(), mark()] })]);
    await call(env, w.manager.token)('POST', '/api/documents/sales', { locationId: w.locA.id, lines: [{ productId: p.id, quantity: 2 }] });
    const items = (await call(env, w.keeperA.token)('GET', '/api/traceability/marks')).json().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ marks: 5, remaining: 3, disposed: 2, productName: 'Молоко' });
    expect((await call(env, w.keeperA.token)('GET', `/api/traceability/marks?locationId=${w.locB.id}`)).statusCode).toBe(404);
    expect((await call(env, w.viewerA.token)('GET', '/api/traceability/marks')).statusCode).toBe(403);
  });

  it('выгрузка в CSV: коды без служебных разделителей, только менеджеру, с аудитом', async () => {
    const p = await product();
    const m = mark(GTIN, 'ABCDEF1234567');
    await receipt(w.manager.token, w.locA.id, [line(p.id, { quantity: 1, marks: [m] })]);
    const res = await call(env, w.manager.token)('GET', '/api/reports/marks.csv');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body).toContain('GTIN;Серийный номер');
    expect(res.body).toContain(`${GTIN};ABCDEF1234567`);
    expect(res.body).not.toContain(GS);
    expect((await call(env, w.keeperA.token)('GET', '/api/reports/marks.csv')).statusCode).toBe(403);
    expect(await env.owner.selectFrom('audit_log').select('id').where('action', '=', 'report.export').execute()).toHaveLength(1);
  });

  it('прикладная роль не может менять и удалять принятые марки', async () => {
    const p = await product();
    await receipt(w.manager.token, w.locA.id, [line(p.id, { quantity: 1, marks: [mark()] })]);
    await expect(env.db.updateTable('batch_marks').set({ serial: 'x' }).execute()).rejects.toThrow();
    await expect(env.db.deleteFrom('batch_marks').execute()).rejects.toThrow();
  });
});

describe('накладная с ВСД и марками', () => {
  it('УПД передаёт номер ВСД и коды маркировки в строки прихода', async () => {
    const vsd = vsdId();
    const kiz = [mark(), mark()];
    const xml = buildUpdXml({
      number: 'Н-7',
      date: '09.10.2026',
      encoding: 'UTF-8',
      supplier: { name: 'ООО «Донской»', inn: '7707083893' },
      lines: [{ name: 'Молоко', unitCode: '796', quantity: '2', price: '60', vsd, kiz }],
    });
    const res = await call(env, w.keeperA.token)('POST', '/api/invoices/parse', { format: 'upd', content: Buffer.from(xml, 'utf8').toString('base64') });
    expect(res.statusCode).toBe(200);
    const l = res.json().lines[0];
    expect(l.vsd).toBe(vsd);
    expect(l.marks).toEqual(kiz);
    expect(l.gtin).toBe(GTIN);
  });
});

void gtinCheckDigit;
