import { z } from 'zod';
import type { Unit } from './enums';

export interface WeatherStatusLocationDto {
  locationId: string;
  locationName: string;
  hasCoordinates: boolean;
  latitude: number | null;
  longitude: number | null;
  /** Сколько суток погоды сохранено. */
  days: number;
  /** Сколько из них прогноз на будущее. */
  forecastDays: number;
  lastDate: string | null;
  fetchedAt: string | null;
}

export interface WeatherStatusDto {
  /** Погода берётся из Open-Meteo. null: загрузка отключена на сервере. */
  provider: 'open-meteo' | null;
  locations: WeatherStatusLocationDto[];
}

export interface WeatherRefreshDto {
  locations: number;
  days: number;
  /** Точки, для которых загрузить не удалось (без подробностей). */
  failed: string[];
}

export interface CalendarDayDto {
  date: string;
  kind: 'off' | 'work';
  note: string | null;
  source: 'manual' | 'builtin';
}

export interface UpcomingOffDayDto {
  date: string;
  name: string;
}

export const calendarDayBody = z.strictObject({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата вида 2026-11-04'),
  kind: z.enum(['off', 'work']),
  note: z
    .string()
    .trim()
    .max(120)
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
});
export type CalendarDayBody = z.infer<typeof calendarDayBody>;

export const calendarQuery = z.object({ days: z.coerce.number().int().min(1).max(366).default(60) });

export const demandQuery = z.object({
  productId: z.uuid(),
  locationId: z.uuid(),
  days: z.coerce.number().int().min(1).max(21).default(14),
});

export const accuracyQuery = z.object({
  locationId: z.uuid().optional(),
  /** За сколько последних суток проверять. */
  days: z.coerce.number().int().min(7).max(28).default(14),
});

export interface DemandDayDto {
  date: string;
  /** Ожидаемый спрос за сутки. */
  qty: number;
  low: number;
  high: number;
  /** Поправки к обычному дню: 1 не влияет, 1,3 это плюс 30 процентов. */
  weekday: number;
  holiday: number;
  weather: number;
  promo: number;
  tMax: number | null;
  rain: boolean | null;
  /** Что отличает день: «выходной», «праздник», «жара», «дождь», «акция». */
  tags: string[];
}

export interface DemandForecastDto {
  productId: string;
  productName: string;
  unit: Unit;
  locationId: string;
  locationName: string;
  /** Средний спрос в сутки по модели (уровень). */
  level: number;
  /** Скорость по простому среднему, на которую раньше опирались расчёты. */
  flatPerDay: number;
  observedDays: number;
  /** Поправка по дням недели, 0 это воскресенье. */
  weekday: number[];
  /** Что подтверждено историей именно этой позиции, остальное берётся по умолчанию. */
  confirmed: { weekday: boolean; holiday: boolean; weather: boolean; promo: boolean };
  /** На сколько процентов меняется спрос при росте температуры на 10 градусов. */
  tempPct: number | null;
  rainPct: number | null;
  promoUplift: number | null;
  /** Последние сутки: факт и то, что дала бы модель. */
  history: { date: string; qty: number; fitted: number }[];
  forecast: DemandDayDto[];
  /** Проверка на прошлом по этой позиции. */
  accuracy: { days: number; wapeFlat: number | null; wapeModel: number | null } | null;
  /** Есть ли у точки координаты и сколько суток погоды сохранено. */
  weather: { hasCoordinates: boolean; days: number };
}

export interface AccuracyRowDto {
  productId: string;
  productName: string;
  unit: Unit;
  locationId: string;
  locationName: string;
  /** Продано за проверяемые сутки. */
  volume: number;
  wapeFlat: number | null;
  wapeModel: number | null;
}

export interface AccuracyDto {
  days: number;
  /** Сколько позиций проверено. */
  series: number;
  /** Ошибка (WAPE): сумма абсолютных отклонений к сумме продаж. 0,12 это 12 процентов. */
  wapeFlat: number | null;
  wapeWeekday: number | null;
  wapeModel: number | null;
  /** Смещение: плюс значит завышает, минус занижает. */
  biasFlat: number | null;
  biasModel: number | null;
  /** На сколько процентов ошибка модели меньше ошибки простого среднего. */
  improvementPct: number | null;
  /** Для скольких позиций использованы данные о погоде. */
  weatherSeries: number;
  /** Позиции с наибольшим объёмом продаж и ошибкой обеих моделей. */
  rows: AccuracyRowDto[];
  computedAt: string;
}
