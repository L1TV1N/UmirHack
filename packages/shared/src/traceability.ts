import { z } from 'zod';
import { parseScan } from './barcode';
import type { Unit } from './enums';

/** Номер ветеринарного сопроводительного документа в «Меркурии»: UUID. Храним в нижнем регистре. */
export const VSD_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function normalizeVsd(value: string): string | null {
  const v = value.trim().toLowerCase();
  return VSD_PATTERN.test(v) ? v : null;
}

export const vsdNumber = z
  .string()
  .trim()
  .transform((v) => v.toLowerCase())
  .refine((v) => VSD_PATTERN.test(v), 'Номер ВСД это UUID вида 1a2b3c4d-1234-5678-9abc-def012345678');

/** Срок на погашение ВСД после приёмки. */
export const VSD_REDEEM_HOURS = 24;

export const VSD_STATUSES = ['pending', 'redeemed'] as const;
export type VsdStatus = (typeof VSD_STATUSES)[number];
export const VSD_STATUS_LABELS: Record<VsdStatus, string> = { pending: 'Ждёт погашения', redeemed: 'Погашен' };

const GS = '\u001d';
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;

/** Код маркировки целиком, как его прочитал сканер. Разделитель полей GS1 допустим, остальные служебные символы нет. */
export const markCode = z
  .string()
  .min(20)
  .max(400)
  .refine((v) => !CONTROL.test(v.split(GS).join('')), 'Недопустимые символы в коде маркировки');

/** Кто есть кто среди марок: GTIN и серийный номер. Один и тот же код сканер может прочитать с разными служебными символами. */
export function markIdentity(code: string): string | null {
  const scan = parseScan(code);
  return scan.kind === 'gs1' && scan.gtin && scan.serial ? `${scan.gtin}|${scan.serial}` : null;
}

export const MAX_MARKS_PER_LINE = 500;
export const MAX_MARKS_PER_DOCUMENT = 1500;

export const redeemBody = z.strictObject({
  comment: z
    .string()
    .trim()
    .max(300)
    .refine((v) => !CONTROL.test(v), 'Недопустимые символы')
    .optional(),
});

export const vsdQuery = z.object({
  status: z.enum(['pending', 'redeemed', 'all']).default('pending'),
  locationId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export const marksQuery = z.object({
  locationId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export interface VsdDto {
  id: string;
  number: string;
  status: VsdStatus;
  productId: string;
  productName: string;
  unit: Unit;
  quantity: number;
  locationId: string;
  locationName: string;
  supplierName: string | null;
  documentNumber: string | null;
  receivedAt: string;
  dueAt: string;
  /** Срок погашения прошёл, а документ не погашен. */
  overdue: boolean;
  redeemedAt: string | null;
  redeemedBy: string | null;
  comment: string | null;
}

export interface MarkBatchDto {
  batchId: string;
  productId: string;
  productName: string;
  unit: Unit;
  locationId: string;
  locationName: string;
  supplierName: string | null;
  documentNumber: string | null;
  receivedOn: string;
  marks: number;
  /** Остаток партии. У штучного товара одна марка это одна штука. */
  remaining: number;
  /** Сколько марок уже должно выбыть (принято марок минус остаток), только для штучного товара. */
  disposed: number | null;
}

export interface TraceabilitySummaryDto {
  vsdPending: number;
  vsdOverdue: number;
  marksTotal: number;
}
