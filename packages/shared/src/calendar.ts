import { addDays } from './dates';

/** Праздничные дни по закону (день и месяц). Первые восемь это новогодние каникулы и Рождество. */
const FIXED_HOLIDAYS: Record<string, string> = {
  '01-01': 'Новый год',
  '01-02': 'Новогодние каникулы',
  '01-03': 'Новогодние каникулы',
  '01-04': 'Новогодние каникулы',
  '01-05': 'Новогодние каникулы',
  '01-06': 'Новогодние каникулы',
  '01-07': 'Рождество',
  '01-08': 'Новогодние каникулы',
  '02-23': 'День защитника Отечества',
  '03-08': 'Международный женский день',
  '05-01': 'Праздник Весны и Труда',
  '05-09': 'День Победы',
  '06-12': 'День России',
  '11-04': 'День народного единства',
};

export interface CalendarOverride {
  date: string;
  /** off: выходной вопреки правилам (перенос), work: рабочий вопреки правилам. */
  kind: 'off' | 'work';
  note?: string | null;
}

/**
 * Переносы, которые правительство утверждает постановлением. Остальные годы считаются по правилам ст. 112 ТК РФ
 * (праздник на выходной переносится на следующий рабочий день), а исправления вносятся вручную в разделе «Календарь».
 * 2026: каникулы 1–11 января, 31 декабря выходной, 12 января рабочий.
 */
export const BUILTIN_OVERRIDES: readonly CalendarOverride[] = [
  { date: '2026-01-12', kind: 'work', note: 'Перенос выходного на 31 декабря' },
  { date: '2026-12-31', kind: 'off', note: 'Перенос выходного с 4 января' },
];

/** День недели: 0 это воскресенье. */
export function dayOfWeek(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

export const isWeekend = (date: string): boolean => {
  const d = dayOfWeek(date);
  return d === 0 || d === 6;
};

const monthDay = (date: string) => date.slice(5);

/** Название праздника, если дата праздничная по закону (без переносов). */
export function holidayName(date: string): string | null {
  return FIXED_HOLIDAYS[monthDay(date)] ?? null;
}

function yearHolidays(year: number): Map<string, string> {
  const result = new Map<string, string>();
  for (const [md, name] of Object.entries(FIXED_HOLIDAYS)) result.set(`${year}-${md}`, name);
  // праздник на выходной переносится на ближайший следующий рабочий день (ст. 112 ТК РФ)
  for (const [date, name] of [...result]) {
    if (!isWeekend(date)) continue;
    let moved = addDays(date, 1);
    while (isWeekend(moved) || result.has(moved)) moved = addDays(moved, 1);
    result.set(moved, `${name} (перенос)`);
  }
  return result;
}

const cache = new Map<number, Map<string, string>>();
function holidaysOf(year: number): Map<string, string> {
  let m = cache.get(year);
  if (!m) {
    m = yearHolidays(year);
    cache.set(year, m);
  }
  return m;
}

export interface DayOff {
  /** Нерабочий день, который выпал на будний: такие дни ведут себя иначе обычных будней. */
  off: boolean;
  name: string | null;
}

/**
 * Праздничный или перенесённый выходной на будний день. Субботы и воскресенья сюда не входят: их учитывает день недели.
 * Ручные исправления перекрывают встроенные, встроенные перекрывают правила.
 */
export function weekdayOff(date: string, overrides: readonly CalendarOverride[] = []): DayOff {
  const manual = overrides.find((o) => o.date === date);
  const builtin = BUILTIN_OVERRIDES.find((o) => o.date === date);
  const rule = holidaysOf(Number(date.slice(0, 4))).get(date) ?? null;
  const decided = manual ?? builtin;
  const weekday = !isWeekend(date);
  if (decided) return { off: weekday && decided.kind === 'off', name: decided.kind === 'off' ? (decided.note ?? rule ?? 'Выходной') : null };
  return { off: weekday && rule !== null, name: weekday ? rule : null };
}

/** Ближайшие нерабочие будни на заданное число суток вперёд: для подсказок в интерфейсе. */
export function upcomingOffDays(from: string, days: number, overrides: readonly CalendarOverride[] = []): { date: string; name: string }[] {
  const out: { date: string; name: string }[] = [];
  for (let i = 0; i < days; i += 1) {
    const date = addDays(from, i);
    const d = weekdayOff(date, overrides);
    if (d.off) out.push({ date, name: d.name ?? 'Выходной' });
  }
  return out;
}
