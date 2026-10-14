import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isValidInn, ruDate, type PortalOrderPush } from '@zapas/shared';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler, type FastifyPluginAsyncZod, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from './config';
import type { Db } from './db';
import { burnVerify, hashPassword, readSession, SESSION_COOKIE, SESSION_MAX_AGE, signSession, verifyPassword, verifySignature } from './security';
import * as store from './store';
import type { Stage } from './types';
import type { ZapasClient } from './zapas';

export interface Deps {
  db: Db;
  config: Config;
  zapas: ZapasClient;
  clock: () => Date;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const text = (max: number) => z.string().trim().min(1).max(max).refine((v) => !/[\u0000-\u001f\u007f]/.test(v), 'Недопустимые символы');
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), 'Недопустимые символы')
    .optional()
    .transform((v) => (v ? v : undefined));
const email = z.string().trim().toLowerCase().max(254).pipe(z.email());
const password = z.string().min(10, 'Не короче 10 знаков').max(128);

const registerBody = z.strictObject({
  company: text(160),
  inn: z.string().trim().refine(isValidInn, 'Некорректный ИНН: 10 или 12 цифр с верной контрольной цифрой'),
  contactName: text(120),
  email,
  phone: optionalText(40),
  password,
});
const loginBody = z.strictObject({ email, password: z.string().min(1).max(128) });
const profileBody = z.strictObject({ company: text(160), contactName: text(120), phone: optionalText(40) });
const passwordBody = z.strictObject({ currentPassword: z.string().min(1).max(128), newPassword: password });
const idParam = z.strictObject({ id: z.coerce.number().int().positive() });
const stageQuery = z.strictObject({ stage: z.enum(['new', 'work', 'shipped', 'closed', 'all']).default('all') });
const actionBody = z.strictObject({
  note: optionalText(300),
  deliveryOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в виде ГГГГ-ММ-ДД')
    .optional(),
});

const pushSchema = z.object({
  externalId: z.uuid(),
  number: text(40),
  status: text(30),
  statusLabel: text(60),
  supplierInn: z.string().refine(isValidInn),
  supplierName: text(200),
  buyer: z.object({ organization: text(200), location: text(200), address: z.string().max(300).nullable() }),
  expectedOn: z.string().nullable(),
  comment: z.string().max(1000).nullable(),
  total: z.number().min(0),
  lines: z
    .array(z.object({ sku: z.string().max(60), name: text(200), unit: z.enum(['kg', 'l', 'pcs']), quantity: z.number().positive(), unitCost: z.number().min(0), receivedQty: z.number().min(0) }))
    .min(1)
    .max(300),
  buyerNote: z.string().max(500).nullable(),
  updatedAt: z.string(),
});

export async function buildApp(deps: Deps) {
  const { db, config, zapas, clock } = deps;
  const app = fastify({ logger: !config.test, trustProxy: true, bodyLimit: 512 * 1024 }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], fontSrc: ["'self'"], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"] } },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: true, max: 600, timeWindow: '1 minute' });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details }, requestId: req.id });
    const e = err as { validation?: unknown; statusCode?: number; message?: string; code?: string };
    if (e.validation || (typeof e.statusCode === 'number' && e.statusCode < 500 && e.statusCode >= 400)) {
      const status = e.statusCode ?? 400;
      const details = Array.isArray(e.validation) ? (e.validation as { message?: string; instancePath?: string }[]).map((v) => ({ path: v.instancePath, message: v.message })) : undefined;
      return reply.status(status).send({ error: { code: status === 429 ? 'rate_limited' : 'bad_request', message: status === 429 ? 'Слишком много запросов, повторите позже' : (details?.[0]?.message ?? 'Неверный запрос'), details }, requestId: req.id });
    }
    req.log.error({ err }, 'ошибка запроса');
    return reply.status(500).send({ error: { code: 'internal', message: 'Внутренняя ошибка' }, requestId: req.id });
  });

  const cookieOptions = { httpOnly: true, secure: config.cookieSecure, sameSite: 'strict' as const, path: config.basePath || '/' };

  async function account(req: FastifyRequest): Promise<NonNullable<ReturnType<typeof store.accountById>>> {
    const id = await readSession(config.sessionSecret, req.cookies[SESSION_COOKIE]);
    const row = id === null ? undefined : store.accountById(db, id);
    if (!row) throw new HttpError(401, 'unauthorized', 'Нужно войти');
    return row;
  }

  async function startSession(reply: FastifyReply, id: number): Promise<void> {
    void reply.setCookie(SESSION_COOKIE, await signSession(config.sessionSecret, id), { ...cookieOptions, maxAge: SESSION_MAX_AGE });
  }

  const origin = (req: FastifyRequest): void => {
    // вход и регистрация меняют состояние: чужая страница не должна уметь их вызывать
    const o = req.headers.origin;
    if (o && req.headers.host && new URL(o).host !== req.headers.host) throw new HttpError(403, 'bad_origin', 'Запрос с чужого адреса');
  };

  const apiPlugin: FastifyPluginAsyncZod = async (api) => {
      api.get('/health', async () => ({ status: 'ok' }));

      // Вход и регистрация

      api.post('/auth/register', { config: { rateLimit: { max: config.loginRateLimitMax, timeWindow: '1 minute' } }, schema: { body: registerBody } }, async (req, reply) => {
        origin(req);
        const b = req.body;
        if (store.accountByInn(db, b.inn)) throw new HttpError(409, 'duplicate_inn', 'Компания с таким ИНН уже зарегистрирована', [{ path: 'inn', message: 'ИНН уже занят' }]);
        if (store.accountByEmail(db, b.email)) throw new HttpError(409, 'duplicate_email', 'Эта почта уже используется', [{ path: 'email', message: 'Почта уже занята' }]);
        const row = store.insertAccount(db, { inn: b.inn, company: b.company, contactName: b.contactName, email: b.email, phone: b.phone ?? null, passwordHash: await hashPassword(b.password) }, clock());
        await startSession(reply, row.id);
        // спрашиваем «Запас», знает ли он такого поставщика: ответ нужен только для подсказки на экране
        const known = await zapas.lookup(b.inn);
        void reply.status(201);
        return { account: store.toAccountDto(db, row), matched: known ? { known: known.known, name: known.name, buyers: known.buyers } : null };
      });

      api.post('/auth/login', { config: { rateLimit: { max: config.loginRateLimitMax, timeWindow: '1 minute' } }, schema: { body: loginBody } }, async (req, reply) => {
        origin(req);
        const now = clock();
        const row = store.accountByEmail(db, req.body.email);
        const fail = (): never => {
          throw new HttpError(401, 'invalid_credentials', 'Неверная почта или пароль, либо запись временно заблокирована');
        };
        if (!row) {
          await burnVerify(req.body.password);
          return fail();
        }
        if (row.locked_until && new Date(row.locked_until).getTime() > now.getTime()) {
          await burnVerify(req.body.password);
          return fail();
        }
        if (!(await verifyPassword(row.password_hash, req.body.password))) {
          store.registerFailure(db, row.id, now);
          return fail();
        }
        store.touchLogin(db, row.id, now);
        await startSession(reply, row.id);
        return { account: store.toAccountDto(db, row) };
      });

      api.post('/auth/logout', async (_req, reply) => {
        void reply.clearCookie(SESSION_COOKIE, cookieOptions);
        return reply.status(204).send();
      });

      api.get('/auth/me', async (req) => ({ account: store.toAccountDto(db, await account(req)) }));

      api.put('/profile', { schema: { body: profileBody } }, async (req) => {
        const row = await account(req);
        store.updateProfile(db, row.id, { company: req.body.company, contactName: req.body.contactName, phone: req.body.phone ?? null });
        return { account: store.toAccountDto(db, store.accountById(db, row.id) as NonNullable<ReturnType<typeof store.accountById>>) };
      });

      api.post('/auth/change-password', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } }, schema: { body: passwordBody } }, async (req, reply) => {
        const row = await account(req);
        if (!(await verifyPassword(row.password_hash, req.body.currentPassword))) throw new HttpError(400, 'wrong_password', 'Текущий пароль указан неверно', [{ path: 'currentPassword', message: 'Неверный пароль' }]);
        store.setPasswordHash(db, row.id, await hashPassword(req.body.newPassword));
        return reply.status(204).send();
      });

      // Заказы

      api.get('/dashboard', async (req) => store.dashboard(db, (await account(req)).inn, clock()));

      api.get('/orders', { schema: { querystring: stageQuery } }, async (req) => store.listOrders(db, (await account(req)).inn, req.query.stage as Stage | 'all'));

      api.get('/orders/:id', { schema: { params: idParam } }, async (req) => {
        const acc = await account(req);
        const row = store.orderRow(db, acc.inn, req.params.id);
        if (!row) throw new HttpError(404, 'not_found', 'Заказ не найден');
        store.markViewed(db, row.id, clock());
        return store.orderDetail(db, store.orderRow(db, acc.inn, row.id) as NonNullable<ReturnType<typeof store.orderRow>>);
      });

      const act = (action: 'confirm' | 'decline' | 'ship') =>
        async (req: FastifyRequest<{ Params: { id: number }; Body: z.infer<typeof actionBody> }>) => {
          const acc = await account(req);
          const row = store.orderRow(db, acc.inn, req.params.id);
          if (!row) throw new HttpError(404, 'not_found', 'Заказ не найден');
          const detail = store.orderDetail(db, row);
          if (!detail.actions.includes(action)) throw new HttpError(409, 'bad_transition', `Заказ уже «${row.status_label.toLowerCase()}», это действие недоступно`);
          const note = req.body.note;
          if (action === 'decline' && !note) throw new HttpError(400, 'note_required', 'Укажите причину отказа', [{ path: 'note', message: 'Обязательно' }]);
          const status = action === 'confirm' ? 'confirmed' : action === 'decline' ? 'declined' : 'shipped';
          // покупатель узнаёт первым: если «Запас» недоступен или не принял статус, у нас ничего не меняется
          const res = await zapas.pushStatus({ externalId: row.external_id, status, note, deliveryOn: req.body.deliveryOn });
          if (!res.ok) throw new HttpError(res.status === 409 ? 409 : 502, res.status === 409 ? 'rejected' : 'zapas_unavailable', res.error);
          const label = status === 'confirmed' ? 'Подтверждён поставщиком' : status === 'declined' ? 'Поставщик отказал' : 'Отгружен';
          const verb = status === 'confirmed' ? 'Вы подтвердили заказ' : status === 'declined' ? 'Вы отказали в поставке' : 'Вы отгрузили заказ';
          store.applySupplierAction(db, row.id, { status, label, note: note ?? null, deliveryOn: req.body.deliveryOn ?? null }, acc.company, `${verb}${req.body.deliveryOn ? `, поставка ${ruDate(req.body.deliveryOn)}` : ''}${note ? `: ${note}` : ''}`, clock());
          return store.orderDetail(db, store.orderRow(db, acc.inn, row.id) as NonNullable<ReturnType<typeof store.orderRow>>);
        };
      for (const action of ['confirm', 'decline', 'ship'] as const) {
        api.post(`/orders/:id/${action}`, { schema: { params: idParam, body: actionBody } }, act(action) as never);
      }

      // Спросить «Запас», что с заказом сейчас: покупатель мог принять поставку или оставить замечание
      api.post('/orders/:id/refresh', { schema: { params: idParam } }, async (req) => {
        const acc = await account(req);
        const row = store.orderRow(db, acc.inn, req.params.id);
        if (!row) throw new HttpError(404, 'not_found', 'Заказ не найден');
        const fresh = await zapas.pull(row.external_id);
        if (!fresh) throw new HttpError(502, 'zapas_unavailable', '«Запас» не отвечает, попробуйте через минуту');
        store.upsertOrder(db, fresh, clock());
        return store.orderDetail(db, store.orderRow(db, acc.inn, row.id) as NonNullable<ReturnType<typeof store.orderRow>>);
      });

      api.get('/buyers', async (req) => store.buyers(db, (await account(req)).inn));

      // Обмен с «Запасом»: заказы приходят сюда. Вход по подписи, а не по паролю.
      api.post('/gateway/orders', { config: { rateLimit: { max: 6000, timeWindow: '1 minute' } } }, async (req, reply) => {
        const parsed = pushSchema.safeParse(req.body);
        const ok = verifySignature(config.portalSecret, req.headers['x-zapas-timestamp'] as string | undefined, req.headers['x-zapas-signature'] as string | undefined, req.body, clock());
        if (!ok) throw new HttpError(401, 'bad_signature', 'Неверная подпись запроса');
        if (!parsed.success) throw new HttpError(400, 'bad_order', 'Заказ в неверном виде', parsed.error.issues.slice(0, 3).map((i) => ({ path: i.path.join('.'), message: i.message })));
        const res = store.upsertOrder(db, parsed.data as PortalOrderPush, clock());
        return reply.status(res.created ? 201 : 200).send({ ok: true, created: res.created });
      });
  };
  await app.register(apiPlugin, { prefix: `${config.basePath}/api` });

  const dist = config.webDist ? resolve(config.webDist) : null;
  const hasSpa = dist !== null && existsSync(resolve(dist, 'index.html'));
  if (hasSpa) {
    await app.register(fastifyStatic, {
      root: dist,
      prefix: `${config.basePath}/`,
      index: false,
      wildcard: false,
      setHeaders(res, path) {
        void res.header('Cache-Control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }
  app.setNotFoundHandler((req, reply) => {
    const underBase = config.basePath === '' || req.url === config.basePath || req.url.startsWith(`${config.basePath}/`);
    const page = hasSpa && underBase && req.method === 'GET' && !req.url.startsWith(`${config.basePath}/api`) && (req.headers.accept ?? '').includes('text/html');
    if (page) return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    return reply.status(404).send({ error: { code: 'not_found', message: 'Не найдено' }, requestId: req.id });
  });

  return app;
}

