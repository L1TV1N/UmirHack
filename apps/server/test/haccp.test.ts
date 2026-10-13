import type { HaccpPointDto, HaccpReadingDto, Page } from '@zapas/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addProduct, createWorld, receive, type World } from './fixtures';
import { call, createTestEnv, createUser, loginAs, type TestEnv } from './helpers';

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

async function point(over: Record<string, unknown> = {}, locationId = w.locA.id): Promise<HaccpPointDto> {
  const res = await manager()('POST', '/api/haccp/points', { locationId, name: 'Холодильник 1', kind: 'fridge', minTemp: 0, maxTemp: 6, everyHours: 4, ...over });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}
const reading = (pointId: string, value: number, extra: Record<string, unknown> = {}) => keeper()('POST', '/api/haccp/readings', { pointId, value, ...extra });
const readings = async (query = '') => (await manager()('GET', `/api/haccp/readings${query}`)).json() as Page<HaccpReadingDto>;

describe('контрольные точки', () => {
  it('менеджер заводит точку, кладовщик видит её на своей точке и не может менять', async () => {
    const p = await point();
    expect(p).toMatchObject({ name: 'Холодильник 1', minTemp: 0, maxTemp: 6, everyHours: 4, last: null, openDeviations: 0, locationName: w.locA.name });
    expect((await keeper()('GET', '/api/haccp/points')).json()).toHaveLength(1);
    expect((await keeper()('POST', '/api/haccp/points', { locationId: w.locA.id, name: 'Х', kind: 'fridge', minTemp: 0, maxTemp: 6 })).statusCode).toBe(403);
    expect((await keeper()('PATCH', `/api/haccp/points/${p.id}`, { name: 'Другое' })).statusCode).toBe(403);
  });

  it('границы проверяются: верхняя не ниже нижней, вид из списка', async () => {
    for (const body of [{ minTemp: 7, maxTemp: 6 }, { kind: 'сауна' }, { everyHours: 0 }, { minTemp: 0.55 }]) {
      const res = await manager()('POST', '/api/haccp/points', { locationId: w.locA.id, name: 'Х', kind: 'fridge', minTemp: 0, maxTemp: 6, ...body });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    const p = await point();
    expect((await manager()('PATCH', `/api/haccp/points/${p.id}`, { minTemp: 8 })).statusCode).toBe(400);
  });

  it('кладовщик не видит точки чужого склада', async () => {
    await point({ name: 'Свой' });
    await point({ name: 'Чужой' }, w.locB.id);
    const names = ((await keeper()('GET', '/api/haccp/points')).json() as HaccpPointDto[]).map((x) => x.name);
    expect(names).toEqual(['Свой']);
    expect((await keeper()('GET', `/api/haccp/points?locationId=${w.locB.id}`)).statusCode).toBe(404);
  });

  it('отключённая точка не ждёт замеров и не принимает их', async () => {
    const p = await point();
    await manager()('PATCH', `/api/haccp/points/${p.id}`, { isActive: false });
    expect((await keeper()('GET', '/api/haccp/points')).json()).toHaveLength(0);
    const res = await reading(p.id, 4);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('point_inactive');
  });
});

describe('замеры и отклонения', () => {
  it('замер в норме записывается, в журнале виден автор и границы на момент замера', async () => {
    const p = await point();
    const res = await reading(p.id, 4.5, { comment: 'Утренний обход' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ pointName: 'Холодильник 1', value: 4.5, minTemp: 0, maxTemp: 6, inRange: true, comment: 'Утренний обход', action: null });
    const point2 = ((await keeper()('GET', '/api/haccp/points')).json() as HaccpPointDto[])[0]!;
    expect(point2.last).toMatchObject({ value: 4.5, inRange: true });
    expect(point2.openDeviations).toBe(0);
  });

  it('границы включены, выход за них это отклонение, которое остаётся открытым и сообщается в чат', async () => {
    const p = await point();
    expect((await reading(p.id, 6)).json().inRange).toBe(true);
    expect((await reading(p.id, 0)).json().inRange).toBe(true);
    env.notifier.messages.length = 0;
    const bad = await reading(p.id, 8.5);
    expect(bad.json()).toMatchObject({ inRange: false, action: null });
    expect(env.notifier.messages[0]).toContain('Отклонение температуры');
    expect(env.notifier.messages[0]).toContain('8.5');
    expect(((await keeper()('GET', '/api/haccp/points')).json() as HaccpPointDto[])[0]?.openDeviations).toBe(1);
    expect((await manager()('GET', '/api/haccp/summary')).json()).toMatchObject({ points: 1, openDeviations: 1 });
  });

  it('действие по отклонению можно записать сразу или позже, один раз', async () => {
    const p = await point();
    const withAction = await reading(p.id, 9, { action: 'Продукты перенесены в холодильник 2, вызван мастер' });
    expect(withAction.json().action).toMatchObject({ text: expect.stringContaining('вызван мастер') });
    expect(((await keeper()('GET', '/api/haccp/points')).json() as HaccpPointDto[])[0]?.openDeviations).toBe(0);

    const later = (await reading(p.id, 10)).json() as HaccpReadingDto;
    const done = await keeper()('POST', `/api/haccp/readings/${later.id}/action`, { action: 'Дверь была не закрыта, температура вернулась' });
    expect(done.statusCode).toBe(200);
    expect(done.json().action.authorName).toBeTruthy();
    const again = await keeper()('POST', `/api/haccp/readings/${later.id}/action`, { action: 'Ещё раз' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('action_exists');
  });

  it('действие к замеру в норме не принимается', async () => {
    const p = await point();
    const ok = (await reading(p.id, 4)).json() as HaccpReadingDto;
    const res = await keeper()('POST', `/api/haccp/readings/${ok.id}/action`, { action: 'Что-то' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('not_a_deviation');
  });

  it('смена границ позже не меняет оценку прежних замеров', async () => {
    const p = await point();
    await reading(p.id, 8);
    await manager()('PATCH', `/api/haccp/points/${p.id}`, { maxTemp: 10 });
    const old = (await readings()).items[0]!;
    expect(old).toMatchObject({ value: 8, maxTemp: 6, inRange: false });
    expect((await reading(p.id, 8)).json()).toMatchObject({ maxTemp: 10, inRange: true });
  });

  it('просроченный замер: точка помечается, как только срок вышел', async () => {
    const p = await point({ everyHours: 4 });
    const fresh = ((await keeper()('GET', '/api/haccp/points')).json() as HaccpPointDto[])[0]!;
    expect(fresh.overdue).toBe(false);
    await reading(p.id, 4);
    env.clock.advance(4 * 3_600_000 + 60_000);
    const token = (await loginAs(env, await createUser(env, { role: 'storekeeper', locationIds: [w.locA.id] }))).token;
    const late = ((await call(env, token)('GET', '/api/haccp/points')).json() as HaccpPointDto[])[0]!;
    expect(late.overdue).toBe(true);
    expect((await call(env, token)('GET', '/api/haccp/summary')).json()).toMatchObject({ overdue: 1 });
  });

  it('наблюдатель читает журнал, но не пишет; чужая точка недоступна', async () => {
    const p = await point();
    await reading(p.id, 4);
    const viewer = call(env, w.viewerA.token);
    expect((await viewer('GET', '/api/haccp/readings')).statusCode).toBe(200);
    expect((await viewer('POST', '/api/haccp/readings', { pointId: p.id, value: 4 })).statusCode).toBe(403);
    const foreign = await point({ name: 'Чужой' }, w.locB.id);
    expect((await reading(foreign.id, 4)).statusCode).toBe(404);
  });

  it('замер с невозможным значением отвергается', async () => {
    const p = await point();
    for (const value of [1000, -200, Number.NaN]) expect((await reading(p.id, value)).statusCode, String(value)).toBe(400);
    expect((await reading(p.id, 4, { extra: true })).statusCode).toBe(400);
  });
});

describe('журнал и выгрузка', () => {
  it('фильтры по точке, периоду и отклонениям, постранично', async () => {
    const a = await point({ name: 'Холодильник 1' });
    const b = await point({ name: 'Морозильник', kind: 'freezer', minTemp: -24, maxTemp: -18 });
    await reading(a.id, 4);
    await reading(a.id, 9);
    await reading(b.id, -20);
    expect((await readings()).total).toBe(3);
    expect((await readings(`?pointId=${b.id}`)).total).toBe(1);
    expect((await readings('?deviations=true')).items.map((r) => r.value)).toEqual([9]);
    expect((await readings('?limit=2')).items).toHaveLength(2);
    expect((await readings(`?from=${w.day(1)}`)).total).toBe(0);
    expect((await readings(`?from=${w.day(0)}&to=${w.day(0)}`)).total).toBe(3);
  });

  it('CSV для проверяющих: отклонения и действия, формулы в ячейках обезврежены', async () => {
    const p = await point({ name: '=Холодильник' });
    await reading(p.id, 9, { action: 'Перенесли продукты' });
    const res = await manager()('GET', '/api/reports/haccp.csv');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const text = res.body;
    expect(text).toContain('Корректирующее действие');
    expect(text).toContain('Перенесли продукты');
    expect(text).toContain("'=Холодильник");
    expect(text).toContain(';нет;');
    expect((await keeper()('GET', '/api/reports/haccp.csv')).statusCode).toBe(403);
  });
});

describe('бракераж при приёмке', () => {
  async function perishable() {
    const p = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l', shelfLifeDays: 6 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 10, expiresOn: w.day(5) }]);
    return p;
  }
  const pending = async (token = w.keeperA.token) => (await call(env, token)('GET', '/api/haccp/inspections/pending')).json() as { batchId: string; productName: string }[];

  it('скоропортящаяся партия ждёт осмотра, долгохранимая нет', async () => {
    await perishable();
    const rice = await addProduct(env, w.categoryId, { name: 'Рис', unit: 'kg', shelfLifeDays: 365 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: rice, quantity: 10, expiresOn: w.day(300) }]);
    expect((await pending()).map((b) => b.productName)).toEqual(['Молоко']);
  });

  it('осмотр записывается один раз и убирает партию из очереди', async () => {
    await perishable();
    const [batch] = await pending();
    const res = await keeper()('POST', '/api/haccp/inspections', { batchId: batch!.batchId, temperature: 4.2, appearanceOk: true, packagingOk: true, decision: 'accepted' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ decision: 'accepted', temperature: 4.2, productName: 'Молоко' });
    expect(await pending()).toEqual([]);
    const again = await keeper()('POST', '/api/haccp/inspections', { batchId: batch!.batchId, appearanceOk: true, packagingOk: true, decision: 'accepted' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('already_inspected');
    expect(((await keeper()('GET', '/api/haccp/inspections')).json() as Page<unknown>).total).toBe(1);
  });

  it('отказ сообщается в чат, партия остаётся на учёте до возврата или списания', async () => {
    await perishable();
    const [batch] = await pending();
    env.notifier.messages.length = 0;
    const res = await keeper()('POST', '/api/haccp/inspections', { batchId: batch!.batchId, appearanceOk: false, packagingOk: true, decision: 'rejected', comment: 'Вздутая упаковка' });
    expect(res.statusCode).toBe(201);
    expect(env.notifier.messages[0]).toContain('не принята');
    expect(env.notifier.messages[0]).toContain('Вздутая упаковка');
  });

  it('чужая точка недоступна, наблюдатель не пишет', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l', shelfLifeDays: 6 });
    await receive(env, w.manager.token, w.locB.id, [{ productId: p, quantity: 10, expiresOn: w.day(5) }]);
    const batch = (await env.owner.selectFrom('batches').select('id').executeTakeFirstOrThrow()).id;
    expect((await pending()).length).toBe(0);
    expect((await keeper()('POST', '/api/haccp/inspections', { batchId: batch, appearanceOk: true, packagingOk: true, decision: 'accepted' })).statusCode).toBe(404);
    expect((await call(env, w.viewerA.token)('POST', '/api/haccp/inspections', { batchId: batch, appearanceOk: true, packagingOk: true, decision: 'accepted' })).statusCode).toBe(403);
  });
});

describe('неизменяемость журнала', () => {
  it('прикладная роль не может переписать замеры, действия и осмотры', async () => {
    const p = await point();
    const r = (await reading(p.id, 9, { action: 'Сделали' })).json() as HaccpReadingDto;
    await expect(env.db.updateTable('haccp_readings').set({ value: 4 }).where('id', '=', r.id).execute()).rejects.toThrow();
    await expect(env.db.updateTable('haccp_actions').set({ action: 'Иначе' }).where('reading_id', '=', r.id).execute()).rejects.toThrow();
    await expect(env.db.deleteFrom('haccp_readings').where('id', '=', r.id).execute()).rejects.toThrow();
  });
});
