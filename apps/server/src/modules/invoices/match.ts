/**
 * Сопоставление названий из накладной с продуктами. Накладные пишут «Молоко «Простоквашино» 3,2% 0,93л»,
 * а у нас «Молоко 3,2% пастеризованное», поэтому точного равенства мало.
 */
export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"“”„'`()\[\]]/g, ' ')
    .replace(/[^\p{L}\p{N},.%/ -]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP = new Set(['и', 'в', 'на', 'с', 'для', 'по', 'без', 'из', 'от', 'тм', 'ооо', 'гост', 'ту', 'шт', 'кг', 'г', 'л', 'мл', 'уп', 'упак']);

function tokens(value: string): string[] {
  return normalizeName(value)
    .split(/[ /]/)
    .map((t) => t.replace(/^[,.-]+|[,.-]+$/g, ''))
    .filter((t) => t.length > 1 && !STOP.has(t));
}

function bigrams(value: string): Map<string, number> {
  const s = normalizeName(value).replace(/ /g, '_');
  const out = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i += 1) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Коэффициент Сёренсена–Дайса по парам букв: устойчив к перестановкам слов и опечаткам. */
function dice(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  let overlap = 0;
  let total = 0;
  for (const n of x.values()) total += n;
  for (const n of y.values()) total += n;
  if (total === 0) return 0;
  for (const [g, n] of x) overlap += Math.min(n, y.get(g) ?? 0);
  return (2 * overlap) / total;
}

/** Доля слов меньшего названия, которые есть в большем. «Молоко 3,2%» целиком входит в «Молоко 3,2% пастеризованное». */
function containment(a: string, b: string): number {
  const x = tokens(a);
  const y = new Set(tokens(b));
  if (x.length === 0 || y.size === 0) return 0;
  const small = x.length <= y.size ? x : [...y];
  const big = x.length <= y.size ? y : new Set(x);
  return small.filter((t) => big.has(t)).length / small.length;
}

/** От 0 до 1. Полное совпадение слов весит больше похожести букв. */
export function similarity(a: string, b: string): number {
  const d = dice(a, b);
  const c = containment(a, b);
  // слова целиком совпали и их достаточно: это почти точное попадание
  const words = Math.min(tokens(a).length, tokens(b).length);
  return Math.max(d, c >= 1 && words >= 2 ? 0.9 : c * 0.8);
}

/** Ключ запоминания соответствия: код поставщика надёжнее названия. */
export function itemKey(name: string, code: string | null): string {
  return code ? `code:${code.trim().slice(0, 100)}` : `name:${normalizeName(name).slice(0, 190)}`;
}

const LEGAL_FORMS = [
  'общество с ограниченной ответственностью',
  'публичное акционерное общество',
  'акционерное общество',
  'индивидуальный предприниматель',
  'ооо', 'пао', 'зао', 'оао', 'ао', 'ип', 'нпо', 'тд',
];

/** Название поставщика без организационно-правовой формы: «ООО «Донской»» и «Донской» это один поставщик. */
export function normalizeSupplierName(value: string): string {
  let out = normalizeName(value);
  for (const form of LEGAL_FORMS) out = out.replace(new RegExp(`(^| )${form}( |$)`, 'g'), ' ');
  return out.replace(/\s+/g, ' ').trim();
}
