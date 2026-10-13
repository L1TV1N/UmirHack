import { todayIn } from '@zapas/shared';
import type { Deps } from './context';

export function addMilliseconds(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

/** Сколько часов прошло с начала суток по времени бизнеса, дробное число от 0 до 24. */
export function businessHour(deps: Pick<Deps, 'clock' | 'config'>): number {
  const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: deps.config.businessTz }).formatToParts(deps.clock());
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return (part('hour') % 24) + part('minute') / 60;
}

/** Сегодняшняя дата в часовом поясе бизнеса. */
export function businessToday(deps: Pick<Deps, 'clock' | 'config'>): string {
  return todayIn(deps.config.businessTz, deps.clock());
}
