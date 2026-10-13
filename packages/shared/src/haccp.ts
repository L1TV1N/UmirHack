import { z } from 'zod';
import { hasForbiddenChars } from './schemas';

export const HACCP_KINDS = ['fridge', 'freezer', 'hot', 'other'] as const;
export type HaccpKind = (typeof HACCP_KINDS)[number];
export const HACCP_KIND_LABELS: Record<HaccpKind, string> = {
  fridge: 'Холодильник',
  freezer: 'Морозильник',
  hot: 'Горячая линия',
  other: 'Другое',
};

/** Границы по умолчанию для нового вида контрольной точки, градусов Цельсия. */
export const HACCP_DEFAULT_RANGE: Record<HaccpKind, { min: number; max: number }> = {
  fridge: { min: 0, max: 6 },
  freezer: { min: -24, max: -18 },
  hot: { min: 65, max: 95 },
  other: { min: 0, max: 25 },
};

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !hasForbiddenChars(v), 'Недопустимые символы');
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((v) => !hasForbiddenChars(v), 'Недопустимые символы')
    .optional()
    .transform((v) => (v === '' ? undefined : v));
const id = z.uuid();
const temp = z
  .number()
  .min(-60)
  .max(300)
  .refine((v) => Math.abs(v * 10 - Math.round(v * 10)) < 1e-6, 'Не больше одного знака после запятой');
const reading = z
  .number()
  .min(-80)
  .max(400)
  .refine((v) => Math.abs(v * 10 - Math.round(v * 10)) < 1e-6, 'Не больше одного знака после запятой');

export const haccpPointBody = z
  .strictObject({
    locationId: id,
    name: text(80),
    kind: z.enum(HACCP_KINDS),
    minTemp: temp,
    maxTemp: temp,
    everyHours: z.number().int().min(1).max(168).default(4),
  })
  .refine((v) => v.minTemp <= v.maxTemp, { path: ['maxTemp'], message: 'Верхняя граница не ниже нижней' });
export type HaccpPointBody = z.infer<typeof haccpPointBody>;

export const haccpPointPatch = z
  .strictObject({
    name: text(80).optional(),
    minTemp: temp.optional(),
    maxTemp: temp.optional(),
    everyHours: z.number().int().min(1).max(168).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => v.minTemp === undefined || v.maxTemp === undefined || v.minTemp <= v.maxTemp, { path: ['maxTemp'], message: 'Верхняя граница не ниже нижней' });
export type HaccpPointPatch = z.infer<typeof haccpPointPatch>;

export const haccpReadingBody = z.strictObject({
  pointId: id,
  value: reading,
  comment: optionalText(300),
  /** Если температура вышла за границы, действие можно записать сразу. */
  action: optionalText(500),
});
export type HaccpReadingBody = z.infer<typeof haccpReadingBody>;

export const haccpActionBody = z.strictObject({ action: text(500) });

export const haccpInspectionBody = z.strictObject({
  batchId: id,
  temperature: reading.nullable().optional(),
  appearanceOk: z.boolean(),
  packagingOk: z.boolean(),
  decision: z.enum(['accepted', 'rejected']),
  comment: optionalText(300),
});
export type HaccpInspectionBody = z.infer<typeof haccpInspectionBody>;

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата вида 2026-10-08');
export const haccpReadingsQuery = z.object({
  locationId: id.optional(),
  pointId: id.optional(),
  from: isoDay.optional(),
  to: isoDay.optional(),
  /** Только отклонения. */
  deviations: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export const haccpLocationQuery = z.object({ locationId: id.optional() });

export interface HaccpReadingDto {
  id: number;
  pointId: string;
  pointName: string;
  locationId: string;
  locationName: string;
  measuredAt: string;
  value: number;
  minTemp: number;
  maxTemp: number;
  inRange: boolean;
  comment: string | null;
  authorName: string;
  /** Что сделали с отклонением. null у замера в норме и у отклонения, по которому ещё ничего не записано. */
  action: { text: string; authorName: string; at: string } | null;
}

export interface HaccpPointDto {
  id: string;
  locationId: string;
  locationName: string;
  name: string;
  kind: HaccpKind;
  minTemp: number;
  maxTemp: number;
  everyHours: number;
  isActive: boolean;
  last: { value: number; at: string; inRange: boolean } | null;
  /** Когда нужен следующий замер. */
  dueAt: string;
  overdue: boolean;
  /** Отклонения, по которым не записано действие. */
  openDeviations: number;
}

export interface HaccpSummaryDto {
  points: number;
  overdue: number;
  openDeviations: number;
}

export interface HaccpPendingBatchDto {
  batchId: string;
  productName: string;
  unit: 'kg' | 'l' | 'pcs';
  quantity: number;
  locationId: string;
  locationName: string;
  receivedOn: string;
  expiresOn: string;
  documentNo: string | null;
  supplierName: string | null;
}

export interface HaccpInspectionDto {
  id: number;
  batchId: string;
  productName: string;
  locationName: string;
  temperature: number | null;
  appearanceOk: boolean;
  packagingOk: boolean;
  decision: 'accepted' | 'rejected';
  comment: string | null;
  authorName: string;
  createdAt: string;
}

/** Попадает ли температура в границы. Границы включены. */
export function inHaccpRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

export interface HaccpDue {
  dueAt: Date;
  overdue: boolean;
}

/**
 * Когда нужен следующий замер. Точка без замеров отсчитывается от создания. Опоздание это когда срок вышел,
 * поэтому в момент ровно через заданное число часов замер ещё не просрочен.
 */
export function haccpDue(everyHours: number, lastAt: Date | null, createdAt: Date, now: Date): HaccpDue {
  const from = lastAt ?? createdAt;
  const dueAt = new Date(from.getTime() + everyHours * 3_600_000);
  return { dueAt, overdue: now.getTime() > dueAt.getTime() };
}
