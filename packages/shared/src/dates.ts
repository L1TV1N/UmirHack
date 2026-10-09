import type { ExpiryStatus } from './enums';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function toDayNumber(iso: string): number {
  const m = ISO_DATE.exec(iso);
  if (!m) throw new Error(`Некорректная дата: ${iso}`);
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}

function fromDayNumber(n: number): string {
  return new Date(n * 86_400_000).toISOString().slice(0, 10);
}

/** Сколько суток от первой даты до второй (может быть отрицательным). */
export function daysBetween(fromIso: string, toIso: string): number {
  return toDayNumber(toIso) - toDayNumber(fromIso);
}

export function addDays(iso: string, days: number): string {
  return fromDayNumber(toDayNumber(iso) + days);
}

/** Текущая календарная дата в часовом поясе бизнеса. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return parts;
}

export interface ExpiryThresholds {
  criticalDays: number;
  expiringSoonDays: number;
}

export const DEFAULT_EXPIRY_THRESHOLDS: ExpiryThresholds = {
  criticalDays: 1,
  expiringSoonDays: 3,
};

export function expiryStatus(daysLeft: number, t: ExpiryThresholds = DEFAULT_EXPIRY_THRESHOLDS): ExpiryStatus {
  if (daysLeft < 0) return 'expired';
  if (daysLeft <= t.criticalDays) return 'critical';
  if (daysLeft <= t.expiringSoonDays) return 'soon';
  return 'ok';
}
