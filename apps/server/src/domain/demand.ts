import { addDays, dayOfWeek } from '@zapas/shared';
import { dayWeight } from './forecast';

/**
 * Прогноз спроса на продукт в точке по дням. Модель мультипликативная: спрос в сутки равен уровню, умноженному на
 * поправки: день недели, праздничный будний день, температура, дождь и акция. Все поправки оцениваются по истории
 * продаж этой же позиции и осторожно: если данных мало или эффект не отличим от шума, поправка равна единице.
 * Так прогноз не хуже простого среднего, а там, где закономерность есть, заметно точнее.
 */

export interface DayContext {
  date: string;
  /** Праздничный или перенесённый выходной на будний день. */
  off: boolean;
  /** Максимальная температура за сутки, °C. Нет данных: null. */
  tMax: number | null;
  /** Осадки не меньше миллиметра. Нет данных: null. */
  rain: boolean | null;
  /** На позицию в этот день действует акция. */
  promo: boolean;
}

export interface HistoryPoint extends DayContext {
  qty: number;
}

export interface Features {
  weekday: boolean;
  holiday: boolean;
  weather: boolean;
  promo: boolean;
}

export const ALL_FEATURES: Features = { weekday: true, holiday: true, weather: true, promo: true };
export const NO_FEATURES: Features = { weekday: false, holiday: false, weather: false, promo: false };

export interface DemandModel {
  level: number;
  /** Поправка по дням недели, 0 это воскресенье, среднее равно единице. */
  weekday: number[];
  /** Во сколько раз спрос в праздничный будний день отличается от воскресного. Единица: ведёт себя как воскресенье. */
  offDay: number;
  /** Влияние температуры: логарифм изменения спроса на каждые 10 градусов выше средней за период. */
  temp: number;
  tempMean: number;
  /** Влияние дождя: логарифм изменения спроса в дождливый день против среднего. */
  rain: number;
  rainShare: number;
  /** Во сколько раз спрос в день акции выше обычного. */
  promo: number;
  /** Разброс спроса вокруг модели в долях от уровня. */
  sigma: number;
  observed: number;
  /** Какие поправки участвуют в прогнозе. */
  enabled: Features;
  /** Какие поправки подтверждены историей этой позиции, а не взяты по умолчанию. */
  used: Features;
}

export interface Factors {
  weekday: number;
  holiday: number;
  weather: number;
  promo: number;
}

export interface DayForecast {
  qty: number;
  low: number;
  high: number;
  /** Вклад каждой поправки, 1 означает «не влияет». */
  factors: Factors;
}

/** Данных меньше недели: ни о каких закономерностях говорить нельзя. */
const MIN_FOR_LEVEL = 7;
/** Две недели нужны, чтобы увидеть дни недели. */
const MIN_FOR_WEEKDAY = 14;
const MIN_FOR_WEATHER = 21;
const MIN_PROMO_DAYS = 3;
const WEEKDAY_PRIOR_WEIGHT = 2;
const OFF_PRIOR_WEIGHT = 2;
const PROMO_PRIOR_WEIGHT = 2;
const RIDGE = 3;
/** Поправка принимается, если она минимум вдвое больше своей погрешности. */
const SIGNIFICANCE = 2;
const MAX_LOG_EFFECT = 0.35;
const Z90 = 1.2816;
const MIN_LEVEL = 1e-9;

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length);
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const sumOf = (xs: number[]): number => xs.reduce((s, x) => s + x, 0);

/** Простое взвешенное среднее прошлых суток: так считает скорость остальная система, это точка отсчёта для сравнения. */
export function flatLevel(history: readonly { qty: number }[]): number {
  let weighted = 0;
  let total = 0;
  for (let i = 0; i < history.length; i += 1) {
    const w = dayWeight(history.length - 1 - i);
    weighted += w * (history[i] as { qty: number }).qty;
    total += w;
  }
  return total === 0 ? 0 : weighted / total;
}

interface Params {
  weekday: number[];
  offDay: number;
  temp: number;
  tempMean: number;
  rain: number;
  rainShare: number;
  promo: number;
  enabled: Features;
}

function factorsOf(p: Params, day: DayContext): Factors {
  const off = p.enabled.holiday && day.off;
  const weekday = p.enabled.weekday ? (p.weekday[off ? 0 : dayOfWeek(day.date)] as number) : 1;
  let weather = 1;
  if (p.enabled.weather) {
    if (day.tMax !== null) weather *= Math.exp(p.temp * ((day.tMax - p.tempMean) / 10));
    if (day.rain !== null) weather *= Math.exp(p.rain * ((day.rain ? 1 : 0) - p.rainShare));
  }
  return { weekday, holiday: off ? p.offDay : 1, weather, promo: p.enabled.promo && day.promo ? p.promo : 1 };
}

/** Общий множитель дня. skip исключает поправки: так оценивается одна поправка при остальных известных. */
function multiplier(p: Params, day: DayContext, skip: Partial<Features> = {}): number {
  const f = factorsOf(p, day);
  return (skip.weekday ? 1 : f.weekday) * (skip.holiday ? 1 : f.holiday) * (skip.weather ? 1 : f.weather) * (skip.promo ? 1 : f.promo);
}

function emptyModel(level: number, observed: number): DemandModel {
  return { level, weekday: Array<number>(7).fill(1), offDay: 1, temp: 0, tempMean: 0, rain: 0, rainShare: 0, promo: 1, sigma: 0, observed, enabled: { ...NO_FEATURES }, used: { ...NO_FEATURES } };
}

/** Ридж-регрессия через начало координат с проверкой значимости. Возвращает ноль, если эффект неотличим от шума. */
function ridgeEffect(x: number[], y: number[]): number {
  const sxx = sumOf(x.map((v) => v * v));
  if (sxx <= 0) return 0;
  const beta = sumOf(x.map((v, i) => v * (y[i] as number))) / (sxx + RIDGE);
  const resid = y.map((v, i) => v - beta * (x[i] as number));
  const se = Math.sqrt(sumOf(resid.map((v) => v * v)) / Math.max(x.length - 1, 1)) / Math.sqrt(sxx);
  if (Math.abs(beta) / Math.max(se, 1e-9) < SIGNIFICANCE) return 0;
  return clamp(beta, -MAX_LOG_EFFECT, MAX_LOG_EFFECT);
}

/**
 * Подбирает модель по истории (по возрастанию дат, без пропусков суток, нули тоже записаны). features отключает
 * поправки: так сравниваются варианты модели на одних и тех же данных.
 */
export function fitDemand(history: readonly HistoryPoint[], features: Features = ALL_FEATURES): DemandModel {
  const n = history.length;
  if (n < MIN_FOR_LEVEL) return emptyModel(flatLevel(history), n);

  const weekdayOn = features.weekday && n >= MIN_FOR_WEEKDAY;
  const temps = history.flatMap((h) => (h.tMax === null ? [] : [h.tMax]));
  const weatherOn = features.weather && temps.length >= MIN_FOR_WEATHER;
  const rainKnown = history.filter((h) => h.rain !== null);
  const p: Params = {
    weekday: Array<number>(7).fill(1),
    offDay: 1,
    temp: 0,
    tempMean: weatherOn ? mean(temps) : 0,
    rain: 0,
    rainShare: weatherOn && rainKnown.length > 0 ? rainKnown.filter((h) => h.rain).length / rainKnown.length : 0,
    promo: 1,
    enabled: { weekday: weekdayOn, holiday: features.holiday, weather: weatherOn, promo: features.promo },
  };
  const weight = (i: number) => dayWeight(n - 1 - i);
  const used: Features = { weekday: weekdayOn, holiday: false, weather: false, promo: false };
  let level = flatLevel(history);

  // Поправки зависят друг от друга (праздник и акция в один день), поэтому оцениваем по очереди несколько кругов
  for (let round = 0; round < 3; round += 1) {
    const lvl = Math.max(level, MIN_LEVEL);

    if (weekdayOn) {
      // будни без праздников и акций: они искажают картину дня недели
      const base = history.filter((h) => !h.off && !(features.promo && h.promo));
      const value = (h: HistoryPoint) => h.qty / Math.max(multiplier(p, h, { weekday: true, holiday: true, promo: true }), MIN_LEVEL);
      const overall = mean(base.map(value));
      const factors = Array<number>(7).fill(1);
      if (overall > 0) {
        for (let d = 0; d < 7; d += 1) {
          const rows = base.filter((h) => dayOfWeek(h.date) === d);
          if (rows.length === 0) continue;
          const ratio = mean(rows.map(value)) / overall;
          factors[d] = (rows.length * ratio + WEEKDAY_PRIOR_WEIGHT) / (rows.length + WEEKDAY_PRIOR_WEIGHT);
        }
      }
      const avg = mean(factors);
      for (let d = 0; d < 7; d += 1) p.weekday[d] = (factors[d] as number) / avg;
    }

    if (features.holiday) {
      // по умолчанию праздничный будний день ведёт себя как воскресенье, история лишь поправляет это
      const rows = history.filter((h) => h.off);
      if (rows.length > 0) {
        const sunday = weekdayOn ? (p.weekday[0] as number) : 1;
        const ratio = mean(rows.map((h) => h.qty / Math.max(lvl * sunday * multiplier(p, h, { weekday: true, holiday: true }), MIN_LEVEL)));
        p.offDay = (rows.length * ratio + OFF_PRIOR_WEIGHT) / (rows.length + OFF_PRIOR_WEIGHT);
        used.holiday = true;
      }
    }

    if (weatherOn) {
      const days = history.filter((h) => !h.off && !(features.promo && h.promo));
      const residual = (h: HistoryPoint) => Math.log(clamp(h.qty / Math.max(lvl * (weekdayOn ? (p.weekday[dayOfWeek(h.date)] as number) : 1), MIN_LEVEL), 0.2, 5));
      const withT = days.filter((h) => h.tMax !== null);
      p.temp = ridgeEffect(withT.map((h) => ((h.tMax as number) - p.tempMean) / 10), withT.map(residual));
      const withR = days.filter((h) => h.rain !== null);
      p.rain = ridgeEffect(
        withR.map((h) => (h.rain ? 1 : 0) - p.rainShare),
        withR.map((h) => residual(h) - p.temp * (h.tMax === null ? 0 : (h.tMax - p.tempMean) / 10)),
      );
      used.weather = p.temp !== 0 || p.rain !== 0;
    }

    if (features.promo) {
      const rows = history.filter((h) => h.promo && !h.off);
      p.promo = 1;
      used.promo = false;
      if (rows.length >= MIN_PROMO_DAYS) {
        const ratios = rows.map((h) => h.qty / Math.max(lvl * multiplier(p, h, { promo: true }), MIN_LEVEL));
        const shrunk = (rows.length * mean(ratios) + PROMO_PRIOR_WEIGHT) / (rows.length + PROMO_PRIOR_WEIGHT);
        const logs = ratios.map((v) => Math.log(clamp(v, 0.2, 5)));
        const m = mean(logs);
        const sd = Math.sqrt(sumOf(logs.map((v) => (v - m) ** 2)) / Math.max(logs.length - 1, 1));
        const se = Math.max(sd, 0.05) / Math.sqrt(rows.length);
        if (Math.abs(Math.log(clamp(shrunk, 0.2, 5))) / se >= SIGNIFICANCE) {
          p.promo = clamp(shrunk, 0.5, 3);
          used.promo = true;
        }
      }
    }

    // уровень: отношение сумм, устойчиво к нулевым дням
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i += 1) {
      const h = history[i] as HistoryPoint;
      num += weight(i) * h.qty;
      den += weight(i) * multiplier(p, h);
    }
    level = den > 0 ? num / den : 0;
  }

  let sq = 0;
  let wsum = 0;
  for (let i = 0; i < n; i += 1) {
    const h = history[i] as HistoryPoint;
    const err = h.qty - level * multiplier(p, h);
    sq += weight(i) * err * err;
    wsum += weight(i);
  }

  return {
    level,
    weekday: p.weekday,
    offDay: p.offDay,
    temp: p.temp,
    tempMean: p.tempMean,
    rain: p.rain,
    rainShare: p.rainShare,
    promo: p.promo,
    sigma: level > 0 ? Math.sqrt(sq / wsum) / level : 0,
    observed: n,
    enabled: p.enabled,
    used,
  };
}

function paramsOf(m: DemandModel): Params {
  return { weekday: m.weekday, offDay: m.offDay, temp: m.temp, tempMean: m.tempMean, rain: m.rain, rainShare: m.rainShare, promo: m.promo, enabled: m.enabled };
}

export function predictDay(model: DemandModel, day: DayContext): DayForecast {
  const factors = factorsOf(paramsOf(model), day);
  const qty = Math.max(0, model.level * factors.weekday * factors.holiday * factors.weather * factors.promo);
  const band = Z90 * model.sigma * model.level;
  return { qty, low: Math.max(0, qty - band), high: qty + band, factors };
}

/** Прогноз на ряд суток. */
export function forecastDays(model: DemandModel, days: readonly DayContext[]): DayForecast[] {
  return days.map((d) => predictDay(model, d));
}

/**
 * Поправка к скорости на ближайшие сутки: во сколько раз ожидаемый спрос отличается от того, что дала бы
 * простая средняя скорость. Нужна рекомендациям, стоп-листу и заказам, которые считают по скорости.
 */
export function outlookFactor(model: DemandModel, days: readonly DayContext[], flat: number, bounds: { min: number; max: number } = { min: 0.5, max: 2 }): number {
  if (days.length === 0 || flat <= 0) return 1;
  const expected = forecastDays(model, days).reduce((s, d) => s + d.qty, 0);
  return clamp(expected / (flat * days.length), bounds.min, bounds.max);
}

export type ModelName = 'flat' | 'weekday' | 'full';
export const MODEL_NAMES: readonly ModelName[] = ['flat', 'weekday', 'full'];

export interface BacktestResult {
  /** Сколько суток проверено. */
  days: number;
  actual: number;
  /** Сумма абсолютных ошибок по моделям. */
  abs: Record<ModelName, number>;
  /** Сумма знаковых ошибок (прогноз минус факт). */
  signed: Record<ModelName, number>;
}

const MIN_TRAIN = 14;

/**
 * Проверка на прошлом: для каждых из последних суток модель строится только по тому, что было до них, и
 * прогнозирует эти сутки. Календарь, акции и погода берутся фактические (как будто прогноз погоды точный),
 * поэтому выигрыш от погоды в этой проверке немного оптимистичен.
 */
export function backtestSeries(history: readonly HistoryPoint[], testDays: number, windowDays: number, flatWindowDays: number = windowDays): BacktestResult {
  const out: BacktestResult = { days: 0, actual: 0, abs: { flat: 0, weekday: 0, full: 0 }, signed: { flat: 0, weekday: 0, full: 0 } };
  const first = Math.max(MIN_TRAIN, history.length - testDays);
  for (let i = first; i < history.length; i += 1) {
    const train = history.slice(Math.max(0, i - windowDays), i);
    if (train.length < MIN_TRAIN) continue;
    const day = history[i] as HistoryPoint;
    const predicted: Record<ModelName, number> = {
      flat: flatLevel(train.slice(-flatWindowDays)),
      weekday: predictDay(fitDemand(train, { ...NO_FEATURES, weekday: true }), day).qty,
      full: predictDay(fitDemand(train, ALL_FEATURES), day).qty,
    };
    out.days += 1;
    out.actual += day.qty;
    for (const name of MODEL_NAMES) {
      out.abs[name] += Math.abs(predicted[name] - day.qty);
      out.signed[name] += predicted[name] - day.qty;
    }
  }
  return out;
}

export const wape = (abs: number, actual: number): number | null => (actual > 0 ? abs / actual : null);

/** Даты следующих суток подряд, начиная с from. */
export function nextDates(from: string, days: number): string[] {
  return Array.from({ length: days }, (_, i) => addDays(from, i));
}
