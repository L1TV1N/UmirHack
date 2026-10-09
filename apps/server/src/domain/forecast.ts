import { addDays, daysBetween } from '@zapas/shared';

export interface VelocityInput {
  /** Расход по суткам: дата → единицы продукта. */
  outflow: ReadonlyMap<string, number>;
  today: string;
  windowDays: number;
  /** С какого дня позиция вообще есть на точке (первая приёмка). */
  activeSince: string | null;
}

export interface Velocity {
  perDay: number;
  confidence: number;
  daysObserved: number;
}

const RECENT_DAYS = 7;
const FULL_CONFIDENCE_DAYS = 14;

/** Вес суток: последняя неделя считается вдвое важнее остальных. Возраст 0 это вчера. */
export const dayWeight = (age: number): number => (age < RECENT_DAYS ? 2 : 1);

/** Сумма весов за observed суток истории. */
function totalWeight(observed: number): number {
  const recent = Math.min(observed, RECENT_DAYS);
  return recent * 2 + Math.max(0, observed - RECENT_DAYS);
}

/** Сколько суток истории учитываем: от первой приёмки или от начала окна, до вчерашнего дня. */
export function observedDays(today: string, windowDays: number, activeSince: string | null): number {
  if (!activeSince) return 0;
  const windowStart = addDays(today, -windowDays);
  const from = activeSince > windowStart ? activeSince : windowStart;
  return Math.max(0, daysBetween(from, today));
}

/**
 * Скорость по уже посчитанной базой взвешенной сумме расхода (она отдаёт одну строку на позицию,
 * а не одну на каждые сутки, что на больших объёмах в разы быстрее).
 */
export function velocityFromWeightedSum(weightedSum: number, observed: number): Velocity {
  if (observed === 0) return { perDay: 0, confidence: 0, daysObserved: 0 };
  return {
    perDay: weightedSum / totalWeight(observed),
    confidence: Math.min(1, observed / FULL_CONFIDENCE_DAYS),
    daysObserved: observed,
  };
}

/**
 * Скорость расхода в единицах в сутки: взвешенное среднее, где последняя неделя весит вдвое больше.
 * Сегодняшний день не берём, он ещё не закончился. Дни до первой приёмки не считаем нулями.
 */
export function estimateVelocity(input: VelocityInput): Velocity {
  const { outflow, today, windowDays, activeSince } = input;
  const observed = observedDays(today, windowDays, activeSince);
  let weighted = 0;
  for (let age = 0; age < observed; age += 1) {
    weighted += dayWeight(age) * (outflow.get(addDays(today, -(age + 1))) ?? 0);
  }
  return velocityFromWeightedSum(weighted, observed);
}
