import { describe, expect, it } from 'vitest';
import { markCode, markIdentity, normalizeVsd, redeemBody, vsdNumber } from './traceability';

const UUID = '1a2b3c4d-1234-5678-9abc-def012345678';
const GS = '\u001d';

describe('normalizeVsd', () => {
  it('приводит UUID к нижнему регистру и обрезает пробелы', () => {
    expect(normalizeVsd(`  ${UUID.toUpperCase()} `)).toBe(UUID);
  });
  it('не принимает ничего, кроме UUID', () => {
    for (const v of ['', 'abc', UUID.slice(1), `${UUID}0`, UUID.replace('-', '_'), `${UUID}\n${UUID}`, 'ё2b3c4d-1234-5678-9abc-def012345678']) {
      expect(normalizeVsd(v)).toBeNull();
    }
  });
  it('схема zod делает то же и выдаёт понятное сообщение', () => {
    expect(vsdNumber.parse(UUID.toUpperCase())).toBe(UUID);
    const bad = vsdNumber.safeParse('123');
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0]?.message).toContain('UUID');
  });
});

describe('markCode', () => {
  const ok = `0104607000010006${'21'}ABCDEF12345${GS}91EE11${GS}92dGVzdA==`;
  it('принимает код с разделителями GS1', () => {
    expect(markCode.safeParse(ok).success).toBe(true);
  });
  it('отвергает слишком короткие и слишком длинные коды', () => {
    expect(markCode.safeParse('0104607000010006').success).toBe(false);
    expect(markCode.safeParse('x'.repeat(401)).success).toBe(false);
  });
  it('отвергает управляющие и невидимые символы кроме GS', () => {
    for (const bad of ['\u0000', '\u0007', '\n', '\t', '​', '‮', ' ', '\u0085', '﻿']) {
      expect(markCode.safeParse(`${ok}${bad}`).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('redeemBody', () => {
  it('комментарий необязателен и ограничен', () => {
    expect(redeemBody.safeParse({}).success).toBe(true);
    expect(redeemBody.safeParse({ comment: 'x'.repeat(301) }).success).toBe(false);
    expect(redeemBody.safeParse({ comment: 'a‮b' }).success).toBe(false);
    expect(redeemBody.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe('markIdentity', () => {
  it('один и тот же код с разными служебными символами это одна марка', () => {
    const a = `0104607000010006${'21'}ABCDEF12345${GS}91EE11${GS}92dGVzdA==`;
    expect(markIdentity(a)).toBe('04607000010006|ABCDEF12345');
    expect(markIdentity(`${GS}${a}`)).toBe(markIdentity(a));
    expect(markIdentity(`]d2${a}`)).toBe(markIdentity(a));
  });
  it('обычный штрихкод и мусор маркой не считаются', () => {
    expect(markIdentity('4607000010006')).toBeNull();
    expect(markIdentity('что-то')).toBeNull();
  });
});
