import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const WEAK_SECRETS = /change.?me|secret|example|password|default|12345678/i;

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),

  DATABASE_URL: z.string().min(1),
  MIGRATION_DATABASE_URL: z.string().min(1).optional(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DB_APP_ROLE: z
    .string()
    .regex(/^[a-z_][a-z0-9_]{0,62}$/)
    .default('zapas_app'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET должен быть не короче 32 символов'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  COOKIE_SECURE: bool.optional(),

  BUSINESS_TZ: z.string().default('Europe/Moscow'),
  APP_ORIGINS: z.string().default(''),
  TRUST_PROXY: z.string().default('false'),
  WEB_DIST: z.string().optional(),
  RATE_LIMIT_MAX: z.coerce.number().int().min(10).max(100000).default(600),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1000).default(10),
  ENABLE_DOCS: bool.default(false),
  SCHEDULER: bool.optional(),
  STOPLIST_SYNC_DELAY_MS: z.coerce.number().int().min(0).max(60_000).optional(),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_COMMANDS: bool.optional(),

  // Погода для прогноза спроса (Open-Meteo): уходят только координаты точек, у которых они указаны
  WEATHER_ENABLED: bool.default(true),

  // Письма поставщикам с заказами. Без SMTP заказ отправляется без письма, текст можно скопировать
  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().optional(),

  // Вебхуки: куда разрешено слать события. По умолчанию только https и только внешние адреса
  WEBHOOK_ALLOW_PRIVATE: bool.default(false),
  WEBHOOK_ALLOW_HTTP: bool.optional(),

  // Распознавание фото накладной через Claude. Без ключа загрузка фото выключена, УПД в XML работает всегда
  ANTHROPIC_API_KEY: z.string().optional(),
  INVOICE_MODEL: z.string().default('claude-opus-5-5'),
});

export interface Config {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  migrationDatabaseUrl: string;
  dbPoolMax: number;
  dbAppRole: string;
  jwtSecret: string;
  accessTokenTtl: number;
  refreshTokenTtlDays: number;
  cookieSecure: boolean;
  businessTz: string;
  appOrigins: string[];
  trustProxy: boolean | number | string[];
  webDist: string | null;
  rateLimitMax: number;
  loginRateLimitMax: number;
  enableDocs: boolean;
  scheduler: boolean;
  /** Через сколько после операции пересчитывать стоп-лист. Частые операции склеиваются в один пересчёт. */
  stopListSyncDelayMs: number;
  /** commands: бот отвечает на команды (опрос Telegram). Выключается, если опрос ведёт другой экземпляр. */
  telegram: { token: string; chatId: string; commands: boolean } | null;
  invoicePhoto: { apiKey: string; model: string } | null;
  webhooks: { allowPrivate: boolean; allowHttp: boolean };
  /** Загружать ли погоду из внешнего сервиса. */
  weatherEnabled: boolean;
  /** Почтовый сервер для писем поставщикам. */
  smtp: { url: string; from: string } | null;
}

/** Подгружает .env из рабочей папки. В тестах берётся .env.test. Уже заданные переменные не трогаем. */
export function loadEnvFile(env: string | undefined = process.env.NODE_ENV): void {
  const file = resolve(process.cwd(), env === 'test' ? '.env.test' : '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

function assertTimeZone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
  } catch {
    throw new Error(`BUSINESS_TZ: неизвестный часовой пояс «${tz}»`);
  }
}

/**
 * Откуда брать настоящий адрес клиента. «true» доверяет любому заголовку X-Forwarded-For, и клиент
 * может подделать адрес, поэтому для боевого режима лучше указать число прыжков (например, 1 для одного
 * обратного прокси) или список адресов прокси.
 */
function parseTrustProxy(value: string): boolean | number | string[] {
  const v = value.trim().toLowerCase();
  if (v === '' || v === 'false' || v === '0') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  const list = value.split(',').map((x) => x.trim()).filter(Boolean);
  const ok = list.every((x) => /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(x) || ['loopback', 'linklocal', 'uniquelocal'].includes(x));
  if (!ok) throw new Error('TRUST_PROXY: ожидается true, false, число прыжков или список адресов прокси');
  return list;
}

export function parseConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Некорректная конфигурация:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  assertTimeZone(e.BUSINESS_TZ);

  const production = e.NODE_ENV === 'production';
  if (production && WEAK_SECRETS.test(e.JWT_SECRET)) {
    throw new Error('JWT_SECRET похож на значение по умолчанию. Сгенерируйте случайную строку: openssl rand -base64 48');
  }
  if (production && new Set(e.JWT_SECRET).size < 12) {
    throw new Error('JWT_SECRET слишком однообразный');
  }
  if ((e.TELEGRAM_BOT_TOKEN && !e.TELEGRAM_CHAT_ID) || (!e.TELEGRAM_BOT_TOKEN && e.TELEGRAM_CHAT_ID)) {
    throw new Error('TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID задаются вместе');
  }

  if (Boolean(e.SMTP_URL) !== Boolean(e.SMTP_FROM)) throw new Error('SMTP_URL и SMTP_FROM задаются вместе');
  if (e.SMTP_URL && !/^smtps?:\/\/[^\s]+$/.test(e.SMTP_URL)) throw new Error('SMTP_URL: ожидается адрес вида smtps://логин:пароль@сервер:465');
  if (e.SMTP_FROM && !/^[^\r\n<>]*(<[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/.test(e.SMTP_FROM)) {
    throw new Error('SMTP_FROM: ожидается адрес вида zakaz@example.ru или «Запас <zakaz@example.ru>»');
  }

  const origins = e.APP_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((o) => {
      const url = new URL(o);
      return url.origin;
    });

  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL ?? (e.NODE_ENV === 'test' ? 'silent' : 'info'),
    databaseUrl: e.DATABASE_URL,
    migrationDatabaseUrl: e.MIGRATION_DATABASE_URL ?? e.DATABASE_URL,
    dbPoolMax: e.DB_POOL_MAX,
    dbAppRole: e.DB_APP_ROLE,
    jwtSecret: e.JWT_SECRET,
    accessTokenTtl: e.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlDays: e.REFRESH_TOKEN_TTL_DAYS,
    cookieSecure: e.COOKIE_SECURE ?? production,
    businessTz: e.BUSINESS_TZ,
    appOrigins: origins,
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    webDist: e.WEB_DIST ?? null,
    rateLimitMax: e.RATE_LIMIT_MAX,
    loginRateLimitMax: e.LOGIN_RATE_LIMIT_MAX,
    enableDocs: e.ENABLE_DOCS && !production,
    scheduler: e.SCHEDULER ?? e.NODE_ENV !== 'test',
    stopListSyncDelayMs: e.STOPLIST_SYNC_DELAY_MS ?? (e.NODE_ENV === 'test' ? 0 : 1500),
    weatherEnabled: e.WEATHER_ENABLED,
    smtp: e.SMTP_URL && e.SMTP_FROM ? { url: e.SMTP_URL, from: e.SMTP_FROM } : null,
    webhooks: { allowPrivate: e.WEBHOOK_ALLOW_PRIVATE, allowHttp: e.WEBHOOK_ALLOW_HTTP ?? !production },
    invoicePhoto: e.ANTHROPIC_API_KEY ? { apiKey: e.ANTHROPIC_API_KEY, model: e.INVOICE_MODEL } : null,
    telegram:
      e.TELEGRAM_BOT_TOKEN && e.TELEGRAM_CHAT_ID
        ? { token: e.TELEGRAM_BOT_TOKEN, chatId: e.TELEGRAM_CHAT_ID, commands: e.TELEGRAM_COMMANDS ?? e.NODE_ENV !== 'test' }
        : null,
  };
}
