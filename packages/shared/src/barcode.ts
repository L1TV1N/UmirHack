/**
 * Разбор отсканированных кодов: обычные штрихкоды (EAN, UPC) и коды GS1 (DataMatrix «Честного знака»,
 * GS1-128). Нужны GTIN для поиска продукта и, если они есть в коде, срок годности и партия.
 */

export interface ScanResult {
  /** gtin: обычный штрихкод товара, gs1: код со служебными полями, code: иное (внутренний код, QR). */
  kind: 'gtin' | 'gs1' | 'code';
  /** Исходный текст без служебного префикса сканера. */
  raw: string;
  /** GTIN-14 (с ведущими нулями), если он есть в коде. */
  gtin: string | null;
  /** Ключ для поиска продукта: цифры штрихкода, дополненные нулями до 14 знаков. */
  key: string | null;
  /** Срок годности из кода (поле 17, а при его отсутствии поле 15), ГГГГ-ММ-ДД. */
  expiresOn: string | null;
  batch: string | null;
  serial: string | null;
  /** В коде есть серийный номер или криптохвост: это марка «Честного знака», а не просто штрихкод. */
  marked: boolean;
}

/** Разделитель полей переменной длины в GS1 (FNC1). */
const GS = '\u001d';

/** Контрольная цифра GS1 по остальным цифрам (для EAN-8, UPC-A, EAN-13, GTIN-14). */
export function gtinCheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    const digit = body.charCodeAt(body.length - 1 - i) - 48;
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidGtin(code: string): boolean {
  if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
  return gtinCheckDigit(code.slice(0, -1)) === code.charCodeAt(code.length - 1) - 48;
}

/** Ключ поиска: цифры от 8 до 14 знаков, выровненные нулями слева. EAN-13, UPC-A и GTIN-14 одного товара совпадают. */
export function canonicalBarcode(code: string): string | null {
  return /^\d{8,14}$/.test(code) ? code.padStart(14, '0') : null;
}

// Длины полей GS1. Число: фиксированная длина, объект: переменная, не длиннее max.
const FIXED: Record<string, number> = {
  '00': 18, '01': 14, '02': 14, '11': 6, '12': 6, '13': 6, '15': 6, '16': 6, '17': 6, '20': 2,
  '410': 13, '411': 13, '412': 13, '413': 13, '414': 13, '415': 13, '416': 13, '417': 13, '422': 3, '7001': 13, '7003': 10,
};
const VARIABLE: Record<string, number> = {
  '10': 20, '21': 20, '22': 20, '30': 8, '37': 8, '240': 30, '241': 30, '242': 6, '250': 30, '251': 30,
  '253': 30, '254': 20, '400': 30, '401': 30, '402': 17, '403': 30, '420': 20, '421': 12, '7002': 30, '7004': 4, '7005': 12, '8003': 30, '8004': 30,
};
for (let n = 91; n <= 99; n += 1) VARIABLE[String(n)] = 90;
// 3100–3699: меры (вес, объём) шестью цифрами
for (let a = 3100; a <= 3699; a += 1) FIXED[String(a)] = 6;

function readFields(text: string): Map<string, string> {
  const fields = new Map<string, string>();

  // человекочитаемая запись: (01)04607...(17)261231(10)A1
  if (text.includes('(')) {
    for (const m of text.matchAll(/\((\d{2,4})\)([^(]*)/g)) {
      if (!fields.has(m[1] as string)) fields.set(m[1] as string, (m[2] as string).replace(new RegExp(GS, 'g'), '').trim());
    }
    return fields;
  }

  let pos = 0;
  while (pos < text.length) {
    if (text[pos] === GS) {
      pos += 1;
      continue;
    }
    let ai: string | null = null;
    for (const len of [2, 3, 4]) {
      const candidate = text.slice(pos, pos + len);
      if (candidate.length === len && (candidate in FIXED || candidate in VARIABLE)) {
        ai = candidate;
        break;
      }
    }
    if (!ai) break;
    pos += ai.length;
    const fixed = FIXED[ai];
    if (fixed !== undefined) {
      const value = text.slice(pos, pos + fixed);
      if (value.length < fixed) break;
      fields.set(ai, value);
      pos += fixed;
    } else {
      const max = VARIABLE[ai] as number;
      let end = text.indexOf(GS, pos);
      if (end === -1 || end - pos > max) end = Math.min(text.length, pos + max);
      fields.set(ai, text.slice(pos, end));
      pos = end;
    }
  }
  return fields;
}

/** ГГММДД из GS1 в ГГГГ-ММ-ДД. День 00 означает последний день месяца. */
export function gs1Date(value: string): string | null {
  if (!/^\d{6}$/.test(value)) return null;
  const year = 2000 + Number(value.slice(0, 2));
  const month = Number(value.slice(2, 4));
  let day = Number(value.slice(4, 6));
  if (month < 1 || month > 12) return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day === 0) day = last;
  if (day > last) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const SYMBOLOGY_PREFIX = /^\][A-Za-z][0-9A-Za-z]/;

export function parseScan(input: string): ScanResult {
  // ZXing и часть сканеров начинают код GS1 с разделителя FNC1: он не часть данных
  const raw = input.trim().replace(SYMBOLOGY_PREFIX, '').replace(/^\u001d+/, '').trim();
  const empty: ScanResult = { kind: 'code', raw, gtin: null, key: null, expiresOn: null, batch: null, serial: null, marked: false };
  if (!raw) return empty;

  // обычный штрихкод: только цифры
  if (/^\d+$/.test(raw) && !(raw.length >= 16 && raw.startsWith('01'))) {
    const key = canonicalBarcode(raw);
    return { ...empty, kind: key && isValidGtin(raw) ? 'gtin' : 'code', gtin: key && isValidGtin(raw) ? key : null, key };
  }

  const looksLikeGs1 = raw.includes('(01)') || /^01\d{14}/.test(raw);
  if (!looksLikeGs1) return empty;

  const fields = readFields(raw);
  const gtin = fields.get('01') ?? null;
  const valid = gtin !== null && /^\d{14}$/.test(gtin);
  const expiresOn = gs1Date(fields.get('17') ?? '') ?? gs1Date(fields.get('15') ?? '');
  const serial = fields.get('21') || null;
  const marked = serial !== null || ['91', '92', '93'].some((ai) => fields.has(ai));
  return {
    kind: valid ? 'gs1' : 'code',
    raw,
    gtin: valid ? gtin : null,
    key: valid ? gtin : null,
    expiresOn,
    batch: fields.get('10') || null,
    serial,
    marked,
  };
}
