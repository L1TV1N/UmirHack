import {
  auditQuery,
  createApiKeyBody,
  idParam,
  settingsBody,
  type ApiKeyCreatedDto,
  type ApiKeyDto,
  type SettingsDto,
} from '@zapas/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { randomToken, sha256Hex } from '../../lib/crypto';
import type { Deps } from '../../lib/context';
import { conflict, notFound } from '../../lib/errors';
import { orgOf } from '../../lib/scope';
import { asUser, requireUser } from '../../plugins/access';
import { listAudit, verifyAuditChain, writeAudit } from '../audit/audit';
import { sendDigest } from '../notifications/digest';
import { getSettings, saveSettings } from '../settings/settings';
import { runSelfCheck } from './selfcheck';

export const adminRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;

    const settingsDto = async (orgId: string): Promise<SettingsDto> => ({ ...(await getSettings(db, orgId)), telegramConfigured: deps.notifier.enabled });

    app.get('/settings', { config: asUser() }, async (req) => settingsDto(orgOf(requireUser(req))));

    /** Самопроверка для вкладки «Тестирование»: только чтение состояния. */
    app.get('/selfcheck', { config: asUser('manager') }, async () => runSelfCheck(deps));

    app.put('/settings', { config: asUser('admin'), schema: { body: settingsBody } }, async (req) => {
      const principal = requireUser(req);
      await db.transaction().execute(async (trx) => {
        await saveSettings(trx, req.body, principal.id, orgOf(principal));
        await writeAudit(trx, {
          action: 'settings.update',
          entity: 'settings',
          principal,
          meta: req.meta,
          at: deps.clock(),
          details: { settings: req.body },
        });
      });
      return settingsDto(orgOf(principal));
    });

    app.get('/audit', { config: asUser('admin'), schema: { querystring: auditQuery } }, async (req) => {
      const { items, total } = await listAudit(db, { ...req.query, orgId: orgOf(requireUser(req)), tz: deps.config.businessTz });
      return { items, total, limit: req.query.limit, offset: req.query.offset };
    });

    app.get('/audit/verify', { config: asUser('admin') }, async () => verifyAuditChain(db));

    app.post('/notifications/test', { config: asUser('admin') }, async (req, reply) => {
      if (!deps.notifier.enabled) {
        throw conflict('Telegram не настроен: задайте TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID', undefined, 'telegram_not_configured');
      }
      await sendDigest(deps);
      await writeAudit(db, {
        action: 'notifications.test',
        principal: requireUser(req),
        meta: req.meta,
        at: deps.clock(),
        details: {},
      });
      return reply.status(204).send();
    });

    const keyRows = () =>
      db
        .selectFrom('api_keys as k')
        .innerJoin('locations as l', 'l.id', 'k.location_id')
        .select(['k.id', 'k.name', 'k.key_prefix', 'k.location_id', 'k.created_at', 'k.last_used_at', 'k.revoked_at', 'l.name as location_name']);

    const toKeyDto = (r: Awaited<ReturnType<ReturnType<typeof keyRows>['execute']>>[number]): ApiKeyDto => ({
      id: r.id,
      name: r.name,
      prefix: r.key_prefix,
      locationId: r.location_id,
      locationName: r.location_name,
      createdAt: r.created_at.toISOString(),
      lastUsedAt: r.last_used_at?.toISOString() ?? null,
      revokedAt: r.revoked_at?.toISOString() ?? null,
    });

    app.get('/api-keys', { config: asUser('admin') }, async (req) =>
      (await keyRows().where('l.org_id', '=', orgOf(requireUser(req))).orderBy('k.created_at', 'desc').execute()).map(toKeyDto),
    );

    app.post('/api-keys', { config: asUser('admin'), schema: { body: createApiKeyBody } }, async (req, reply) => {
      const principal = requireUser(req);
      const now = deps.clock();
      // 8 символов префикса для опознания, остальное секрет; в базе только хэш
      const prefix = randomToken(6);
      const key = `zk_${prefix}_${randomToken(32)}`;
      const id = await db.transaction().execute(async (trx) => {
        const loc = await trx.selectFrom('locations').select('id').where('id', '=', req.body.locationId).where('is_active', '=', true).executeTakeFirst();
        if (!loc) throw notFound('Точка');
        const row = await trx
          .insertInto('api_keys')
          .values({
            name: req.body.name,
            key_hash: sha256Hex(key),
            key_prefix: `zk_${prefix}`,
            location_id: req.body.locationId,
            created_by: principal.id,
            created_at: now,
            last_used_at: null,
            revoked_at: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await writeAudit(trx, {
          action: 'apikey.create',
          entity: 'api_key',
          entityId: row.id,
          principal,
          meta: req.meta,
          at: now,
          details: { name: req.body.name, locationId: req.body.locationId, prefix: `zk_${prefix}` },
        });
        return row.id;
      });
      const row = await keyRows().where('k.id', '=', id).executeTakeFirstOrThrow();
      const body: ApiKeyCreatedDto = { ...toKeyDto(row), key };
      return reply.status(201).send(body);
    });

    app.delete('/api-keys/:id', { config: asUser('admin'), schema: { params: idParam } }, async (req, reply) => {
      const principal = requireUser(req);
      const now = deps.clock();
      await db.transaction().execute(async (trx) => {
        const row = await trx
          .updateTable('api_keys')
          .set({ revoked_at: now })
          .where('id', '=', req.params.id)
          .where('location_id', 'in', db.selectFrom('locations').select('id').where('org_id', '=', orgOf(principal)))
          .where('revoked_at', 'is', null)
          .returning('id')
          .executeTakeFirst();
        if (!row) throw notFound('Ключ');
        await writeAudit(trx, {
          action: 'apikey.revoke',
          entity: 'api_key',
          entityId: row.id,
          principal,
          meta: req.meta,
          at: now,
          details: {},
        });
      });
      return reply.status(204).send();
    });
  };
