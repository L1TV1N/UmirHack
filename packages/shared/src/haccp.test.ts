import { describe, expect, it } from 'vitest';
import { haccpDue, haccpInspectionBody, haccpPointBody, haccpReadingBody, haccpReadingsQuery, inHaccpRange } from './haccp';

const uuid = '5b3f6a52-5d6e-4f55-9d0b-1f7f8f0f7a11';

describe('границы температуры', () => {
  it('границы включены', () => {
    expect(inHaccpRange(6, 0, 6)).toBe(true);
    expect(inHaccpRange(0, 0, 6)).toBe(true);
    expect(inHaccpRange(6.1, 0, 6)).toBe(false);
    expect(inHaccpRange(-0.1, 0, 6)).toBe(false);
    expect(inHaccpRange(-20, -24, -18)).toBe(true);
  });
});

describe('срок следующего замера', () => {
  const t = (iso: string) => new Date(iso);
  it('отсчитывается от последнего замера', () => {
    const d = haccpDue(4, t('2026-10-10T08:00:00Z'), t('2026-10-01T00:00:00Z'), t('2026-10-10T11:59:00Z'));
    expect(d.dueAt.toISOString()).toBe('2026-10-10T12:00:00.000Z');
    expect(d.overdue).toBe(false);
  });
  it('ровно в срок ещё не просрочен, через минуту просрочен', () => {
    expect(haccpDue(4, t('2026-10-10T08:00:00Z'), t('2026-10-01T00:00:00Z'), t('2026-10-10T12:00:00Z')).overdue).toBe(false);
    expect(haccpDue(4, t('2026-10-10T08:00:00Z'), t('2026-10-01T00:00:00Z'), t('2026-10-10T12:01:00Z')).overdue).toBe(true);
  });
  it('точка без замеров отсчитывается от создания', () => {
    const d = haccpDue(6, null, t('2026-10-10T06:00:00Z'), t('2026-10-10T13:00:00Z'));
    expect(d.dueAt.toISOString()).toBe('2026-10-10T12:00:00.000Z');
    expect(d.overdue).toBe(true);
  });
});

describe('схемы запросов', () => {
  it('точка: границы по порядку, один знак после запятой, частота по умолчанию', () => {
    const ok = haccpPointBody.parse({ locationId: uuid, name: 'Холодильник 1', kind: 'fridge', minTemp: 0, maxTemp: 6 });
    expect(ok.everyHours).toBe(4);
    expect(haccpPointBody.safeParse({ locationId: uuid, name: 'x', kind: 'fridge', minTemp: 7, maxTemp: 6 }).success).toBe(false);
    expect(haccpPointBody.safeParse({ locationId: uuid, name: 'x', kind: 'fridge', minTemp: 0.55, maxTemp: 6 }).success).toBe(false);
    expect(haccpPointBody.safeParse({ locationId: uuid, name: 'x', kind: 'сауна', minTemp: 0, maxTemp: 6 }).success).toBe(false);
    expect(haccpPointBody.safeParse({ locationId: uuid, name: 'x', kind: 'fridge', minTemp: 0, maxTemp: 6, everyHours: 0 }).success).toBe(false);
  });

  it('замер: разумные значения, лишние поля отвергаются', () => {
    expect(haccpReadingBody.safeParse({ pointId: uuid, value: 4.5 }).success).toBe(true);
    expect(haccpReadingBody.safeParse({ pointId: uuid, value: -19 }).success).toBe(true);
    expect(haccpReadingBody.safeParse({ pointId: uuid, value: 1000 }).success).toBe(false);
    expect(haccpReadingBody.safeParse({ pointId: uuid, value: Number.NaN }).success).toBe(false);
    expect(haccpReadingBody.safeParse({ pointId: uuid, value: 4, inRange: true }).success).toBe(false);
  });

  it('бракераж: решение из списка', () => {
    expect(haccpInspectionBody.safeParse({ batchId: uuid, appearanceOk: true, packagingOk: true, decision: 'accepted' }).success).toBe(true);
    expect(haccpInspectionBody.safeParse({ batchId: uuid, appearanceOk: true, packagingOk: true, decision: 'maybe' }).success).toBe(false);
    expect(haccpInspectionBody.safeParse({ batchId: uuid, temperature: 4.2, appearanceOk: false, packagingOk: true, decision: 'rejected' }).success).toBe(true);
  });

  it('запрос журнала: отклонения строкой true или false', () => {
    expect(haccpReadingsQuery.parse({ deviations: 'true' }).deviations).toBe(true);
    expect(haccpReadingsQuery.parse({}).limit).toBe(50);
    expect(haccpReadingsQuery.safeParse({ deviations: 'да' }).success).toBe(false);
    expect(haccpReadingsQuery.safeParse({ from: '12.10.2026' }).success).toBe(false);
  });
});
