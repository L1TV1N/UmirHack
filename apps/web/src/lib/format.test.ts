import { describe, expect, it } from 'vitest';
import { toQuery } from '../api/client';
import { fmtDate, fmtShortDate, parseDecimal } from './format';

describe('parseDecimal', () => {
  it('понимает запятую и точку', () => {
    expect(parseDecimal('12,5')).toBe(12.5);
    expect(parseDecimal('12.5')).toBe(12.5);
    expect(parseDecimal(' 1 250,75 ')).toBe(1250.75);
  });

  it('отвергает мусор и пустую строку', () => {
    expect(parseDecimal('')).toBeNull();
    expect(parseDecimal('abc')).toBeNull();
    expect(parseDecimal('1,2,3')).toBeNull();
    expect(parseDecimal('1e3')).toBeNull();
  });
});

describe('даты', () => {
  it('не сдвигает сутки из-за часового пояса', () => {
    expect(fmtDate('2026-10-08')).toBe('08.10.2026');
    expect(fmtShortDate('2026-01-01')).toMatch(/^1 янв/);
  });
});

describe('toQuery', () => {
  it('пропускает пустые значения и кодирует остальные', () => {
    expect(toQuery({ q: 'сыр & масло', limit: 50, locationId: undefined, flag: '', active: false })).toBe(
      '?q=%D1%81%D1%8B%D1%80+%26+%D0%BC%D0%B0%D1%81%D0%BB%D0%BE&limit=50&active=false',
    );
    expect(toQuery({})).toBe('');
  });
});
