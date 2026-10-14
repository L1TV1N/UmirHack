import {
  createWebhookBody,
  deliveriesQuery,
  idParam,
  posProductsQuery,
  updateWebhookBody,
  WEBHOOK_MAX_ENDPOINTS,
  type Page,
  type PosProductDto,
  type StopFeedDto,
  type WebhookCreatedDto,
  type WebhookDeliveryDto,
  type WebhookDto,
} from '@zapas/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Deps } from '../../lib/context';
import { encryptSecret, randomToken } from '../../lib/crypto';
import { conflict, forbidden, notFound, PG_FK_VIOLATION, badRequest, pgCode } from '../../lib/errors';
import { orgOf } from '../../lib/scope';
import { asPos, asUser, requirePrincipal, requireUser } from '../../plugins/access';
import { writeAudit } from '../audit/audit';
import { businessToday } from '../../lib/time';
import { nextMarkdowns } from '../promotions/markdown';
import { getStopList } from '../stoplist/service';
import { assertWebhookUrl } from './guard';
import { iikoStopList } from '../exchange/iiko';
import { enqueueFullState, publishStopList, sendPing, toDeliveryDto, toFeedEntries, toWebhookDto } from './service';

const newSecret = () => `whsec_${randomToken(32)}`;

export const integrationRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;
    const policy = deps.config.webhooks;

    const loadOne = async (id: string, org: string) => {
      const row = await db.selectFrom('webhook_endpoints').selectAll().where('org_id', '=', org).where('id', '=', id).executeTakeFirst();
      if (!row) throw notFound('Адрес');
      return row;
    };
    const dtoOf = async (id: string, org: string): Promise<WebhookDto> => {
      const row = await loadOne(id, org);
      const loc = row.location_id ? await db.selectFrom('locations').select('name').where('id', '=', row.location_id).executeTakeFirst() : null;
      return toWebhookDto(row, loc?.name ?? null);
    };

    app.get('/integrations/webhooks', { config: asUser('admin') }, async (req): Promise<WebhookDto[]> => {
      const rows = await db
        .selectFrom('webhook_endpoints as e')
        .where('e.org_id', '=', orgOf(requireUser(req)))
        .leftJoin('locations as l', 'l.id', 'e.location_id')
        .selectAll('e')
        .select('l.name as location_name')
        .orderBy('e.created_at')
        .execute();
      return rows.map((r) => toWebhookDto(r, r.location_name));
    });

    app.post('/integrations/webhooks', { config: asUser('admin'), schema: { body: createWebhookBody } }, async (req, reply) => {
      const principal = requireUser(req);
      const b = req.body;
      const url = assertWebhookUrl(b.url, policy);
      const count = await db.selectFrom('webhook_endpoints').select((eb) => eb.fn.countAll<string>().as('n')).where('org_id', '=', orgOf(principal)).executeTakeFirstOrThrow();
      if (Number(count.n) >= WEBHOOK_MAX_ENDPOINTS) throw conflict(`Адресов не больше ${WEBHOOK_MAX_ENDPOINTS}`, undefined, 'too_many_webhooks');
      const secret = newSecret();
      const now = deps.clock();
      try {
        const id = await db.transaction().execute(async (trx) => {
          const row = await trx
            .insertInto('webhook_endpoints')
            .values({
              org_id: orgOf(principal),
              name: b.name,
              url: url.toString(),
              secret_enc: encryptSecret(deps.config.jwtSecret, secret),
              events: b.events,
              location_id: b.locationId ?? null,
              created_by: principal.id,
              created_at: now,
              updated_at: now,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await writeAudit(trx, { action: 'webhook.create', entity: 'webhook', entityId: row.id, principal, meta: req.meta, at: now, details: { name: b.name, host: url.host, events: b.events, locationId: b.locationId ?? null } });
          return row.id;
        });
        // запоминаем, каким был стоп-лист к этому моменту: событием станет только то, что изменится после
        await publishStopList(deps, null).catch((err) => deps.log.error({ err }, 'не удалось запомнить состояние стоп-листа для вебхука'));
        const dto: WebhookCreatedDto = { ...(await dtoOf(id, orgOf(principal))), secret };
        return reply.status(201).send(dto);
      } catch (err) {
        if (pgCode(err) === PG_FK_VIOLATION) throw badRequest('Точка не найдена', [{ path: ['locationId'], message: 'Не найдена' }]);
        throw err;
      }
    });

    app.patch('/integrations/webhooks/:id', { config: asUser('admin'), schema: { params: idParam, body: updateWebhookBody } }, async (req): Promise<WebhookDto> => {
      const principal = requireUser(req);
      const b = req.body;
      const url = b.url !== undefined ? assertWebhookUrl(b.url, policy) : null;
      const now = deps.clock();
      try {
        await db.transaction().execute(async (trx) => {
          const current = await trx.selectFrom('webhook_endpoints').select(['id', 'url', 'enabled']).where('org_id', '=', orgOf(principal)).where('id', '=', req.params.id).forUpdate().executeTakeFirst();
          if (!current) throw notFound('Адрес');
          await trx
            .updateTable('webhook_endpoints')
            .set({
              ...(b.name !== undefined ? { name: b.name } : {}),
              ...(url ? { url: url.toString() } : {}),
              ...(b.events !== undefined ? { events: b.events } : {}),
              ...(b.locationId !== undefined ? { location_id: b.locationId } : {}),
              // включили вручную: серия неудач начинается заново
              ...(b.enabled === true ? { enabled: true, failure_streak: 0, disabled_reason: null } : {}),
              ...(b.enabled === false ? { enabled: false, disabled_reason: null } : {}),
              updated_at: now,
            })
            .where('id', '=', current.id)
            .execute();
          await writeAudit(trx, {
            action: 'webhook.update',
            entity: 'webhook',
            entityId: current.id,
            principal,
            meta: req.meta,
            at: now,
            details: { changes: { ...b, url: url ? url.host : undefined } },
          });
        });
      } catch (err) {
        if (pgCode(err) === PG_FK_VIOLATION) throw badRequest('Точка не найдена', [{ path: ['locationId'], message: 'Не найдена' }]);
        throw err;
      }
      return dtoOf(req.params.id, orgOf(principal));
    });

    app.post('/integrations/webhooks/:id/rotate-secret', { config: asUser('admin'), schema: { params: idParam } }, async (req) => {
      const principal = requireUser(req);
      const secret = newSecret();
      const now = deps.clock();
      await db.transaction().execute(async (trx) => {
        const res = await trx
          .updateTable('webhook_endpoints')
          .set({ secret_enc: encryptSecret(deps.config.jwtSecret, secret), updated_at: now })
          .where('id', '=', req.params.id)
          .returning('id')
          .executeTakeFirst();
        if (!res) throw notFound('Адрес');
        await writeAudit(trx, { action: 'webhook.rotate_secret', entity: 'webhook', entityId: res.id, principal, meta: req.meta, at: now, details: {} });
      });
      return { secret };
    });

    app.delete('/integrations/webhooks/:id', { config: asUser('admin'), schema: { params: idParam } }, async (req, reply) => {
      const principal = requireUser(req);
      const now = deps.clock();
      await db.transaction().execute(async (trx) => {
        const row = await trx.selectFrom('webhook_endpoints').select(['id', 'name', 'url']).where('org_id', '=', orgOf(principal)).where('id', '=', req.params.id).forUpdate().executeTakeFirst();
        if (!row) throw notFound('Адрес');
        await trx.deleteFrom('webhook_endpoints').where('id', '=', row.id).execute();
        await writeAudit(trx, { action: 'webhook.delete', entity: 'webhook', entityId: row.id, principal, meta: req.meta, at: now, details: { name: row.name, host: new URL(row.url).host } });
      });
      return reply.status(204).send();
    });

    // Проверка связи: одно событие «ping», один заход, результат сразу в ответе
    app.post('/integrations/webhooks/:id/test', { config: asUser('admin'), schema: { params: idParam } }, async (req): Promise<WebhookDeliveryDto> => {
      await loadOne(req.params.id, orgOf(requireUser(req)));
      return sendPing(deps, req.params.id);
    });

    // Первая синхронизация приёмника: текущее состояние стоп-листа по каждой точке, которую он слушает
    app.post('/integrations/webhooks/:id/sync', { config: asUser('admin'), schema: { params: idParam } }, async (req) => {
      const principal = requireUser(req);
      const row = await loadOne(req.params.id, orgOf(requireUser(req)));
      const queued = await enqueueFullState(deps, row);
      await writeAudit(db, { action: 'webhook.sync', entity: 'webhook', entityId: row.id, principal, meta: req.meta, at: deps.clock(), details: { queued } });
      return { queued };
    });

    app.get('/integrations/webhooks/:id/deliveries', { config: asUser('admin'), schema: { params: idParam, querystring: deliveriesQuery } }, async (req): Promise<WebhookDeliveryDto[]> => {
      await loadOne(req.params.id, orgOf(requireUser(req)));
      const rows = await db
        .selectFrom('webhook_deliveries')
        .select(['id', 'event', 'status', 'attempts', 'last_status', 'last_error', 'created_at', 'delivered_at', 'next_attempt_at'])
        .where('endpoint_id', '=', req.params.id)
        .orderBy('created_at', 'desc')
        .limit(req.query.limit)
        .execute();
      return rows.map(toDeliveryDto);
    });

    // Ленты для кассовой системы. Ключ кассы привязан к одной точке и видит только её.
    const posLocation = (req: Parameters<typeof requirePrincipal>[0]): string => {
      const principal = requirePrincipal(req);
      const locationId = principal.locationIds === 'all' ? undefined : principal.locationIds[0];
      if (principal.kind !== 'apikey' || !locationId) throw forbidden();
      return locationId;
    };

    app.get('/pos/stop-list', { config: asPos }, async (req): Promise<StopFeedDto> => {
      const locationId = posLocation(req);
      const list = await getStopList(deps, [locationId]);
      return { generatedAt: deps.clock().toISOString(), locationId, entries: await toFeedEntries(deps, list.entries) };
    });

    /** То же самое в виде ответа iikoCloud: для систем, которые уже умеют читать стоп-лист iiko. */
    app.get('/pos/stop-list/iiko', { config: asPos }, async (req) => {
      const locationId = posLocation(req);
      const list = await getStopList(deps, [locationId]);
      return iikoStopList(deps.clock().toISOString(), locationId, await toFeedEntries(deps, list.entries));
    });

    app.get('/pos/products', { config: asPos, schema: { querystring: posProductsQuery } }, async (req): Promise<Page<PosProductDto>> => {
      const locationId = posLocation(req);
      const { limit, offset } = req.query;
      const orgId = (await db.selectFrom('locations').select('org_id').where('id', '=', locationId).executeTakeFirstOrThrow()).org_id;
      const total = await db.selectFrom('products').select((eb) => eb.fn.countAll<string>().as('n')).where('org_id', '=', orgId).executeTakeFirstOrThrow();
      const rows = await db.selectFrom('products').select(['id', 'sku', 'barcode', 'name', 'unit', 'price', 'sellable', 'is_active']).where('org_id', '=', orgId).orderBy('sku').limit(limit).offset(offset).execute();
      const markdowns = await nextMarkdowns(db, locationId, businessToday(deps), rows.map((r) => r.id));
      return {
        items: rows.map((r) => ({ sku: r.sku, barcode: r.barcode, name: r.name, unit: r.unit, price: Number(r.price), markdown: markdowns.get(r.id) ?? null, sellable: r.sellable, isActive: r.is_active })),
        total: Number(total.n),
        limit,
        offset,
      };
    });
  };
