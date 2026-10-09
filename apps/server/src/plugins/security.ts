import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Config } from '../config';
import { forbidden } from '../lib/errors';

// камера нужна сканеру штрихкодов, но только самому приложению, не встроенным и чужим страницам
const PERMISSIONS_POLICY = 'camera=(self), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()';

export const securityPlugin = fp<{ config: Config }>(async (app: FastifyInstance, { config }) => {
  const production = config.env === 'production';

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(config.cookieSecure ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    strictTransportSecurity: production && config.cookieSecure ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    frameguard: { action: 'deny' },
    hidePoweredBy: true,
  });

  if (config.appOrigins.length > 0) {
    await app.register(cors, {
      origin: config.appOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
      maxAge: 600,
    });
  }

  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitMax,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: (_req, ctx) => {
      const err = new Error('Слишком много запросов, повторите позже') as Error & { statusCode: number };
      err.statusCode = 429;
      return Object.assign(err, { retryAfterSeconds: Math.ceil(ctx.ttl / 1000) });
    },
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('Permissions-Policy', PERMISSIONS_POLICY);
    reply.header('X-Request-Id', req.id);
    if (req.url.startsWith('/api')) {
      reply.header('Cache-Control', 'no-store');
      reply.header('Pragma', 'no-cache');
    }
  });
});

/**
 * Запросы, которые меняют состояние по cookie (обновление и выход), принимаем только со своих страниц.
 * Заголовок Origin браузер ставит сам и скрипт его не подделает.
 */
export function assertTrustedOrigin(req: FastifyRequest, config: Config): void {
  const origin = req.headers.origin;
  if (!origin) return;
  if (config.appOrigins.includes(origin)) return;
  const host = req.headers.host;
  try {
    if (host && new URL(origin).host === host) return;
  } catch {
    // нечитаемый Origin отклоняем ниже
  }
  throw forbidden('Запрос с чужого источника', 'bad_origin');
}
