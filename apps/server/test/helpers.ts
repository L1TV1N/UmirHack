import { DEFAULT_ORG_ID, DEFAULT_ORG_NAME, type Role } from '@zapas/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { buildApp } from '../src/app';
import { loadEnvFile, parseConfig, type Config } from '../src/config';
import { createDb, type Db, type DbHandle } from '../src/db/client';
import { invalidateSnapshots } from '../src/modules/analytics/snapshot';
import type { Deps } from '../src/lib/context';
import { FakeWebhookSender } from '../src/modules/integrations/sender';
import type { ExchangeRequest, ExchangeResponse, ExchangeTransport } from '../src/modules/exchange/transport';
import { MemoryNotifier } from '../src/modules/notifications/notifier';
import { resetForecastCache } from '../src/modules/forecast/service';
import { FakeWeatherProvider } from '../src/modules/forecast/weather';
import { FakeMailer } from '../src/modules/orders/mailer';
import { drainStopListSync } from '../src/modules/stoplist/service';
import { hashPassword } from '../src/modules/auth/password';
import type { BotCommand, Buttons, TelegramApi, TelegramUpdate } from '../src/modules/telegram/api';
import { TelegramBot } from '../src/modules/telegram/bot';
import type { InvoiceReader } from '../src/modules/invoices/reader';
import type { SupplierPortal } from '../src/modules/supplier-portal/client';
import type { PortalOrderPush } from '@zapas/shared';
import type { RawInvoice } from '../src/modules/invoices/raw';

/** Транспорт обмена, который тест подменяет на имитацию 1С или на отказ сети. Пока ничего не подключено, любая отправка падает. */
export class SwitchTransport implements ExchangeTransport {
  current: ExchangeTransport | null = null;
  async request(req: ExchangeRequest): Promise<ExchangeResponse> {
    if (!this.current) throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    return this.current.request(req);
  }
}

/** Кабинет поставщика без сети: запоминает всё, что ему отправили. */
export class FakePortal implements SupplierPortal {
  readonly publicUrl = 'http://portal.test/supplier';
  readonly pushes: PortalOrderPush[] = [];
  failure: string | null = null;
  async push(order: PortalOrderPush): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.failure) return { ok: false, error: this.failure };
    this.pushes.push(order);
    return { ok: true };
  }
}

export const TEST_PASSWORD = 'Тестовый-пароль-2026';

/** Чтение фото без сети: отдаёт заготовленную накладную или сбой. */
export class FakeInvoiceReader implements InvoiceReader {
  result: RawInvoice = { number: null, date: null, supplier: null, total: null, lines: [], warnings: [] };
  failure: Error | null = null;
  calls: { bytes: number; mediaType: string }[] = [];
  async read(image: Buffer, mediaType: string): Promise<RawInvoice> {
    this.calls.push({ bytes: image.length, mediaType });
    if (this.failure) throw this.failure;
    return this.result;
  }
}

/** Telegram без сети: записывает отправленное и отдаёт заранее заготовленные сообщения. */
export class FakeTelegramApi implements TelegramApi {
  username = 'zapas_test_bot';
  readonly sent: { chatId: number; text: string; buttons?: Buttons }[] = [];
  readonly edits: { chatId: number; messageId: number; text: string; buttons?: Buttons }[] = [];
  readonly answers: { id: string; text?: string }[] = [];
  commands: BotCommand[] = [];
  queue: TelegramUpdate[] = [];
  private seq = 1000;

  async getMe() {
    return { username: this.username };
  }
  async getUpdates(_offset?: number, _timeoutSeconds?: number, _signal?: AbortSignal): Promise<TelegramUpdate[]> {
    const next = this.queue;
    this.queue = [];
    return next;
  }
  async sendMessage(chatId: number, text: string, buttons?: Buttons) {
    this.sent.push({ chatId, text, ...(buttons ? { buttons } : {}) });
  }
  async editMessage(chatId: number, messageId: number, text: string, buttons?: Buttons) {
    this.edits.push({ chatId, messageId, text, ...(buttons ? { buttons } : {}) });
  }
  async answerCallback(id: string, text?: string) {
    this.answers.push({ id, ...(text ? { text } : {}) });
  }
  async setCommands(commands: BotCommand[]) {
    this.commands = commands;
  }

  /** Сообщение от человека в личном чате. */
  say(chatId: number, text: string, extra: Partial<TelegramUpdate['message'] & object> = {}): TelegramUpdate {
    this.seq += 1;
    return { update_id: this.seq, message: { message_id: this.seq, from: { id: chatId, username: `user${chatId}` }, chat: { id: chatId, type: 'private' }, text, ...extra } };
  }
  /** Нажатие кнопки под сообщением бота. */
  tap(chatId: number, data: string, messageId = 1): TelegramUpdate {
    this.seq += 1;
    return { update_id: this.seq, callback_query: { id: `cb${this.seq}`, from: { id: chatId, username: `user${chatId}` }, data, message: { message_id: messageId, chat: { id: chatId, type: 'private' } } } };
  }
  /** Тексты ответов, отправленных в чат. */
  to(chatId: number): string[] {
    return this.sent.filter((m) => m.chatId === chatId).map((m) => m.text);
  }
  last(chatId: number): string {
    return this.to(chatId).at(-1) ?? '';
  }
}

export interface TestEnv {
  app: FastifyInstance;
  db: Db;
  /** Подключение владельца схемы: для очистки и проверок, которые прикладной роли недоступны. */
  owner: Db;
  config: Config;
  notifier: MemoryNotifier;
  telegram: FakeTelegramApi;
  invoiceReader: FakeInvoiceReader;
  /** Отправитель вебхуков без сети: запоминает запросы. */
  webhooks: FakeWebhookSender;
  exchange: SwitchTransport;
  /** Почта без сети: запоминает письма поставщикам. */
  mailer: FakeMailer;
  /** Погода без сети: отдаёт заготовленные сутки. */
  weather: FakeWeatherProvider;
  /** Кабинет поставщика без сети. */
  portal: FakePortal;
  /** Зависимости приложения для вызова сервисов напрямую (например, очереди вебхуков). */
  deps: Deps;
  bot: TelegramBot;
  /** Написать боту от имени чата и дождаться ответа. */
  chat(chatId: number, text: string, extra?: Partial<TelegramUpdate['message'] & object>): Promise<string>;
  clock: { now: Date; advance(ms: number): void };
  /** Дождаться фонового пересчёта стоп-листа. */
  settle(): Promise<void>;
  /** Сбросить кеш расчётов после правки базы в обход приложения. */
  forget(): void;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createTestEnv(overrides: Record<string, string> = {}, now = new Date('2026-10-08T09:00:00Z')): Promise<TestEnv> {
  process.env.NODE_ENV = 'test';
  loadEnvFile('test');
  const config = parseConfig({
    ...process.env,
    RATE_LIMIT_MAX: '100000',
    LOGIN_RATE_LIMIT_MAX: '1000',
    ...overrides,
  });
  const appHandle: DbHandle = createDb(config.databaseUrl, 5);
  const ownerHandle: DbHandle = createDb(config.migrationDatabaseUrl, 2);
  const clock = {
    now,
    advance(ms: number) {
      this.now = new Date(this.now.getTime() + ms);
    },
  };
  const notifier = new MemoryNotifier();
  const telegram = new FakeTelegramApi();
  const invoiceReader = new FakeInvoiceReader();
  const webhooks = new FakeWebhookSender();
  const exchange = new SwitchTransport();
  const mailer = new FakeMailer();
  const weather = new FakeWeatherProvider();
  const portal = new FakePortal();
  const app = await buildApp({ db: appHandle.db, config, clock: () => clock.now, notifier, telegram, invoiceReader, webhookSender: webhooks, exchangeTransport: exchange, mailer, weather, supplierPortal: portal });
  await app.ready();

  const runtime: Deps = { db: appHandle.db, config, clock: () => clock.now, notifier, telegram, webhookSender: webhooks, exchangeTransport: exchange, mailer, weather, supplierPortal: portal, log: console };
  let bot = new TelegramBot(runtime, telegram);
  await bot.prepare();
  return {
    app,
    db: appHandle.db,
    owner: ownerHandle.db,
    config,
    notifier,
    telegram,
    invoiceReader,
    webhooks,
    exchange,
    mailer,
    weather,
    portal,
    deps: runtime,
    get bot() {
      return bot;
    },
    async chat(chatId, text, extra) {
      const before = telegram.to(chatId).length;
      await bot.handleUpdate(telegram.say(chatId, text, extra));
      return telegram.to(chatId).slice(before).join('\n');
    },
    clock,
    settle: () => drainStopListSync(runtime),
    forget: () => invalidateSnapshots(appHandle.db),
    async reset() {
      await drainStopListSync(runtime);
      invalidateSnapshots(appHandle.db);
      const rows = await sql<{ tablename: string }>`
        select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'`.execute(
        ownerHandle.db,
      );
      const list = rows.rows.map((r) => `"${r.tablename}"`).join(', ');
      await sql.raw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`).execute(ownerHandle.db);
      await sql`INSERT INTO organizations (id, name) VALUES (${DEFAULT_ORG_ID}, ${DEFAULT_ORG_NAME})`.execute(ownerHandle.db);
      notifier.messages.length = 0;
      telegram.sent.length = 0;
      telegram.edits.length = 0;
      telegram.answers.length = 0;
      invoiceReader.result = { number: null, date: null, supplier: null, total: null, lines: [], warnings: [] };
      invoiceReader.failure = null;
      invoiceReader.calls.length = 0;
      webhooks.requests.length = 0;
      exchange.current = null;
      mailer.sent.length = 0;
      mailer.failure = null;
      weather.reset();
      portal.pushes.length = 0;
      portal.failure = null;
      resetForecastCache();
      webhooks.failNext = 0;
      webhooks.failStatus = null;
      webhooks.status = 200;
      // у бота свои счётчики частоты и неудачных кодов: каждому тесту нужен чистый
      bot = new TelegramBot(runtime, telegram);
      await bot.prepare();
      clock.now = now;
    },
    async close() {
      await drainStopListSync(runtime);
      await app.close();
      await appHandle.close();
      await ownerHandle.close();
    },
  };
}

let seq = 0;

export async function createUser(
  env: TestEnv,
  opts: { role?: Role; email?: string; fullName?: string; password?: string; locationIds?: string[]; isActive?: boolean } = {},
): Promise<{ id: string; email: string; password: string }> {
  seq += 1;
  const email = opts.email ?? `user${seq}@example.ru`;
  const password = opts.password ?? TEST_PASSWORD;
  const row = await env.db
    .insertInto('users')
    .values({
      email,
      full_name: opts.fullName ?? `Тестовый Пользователь ${seq}`,
      password_hash: await hashPassword(password),
      role: opts.role ?? 'admin',
      is_active: opts.isActive ?? true,
      locked_until: null,
      last_login_at: null,
      password_changed_at: new Date(env.clock.now.getTime() - 60_000),
      created_at: env.clock.now,
      updated_at: env.clock.now,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  if (opts.locationIds?.length) {
    await env.db
      .insertInto('user_locations')
      .values(opts.locationIds.map((location_id) => ({ user_id: row.id, location_id })))
      .execute();
  }
  return { id: row.id, email, password };
}

export interface Session {
  token: string;
  cookie: string;
  userId: string;
}

export async function loginAs(env: TestEnv, user: { email: string; password: string }): Promise<Session> {
  const res = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password: user.password } });
  if (res.statusCode !== 200) throw new Error(`Вход не удался: ${res.statusCode} ${res.body}`);
  const body = res.json();
  const cookie = res.cookies.find((c) => c.name === 'zapas_rt');
  return { token: body.accessToken, cookie: cookie?.value ?? '', userId: body.user.id };
}

export function call(env: TestEnv, token: string | null) {
  return async (method: InjectOptions['method'], url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    env.app.inject({
      method,
      url,
      payload: payload as InjectOptions['payload'],
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    });
}
