import type { Role } from '@zapas/shared';
import type { Config } from '../config';
import type { Db } from '../db/client';
import type { Notifier } from '../modules/notifications/notifier';
import type { InvoiceReader } from '../modules/invoices/reader';
import type { WebhookSender } from '../modules/integrations/sender';
import type { ExchangeTransport } from '../modules/exchange/transport';
import type { WeatherProvider } from '../modules/forecast/weather';
import type { QuestionPlanner } from '../modules/assistant/planner';
import type { Mailer } from '../modules/orders/mailer';
import type { TelegramApi } from '../modules/telegram/api';
import type { SupplierPortal } from '../modules/supplier-portal/client';

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
  /**
   * Только отправка сообщений: коды подтверждения входа. Задан при любом токене бота, даже если опрос Telegram
   * на этом экземпляре выключен (его ведёт другой), поэтому коды уходят с любого экземпляра.
   */
  codeSender?: Pick<TelegramApi, 'sendMessage'> | null;
  /** Чтение накладных с фото (нужен ключ GigaChat). Если его нет, загрузка фото выключена. */
  invoiceReader?: InvoiceReader | null;
  /** Разбор вопросов помощника (нужен ключ GigaChat). Нет: вопросы разбирают простые правила. */
  questionPlanner?: QuestionPlanner | null;
  /** Отправка вебхуков. Нет: события копятся в очереди, но не уходят. */
  webhookSender?: WebhookSender | null;
  /** Обмен с учётными системами (1С, iiko). Нет: задания копятся в очереди, но не уходят. */
  exchangeTransport?: ExchangeTransport | null;
  /** Письма поставщикам с заказами (нужен SMTP). Нет: заказ отправляется без письма, причина видна в заказе. */
  mailer?: Mailer | null;
  /** Кабинет поставщика «Отгрузка»: куда уходят заказы. Нет: заказы остаются только в «Запасе». */
  supplierPortal?: SupplierPortal | null;
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
      /** Организация пользователя. Пусто только у служебного администратора фоновых задач. */
      orgId: string | null;
      /** Пароль выдан администратором: до смены доступны только вход и смена пароля. */
      mustChangePassword?: boolean;
      /** Для admin и manager это все точки их организации, для остальных назначенные. 'all' только у служебных задач. */
      locationIds: string[] | 'all';
    }
  | {
      kind: 'apikey';
      id: string;
      name: string;
      orgId: string;
      locationIds: string[];
    }
  /** Фоновые задачи приложения: например, автоматическое списание просроченного. */
  | {
      kind: 'system';
      name: string;
      orgId: null;
      locationIds: 'all';
    };

/** Вошедший сотрудник (не ключ кассы и не система). */
export type UserPrincipal = Extract<Principal, { kind: 'user' }>;

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
  if (p.kind === 'user') return p.fullName;
  return p.kind === 'system' ? p.name : `Касса «${p.name}»`;
}

export function actorUserId(p: Principal): string | null {
  return p.kind === 'user' ? p.id : null;
}
