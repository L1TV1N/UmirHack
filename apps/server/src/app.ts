import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import { useRussianErrors } from '@zapas/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Deps } from './lib/context';
import { adminRoutes } from './modules/admin/routes';
import { invoiceRoutes } from './modules/invoices/routes';
import { forecastRoutes } from './modules/forecast/routes';
import { catalogImportRoutes } from './modules/catalog/import-routes';
import { integrationRoutes } from './modules/integrations/routes';
import { orderRoutes } from './modules/orders/routes';
import { traceabilityRoutes } from './modules/traceability/routes';
import { telegramRoutes } from './modules/telegram/routes';
import { analyticsRoutes } from './modules/analytics/routes';
import { authRoutes } from './modules/auth/routes';
import { catalogRoutes } from './modules/catalog/routes';
import { dishRoutes } from './modules/dishes/routes';
import { inventoryRoutes } from './modules/inventory/routes';
import { locationRoutes } from './modules/locations/routes';
import { promotionRoutes } from './modules/promotions/routes';
import { reportRoutes } from './modules/reports/routes';
import { stockRoutes } from './modules/stock/routes';
import { stopListRoutes } from './modules/stoplist/routes';
import { userRoutes } from './modules/users/routes';
import { accessPlugin, open } from './plugins/access';
import { errorsPlugin, send } from './plugins/errors';
import { invalidateSnapshots } from './modules/analytics/snapshot';
import { securityPlugin } from './plugins/security';
import { sql } from 'kysely';

/** Доверяем заданному числу ближайших прокси, дальше по цепочке заголовку X-Forwarded-For не верим. */
const hopsTrust = (hops: number) => (_address: string, hop: number) => hop < hops;

export async function buildApp(input: Omit<Deps, 'log'>): Promise<FastifyInstance> {
  useRussianErrors();
  const { config } = input;

  const app = Fastify({
    bodyLimit: 256 * 1024,
    trustProxy: typeof config.trustProxy === 'number' ? hopsTrust(config.trustProxy) : config.trustProxy,
    genReqId: () => randomUUID(),
    requestTimeout: 30_000,
    frameworkErrors: (error, req, reply) => {
      const status = (error as { statusCode?: number }).statusCode ?? 400;
      return send(reply, req, status, status === 404 ? 'not_found' : 'bad_request', status === 404 ? 'Не найдено' : 'Некорректный запрос');
    },
    logger: {
      level: config.logLevel,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-api-key"]',
          'res.headers["set-cookie"]',
        ],
        censor: '[скрыто]',
      },
      serializers: {
        req: (req) => ({ method: req.method, url: req.url.split('?')[0], remoteAddress: req.ip }),
      },
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  const deps: Deps = { ...input, log: app.log };

  if (config.enableDocs) {
    await app.register(swagger, {
      openapi: { info: { title: 'Запас API', version: '1.0.0' } },
      transform: jsonSchemaTransform,
    });
  }

  await app.register(errorsPlugin);
  await app.register(securityPlugin, { config });
  await app.register(cookie);
  await app.register(accessPlugin, { deps });

  // Любая успешная запись может изменить остатки, цены, рецептуры или настройки: кеш расчётов сбрасываем,
  // пока ответ не ушёл клиенту, иначе следующий запрос мог бы увидеть старые цифры
  app.addHook('onSend', async (req, reply) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && reply.statusCode < 400 && !req.url.startsWith('/api/pos/')) invalidateSnapshots(deps.db);
  });

  app.addHook('onRequest', async (req) => {
    req.meta = { ip: req.ip, userAgent: req.headers['user-agent'] ?? null, requestId: req.id };
  });

  await app.register(
    async (api) => {
      api.get('/health', { config: { ...open, rateLimit: false } }, async () => ({ status: 'ok' }));
      api.get('/health/ready', { config: { ...open, rateLimit: false } }, async (_req, reply) => {
        try {
          await sql`select 1`.execute(deps.db);
          return { status: 'ready' };
        } catch {
          return reply.status(503).send({ status: 'unavailable' });
        }
      });
      if (config.enableDocs) {
        api.get('/docs/openapi.json', { config: open, schema: { hide: true } }, async () => app.swagger());
      }
      await api.register(authRoutes(deps));
      await api.register(userRoutes(deps));
      await api.register(locationRoutes(deps));
      await api.register(catalogRoutes(deps));
      await api.register(catalogImportRoutes(deps));
      await api.register(dishRoutes(deps));
      await api.register(stockRoutes(deps));
      await api.register(inventoryRoutes(deps));
      await api.register(promotionRoutes(deps));
      await api.register(stopListRoutes(deps));
      await api.register(analyticsRoutes(deps));
      await api.register(reportRoutes(deps));
      await api.register(adminRoutes(deps));
      await api.register(telegramRoutes(deps));
      await api.register(invoiceRoutes(deps));
      await api.register(traceabilityRoutes(deps));
      await api.register(integrationRoutes(deps));
      await api.register(orderRoutes(deps));
      await api.register(forecastRoutes(deps));
    },
    { prefix: '/api' },
  );

  const dist = config.webDist ? resolve(config.webDist) : null;
  const hasSpa = dist !== null && existsSync(resolve(dist, 'index.html'));
  if (hasSpa) {
    await app.register(fastifyStatic, {
      root: dist,
      index: false,
      wildcard: false,
      setHeaders(reply, path) {
        if (path.includes('/assets/')) void reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        else void reply.header('Cache-Control', 'no-cache');
      },
    });
  }
  app.setNotFoundHandler((req, reply) => {
    const wantsPage =
      hasSpa && req.method === 'GET' && !req.url.startsWith('/api') && (req.headers.accept ?? '').includes('text/html');
    if (wantsPage) return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    return send(reply, req, 404, 'not_found', 'Не найдено');
  });

  return app;
}
