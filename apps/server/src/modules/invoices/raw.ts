import type { InvoiceUnit } from '@zapas/shared';

/** Накладная в том виде, в каком её прочли из файла или с фото, до сопоставления с нашим справочником. */
export interface RawInvoiceLine {
  name: string;
  code: string | null;
  gtin: string | null;
  unit: InvoiceUnit | null;
  quantity: number;
  price: number | null;
  expiresOn: string | null;
  batch: string | null;
  vsd: string | null;
  marks: string[];
}

export interface RawInvoice {
  number: string | null;
  date: string | null;
  supplier: { name: string; inn: string | null } | null;
  total: number | null;
  lines: RawInvoiceLine[];
  warnings: string[];
}

/** Файл не похож на поддерживаемую накладную. Текст показывается человеку. */
export class InvoiceFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvoiceFormatError';
  }
}

/** Названия единиц в тексте накладной и коды ОКЕИ → единицы системы. */
const OKEI: Record<string, InvoiceUnit> = {
  '166': 'kg',
  '163': 'g',
  '168': 't',
  '112': 'l',
  '111': 'ml',
  '796': 'pcs',
  '778': 'pcs',
  '704': 'pcs',
};

const BY_NAME: Record<string, InvoiceUnit> = {
  кг: 'kg', 'кг.': 'kg', килограмм: 'kg',
  г: 'g', 'г.': 'g', гр: 'g', грамм: 'g',
  т: 't', тонна: 't',
  л: 'l', 'л.': 'l', литр: 'l',
  мл: 'ml', миллилитр: 'ml',
  шт: 'pcs', 'шт.': 'pcs', штука: 'pcs', упак: 'pcs', 'упак.': 'pcs', упаковка: 'pcs', пач: 'pcs', 'пач.': 'pcs', бут: 'pcs', 'бут.': 'pcs',
};

export function unitFrom(okei: string | null | undefined, name: string | null | undefined): InvoiceUnit | null {
  if (okei && OKEI[okei.trim()]) return OKEI[okei.trim()] as InvoiceUnit;
  const key = name?.trim().toLowerCase();
  return key ? (BY_NAME[key] ?? null) : null;
}

/** Число из накладной: запятая и пробелы-разделители тысяч допустимы. */
export function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** ДД.ММ.ГГГГ или ГГГГ-ММ-ДД в ГГГГ-ММ-ДД. Несуществующие даты это null. */
export function toIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  let y: number, m: number, d: number;
  const ru = /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/.exec(v);
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (ru) [d, m, y] = [Number(ru[1]), Number(ru[2]), Number(ru[3])] as [number, number, number];
  else if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])] as [number, number, number];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
