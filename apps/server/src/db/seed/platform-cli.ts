import { DEFAULT_ORG_ID, todayIn } from '@zapas/shared';
import { loadEnvFile, parseConfig } from '../../config';
import { hashPassword } from '../../modules/auth/password';
import { createDb } from '../client';
import { LOCATIONS, PRODUCTS, SUPPLIERS, USERS } from './data';
import { SECOND_ORG, seedPlatformDemo } from './extras';

/**
 * Добавляет к уже загруженным демо-данным официанта, заказы гостей, заказы поставщикам в пути и вторую организацию.
 * Ничего не стирает; повторный запуск ничего не меняет, если официант уже есть.
 */
loadEnvFile();
const config = parseConfig();
const handle = createDb(config.databaseUrl, 2);
try {
  const db = handle.db;
  const waiterSpec = USERS.find((u) => u.role === 'waiter');
  if (!waiterSpec) throw new Error('В демо-данных нет официанта');
  const exists = await db.selectFrom('users').select('id').where('email', '=', waiterSpec.email).executeTakeFirst();
  if (exists) {
    console.log('Демо-данные платформы уже загружены');
    process.exit(0);
  }

  const now = new Date();
  const today = todayIn(config.businessTz, now);
  const locationRows = await db.selectFrom('locations').select(['id', 'code']).where('org_id', '=', DEFAULT_ORG_ID).execute();
  const locations: Record<string, string> = {};
  for (const l of LOCATIONS) {
    const row = locationRows.find((r) => r.code === l.code);
    if (row) locations[l.key] = row.id;
  }
  const supplierRows = await db.selectFrom('suppliers').select(['id', 'inn']).where('org_id', '=', DEFAULT_ORG_ID).execute();
  const suppliers = SUPPLIERS.map((s) => supplierRows.find((r) => r.inn === s.inn)?.id ?? '');
  const productRows = await db.selectFrom('products').select(['id', 'sku']).where('org_id', '=', DEFAULT_ORG_ID).execute();
  const products: Record<string, string> = {};
  for (const p of PRODUCTS) {
    const row = productRows.find((r) => r.sku === p.sku);
    if (row) products[p.key] = row.id;
  }
  const dishRows = await db.selectFrom('dishes').select(['id', 'name']).where('org_id', '=', DEFAULT_ORG_ID).execute();
  const dishes = Object.fromEntries(dishRows.map((d) => [d.name, d.id]));
  if (!locations.kit || supplierRows.length === 0 || dishRows.length === 0) throw new Error('Сначала загрузите основные демо-данные: npm run seed');

  await db.transaction().execute(async (trx) => {
    const userIds = new Map<string, string>();
    const manager = await trx.selectFrom('users').select('id').where('email', '=', 'manager@zapas.local').executeTakeFirst();
    if (manager) userIds.set('manager@zapas.local', manager.id);
    const waiter = await trx
      .insertInto('users')
      .values({
        org_id: DEFAULT_ORG_ID,
        email: waiterSpec.email,
        full_name: waiterSpec.fullName,
        password_hash: await hashPassword(waiterSpec.password),
        role: 'waiter',
        locked_until: null,
        last_login_at: null,
        password_changed_at: now,
        created_at: now,
        updated_at: now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    userIds.set(waiterSpec.email, waiter.id);
    await trx.insertInto('user_locations').values(waiterSpec.locations.map((key) => ({ user_id: waiter.id, location_id: locations[key] as string }))).execute();
    await seedPlatformDemo(trx, { now, today, locations, suppliers, products, dishes, userIds, passwordHash: await hashPassword(SECOND_ORG.adminPassword) });
  });
  console.log('Добавлены: официант, заявки гостей, заказы поставщикам в пути, организация «Кофейня «Зерно»»');
} finally {
  await handle.close();
}
