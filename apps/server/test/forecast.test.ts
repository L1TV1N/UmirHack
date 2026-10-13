import { addDays, dayOfWeek, type AccuracyDto, type DemandForecastDto } from '@zapas/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenMeteoProvider, refreshWeather } from '../src/modules/forecast/weather';
import { refreshDemandOutlook, runForecastJobs } from '../src/modules/forecast/service';
import { addProduct, createWorld, receive, seedSales, type World } from './fixtures';
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

const admin = () => call(env, w.admin.token);
const manager = () => call(env, w.manager.token);
const keeper = () => call(env, w.keeperA.token);

const WEEK = [1.1, 0.88, 0.92, 1.0, 1.05, 1.22, 1.38];
const dateOfAge = (age: number) => addDays(w.today, -(age + 1));
const weekdayFactor = (date: string) => WEEK[dayOfWeek(date)] as number;
const tempOf = (date: string) => 20 + 8 * Math.sin(Date.parse(`${date}T12:00:00Z`) / 86_400_000 / 5);

async function weatherRows(locationId: string, from: number, to: number, temp: (date: string) => number = tempOf, rain: (date: string) => number = () => 0) {
  const rows = [];
  for (let i = from; i <= to; i += 1) {
    const date = addDays(w.today, i);
    rows.push({ location_id: locationId, day: date, t_max: temp(date), t_min: temp(date) - 8, precip_mm: rain(date), is_forecast: date >= w.today, fetched_at: env.clock.now });
  }
  await env.owner.insertInto('weather_daily').values(rows).execute();
}

/** Позиция с недельной закономерностью продаж (и необязательным влиянием температуры). */
async function product(o: { name?: string; base?: number; tempEffect?: number; days?: number; location?: string; promoOn?: Set<string>; promoUplift?: number } = {}) {
  const location = o.location ?? w.locA.id;
  const p = await addProduct(env, w.categoryId, { name: o.name ?? 'Молоко', unit: 'l' });
  await seedSales(env, {
    productId: p,
    locationId: location,
    days: o.days ?? 70,
    perDay: (age) => {
      const date = dateOfAge(age);
      let m = weekdayFactor(date);
      if (o.tempEffect) m *= Math.exp(o.tempEffect * ((tempOf(date) - 20) / 10));
      if (o.promoOn?.has(date)) m *= o.promoUplift ?? 1.6;
      return Math.round((o.base ?? 40) * m * 10) / 10;
    },
  });
  await receive(env, w.manager.token, location, [{ productId: p, quantity: 500, expiresOn: w.day(20) }]);
  env.forget();
  return p;
}

const demand = async (p: string, location = w.locA.id, days = 14, token = w.manager.token) => call(env, token)('GET', `/api/forecast/demand?productId=${p}&locationId=${location}&days=${days}`);

describe('календарь', () => {
  it('показывает встроенные переносы, ручные исправления добавляет и снимает только администратор', async () => {
    const list = (await manager()('GET', '/api/calendar/days')).json() as { date: string; kind: string; source: string }[];
    expect(list.find((d) => d.date === '2026-12-31')).toMatchObject({ kind: 'off', source: 'builtin' });

    const body = { date: '2026-10-12', kind: 'off', note: 'День города' };
    expect((await manager()('PUT', '/api/calendar/days', body)).statusCode).toBe(403);
    expect((await keeper()('PUT', '/api/calendar/days', body)).statusCode).toBe(403);
    const added = await admin()('PUT', '/api/calendar/days', body);
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json().find((d: { date: string }) => d.date === '2026-10-12')).toMatchObject({ kind: 'off', note: 'День города', source: 'manual' });

    // ручное исправление перекрывает встроенное для той же даты
    await admin()('PUT', '/api/calendar/days', { date: '2026-12-31', kind: 'work' });
    expect(((await manager()('GET', '/api/calendar/days')).json() as { date: string; kind: string; source: string }[]).find((d) => d.date === '2026-12-31')).toMatchObject({ kind: 'work', source: 'manual' });

    const cleared = await admin()('DELETE', '/api/calendar/days/2026-12-31');
    expect(cleared.json().find((d: { date: string }) => d.date === '2026-12-31')).toMatchObject({ kind: 'off', source: 'builtin' });
    expect((await manager()('DELETE', '/api/calendar/days/2026-10-12')).statusCode).toBe(403);
    expect(await env.owner.selectFrom('audit_log').select('id').where('action', 'in', ['calendar.set', 'calendar.clear']).execute()).toHaveLength(3);
  });

  it('проверяет дату и вид', async () => {
    for (const body of [{ date: '12.10.2026', kind: 'off' }, { date: '2026-10-12', kind: 'holiday' }, { date: '2026-10-12', kind: 'off', extra: 1 }]) {
      expect((await admin()('PUT', '/api/calendar/days', body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('ближайшие выходные будни', async () => {
    env.clock.now = new Date('2026-10-30T09:00:00Z');
    // токены живут час, а часы теста переведены: входим заново
    const token = (await loginAs(env, await createUser(env, { role: 'manager' }))).token;
    const res = (await call(env, token)('GET', '/api/calendar/upcoming?days=10')).json();
    expect(res).toEqual([{ date: '2026-11-04', name: 'День народного единства' }]);
  });
});

describe('координаты точек', () => {
  it('точка хранит пару координат, одна половина не принимается', async () => {
    const created = await admin()('POST', '/api/locations', { code: 'GEO-1', name: 'С координатами', kind: 'shop', latitude: 47.2357, longitude: 39.7015 });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ latitude: 47.2357, longitude: 39.7015 });
    expect((await admin()('POST', '/api/locations', { code: 'GEO-2', name: 'Половина', kind: 'shop', latitude: 47.2 })).statusCode).toBe(400);
    expect((await admin()('POST', '/api/locations', { code: 'GEO-3', name: 'Вне земли', kind: 'shop', latitude: 91, longitude: 10 })).statusCode).toBe(400);

    const id = created.json().id as string;
    expect((await admin()('PATCH', `/api/locations/${id}`, { latitude: null })).statusCode).toBe(400);
    const cleared = await admin()('PATCH', `/api/locations/${id}`, { latitude: null, longitude: null });
    expect(cleared.json()).toMatchObject({ latitude: null, longitude: null });
    const moved = await admin()('PATCH', `/api/locations/${id}`, { latitude: 55.75, longitude: 37.61 });
    expect(moved.json()).toMatchObject({ latitude: 55.75, longitude: 37.61 });
    expect((await manager()('PATCH', `/api/locations/${id}`, { latitude: 1, longitude: 1 })).statusCode).toBe(403);
  });
});

describe('погода', () => {
  async function withCoordinates(...ids: string[]) {
    for (const id of ids) await env.owner.updateTable('locations').set({ latitude: 47.2357, longitude: 39.7015 }).where('id', '=', id).execute();
  }

  it('загружается для точек с координатами и сохраняется по суткам, прогноз помечен', async () => {
    await withCoordinates(w.locA.id);
    const res = await admin()('POST', '/api/forecast/weather/refresh');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ locations: 1, failed: [] });
    expect(env.weather.requests).toHaveLength(1);
    expect(env.weather.requests[0]).toMatchObject({ latitude: 47.2357, longitude: 39.7015, timezone: env.config.businessTz, pastDays: 92, forecastDays: 16 });
    const rows = await env.owner.selectFrom('weather_daily').selectAll().where('location_id', '=', w.locA.id).orderBy('day').execute();
    expect(rows).toHaveLength(108);
    expect(rows.filter((r) => r.is_forecast)).toHaveLength(16);
    expect(rows.find((r) => r.day === w.today)).toMatchObject({ is_forecast: true });
    const status = (await admin()('GET', '/api/forecast/weather')).json();
    expect(status.provider).toBe('open-meteo');
    expect(status.locations.find((l: { locationId: string }) => l.locationId === w.locA.id)).toMatchObject({ hasCoordinates: true, days: 108, forecastDays: 16, lastDate: addDays(w.today, 15) });
    expect(status.locations.find((l: { locationId: string }) => l.locationId === w.locB.id)).toMatchObject({ hasCoordinates: false, days: 0 });
  });

  it('повторная загрузка обновляет, а не дублирует', async () => {
    await withCoordinates(w.locA.id);
    await refreshWeather(env.deps);
    env.weather.build = (r, today) => Array.from({ length: r.pastDays + r.forecastDays }, (_, i) => ({ date: addDays(today, i - r.pastDays), tMax: 30, tMin: 20, precipMm: 5 }));
    await refreshWeather(env.deps);
    const rows = await env.owner.selectFrom('weather_daily').selectAll().execute();
    expect(rows).toHaveLength(108);
    expect(Number(rows[0]?.t_max)).toBe(30);
  });

  it('сбой сервиса погоды не роняет остальное и не раскрывает подробностей', async () => {
    await withCoordinates(w.locA.id, w.locB.id);
    env.weather.failure = new Error('connect ECONNREFUSED 10.1.2.3:443 секретная подробность');
    const res = await admin()('POST', '/api/forecast/weather/refresh');
    expect(res.statusCode).toBe(200);
    expect(res.json().locations).toBe(0);
    expect(res.json().failed.sort()).toEqual([w.locA.name, w.locB.name].sort());
    expect(res.body).not.toContain('секретная');
    expect(res.body).not.toContain('10.1.2.3');
  });

  it('только администратор, а без провайдера понятная ошибка', async () => {
    expect((await manager()('POST', '/api/forecast/weather/refresh')).statusCode).toBe(403);
    expect((await manager()('GET', '/api/forecast/weather')).statusCode).toBe(403);
    expect((await call(env, null)('GET', '/api/forecast/weather')).statusCode).toBe(401);
    const off = await refreshWeather({ ...env.deps, weather: null });
    expect(off).toEqual({ locations: 0, days: 0, failed: [] });
  });

  it('суток без температуры и осадков не сохраняет', async () => {
    await withCoordinates(w.locA.id);
    env.weather.build = (_r, today) => [
      { date: addDays(today, -1), tMax: null, tMin: null, precipMm: null },
      { date: today, tMax: 18, tMin: 9, precipMm: null },
    ];
    await refreshWeather(env.deps);
    expect(await env.owner.selectFrom('weather_daily').select('day').execute()).toHaveLength(1);
  });
});

describe('ответ Open-Meteo', () => {
  const ok = (daily: object) => new Response(JSON.stringify({ daily }), { status: 200 });
  const request = { latitude: 47.2357, longitude: 39.7015, timezone: 'Europe/Moscow', pastDays: 2, forecastDays: 1 };
  const daily = { time: ['2026-10-07', '2026-10-08'], temperature_2m_max: [14.2, null], temperature_2m_min: [6, 7], precipitation_sum: [0, 3.4] };

  it('запрашивает только свой хост, шлёт координаты и часовой пояс, не ходит по перенаправлениям', async () => {
    let seen: { url: URL; init: RequestInit } | null = null;
    const provider = new OpenMeteoProvider((async (url: URL, init: RequestInit) => {
      seen = { url, init };
      return ok(daily);
    }) as unknown as typeof fetch);
    const days = await provider.fetchDaily(request);
    expect(days).toEqual([
      { date: '2026-10-07', tMax: 14.2, tMin: 6, precipMm: 0 },
      { date: '2026-10-08', tMax: null, tMin: 7, precipMm: 3.4 },
    ]);
    const s = seen as unknown as { url: URL; init: RequestInit };
    expect(s.url.origin).toBe('https://api.open-meteo.com');
    expect(s.url.pathname).toBe('/v1/forecast');
    expect(s.url.searchParams.get('latitude')).toBe('47.2357');
    expect(s.url.searchParams.get('timezone')).toBe('Europe/Moscow');
    expect(s.url.searchParams.get('past_days')).toBe('2');
    expect(s.init.redirect).toBe('error');
  });

  it('отклоняет чужую форму ответа, невероятные значения и ошибки сервиса', async () => {
    const bad = async (res: Response | Error) => {
      const provider = new OpenMeteoProvider((async () => {
        if (res instanceof Error) throw res;
        return res;
      }) as unknown as typeof fetch);
      await expect(provider.fetchDaily(request)).rejects.toThrow(/Погода|boom/);
    };
    await bad(new Response('{}', { status: 200 }));
    await bad(new Response('не json', { status: 200 }));
    await bad(new Response('{}', { status: 500 }));
    await bad(ok({ ...daily, temperature_2m_max: [14.2] }));
    await bad(ok({ ...daily, temperature_2m_max: [140, 1] }));
    await bad(ok({ ...daily, precipitation_sum: [-5, 1] }));
    await bad(ok({ ...daily, time: ['вчера', '2026-10-08'] }));
    await bad(new Response(JSON.stringify({ daily, padding: 'x'.repeat(400_000) }), { status: 200 }));
    await bad(new Error('boom'));
  });
});

describe('прогноз спроса', () => {
  it('находит дни недели, прогнозирует выходные выше будней и показывает причины', async () => {
    const p = await product({ base: 40 });
    const res = await demand(p);
    expect(res.statusCode, res.body).toBe(200);
    const d = res.json() as DemandForecastDto;
    expect(d).toMatchObject({ productId: p, locationId: w.locA.id, observedDays: 70, unit: 'l' });
    expect(d.confirmed.weekday).toBe(true);
    expect(d.weekday).toHaveLength(7);
    expect(d.weekday[6]).toBeGreaterThan(d.weekday[1]! * 1.4);
    expect(d.forecast).toHaveLength(14);
    const sat = d.forecast.find((f) => dayOfWeek(f.date) === 6)!;
    const mon = d.forecast.find((f) => dayOfWeek(f.date) === 1)!;
    expect(sat.qty).toBeGreaterThan(mon.qty * 1.4);
    expect(sat.tags).toContain('выходной');
    expect(mon.tags).toEqual([]);
    expect(sat.low).toBeLessThanOrEqual(sat.qty);
    expect(sat.high).toBeGreaterThanOrEqual(sat.qty);
    // в прогнозе учтены и точная поправка дня, и факт
    expect(d.history).toHaveLength(28);
    expect(d.history.at(-1)?.date).toBe(addDays(w.today, -1));
    expect(d.forecast[0]?.date).toBe(w.today);
  });

  it('проверка на прошлом по позиции: модель точнее простой скорости', async () => {
    const p = await product({ base: 40 });
    const d = (await demand(p)).json() as DemandForecastDto;
    expect(d.accuracy?.days).toBe(14);
    expect(d.accuracy!.wapeModel!).toBeLessThan(d.accuracy!.wapeFlat! * 0.5);
  });

  it('учитывает температуру: в жаркие дни прогноз выше, у позиции есть подтверждённый эффект', async () => {
    const p = await product({ base: 40, tempEffect: 0.3 });
    await weatherRows(w.locA.id, -70, 14);
    const d = (await demand(p)).json() as DemandForecastDto;
    expect(d.confirmed.weather).toBe(true);
    expect(d.tempPct).toBeGreaterThan(15);
    expect(d.weather).toMatchObject({ hasCoordinates: false });
    const hot = [...d.forecast].filter((f) => dayOfWeek(f.date) === dayOfWeek(d.forecast[0]!.date)).sort((a, b) => a.weather - b.weather);
    expect(hot[hot.length - 1]!.weather).toBeGreaterThan(hot[0]!.weather);
    const warm = d.forecast.find((f) => (f.tMax ?? 0) - 20 >= 6 && f.tags.includes('жарче обычного'));
    expect(warm).toBeDefined();
  });

  it('без данных о погоде эффект не выдумывается', async () => {
    const p = await product({ base: 40 });
    const d = (await demand(p)).json() as DemandForecastDto;
    expect(d.confirmed.weather).toBe(false);
    expect(d.tempPct).toBeNull();
    expect(d.forecast.every((f) => f.weather === 1)).toBe(true);
  });

  it('учитывает акции: прирост в акционные дни и пометка будущей акции', async () => {
    const promoOn = new Set<string>();
    for (let age = 10; age <= 14; age += 1) promoOn.add(dateOfAge(age));
    for (let age = 35; age <= 38; age += 1) promoOn.add(dateOfAge(age));
    const p = await product({ base: 40, promoOn, promoUplift: 1.7 });
    const batch = await env.owner.selectFrom('batches').select('id').where('product_id', '=', p).orderBy('created_at').executeTakeFirstOrThrow();
    const mk = (startAge: number, endAge: number) =>
      env.owner
        .insertInto('promotions')
        .values({ batch_id: batch.id, percent: 20, ends_on: dateOfAge(endAge), created_by: null, created_at: new Date(`${dateOfAge(startAge)}T09:00:00+03:00`), cancelled_at: new Date(`${dateOfAge(endAge)}T20:00:00+03:00`) })
        .execute();
    await mk(14, 10);
    await mk(38, 35);
    // действующая акция на ближайшие дни
    await env.owner.insertInto('promotions').values({ batch_id: batch.id, percent: 15, ends_on: addDays(w.today, 2), created_by: null, created_at: new Date(`${w.today}T08:00:00+03:00`), cancelled_at: null }).execute();
    const d = (await demand(p)).json() as DemandForecastDto;
    expect(d.confirmed.promo).toBe(true);
    expect(d.promoUplift).toBeGreaterThan(1.4);
    expect(d.promoUplift).toBeLessThan(2);
    const [first, second, third, after] = d.forecast;
    for (const f of [first, second, third]) {
      expect(f!.promo).toBe(d.promoUplift);
      expect(f!.tags).toContain('акция');
    }
    expect(after!.promo).toBe(1);
  });

  it('отменённая акция действовала до дня отмены', async () => {
    const promoOn = new Set<string>();
    for (let age = 10; age <= 14; age += 1) promoOn.add(dateOfAge(age));
    const p = await product({ base: 40, promoOn, promoUplift: 1.7 });
    const batch = await env.owner.selectFrom('batches').select('id').where('product_id', '=', p).orderBy('created_at').executeTakeFirstOrThrow();
    await env.owner.insertInto('promotions').values({ batch_id: batch.id, percent: 20, ends_on: addDays(w.today, 30), created_by: null, created_at: new Date(`${dateOfAge(14)}T09:00:00+03:00`), cancelled_at: new Date(`${dateOfAge(10)}T18:00:00+03:00`) }).execute();
    const d = (await demand(p)).json() as DemandForecastDto;
    expect(d.forecast.every((f) => f.promo === 1)).toBe(true);
  });

  it('права и видимость: наблюдатель закрыт, кладовщик только своя точка, чужой продукт 404', async () => {
    const p = await product({ base: 40 });
    expect((await demand(p, w.locA.id, 14, w.viewerA.token)).statusCode).toBe(403);
    expect((await demand(p, w.locA.id, 14, w.keeperA.token)).statusCode).toBe(200);
    expect((await demand(p, w.locB.id, 14, w.keeperA.token)).statusCode).toBe(404);
    expect((await demand(p, w.locB.id)).statusCode).toBe(404);
    expect((await call(env, null)('GET', `/api/forecast/demand?productId=${p}&locationId=${w.locA.id}`)).statusCode).toBe(401);
    expect((await manager()('GET', `/api/forecast/demand?productId=${p}&locationId=${w.locA.id}&days=99`)).statusCode).toBe(400);
  });

  it('короткая история: без дней недели, честно сообщает число суток', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Новинка', unit: 'l' });
    await seedSales(env, { productId: p, locationId: w.locA.id, days: 6, perDay: 10 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 50, expiresOn: w.day(20) }]);
    const d = (await demand(p)).json() as DemandForecastDto;
    expect(d.observedDays).toBe(6);
    expect(d.confirmed).toEqual({ weekday: false, holiday: false, weather: false, promo: false });
    expect(d.weekday).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(d.accuracy).toBeNull();
  });

  it('праздничный будний день прогнозируется как воскресенье', async () => {
    const p = await product({ base: 40 });
    // завтра пятница: сам по себе будний день, поэтому пометка «День города» может прийти только из календаря
    await admin()('PUT', '/api/calendar/days', { date: addDays(w.today, 1), kind: 'off', note: 'День города' });
    const d = (await demand(p)).json() as DemandForecastDto;
    const off = d.forecast[1]!;
    expect(off.tags.join(' ')).toContain('День города');
    const sundayWeight = d.weekday[0]!;
    const normal = d.forecast.find((f, i) => i > 3 && dayOfWeek(f.date) === dayOfWeek(off.date))!;
    expect(off.weekday).toBeCloseTo(sundayWeight, 3);
    expect(Math.abs(off.weekday - normal.weekday)).toBeGreaterThan(0.01);
  });
});

describe('точность на прошлом', () => {
  it('сводка по позициям: модель точнее, ошибка и смещение в долях', async () => {
    await product({ name: 'Молоко', base: 40 });
    await product({ name: 'Кефир', base: 25 });
    const res = await manager()('GET', '/api/forecast/accuracy?days=14');
    expect(res.statusCode, res.body).toBe(200);
    const a = res.json() as AccuracyDto;
    expect(a.series).toBe(2);
    expect(a.days).toBe(14);
    expect(a.wapeModel!).toBeLessThan(a.wapeFlat!);
    expect(a.wapeWeekday!).toBeLessThan(a.wapeFlat!);
    expect(a.improvementPct!).toBeGreaterThan(40);
    expect(Math.abs(a.biasModel!)).toBeLessThan(Math.abs(a.biasFlat!) + 0.05);
    expect(a.rows).toHaveLength(2);
    expect(a.rows[0]!.volume).toBeGreaterThanOrEqual(a.rows[1]!.volume);
    expect(a.rows[0]).toMatchObject({ productName: 'Молоко', locationId: w.locA.id });
  });

  it('точки фильтруются, кладовщику и наблюдателю закрыто, пустая система не падает', async () => {
    const empty = (await manager()('GET', '/api/forecast/accuracy')).json() as AccuracyDto;
    expect(empty).toMatchObject({ series: 0, wapeModel: null, improvementPct: null, rows: [] });
    await product({ name: 'А', base: 40, location: w.locA.id });
    await product({ name: 'Б', base: 40, location: w.locB.id });
    expect(((await manager()('GET', `/api/forecast/accuracy?locationId=${w.locB.id}`)).json() as AccuracyDto).series).toBe(1);
    expect((await keeper()('GET', '/api/forecast/accuracy')).statusCode).toBe(403);
    expect((await call(env, w.viewerA.token)('GET', '/api/forecast/accuracy')).statusCode).toBe(403);
    expect((await manager()('GET', '/api/forecast/accuracy?days=3')).statusCode).toBe(400);
  });

  it('учитывает, у скольких позиций подтверждена погода', async () => {
    await product({ name: 'Вода', base: 40, tempEffect: 0.3 });
    await weatherRows(w.locA.id, -70, 14);
    const a = (await manager()('GET', '/api/forecast/accuracy')).json() as AccuracyDto;
    expect(a.weatherSeries).toBe(1);
    expect(a.wapeModel!).toBeLessThan(a.wapeWeekday!);
  });
});

describe('поправка к скорости', () => {
  const velocity = async (p: string) => ((await manager()('GET', `/api/analytics/forecast/${p}?locationId=${w.locA.id}`)).json() as { velocityPerDay: number }).velocityPerDay;

  it('пересчёт сохраняет множитель, и скорость в рекомендациях умножается на него', async () => {
    // температура на ближайшую неделю заметно выше обычной, продажи от жары растут
    const p = await product({ base: 40, tempEffect: 0.3 });
    await weatherRows(w.locA.id, -70, -1);
    await weatherRows(w.locA.id, 0, 14, () => 30);
    const before = await velocity(p);
    const res = await refreshDemandOutlook(env.deps);
    expect(res.pairs).toBe(1);
    expect(res.adjusted).toBe(1);
    env.forget();
    const row = await env.owner.selectFrom('demand_outlook').selectAll().where('product_id', '=', p).executeTakeFirstOrThrow();
    expect(Number(row.factor)).toBeGreaterThan(1.1);
    expect(row.computed_for).toBe(w.today);
    expect(await velocity(p)).toBeCloseTo(before * Number(row.factor), 1);
  });

  it('устаревший множитель (за другие сутки) и выключенная настройка игнорируются', async () => {
    const p = await product({ base: 40, tempEffect: 0.3 });
    await weatherRows(w.locA.id, -70, -1);
    await weatherRows(w.locA.id, 0, 14, () => 30);
    const before = await velocity(p);
    await refreshDemandOutlook(env.deps);
    env.forget();
    const boosted = await velocity(p);
    expect(boosted).toBeGreaterThan(before * 1.05);

    const { telegramConfigured: _telegram, ...current } = (await admin()('GET', '/api/settings')).json();
    const off = await admin()('PUT', '/api/settings', { ...current, useDemandModel: false });
    expect(off.statusCode, off.body).toBe(200);
    env.forget();
    expect(await velocity(p)).toBeCloseTo(before, 3);
    await admin()('PUT', '/api/settings', { ...current, useDemandModel: true });

    // множитель привязан к дате расчёта: на следующие сутки он не действует, пока его не пересчитают
    await env.owner.updateTable('demand_outlook').set({ computed_for: addDays(w.today, -1) }).execute();
    env.forget();
    expect(await velocity(p)).toBeCloseTo(before, 3);
  });

  it('позиции с короткой историей или без продаж не получают множителя', async () => {
    const fresh = await addProduct(env, w.categoryId, { name: 'Новинка', unit: 'l' });
    await seedSales(env, { productId: fresh, locationId: w.locA.id, days: 6, perDay: 10 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: fresh, quantity: 50, expiresOn: w.day(20) }]);
    const silent = await addProduct(env, w.categoryId, { name: 'Не продаётся', unit: 'l' });
    await receive(env, w.manager.token, w.locA.id, [{ productId: silent, quantity: 50, expiresOn: w.day(20) }]);
    const res = await refreshDemandOutlook(env.deps);
    expect(res.pairs).toBe(0);
  });

  it('ровные продажи оставляют скорость практически прежней', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Ровное', unit: 'l' });
    await seedSales(env, { productId: p, locationId: w.locA.id, days: 60, perDay: 20 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 500, expiresOn: w.day(20) }]);
    const before = await velocity(p);
    await refreshDemandOutlook(env.deps);
    env.forget();
    expect(await velocity(p)).toBeCloseTo(before, 1);
  });
});

describe('фоновая работа', () => {
  it('загружает погоду, когда её давно не обновляли, и пересчитывает множители, повторно ничего не делает', async () => {
    await env.owner.updateTable('locations').set({ latitude: 47.2357, longitude: 39.7015 }).where('id', '=', w.locA.id).execute();
    await product({ base: 40 });
    await runForecastJobs(env.deps);
    expect(env.weather.requests).toHaveLength(1);
    expect(await env.owner.selectFrom('demand_outlook').select('product_id').execute()).toHaveLength(1);
    await runForecastJobs(env.deps);
    expect(env.weather.requests).toHaveLength(1);
    // через шесть часов погоду пора обновить
    env.clock.advance(6 * 3_600_000 + 1000);
    await runForecastJobs(env.deps);
    expect(env.weather.requests).toHaveLength(2);
  });

  it('сбой погоды не мешает пересчёту множителей', async () => {
    await env.owner.updateTable('locations').set({ latitude: 47.2357, longitude: 39.7015 }).where('id', '=', w.locA.id).execute();
    env.weather.failure = new Error('нет связи');
    await product({ base: 40 });
    await runForecastJobs(env.deps);
    expect(await env.owner.selectFrom('demand_outlook').select('product_id').execute()).toHaveLength(1);
  });
});
