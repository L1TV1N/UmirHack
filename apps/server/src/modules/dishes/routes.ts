import { createDishBody, idParam, updateDishBody, type DishDto } from '@zapas/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Transaction } from 'kysely';
import type { Db } from '../../db/client';
import type { Database } from '../../db/types';
import type { Deps } from '../../lib/context';
import { badRequest, conflict, notFound, PG_UNIQUE_VIOLATION, pgCode, pgConstraint } from '../../lib/errors';
import { asUser, requirePrincipal } from '../../plugins/access';
import { writeAudit } from '../audit/audit';

export async function loadDishes(db: Db, ids?: string[]): Promise<DishDto[]> {
  let q = db.selectFrom('dishes').selectAll().orderBy('name');
  if (ids) q = q.where('id', 'in', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
  const dishes = await q.execute();
  if (dishes.length === 0) return [];
  const items = await db
    .selectFrom('dish_items')
    .innerJoin('products', 'products.id', 'dish_items.product_id')
    .select(['dish_items.dish_id', 'dish_items.product_id', 'dish_items.quantity', 'products.name', 'products.unit'])
    .where('dish_items.dish_id', 'in', dishes.map((d) => d.id))
    .orderBy('products.name')
    .execute();
  return dishes.map((d) => ({
    id: d.id,
    name: d.name,
    code: d.code,
    price: Number(d.price),
    isActive: d.is_active,
    items: items
      .filter((i) => i.dish_id === d.id)
      .map((i) => ({ productId: i.product_id, productName: i.name, unit: i.unit, quantity: Number(i.quantity) })),
  }));
}

async function assertProducts(trx: Transaction<Database>, items: { productId: string; quantity: number }[]): Promise<void> {
  const ids = items.map((i) => i.productId);
  const rows = await trx.selectFrom('products').select(['id', 'name', 'unit']).where('id', 'in', ids).where('is_active', '=', true).execute();
  if (rows.length !== new Set(ids).size) {
    throw badRequest('В составе есть несуществующий или отключённый продукт', [{ path: ['items'], message: 'Проверьте ингредиенты' }]);
  }
  // иначе при продаже нескольких порций на складе появятся доли штуки
  for (const [i, item] of items.entries()) {
    const p = rows.find((r) => r.id === item.productId);
    if (p?.unit === 'pcs' && !Number.isInteger(item.quantity)) {
      throw badRequest(`«${p.name}» считается в штуках, на порцию нужно целое количество`, [{ path: ['items', i, 'quantity'], message: 'Нужно целое число' }], 'whole_pieces');
    }
  }
}

function duplicateDish(err: unknown): void {
  if (pgCode(err) !== PG_UNIQUE_VIOLATION) return;
  if (pgConstraint(err) === 'dishes_code_key') throw conflict('Этот код уже у другого блюда', [{ path: ['code'], message: 'Код уже занят' }], 'duplicate_code');
  throw conflict('Блюдо с таким названием уже есть', undefined, 'duplicate_name');
}

export const dishRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;

    app.get('/dishes', { config: asUser() }, async () => loadDishes(db));

    app.post('/dishes', { config: asUser('manager'), schema: { body: createDishBody } }, async (req, reply) => {
      const b = req.body;
      try {
        const id = await db.transaction().execute(async (trx) => {
          await assertProducts(trx, b.items);
          const now = deps.clock();
          const dish = await trx
            .insertInto('dishes')
            .values({ name: b.name, code: b.code ?? null, price: b.price, created_at: now, updated_at: now })
            .returning('id')
            .executeTakeFirstOrThrow();
          await trx
            .insertInto('dish_items')
            .values(b.items.map((i) => ({ dish_id: dish.id, product_id: i.productId, quantity: i.quantity })))
            .execute();
          await writeAudit(trx, {
            action: 'dish.create',
            entity: 'dish',
            entityId: dish.id,
            principal: requirePrincipal(req),
            meta: req.meta,
            at: now,
            details: { name: b.name, price: b.price, items: b.items.length },
          });
          return dish.id;
        });
        const [dto] = await loadDishes(db, [id]);
        return reply.status(201).send(dto);
      } catch (err) {
        duplicateDish(err);
        throw err;
      }
    });

    app.patch('/dishes/:id', { config: asUser('manager'), schema: { params: idParam, body: updateDishBody } }, async (req) => {
      const b = req.body;
      try {
        await db.transaction().execute(async (trx) => {
          const current = await trx.selectFrom('dishes').selectAll().where('id', '=', req.params.id).forUpdate().executeTakeFirst();
          if (!current) throw notFound('Блюдо');
          const now = deps.clock();
          await trx
            .updateTable('dishes')
            .set({
              ...(b.name !== undefined ? { name: b.name } : {}),
              ...(b.code !== undefined ? { code: b.code } : {}),
              ...(b.price !== undefined ? { price: b.price } : {}),
              ...(b.isActive !== undefined ? { is_active: b.isActive } : {}),
              updated_at: now,
            })
            .where('id', '=', current.id)
            .execute();
          if (b.items) {
            await assertProducts(trx, b.items);
            await trx.deleteFrom('dish_items').where('dish_id', '=', current.id).execute();
            await trx
              .insertInto('dish_items')
              .values(b.items.map((i) => ({ dish_id: current.id, product_id: i.productId, quantity: i.quantity })))
              .execute();
          }
          await writeAudit(trx, {
            action: 'dish.update',
            entity: 'dish',
            entityId: current.id,
            principal: requirePrincipal(req),
            meta: req.meta,
            at: now,
            details: { changes: { ...b, items: b.items ? b.items.length : undefined }, before: { price: Number(current.price) } },
          });
        });
      } catch (err) {
        duplicateDish(err);
        throw err;
      }
      const [dto] = await loadDishes(db, [req.params.id]);
      return dto;
    });
  };
