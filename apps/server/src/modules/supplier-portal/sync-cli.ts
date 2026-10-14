import { loadEnvFile, parseConfig } from '../../config';
import { createDb } from '../../db/client';
import { HttpSupplierPortal } from './client';
import { pushOrder } from './service';

/** Передаёт кабинету поставщика все отправленные заказы: после подключения кабинета или после загрузки демо-данных. */
loadEnvFile();
const config = parseConfig();
if (!config.supplierPortal) {
  console.error('Кабинет поставщика не подключён: задайте SUPPLIER_PORTAL_URL и SUPPLIER_PORTAL_SECRET');
  process.exit(1);
}
const handle = createDb(config.databaseUrl, 2);
const log = { info: () => undefined, warn: console.warn, error: console.error };
const deps = {
  db: handle.db,
  config,
  clock: () => new Date(),
  log,
  notifier: { enabled: false, send: async () => undefined },
  supplierPortal: new HttpSupplierPortal(config.supplierPortal.url, config.supplierPortal.secret, config.supplierPortal.publicUrl),
};
// по умолчанию открытые заказы и закрытые за последнюю неделю; все до единого: --all
const since = new Date(Date.now() - 7 * 86_400_000);
const all = process.argv.includes('--all');
const rows = await handle.db
  .selectFrom('purchase_orders')
  .select(['id', 'number'])
  .where('status', '<>', 'draft')
  .$if(!all, (qb) => qb.where((eb) => eb.or([eb('status', 'not in', ['received', 'cancelled']), eb('updated_at', '>=', since)])))
  .orderBy('created_at')
  .execute();
let ok = 0;
for (const r of rows) {
  await pushOrder(deps as never, r.id);
  const state = await handle.db.selectFrom('purchase_orders').select('portal_error').where('id', '=', r.id).executeTakeFirstOrThrow();
  if (state.portal_error) console.log(`${r.number}: ${state.portal_error}`);
  else ok += 1;
}
console.log(`Передано заказов: ${ok} из ${rows.length}`);
await handle.close();
