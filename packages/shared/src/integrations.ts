import { z } from 'zod';
import { hasForbiddenChars } from './schemas';
import type { Unit } from './enums';

/** События, на которые можно подписать адрес. Служебное «ping» отправляется только кнопкой «Проверить». */
export const WEBHOOK_EVENTS = ['stoplist.changed', 'order.sent', 'promotion.changed'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export const WEBHOOK_EVENT_LABELS: Record<WebhookEvent, string> = {
  'stoplist.changed': 'Стоп-лист изменился',
  'order.sent': 'Заказ поставщику отправлен',
  'promotion.changed': 'Скидка на партию изменилась',
};

export const WEBHOOK_MAX_ENDPOINTS = 20;

const webhookName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((v) => !hasForbiddenChars(v), 'Недопустимые символы');

// Разбор адреса по-настоящему делает сервер (там есть URL и проверка адресов), здесь отсекаем явный мусор
const URL_PATTERN = /^https?:\/\/(?![^/?#]*@)[^\s/?#]+(?:[/?][^\s#]*)?$/i;

/** Адрес приёмника: http или https, без логина и пароля в адресе и без «#». */
export const webhookUrl = z
  .string()
  .trim()
  .min(8)
  .max(500)
  .refine((v) => !hasForbiddenChars(v) && URL_PATTERN.test(v), 'Нужен адрес вида https://example.ru/hook, без логина, пароля и «#»');

const events = z
  .array(z.enum(WEBHOOK_EVENTS))
  .min(1, 'Выберите хотя бы одно событие')
  .max(WEBHOOK_EVENTS.length)
  .refine((v) => new Set(v).size === v.length, 'События не должны повторяться');

export const createWebhookBody = z.strictObject({
  name: webhookName,
  url: webhookUrl,
  events,
  /** Пусто: все точки. */
  locationId: z.uuid().nullable().optional(),
});
export type CreateWebhookBody = z.infer<typeof createWebhookBody>;

export const updateWebhookBody = z.strictObject({
  name: webhookName.optional(),
  url: webhookUrl.optional(),
  events: events.optional(),
  locationId: z.uuid().nullable().optional(),
  enabled: z.boolean().optional(),
});
export type UpdateWebhookBody = z.infer<typeof updateWebhookBody>;

export const deliveriesQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) });

export interface WebhookDto {
  id: string;
  name: string;
  url: string;
  events: WebhookEvent[];
  locationId: string | null;
  locationName: string | null;
  enabled: boolean;
  /** Сколько доставок подряд завершились неудачей. */
  failureStreak: number;
  /** Почему отправка выключена сама (после серии неудач). */
  disabledReason: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  createdAt: string;
}

export interface WebhookCreatedDto extends WebhookDto {
  /** Показывается один раз: по нему приёмник проверяет подпись. */
  secret: string;
}

export interface WebhookDeliveryDto {
  id: string;
  event: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  lastStatus: number | null;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
  nextAttemptAt: string | null;
}

/** Строка стоп-листа в ленте для кассы и в теле вебхука. */
export interface StopFeedEntryDto {
  /** Идентификатор продукта или блюда в «Запасе». */
  id: string;
  type: 'product' | 'dish';
  /** Артикул продукта или код блюда, по которому позицию узнаёт касса. Может быть пустым у блюда. */
  code: string | null;
  barcode: string | null;
  name: string;
  locationId: string;
  locationName: string;
  source: 'auto' | 'manual';
  reason: string;
  since: string;
}

export interface StopFeedDto {
  generatedAt: string;
  locationId: string;
  entries: StopFeedEntryDto[];
}

export interface StopListChangedPayload {
  event: 'stoplist.changed';
  locationId: string;
  locationName: string;
  createdAt: string;
  /** Что появилось и что ушло из стоп-листа с прошлой отправки. */
  added: StopFeedEntryDto[];
  removed: StopFeedEntryDto[];
  /** Полное текущее состояние точки: приёмнику не нужно складывать события, достаточно заменить своё. */
  entries: StopFeedEntryDto[];
  /** Список слишком длинный и обрезан: полное состояние есть в ленте GET /api/pos/stop-list. */
  truncated: boolean;
}

/** Скидка на партию, по которой касса продаст следующую единицу товара. */
export interface MarkdownDto {
  percent: number;
  /** Цена со скидкой. */
  price: number;
  /** Скидка действует до конца этого дня, обычно это последний день срока партии. */
  endsOn: string;
  /** Сколько товара осталось в уценённой партии. */
  quantity: number;
}

/** Событие «скидка изменилась»: касса обновляет цену, markdown равен null, когда скидку отменили. */
export interface PromotionChangedPayload {
  event: 'promotion.changed';
  locationId: string;
  locationName: string;
  createdAt: string;
  product: { sku: string; barcode: string | null; name: string; unit: Unit; price: number };
  markdown: MarkdownDto | null;
}

export interface PosProductDto {
  sku: string;
  barcode: string | null;
  name: string;
  unit: Unit;
  price: number;
  /** Скидка, действующая сейчас на ближайшую по сроку партию на точке кассы. Касса продаёт по ней, пока партия не кончится. */
  markdown: MarkdownDto | null;
  sellable: boolean;
  isActive: boolean;
}

export const posProductsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

// Импорт номенклатуры из CSV (выгрузка iiko, 1С, Excel)

export const MAX_IMPORT_BYTES = 2_000_000;
export const MAX_IMPORT_ROWS = 5000;

export const importBody = z.strictObject({
  /** Файл целиком в base64. */
  content: z.string().min(1).max(Math.ceil((MAX_IMPORT_BYTES * 4) / 3) + 8),
  /** Создавать категории, которых ещё нет. Иначе строки с новой категорией считаются ошибкой. */
  createCategories: z.boolean().default(false),
});
export type ImportBody = z.infer<typeof importBody>;

export type ImportAction = 'create' | 'update' | 'skip' | 'error';

export interface ImportRowDto {
  /** Номер строки в файле, как её видно в Excel (заголовок это строка 1). */
  line: number;
  action: ImportAction;
  sku: string | null;
  name: string | null;
  /** Что изменится у существующего продукта. */
  changes: string[];
  messages: string[];
}

export interface ImportPreviewDto {
  encoding: 'utf-8' | 'windows-1251';
  delimiter: ';' | ',' | '\t';
  /** Какие колонки файла распознаны и чем они стали. */
  columns: { header: string; field: string | null }[];
  total: number;
  create: number;
  update: number;
  skip: number;
  errors: number;
  newCategories: string[];
  /** Сначала ошибки, затем остальное. Не больше 300 строк. */
  rows: ImportRowDto[];
}

export interface ImportResultDto {
  created: number;
  updated: number;
  skipped: number;
  categoriesCreated: number;
}

const DELIVERY_ERROR_HINT = 'ответа нет';

/** Что показать в журнале вместо кода: «ответ 200», текст сбоя или «ответа нет». */
export function fmtDelivery(d: Pick<WebhookDeliveryDto, 'status' | 'lastStatus' | 'lastError'>): string {
  if (d.lastError) return d.lastError;
  if (d.status === 'delivered') return d.lastStatus ? `ответ ${d.lastStatus}` : 'доставлено';
  return d.lastStatus ? `ответ ${d.lastStatus}` : DELIVERY_ERROR_HINT;
}
