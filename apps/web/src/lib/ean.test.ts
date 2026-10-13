import { describe, expect, it } from 'vitest';
import { eanBits } from './ean';

describe('штрихкод EAN', () => {
  it('EAN-13 занимает 95 модулей и начинается и заканчивается ограничителем', () => {
    const r = eanBits('4006381333931');
    expect(r?.kind).toBe('ean13');
    expect(r?.bits).toHaveLength(95);
    expect(r?.bits.startsWith('101')).toBe(true);
    expect(r?.bits.endsWith('101')).toBe(true);
    expect(r?.bits.slice(45, 50)).toBe('01010');
  });

  it('известный образец даёт известный рисунок первой цифры после ограничителя', () => {
    // 4 = LGLLGG: вторая цифра (0) кодируется набором L, третья (0) набором G
    expect(eanBits('4006381333931')?.bits.slice(3, 10)).toBe('0001101');
  });

  it('EAN-8 занимает 67 модулей', () => {
    expect(eanBits('96385074')?.bits).toHaveLength(67);
  });

  it('неверная контрольная цифра и чужая длина не рисуются', () => {
    expect(eanBits('4006381333932')).toBeNull();
    expect(eanBits('12345')).toBeNull();
    expect(eanBits('abcdefghijklm')).toBeNull();
  });
});
