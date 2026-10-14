import { z } from 'zod';
import { isValidInn } from './invoice';
import { MAX_ORDER_LINES, ORDER_STATUSES } from './orders';
import { markCode, MAX_MARKS_PER_DOCUMENT, MAX_MARKS_PER_LINE, vsdNumber } from './traceability';
import { isValidIsoDate } from './dates';
import {
  DOCUMENT_KINDS,
  LOCATION_KINDS,
  MOVEMENT_TYPES,
  RECOMMENDATION_TYPES,
  ROLES,
  UNITS,
  WRITEOFF_REASONS,
} from './enums';
import { checkPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './password';

/** Русские тексты стандартных ошибок валидации для API и форм. */
export function useRussianErrors(): void {
  z.config(z.locales.ru());
}

const id = z.uuid();
const isoDate = z.string().refine(isValidIsoDate, 'Некорректная дата');

// Управляющие символы, символы направления текста и нулевой байт. Первые ломают отображение и
// позволяют подделать имя (например, «gnp.exe» задом наперёд), последний Postgres не принимает вовсе.
// Одиночные суррогаты тоже недопустимы в UTF-8.
const FORBIDDEN_CHARS =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export function hasForbiddenChars(value: string): boolean {
  return FORBIDDEN_CHARS.test(value);
}

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !hasForbiddenChars(v), 'Недопустимые символы');
const note = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((v) => !hasForbiddenChars(v), 'Недопустимые символы')
    .optional()
    .transform((v) => (v === '' ? undefined : v));

const hasAtMost = (digits: number) => (v: number) => Math.abs(v * 10 ** digits - Math.round(v * 10 ** digits)) < 1e-6;
const quantity = z
  .number()
  .positive()
  .max(1_000_000)
  .refine(hasAtMost(3), 'Не больше трёх знаков после запятой');
const quantityOrZero = z
  .number()
  .min(0)
  .max(1_000_000)
  .refine(hasAtMost(3), 'Не больше трёх знаков после запятой');
const money = z
  .number()
  .min(0)
  .max(10_000_000)
  .refine(hasAtMost(2), 'Не больше двух знаков после запятой');

const password = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);
const email = z.string().trim().toLowerCase().max(254).pipe(z.email());

// Авторизация

export const loginBody = z.strictObject({
  email,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginBody = z.infer<typeof loginBody>;

export const changePasswordBody = z
  .strictObject({
    currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    newPassword: password,
  })
  .superRefine((v, ctx) => {
    if (v.newPassword === v.currentPassword) {
      ctx.addIssue({ code: 'custom', path: ['newPassword'], message: 'Новый пароль совпадает с текущим' });
      return;
    }
    const problem = checkPassword(v.newPassword);
    if (problem) ctx.addIssue({ code: 'custom', path: ['newPassword'], message: problem });
  });
export type ChangePasswordBody = z.infer<typeof changePasswordBody>;

// Пользователи и точки

const locationIds = z.array(id).max(200);

export const createUserBody = z
  .strictObject({
    email,
    fullName: text(120),
    role: z.enum(ROLES),
    /** Без пароля система сама сгенерирует временный и потребует сменить его при первом входе. */
    password: password.optional(),
    locationIds: locationIds.default([]),
  })
  .superRefine((v, ctx) => {
    if (v.password === undefined) return;
    const problem = checkPassword(v.password, { email: v.email, fullName: v.fullName });
    if (problem) ctx.addIssue({ code: 'custom', path: ['password'], message: problem });
  });
export type CreateUserBody = z.infer<typeof createUserBody>;

export const updateUserBody = z.strictObject({
  fullName: text(120).optional(),
  role: z.enum(ROLES).optional(),
  isActive: z.boolean().optional(),
  locationIds: locationIds.optional(),
});
export type UpdateUserBody = z.infer<typeof updateUserBody>;

export const setPasswordBody = z.strictObject({ password });
export type SetPasswordBody = z.infer<typeof setPasswordBody>;

export const locationCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{2,20}$/, 'Латиница, цифры, дефис и подчёркивание, от 2 до 20 символов');

// Координаты нужны, чтобы брать для точки прогноз погоды. Пара задаётся целиком или не задаётся вовсе
const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);

export const createLocationBody = z
  .strictObject({
    code: locationCode,
    name: text(80),
    kind: z.enum(LOCATION_KINDS),
    address: note(200),
    latitude: latitude.nullable().optional(),
    longitude: longitude.nullable().optional(),
  })
  .refine((v) => (v.latitude == null) === (v.longitude == null), { path: ['longitude'], message: 'Укажите широту и долготу вместе' });
export type CreateLocationBody = z.infer<typeof createLocationBody>;

export const updateLocationBody = z.strictObject({
  name: text(80).optional(),
  kind: z.enum(LOCATION_KINDS).optional(),
  address: z.string().trim().max(200).refine((v) => !hasForbiddenChars(v), 'Недопустимые символы').nullable().optional(),
  latitude: latitude.nullable().optional(),
  longitude: longitude.nullable().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateLocationBody = z.infer<typeof updateLocationBody>;

// Справочники

export const categoryBody = z.strictObject({ name: text(60) });
export type CategoryBody = z.infer<typeof categoryBody>;

// Почта поставщика: на неё уходят заказы, поэтому пробелы, переводы строк и перечисление нескольких адресов недопустимы
const supplierEmail = z
  .string()
  .trim()
  .max(254)
  .regex(/^[^\s@<>()[\],;:\\"]+@[^\s@<>()[\],;:\\"]+\.[^\s@<>()[\],;:\\"]{2,}$/, 'Некорректная почта')
  .refine((v) => !hasForbiddenChars(v), 'Недопустимые символы');

export const supplierBody = z.strictObject({
  name: text(120),
  inn: z.union([z.literal(''), z.string().trim().refine(isValidInn, 'Некорректный ИНН: 10 или 12 цифр с верной контрольной цифрой')]).optional(),
  phone: note(40),
  note: note(300),
  email: z.union([z.literal(''), supplierEmail]).optional(),
  leadTimeDays: z.number().int().min(0).max(30).optional(),
  minOrderSum: z.number().min(0).max(10_000_000).refine(hasAtMost(2), 'Не больше двух знаков после запятой').optional(),
  autoOrder: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
export type SupplierBody = z.infer<typeof supplierBody>;

const sku = z
  .string()
  .trim()
  .regex(/^[A-Za-zА-Яа-яЁё0-9._-]{1,32}$/, 'Буквы, цифры, точка, дефис и подчёркивание, до 32 символов');
const barcode = z
  .string()
  .trim()
  .regex(/^\d{8,14}$/, 'От 8 до 14 цифр')
  .optional();

export const barcodeParam = z.strictObject({ code: z.string().regex(/^\d{8,14}$/, 'От 8 до 14 цифр') });

/** Кратность заказа: от тысячной до тысячи единиц. */
const packSize = z
  .number()
  .min(0.001)
  .max(1000)
  .refine(hasAtMost(3), 'Не больше трёх знаков после запятой');

export const createProductBody = z.strictObject({
  sku,
  barcode,
  name: text(160),
  categoryId: id,
  unit: z.enum(UNITS),
  minStock: quantityOrZero.default(0),
  shelfLifeDays: z.number().int().min(1).max(3650).optional(),
  price: money,
  cost: money,
  sellable: z.boolean().default(true),
  requiresVsd: z.boolean().default(false),
  requiresMarking: z.boolean().default(false),
  defaultSupplierId: id.optional(),
  packSize: packSize.default(1),
});
export type CreateProductBody = z.infer<typeof createProductBody>;

export const updateProductBody = z.strictObject({
  sku: sku.optional(),
  barcode: barcode.nullable().optional(),
  name: text(160).optional(),
  categoryId: id.optional(),
  unit: z.enum(UNITS).optional(),
  minStock: quantityOrZero.optional(),
  shelfLifeDays: z.number().int().min(1).max(3650).nullable().optional(),
  price: money.optional(),
  cost: money.optional(),
  sellable: z.boolean().optional(),
  requiresVsd: z.boolean().optional(),
  requiresMarking: z.boolean().optional(),
  defaultSupplierId: id.nullable().optional(),
  packSize: packSize.optional(),
  isActive: z.boolean().optional(),
});
export type UpdateProductBody = z.infer<typeof updateProductBody>;

const dishItems = z
  .array(z.strictObject({ productId: id, quantity }))
  .min(1)
  .max(40)
  .refine((items) => new Set(items.map((i) => i.productId)).size === items.length, 'Ингредиенты не должны повторяться');

/** Код блюда в кассовой системе (iiko, 1С): по нему касса узнаёт позицию стоп-листа. */
export const dishCode = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-zА-Яа-яЁё0-9._/-]+$/, 'Буквы, цифры, точка, дефис, подчёркивание и косая черта');

export const createDishBody = z.strictObject({
  name: text(160),
  code: dishCode.optional(),
  price: money,
  items: dishItems,
});
export type CreateDishBody = z.infer<typeof createDishBody>;

export const updateDishBody = z.strictObject({
  name: text(160).optional(),
  code: dishCode.nullable().optional(),
  price: money.optional(),
  items: dishItems.optional(),
  isActive: z.boolean().optional(),
});
export type UpdateDishBody = z.infer<typeof updateDishBody>;

// Операции

export const idempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Недопустимые символы в ключе идемпотентности');

export const receiptBody = z.strictObject({
  locationId: id,
  supplierId: id.optional(),
  /** Заказ поставщику, по которому принимается товар: принятое количество засчитывается в заказ. */
  orderId: id.optional(),
  documentNo: note(40),
  comment: note(500),
  allowExpired: z.boolean().default(false),
  lines: z
    .array(
      z.strictObject({
        productId: id,
        quantity,
        unitCost: money,
        /** Срок годности датой. Вместо неё можно передать срок хранения в днях или не передавать ничего: тогда берётся срок из карточки продукта. */
        expiresOn: isoDate.optional(),
        /** Срок хранения в днях от дня приёмки. */
        shelfLifeDays: z.number().int().min(1).max(3650).optional(),
        /** Номер ВСД из «Меркурия» на эту партию. */
        vsd: vsdNumber.optional(),
        /** Коды маркировки, отсканированные при приёмке. */
        marks: z.array(markCode).max(MAX_MARKS_PER_LINE).optional(),
      }),
    )
    .min(1)
    .max(200)
    .refine((lines) => lines.every((l) => !(l.expiresOn && l.shelfLifeDays)), 'Срок годности указывается датой или сроком хранения, но не обоими способами сразу')
    .refine((lines) => lines.reduce((n, l) => n + (l.marks?.length ?? 0), 0) <= MAX_MARKS_PER_DOCUMENT, `Не больше ${MAX_MARKS_PER_DOCUMENT} кодов маркировки в одном приходе`),
});
export type ReceiptBody = z.infer<typeof receiptBody>;

const saleLine = z.union([
  z.strictObject({ productId: id, quantity }),
  z.strictObject({ dishId: id, quantity }),
]);
export type SaleLine = z.infer<typeof saleLine>;

export const saleBody = z.strictObject({
  locationId: id,
  comment: note(500),
  lines: z.array(saleLine).min(1).max(200),
});
export type SaleBody = z.infer<typeof saleBody>;

export const posSaleBody = z.strictObject({
  externalId: idempotencyKey,
  lines: z.array(saleLine).min(1).max(200),
});
export type PosSaleBody = z.infer<typeof posSaleBody>;

const batchLine = z.strictObject({
  productId: id,
  batchId: id.optional(),
  quantity,
});

export const writeoffBody = z.strictObject({
  locationId: id,
  reason: z.enum(WRITEOFF_REASONS),
  comment: note(500),
  lines: z.array(batchLine).min(1).max(200),
});
export type WriteoffBody = z.infer<typeof writeoffBody>;

export const writeoffExpiredBody = z.strictObject({
  locationId: id,
  comment: note(500),
});
export type WriteoffExpiredBody = z.infer<typeof writeoffExpiredBody>;

export const transferBody = z
  .strictObject({
    fromLocationId: id,
    toLocationId: id,
    comment: note(500),
    lines: z.array(batchLine).min(1).max(200),
  })
  .refine((v) => v.fromLocationId !== v.toLocationId, {
    path: ['toLocationId'],
    message: 'Точка получатель должна отличаться от отправителя',
  });
export type TransferBody = z.infer<typeof transferBody>;

// Инвентаризация

export const createInventoryBody = z.strictObject({
  locationId: id,
  comment: note(300),
});
export type CreateInventoryBody = z.infer<typeof createInventoryBody>;

export const inventoryLinesBody = z.strictObject({
  lines: z
    .array(
      z.strictObject({
        productId: id,
        countedQty: quantityOrZero.nullable(),
        surplusExpiresOn: isoDate.optional(),
      }),
    )
    .min(1)
    .max(2000),
});
export type InventoryLinesBody = z.infer<typeof inventoryLinesBody>;

// Акции и стоп-лист

export const promotionBody = z.strictObject({
  batchId: id,
  percent: z.number().int().min(1).max(90),
});
export type PromotionBody = z.infer<typeof promotionBody>;

export const manualStopBody = z
  .strictObject({
    locationId: id,
    productId: id.optional(),
    dishId: id.optional(),
    reason: text(200),
    until: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((v) => Number(Boolean(v.productId)) + Number(Boolean(v.dishId)) === 1, {
    message: 'Укажите продукт или блюдо',
    path: ['productId'],
  });
export type ManualStopBody = z.infer<typeof manualStopBody>;

// Настройки и интеграции

export const settingsBody = z
  .strictObject({
    expiringSoonDays: z.number().int().min(1).max(30),
    criticalDays: z.number().int().min(0).max(14),
    forecastWindowDays: z.number().int().min(7).max(90),
    reorderCoverDays: z.number().int().min(1).max(60),
    lowPortionThreshold: z.number().int().min(1).max(30),
    digestHour: z.number().int().min(0).max(23),
    /** Рекомендации, стоп-лист и заказы считают скорость с поправкой на день недели, праздники, погоду и акции. */
    useDemandModel: z.boolean().default(true),
    /** Раз в сутки списывать просроченные партии от имени системы. */
    autoWriteoffExpired: z.boolean().default(false),
  })
  .refine((v) => v.criticalDays <= v.expiringSoonDays, {
    path: ['criticalDays'],
    message: 'Не больше порога «скоро истекает»',
  });
export type SettingsBody = z.infer<typeof settingsBody>;

export const createApiKeyBody = z.strictObject({
  name: text(80),
  locationId: id,
});
export type CreateApiKeyBody = z.infer<typeof createApiKeyBody>;

// Заказы поставщикам

const orderLines = z
  .array(z.strictObject({ productId: id, quantity, unitCost: money }))
  .min(1)
  .max(MAX_ORDER_LINES)
  .refine((lines) => new Set(lines.map((l) => l.productId)).size === lines.length, 'Продукты в заказе не должны повторяться');

export const createOrderBody = z.strictObject({
  supplierId: id,
  locationId: id,
  expectedOn: isoDate.optional(),
  comment: note(500),
  lines: orderLines,
});
export type CreateOrderBody = z.infer<typeof createOrderBody>;

export const updateOrderBody = z.strictObject({
  expectedOn: isoDate.nullable().optional(),
  comment: z.union([note(500), z.null()]).optional(),
  lines: orderLines.optional(),
});
export type UpdateOrderBody = z.infer<typeof updateOrderBody>;

export const orderFromSuggestionBody = z.strictObject({
  supplierId: id,
  locationId: id,
  expectedOn: isoDate.optional(),
});
export type OrderFromSuggestionBody = z.infer<typeof orderFromSuggestionBody>;

export const closeOrderBody = z.strictObject({ comment: note(300) });

// Параметры запросов

export const idParam = z.object({ id });

export const ordersQuery = z.object({
  /** open: отправленные и принятые частично. */
  status: z.enum([...ORDER_STATUSES, 'open', 'all']).default('all'),
  locationId: id.optional(),
  supplierId: id.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export const orderSuggestionsQuery = z.object({ locationId: id.optional(), supplierId: id.optional() });

const boolString = z.enum(['true', 'false']).transform((v) => v === 'true');

export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

const search = z
  .string()
  .trim()
  .max(100)
  .refine((v) => !hasForbiddenChars(v), 'Недопустимые символы')
  .optional();

export const stockSummaryQuery = pageQuery.extend({
  locationId: id.optional(),
  categoryId: id.optional(),
  q: search,
  flag: z.enum(['all', 'low', 'expiring', 'expired']).default('all'),
});

export const batchesQuery = pageQuery.extend({
  locationId: id.optional(),
  productId: id.optional(),
  status: z.enum(['active', 'expiring', 'expired', 'depleted']).default('active'),
  q: search,
});

export const movementsQuery = pageQuery.extend({
  locationId: id.optional(),
  productId: id.optional(),
  type: z.enum(MOVEMENT_TYPES).optional(),
  documentId: id.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const documentsQuery = pageQuery.extend({
  kind: z.enum(DOCUMENT_KINDS).optional(),
  locationId: id.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const productsQuery = pageQuery.extend({
  q: search,
  categoryId: id.optional(),
  active: boolString.optional(),
  sellable: boolString.optional(),
});

export const locationScopeQuery = z.object({ locationId: id.optional() });

export const recommendationsQuery = z.object({
  locationId: id.optional(),
  type: z.enum(RECOMMENDATION_TYPES).optional(),
});

export const forecastQuery = z.object({ locationId: id });

export const supplierRatingQuery = z.object({
  locationId: id.optional(),
  /** За сколько последних суток считать. */
  days: z.coerce.number().int().min(7).max(365).default(90),
});

export const rescuedQuery = z.object({
  locationId: id.optional(),
  /** За сколько последних суток считать. */
  days: z.coerce.number().int().min(1).max(90).default(30),
});

export const shortagesQuery = z.object({
  locationId: id.optional(),
  /** За сколько последних суток считать. */
  days: z.coerce.number().int().min(1).max(90).default(30),
});

export const reportQuery = z.object({
  locationId: id.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const auditQuery = pageQuery.extend({
  action: z.string().trim().max(60).refine((v) => !hasForbiddenChars(v), 'Недопустимые символы').optional(),
  userEmail: z.string().trim().max(254).refine((v) => !hasForbiddenChars(v), 'Недопустимые символы').optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const promotionsQuery = z.object({
  locationId: id.optional(),
  active: boolString.default(true),
});

export const inventoriesQuery = pageQuery.extend({
  locationId: id.optional(),
  status: z.enum(['draft', 'committed', 'cancelled']).optional(),
});

export const usersQuery = pageQuery.extend({ q: search });
