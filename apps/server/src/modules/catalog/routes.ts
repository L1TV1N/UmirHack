import {
  barcodeParam,
  categoryBody,
  createProductBody,
  idParam,
  productsQuery,
  supplierBody,
  updateProductBody,
  type CategoryDto,
  type ProductDto,
  type SupplierDto,
} from '@zapas/shared';
import { sql, type Selectable } from 'kysely';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { CategoriesTable, ProductsTable, SuppliersTable } from '../../db/types';
import type { Deps } from '../../lib/context';
import { badRequest, conflict, notFound, pgCode, pgConstraint, PG_FK_VIOLATION, PG_UNIQUE_VIOLATION } from '../../lib/errors';
import { asUser, requirePrincipal } from '../../plugins/access';
import { writeAudit } from '../audit/audit';

type ProductRow = Selectable<ProductsTable> & { category_name: string; supplier_name: string | null };

export function toProductDto(r: ProductRow): ProductDto {
  return {
    id: r.id,
    sku: r.sku,
    barcode: r.barcode,
    name: r.name,
    categoryId: r.category_id,
    categoryName: r.category_name,
    unit: r.unit,
    minStock: Number(r.min_stock),
    shelfLifeDays: r.shelf_life_days,
    price: Number(r.price),
    cost: Number(r.cost),
    sellable: r.sellable,
    requiresVsd: r.requires_vsd,
    requiresMarking: r.requires_marking,
    defaultSupplierId: r.default_supplier_id,
    defaultSupplierName: r.supplier_name,
    packSize: Number(r.pack_size),
    isActive: r.is_active,
  };
}

const toCategoryDto = (r: Selectable<CategoriesTable>): CategoryDto => ({ id: r.id, name: r.name });
const toSupplierDto = (r: Selectable<SuppliersTable>): SupplierDto => ({
  id: r.id,
  name: r.name,
  inn: r.inn,
  phone: r.phone,
  note: r.note,
  email: r.email,
  leadTimeDays: r.lead_time_days,
  minOrderSum: Number(r.min_order_sum),
  autoOrder: r.auto_order,
  isActive: r.is_active,
});

/** Сколько продуктов отдаём сканеру. Больше на одной точке не бывает, а ответ остаётся небольшим. */
const SCAN_INDEX_LIMIT = 10_000;

const likePattern = (q: string) => `%${q.replace(/[%_\\]/g, '\\$&')}%`;

export const catalogRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;

    const productSelect = () =>
      db
        .selectFrom('products')
        .innerJoin('categories', 'categories.id', 'products.category_id')
        .leftJoin('suppliers', 'suppliers.id', 'products.default_supplier_id')
        .selectAll('products')
        .select(['categories.name as category_name', 'suppliers.name as supplier_name']);

    function duplicateProduct(err: unknown): never {
      if (pgCode(err) === PG_UNIQUE_VIOLATION) {
        const c = pgConstraint(err);
        if (c === 'products_sku_key') throw conflict('Артикул уже занят', [{ path: ['sku'], message: 'Артикул уже занят' }], 'duplicate_sku');
        if (c === 'products_barcode_key') {
          throw conflict('Штрихкод уже занят', [{ path: ['barcode'], message: 'Штрихкод уже занят' }], 'duplicate_barcode');
        }
      }
      if (pgCode(err) === PG_FK_VIOLATION) {
        if (pgConstraint(err) === 'products_default_supplier_id_fkey') throw badRequest('Поставщик не найден', [{ path: ['defaultSupplierId'], message: 'Не найден' }]);
        throw badRequest('Категория не найдена', [{ path: ['categoryId'], message: 'Не найдена' }]);
      }
      throw err;
    }

    /** Поставщик по умолчанию должен быть действующим, а фасовка штучного товара целой. */
    async function assertOrderSettings(
      trx: typeof db,
      unit: 'kg' | 'l' | 'pcs',
      packSize: number | undefined,
      supplierId: string | null | undefined,
    ): Promise<void> {
      if (supplierId) {
        const s = await trx.selectFrom('suppliers').select('id').where('id', '=', supplierId).where('is_active', '=', true).executeTakeFirst();
        if (!s) throw badRequest('Поставщик не найден или отключён', [{ path: ['defaultSupplierId'], message: 'Недоступен для заказов' }]);
      }
      if (unit === 'pcs' && packSize !== undefined && !Number.isInteger(packSize)) {
        throw badRequest('Товар считается в штуках: фасовка должна быть целой', [{ path: ['packSize'], message: 'Нужно целое число' }], 'whole_pieces');
      }
    }

    // Категории

    app.get('/categories', { config: asUser() }, async () =>
      (await db.selectFrom('categories').selectAll().orderBy('name').execute()).map(toCategoryDto),
    );

    app.post('/categories', { config: asUser('manager'), schema: { body: categoryBody } }, async (req, reply) => {
      try {
        const row = await db.transaction().execute(async (trx) => {
          const created = await trx.insertInto('categories').values({ name: req.body.name }).returningAll().executeTakeFirstOrThrow();
          await writeAudit(trx, {
            action: 'category.create',
            entity: 'category',
            entityId: created.id,
            principal: requirePrincipal(req),
            meta: req.meta,
            at: deps.clock(),
            details: { name: created.name },
          });
          return created;
        });
        return reply.status(201).send(toCategoryDto(row));
      } catch (err) {
        if (pgCode(err) === PG_UNIQUE_VIOLATION) throw conflict('Такая категория уже есть', undefined, 'duplicate_name');
        throw err;
      }
    });

    app.patch('/categories/:id', { config: asUser('manager'), schema: { params: idParam, body: categoryBody } }, async (req) => {
      try {
        return await db.transaction().execute(async (trx) => {
          const row = await trx
            .updateTable('categories')
            .set({ name: req.body.name })
            .where('id', '=', req.params.id)
            .returningAll()
            .executeTakeFirst();
          if (!row) throw notFound('Категория');
          await writeAudit(trx, {
            action: 'category.update',
            entity: 'category',
            entityId: row.id,
            principal: requirePrincipal(req),
            meta: req.meta,
            at: deps.clock(),
            details: { name: row.name },
          });
          return toCategoryDto(row);
        });
      } catch (err) {
        if (pgCode(err) === PG_UNIQUE_VIOLATION) throw conflict('Такая категория уже есть', undefined, 'duplicate_name');
        throw err;
      }
    });

    // Поставщики

    app.get('/suppliers', { config: asUser() }, async () =>
      (await db.selectFrom('suppliers').selectAll().orderBy('name').execute()).map(toSupplierDto),
    );

    app.post('/suppliers', { config: asUser('manager'), schema: { body: supplierBody } }, async (req, reply) => {
      try {
        const row = await db.transaction().execute(async (trx) => {
          const created = await trx
            .insertInto('suppliers')
            .values({
              name: req.body.name,
              inn: req.body.inn || null,
              phone: req.body.phone ?? null,
              note: req.body.note ?? null,
              email: req.body.email || null,
              ...(req.body.leadTimeDays !== undefined ? { lead_time_days: req.body.leadTimeDays } : {}),
              ...(req.body.minOrderSum !== undefined ? { min_order_sum: req.body.minOrderSum } : {}),
              ...(req.body.autoOrder !== undefined ? { auto_order: req.body.autoOrder } : {}),
              is_active: req.body.isActive ?? true,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await writeAudit(trx, {
            action: 'supplier.create',
            entity: 'supplier',
            entityId: created.id,
            principal: requirePrincipal(req),
            meta: req.meta,
            at: deps.clock(),
            details: { name: created.name },
          });
          return created;
        });
        return reply.status(201).send(toSupplierDto(row));
      } catch (err) {
        if (pgCode(err) === PG_UNIQUE_VIOLATION) {
          if (pgConstraint(err) === 'suppliers_inn_key') throw conflict('Поставщик с таким ИНН уже есть', [{ path: ['inn'], message: 'ИНН уже занят' }], 'duplicate_inn');
          throw conflict('Такой поставщик уже есть', undefined, 'duplicate_name');
        }
        throw err;
      }
    });

    app.patch('/suppliers/:id', { config: asUser('manager'), schema: { params: idParam, body: supplierBody } }, async (req) => {
      try {
        return await db.transaction().execute(async (trx) => {
          const row = await trx
            .updateTable('suppliers')
            .set({
              name: req.body.name,
              ...(req.body.inn !== undefined ? { inn: req.body.inn || null } : {}),
              phone: req.body.phone ?? null,
              note: req.body.note ?? null,
              ...(req.body.email !== undefined ? { email: req.body.email || null } : {}),
              ...(req.body.leadTimeDays !== undefined ? { lead_time_days: req.body.leadTimeDays } : {}),
              ...(req.body.minOrderSum !== undefined ? { min_order_sum: req.body.minOrderSum } : {}),
              ...(req.body.autoOrder !== undefined ? { auto_order: req.body.autoOrder } : {}),
              ...(req.body.isActive !== undefined ? { is_active: req.body.isActive } : {}),
            })
            .where('id', '=', req.params.id)
            .returningAll()
            .executeTakeFirst();
          if (!row) throw notFound('Поставщик');
          await writeAudit(trx, {
            action: 'supplier.update',
            entity: 'supplier',
            entityId: row.id,
            principal: requirePrincipal(req),
            meta: req.meta,
            at: deps.clock(),
            details: { name: row.name, isActive: row.is_active },
          });
          return toSupplierDto(row);
        });
      } catch (err) {
        if (pgCode(err) === PG_UNIQUE_VIOLATION) {
          if (pgConstraint(err) === 'suppliers_inn_key') throw conflict('Поставщик с таким ИНН уже есть', [{ path: ['inn'], message: 'ИНН уже занят' }], 'duplicate_inn');
          throw conflict('Такой поставщик уже есть', undefined, 'duplicate_name');
        }
        throw err;
      }
    });

    // Продукты

    app.get('/products', { config: asUser(), schema: { querystring: productsQuery } }, async (req) => {
      const { q, categoryId, active, sellable, limit, offset } = req.query;
      const like = q ? likePattern(q) : '';
      const filtered = db
        .selectFrom('products')
        .innerJoin('categories', 'categories.id', 'products.category_id')
        .leftJoin('suppliers', 'suppliers.id', 'products.default_supplier_id')
        .$if(Boolean(q), (qb) =>
          qb.where((eb) =>
            eb.or([eb('products.name', 'ilike', like), eb('products.sku', 'ilike', like), eb('products.barcode', 'like', like)]),
          ),
        )
        .$if(categoryId !== undefined, (qb) => qb.where('products.category_id', '=', categoryId as string))
        .$if(active !== undefined, (qb) => qb.where('products.is_active', '=', active as boolean))
        .$if(sellable !== undefined, (qb) => qb.where('products.sellable', '=', sellable as boolean));

      const total = await filtered.select(sql<number>`count(*)`.as('n')).executeTakeFirstOrThrow();
      const rows = await filtered
        .selectAll('products')
        .select(['categories.name as category_name', 'suppliers.name as supplier_name'])
        .orderBy('products.name')
        .limit(limit)
        .offset(offset)
        .execute();
      return { items: rows.map(toProductDto), total: Number(total.n), limit, offset };
    });

    // Продукты по штрихкоду. Сравниваются выровненные до 14 знаков значения: EAN-13, UPC-A и GTIN-14 одного товара совпадают.
    app.get('/products/by-barcode/:code', { config: asUser(), schema: { params: barcodeParam } }, async (req) => {
      const row = await productSelect()
        .where(sql<boolean>`lpad(products.barcode, 14, '0') = lpad(${req.params.code}, 14, '0')`)
        .orderBy('products.is_active', 'desc')
        .orderBy('products.name')
        .executeTakeFirst();
      if (!row) throw notFound('Продукт');
      return toProductDto(row);
    });

    // Каталог для сканера без связи: активные продукты со штрихкодом. Телефон хранит его на время работы.
    app.get('/products/scan-index', { config: asUser() }, async () => {
      const rows = await productSelect()
        .where('products.is_active', '=', true)
        .where('products.barcode', 'is not', null)
        .orderBy('products.name')
        .limit(SCAN_INDEX_LIMIT)
        .execute();
      return { items: rows.map(toProductDto), limit: SCAN_INDEX_LIMIT };
    });

    app.get('/products/:id', { config: asUser(), schema: { params: idParam } }, async (req) => {
      const row = await productSelect().where('products.id', '=', req.params.id).executeTakeFirst();
      if (!row) throw notFound('Продукт');
      return toProductDto(row);
    });

    app.post('/products', { config: asUser('manager'), schema: { body: createProductBody } }, async (req, reply) => {
      const b = req.body;
      try {
        const id = await db.transaction().execute(async (trx) => {
          const now = deps.clock();
          await assertOrderSettings(trx as unknown as typeof db, b.unit, b.packSize, b.defaultSupplierId);
          const created = await trx
            .insertInto('products')
            .values({
              sku: b.sku,
              barcode: b.barcode ?? null,
              name: b.name,
              category_id: b.categoryId,
              unit: b.unit,
              min_stock: b.minStock,
              shelf_life_days: b.shelfLifeDays ?? null,
              price: b.price,
              cost: b.cost,
              sellable: b.sellable,
              requires_vsd: b.requiresVsd,
              requires_marking: b.requiresMarking,
              default_supplier_id: b.defaultSupplierId ?? null,
              pack_size: b.packSize,
              created_at: now,
              updated_at: now,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await writeAudit(trx, {
            action: 'product.create',
            entity: 'product',
            entityId: created.id,
            principal: requirePrincipal(req),
            meta: req.meta,
            at: now,
            details: { sku: b.sku, name: b.name, price: b.price, cost: b.cost },
          });
          return created.id;
        });
        const row = await productSelect().where('products.id', '=', id).executeTakeFirstOrThrow();
        return reply.status(201).send(toProductDto(row));
      } catch (err) {
        return duplicateProduct(err);
      }
    });

    app.patch('/products/:id', { config: asUser('manager'), schema: { params: idParam, body: updateProductBody } }, async (req) => {
      const b = req.body;
      try {
        await db.transaction().execute(async (trx) => {
          const current = await trx.selectFrom('products').selectAll().where('id', '=', req.params.id).forUpdate().executeTakeFirst();
          if (!current) throw notFound('Продукт');

          if (b.unit !== undefined && b.unit !== current.unit) {
            const used = await trx.selectFrom('batches').select('id').where('product_id', '=', current.id).limit(1).executeTakeFirst();
            if (used) throw conflict('Единицу измерения нельзя менять после первого прихода', undefined, 'unit_locked');
          }

          const now = deps.clock();
          await assertOrderSettings(trx as unknown as typeof db, b.unit ?? current.unit, b.packSize ?? (b.unit !== undefined ? Number(current.pack_size) : undefined), b.defaultSupplierId);
          await trx
            .updateTable('products')
            .set({
              ...(b.sku !== undefined ? { sku: b.sku } : {}),
              ...(b.barcode !== undefined ? { barcode: b.barcode } : {}),
              ...(b.name !== undefined ? { name: b.name } : {}),
              ...(b.categoryId !== undefined ? { category_id: b.categoryId } : {}),
              ...(b.unit !== undefined ? { unit: b.unit } : {}),
              ...(b.minStock !== undefined ? { min_stock: b.minStock } : {}),
              ...(b.shelfLifeDays !== undefined ? { shelf_life_days: b.shelfLifeDays } : {}),
              ...(b.price !== undefined ? { price: b.price } : {}),
              ...(b.cost !== undefined ? { cost: b.cost } : {}),
              ...(b.sellable !== undefined ? { sellable: b.sellable } : {}),
              ...(b.requiresVsd !== undefined ? { requires_vsd: b.requiresVsd } : {}),
              ...(b.requiresMarking !== undefined ? { requires_marking: b.requiresMarking } : {}),
              ...(b.defaultSupplierId !== undefined ? { default_supplier_id: b.defaultSupplierId } : {}),
              ...(b.packSize !== undefined ? { pack_size: b.packSize } : {}),
              ...(b.isActive !== undefined ? { is_active: b.isActive } : {}),
              updated_at: now,
            })
            .where('id', '=', current.id)
            .execute();
          await writeAudit(trx, {
            action: 'product.update',
            entity: 'product',
            entityId: current.id,
            principal: requirePrincipal(req),
            meta: req.meta,
            at: now,
            details: {
              changes: b,
              before: { price: Number(current.price), cost: Number(current.cost), isActive: current.is_active },
            },
          });
        });
      } catch (err) {
        return duplicateProduct(err);
      }
      const row = await productSelect().where('products.id', '=', req.params.id).executeTakeFirstOrThrow();
      return toProductDto(row);
    });
  };
