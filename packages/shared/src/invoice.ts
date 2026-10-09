import { z } from 'zod';
import type { ProductDto } from './types';
import type { Unit } from './enums';

/** Контрольные цифры ИНН (10 знаков у организаций, 12 у предпринимателей и физлиц). */
const INN10 = [2, 4, 10, 3, 5, 9, 4, 6, 8];
const INN12_A = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const INN12_B = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];

function innDigit(digits: number[], weights: number[]): number {
  const sum = weights.reduce((s, w, i) => s + w * (digits[i] as number), 0);
  return (sum % 11) % 10;
}

export function isValidInn(value: string): boolean {
  if (!/^(\d{10}|\d{12})$/.test(value)) return false;
  const d = [...value].map(Number);
  if (d.length === 10) return innDigit(d, INN10) === d[9];
  return innDigit(d, INN12_A) === d[10] && innDigit(d, INN12_B) === d[11];
}

/** Достраивает ИНН до верного: по девяти знакам даёт десять, по десяти даёт двенадцать (для демо-данных). */
export function completeInn(prefix: string): string {
  const d = [...prefix].map(Number);
  if (d.length === 9) return prefix + innDigit(d, INN10);
  if (d.length === 10) {
    const a = innDigit(d, INN12_A);
    return prefix + a + innDigit([...d, a], INN12_B);
  }
  throw new Error('Нужно 9 или 10 цифр');
}

export const inn = z
  .string()
  .trim()
  .refine(isValidInn, 'Некорректный ИНН: 10 или 12 цифр с верной контрольной цифрой');

export type InvoiceSource = 'upd' | 'photo';

/** Откуда продукт взялся для строки накладной. */
export type InvoiceMatchHow = 'barcode' | 'mapping' | 'name' | 'similar';

export const INVOICE_MATCH_LABELS: Record<InvoiceMatchHow, string> = {
  barcode: 'по штрихкоду',
  mapping: 'как в прошлый раз',
  name: 'по названию',
  similar: 'похоже по названию, проверьте',
};

/** Единицы, в которых приходят накладные. К единицам продукта приводятся пересчётом. */
export type InvoiceUnit = 'kg' | 'g' | 't' | 'l' | 'ml' | 'pcs';

const TO_BASE: Record<InvoiceUnit, { base: Unit; factor: number }> = {
  kg: { base: 'kg', factor: 1 },
  g: { base: 'kg', factor: 0.001 },
  t: { base: 'kg', factor: 1000 },
  l: { base: 'l', factor: 1 },
  ml: { base: 'l', factor: 0.001 },
  pcs: { base: 'pcs', factor: 1 },
};

/**
 * Количество и цена в единицах продукта. Граммы в килограммы, миллилитры в литры и так далее.
 * null: единицы несовместимы (например, штуки в накладной, а продукт весовой), решать должен человек.
 */
export function convertInvoiceUnit(
  quantity: number,
  price: number | null,
  from: InvoiceUnit | null,
  to: Unit,
): { quantity: number; price: number | null } | null {
  if (from === null) return { quantity, price };
  const f = TO_BASE[from];
  if (f.base !== to) return null;
  const q = Math.round(quantity * f.factor * 1000) / 1000;
  const p = price === null ? null : Math.round((price / f.factor) * 100) / 100;
  return { quantity: q, price: p };
}

export interface InvoiceCandidateDto {
  productId: string;
  name: string;
  unit: Unit;
  cost: number;
  shelfLifeDays: number | null;
  score: number;
}

export interface InvoiceMatchDto {
  product: Pick<ProductDto, 'id' | 'name' | 'unit' | 'sku' | 'cost' | 'shelfLifeDays'>;
  how: InvoiceMatchHow;
}

export interface InvoiceLineDto {
  /** Ключ для запоминания соответствия: код поставщика или нормализованное название. */
  key: string;
  index: number;
  name: string;
  code: string | null;
  gtin: string | null;
  /** Единица из накладной, если удалось понять. */
  unit: InvoiceUnit | null;
  /** Исходные количество и цена из накладной (в единицах накладной). */
  quantity: number;
  price: number | null;
  expiresOn: string | null;
  batch: string | null;
  /** Номер ВСД из «Меркурия», если поставщик указал его в накладной. */
  vsd: string | null;
  /** Коды маркировки из накладной. */
  marks: string[];
  /** Количество и цена в единицах найденного продукта (если пересчёт возможен). */
  converted: { quantity: number; price: number | null } | null;
  /** Единицы накладной и продукта несовместимы. */
  unitMismatch: boolean;
  match: InvoiceMatchDto | null;
  candidates: InvoiceCandidateDto[];
}

export interface InvoiceDto {
  source: InvoiceSource;
  number: string | null;
  date: string | null;
  supplier: { name: string; inn: string | null; supplierId: string | null; how: 'inn' | 'name' | null } | null;
  total: number | null;
  lines: InvoiceLineDto[];
  warnings: string[];
  /** Эта накладная уже оприходована. */
  alreadyReceived: { documentNumber: string; receivedOn: string } | null;
}

const base64 = z
  .string()
  .min(16)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Файл должен быть передан в base64');

export const parseInvoiceBody = z.strictObject({
  format: z.literal('upd'),
  content: base64,
});

export const INVOICE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

export const parseInvoicePhotoBody = z.strictObject({
  mediaType: z.enum(INVOICE_IMAGE_TYPES),
  image: base64,
});

export const itemMapBody = z.strictObject({
  items: z
    .array(z.strictObject({ key: z.string().trim().min(1).max(200), productId: z.string().uuid() }))
    .min(1)
    .max(200),
});
export type ItemMapBody = z.infer<typeof itemMapBody>;

export interface InvoiceCapabilitiesDto {
  upd: true;
  /** Распознавание фото накладной подключено (нужен ключ ИИ-сервиса). */
  photo: boolean;
}
