import { completeInn, SUPPLIER_PORTAL_SIGNATURE_HEADER, SUPPLIER_PORTAL_TIMESTAMP_HEADER, type PortalOrderPush, type SupplierSideStatus } from '@zapas/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { parseConfig } from '../src/config';
import { openDb } from '../src/db';
import { signPayload } from '../src/security';
import type { ZapasClient } from '../src/zapas';

const SECRET = 'test-portal-secret-1234';
const INN = completeInn('616301234');
const clock = { now: new Date('2026-10-14T09:00:00Z') };

class FakeZapas implements ZapasClient {
  pushed: { externalId: string; status: SupplierSideStatus; note?: string | undefined; deliveryOn?: string | undefined }[] = [];
  rejectWith: { status: number; error: string } | null = null;
  known: { known: boolean; name: string | null; buyers: number } | null = { known: true, name: 'Молочный комбинат «Донской»', buyers: 2 };
  fresh: PortalOrderPush | null = null;
  async pushStatus(input: { externalId: string; status: SupplierSideStatus; note?: string | undefined; deliveryOn?: string | undefined }) {
    if (this.rejectWith) return { ok: false as const, ...this.rejectWith };
    this.pushed.push(input);
    return { ok: true as const };
  }
  async lookup() {
    return this.known;
  }
  async pull() {
    return this.fresh;
  }
}

const config = parseConfig({ NODE_ENV: 'test', SUPPLIER_DB_FILE: ':memory:', SUPPLIER_PORTAL_SECRET: SECRET, SUPPLIER_SESSION_SECRET: 'test-session-secret-0000000000000000' });
let zapas: FakeZapas;
let app: Awaited<ReturnType<typeof buildApp>>;
const API = '/supplier/api';

beforeEach(async () => {
  await app?.close();
  zapas = new FakeZapas();
  app = await buildApp({ db: openDb(':memory:'), config, zapas, clock: () => clock.now });
});
afterAll(() => app?.close());

const registration = { company: 'Молочный комбинат «Донской»', inn: INN, contactName: 'Ковалёв Игорь', email: 'zakaz@donskoy.example', phone: '+7 863 200-11-22', password: 'Хорошая-длинная-фраза-91' };

async function register(over: Record<string, unknown> = {}) {
  const res = await app.inject({ method: 'POST', url: `${API}/auth/register`, payload: { ...registration, ...over } });
  const cookie = res.cookies.find((c) => c.name === 'otgruzka_session');
  return { res, headers: { cookie: `otgruzka_session=${cookie?.value ?? ''}` } };
}

const order = (over: Partial<PortalOrderPush> = {}): PortalOrderPush => ({
  externalId: '11111111-1111-4111-8111-111111111111',
  number: 'ЗК-000010',
  status: 'sent',
  statusLabel: 'Отправлен поставщику',
  supplierInn: INN,
  supplierName: 'Молочный комбинат «Донской»',
  buyer: { organization: 'Ресторанная группа «Набережная»', location: 'Кухня «Набережная»', address: 'Ростов-на-Дону, ул. Береговая, 12' },
  expectedOn: '2026-10-16',
  comment: null,
  total: 2400,
  lines: [{ sku: 'MLK-001', name: 'Молоко 3,2%', unit: 'l', quantity: 40, unitCost: 60, receivedQty: 0 }],
  buyerNote: null,
  updatedAt: '2026-10-14T08:00:00.000Z',
  ...over,
});

const sendOrder = (o: PortalOrderPush, over: { secret?: string; at?: number } = {}) => {
  const ts = String(Math.floor((over.at ?? clock.now.getTime()) / 1000));
  return app.inject({
    method: 'POST',
    url: `${API}/gateway/orders`,
    payload: o,
    headers: { [SUPPLIER_PORTAL_TIMESTAMP_HEADER]: ts, [SUPPLIER_PORTAL_SIGNATURE_HEADER]: signPayload(over.secret ?? SECRET, ts, o) },
  });
};

describe('регистрация и вход', () => {
  it('регистрирует по ИНН, сразу пускает и подсказывает, знает ли «Запас» такого поставщика', async () => {
    const { res, headers } = await register();
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().matched).toEqual({ known: true, name: 'Молочный комбинат «Донской»', buyers: 2 });
    expect(res.body).not.toMatch(/password|hash/i);
    const me = await app.inject({ method: 'GET', url: `${API}/auth/me`, headers });
    expect(me.json().account.inn).toBe(INN);
  });

  it('проверяет ИНН по контрольной цифре, почту и пароль; повторы отклоняет', async () => {
    expect((await register({ inn: '6163012340' })).res.statusCode).toBe(400);
    expect((await register({ inn: '123' })).res.statusCode).toBe(400);
    expect((await register({ email: 'нет' })).res.statusCode).toBe(400);
    expect((await register({ password: 'короткий' })).res.statusCode).toBe(400);
    expect((await register()).res.statusCode).toBe(201);
    expect((await register({ email: 'other@x.example' })).res.statusCode).toBe(409);
    expect((await register({ inn: completeInn('616302345') })).res.statusCode).toBe(409);
  });

  it('если «Запас» не отвечает, регистрация всё равно проходит', async () => {
    zapas.known = null;
    const { res } = await register();
    expect(res.statusCode).toBe(201);
    expect(res.json().matched).toBeNull();
  });

  it('вход по почте и паролю, блокировка после неудач, выход', async () => {
    await register();
    const bad = await app.inject({ method: 'POST', url: `${API}/auth/login`, payload: { email: registration.email, password: 'неверный-пароль' } });
    expect(bad.statusCode).toBe(401);
    const good = await app.inject({ method: 'POST', url: `${API}/auth/login`, payload: { email: registration.email, password: registration.password } });
    expect(good.statusCode).toBe(200);
    for (let i = 0; i < 5; i += 1) await app.inject({ method: 'POST', url: `${API}/auth/login`, payload: { email: registration.email, password: 'неверный-пароль' } });
    const locked = await app.inject({ method: 'POST', url: `${API}/auth/login`, payload: { email: registration.email, password: registration.password } });
    expect(locked.statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `${API}/orders` })).statusCode).toBe(401);
  });
});

describe('заказы от покупателей', () => {
  it('принимает заказ только с верной подписью и свежим временем', async () => {
    expect((await sendOrder(order(), { secret: 'чужой-секрет-чужой-секрет' })).statusCode).toBe(401);
    expect((await sendOrder(order(), { at: clock.now.getTime() - 3_600_000 })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `${API}/gateway/orders`, payload: order() })).statusCode).toBe(401);
    const ok = await sendOrder(order());
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().created).toBe(true);
    expect((await sendOrder(order())).json().created).toBe(false);
    expect((await sendOrder(order({ lines: [] }))).statusCode).toBe(400);
  });

  it('заказ, пришедший до регистрации, появляется у поставщика сразу после неё', async () => {
    await sendOrder(order());
    const { headers } = await register();
    const list = (await app.inject({ method: 'GET', url: `${API}/orders?stage=new`, headers })).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ number: 'ЗК-000010', stage: 'new', isNew: true, total: 2400 });
  });

  it('поставщик видит только заказы со своим ИНН', async () => {
    await sendOrder(order());
    await sendOrder(order({ externalId: '22222222-2222-4222-8222-222222222222', number: 'ЗК-000011', supplierInn: completeInn('616302345'), supplierName: 'Агрофирма «Зерновая»' }));
    const { headers } = await register();
    const list = (await app.inject({ method: 'GET', url: `${API}/orders`, headers })).json();
    expect(list.map((o: { number: string }) => o.number)).toEqual(['ЗК-000010']);
    const other = await app.inject({ method: 'GET', url: `${API}/orders/2`, headers });
    expect(other.statusCode).toBe(404);
  });

  it('подтверждение, отгрузка и отказ идут в «Запас» и меняют заказ только после его согласия', async () => {
    await sendOrder(order());
    const { headers } = await register();
    const id = (await app.inject({ method: 'GET', url: `${API}/orders`, headers })).json()[0].id as number;

    const opened = (await app.inject({ method: 'GET', url: `${API}/orders/${id}`, headers })).json();
    expect(opened.actions).toEqual(['confirm', 'ship', 'decline']);
    expect(opened.items).toHaveLength(1);

    zapas.rejectWith = { status: 502, error: '«Запас» не отвечает' };
    const failed = await app.inject({ method: 'POST', url: `${API}/orders/${id}/confirm`, headers, payload: {} });
    expect(failed.statusCode).toBe(502);
    expect((await app.inject({ method: 'GET', url: `${API}/orders/${id}`, headers })).json().status).toBe('sent');

    zapas.rejectWith = null;
    const confirmed = await app.inject({ method: 'POST', url: `${API}/orders/${id}/confirm`, headers, payload: { note: 'Привезём к десяти', deliveryOn: '2026-10-15' } });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json()).toMatchObject({ status: 'confirmed', stage: 'work', deliveryOn: '2026-10-15', supplierNote: 'Привезём к десяти', actions: ['ship', 'decline'] });
    expect(zapas.pushed[0]).toEqual({ externalId: '11111111-1111-4111-8111-111111111111', status: 'confirmed', note: 'Привезём к десяти', deliveryOn: '2026-10-15' });

    expect((await app.inject({ method: 'POST', url: `${API}/orders/${id}/confirm`, headers, payload: {} })).statusCode).toBe(409);
    const shipped = await app.inject({ method: 'POST', url: `${API}/orders/${id}/ship`, headers, payload: {} });
    expect(shipped.json()).toMatchObject({ status: 'shipped', stage: 'shipped', actions: [] });
    expect(shipped.json().events.length).toBeGreaterThanOrEqual(3);
  });

  it('отказ без причины не принимается', async () => {
    await sendOrder(order());
    const { headers } = await register();
    const id = (await app.inject({ method: 'GET', url: `${API}/orders`, headers })).json()[0].id as number;
    expect((await app.inject({ method: 'POST', url: `${API}/orders/${id}/decline`, headers, payload: {} })).statusCode).toBe(400);
    const res = await app.inject({ method: 'POST', url: `${API}/orders/${id}/decline`, headers, payload: { note: 'Нет товара' } });
    expect(res.json()).toMatchObject({ status: 'declined', stage: 'closed' });
  });

  it('статус приёмки у покупателя приходит обновлением и виден в истории', async () => {
    await sendOrder(order({ status: 'shipped', statusLabel: 'Отгружен' }));
    const { headers } = await register();
    const id = (await app.inject({ method: 'GET', url: `${API}/orders`, headers })).json()[0].id as number;
    await sendOrder(order({ status: 'refused', statusLabel: 'Отказ от поставки', buyerNote: 'Срок годности короче заявленного' }));
    const detail = (await app.inject({ method: 'GET', url: `${API}/orders/${id}`, headers })).json();
    expect(detail).toMatchObject({ status: 'refused', stage: 'closed', buyerNote: 'Срок годности короче заявленного' });
    expect(detail.events.at(-1).text).toContain('отказ от поставки');
  });

  it('«Обновить у покупателя» берёт состояние заказа из «Запаса»', async () => {
    await sendOrder(order({ status: 'shipped', statusLabel: 'Отгружен' }));
    const { headers } = await register();
    const id = (await app.inject({ method: 'GET', url: `${API}/orders`, headers })).json()[0].id as number;
    zapas.fresh = { ...order(), status: 'received', statusLabel: 'Принят' };
    const res = await app.inject({ method: 'POST', url: `${API}/orders/${id}/refresh`, headers });
    expect(res.json()).toMatchObject({ status: 'received', statusLabel: 'Принят' });
    zapas.fresh = null;
    expect((await app.inject({ method: 'POST', url: `${API}/orders/${id}/refresh`, headers })).statusCode).toBe(502);
  });

  it('сводка и покупатели считаются по заказам', async () => {
    await sendOrder(order());
    await sendOrder(order({ externalId: '33333333-3333-4333-8333-333333333333', number: 'ЗК-000012', status: 'confirmed', statusLabel: 'Подтверждён', total: 1000, buyer: { organization: 'Кофейня «Зерно»', location: 'Кофейня «Зерно»', address: null } }));
    const { headers } = await register();
    const dash = (await app.inject({ method: 'GET', url: `${API}/dashboard`, headers })).json();
    expect(dash.counts).toMatchObject({ new: 1, work: 1, shipped: 0, closed: 0 });
    expect(dash.awaitingSum).toBe(3400);
    expect(dash.buyers).toBe(2);
    const buyers = (await app.inject({ method: 'GET', url: `${API}/buyers`, headers })).json();
    expect(buyers.map((b: { organization: string }) => b.organization)).toEqual(['Ресторанная группа «Набережная»', 'Кофейня «Зерно»']);
  });
});

describe('профиль', () => {
  it('меняет данные компании и пароль', async () => {
    const { headers } = await register();
    const saved = await app.inject({ method: 'PUT', url: `${API}/profile`, headers, payload: { company: 'ООО «Донской молочник»', contactName: 'Ковалёв И. П.', phone: '+7 900 000-00-00' } });
    expect(saved.json().account.company).toBe('ООО «Донской молочник»');
    expect((await app.inject({ method: 'POST', url: `${API}/auth/change-password`, headers, payload: { currentPassword: 'не тот', newPassword: 'Совсем-новая-фраза-77' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `${API}/auth/change-password`, headers, payload: { currentPassword: registration.password, newPassword: 'Совсем-новая-фраза-77' } })).statusCode).toBe(204);
    const login = await app.inject({ method: 'POST', url: `${API}/auth/login`, payload: { email: registration.email, password: 'Совсем-новая-фраза-77' } });
    expect(login.statusCode).toBe(200);
  });
});
