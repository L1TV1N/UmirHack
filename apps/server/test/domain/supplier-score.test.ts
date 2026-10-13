import { SUPPLIER_SCORE_WEIGHTS } from '@zapas/shared';
import { describe, expect, it } from 'vitest';
import { gradeOf, supplierScore } from '../../src/domain/supplier-score';

describe('оценка поставщика', () => {
  it('идеальный поставщик получает сто баллов и оценку A', () => {
    expect(supplierScore({ fillRate: 1, onTimeRate: 1, freshness: 0.9, spoilageRate: 0 })).toEqual({ score: 100, grade: 'A' });
  });

  it('веса составляющих в сумме дают единицу', () => {
    const sum = Object.values(SUPPLIER_SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it('каждая составляющая тянет оценку вниз пропорционально своему весу', () => {
    const base = { fillRate: 1, onTimeRate: 1, freshness: 0.9, spoilageRate: 0 };
    expect(supplierScore({ ...base, fillRate: 0 }).score).toBe(65);
    expect(supplierScore({ ...base, onTimeRate: 0 }).score).toBe(75);
    expect(supplierScore({ ...base, freshness: 0 }).score).toBe(80);
    expect(supplierScore({ ...base, spoilageRate: 0.05 }).score).toBe(80);
  });

  it('свежесть выше порога полной оценки не даёт больше, чем порог', () => {
    const a = supplierScore({ fillRate: 1, onTimeRate: 1, freshness: 0.8, spoilageRate: 0 });
    const b = supplierScore({ fillRate: 1, onTimeRate: 1, freshness: 1, spoilageRate: 0 });
    expect(a.score).toBe(b.score);
  });

  it('порча сверх допустимой доли не уводит оценку качества ниже нуля', () => {
    const worst = supplierScore({ fillRate: 1, onTimeRate: 1, freshness: 0.9, spoilageRate: 0.5 });
    const edge = supplierScore({ fillRate: 1, onTimeRate: 1, freshness: 0.9, spoilageRate: 0.05 });
    expect(worst.score).toBe(edge.score);
  });

  it('нет данных по составляющей: она не считается нулём', () => {
    expect(supplierScore({ fillRate: null, onTimeRate: null, freshness: 0.8, spoilageRate: 0 })).toEqual({ score: 100, grade: 'A' });
    expect(supplierScore({ fillRate: 0.5, onTimeRate: null, freshness: null, spoilageRate: null })).toEqual({ score: 50, grade: 'C' });
    expect(supplierScore({ fillRate: null, onTimeRate: null, freshness: null, spoilageRate: null })).toEqual({ score: null, grade: null });
  });

  it('границы оценок', () => {
    expect(gradeOf(100)).toBe('A');
    expect(gradeOf(90)).toBe('A');
    expect(gradeOf(89)).toBe('B');
    expect(gradeOf(80)).toBe('B');
    expect(gradeOf(79)).toBe('C');
    expect(gradeOf(0)).toBe('C');
  });
});
