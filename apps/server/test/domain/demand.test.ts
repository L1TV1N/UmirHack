import { addDays, dayOfWeek } from '@zapas/shared';
import { describe, expect, it } from 'vitest';
import {
  ALL_FEATURES,
  backtestSeries,
  fitDemand,
  flatLevel,
  forecastDays,
  NO_FEATURES,
  outlookFactor,
  predictDay,
  wape,
  type DayContext,
  type HistoryPoint,
} from '../../src/domain/demand';

function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const START = '2026-06-01'; // понедельник
const WEEK = [1.1, 0.88, 0.92, 1.0, 1.05, 1.22, 1.38]; // 0 = воскресенье, среднее около 1.08
const WEEK_MEAN = WEEK.reduce((s, x) => s + x, 0) / 7;

interface Spec {
  days: number;
  level: number;
  week?: number[];
  noise?: number;
  seed?: number;
  tempEffect?: number; // логарифм на 10 градусов
  rainEffect?: number;
  weather?: boolean;
  offDates?: Record<string, number>; // дата → множитель к воскресенью
  promoDates?: Record<string, number>;
}

/** Синтетический ряд с известными закономерностями. */
function series(spec: Spec): HistoryPoint[] {
  const rand = rng(spec.seed ?? 1);
  const out: HistoryPoint[] = [];
  for (let i = 0; i < spec.days; i += 1) {
    const date = addDays(START, i);
    const dow = dayOfWeek(date);
    const off = spec.offDates !== undefined && date in spec.offDates;
    const tMax = spec.weather ? 20 + 8 * Math.sin(i / 6) + (rand() - 0.5) * 6 : null;
    const rain = spec.weather ? rand() < 0.3 : null;
    let m = spec.week ? (spec.week[off ? 0 : dow] as number) / WEEK_MEAN : 1;
    if (off) m *= (spec.offDates as Record<string, number>)[date] as number;
    if (tMax !== null && spec.tempEffect) m *= Math.exp(spec.tempEffect * ((tMax - 20) / 10));
    if (rain && spec.rainEffect) m *= Math.exp(spec.rainEffect);
    const promo = spec.promoDates !== undefined && date in spec.promoDates;
    if (promo) m *= (spec.promoDates as Record<string, number>)[date] as number;
    const noise = 1 + ((rand() - 0.5) * 2 * (spec.noise ?? 0.1));
    out.push({ date, off, tMax, rain, promo, qty: Math.max(0, spec.level * m * noise) });
  }
  return out;
}

const day = (date: string, over: Partial<DayContext> = {}): DayContext => ({ date, off: false, tMax: null, rain: null, promo: false, ...over });

describe('простая скорость', () => {
  it('последняя неделя весит вдвое больше', () => {
    const h = Array.from({ length: 14 }, (_, i) => ({ qty: i < 7 ? 10 : 20 }));
    // 7 дней по 10 с весом 1 и 7 дней по 20 с весом 2
    expect(flatLevel(h)).toBeCloseTo((70 + 280) / 21, 6);
  });
  it('пустая история даёт ноль', () => {
    expect(flatLevel([])).toBe(0);
  });
});

describe('дни недели', () => {
  it('находит недельную закономерность в шумных данных', () => {
    const m = fitDemand(series({ days: 84, level: 50, week: WEEK, noise: 0.12 }));
    expect(m.used.weekday).toBe(true);
    expect(m.weekday.reduce((s, x) => s + x, 0) / 7).toBeCloseTo(1, 6);
    // осторожная оценка чуть сглаживает крайние дни, поэтому допуск 0,08
    for (let d = 0; d < 7; d += 1) expect(Math.abs((m.weekday[d] as number) - (WEEK[d] as number) / WEEK_MEAN)).toBeLessThan(0.08);
    // суббота заметно выше понедельника
    expect(m.weekday[6]).toBeGreaterThan((m.weekday[1] as number) * 1.4);
    expect(m.level).toBeGreaterThan(46);
    expect(m.level).toBeLessThan(54);
  });

  it('до двух недель истории дни недели не выделяются', () => {
    const m = fitDemand(series({ days: 13, level: 50, week: WEEK }));
    expect(m.used.weekday).toBe(false);
    expect(m.weekday).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it('меньше недели истории: модель только с уровнем', () => {
    const m = fitDemand(series({ days: 5, level: 40 }));
    expect(m.enabled).toEqual(NO_FEATURES);
    expect(m.level).toBeCloseTo(flatLevel(series({ days: 5, level: 40 })), 6);
    expect(predictDay(m, day('2026-06-10')).qty).toBeCloseTo(m.level, 6);
  });

  it('ровные продажи не рождают дней недели: поправки около единицы', () => {
    const m = fitDemand(series({ days: 84, level: 50, noise: 0.08 }));
    for (const f of m.weekday) expect(Math.abs(f - 1)).toBeLessThan(0.08);
  });

  it('нулевые продажи не ломают расчёт', () => {
    const m = fitDemand(Array.from({ length: 30 }, (_, i) => ({ ...day(addDays(START, i)), qty: 0 })));
    expect(m.level).toBe(0);
    expect(predictDay(m, day('2026-07-10')).qty).toBe(0);
    expect(outlookFactor(m, [day('2026-07-10')], 0)).toBe(1);
  });
});

describe('праздничные будни', () => {
  const holiday = '2026-07-15'; // среда
  it('без праздников в истории будний выходной считается воскресеньем', () => {
    const m = fitDemand(series({ days: 84, level: 50, week: WEEK }));
    expect(m.offDay).toBe(1);
    const off = predictDay(m, day(holiday, { off: true }));
    const sunday = predictDay(m, day('2026-07-19'));
    expect(off.qty).toBeCloseTo(sunday.qty, 6);
    expect(off.factors.holiday).toBe(1);
    // а обычная среда ниже воскресенья
    expect(predictDay(m, day(holiday)).qty).toBeLessThan(off.qty);
  });

  it('история праздников поправляет воскресную догадку, но не больше чем позволяет число примеров', () => {
    const offs = { '2026-06-24': 0.5, '2026-07-01': 0.5, '2026-07-08': 0.5, '2026-07-15': 0.5 };
    const m = fitDemand(series({ days: 84, level: 50, week: WEEK, offDates: offs, noise: 0.05 }));
    expect(m.used.holiday).toBe(true);
    // истинное 0.5, четыре примера и два «весовых» приора: между 0.5 и 1, ближе к 0.5
    expect(m.offDay).toBeLessThan(0.75);
    expect(m.offDay).toBeGreaterThan(0.5);
    const lone = fitDemand(series({ days: 84, level: 50, week: WEEK, offDates: { '2026-07-15': 0.5 }, noise: 0.05 }));
    expect(lone.offDay).toBeGreaterThan(m.offDay);
  });

  it('праздничные дни не портят оценку обычных дней недели', () => {
    const offs = { '2026-06-24': 0.4, '2026-07-01': 0.4, '2026-07-08': 0.4, '2026-07-15': 0.4 };
    const m = fitDemand(series({ days: 84, level: 50, week: WEEK, offDates: offs, noise: 0.05 }));
    expect(m.weekday[3]).toBeCloseTo((WEEK[3] as number) / WEEK_MEAN, 1);
  });
});

describe('погода', () => {
  it('находит рост спроса в жару и отличает дождь', () => {
    const m = fitDemand(series({ days: 84, level: 50, week: WEEK, weather: true, tempEffect: 0.2, rainEffect: -0.15, noise: 0.05, seed: 7 }));
    expect(m.used.weather).toBe(true);
    expect(m.temp).toBeGreaterThan(0.12);
    expect(m.temp).toBeLessThan(0.28);
    expect(m.rain).toBeLessThan(-0.05);
    const hot = predictDay(m, day('2026-08-24', { tMax: m.tempMean + 8, rain: false }));
    const cold = predictDay(m, day('2026-08-24', { tMax: m.tempMean - 8, rain: false }));
    // истинный рост на 16 градусов около 38 процентов, осторожная оценка чуть ниже
    expect(hot.qty).toBeGreaterThan(cold.qty * 1.2);
    expect(hot.factors.weather).toBeGreaterThan(1);
    expect(cold.factors.weather).toBeLessThan(1);
  });

  it('если погода на продажи не влияет, поправка не выдумывается', () => {
    let used = 0;
    for (let seed = 1; seed <= 12; seed += 1) {
      const m = fitDemand(series({ days: 84, level: 50, week: WEEK, weather: true, noise: 0.1, seed }));
      if (m.used.weather) used += 1;
      expect(Math.abs(m.temp)).toBeLessThanOrEqual(0.12);
    }
    // порог значимости двойной, ложные срабатывания редки
    expect(used).toBeLessThanOrEqual(3);
  });

  it('без данных о погоде или с малым числом дней погода не используется', () => {
    expect(fitDemand(series({ days: 60, level: 50, week: WEEK })).enabled.weather).toBe(false);
    const short = series({ days: 40, level: 50, weather: true }).map((h, i) => (i < 25 ? { ...h, tMax: null, rain: null } : h));
    expect(fitDemand(short).enabled.weather).toBe(false);
  });

  it('прогноз без температуры на день не меняется от погодной поправки', () => {
    const m = fitDemand(series({ days: 84, level: 50, week: WEEK, weather: true, tempEffect: 0.2, noise: 0.05, seed: 7 }));
    const a = predictDay(m, day('2026-08-24'));
    expect(a.factors.weather).toBe(1);
  });
});

describe('акции', () => {
  it('находит прирост по нескольким акционным дням', () => {
    const promos: Record<string, number> = {};
    for (const d of ['2026-06-10', '2026-06-11', '2026-06-12', '2026-07-01', '2026-07-02', '2026-07-03', '2026-07-20', '2026-07-21']) promos[d] = 1.6;
    const m = fitDemand(series({ days: 84, level: 50, week: WEEK, promoDates: promos, noise: 0.06, seed: 3 }));
    expect(m.used.promo).toBe(true);
    expect(m.promo).toBeGreaterThan(1.35);
    expect(m.promo).toBeLessThan(1.75);
    const plain = predictDay(m, day('2026-08-26'));
    const promo = predictDay(m, day('2026-08-26', { promo: true }));
    expect(promo.qty / plain.qty).toBeCloseTo(m.promo, 6);
    expect(promo.factors.promo).toBe(m.promo);
  });

  it('одна-две акции эффекта не доказывают', () => {
    const m = fitDemand(series({ days: 84, level: 50, week: WEEK, promoDates: { '2026-07-01': 3, '2026-07-02': 3 }, noise: 0.05 }));
    expect(m.used.promo).toBe(false);
    expect(m.promo).toBe(1);
  });

  it('акции без эффекта не дают прироста', () => {
    const promos: Record<string, number> = {};
    for (const d of ['2026-06-10', '2026-06-11', '2026-06-12', '2026-07-01', '2026-07-02', '2026-07-03']) promos[d] = 1;
    const m = fitDemand(series({ days: 84, level: 50, week: WEEK, promoDates: promos, noise: 0.08, seed: 5 }));
    expect(m.promo).toBeLessThanOrEqual(1.15);
  });
});

describe('прогноз и интервал', () => {
  it('интервал охватывает прогноз и не уходит ниже нуля', () => {
    const m = fitDemand(series({ days: 84, level: 50, week: WEEK, noise: 0.2 }));
    for (const f of forecastDays(m, Array.from({ length: 14 }, (_, i) => day(addDays('2026-08-25', i))))) {
      expect(f.low).toBeLessThanOrEqual(f.qty);
      expect(f.qty).toBeLessThanOrEqual(f.high);
      expect(f.low).toBeGreaterThanOrEqual(0);
    }
    expect(m.sigma).toBeGreaterThan(0.05);
  });

  it('множитель на неделю вперёд около единицы: уровень уже учитывает все дни недели', () => {
    const m = fitDemand(series({ days: 84, level: 50, week: WEEK, noise: 0.05 }));
    const next = Array.from({ length: 7 }, (_, i) => day(addDays('2026-08-24', i)));
    expect(outlookFactor(m, next, flatLevel(series({ days: 84, level: 50, week: WEEK, noise: 0.05 })))).toBeGreaterThan(0.93);
    expect(outlookFactor(m, next, flatLevel(series({ days: 84, level: 50, week: WEEK, noise: 0.05 })))).toBeLessThan(1.07);
  });

  it('горизонт из выходных даёт множитель выше единицы, из будней ниже', () => {
    const h = series({ days: 84, level: 50, week: WEEK, noise: 0.05 });
    const m = fitDemand(h);
    const flat = flatLevel(h);
    const weekend = [day('2026-08-29'), day('2026-08-30')]; // сб, вс
    const midweek = [day('2026-08-25'), day('2026-08-26')]; // вт, ср
    expect(outlookFactor(m, weekend, flat)).toBeGreaterThan(1.1);
    expect(outlookFactor(m, midweek, flat)).toBeLessThan(0.95);
  });

  it('множитель ограничен, а без скорости равен единице', () => {
    const m = fitDemand(series({ days: 84, level: 50, week: WEEK }));
    expect(outlookFactor(m, [day('2026-08-29')], 1)).toBe(2);
    expect(outlookFactor(m, [day('2026-08-29')], 1e9)).toBe(0.5);
    expect(outlookFactor(m, [], 10)).toBe(1);
    expect(outlookFactor(m, [day('2026-08-29')], 0)).toBe(1);
  });
});

describe('проверка на прошлом', () => {
  const run = (h: HistoryPoint[]) => backtestSeries(h, 14, 84);

  it('модель с днями недели точнее простого среднего там, где неделя выражена', () => {
    const r = run(series({ days: 98, level: 50, week: WEEK, noise: 0.08, seed: 11 }));
    expect(r.days).toBe(14);
    const flat = wape(r.abs.flat, r.actual) as number;
    const model = wape(r.abs.full, r.actual) as number;
    expect(model).toBeLessThan(flat * 0.8);
    expect(wape(r.abs.weekday, r.actual) as number).toBeLessThan(flat);
  });

  it('на ровных продажах модель не хуже среднего заметно', () => {
    const r = run(series({ days: 98, level: 50, noise: 0.1, seed: 4 }));
    expect(wape(r.abs.full, r.actual) as number).toBeLessThan((wape(r.abs.flat, r.actual) as number) * 1.1);
  });

  it('погода и акции улучшают прогноз, когда они действительно влияют', () => {
    const promos: Record<string, number> = {};
    for (let i = 0; i < 98; i += 7) promos[addDays(START, i + 2)] = 1.7;
    const h = series({ days: 126, level: 50, week: WEEK, weather: true, tempEffect: 0.25, promoDates: promos, noise: 0.05, seed: 9 });
    const r = backtestSeries(h, 21, 105);
    expect(wape(r.abs.full, r.actual) as number).toBeLessThan((wape(r.abs.weekday, r.actual) as number) * 0.9);
  });

  it('короткая история не проверяется, а отчёт честный о числе суток', () => {
    expect(run(series({ days: 14, level: 50 })).days).toBe(0);
    expect(run(series({ days: 20, level: 50 })).days).toBe(6);
  });

  it('смещение считается со знаком: завышение положительное', () => {
    const rising = series({ days: 70, level: 50 }).map((h, i) => ({ ...h, qty: 20 + i * 1.5 }));
    const r = run(rising);
    // продажи растут, среднее отстаёт: прогноз занижает
    expect(r.signed.flat).toBeLessThan(0);
  });

  it('WAPE при нулевых продажах не определён', () => {
    expect(wape(5, 0)).toBeNull();
    expect(wape(5, 50)).toBeCloseTo(0.1, 6);
  });

  it('все возможности включены по умолчанию', () => {
    expect(ALL_FEATURES).toEqual({ weekday: true, holiday: true, weather: true, promo: true });
  });
});
