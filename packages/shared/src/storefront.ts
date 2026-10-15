import { z } from 'zod';
import { hasForbiddenChars } from './schemas';

const id = z.uuid();
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !hasForbiddenChars(v), 'Недопустимые символы');

export const STOREFRONT_CODE_LENGTH = 6;
/** Без похожих знаков (0/O, 1/I): код читают с экрана и называют вслух. */
export const STOREFRONT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** Сколько броней на одном телефоне может быть открыто одновременно. */
export const STOREFRONT_MAX_ACTIVE_PER_PHONE = 3;
/** Сколько броней может быть открыто одновременно на одной точке: ограничение от забивания витрины. */
export const STOREFRONT_MAX_ACTIVE_PER_LOCATION = 200;

export const slugBody = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, 'Адрес из латинских букв, цифр и дефиса, от 3 до 40 знаков');

export const storefrontSettingsBody = z.strictObject({
  locationId: id,
  enabled: z.boolean(),
  slug: slugBody.optional(),
  note: z
    .string()
    .trim()
    .max(300)
    .refine((v) => !hasForbiddenChars(v), 'Недопустимые символы')
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
});
export type StorefrontSettingsBody = z.infer<typeof storefrontSettingsBody>;

export const createOfferBody = z.strictObject({
  batchId: id,
  quantity: z.number().positive().max(1_000_000),
  perGuestMax: z.number().int().min(1).max(50).optional(),
});
export type CreateOfferBody = z.infer<typeof createOfferBody>;

/** Телефон приводится к цифрам: 8 и +7 в начале считаются одним и тем же. */
export function normalizePhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`;
  if (digits.length === 10) digits = `7${digits}`;
  return digits.length >= 11 && digits.length <= 15 ? digits : null;
}

const phone = z
  .string()
  .trim()
  .max(30)
  .transform((v, ctx) => {
    const normalized = normalizePhone(v);
    if (!normalized) ctx.addIssue({ code: 'custom', message: 'Введите телефон полностью, например +7 900 123-45-67' });
    return normalized ?? '';
  });

export const reserveBody = z.strictObject({
  offerId: id,
  quantity: z.number().positive().max(50),
  name: text(60),
  phone,
  /** Согласие на хранение имени и телефона на время брони. */
  consent: z.literal(true, { error: 'Нужно согласие на обработку имени и телефона' }),
  /** Ловушка для ботов: настоящий человек поле не видит и не заполняет. */
  website: z.string().max(0).optional(),
});
export type ReserveBody = z.infer<typeof reserveBody>;

export const cancelReservationBody = z.strictObject({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(new RegExp(`^[${STOREFRONT_CODE_ALPHABET}]{${STOREFRONT_CODE_LENGTH}}$`), 'Неверный код брони'),
  phone,
});
export type CancelReservationBody = z.infer<typeof cancelReservationBody>;

export const cancelStaffBody = z.strictObject({ reason: text(200).optional() });
export type CancelStaffBody = z.infer<typeof cancelStaffBody>;

export interface PublicOfferDto {
  id: string;
  productName: string;
  unit: string;
  /** Сколько можно забронировать сейчас. */
  available: number;
  price: number;
  oldPrice: number;
  percent: number;
  expiresOn: string;
  daysLeft: number;
  perGuestMax: number;
}

export interface PublicVenueDto {
  slug: string;
  name: string;
  address: string | null;
  note: string | null;
  offers: PublicOfferDto[];
}

export interface PublicRescueDto {
  venues: PublicVenueDto[];
  holdMinutes: number;
}

export interface ReservationReceiptDto {
  code: string;
  expiresAt: string;
  venue: string;
  address: string | null;
  note: string | null;
  productName: string;
  unit: string;
  quantity: number;
  total: number;
}

export interface StorefrontSettingsDto {
  locationId: string;
  locationName: string;
  enabled: boolean;
  slug: string | null;
  note: string | null;
  publicPath: string | null;
}

export interface StaffOfferDto {
  id: string;
  batchId: string;
  locationId: string;
  locationName: string;
  productName: string;
  unit: string;
  offered: number;
  reserved: number;
  sold: number;
  available: number;
  price: number;
  percent: number;
  expiresOn: string;
  daysLeft: number;
  perGuestMax: number;
  createdAt: string;
  closedAt: string | null;
  /** Почему предложение не видно гостям, если не видно. */
  hiddenReason: string | null;
}

export type ReservationStatus = 'reserved' | 'picked_up' | 'cancelled' | 'expired';

export interface StaffReservationDto {
  id: string;
  code: string;
  status: ReservationStatus;
  locationId: string;
  locationName: string;
  productName: string;
  unit: string;
  quantity: number;
  total: number;
  /** null: данные гостя уже стёрты по сроку хранения. */
  guestName: string | null;
  guestPhone: string | null;
  createdAt: string;
  expiresAt: string;
  closedAt: string | null;
  cancelReason: string | null;
}
