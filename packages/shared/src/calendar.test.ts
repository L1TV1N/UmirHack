import { describe, expect, it } from 'vitest';
import { dayOfWeek, holidayName, upcomingOffDays, weekdayOff } from './calendar';

describe('день недели', () => {
  it('0 это воскресенье', () => {
    expect(dayOfWeek('2026-10-04')).toBe(0);
    expect(dayOfWeek('2026-10-09')).toBe(5);
    expect(dayOfWeek('2026-10-10')).toBe(6);
  });
});

describe('праздники', () => {
  it('праздник на будний день это выходной', () => {
    expect(weekdayOff('2026-02-23')).toMatchObject({ off: true, name: 'День защитника Отечества' });
    expect(weekdayOff('2026-06-12').off).toBe(true);
    expect(weekdayOff('2026-11-04')).toMatchObject({ off: true, name: 'День народного единства' });
    expect(weekdayOff('2026-05-01').off).toBe(true);
  });

  it('обычный день и обычные выходные сюда не попадают', () => {
    expect(weekdayOff('2026-10-09').off).toBe(false);
    expect(weekdayOff('2026-10-10').off).toBe(false);
    expect(weekdayOff('2026-10-11').off).toBe(false);
  });

  it('праздник на воскресенье переносится на понедельник, на субботу тоже на понедельник', () => {
    // 8 марта 2026 воскресенье, 9 мая 2026 суббота
    expect(weekdayOff('2026-03-08').off).toBe(false);
    expect(weekdayOff('2026-03-09')).toMatchObject({ off: true, name: 'Международный женский день (перенос)' });
    expect(weekdayOff('2026-05-11').off).toBe(true);
    expect(weekdayOff('2026-05-09').off).toBe(false);
  });

  it('новогодние каникулы 2026: 9 января выходной по переносу, 12 января рабочий, 31 декабря выходной', () => {
    expect(weekdayOff('2026-01-08').off).toBe(true);
    expect(weekdayOff('2026-01-09').off).toBe(true);
    expect(weekdayOff('2026-01-12').off).toBe(false);
    expect(weekdayOff('2026-12-31')).toMatchObject({ off: true });
  });

  it('ручное исправление перекрывает правила и встроенные переносы', () => {
    expect(weekdayOff('2026-10-09', [{ date: '2026-10-09', kind: 'off', note: 'Корпоратив города' }])).toMatchObject({ off: true, name: 'Корпоратив города' });
    expect(weekdayOff('2026-11-04', [{ date: '2026-11-04', kind: 'work' }]).off).toBe(false);
    expect(weekdayOff('2026-12-31', [{ date: '2026-12-31', kind: 'work' }]).off).toBe(false);
  });

  it('выходной вручную на субботе ничего не меняет: её учитывает день недели', () => {
    expect(weekdayOff('2026-10-10', [{ date: '2026-10-10', kind: 'off' }]).off).toBe(false);
  });

  it('название по закону без переносов', () => {
    expect(holidayName('2027-05-09')).toBe('День Победы');
    expect(holidayName('2026-10-09')).toBeNull();
  });

  it('ближайшие выходные будни', () => {
    expect(upcomingOffDays('2026-10-30', 10).map((d) => d.date)).toEqual(['2026-11-04']);
    expect(upcomingOffDays('2026-10-09', 7)).toEqual([]);
  });
});
