import { importBody, type ImportPreviewDto, type ImportResultDto } from '@zapas/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import type { Deps } from '../../lib/context';
import { sha256Hex } from '../../lib/crypto';
import { orgOf } from '../../lib/scope';
import { badRequest, conflict, PG_UNIQUE_VIOLATION, pgCode } from '../../lib/errors';
import { asUser, requireUser } from '../../plugins/access';
import { writeAudit } from '../audit/audit';
import { ImportFormatError, planImport } from './import';

const BODY_LIMIT = 3.5 * 1024 * 1024;
const CHUNK = 500;
const AUDIT_SKUS = 200;

export const catalogImportRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;
    // тяжёлые маршруты получают долю общего лимита: по умолчанию 20 просмотров и 10 применений в минуту
    const previewLimit = Math.max(20, Math.floor(deps.config.rateLimitMax / 30));
    const applyLimit = Math.max(10, Math.floor(deps.config.rateLimitMax / 60));

    // Загрузка выгрузки iiko или 1С: показать, что изменится, и только потом записать
    app.post(
      '/products/import/preview',
      { config: { ...asUser('manager'), rateLimit: { max: previewLimit, timeWindow: '1 minute' } }, bodyLimit: BODY_LIMIT, schema: { body: importBody } },
      async (req): Promise<ImportPreviewDto> => {
        try {
          return (await planImport(db, Buffer.from(req.body.content, 'base64'), req.body.createCategories, orgOf(requireUser(req)))).preview;
        } catch (err) {
          if (err instanceof ImportFormatError) throw badRequest(err.message, undefined, 'import_format');
          throw err;
        }
      },
    );

    app.post(
      '/products/import',
      { config: { ...asUser('manager'), rateLimit: { max: applyLimit, timeWindow: '1 minute' } }, bodyLimit: BODY_LIMIT, schema: { body: importBody } },
      async (req, reply) => {
        const principal = requireUser(req);
        const bytes = Buffer.from(req.body.content, 'base64');
        const now = deps.clock();
        try {
          const result = await db.transaction().execute(async (trx): Promise<ImportResultDto> => {
            // импорты идут по одному: два одновременных файла с одними артикулами не должны спорить между собой
            await sql`SELECT pg_advisory_xact_lock(hashtext('zapas.catalog.import'))`.execute(trx);
            // файл разбирается заново в этой же транзакции, поэтому записывается ровно то, что сейчас видно в базе
            const orgId = orgOf(principal);
            const plan = await planImport(trx, bytes, req.body.createCategories, orgId);
            if (plan.creates.length + plan.updates.length === 0) throw conflict('Нечего применять: все строки без изменений или с ошибками', undefined, 'nothing_to_import');

            for (const name of plan.newCategories) {
              await trx.insertInto('categories').values({ org_id: orgId, name }).onConflict((oc) => oc.expression(sql`org_id, lower(name)`).doNothing()).execute();
            }
            const categories = await trx.selectFrom('categories').select(['id', 'name']).where('org_id', '=', orgId).execute();
            const categoryId = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));

            for (let from = 0; from < plan.creates.length; from += CHUNK) {
              await trx
                .insertInto('products')
                .values(
                  plan.creates.slice(from, from + CHUNK).map((c) => ({
                    org_id: orgId,
                    sku: c.sku,
                    barcode: c.barcode ?? null,
                    name: c.name,
                    category_id: categoryId.get(c.categoryName.toLowerCase()) as string,
                    unit: c.unit,
                    min_stock: c.minStock,
                    shelf_life_days: c.shelfLifeDays ?? null,
                    price: c.price,
                    cost: c.cost,
                    sellable: true,
                    requires_vsd: c.requiresVsd,
                    requires_marking: c.requiresMarking,
                    created_at: now,
                    updated_at: now,
                  })),
                )
                .execute();
            }
            for (const u of plan.updates) {
              const p = u.patch;
              await trx
                .updateTable('products')
                .set({
                  ...(p.name !== undefined ? { name: p.name } : {}),
                  ...(p.barcode !== undefined ? { barcode: p.barcode } : {}),
                  ...(p.categoryName !== undefined ? { category_id: categoryId.get(p.categoryName.toLowerCase()) as string } : {}),
                  ...(p.price !== undefined ? { price: p.price } : {}),
                  ...(p.cost !== undefined ? { cost: p.cost } : {}),
                  ...(p.minStock !== undefined ? { min_stock: p.minStock } : {}),
                  ...(p.shelfLifeDays !== undefined ? { shelf_life_days: p.shelfLifeDays } : {}),
                  ...(p.requiresVsd !== undefined ? { requires_vsd: p.requiresVsd } : {}),
                  ...(p.requiresMarking !== undefined ? { requires_marking: p.requiresMarking } : {}),
                  updated_at: now,
                })
                .where('id', '=', u.id)
                .execute();
            }
            await writeAudit(trx, {
              action: 'product.import',
              entity: 'product',
              entityId: sha256Hex(req.body.content).slice(0, 12),
              principal,
              meta: req.meta,
              at: now,
              details: {
                created: plan.creates.length,
                updated: plan.updates.length,
                skipped: plan.preview.skip,
                errors: plan.preview.errors,
                categories: plan.newCategories.length,
                createdSkus: plan.creates.slice(0, AUDIT_SKUS).map((c) => c.sku),
                updatedRows: plan.preview.rows.filter((r) => r.action === 'update').slice(0, AUDIT_SKUS).map((r) => ({ sku: r.sku, changes: r.changes })),
              },
            });
            return { created: plan.creates.length, updated: plan.updates.length, skipped: plan.preview.skip + plan.preview.errors, categoriesCreated: plan.newCategories.length };
          });
          return reply.status(200).send(result);
        } catch (err) {
          if (err instanceof ImportFormatError) throw badRequest(err.message, undefined, 'import_format');
          // пока шёл импорт, тот же артикул или штрихкод завели вручную
          if (pgCode(err) === PG_UNIQUE_VIOLATION) throw conflict('Пока шёл импорт, данные изменились. Загрузите файл ещё раз', undefined, 'import_conflict');
          throw err;
        }
      },
    );
  };
