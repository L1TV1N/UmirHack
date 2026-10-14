import {
  createPosConnectionBody,
  idParam,
  posIngestQuery,
  posInboxQuery,
  posMapBody,
  posPreviewBody,
  updatePosConnectionBody,
  type PosConnectionCreatedDto,
  type PosConnectionDto,
  type PosInboxDto,
  type PosPresetDto,
  type PosPreviewDto,
  type PosUnmatchedDto,
} from '@zapas/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Deps } from '../../lib/context';
import { randomToken, sha256Hex } from '../../lib/crypto';
import { badRequest, conflict, forbidden, notFound, PG_FK_VIOLATION, pgCode } from '../../lib/errors';
import { orgOf } from '../../lib/scope';
import { asPos, asUser, requirePrincipal, requireUser } from '../../plugins/access';
import { writeAudit } from '../audit/audit';
import { listPosPresets } from './presets';
import { normalizeReceipts } from './rules';
import { ingestReceipt, listInbox, listUnmatched, previewReceipts, replayPending, retryRejected, rulesOfKey } from './service';

/** Выгрузки старых касс часто в windows-1251: если как UTF-8 текст не читается, пробуем эту кодировку. */
function decode(buf: Buffer): string {
  const utf = buf.toString('utf8');
  return utf.includes('�') ? new TextDecoder('windows-1251').decode(buf) : utf;
}

export const posRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;

    app.addContentTypeParser(['application/xml', 'text/xml', 'text/csv', 'text/plain', 'application/csv'], { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, decode(body as Buffer)));

    const rows = () =>
      db
        .selectFrom('api_keys as k')
        .innerJoin('locations as l', 'l.id', 'k.location_id')
        .select(['k.id', 'k.name', 'k.key_prefix', 'k.location_id', 'k.vendor', 'k.rules', 'k.created_at', 'k.last_used_at', 'k.revoked_at', 'l.name as location_name']);

    const toDto = async (r: Awaited<ReturnType<ReturnType<typeof rows>['execute']>>[number]): Promise<PosConnectionDto> => {
      const c = await db.selectFrom('pos_inbox').select(['status', (eb) => eb.fn.countAll<string>().as('n')]).where('key_id', '=', r.id).groupBy('status').execute();
      const n = (s: string) => Number(c.find((x) => x.status === s)?.n ?? 0);
      return {
        id: r.id,
        name: r.name,
        keyPrefix: r.key_prefix,
        locationId: r.location_id,
        locationName: r.location_name,
        vendor: r.vendor,
        rules: rulesOfKey(r),
        createdAt: r.created_at.toISOString(),
        lastUsedAt: r.last_used_at?.toISOString() ?? null,
        revokedAt: r.revoked_at?.toISOString() ?? null,
        counts: { done: n('done'), pending: n('pending_match'), rejected: n('rejected'), returns: n('return_logged') },
      };
    };

    app.get('/pos/presets', { config: asUser('manager') }, async (): Promise<PosPresetDto[]> => listPosPresets());

    app.get('/pos/connections', { config: asUser('manager') }, async (req): Promise<PosConnectionDto[]> => Promise.all((await rows().where('l.org_id', '=', orgOf(requireUser(req))).orderBy('k.created_at', 'desc').execute()).map(toDto)));

    app.post('/pos/connections', { config: asUser('admin'), schema: { body: createPosConnectionBody } }, async (req, reply) => {
      const principal = requireUser(req);
      const b = req.body;
      const now = deps.clock();
      const prefix = randomToken(6);
      const key = `zk_${prefix}_${randomToken(32)}`;
      try {
        const id = await db.transaction().execute(async (trx) => {
          const row = await trx
            .insertInto('api_keys')
            .values({ name: b.name, key_hash: sha256Hex(key), key_prefix: `zk_${prefix}`, location_id: b.locationId, vendor: b.vendor, rules: b.rules ? JSON.stringify(b.rules) : null, created_by: principal.id, created_at: now, last_used_at: null, revoked_at: null })
            .returning('id')
            .executeTakeFirstOrThrow();
          await writeAudit(trx, { action: 'pos.connect', entity: 'api_key', entityId: row.id, principal, meta: req.meta, at: now, details: { name: b.name, vendor: b.vendor, locationId: b.locationId } });
          return row.id;
        });
        const dto: PosConnectionCreatedDto = { ...(await toDto(await rows().where('k.id', '=', id).executeTakeFirstOrThrow())), key };
        return reply.status(201).send(dto);
      } catch (err) {
        if (pgCode(err) === PG_FK_VIOLATION) throw notFound('Точка');
        throw err;
      }
    });

    app.patch('/pos/connections/:id', { config: asUser('admin'), schema: { params: idParam, body: updatePosConnectionBody } }, async (req): Promise<PosConnectionDto> => {
      const principal = requireUser(req);
      const b = req.body;
      const now = deps.clock();
      const changes = { ...(b.name !== undefined ? { name: b.name } : {}), ...(b.vendor !== undefined ? { vendor: b.vendor } : {}), ...(b.rules !== undefined ? { rules: b.rules ? JSON.stringify(b.rules) : null } : {}) };
      await db.transaction().execute(async (trx) => {
        const current = await trx.selectFrom('api_keys as k').innerJoin('locations as l', 'l.id', 'k.location_id').select('k.id').where('l.org_id', '=', orgOf(principal)).where('k.id', '=', req.params.id).where('k.revoked_at', 'is', null).executeTakeFirst();
        if (!current) throw notFound('Подключение');
        if (Object.keys(changes).length === 0) return;
        await trx.updateTable('api_keys').set(changes).where('id', '=', current.id).execute();
        await writeAudit(trx, { action: 'pos.update', entity: 'api_key', entityId: current.id, principal, meta: req.meta, at: now, details: { changes: { name: b.name, vendor: b.vendor, rules: b.rules ? '[изменены]' : b.rules } } });
      });
      return toDto(await rows().where('k.id', '=', req.params.id).executeTakeFirstOrThrow());
    });

    /** Проверка правил на присланном образце: чек не записывается, видно, как он разобран и что найдено в номенклатуре. */
    app.post('/pos/connections/:id/preview', { config: asUser('manager'), schema: { params: idParam, body: posPreviewBody } }, async (req): Promise<PosPreviewDto> => {
      const key = await rows().where('l.org_id', '=', orgOf(requireUser(req))).where('k.id', '=', req.params.id).executeTakeFirst();
      if (!key) throw notFound('Подключение');
      return previewReceipts(deps, key.id, normalizeReceipts(rulesOfKey(key), req.body.payload));
    });

    app.post('/pos/ingest', { config: asPos, bodyLimit: 1024 * 1024, schema: { querystring: posIngestQuery } }, async (req, reply) => {
      const principal = requirePrincipal(req);
      if (principal.kind !== 'apikey') throw forbidden();
      const key = await rows().where('k.id', '=', principal.id).executeTakeFirstOrThrow();
      const body = req.body;
      if (body === undefined || body === null || body === '') throw badRequest('Пустое тело запроса', undefined, 'pos_unreadable');
      const receipts = normalizeReceipts(rulesOfKey(key), body);
      if (req.query.dryRun) return previewReceipts(deps, key.id, receipts);
      const results = [];
      for (const r of receipts) results.push(await ingestReceipt(deps, principal, req.meta, r));
      // кассе всегда отвечаем 200, если чек понят: повторять отправку из-за нехватки остатка или неизвестного кода нет смысла
      return reply.status(200).send({ results });
    });

    app.get('/pos/inbox', { config: asUser('manager'), schema: { querystring: posInboxQuery } }, async (req): Promise<PosInboxDto[]> => listInbox(deps, req.query));

    app.get('/pos/unmatched', { config: asUser('manager') }, async (): Promise<PosUnmatchedDto[]> => listUnmatched(deps));

    app.put('/pos/map', { config: asUser('manager'), schema: { body: posMapBody } }, async (req) => {
      const principal = requireUser(req);
      const b = req.body;
      if (b.entity !== 'ignore' && !b.entityId) throw badRequest('Выберите продукт или блюдо', [{ path: ['entityId'], message: 'Обязательно' }]);
      const ref = b.ref.trim().toLowerCase();
      const now = deps.clock();
      const key = await db.selectFrom('api_keys').select('id').where('id', '=', b.keyId).where('revoked_at', 'is', null).executeTakeFirst();
      if (!key) throw notFound('Подключение');
      if (b.entity === 'product' && !(await db.selectFrom('products').select('id').where('id', '=', b.entityId as string).executeTakeFirst())) throw notFound('Продукт');
      if (b.entity === 'dish' && !(await db.selectFrom('dishes').select('id').where('id', '=', b.entityId as string).executeTakeFirst())) throw notFound('Блюдо');
      await db
        .insertInto('pos_code_map')
        .values({ key_id: b.keyId, ref, entity: b.entity, entity_id: b.entity === 'ignore' ? null : (b.entityId as string), created_by: principal.id, created_at: now })
        .onConflict((oc) => oc.columns(['key_id', 'ref']).doUpdateSet({ entity: b.entity, entity_id: b.entity === 'ignore' ? null : (b.entityId as string) }))
        .execute();
      await writeAudit(db, { action: 'pos.map', entity: 'api_key', entityId: b.keyId, principal, meta: req.meta, at: now, details: { ref, entity: b.entity, entityId: b.entityId ?? null } });
      const played = await replayPending(deps, b.keyId, req.meta);
      return { replayed: played };
    });

    app.post('/pos/inbox/:id/retry', { config: asUser('manager'), schema: { params: idParam } }, async (req) => {
      const result = await retryRejected(deps, req.params.id, req.meta);
      if (!result) throw conflict('Повторить можно только отклонённый чек', undefined, 'not_retryable');
      return result;
    });
  };
