import type { OrderDetailDto, OrderSuggestionDto } from '@zapas/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processDeliveries } from '../src/modules/integrations/service';
import { schedulerTick } from '../src/modules/notifications/scheduler';
import { buildDigest } from '../src/modules/notifications/digest';
import { autoDraftOrders, emailOrder } from '../src/modules/orders/service';
import { addProduct, createWorld, receive, seedSales, type World } from './fixtures';
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

const manager = () => call(env, w.manager.token);
const keeper = () => call(env, w.keeperA.token);

async function supplier(over: Record<string, unknown> = {}) {
  const res = await manager()('POST', '/api/suppliers', { name: `Поставщик ${Math.random().toString(36).slice(2, 7)}`, email: 'zakaz@donskoy.ru', leadTimeDays: 1, minOrderSum: 0, ...over });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; name: string };
}

/** Продукт, который расходуется по perDay в сутки, при остатке stock, с поставщиком и кратностью заказа. */
async function product(s: { id: string }, o: { name?: string; unit?: 'kg' | 'l' | 'pcs'; perDay?: number; stock?: number; minStock?: number; pack?: number; cost?: number; location?: string } = {}) {
  const location = o.location ?? w.locA.id;
  const p = await addProduct(env, w.categoryId, { name: o.name ?? 'Яйца', unit: o.unit ?? 'pcs', minStock: o.minStock ?? 0, cost: o.cost ?? 10 });
  await env.owner.updateTable('products').set({ default_supplier_id: s.id, pack_size: o.pack ?? 1 }).where('id', '=', p).execute();
  if (o.perDay) await seedSales(env, { productId: p, locationId: location, days: 25, perDay: o.perDay });
  await receive(env, w.manager.token, location, [{ productId: p, quantity: o.stock ?? 25, expiresOn: w.day(20), unitCost: o.cost ?? 10 }]);
  env.forget();
  return p;
}

const suggestions = async (query = '') => {
  const res = await manager()('GET', `/api/orders/suggestions${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as OrderSuggestionDto[];
};
const fromSuggestion = (supplierId: string, locationId = w.locA.id) => manager()('POST', '/api/orders/from-suggestion', { supplierId, locationId });
const order = async (id: string) => (await manager()('GET', `/api/orders/${id}`)).json() as OrderDetailDto;

/** Заказ из расчёта сразу доводится до отправленного. */
async function sentOrder(s: { id: string }, locationId = w.locA.id) {
  const created = await fromSuggestion(s.id, locationId);
  expect(created.statusCode, created.body).toBe(201);
  const sent = await manager()('POST', `/api/orders/${created.json().id}/send`);
  expect(sent.statusCode, sent.body).toBe(200);
  return sent.json() as OrderDetailDto;
}

describe('условия поставщика и продукта', () => {
  it('поставщик хранит почту, срок поставки, минимальную сумму; изменение имени их не стирает', async () => {
    const s = await supplier({ email: 'orders@milk.ru', leadTimeDays: 3, minOrderSum: 5000, autoOrder: true });
    const list = (await manager()('GET', '/api/suppliers')).json();
    expect(list.find((x: { id: string }) => x.id === s.id)).toMatchObject({ email: 'orders@milk.ru', leadTimeDays: 3, minOrderSum: 5000, autoOrder: true });
    const patched = await manager()('PATCH', `/api/suppliers/${s.id}`, { name: 'Новое имя' });
    expect(patched.json()).toMatchObject({ name: 'Новое имя', email: 'orders@milk.ru', leadTimeDays: 3, minOrderSum: 5000, autoOrder: true });
    const cleared = await manager()('PATCH', `/api/suppliers/${s.id}`, { name: 'Новое имя', email: '' });
    expect(cleared.json().email).toBeNull();
  });

  it('почта с несколькими адресами и переводом строки не принимается', async () => {
    for (const email of ['a@b.ru, c@d.ru', 'a@b.ru\nBcc: x@y.ru']) {
      expect((await manager()('POST', '/api/suppliers', { name: 'Плохая почта', email })).statusCode, email).toBe(400);
    }
  });

  it('у продукта задаются поставщик и фасовка, штучная фасовка только целая, отключённый поставщик недоступен', async () => {
    const s = await supplier();
    const p = await addProduct(env, w.categoryId, { name: 'Яйца', unit: 'pcs' });
    const ok = await manager()('PATCH', `/api/products/${p}`, { defaultSupplierId: s.id, packSize: 10 });
    expect(ok.json()).toMatchObject({ defaultSupplierId: s.id, defaultSupplierName: s.name, packSize: 10 });
    expect((await manager()('PATCH', `/api/products/${p}`, { packSize: 2.5 })).json().error.code).toBe('whole_pieces');
    expect((await manager()('PATCH', `/api/products/${p}`, { defaultSupplierId: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(400);
    await manager()('PATCH', `/api/suppliers/${s.id}`, { name: s.name, isActive: false });
    expect((await manager()('PATCH', `/api/products/${p}`, { defaultSupplierId: s.id })).statusCode).toBe(400);
    const cleared = await manager()('PATCH', `/api/products/${p}`, { defaultSupplierId: null });
    expect(cleared.json()).toMatchObject({ defaultSupplierId: null, defaultSupplierName: null });
  });

  it('создание продукта сразу с поставщиком, весовой товар допускает дробную фасовку', async () => {
    const s = await supplier();
    const res = await manager()('POST', '/api/products', { sku: 'OIL-1', name: 'Масло', categoryId: w.categoryId, unit: 'kg', price: 10, cost: 5, defaultSupplierId: s.id, packSize: 2.5 });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ defaultSupplierId: s.id, packSize: 2.5 });
  });
});

describe('что заказать', () => {
  it('считает по скорости продаж, сроку поставки и фасовке, объясняет причину', async () => {
    const s = await supplier({ leadTimeDays: 1 });
    const p = await product(s, { perDay: 20, stock: 25, pack: 12, cost: 10 });
    const [g] = await suggestions();
    expect(g).toMatchObject({ supplierId: s.id, locationId: w.locA.id, leadTimeDays: 1, draftId: null, belowMinimum: false });
    const line = g!.lines[0]!;
    // горизонт 1 + 7 суток при 20 в сутки = 160, остаток 25, нужно 135, округление вверх до ящиков по 12 = 144
    expect(line).toMatchObject({ productId: p, quantity: 144, unitCost: 10, sum: 1440, available: 25, incoming: 0, perDay: 20, packSize: 12, daysCover: 1.3 });
    expect(line.reason).toContain('Хватит на 1 день, поставка занимает 1 день');
    expect(g!.total).toBe(1440);
  });

  it('товар с хорошим запасом, без поставщика или у отключённого поставщика не предлагается', async () => {
    const s = await supplier();
    await product(s, { name: 'Много', perDay: 2, stock: 200 });
    const noSupplier = await addProduct(env, w.categoryId, { name: 'Ничей' });
    await seedSales(env, { productId: noSupplier, locationId: w.locA.id, days: 25, perDay: 20 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: noSupplier, quantity: 5, expiresOn: w.day(20) }]);
    const off = await supplier({ name: 'Закрытый' });
    await product(off, { name: 'У закрытого', perDay: 20, stock: 5 });
    await manager()('PATCH', `/api/suppliers/${off.id}`, { name: 'Закрытый', isActive: false });
    env.forget();
    expect(await suggestions()).toEqual([]);
  });

  it('без измеренных продаж заказывает по минимальному остатку', async () => {
    const s = await supplier();
    await product(s, { name: 'Мука', unit: 'kg', minStock: 20, stock: 8, pack: 25 });
    const [g] = await suggestions();
    expect(g!.lines[0]).toMatchObject({ quantity: 50, daysCover: null, perDay: 0 });
    expect(g!.lines[0]!.reason).toContain('минимального');
  });

  it('уже заказанное и не принятое учитывается: повторно то же не предлагается', async () => {
    const s = await supplier();
    await product(s, { perDay: 20, stock: 25, pack: 12 });
    expect(await suggestions()).toHaveLength(1);
    await sentOrder(s);
    expect(await suggestions()).toEqual([]);
  });

  it('если до минимальной суммы поставщика не хватает, предложение помечено', async () => {
    const s = await supplier({ minOrderSum: 5000 });
    await product(s, { perDay: 20, stock: 25, pack: 12, cost: 10 });
    const [g] = await suggestions();
    expect(g).toMatchObject({ total: 1440, minOrderSum: 5000, belowMinimum: true });
  });

  it('точки считаются отдельно и фильтруются; наблюдателю и кладовщику расчёт закрыт', async () => {
    const s = await supplier();
    await product(s, { name: 'Яйца А', perDay: 20, stock: 25, location: w.locA.id });
    await product(s, { name: 'Яйца Б', perDay: 20, stock: 25, location: w.locB.id });
    expect((await suggestions()).map((g) => g.locationId).sort()).toEqual([w.locA.id, w.locB.id].sort());
    expect((await suggestions(`?locationId=${w.locB.id}`)).map((g) => g.locationId)).toEqual([w.locB.id]);
    expect((await keeper()('GET', '/api/orders/suggestions')).statusCode).toBe(403);
    expect((await call(env, w.viewerA.token)('GET', '/api/orders/suggestions')).statusCode).toBe(403);
    expect((await call(env, null)('GET', '/api/orders/suggestions')).statusCode).toBe(401);
  });
});

describe('черновик', () => {
  it('создаётся из расчёта с количествами сервера, срок поставки по сроку поставщика, номер по порядку', async () => {
    const s = await supplier({ leadTimeDays: 2 });
    const p = await product(s, { perDay: 20, stock: 25, pack: 12 });
    const res = await fromSuggestion(s.id);
    expect(res.statusCode, res.body).toBe(201);
    const o = res.json() as OrderDetailDto;
    expect(o.number).toMatch(/^ЗК-\d{6}$/);
    expect(o).toMatchObject({ status: 'draft', supplierId: s.id, locationId: w.locA.id, lines: 1, expectedOn: w.day(2), createdBy: expect.any(String) });
    expect(o.items[0]).toMatchObject({ productId: p, receivedQty: 0 });
    expect(o.text).toContain(`Заказ ${o.number}`);
    expect(o.text).toContain('Яйца');
    expect(o.text).not.toMatch(/[  ]/);
    expect((await suggestions())[0]?.draftId).toBe(o.id);
  });

  it('повторное создание открывает прежний черновик, одновременное создание даёт один', async () => {
    const s = await supplier();
    await product(s, { perDay: 20, stock: 25 });
    const [a, b] = await Promise.all([fromSuggestion(s.id), fromSuggestion(s.id)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().error.code).toBe('draft_exists');
    expect(loser.json().error.details.orderId).toBeTruthy();
    expect((await env.owner.selectFrom('purchase_orders').select('id').execute()).length).toBe(1);
  });

  it('когда заказывать нечего, понятная ошибка', async () => {
    const s = await supplier();
    const res = await fromSuggestion(s.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('nothing_to_order');
  });

  it('ручной заказ: проверки строк, повторы, дробные штуки, отключённые продукты, чужие права', async () => {
    const s = await supplier();
    const p = await addProduct(env, w.categoryId, { name: 'Яйца', unit: 'pcs' });
    const q = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l' });
    const body = (lines: object[], extra: object = {}) => ({ supplierId: s.id, locationId: w.locA.id, lines, ...extra });
    expect((await manager()('POST', '/api/orders', body([{ productId: p, quantity: 1.5, unitCost: 10 }]))).json().error.code).toBe('whole_pieces');
    expect((await manager()('POST', '/api/orders', body([{ productId: '00000000-0000-4000-8000-000000000000', quantity: 1, unitCost: 10 }]))).statusCode).toBe(400);
    expect((await manager()('POST', '/api/orders', body([{ productId: p, quantity: 1, unitCost: 10 }], { expectedOn: w.day(-1) }))).statusCode).toBe(400);
    await env.owner.updateTable('products').set({ is_active: false }).where('id', '=', q).execute();
    expect((await manager()('POST', '/api/orders', body([{ productId: q, quantity: 1, unitCost: 10 }]))).statusCode).toBe(400);
    const ok = await manager()('POST', '/api/orders', body([{ productId: p, quantity: 12, unitCost: 10.5 }], { comment: 'Привезти до обеда', expectedOn: w.day(1) }));
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ total: 126, comment: 'Привезти до обеда', expectedOn: w.day(1) });
    expect((await keeper()('POST', '/api/orders', body([{ productId: p, quantity: 1, unitCost: 1 }]))).statusCode).toBe(403);
    expect((await manager()('POST', '/api/orders', { ...body([{ productId: p, quantity: 1, unitCost: 1 }]), status: 'sent' })).statusCode).toBe(400);
  });

  it('черновик правится целиком, после отправки менять нельзя', async () => {
    const s = await supplier();
    const p = await addProduct(env, w.categoryId, { name: 'Яйца', unit: 'pcs' });
    const created = (await manager()('POST', '/api/orders', { supplierId: s.id, locationId: w.locA.id, lines: [{ productId: p, quantity: 12, unitCost: 10 }] })).json() as OrderDetailDto;
    const edited = await manager()('PATCH', `/api/orders/${created.id}`, { lines: [{ productId: p, quantity: 24, unitCost: 11 }], comment: 'Срочно', expectedOn: w.day(3) });
    expect(edited.json()).toMatchObject({ total: 264, comment: 'Срочно', expectedOn: w.day(3) });
    expect(edited.json().items[0]).toMatchObject({ quantity: 24, unitCost: 11, sum: 264 });
    expect((await manager()('PATCH', `/api/orders/${created.id}`, { expectedOn: w.day(-1) })).statusCode).toBe(400);
    expect((await manager()('PATCH', `/api/orders/${created.id}`, { lines: [] })).statusCode).toBe(400);
    await manager()('POST', `/api/orders/${created.id}/send`);
    const again = await manager()('PATCH', `/api/orders/${created.id}`, { comment: 'Поздно' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('order_not_draft');
  });
});

describe('отправка', () => {
  it('меняет статус, пишет аудит, шлёт письмо поставщику с ответом на почту менеджера и сообщение в Telegram', async () => {
    const s = await supplier({ email: 'orders@milk.ru' });
    await product(s, { perDay: 20, stock: 25, pack: 12 });
    const o = await sentOrder(s);
    expect(o).toMatchObject({ status: 'sent', emailError: null });
    expect(o.sentAt).toBeTruthy();
    expect(o.emailedAt).toBeTruthy();
    expect(env.mailer.sent).toHaveLength(1);
    const mail = env.mailer.sent[0]!;
    expect(mail).toMatchObject({ to: 'orders@milk.ru', subject: `Заказ ${o.number} для «${w.locA.name}»` });
    expect(mail.replyTo).toBeTruthy();
    expect(mail.text).toBe(o.text);
    expect(mail.text).toContain('Яйца');
    expect(env.notifier.messages.some((m) => m.includes(`Заказ ${o.number} отправлен`))).toBe(true);
    const audit = await env.owner.selectFrom('audit_log').select('details').where('action', '=', 'order.send').executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({ number: o.number, lines: 1 });
  });

  it('заказ уходит событием order.sent на подписанный адрес', async () => {
    const hook = (await call(env, w.admin.token)('POST', '/api/integrations/webhooks', { name: 'ЭДО', url: 'https://hooks.example.com/orders', events: ['order.sent'] })).json();
    const s = await supplier();
    const p = await product(s, { perDay: 20, stock: 25, pack: 12 });
    const o = await sentOrder(s);
    expect(await processDeliveries(env.deps)).toBe(1);
    const req = env.webhooks.requests[0]!;
    expect(req.headers['x-zapas-event']).toBe('order.sent');
    const payload = JSON.parse(req.body);
    expect(payload.order).toMatchObject({ id: o.id, number: o.number, total: 1440, supplier: { id: s.id, name: s.name }, location: { id: w.locA.id } });
    expect(payload.order.lines[0]).toMatchObject({ name: 'Яйца', quantity: 144, unitCost: 10, unit: 'pcs' });
    expect(payload.order.lines[0].sku).toBeTruthy();
    void hook;
    void p;
  });

  it('без почты поставщика заказ всё равно отправляется, причина видна, текст можно скопировать', async () => {
    const s = await supplier({ email: '' });
    await product(s, { perDay: 20, stock: 25 });
    const o = await sentOrder(s);
    expect(o).toMatchObject({ status: 'sent', emailedAt: null, emailError: 'у поставщика не указана почта' });
    expect(o.text).toContain('Итого');
    expect(env.mailer.sent).toHaveLength(0);
  });

  it('если почта на сервере не настроена, это видно в заказе', async () => {
    const s = await supplier();
    await product(s, { perDay: 20, stock: 25 });
    const created = (await fromSuggestion(s.id)).json() as OrderDetailDto;
    await env.owner.updateTable('purchase_orders').set({ status: 'sent' }).where('id', '=', created.id).execute();
    await emailOrder({ ...env.deps, mailer: null }, created.id, null);
    expect((await order(created.id)).emailError).toBe('отправка почты не настроена на сервере');
  });

  it('сбой почты не отменяет заказ, причина короткая и без подробностей, повторная отправка работает', async () => {
    const s = await supplier();
    await product(s, { perDay: 20, stock: 25 });
    env.mailer.failure = { code: 'EAUTH' };
    const o = await sentOrder(s);
    expect(o.status).toBe('sent');
    expect(o.emailedAt).toBeNull();
    expect(o.emailError).toBe('почтовый сервер не принял логин и пароль');
    expect(JSON.stringify(o)).not.toContain('секретная');
    env.mailer.failure = null;
    const retry = await manager()('POST', `/api/orders/${o.id}/resend`);
    expect(retry.json()).toMatchObject({ emailError: null });
    expect(retry.json().emailedAt).toBeTruthy();
    expect(env.mailer.sent).toHaveLength(1);
    // черновик письмом не отправляется
    const s2 = await supplier({ name: 'Другой' });
    await product(s2, { name: 'Другое', perDay: 20, stock: 25 });
    const draft = (await fromSuggestion(s2.id)).json();
    expect((await manager()('POST', `/api/orders/${draft.id}/resend`)).statusCode).toBe(409);
  });

  it('второй раз отправить нельзя, отключённому поставщику нельзя, права и видимость по точкам', async () => {
    const s = await supplier();
    await product(s, { perDay: 20, stock: 25, location: w.locA.id });
    const o = await sentOrder(s);
    expect((await manager()('POST', `/api/orders/${o.id}/send`)).json().error.code).toBe('order_not_draft');
    expect((await keeper()('POST', `/api/orders/${o.id}/send`)).statusCode).toBe(403);

    // кладовщик видит заказы своей точки, но не чужой
    expect((await keeper()('GET', `/api/orders/${o.id}`)).statusCode).toBe(200);
    expect(((await keeper()('GET', '/api/orders')).json().items as { id: string }[]).map((x) => x.id)).toEqual([o.id]);
    const other = await supplier({ name: 'Для точки Б' });
    await product(other, { name: 'Яйца Б', perDay: 20, stock: 25, location: w.locB.id });
    const b = (await fromSuggestion(other.id, w.locB.id)).json();
    expect((await keeper()('GET', `/api/orders/${b.id}`)).statusCode).toBe(404);
    expect(((await keeper()('GET', '/api/orders')).json().items as unknown[]).length).toBe(1);
    expect((await call(env, w.viewerA.token)('GET', '/api/orders')).statusCode).toBe(403);

    await manager()('PATCH', `/api/suppliers/${other.id}`, { name: 'Для точки Б', isActive: false });
    const blocked = await manager()('POST', `/api/orders/${b.id}/send`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('supplier_inactive');
  });
});

describe('приход по заказу', () => {
  async function open() {
    const s = await supplier();
    const p = await product(s, { perDay: 20, stock: 25, pack: 12 });
    const o = await sentOrder(s);
    return { s, p, o };
  }
  const receipt = (body: object) => keeper()('POST', '/api/documents/receipts', { locationId: w.locA.id, ...body });
  const line = (productId: string, quantity: number) => ({ productId, quantity, unitCost: 10, expiresOn: w.day(10) });

  it('частичный приход делает заказ принятым частично, остальное засчитывается и закрывает заказ', async () => {
    const { s, p, o } = await open();
    const first = await receipt({ orderId: o.id, lines: [line(p, 100)] });
    expect(first.statusCode, first.body).toBe(201);
    let cur = await order(o.id);
    expect(cur.status).toBe('partial');
    expect(cur.items[0]!.receivedQty).toBe(100);
    // поставщик по умолчанию берётся из заказа
    const batch = await env.owner.selectFrom('batches').select('supplier_id').where('origin_document_id', '=', first.json().documentId).executeTakeFirstOrThrow();
    expect(batch.supplier_id).toBe(s.id);
    const second = await receipt({ orderId: o.id, lines: [line(p, 44)] });
    expect(second.statusCode).toBe(201);
    cur = await order(o.id);
    expect(cur.status).toBe('received');
    expect(cur.closedAt).toBeTruthy();
    expect(cur.items[0]!.receivedQty).toBe(144);
    const audit = await env.owner.selectFrom('audit_log').select('details').where('action', '=', 'document.receipt').orderBy('id', 'desc').executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({ order: o.number });
  });

  it('то, чего не было в заказе, принимается, но в заказ не засчитывается', async () => {
    const { p, o } = await open();
    const extra = await addProduct(env, w.categoryId, { name: 'Лишний товар' });
    const res = await receipt({ orderId: o.id, lines: [line(p, 144), line(extra, 3)] });
    expect(res.statusCode, res.body).toBe(201);
    expect((await order(o.id)).status).toBe('received');
    const audit = await env.owner.selectFrom('audit_log').select('details').where('action', '=', 'document.receipt').orderBy('id', 'desc').executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({ outsideOrder: 1 });
  });

  it('повтор запроса с тем же ключом не засчитывает приход в заказ второй раз', async () => {
    const { p, o } = await open();
    const body = { orderId: o.id, lines: [line(p, 50)] };
    const headers = { 'idempotency-key': 'order-receipt-0001' };
    const a = await keeper()('POST', '/api/documents/receipts', { locationId: w.locA.id, ...body }, headers);
    const b = await keeper()('POST', '/api/documents/receipts', { locationId: w.locA.id, ...body }, headers);
    expect([a.statusCode, b.statusCode]).toEqual([201, 200]);
    expect((await order(o.id)).items[0]!.receivedQty).toBe(50);
  });

  it('другая точка, другой поставщик, черновик, отменённый и чужой заказ отклоняются, ничего не создаётся', async () => {
    const { s, p, o } = await open();
    const before = (await env.owner.selectFrom('documents').select('id').execute()).length;
    const wrongLocation = await manager()('POST', '/api/documents/receipts', { locationId: w.locB.id, orderId: o.id, lines: [line(p, 1)] });
    expect(wrongLocation.json().error.code).toBe('order_location_mismatch');
    const otherSupplier = await supplier({ name: 'Не тот' });
    const wrongSupplier = await receipt({ orderId: o.id, supplierId: otherSupplier.id, lines: [line(p, 1)] });
    expect(wrongSupplier.json().error.code).toBe('order_supplier_mismatch');
    expect((await receipt({ orderId: '00000000-0000-4000-8000-000000000000', lines: [line(p, 1)] })).statusCode).toBe(404);

    await manager()('POST', `/api/orders/${o.id}/cancel`);
    expect((await receipt({ orderId: o.id, lines: [line(p, 1)] })).json().error.code).toBe('order_not_open');
    await env.owner.updateTable('purchase_orders').set({ status: 'draft' }).where('id', '=', o.id).execute();
    expect((await receipt({ orderId: o.id, lines: [line(p, 1)] })).json().error.code).toBe('order_not_open');
    expect((await env.owner.selectFrom('documents').select('id').execute()).length).toBe(before);
    void s;
  });

  it('недопоставку можно закрыть: она перестаёт считаться «в пути» и снова попадает в расчёт', async () => {
    const { s, p, o } = await open();
    await receipt({ orderId: o.id, lines: [line(p, 12)] });
    expect(await suggestions()).toEqual([]);
    const closed = await manager()('POST', `/api/orders/${o.id}/close`, { comment: 'Поставщик довёз меньше' });
    expect(closed.json()).toMatchObject({ status: 'received' });
    expect(closed.json().comment).toContain('Закрыт: Поставщик довёз меньше');
    const again = await suggestions();
    expect(again).toHaveLength(1);
    expect(again[0]!.lines[0]!.incoming).toBe(0);
    expect((await manager()('POST', `/api/orders/${o.id}/close`, {})).json().error.code).toBe('order_not_open');
    void s;
  });
});

describe('отмена', () => {
  it('черновик и отправленный заказ без прихода отменяются, частично принятый и закрытый нет', async () => {
    const s = await supplier();
    const p = await product(s, { perDay: 20, stock: 25, pack: 12 });
    const draft = (await fromSuggestion(s.id)).json() as OrderDetailDto;
    expect((await keeper()('POST', `/api/orders/${draft.id}/cancel`)).statusCode).toBe(403);
    expect((await manager()('POST', `/api/orders/${draft.id}/cancel`)).json().status).toBe('cancelled');
    expect((await manager()('POST', `/api/orders/${draft.id}/cancel`)).json().error.code).toBe('order_closed');

    const sent = await sentOrder(s);
    await keeper()('POST', '/api/documents/receipts', { locationId: w.locA.id, orderId: sent.id, lines: [{ productId: p, quantity: 5, unitCost: 10, expiresOn: w.day(10) }] });
    const partial = await manager()('POST', `/api/orders/${sent.id}/cancel`);
    expect(partial.statusCode).toBe(409);
    expect(partial.json().error.code).toBe('order_partial');
  });

  it('отменённый заказ снова даёт место черновику и не считается «в пути»', async () => {
    const s = await supplier();
    await product(s, { perDay: 20, stock: 25 });
    const o = await sentOrder(s);
    expect(await suggestions()).toEqual([]);
    await manager()('POST', `/api/orders/${o.id}/cancel`);
    expect(await suggestions()).toHaveLength(1);
    expect((await fromSuggestion(s.id)).statusCode).toBe(201);
  });
});

describe('список и выгрузка', () => {
  it('фильтры по статусу, «open» и постраничность', async () => {
    const s1 = await supplier({ name: 'А' });
    const s2 = await supplier({ name: 'Б' });
    await product(s1, { name: 'Яйца', perDay: 20, stock: 25 });
    await product(s2, { name: 'Молоко', unit: 'l', perDay: 20, stock: 25 });
    const sent = await sentOrder(s1);
    await fromSuggestion(s2.id);
    const all = (await manager()('GET', '/api/orders')).json();
    expect(all.total).toBe(2);
    expect((await manager()('GET', '/api/orders?status=draft')).json().items).toHaveLength(1);
    expect((await manager()('GET', '/api/orders?status=open')).json().items.map((x: { id: string }) => x.id)).toEqual([sent.id]);
    expect((await manager()('GET', `/api/orders?supplierId=${s2.id}`)).json().total).toBe(1);
    expect((await manager()('GET', '/api/orders?limit=1&offset=1')).json().items).toHaveLength(1);
    expect((await manager()('GET', '/api/orders?status=weird')).statusCode).toBe(400);
  });

  it('CSV выгружает менеджер, запись попадает в журнал', async () => {
    const s = await supplier();
    await product(s, { perDay: 20, stock: 25, pack: 12 });
    const o = await sentOrder(s);
    const res = await manager()('GET', `/api/orders/${o.id}/export.csv`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain("filename*=UTF-8''");
    expect(res.body).toContain('Артикул;Наименование');
    expect(res.body).toContain('Яйца');
    expect((await keeper()('GET', `/api/orders/${o.id}/export.csv`)).statusCode).toBe(403);
    expect(await env.owner.selectFrom('audit_log').select('id').where('action', '=', 'report.export').execute()).toHaveLength(1);
  });
});

describe('автоматические черновики', () => {
  it('готовятся только по поставщикам с автозаказом, без дублей, с уведомлением', async () => {
    const auto = await supplier({ name: 'Автозаказ', autoOrder: true, leadTimeDays: 2 });
    const manual = await supplier({ name: 'Вручную', autoOrder: false });
    await product(auto, { name: 'Яйца', perDay: 20, stock: 25, pack: 12 });
    await product(manual, { name: 'Молоко', unit: 'l', perDay: 20, stock: 25 });
    const first = await autoDraftOrders(env.deps);
    expect(first.drafts).toBe(1);
    const rows = await env.owner.selectFrom('purchase_orders').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ supplier_id: auto.id, status: 'draft', created_by: null });
    expect(rows[0]!.comment).toContain('автоматически');
    expect(env.notifier.messages.at(-1)).toContain('Черновики заказов готовы: 1');
    expect((await autoDraftOrders(env.deps)).drafts).toBe(0);
    expect(await env.owner.selectFrom('purchase_orders').select('id').execute()).toHaveLength(1);
    // отправляет только человек
    expect(rows[0]!.sent_at).toBeNull();
    expect(env.mailer.sent).toHaveLength(0);
  });

  it('планировщик делает это раз в сутки в час сводки', async () => {
    const auto = await supplier({ name: 'Автозаказ', autoOrder: true });
    await product(auto, { perDay: 20, stock: 25 });
    env.clock.now = new Date('2026-10-08T12:00:00Z'); // 15:00 по Москве, не час сводки
    env.forget();
    await schedulerTick(env.deps);
    expect(await env.owner.selectFrom('purchase_orders').select('id').execute()).toHaveLength(0);
    env.clock.now = new Date('2026-10-08T05:10:00Z'); // 08:10 по Москве
    env.forget();
    await schedulerTick(env.deps);
    expect(await env.owner.selectFrom('purchase_orders').select('id').execute()).toHaveLength(1);
    await env.owner.deleteFrom('purchase_order_lines').execute();
    await env.owner.deleteFrom('purchase_orders').execute();
    env.clock.advance(60_000);
    await schedulerTick(env.deps);
    expect(await env.owner.selectFrom('purchase_orders').select('id').execute()).toHaveLength(0);
  });

  it('утренняя сводка упоминает черновики и ожидаемые поставки', async () => {
    const s = await supplier();
    await product(s, { perDay: 20, stock: 25 });
    await fromSuggestion(s.id);
    expect(await buildDigest(env.deps)).toContain('Заказы поставщикам: черновиков 1');
    const o = (await manager()('GET', '/api/orders')).json().items[0];
    await manager()('POST', `/api/orders/${o.id}/send`);
    expect(await buildDigest(env.deps)).toContain('ждём поставку 1');
  });
});
