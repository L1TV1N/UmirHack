import {
  SUPPLIER_PORTAL_SIGNATURE_HEADER,
  SUPPLIER_PORTAL_TIMESTAMP_HEADER,
  idParam,
  ruDate,
  supplierLookupBody,
  supplierStatusPush,
  type SupplierSideStatus,
} from '@zapas/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import type { Deps } from '../../lib/context';
import { conflict, notFound, unauthorized } from '../../lib/errors';
import { hubFor } from '../../lib/events';
import { open } from '../../plugins/access';
import { writeAudit } from '../audit/audit';
import { verifyPortalSignature } from './client';
import { addOrderEvent, buildPush } from './service';

/** Что поставщик может сделать с заказом на своей стороне. */
const NEXT: Record<string, SupplierSideStatus[]> = {
  sent: ['confirmed', 'declined', 'shipped'],
  confirmed: ['shipped', 'declined'],
};

const EVENT_TEXT: Record<SupplierSideStatus, string> = {
  confirmed: 'Поставщик подтвердил заказ',
  declined: 'Поставщик отказал в поставке',
  shipped: 'Поставщик отгрузил заказ',
};

/**
 * Обратная связь от кабинета поставщика. Маршруты открыты для входа по паролю, но каждый запрос подписан общим секретом:
 * без верной подписи и свежего времени ответ один, 401.
 */
export const supplierGatewayRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;

    const check = (req: FastifyRequest, payload: unknown): void => {
      const secret = deps.config.supplierPortal?.secret;
      if (!secret) throw notFound('Кабинет поставщика');
      const ok = verifyPortalSignature(
        secret,
        req.headers[SUPPLIER_PORTAL_TIMESTAMP_HEADER] as string | undefined,
        req.headers[SUPPLIER_PORTAL_SIGNATURE_HEADER] as string | undefined,
        payload,
        deps.clock(),
      );
      if (!ok) throw unauthorized('Неверная подпись запроса', 'bad_signature');
    };

    // Куда вести кнопку «Отгрузка» на экране входа. Адрес не секрет, а входить на экран нужно без пароля. Пусто, если кабинет не подключён.
    app.get('/supplier-portal/link', { config: open }, async () => ({ url: deps.config.supplierPortal?.publicUrl ?? null }));

    app.post('/supplier-gateway/status', { config: open, schema: { body: supplierStatusPush } }, async (req) => {
      check(req, req.body);
      const b = req.body;
      const now = deps.clock();
      const result = await db.transaction().execute(async (trx) => {
        const order = await trx
          .selectFrom('purchase_orders as o')
          .innerJoin('locations as l', 'l.id', 'o.location_id')
          .select(['o.id', 'o.number', 'o.status', 'l.org_id'])
          .where('o.id', '=', b.externalId)
          .forUpdate('o')
          .executeTakeFirst();
        if (!order) throw notFound('Заказ');
        if (order.status === b.status) return { status: order.status, changed: false, number: order.number };
        if (!(NEXT[order.status] ?? []).includes(b.status)) {
          throw conflict(`Заказ ${order.number} уже в статусе «${order.status}», изменить его нельзя`, undefined, 'bad_transition');
        }
        await trx
          .updateTable('purchase_orders')
          .set({
            status: b.status,
            supplier_note: b.note ?? null,
            ...(b.deliveryOn ? { delivery_on: b.deliveryOn } : {}),
            ...(b.status === 'declined' ? { closed_at: now } : {}),
            updated_at: now,
            portal_error: null,
          })
          .where('id', '=', order.id)
          .execute();
        const text = `${EVENT_TEXT[b.status]}${b.deliveryOn ? `, поставка ${ruDate(b.deliveryOn)}` : ''}${b.note ? `: ${b.note}` : ''}`;
        await addOrderEvent(trx, order.id, 'supplier', b.status, text, 'Кабинет поставщика', now);
        await writeAudit(trx, { action: 'order.supplier_status', entity: 'purchase_order', entityId: order.id, email: 'кабинет поставщика', orgId: order.org_id, at: now, details: { number: order.number, status: b.status, note: b.note ?? null } });
        return { status: b.status, changed: true, number: order.number, text };
      });
      if (result.changed) {
        hubFor(db).publish();
        if (deps.notifier.enabled && result.text) {
          deps.notifier.send(`<b>Заказ ${result.number}</b>\n${result.text}`).catch((err) => deps.log.error({ err }, 'уведомление о статусе заказа не отправлено'));
        }
      }
      return { ok: true, status: result.status };
    });

    app.post('/supplier-gateway/lookup', { config: open, schema: { body: supplierLookupBody } }, async (req) => {
      check(req, req.body);
      const rows = await db
        .selectFrom('suppliers')
        .select(['name', sql<string>`count(*) over ()`.as('n')])
        .where('inn', '=', req.body.inn)
        .where('is_active', '=', true)
        .limit(1)
        .execute();
      const row = rows[0];
      return { known: Boolean(row), name: row?.name ?? null, buyers: Number(row?.n ?? 0) };
    });

    app.get('/supplier-gateway/orders/:id', { config: open, schema: { params: idParam } }, async (req) => {
      check(req, { id: req.params.id });
      const push = await buildPush(deps, req.params.id);
      if (!push) throw notFound('Заказ');
      return push;
    });
  };
