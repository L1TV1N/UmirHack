import { checkPassword, DEFAULT_EXPIRY_THRESHOLDS, gtinCheckDigit, todayIn } from '@zapas/shared';
import { sql } from 'kysely';
import type { Config } from '../../config';
import { hashPassword } from '../../modules/auth/password';
import { writeAudit } from '../../modules/audit/audit';
import { DEFAULT_SETTINGS } from '../../modules/settings/settings';
import { createDb } from '../client';
import { demoWeatherRange, DEMO_COORDINATES } from './weather';
import { dishCode, DISHES, isMarked, kitchenDemandPerDay, LOCATIONS, packFor, PRODUCTS, RETAIL_DEMAND, SUPPLIERS, USERS, VSD_CATEGORIES } from './data';
import { seedHaccp } from './haccp';
import { seedTraceability } from './traceability';
import { simulate } from './simulate';

const HISTORY_DAYS = 60;
const CHUNK = 800;

const n3 = (v: number) => v.toFixed(3);

/** Настоящий EAN-13 с верной контрольной цифрой: такие коды распознаёт сканер и печатает лист демо-штрихкодов. */
export function demoBarcode(index: number): string {
  const body = `46070000${String(1000 + index * 7).padStart(4, '0')}`;
  return `${body}${gtinCheckDigit(body)}`;
}

function hourIn(timeZone: string, at: Date): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(at));
}

/** Порог «ниже минимума»: страховой запас в полтора дня спроса на самой тихой точке, где позиция продаётся. */
function minStockFor(key: string, unit: 'kg' | 'l' | 'pcs', kitchen: Map<string, number>): number {
  const demands = [
    ...Object.values(RETAIL_DEMAND).flatMap((d) => (d[key] ? [d[key] as number] : [])),
    ...(kitchen.has(key) ? [kitchen.get(key) as number] : []),
  ];
  if (demands.length === 0) return 0;
  const raw = 1.5 * Math.min(...demands);
  return unit === 'pcs' ? Math.max(1, Math.round(raw)) : Math.max(0.1, Math.round(raw * 10) / 10);
}

async function insertChunks<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) await insert(rows.slice(i, i + CHUNK));
}

export interface SeedResult {
  documents: number;
  batches: number;
  movements: number;
}

export async function seed(config: Config, options: { reset: boolean; log: (m: string) => void }): Promise<SeedResult> {
  if (config.env === 'production') throw new Error('Демо-данные нельзя загружать в production');

  const handle = createDb(config.migrationDatabaseUrl, 2);
  const { db } = handle;
  try {
    const existing = await db.selectFrom('users').select('id').limit(1).executeTakeFirst();
    if (existing && !options.reset) {
      throw new Error('В базе уже есть данные. Чтобы очистить и загрузить заново, добавьте --reset');
    }
    if (options.reset) {
      const tables = await sql<{ tablename: string }>`
        select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'`.execute(db);
      await sql.raw(`TRUNCATE ${tables.rows.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`).execute(db);
      await sql`ALTER SEQUENCE document_number_seq RESTART WITH 1`.execute(db);
      options.log('Данные очищены');
    }

    const now = new Date();
    const today = todayIn(config.businessTz, now);
    const ids = {
      locations: {} as Record<string, string>,
      products: {} as Record<string, string>,
      suppliers: [] as string[],
      dishes: {} as Record<string, string>,
    };

    const passwords = new Map<string, string>();
    for (const u of USERS) {
      const problem = checkPassword(u.password, { email: u.email, fullName: u.fullName });
      if (problem) throw new Error(`Пароль ${u.email} не проходит политику: ${problem}`);
      passwords.set(u.email, await hashPassword(u.password));
    }

    await db.transaction().execute(async (trx) => {
      for (const l of LOCATIONS) {
        const row = await trx
          .insertInto('locations')
          .values({ code: l.code, name: l.name, kind: l.kind, address: l.address, latitude: DEMO_COORDINATES.latitude, longitude: DEMO_COORDINATES.longitude, created_at: now })
          .returning('id')
          .executeTakeFirstOrThrow();
        ids.locations[l.key] = row.id;
      }

      for (const u of USERS) {
        const row = await trx
          .insertInto('users')
          .values({
            email: u.email,
            full_name: u.fullName,
            password_hash: passwords.get(u.email) as string,
            role: u.role,
            locked_until: null,
            last_login_at: null,
            password_changed_at: now,
            created_at: now,
            updated_at: now,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const links = u.locations.map((key) => ({ user_id: row.id, location_id: ids.locations[key] as string }));
        if (links.length) await trx.insertInto('user_locations').values(links).execute();
      }

      const categoryNames = [...new Set(PRODUCTS.map((p) => p.category))];
      const categoryIds = new Map<string, string>();
      for (const name of categoryNames) {
        const row = await trx.insertInto('categories').values({ name }).returning('id').executeTakeFirstOrThrow();
        categoryIds.set(name, row.id);
      }
      for (const s of SUPPLIERS) {
        const row = await trx
          .insertInto('suppliers')
          .values({ name: s.name, inn: s.inn, phone: s.phone, note: null, email: s.email, lead_time_days: s.leadTimeDays, min_order_sum: s.minOrderSum, auto_order: s.autoOrder })
          .returning('id')
          .executeTakeFirstOrThrow();
        ids.suppliers.push(row.id);
      }
      const kitchen = kitchenDemandPerDay();
      for (const [i, p] of PRODUCTS.entries()) {
        const row = await trx
          .insertInto('products')
          .values({
            sku: p.sku,
            barcode: demoBarcode(i),
            name: p.name,
            category_id: categoryIds.get(p.category) as string,
            unit: p.unit,
            min_stock: minStockFor(p.key, p.unit, kitchen),
            shelf_life_days: p.shelf,
            price: p.price,
            cost: p.cost,
            sellable: p.sellable,
            requires_vsd: VSD_CATEGORIES.has(p.category),
            requires_marking: isMarked(p),
            default_supplier_id: ids.suppliers[p.supplier] ?? null,
            pack_size: packFor(p),
            created_at: now,
            updated_at: now,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        ids.products[p.key] = row.id;
      }
      for (const [i, d] of DISHES.entries()) {
        const row = await trx
          .insertInto('dishes')
          .values({ name: d.name, price: d.price, code: dishCode(i), created_at: now, updated_at: now })
          .returning('id')
          .executeTakeFirstOrThrow();
        ids.dishes[d.name] = row.id;
        await trx
          .insertInto('dish_items')
          .values(d.items.map(([key, quantity]) => ({ dish_id: row.id, product_id: ids.products[key] as string, quantity })))
          .execute();
      }
      await trx
        .insertInto('settings')
        .values({ key: 'app', value: JSON.stringify({ ...DEFAULT_SETTINGS, ...DEFAULT_EXPIRY_THRESHOLDS }), updated_by: null, updated_at: now })
        .execute();
    });
    options.log('Справочники загружены');

    // история погоды за три месяца и прогноз на две недели: по ней модель учится, как погода влияет на продажи
    const weatherRows = demoWeatherRange(today, 92, 16).flatMap((w) =>
      Object.values(ids.locations).map((locationId) => ({ location_id: locationId, day: w.date, t_max: w.weather.tMax, t_min: w.weather.tMin, precip_mm: w.weather.precip, is_forecast: w.forecast, fetched_at: now })),
    );
    await insertChunks(weatherRows, (chunk) => db.insertInto('weather_daily').values(chunk).execute());

    const sim = simulate({ today, days: HISTORY_DAYS, ids, nowHour: hourIn(config.businessTz, now) });

    await db.transaction().execute(async (trx) => {
      await insertChunks(sim.orders, (chunk) =>
        trx
          .insertInto('purchase_orders')
          .values(
            chunk.map((o) => ({
              id: o.id,
              number: o.number,
              supplier_id: o.supplierId,
              location_id: o.locationId,
              status: 'received' as const,
              expected_on: o.expectedOn,
              comment: null,
              total: o.total,
              created_by: null,
              created_at: o.sentAt,
              updated_at: o.closedAt,
              sent_at: o.sentAt,
              sent_by: null,
              closed_at: o.closedAt,
            })),
          )
          .execute(),
      );
      await insertChunks(
        sim.orders.flatMap((o) => o.lines.map((l) => ({ order_id: o.id, product_id: l.productId, quantity: l.quantity, unit_cost: l.unitCost, received_qty: l.received }))),
        (chunk) => trx.insertInto('purchase_order_lines').values(chunk).execute(),
      );
      await sql`SELECT setval('purchase_order_seq', ${Math.max(sim.orders.length, 1)})`.execute(trx);
      await insertChunks(sim.documents, (chunk) =>
        trx
          .insertInto('documents')
          .values(
            chunk.map((d) => ({
              id: d.id,
              kind: d.kind,
              number: d.number,
              location_id: d.locationId,
              to_location_id: d.toLocationId,
              created_by: null,
              actor_name: d.actor,
              comment: d.comment,
              idempotency_scope: null,
              idempotency_key: null,
              order_id: d.orderId ?? null,
              created_at: d.createdAt,
            })),
          )
          .execute(),
      );
      await insertChunks(sim.batches, (chunk) =>
        trx
          .insertInto('batches')
          .values(
            chunk.map((b) => ({
              id: b.id,
              product_id: b.productId,
              location_id: b.locationId,
              supplier_id: b.supplierId,
              origin_document_id: b.docId,
              document_no: b.documentNo,
              received_on: b.receivedOn,
              expires_on: b.expiresOn,
              initial_qty: n3(b.initial),
              remaining_qty: n3(b.remaining),
              unit_cost: b.unitCost,
              created_by: null,
              created_at: b.createdAt,
            })),
          )
          .execute(),
      );
      const ordered = [...sim.movements].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      await insertChunks(ordered, (chunk) =>
        trx
          .insertInto('stock_movements')
          .values(
            chunk.map((m) => ({
              document_id: m.docId,
              batch_id: m.batchId,
              product_id: m.productId,
              location_id: m.locationId,
              type: m.type,
              quantity: n3(m.quantity),
              unit_cost: m.unitCost,
              unit_price: m.unitPrice,
              reason: m.reason,
              dish_id: m.dishId,
              comment: null,
              created_by: null,
              created_at: m.createdAt,
            })),
          )
          .execute(),
      );
      await insertChunks(sim.promotions, (chunk) =>
        trx
          .insertInto('promotions')
          .values(chunk.map((p) => ({ batch_id: p.batchId, percent: p.percent, ends_on: p.endsOn, created_by: null, created_at: p.createdAt, cancelled_at: p.cancelledAt })))
          .execute(),
      );
      await insertChunks(sim.shortages, (chunk) =>
        trx
          .insertInto('shortage_episodes')
          .values(chunk.map((s) => ({ location_id: s.locationId, product_id: s.productId, started_at: s.startedAt, ended_at: s.endedAt, dishes_blocked: s.dishesBlocked })))
          .execute(),
      );
      await insertChunks(sim.refusals, (chunk) =>
        trx
          .insertInto('sale_refusals')
          .values(chunk.map((r) => ({ location_id: r.locationId, created_at: r.createdAt, order_total: r.total, missing: r.missing, source: 'pos' as const })))
          .execute(),
      );
      await sql`SELECT setval('document_number_seq', ${sim.lastNumber})`.execute(trx);

      const broken = await sql<{ n: number }>`
        SELECT count(*) AS n FROM (
          SELECT b.id FROM batches b
          LEFT JOIN stock_movements m ON m.batch_id = b.id
          GROUP BY b.id, b.remaining_qty
          HAVING abs(b.remaining_qty - COALESCE(SUM(m.quantity), 0)) > 0.0001
        ) x`.execute(trx);
      if (Number(broken.rows[0]?.n) > 0) throw new Error('Остатки партий не сходятся с журналом движений');

      await seedTraceability(trx, now, today);
      await seedHaccp(trx, ids.locations, now, today);

      await writeAudit(trx, {
        action: 'seed.run',
        details: { days: HISTORY_DAYS, documents: sim.documents.length, batches: sim.batches.length, movements: sim.movements.length },
        at: now,
      });
    });

    return { documents: sim.documents.length, batches: sim.batches.length, movements: sim.movements.length };
  } finally {
    await handle.close();
  }
}
