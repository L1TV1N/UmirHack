import { addDays, daysBetween } from '@zapas/shared';

const dayMonth = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const dayMonthYear = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
const dateTime = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const weekday = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });

function parse(iso: string): Date {
  // дата без времени: строим в UTC, чтобы пояс браузера не сдвинул сутки
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`);
}

export function fmtDate(iso: string): string {
  return dayMonthYear.format(parse(iso));
}

export function fmtShortDate(iso: string): string {
  return dayMonth.format(parse(iso)).replace('.', '');
}

export function fmtDateTime(iso: string): string {
  return dateTime.format(new Date(iso)).replace(',', '');
}

export function fmtLongDate(iso: string): string {
  return weekday.format(new Date(iso));
}

export { addDays, daysBetween };

export function todayLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Число из поля ввода: принимает и запятую, и точку, пробелы-разделители. */
export function parseDecimal(value: string): number | null {
  const cleaned = value.replace(/\s/g, '').replace(',', '.');
  if (cleaned === '' || !/^-?\d*\.?\d*$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
