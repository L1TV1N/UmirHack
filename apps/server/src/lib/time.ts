import { todayIn } from '@zapas/shared';
import type { Deps } from './context';

export function addMilliseconds(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

/** Сегодняшняя дата в часовом поясе бизнеса. */
export function businessToday(deps: Pick<Deps, 'clock' | 'config'>): string {
  return todayIn(deps.config.businessTz, deps.clock());
}
