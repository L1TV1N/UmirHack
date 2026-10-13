import { isValidGtin } from '@zapas/shared';

const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

/** Рисунок штрихкода EAN-13 или EAN-8 в виде строки из нулей и единиц. Другие форматы и неверная контрольная цифра: null. */
export function eanBits(code: string): { bits: string; kind: 'ean13' | 'ean8' } | null {
  if (!/^\d{8}$|^\d{13}$/.test(code) || !isValidGtin(code)) return null;
  const d = [...code].map(Number);
  if (code.length === 13) {
    const parity = PARITY[d[0] as number] as string;
    let bits = '101';
    for (let i = 1; i <= 6; i += 1) bits += (parity[i - 1] === 'L' ? L : G)[d[i] as number];
    bits += '01010';
    for (let i = 7; i <= 12; i += 1) bits += R[d[i] as number];
    return { bits: `${bits}101`, kind: 'ean13' };
  }
  let bits = '101';
  for (let i = 0; i < 4; i += 1) bits += L[d[i] as number];
  bits += '01010';
  for (let i = 4; i < 8; i += 1) bits += R[d[i] as number];
  return { bits: `${bits}101`, kind: 'ean8' };
}
