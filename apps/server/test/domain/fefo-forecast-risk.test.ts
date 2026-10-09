import { describe, expect, it } from 'vitest';
import { allocateFefo } from '../../src/domain/fefo';
import { estimateVelocity } from '../../src/domain/forecast';
import { computeBatchRisks } from '../../src/domain/risk';

const batch = (id: string, expiresOn: string, remainingMilli: number, receivedOn = '2026-10-01') => ({
  id,
  expiresOn,
  receivedOn,
  remainingMilli,
});

describe('FEFO', () => {
  it('берёт сначала ближайший срок и переходит к следующей партии', () => {
    const r = allocateFefo(
      [batch('c', '2026-10-20', 5000), batch('a', '2026-10-10', 3000), batch('b', '2026-10-15', 4000)],
      8000,
    );
    expect(r.allocations).toEqual([
      { batchId: 'a', milli: 3000 },
      { batchId: 'b', milli: 4000 },
      { batchId: 'c', milli: 1000 },
    ]);
    expect(r.shortMilli).toBe(0);
  });

  it('при равных сроках берёт более раннюю приёмку', () => {
    const r = allocateFefo(
      [batch('late', '2026-10-10', 1000, '2026-10-05'), batch('early', '2026-10-10', 1000, '2026-10-02')],
      1000,
    );
    expect(r.allocations).toEqual([{ batchId: 'early', milli: 1000 }]);
  });

  it('возвращает нехватку и пропускает пустые партии', () => {
    const r = allocateFefo([batch('a', '2026-10-10', 0), batch('b', '2026-10-11', 2500)], 4000);
    expect(r.allocations).toEqual([{ batchId: 'b', milli: 2500 }]);
    expect(r.shortMilli).toBe(1500);
  });
});

describe('скорость расхода', () => {
  const today = '2026-10-29';

  function series(days: number, qty: number | ((age: number) => number)) {
    const m = new Map<string, number>();
    for (let age = 0; age < days; age += 1) {
      const d = new Date(Date.UTC(2026, 9, 28 - age)).toISOString().slice(0, 10);
      m.set(d, typeof qty === 'number' ? qty : qty(age));
    }
    return m;
  }

  it('ровный расход даёт ту же скорость и полную уверенность', () => {
    const v = estimateVelocity({ outflow: series(28, 5), today, windowDays: 28, activeSince: '2026-09-01' });
    expect(v.perDay).toBeCloseTo(5, 6);
    expect(v.confidence).toBe(1);
    expect(v.daysObserved).toBe(28);
  });

  it('последняя неделя весит больше', () => {
    const v = estimateVelocity({
      outflow: series(28, (age) => (age < 7 ? 10 : 2)),
      today,
      windowDays: 28,
      activeSince: '2026-09-01',
    });
    // без весов было бы 4, с весами (7*2*10 + 21*2) / 35
    expect(v.perDay).toBeCloseTo(5.2, 6);
  });

  it('у новой позиции дни до приёмки не считаются нулями', () => {
    const v = estimateVelocity({ outflow: series(4, 3), today, windowDays: 28, activeSince: '2026-10-25' });
    expect(v.daysObserved).toBe(4);
    expect(v.perDay).toBeCloseTo(3, 6);
    expect(v.confidence).toBeCloseTo(4 / 14, 6);
  });

  it('без истории скорость нулевая', () => {
    expect(estimateVelocity({ outflow: new Map(), today, windowDays: 28, activeSince: null }).perDay).toBe(0);
    expect(estimateVelocity({ outflow: new Map(), today, windowDays: 28, activeSince: today }).confidence).toBe(0);
  });
});

describe('риск по партиям', () => {
  const rb = (id: string, daysLeft: number, remainingMilli: number) => ({
    id,
    daysLeft,
    remainingMilli,
    expiresOn: `2026-11-${String(10 + daysLeft).padStart(2, '0')}`,
    receivedOn: '2026-10-01',
  });

  it('вторая партия получает только остаток возможностей продаж после первой', () => {
    // 2 в сутки: к концу 3-го дня продадим 6, партия 1 из 10 не уйдёт на 4
    const r = computeBatchRisks([rb('a', 2, 10_000), rb('b', 10, 10_000)], 2, 1);
    expect(r.get('a')?.atRiskMilli).toBe(4000);
    // к 11-му дню продаж 22, на партию а ушло бы 10, остаётся 12 >= 10
    expect(r.get('b')?.atRiskMilli).toBe(0);
  });

  it('медленные продажи оставляют под угрозой почти всё', () => {
    const r = computeBatchRisks([rb('a', 1, 10_000)], 0.5, 1);
    expect(r.get('a')?.atRiskMilli).toBe(9000);
  });

  it('просроченная партия целиком потеря и не занимает продажи других', () => {
    const r = computeBatchRisks([rb('old', -1, 3000), rb('new', 1, 4000)], 2, 1);
    expect(r.get('old')).toMatchObject({ atRiskMilli: 3000, basis: 'expired' });
    expect(r.get('new')?.atRiskMilli).toBe(0);
  });

  it('партии с очень далёким сроком не считает рискованными даже при нулевых продажах', () => {
    const r = computeBatchRisks([rb('far', 400, 50_000)], 0, 1);
    expect(r.get('far')?.atRiskMilli).toBe(0);
  });

  it('при малой истории смотрит только на срок', () => {
    const r = computeBatchRisks([rb('a', 2, 5000), rb('b', 9, 5000)], 0, 0.2);
    expect(r.get('a')).toMatchObject({ atRiskMilli: 5000, basis: 'rules' });
    expect(r.get('b')?.atRiskMilli).toBe(0);
  });
});
