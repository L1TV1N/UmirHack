import type { Role } from '@zapas/shared';
import type { Config } from '../config';
import type { Db } from '../db/client';
import type { Notifier } from '../modules/notifications/notifier';
import type { InvoiceReader } from '../modules/invoices/reader';
import type { WebhookSender } from '../modules/integrations/sender';
import type { WeatherProvider } from '../modules/forecast/weather';
import type { Mailer } from '../modules/orders/mailer';
import type { TelegramApi } from '../modules/telegram/api';

export interface Logger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

export interface Deps {
  db: Db;
  log: Logger;
  config: Config;
  /** Единственный источник «сейчас»: в тестах и сидах подменяется. */
  clock: () => Date;
  notifier: Notifier;
  /** Клиент Telegram для бота с командами. Нет: бот выключен. */
  telegram?: TelegramApi | null;
  /** Чтение накладных с фото (нужен ключ ИИ-сервиса). Нет: загрузка фото выключена. */
  invoiceReader?: InvoiceReader | null;
  /** Отправка вебхуков. Нет: события копятся в очереди, но не уходят. */
  webhookSender?: WebhookSender | null;
  /** Письма поставщикам с заказами (нужен SMTP). Нет: заказ отправляется без письма, причина видна в заказе. */
  mailer?: Mailer | null;
  /** Прогноз и история погоды для точек с координатами. Нет: погода в прогнозе не используется. */
  weather?: WeatherProvider | null;
}

export type Principal =
  | {
      kind: 'user';
      id: string;
      email: string;
      fullName: string;
      role: Role;
      /** 'all' для admin и manager. */
      locationIds: string[] | 'all';
    }
  | {
      kind: 'apikey';
      id: string;
      name: string;
      locationIds: string[];
    };

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

export interface Actor {
  principal: Principal;
  meta: RequestMeta;
}

export function actorName(p: Principal): string {
  return p.kind === 'user' ? p.fullName : `Касса «${p.name}»`;
}

export function actorUserId(p: Principal): string | null {
  return p.kind === 'user' ? p.id : null;
}
