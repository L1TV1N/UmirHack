import {
  createExchangeSystemBody,
  exchangeJobsQuery,
  idParam,
  linkBody,
  pushDocumentBody,
  remoteSearchQuery,
  updateExchangeSystemBody,
  type ExchangeJobDto,
  type ExchangeMissingDto,
  type ExchangePresetDto,
  type ExternalSystemDto,
  type RemoteItemDto,
} from '@zapas/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../../lib/context';
import { encryptSecret } from '../../lib/crypto';
import { badRequest, conflict, notFound, PG_FK_VIOLATION, pgCode, unprocessable } from '../../lib/errors';
import { orgOf } from '../../lib/scope';
import { asUser, requireUser } from '../../plugins/access';
import { writeAudit } from '../audit/audit';
import { assertWebhookUrl } from '../integrations/guard';
import { incomingInvoiceXml } from './iiko';
import { connectionOf, loadCanonical, autolink, checkSystem, listJobs, listUnlinked, pushNow, retryJob, saveLink, toSystemDto } from './service';
import { OneCError, searchCatalog } from './onec';
import { listOneCPresets } from './presets';
import { describeExchangeError, exchangeHostAllowed } from './transport';

const MAX_SYSTEMS = 10;

export const exchangeRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;
    const allow = deps.config.exchange.allowHosts;

    /** Адрес из списка разрешённых хостов можно указывать и по http, и во внутренней сети. Остальные только по https и во внешней сети. */
    const checkUrl = (raw: string): URL => {
      let host = '';
      try {
        host = new URL(raw).hostname;
      } catch {
        /* ошибку выдаст проверка ниже */
      }
      const trusted = exchangeHostAllowed(host, allow);
      return assertWebhookUrl(raw, { allowPrivate: trusted, allowHttp: trusted });
    };

    const load = async (id: string, org: string) => {
      const row = await db.selectFrom('external_systems').selectAll().where('org_id', '=', org).where('id', '=', id).executeTakeFirst();
      if (!row) throw notFound('Система');
      return row;
    };

    app.get('/exchange/presets', { config: asUser('admin') }, async (): Promise<ExchangePresetDto[]> => listOneCPresets());

    app.get('/exchange/systems', { config: asUser('manager') }, async (req): Promise<ExternalSystemDto[]> => {
      const rows = await db.selectFrom('external_systems').selectAll().where('org_id', '=', orgOf(requireUser(req))).orderBy('created_at').execute();
      return Promise.all(rows.map((r) => toSystemDto(deps, r)));
    });

    app.post('/exchange/systems', { config: asUser('admin'), schema: { body: createExchangeSystemBody } }, async (req, reply) => {
      const principal = requireUser(req);
      const b = req.body;
      const url = checkUrl(b.baseUrl);
      const count = await db.selectFrom('external_systems').select((eb) => eb.fn.countAll<string>().as('n')).where('org_id', '=', orgOf(principal)).executeTakeFirstOrThrow();
      if (Number(count.n) >= MAX_SYSTEMS) throw conflict(`Систем обмена не больше ${MAX_SYSTEMS}`, undefined, 'too_many_systems');
      const now = deps.clock();
      try {
        const id = await db.transaction().execute(async (trx) => {
          const row = await trx
            .insertInto('external_systems')
            .values({
              org_id: orgOf(principal),
              kind: b.kind,
              name: b.name,
              base_url: url.toString().replace(/\/$/, ''),
              username: b.username || null,
              secret_enc: b.password ? encryptSecret(deps.config.jwtSecret, b.password) : null,
              profile: JSON.stringify(b.profile),
              doc_kinds: b.docKinds,
              location_id: b.locationId ?? null,
              last_ok_at: null,
              last_error: null,
              created_by: principal.id,
              created_at: now,
              updated_at: now,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await writeAudit(trx, { action: 'exchange.create', entity: 'exchange_system', entityId: row.id, principal, meta: req.meta, at: now, details: { name: b.name, kind: b.kind, host: url.host, docKinds: b.docKinds } });
          return row.id;
        });
        return reply.status(201).send(await toSystemDto(deps, await load(id, orgOf(principal))));
      } catch (err) {
        if (pgCode(err) === PG_FK_VIOLATION) throw badRequest('Точка не найдена', [{ path: ['locationId'], message: 'Не найдена' }]);
        throw err;
      }
    });

    app.patch('/exchange/systems/:id', { config: asUser('admin'), schema: { params: idParam, body: updateExchangeSystemBody } }, async (req): Promise<ExternalSystemDto> => {
      const principal = requireUser(req);
      const b = req.body;
      const url = b.baseUrl !== undefined ? checkUrl(b.baseUrl) : null;
      const now = deps.clock();
      try {
        await db.transaction().execute(async (trx) => {
          const current = await trx.selectFrom('external_systems').select('id').where('org_id', '=', orgOf(principal)).where('id', '=', req.params.id).forUpdate().executeTakeFirst();
          if (!current) throw notFound('Система');
          await trx
            .updateTable('external_systems')
            .set({
              ...(b.name !== undefined ? { name: b.name } : {}),
              ...(url ? { base_url: url.toString().replace(/\/$/, '') } : {}),
              ...(b.username !== undefined ? { username: b.username || null } : {}),
              ...(b.password ? { secret_enc: encryptSecret(deps.config.jwtSecret, b.password) } : {}),
              ...(b.profile !== undefined ? { profile: JSON.stringify(b.profile) } : {}),
              ...(b.docKinds !== undefined ? { doc_kinds: b.docKinds } : {}),
              ...(b.locationId !== undefined ? { location_id: b.locationId } : {}),
              ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
              updated_at: now,
            })
            .where('id', '=', current.id)
            .execute();
          await writeAudit(trx, { action: 'exchange.update', entity: 'exchange_system', entityId: current.id, principal, meta: req.meta, at: now, details: { changes: { ...b, password: b.password ? '[изменён]' : undefined, profile: b.profile ? '[изменён]' : undefined } } });
        });
      } catch (err) {
        if (pgCode(err) === PG_FK_VIOLATION) throw badRequest('Точка не найдена', [{ path: ['locationId'], message: 'Не найдена' }]);
        throw err;
      }
      return toSystemDto(deps, await load(req.params.id, orgOf(requireUser(req))));
    });

    app.delete('/exchange/systems/:id', { config: asUser('admin'), schema: { params: idParam } }, async (req, reply) => {
      const principal = requireUser(req);
      const now = deps.clock();
      await db.transaction().execute(async (trx) => {
        const row = await trx.deleteFrom('external_systems').where('id', '=', req.params.id).returning('name').executeTakeFirst();
        if (!row) throw notFound('Система');
        await writeAudit(trx, { action: 'exchange.delete', entity: 'exchange_system', entityId: req.params.id, principal, meta: req.meta, at: now, details: { name: row.name } });
      });
      return reply.status(204).send();
    });

    app.post('/exchange/systems/:id/check', { config: asUser('admin'), schema: { params: idParam } }, async (req) => {
      await load(req.params.id, orgOf(requireUser(req)));
      return checkSystem(deps, req.params.id);
    });

    app.get('/exchange/systems/:id/unlinked', { config: asUser('manager'), schema: { params: idParam } }, async (req): Promise<ExchangeMissingDto[]> => {
      await load(req.params.id, orgOf(requireUser(req)));
      return listUnlinked(deps, req.params.id);
    });

    app.post('/exchange/systems/:id/autolink', { config: asUser('admin'), schema: { params: idParam } }, async (req) => {
      await load(req.params.id, orgOf(requireUser(req)));
      try {
        return await autolink(deps, req.params.id);
      } catch (err) {
        if (err instanceof OneCError) throw unprocessable(err.message, undefined, 'exchange_failed');
        throw unprocessable(describeExchangeError(err), undefined, 'exchange_failed');
      }
    });

    app.get('/exchange/systems/:id/search', { config: asUser('admin'), schema: { params: idParam, querystring: remoteSearchQuery } }, async (req): Promise<RemoteItemDto[]> => {
      const system = await load(req.params.id, orgOf(requireUser(req)));
      if (!deps.exchangeTransport) throw unprocessable('Отправка не настроена на сервере', undefined, 'exchange_disabled');
      try {
        return await searchCatalog(deps.exchangeTransport, connectionOf(deps, system), req.query.entity, req.query.q);
      } catch (err) {
        throw unprocessable(err instanceof OneCError ? err.message : describeExchangeError(err), undefined, 'exchange_failed');
      }
    });

    app.put('/exchange/systems/:id/links', { config: asUser('manager'), schema: { params: idParam, body: linkBody } }, async (req) => {
      const principal = requireUser(req);
      await load(req.params.id, orgOf(requireUser(req)));
      const woke = await saveLink(deps, req.params.id, req.body.entity, req.body.localId, req.body.remoteKey);
      await writeAudit(db, { action: 'exchange.link', entity: 'exchange_system', entityId: req.params.id, principal, meta: req.meta, at: deps.clock(), details: { entity: req.body.entity, localId: req.body.localId } });
      return { woke };
    });

    app.get('/exchange/jobs', { config: asUser('manager'), schema: { querystring: exchangeJobsQuery } }, async (req): Promise<ExchangeJobDto[]> => listJobs(deps, req.query));

    app.post('/exchange/jobs/:id/retry', { config: asUser('manager'), schema: { params: idParam } }, async (req, reply) => {
      if (!(await retryJob(deps, req.params.id))) throw conflict('Повторить можно только задание, которое не прошло или ждёт связей', undefined, 'not_retryable');
      return reply.status(202).send({ queued: true });
    });

    /** Приход в виде XML для загрузки в iiko. Склад и поставщика iiko (их идентификаторы) указывает тот, кто выгружает. */
    app.get('/documents/:id/export/iiko.xml', { config: asUser('manager'), schema: { params: idParam, querystring: z.object({ store: z.uuid().optional(), supplier: z.uuid().optional() }) } }, async (req, reply) => {
      const doc = await loadCanonical(deps, req.params.id);
      if (!doc) throw notFound('Документ');
      if (doc.kind !== 'receipt') throw unprocessable('В iiko выгружается только приход', undefined, 'not_exportable');
      const xml = incomingInvoiceXml(doc, { store: req.query.store, supplier: req.query.supplier, tz: deps.config.businessTz });
      return reply
        .header('content-type', 'application/xml; charset=utf-8')
        .header('content-disposition', `attachment; filename="receipt-${/\d+/.exec(doc.number)?.[0] ?? 'doc'}.xml"; filename*=UTF-8''${encodeURIComponent(doc.number)}.xml`)
        .send(xml);
    });

    app.post('/documents/:id/exchange', { config: asUser('manager'), schema: { params: idParam, body: pushDocumentBody } }, async (req) => {
      const principal = requireUser(req);
      await load(req.body.systemId, orgOf(requireUser(req)));
      const doc = await db.selectFrom('documents').select(['id', 'kind']).where('id', '=', req.params.id).executeTakeFirst();
      if (!doc) throw notFound('Документ');
      if (!['receipt', 'writeoff', 'transfer', 'inventory'].includes(doc.kind)) throw unprocessable('Этот вид документа не выгружается', undefined, 'not_exportable');
      const result = await pushNow(deps, req.body.systemId, req.params.id);
      await writeAudit(db, { action: 'exchange.push', entity: 'document', entityId: req.params.id, principal, meta: req.meta, at: deps.clock(), details: { systemId: req.body.systemId, outcome: result.outcome } });
      const [job] = await listJobs(deps, { systemId: req.body.systemId, limit: 1 });
      return { outcome: result.outcome, job: job ?? null };
    });
  };
