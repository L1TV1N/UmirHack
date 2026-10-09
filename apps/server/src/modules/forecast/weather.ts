import { addDays } from '@zapas/shared';
import { z } from 'zod';
import type { Deps } from '../../lib/context';
import { businessToday } from '../../lib/time';

/** Хост зашит в коде: куда уходят координаты точек нельзя подменить конфигурацией или запросом. */
export const WEATHER_HOST = 'https://api.open-meteo.com';

export interface WeatherDay {
  date: string;
  tMax: number | null;
  tMin: number | null;
  precipMm: number | null;
}

export interface WeatherRequest {
  latitude: number;
  longitude: number;
  timezone: string;
  pastDays: number;
  forecastDays: number;
}

export interface WeatherProvider {
  fetchDaily(request: WeatherRequest): Promise<WeatherDay[]>;
}

const temp = z.number().min(-90).max(60).nullable();
const body = z.object({
  daily: z.object({
    time: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(130),
    temperature_2m_max: z.array(temp).max(130),
    temperature_2m_min: z.array(temp).max(130),
    precipitation_sum: z.array(z.number().min(0).max(1000).nullable()).max(130),
  }),
});

const MAX_BYTES = 300_000;

/** Open-Meteo: бесплатный сервис без ключа. Уходят только широта, долгота и часовой пояс. */
export class OpenMeteoProvider implements WeatherProvider {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async fetchDaily(r: WeatherRequest): Promise<WeatherDay[]> {
    const url = new URL('/v1/forecast', WEATHER_HOST);
    url.searchParams.set('latitude', r.latitude.toFixed(4));
    url.searchParams.set('longitude', r.longitude.toFixed(4));
    url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_sum');
    url.searchParams.set('timezone', r.timezone);
    url.searchParams.set('past_days', String(r.pastDays));
    url.searchParams.set('forecast_days', String(r.forecastDays));
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000), redirect: 'error', headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`Погода: сервис ответил статусом ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_BYTES) throw new Error('Погода: ответ сервиса слишком большой');
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error('Погода: ответ сервиса не принят');
    }
    const parsed = body.safeParse(json);
    if (!parsed.success) throw new Error('Погода: ответ сервиса не принят');
    const d = parsed.data.daily;
    if (d.temperature_2m_max.length !== d.time.length || d.temperature_2m_min.length !== d.time.length || d.precipitation_sum.length !== d.time.length) {
      throw new Error('Погода: ответ сервиса не принят');
    }
    return d.time.map((date, i) => ({ date, tMax: d.temperature_2m_max[i] ?? null, tMin: d.temperature_2m_min[i] ?? null, precipMm: d.precipitation_sum[i] ?? null }));
  }
}

/** Для тестов: отдаёт заготовленные сутки или сбой. */
export class FakeWeatherProvider implements WeatherProvider {
  readonly requests: WeatherRequest[] = [];
  failure: Error | null = null;
  /** Функция строит погоду для запрошенного окна. */
  build: (r: WeatherRequest, today: string) => WeatherDay[] = FakeWeatherProvider.flat;
  today = '2026-10-08';

  /** Ровная погода: двадцать градусов и без осадков. */
  static flat(r: WeatherRequest, today: string): WeatherDay[] {
    return Array.from({ length: r.pastDays + r.forecastDays }, (_, i) => ({ date: addDays(today, i - r.pastDays), tMax: 20, tMin: 12, precipMm: 0 }));
  }

  reset(): void {
    this.requests.length = 0;
    this.failure = null;
    this.build = FakeWeatherProvider.flat;
    this.today = '2026-10-08';
  }

  async fetchDaily(r: WeatherRequest): Promise<WeatherDay[]> {
    this.requests.push(r);
    if (this.failure) throw this.failure;
    return this.build(r, this.today);
  }
}

export interface WeatherRefreshResult {
  locations: number;
  days: number;
  failed: string[];
}

const PAST_DAYS = 92;
const FORECAST_DAYS = 16;
export const WEATHER_STALE_MS = 6 * 3_600_000;

/** Загружает погоду для точек с координатами и сохраняет её по суткам. Сбой одной точки не мешает остальным. */
export async function refreshWeather(deps: Deps, onlyLocationId?: string): Promise<WeatherRefreshResult> {
  const provider = deps.weather;
  const result: WeatherRefreshResult = { locations: 0, days: 0, failed: [] };
  if (!provider) return result;
  const rows = await deps.db
    .selectFrom('locations')
    .select(['id', 'name', 'latitude', 'longitude'])
    .where('is_active', '=', true)
    .where('latitude', 'is not', null)
    .where('longitude', 'is not', null)
    .$if(onlyLocationId !== undefined, (qb) => qb.where('id', '=', onlyLocationId as string))
    .execute();
  const today = businessToday(deps);
  for (const loc of rows) {
    try {
      const days = await provider.fetchDaily({ latitude: Number(loc.latitude), longitude: Number(loc.longitude), timezone: deps.config.businessTz, pastDays: PAST_DAYS, forecastDays: FORECAST_DAYS });
      const now = deps.clock();
      const fresh = days.filter((d) => d.tMax !== null || d.precipMm !== null);
      for (let from = 0; from < fresh.length; from += 200) {
        await deps.db
          .insertInto('weather_daily')
          .values(fresh.slice(from, from + 200).map((d) => ({ location_id: loc.id, day: d.date, t_max: d.tMax, t_min: d.tMin, precip_mm: d.precipMm, is_forecast: d.date >= today, fetched_at: now })))
          .onConflict((oc) => oc.columns(['location_id', 'day']).doUpdateSet((eb) => ({ t_max: eb.ref('excluded.t_max'), t_min: eb.ref('excluded.t_min'), precip_mm: eb.ref('excluded.precip_mm'), is_forecast: eb.ref('excluded.is_forecast'), fetched_at: eb.ref('excluded.fetched_at') })))
          .execute();
      }
      result.locations += 1;
      result.days += fresh.length;
    } catch (err) {
      // подробности (адрес, тело ответа) не пишем: достаточно названия точки
      deps.log.error({ location: loc.name, reason: err instanceof Error ? err.message : 'ошибка' }, 'не удалось загрузить погоду');
      result.failed.push(loc.name);
    }
  }
  return result;
}
