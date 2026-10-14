import { z } from 'zod';
import { isValidInn } from './invoice';
import { checkPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './password';
import { hasForbiddenChars } from './schemas';
import type { Unit } from './enums';

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
const id = z.uuid();
const email = z.string().trim().toLowerCase().max(254).pipe(z.email());

// Регистрация организации: первый пользователь становится её администратором

export const registerBody = z
  .strictObject({
    organizationName: text(120),
    fullName: text(120),
    email,
    password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  })
  .superRefine((v, ctx) => {
    const problem = checkPassword(v.password, { email: v.email, fullName: v.fullName });
    if (problem) ctx.addIssue({ code: 'custom', path: ['password'], message: problem });
  });
export type RegisterBody = z.infer<typeof registerBody>;

/** Организация, в которой лежат демо-данные и всё, что создано без явного указания организации. */
export const DEFAULT_ORG_ID = '00000000-0000-4000-8000-000000000001';
export const DEFAULT_ORG_NAME = 'Ресторанная группа «Набережная»';

export interface OrganizationDto {
  id: string;
  name: string;
}

// Заказы гостей: официант принимает, менеджер ведёт до выдачи

export const GUEST_ORDER_STATUSES = ['new', 'in_progress', 'served', 'cancelled'] as const;
export type GuestOrderStatus = (typeof GUEST_ORDER_STATUSES)[number];
export const GUEST_ORDER_STATUS_LABELS: Record<GuestOrderStatus, string> = {
  new: 'Принят',
  in_progress: 'В работе',
  served: 'Выдан',
  cancelled: 'Отменён',
};
/** Заказы, которые ещё не закрыты. */
export const OPEN_GUEST_STATUSES: readonly GuestOrderStatus[] = ['new', 'in_progress'];

export const INCIDENT_KINDS = ['dropped', 'wrong_dish', 'complaint', 'kitchen_defect', 'other'] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];
export const INCIDENT_KIND_LABELS: Record<IncidentKind, string> = {
  dropped: 'Разбили или уронили по пути',
  wrong_dish: 'Ошибка в заказе',
  complaint: 'Жалоба гостя',
  kitchen_defect: 'Брак на кухне',
  other: 'Другое',
};

export const INCIDENT_BLAMES = ['waiter', 'kitchen', 'guest', 'venue'] as const;
export type IncidentBlame = (typeof INCIDENT_BLAMES)[number];
export const INCIDENT_BLAME_LABELS: Record<IncidentBlame, string> = {
  waiter: 'По вине официанта',
  kitchen: 'По вине кухни',
  guest: 'По вине гостя',
  venue: 'За счёт заведения',
};

export const INCIDENT_STATUSES = ['reported', 'remade', 'dismissed'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = {
  reported: 'Ждёт решения',
  remade: 'Переделано бесплатно',
  dismissed: 'Отклонено',
};

export const MAX_GUEST_ORDER_LINES = 40;

/** Дата ГГГГ-ММ-ДД в виде, привычном читающему: 16.10.2026. */
export function ruDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return y && m && d ? `${d}.${m}.${y}` : iso;
}

export const createGuestOrderBody = z.strictObject({
  locationId: id,
  tableLabel: text(30),
  comment: note(300),
  lines: z
    .array(
      z.strictObject({
        dishId: id,
        quantity: z.number().int().min(1).max(50),
        note: note(120),
      }),
    )
    .min(1)
    .max(MAX_GUEST_ORDER_LINES),
});
export type CreateGuestOrderBody = z.infer<typeof createGuestOrderBody>;

export const guestOrderStatusBody = z
  .strictObject({
    status: z.enum(['in_progress', 'served', 'cancelled']),
    comment: note(300),
  })
  .superRefine((v, ctx) => {
    if (v.status === 'cancelled' && !v.comment) ctx.addIssue({ code: 'custom', path: ['comment'], message: 'Укажите причину отмены' });
  });
export type GuestOrderStatusBody = z.infer<typeof guestOrderStatusBody>;

export const reportIncidentBody = z.strictObject({
  lineId: id.optional(),
  kind: z.enum(INCIDENT_KINDS),
  blame: z.enum(INCIDENT_BLAMES),
  comment: text(300),
});
export type ReportIncidentBody = z.infer<typeof reportIncidentBody>;

export const resolveIncidentBody = z.strictObject({
  action: z.enum(['remake', 'dismiss']),
  /** Какую позицию переделать, если в обращении она не указана. */
  lineId: id.optional(),
  comment: note(300),
});
export type ResolveIncidentBody = z.infer<typeof resolveIncidentBody>;

export const guestOrdersQuery = z.strictObject({
  locationId: id.optional(),
  status: z.enum([...GUEST_ORDER_STATUSES, 'open', 'all']).default('open'),
  mine: z
    .enum(['1', '0'])
    .optional()
    .transform((v) => v === '1'),
});

export interface GuestOrderLineDto {
  id: string;
  dishId: string;
  dishName: string;
  quantity: number;
  price: number;
  note: string | null;
  /** Строка добавлена как бесплатная переделка по инциденту. */
  isRemake: boolean;
}

export interface GuestIncidentDto {
  id: string;
  orderId: string;
  lineId: string | null;
  dishName: string | null;
  kind: IncidentKind;
  blame: IncidentBlame;
  comment: string;
  status: IncidentStatus;
  reportedBy: string;
  reportedAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionComment: string | null;
  /** Стоимость списанных продуктов по себестоимости, если решили переделать. */
  lossCost: number | null;
}

export interface GuestOrderEventDto {
  id: string;
  kind: string;
  text: string;
  actor: string;
  at: string;
}

export interface GuestOrderDto {
  id: string;
  number: string;
  status: GuestOrderStatus;
  locationId: string;
  locationName: string;
  tableLabel: string;
  comment: string | null;
  waiterId: string;
  waiterName: string;
  lines: GuestOrderLineDto[];
  /** Сумма заказа без бесплатных переделок. */
  total: number;
  createdAt: string;
  acceptedAt: string | null;
  servedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  openIncidents: number;
}

export interface GuestOrderDetailDto extends GuestOrderDto {
  incidents: GuestIncidentDto[];
  events: GuestOrderEventDto[];
}

// Экраны официанта: только то, что нужно у стола

export interface WaiterHotDishDto {
  dishId: string;
  dishName: string;
  price: number;
  /** Сколько порций стоит предложить гостям. */
  portionsToPush: number;
  /** Насколько срочно: от 8 до 100. */
  priority: number;
}

export interface WaiterDishDto {
  id: string;
  name: string;
  price: number;
  stopped: boolean;
  /** Что мешает приготовить блюдо, коротко. */
  stopNote: string | null;
  ingredients: string[];
  hot: boolean;
}

// Связь с кабинетом поставщика. Обе стороны подписывают тело запроса общим секретом.

export const SUPPLIER_PORTAL_SIGNATURE_HEADER = 'x-zapas-signature';
export const SUPPLIER_PORTAL_TIMESTAMP_HEADER = 'x-zapas-timestamp';
export const SUPPLIER_PORTAL_MAX_SKEW_SECONDS = 300;

/** Статусы, которые ставит поставщик. */
export const SUPPLIER_SIDE_STATUSES = ['confirmed', 'declined', 'shipped'] as const;
export type SupplierSideStatus = (typeof SUPPLIER_SIDE_STATUSES)[number];

export const supplierStatusPush = z.strictObject({
  externalId: id,
  status: z.enum(SUPPLIER_SIDE_STATUSES),
  note: note(300),
  /** Дата, на которую поставщик обещает привезти. */
  deliveryOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export type SupplierStatusPush = z.infer<typeof supplierStatusPush>;

export const supplierLookupBody = z.strictObject({
  inn: z
    .string()
    .trim()
    .refine(isValidInn, 'Некорректный ИНН'),
});
export type SupplierLookupBody = z.infer<typeof supplierLookupBody>;

export interface PortalOrderLine {
  sku: string;
  name: string;
  unit: Unit;
  quantity: number;
  unitCost: number;
  receivedQty: number;
}

/** Заказ в том виде, в каком он уходит в кабинет поставщика. */
export interface PortalOrderPush {
  externalId: string;
  number: string;
  /** Статус заказа в «Запасе». */
  status: string;
  statusLabel: string;
  supplierInn: string;
  supplierName: string;
  buyer: { organization: string; location: string; address: string | null };
  expectedOn: string | null;
  comment: string | null;
  total: number;
  lines: PortalOrderLine[];
  /** Решение покупателя при приёмке: принято, принято частично, отказ. */
  buyerNote: string | null;
  updatedAt: string;
}

export const orderDecisionBody = z.strictObject({
  decision: z.enum(['refuse', 'remark']),
  comment: text(300),
});
export type OrderDecisionBody = z.infer<typeof orderDecisionBody>;

export interface WaiterStopDto {
  key: string;
  name: string;
  entityType: 'product' | 'dish';
  /** Коротко: нет в наличии, не хватает ингредиентов, снято вручную. */
  note: string;
}

export const waiterLocationQuery = z.strictObject({ locationId: id });
