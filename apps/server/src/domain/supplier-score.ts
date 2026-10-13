import { FRESHNESS_FULL, SPOILAGE_ZERO_AT, SUPPLIER_SCORE_WEIGHTS, type SupplierScoreDto } from '@zapas/shared';

export interface ScoreInput {
  /** Доли от 0 до 1. null: по этой составляющей за период нет данных. */
  fillRate: number | null;
  onTimeRate: number | null;
  freshness: number | null;
  spoilageRate: number | null;
}

export function gradeOf(score: number): NonNullable<SupplierScoreDto['grade']> {
  return score >= 90 ? 'A' : score >= 80 ? 'B' : 'C';
}

/**
 * Оценка поставщика от 0 до 100: выполнение заказов, соблюдение сроков, свежесть при приёмке и отсутствие порчи.
 * Составляющая без данных не считается нулём: оценка делится на сумму весов тех, что есть.
 */
export function supplierScore(input: ScoreInput): { score: number | null; grade: SupplierScoreDto['grade'] } {
  const w = SUPPLIER_SCORE_WEIGHTS;
  const parts: [number, number | null][] = [
    [w.fill, input.fillRate],
    [w.onTime, input.onTimeRate],
    [w.freshness, input.freshness === null ? null : Math.min(1, input.freshness / FRESHNESS_FULL)],
    [w.quality, input.spoilageRate === null ? null : 1 - Math.min(1, input.spoilageRate / SPOILAGE_ZERO_AT)],
  ];
  let weight = 0;
  let sum = 0;
  for (const [wt, value] of parts) {
    if (value === null) continue;
    weight += wt;
    sum += wt * Math.min(1, Math.max(0, value));
  }
  if (weight === 0) return { score: null, grade: null };
  const score = Math.round((100 * sum) / weight);
  return { score, grade: gradeOf(score) };
}
