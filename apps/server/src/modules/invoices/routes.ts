import { idParam, itemMapBody, parseInvoiceBody, parseInvoicePhotoBody, type InvoiceCapabilitiesDto, type InvoiceDto } from '@zapas/shared';
import { sql } from 'kysely';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Deps } from '../../lib/context';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors';
import { orgOf } from '../../lib/scope';
import { asUser, requireUser } from '../../plugins/access';
import { writeAudit } from '../audit/audit';
import { InvoiceFormatError } from './raw';
import { buildInvoice } from './service';
import { parseUpd } from './upd';

const MAX_XML_BYTES = 3 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Первые байты должны соответствовать заявленному типу: иначе под видом картинки пришло что-то другое. */
function looksLike(mediaType: string, b: Buffer): boolean {
  switch (mediaType) {
    case 'image/jpeg':
      return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'image/png':
      return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/gif':
      return b.subarray(0, 4).toString('latin1') === 'GIF8';
    case 'image/webp':
      return b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
    default:
      return false;
  }
}

export const invoiceRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;

    app.get('/invoices/capabilities', { config: asUser('storekeeper') }, async (): Promise<InvoiceCapabilitiesDto> => ({ upd: true, photo: Boolean(deps.invoiceReader) }));

    app.post(
      '/invoices/parse',
      { config: { ...asUser('storekeeper'), rateLimit: { max: 30, timeWindow: '1 minute' } }, bodyLimit: 4.5 * 1024 * 1024, schema: { body: parseInvoiceBody } },
      async (req): Promise<InvoiceDto> => {
        const bytes = Buffer.from(req.body.content, 'base64');
        if (bytes.length > MAX_XML_BYTES) throw badRequest('Файл больше 3 МБ', undefined, 'invoice_too_large');
        try {
          return await buildInvoice(deps, parseUpd(bytes), 'upd', orgOf(requireUser(req)));
        } catch (err) {
          if (err instanceof InvoiceFormatError) throw badRequest(err.message, undefined, 'invoice_format');
          throw err;
        }
      },
    );

    app.post(
      '/invoices/parse-photo',
      { config: { ...asUser('storekeeper'), rateLimit: { max: 10, timeWindow: '1 minute' } }, bodyLimit: 7.5 * 1024 * 1024, schema: { body: parseInvoicePhotoBody } },
      async (req): Promise<InvoiceDto> => {
        const reader = deps.invoiceReader;
        if (!reader) throw conflict('Распознавание фото не подключено. Загрузите файл УПД (XML) или попросите администратора указать ключ сервиса распознавания', undefined, 'invoice_photo_disabled');
        const image = Buffer.from(req.body.image, 'base64');
        if (image.length > MAX_IMAGE_BYTES) throw badRequest('Фото больше 5 МБ: сделайте снимок поменьше', undefined, 'invoice_too_large');
        if (!looksLike(req.body.mediaType, image)) throw badRequest('Содержимое не похоже на изображение', undefined, 'invoice_format');

        let raw;
        try {
          raw = await reader.read(image, req.body.mediaType);
        } catch (err) {
          // картинку и ответ сервиса в журнал не пишем, только факт сбоя
          deps.log.error({ err: err instanceof Error ? err.name : 'ошибка' }, 'не удалось распознать фото накладной');
          throw new AppError(502, 'invoice_reader_failed', 'Не удалось распознать фото. Попробуйте ещё раз или загрузите файл УПД');
        }
        await writeAudit(db, { action: 'invoice.photo', principal: requireUser(req), meta: req.meta, at: deps.clock(), details: { bytes: image.length, lines: raw.lines.length } });
        return buildInvoice(deps, raw, 'photo', orgOf(requireUser(req)));
      },
    );

    // Запоминаем, какому нашему продукту соответствует строка накладной поставщика
    app.put('/suppliers/:id/item-map', { config: asUser('storekeeper'), schema: { params: idParam, body: itemMapBody } }, async (req, reply) => {
      const principal = requireUser(req);
      const supplier = await db.selectFrom('suppliers').select('id').where('id', '=', req.params.id).executeTakeFirst();
      if (!supplier) throw notFound('Поставщик');

      const ids = [...new Set(req.body.items.map((i) => i.productId))];
      const known = await db.selectFrom('products').select('id').where('id', 'in', ids).execute();
      if (known.length !== ids.length) throw badRequest('Есть продукты, которых нет в справочнике', undefined, 'unknown_product');

      await db.transaction().execute(async (trx) => {
        for (const item of req.body.items) {
          await trx
            .insertInto('supplier_item_map')
            .values({ supplier_id: supplier.id, item_key: item.key, product_id: item.productId })
            .onConflict((oc) => oc.columns(['supplier_id', 'item_key']).doUpdateSet({ product_id: item.productId, updated_at: sql`now()` }))
            .execute();
        }
        await writeAudit(trx, { action: 'supplier.item_map', entity: 'supplier', entityId: supplier.id, principal, meta: req.meta, at: deps.clock(), details: { items: req.body.items.length } });
      });
      return reply.status(204).send();
    });
  };
