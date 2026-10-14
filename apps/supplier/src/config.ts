import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().default(3100),
  /** Файл базы. В тестах :memory:. */
  SUPPLIER_DB_FILE: z.string().default('./data/supplier.db'),
  /** Подпись сессий кабинета. Не короче 32 символов. */
  SUPPLIER_SESSION_SECRET: z.string().min(32).default('dev-only-supplier-session-secret-change-me-0000'),
  /** Общий секрет с «Запасом»: им подписываются запросы в обе стороны. */
  SUPPLIER_PORTAL_SECRET: z.string().min(16).default('dev-only-portal-secret-change-me'),
  /** Где «Запас», например http://127.0.0.1:3000. Без него кабинет работает, но ответить покупателю не может. */
  ZAPAS_URL: z.string().default('http://127.0.0.1:3000'),
  /** Под каким путём живёт кабинет за обратным прокси. */
  BASE_PATH: z.string().default('/supplier'),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  WEB_DIST: z.string().optional(),
  /** Минимальная пауза между входами с одним адресом. */
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().default(20),
});

export type Config = ReturnType<typeof parseConfig>;

export function parseConfig(env: Record<string, string | undefined> = process.env) {
  const e = schema.parse(env);
  const production = e.NODE_ENV === 'production';
  if (production && (e.SUPPLIER_SESSION_SECRET.startsWith('dev-only') || e.SUPPLIER_PORTAL_SECRET.startsWith('dev-only'))) {
    throw new Error('В продакшене задайте SUPPLIER_SESSION_SECRET и SUPPLIER_PORTAL_SECRET');
  }
  const base = e.BASE_PATH === '/' ? '' : `/${e.BASE_PATH.replace(/^\/+|\/+$/g, '')}`;
  return {
    production,
    test: e.NODE_ENV === 'test',
    host: e.HOST,
    port: e.PORT,
    dbFile: e.SUPPLIER_DB_FILE,
    sessionSecret: e.SUPPLIER_SESSION_SECRET,
    portalSecret: e.SUPPLIER_PORTAL_SECRET,
    zapasUrl: e.ZAPAS_URL.replace(/\/$/, ''),
    basePath: base,
    cookieSecure: e.COOKIE_SECURE ?? production,
    webDist: e.WEB_DIST ?? null,
    loginRateLimitMax: e.LOGIN_RATE_LIMIT_MAX,
  };
}
