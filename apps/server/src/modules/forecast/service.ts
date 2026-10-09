import {
  addDays,
  BUILTIN_OVERRIDES,
  dayOfWeek,
  upcomingOffDays,
  weekdayOff,
  type AccuracyDto,
  type AccuracyRowDto,
  type CalendarDayDto,
  type CalendarOverride,
  type DemandDayDto,
  type DemandForecastDto,
  type Unit,
  type WeatherStatusDto,
} from '@zapas/shared';
import { sql } from 'kysely';
import {
  ALL_FEATURES,
  backtestSeries,
  fitDemand,
  flatLevel,
  forecastDays,
  nextDates,
  outlookFactor,
  predictDay,
  wape,
  type DayContext,
  type HistoryPoint,
} from '../../domain/demand';
import type { Db } from '../../db/client';
import type { Deps, Principal } from '../../lib/context';
import { assertLocation, locationFilter } from '../../lib/scope';
import { notFound } from '../../lib/errors';
import { businessToday } from '../../lib/time';
import { getSettings } from '../settings/settings';
import { refreshWeather, WEATHER_STALE_MS } from './weather';

const NO_ROWS = ['00000000-0000-0000-0000-000000000000'];
/** Сколько суток вперёд смотрит поправка к скорости. */
export const OUTLOOK_DAYS = 7;
/** Осадки от этого количества миллиметров считаем дождливым днём. */
const RAIN_MM = 1;
/** Сколько позиций проверяем на точность: самые продаваемые. */
const ACCURACY_SERIES_LIMIT = 400;
const ACCURACY_TTL_MS = 5 * 60_000;
/** Сколько суток истории берёт модель спроса: чтобы увидеть дни недели и влияние погоды нужно заметно больше четырёх недель. */
export const DEMAND_HISTORY_DAYS = 84;

export async function loadCalendarOverrides(db: Db): Promise<CalendarOverride[]> {
  const rows = await db.selectFrom('calendar_days').select(['day', 'kind', 'note']).orderBy('day').execute();
  return rows.map((r) => ({ date: r.day, kind: r.kind, note: r.note }));
}

export async function listCalendarDays(db: Db): Promise<CalendarDayDto[]> {
  const manual = await loadCalendarOverrides(db);
  const taken = new Set(manual.map((m) => m.date));
  return [
    ...manual.map((m) => ({ date: m.date, kind: m.kind, note: m.note ?? null, source: 'manual' as const })),
    ...BUILTIN_OVERRIDES.filter((b) => !taken.has(b.date)).map((b) => ({ date: b.date, kind: b.kind, note: b.note ?? null, source: 'builtin' as const })),
  ].sort((a, b) => (a.date < b.date ? -1 : 1));
}

interface Pair {
  productId: string;
  productName: string;
  unit: Unit;
  locationId: string;
  locationName: string;
  since: string;
}

interface Context {
  today: string;
  overrides: CalendarOverride[];
  /** Погода: точка → сутки → значения. */
  weather: Map<string, Map<string, { tMax: number | null; rain: boolean | null }>>;
  /** Акции: пара → сутки. */
  promo: Map<string, Set<string>>;
}

const pairKey = (productId: string, locationId: string) => `${productId}|${locationId}`;

function dayContext(ctx: Context, locationId: string, productId: string, date: string): DayContext {
  const w = ctx.weather.get(locationId)?.get(date);
  return {
    date,
    off: weekdayOff(date, ctx.overrides).off,
    tMax: w?.tMax ?? null,
    rain: w?.rain ?? null,
    promo: ctx.promo.get(pairKey(productId, locationId))?.has(date) ?? false,
  };
}

async function loadContext(deps: Deps, scope: string[] | null, from: string, to: string): Promise<Context> {
  const { db } = deps;
  const today = businessToday(deps);
  const overrides = await loadCalendarOverrides(db);
  const weatherRows = await db
    .selectFrom('weather_daily')
    .select(['location_id', 'day', 't_max', 'precip_mm'])
    .where('day', '>=', from)
    .where('day', '<=', to)
    .$if(scope !== null, (qb) => qb.where('location_id', 'in', scope?.length ? scope : NO_ROWS))
    .execute();
  const weather: Context['weather'] = new Map();
  for (const r of weatherRows) {
    const byDay = weather.get(r.location_id) ?? new Map();
    byDay.set(r.day, { tMax: r.t_max === null ? null : Number(r.t_max), rain: r.precip_mm === null ? null : Number(r.precip_mm) >= RAIN_MM });
    weather.set(r.location_id, byDay);
  }

  const tz = deps.config.businessTz;
  const promoRows = await db
    .selectFrom('promotions as p')
    .innerJoin('batches as b', 'b.id', 'p.batch_id')
    .select(['b.product_id', 'b.location_id', 'p.ends_on', 'p.cancelled_at', sql<string>`((p.created_at AT TIME ZONE ${tz})::date)::text`.as('starts_on')])
    .where('p.ends_on', '>=', from)
    .$if(scope !== null, (qb) => qb.where('b.location_id', 'in', scope?.length ? scope : NO_ROWS))
    .execute();
  const promo: Context['promo'] = new Map();
  for (const r of promoRows) {
    const cancelled = r.cancelled_at ? new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(r.cancelled_at) : null;
    // отменённая акция действовала до дня отмены включительно
    const end = cancelled && cancelled < r.ends_on ? cancelled : r.ends_on;
    const set = promo.get(pairKey(r.product_id, r.location_id)) ?? new Set<string>();
    for (let d = r.starts_on < from ? from : r.starts_on; d <= end && d <= to; d = addDays(d, 1)) set.add(d);
    promo.set(pairKey(r.product_id, r.location_id), set);
  }
  return { today, overrides, weather, promo };
}

interface Series extends Pair {
  history: HistoryPoint[];
}

/** Ряды продаж по суткам для позиций точек из scope. Сутки без продаж записаны нулями, дни до первой приёмки не берутся. */
async function loadSeries(deps: Deps, scope: string[] | null, ctx: Context, windowDays: number, productId?: string): Promise<Series[]> {
  const { db } = deps;
  const tz = deps.config.businessTz;
  const from = addDays(ctx.today, -windowDays);
  const pairRows = await db
    .selectFrom('batches as b')
    .innerJoin('products as p', 'p.id', 'b.product_id')
    .innerJoin('locations as l', 'l.id', 'b.location_id')
    .select(['b.product_id', 'b.location_id', 'p.name as product_name', 'p.unit', 'l.name as location_name', sql<string>`min(b.received_on)`.as('since')])
    .where('p.is_active', '=', true)
    .where('l.is_active', '=', true)
    .$if(scope !== null, (qb) => qb.where('b.location_id', 'in', scope?.length ? scope : NO_ROWS))
    .$if(productId !== undefined, (qb) => qb.where('b.product_id', '=', productId as string))
    .groupBy(['b.product_id', 'b.location_id', 'p.name', 'p.unit', 'l.name'])
    .execute();
  if (pairRows.length === 0) return [];

  const outflow = await sql<{ product_id: string; location_id: string; day: string; qty: string }>`
    SELECT product_id, location_id, ((created_at AT TIME ZONE ${tz})::date)::text AS day, SUM(-quantity) AS qty
    FROM stock_movements
    WHERE type IN ('sale', 'transfer_out')
      AND created_at >= ((${from}::date)::timestamp AT TIME ZONE ${tz})
      AND created_at < ((${ctx.today}::date)::timestamp AT TIME ZONE ${tz})
      ${scope !== null ? sql`AND location_id IN (${sql.join((scope.length ? scope : NO_ROWS).map((id) => sql`${id}::uuid`))})` : sql``}
      ${productId !== undefined ? sql`AND product_id = ${productId}::uuid` : sql``}
    GROUP BY product_id, location_id, day`.execute(db);
  const sold = new Map<string, Map<string, number>>();
  for (const r of outflow.rows) {
    const k = pairKey(r.product_id, r.location_id);
    const m = sold.get(k) ?? new Map();
    m.set(r.day, Number(r.qty));
    sold.set(k, m);
  }

  const yesterday = addDays(ctx.today, -1);
  return pairRows.map((r) => {
    const start = r.since > from ? r.since : from;
    const days = sold.get(pairKey(r.product_id, r.location_id));
    const history: HistoryPoint[] = [];
    for (let d = start; d <= yesterday; d = addDays(d, 1)) history.push({ ...dayContext(ctx, r.location_id, r.product_id, d), qty: days?.get(d) ?? 0 });
    return { productId: r.product_id, productName: r.product_name, unit: r.unit, locationId: r.location_id, locationName: r.location_name, since: r.since, history };
  });
}

/**
 * Пересчитывает поправку к скорости для всех позиций: во сколько раз ожидаемый спрос на ближайшую неделю
 * отличается от простой средней скорости. Рекомендации, стоп-лист и заказы умножают скорость на эту поправку.
 */
export async function refreshDemandOutlook(deps: Deps): Promise<{ pairs: number; adjusted: number }> {
  const { db } = deps;
  const settings = await getSettings(db);
  const ctx = await loadContext(deps, null, addDays(businessToday(deps), -DEMAND_HISTORY_DAYS), addDays(businessToday(deps), OUTLOOK_DAYS));
  const series = await loadSeries(deps, null, ctx, DEMAND_HISTORY_DAYS);
  const horizon = nextDates(ctx.today, OUTLOOK_DAYS);
  const now = deps.clock();
  const rows: { location_id: string; product_id: string; factor: number; computed_for: string; computed_at: Date }[] = [];
  let adjusted = 0;
  for (const s of series) {
    if (s.history.length < 14) continue;
    const flat = flatLevel(s.history.slice(-settings.forecastWindowDays));
    if (flat <= 0) continue;
    const model = fitDemand(s.history, ALL_FEATURES);
    const factor = outlookFactor(model, horizon.map((d) => dayContext(ctx, s.locationId, s.productId, d)), flat);
    if (Math.abs(factor - 1) > 0.005) adjusted += 1;
    rows.push({ location_id: s.locationId, product_id: s.productId, factor: Math.round(factor * 1000) / 1000, computed_for: ctx.today, computed_at: now });
  }
  for (let from = 0; from < rows.length; from += 500) {
    await db
      .insertInto('demand_outlook')
      .values(rows.slice(from, from + 500))
      .onConflict((oc) => oc.columns(['location_id', 'product_id']).doUpdateSet((eb) => ({ factor: eb.ref('excluded.factor'), computed_for: eb.ref('excluded.computed_for'), computed_at: eb.ref('excluded.computed_at') })))
      .execute();
  }
  accuracyCache.clear();
  return { pairs: rows.length, adjusted };
}

const MIN_OBSERVED = 14;

function tagsFor(model: ReturnType<typeof fitDemand>, d: DayContext, name: string | null): string[] {
  const tags: string[] = [];
  const dow = dayOfWeek(d.date);
  if (d.off) tags.push(name ? `праздник: ${name}` : 'праздничный день');
  else if (dow === 0 || dow === 6) tags.push('выходной');
  if (d.promo && model.used.promo) tags.push('акция');
  if (model.used.weather && d.tMax !== null) {
    if (model.temp !== 0 && d.tMax - model.tempMean >= 5) tags.push('жарче обычного');
    if (model.temp !== 0 && d.tMax - model.tempMean <= -5) tags.push('холоднее обычного');
  }
  if (model.rain !== 0 && d.rain) tags.push('дождь');
  return tags;
}

const pct = (logEffect: number): number => Math.round((Math.exp(logEffect) - 1) * 1000) / 10;

export async function getDemandForecast(deps: Deps, principal: Principal, productId: string, locationId: string, days: number): Promise<DemandForecastDto> {
  assertLocation(principal, locationId);
  const settings = await getSettings(deps.db);
  const today = businessToday(deps);
  const ctx = await loadContext(deps, [locationId], addDays(today, -DEMAND_HISTORY_DAYS), addDays(today, days + 1));
  const [s] = await loadSeries(deps, [locationId], ctx, DEMAND_HISTORY_DAYS, productId);
  if (!s) throw notFound('Продукт на этой точке');

  const model = fitDemand(s.history, ALL_FEATURES);
  const flat = flatLevel(s.history.slice(-settings.forecastWindowDays));
  const future = nextDates(today, days).map((date) => dayContext(ctx, locationId, productId, date));
  const predictions = forecastDays(model, future);
  const forecast: DemandDayDto[] = future.map((d, i) => {
    const p = predictions[i];
    const name = weekdayOff(d.date, ctx.overrides).name;
    return {
      date: d.date,
      qty: Math.round((p?.qty ?? 0) * 1000) / 1000,
      low: Math.round((p?.low ?? 0) * 1000) / 1000,
      high: Math.round((p?.high ?? 0) * 1000) / 1000,
      weekday: round3(p?.factors.weekday ?? 1),
      holiday: round3(p?.factors.holiday ?? 1),
      weather: round3(p?.factors.weather ?? 1),
      promo: round3(p?.factors.promo ?? 1),
      tMax: d.tMax,
      rain: d.rain,
      tags: tagsFor(model, d, name),
    };
  });

  const test = backtestSeries(s.history, 14, DEMAND_HISTORY_DAYS, settings.forecastWindowDays);
  const tail = s.history.slice(-28);
  const weatherDays = [...(ctx.weather.get(locationId)?.keys() ?? [])].length;
  const coords = await deps.db.selectFrom('locations').select(['latitude']).where('id', '=', locationId).executeTakeFirst();
  return {
    productId,
    productName: s.productName,
    unit: s.unit,
    locationId,
    locationName: s.locationName,
    level: round3(model.level),
    flatPerDay: round3(flat),
    observedDays: s.history.length,
    weekday: model.weekday.map(round3),
    confirmed: { ...model.used },
    tempPct: model.used.weather && model.temp !== 0 ? pct(model.temp) : null,
    rainPct: model.used.weather && model.rain !== 0 ? pct(model.rain) : null,
    promoUplift: model.used.promo ? round3(model.promo) : null,
    history: tail.map((h) => ({ date: h.date, qty: round3(h.qty), fitted: round3(predictDay(model, h).qty) })),
    forecast,
    accuracy: test.days > 0 ? { days: test.days, wapeFlat: wape(test.abs.flat, test.actual), wapeModel: wape(test.abs.full, test.actual) } : null,
    weather: { hasCoordinates: coords?.latitude !== null && coords?.latitude !== undefined, days: weatherDays },
  };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

const accuracyCache = new Map<string, { at: number; value: AccuracyDto }>();

/** Забыть сохранённую проверку точности: нужно после перезагрузки данных и в тестах. */
export function resetForecastCache(): void {
  accuracyCache.clear();
}

export async function getAccuracy(deps: Deps, principal: Principal, locationId: string | undefined, testDays: number): Promise<AccuracyDto> {
  const scope = locationFilter(principal, locationId);
  const settings = await getSettings(deps.db);
  const today = businessToday(deps);
  const key = `${scope === null ? '*' : [...scope].sort().join(',')}|${testDays}|${today}`;
  const hit = accuracyCache.get(key);
  if (hit && deps.clock().getTime() - hit.at < ACCURACY_TTL_MS) return hit.value;

  const ctx = await loadContext(deps, scope, addDays(today, -DEMAND_HISTORY_DAYS), today);
  const all = (await loadSeries(deps, scope, ctx, DEMAND_HISTORY_DAYS)).filter((s) => s.history.length >= MIN_OBSERVED + 1);
  const recent = (s: Series) => s.history.slice(-testDays).reduce((sum, h) => sum + h.qty, 0);
  const series = all.sort((a, b) => recent(b) - recent(a)).slice(0, ACCURACY_SERIES_LIMIT);

  const total = { actual: 0, flat: 0, weekday: 0, full: 0, sFlat: 0, sFull: 0 };
  const rows: AccuracyRowDto[] = [];
  let tested = 0;
  let weatherSeries = 0;
  for (const s of series) {
    const r = backtestSeries(s.history, testDays, DEMAND_HISTORY_DAYS, settings.forecastWindowDays);
    if (r.days === 0 || r.actual <= 0) continue;
    tested += 1;
    total.actual += r.actual;
    total.flat += r.abs.flat;
    total.weekday += r.abs.weekday;
    total.full += r.abs.full;
    total.sFlat += r.signed.flat;
    total.sFull += r.signed.full;
    if (fitDemand(s.history, ALL_FEATURES).used.weather) weatherSeries += 1;
    rows.push({ productId: s.productId, productName: s.productName, unit: s.unit, locationId: s.locationId, locationName: s.locationName, volume: round3(r.actual), wapeFlat: wape(r.abs.flat, r.actual), wapeModel: wape(r.abs.full, r.actual) });
  }
  const flat = wape(total.flat, total.actual);
  const model = wape(total.full, total.actual);
  const value: AccuracyDto = {
    days: testDays,
    series: tested,
    wapeFlat: flat,
    wapeWeekday: wape(total.weekday, total.actual),
    wapeModel: model,
    biasFlat: total.actual > 0 ? total.sFlat / total.actual : null,
    biasModel: total.actual > 0 ? total.sFull / total.actual : null,
    improvementPct: flat !== null && model !== null && flat > 0 ? Math.round(((flat - model) / flat) * 1000) / 10 : null,
    weatherSeries,
    rows: rows.sort((a, b) => b.volume - a.volume).slice(0, 15),
    computedAt: deps.clock().toISOString(),
  };
  accuracyCache.set(key, { at: deps.clock().getTime(), value });
  return value;
}

export async function weatherStatus(deps: Deps): Promise<WeatherStatusDto> {
  const locations = await deps.db.selectFrom('locations').select(['id', 'name', 'latitude', 'longitude']).where('is_active', '=', true).orderBy('name').execute();
  const stats = await deps.db
    .selectFrom('weather_daily')
    .select(['location_id', (eb) => eb.fn.countAll<string>().as('days'), sql<string>`count(*) filter (where is_forecast)`.as('forecast'), sql<string>`max(day)`.as('last'), sql<Date>`max(fetched_at)`.as('fetched')])
    .groupBy('location_id')
    .execute();
  const byLoc = new Map(stats.map((s) => [s.location_id, s]));
  return {
    provider: deps.weather ? 'open-meteo' : null,
    locations: locations.map((l) => {
      const s = byLoc.get(l.id);
      return {
        locationId: l.id,
        locationName: l.name,
        hasCoordinates: l.latitude !== null,
        latitude: l.latitude === null ? null : Number(l.latitude),
        longitude: l.longitude === null ? null : Number(l.longitude),
        days: Number(s?.days ?? 0),
        forecastDays: Number(s?.forecast ?? 0),
        lastDate: s?.last ?? null,
        fetchedAt: s?.fetched ? new Date(s.fetched).toISOString() : null,
      };
    }),
  };
}

export async function upcomingOff(deps: Deps, days: number) {
  return upcomingOffDays(businessToday(deps), days, await loadCalendarOverrides(deps.db));
}

/** Точки, погода которых давно не обновлялась: пора идти за новой. */
export async function locationsNeedingWeather(deps: Deps): Promise<boolean> {
  const rows = await deps.db
    .selectFrom('locations as l')
    .leftJoin('weather_daily as w', 'w.location_id', 'l.id')
    .select(['l.id', sql<Date | null>`max(w.fetched_at)`.as('fetched')])
    .where('l.is_active', '=', true)
    .where('l.latitude', 'is not', null)
    .groupBy('l.id')
    .execute();
  const now = deps.clock().getTime();
  return rows.some((r) => !r.fetched || now - new Date(r.fetched).getTime() > WEATHER_STALE_MS);
}

/** Нужно ли пересчитать поправку: сегодня ещё не считали или считали больше часа назад. */
export async function outlookIsStale(deps: Deps): Promise<boolean> {
  const row = await deps.db.selectFrom('demand_outlook').select([sql<string | null>`max(computed_for)`.as('day'), sql<Date | null>`max(computed_at)`.as('at')]).executeTakeFirst();
  if (!row?.day || row.day !== businessToday(deps)) return true;
  return !row.at || deps.clock().getTime() - new Date(row.at).getTime() > 3_600_000;
}

/** Фоновая работа: погода и поправка к скорости. Дешёвые проверки каждую минуту, тяжёлое только когда пора. */
export async function runForecastJobs(deps: Deps): Promise<void> {
  const settings = await getSettings(deps.db);
  if (deps.weather && (await locationsNeedingWeather(deps))) {
    await refreshWeather(deps);
  }
  if (settings.useDemandModel && (await outlookIsStale(deps))) await refreshDemandOutlook(deps);
}

const WORKER_TICK_MS = 60_000;

export function startForecastWorker(deps: Deps): () => void {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    runForecastJobs(deps)
      .catch((err) => deps.log.error({ err }, 'ошибка прогноза спроса'))
      .finally(() => {
        running = false;
      });
  };
  const first = setTimeout(run, 5_000);
  const timer = setInterval(run, WORKER_TICK_MS);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
