import { addDays, completeInn, DEFAULT_ORG_ID, ORDER_STATUS_LABELS, type OrderStatus } from '@zapas/shared';
import { sql, type Transaction } from 'kysely';
import type { Database } from '../types';
import { PRODUCTS, SUPPLIERS } from './data';

export const SECOND_ORG = { name: 'Кофейня «Зерно»', adminEmail: 'coffee@zapas.local', adminName: 'Зорина Алёна Витальевна', adminPassword: 'Зерно-Кофе-72-лето' };

interface Ctx {
  now: Date;
  today: string;
  locations: Record<string, string>;
  suppliers: string[];
  products: Record<string, string>;
  dishes: Record<string, string>;
  userIds: Map<string, string>;
  passwordHash: string;
}

type Trx = Transaction<Database>;

/** Заказы поставщикам, которые сейчас в пути: по ним видно статусы и обмен с кабинетом поставщика. */
async function liveOrders(trx: Trx, c: Ctx, managerId: string | undefined): Promise<void> {
  const plan: { supplier: number; location: string; status: OrderStatus; ageHours: number; deliveryOn?: number; note?: string; buyerNote?: string }[] = [
    { supplier: 0, location: 'kit', status: 'sent', ageHours: 2 },
    { supplier: 2, location: 'kit', status: 'confirmed', ageHours: 20, deliveryOn: 1, note: 'Привезём завтра до десяти утра' },
    { supplier: 4, location: 'shopC', status: 'shipped', ageHours: 30, deliveryOn: 0, note: 'Машина выехала, будет к обеду' },
    { supplier: 1, location: 'wh', status: 'declined', ageHours: 40, note: 'Гречки нет до конца недели' },
    { supplier: 3, location: 'shopN', status: 'refused', ageHours: 50, deliveryOn: -1, note: 'Привезём к вечеру', buyerNote: 'Товар привезли с коротким сроком, поставку не приняли' },
  ];
  for (const o of plan) {
    const supplierId = c.suppliers[o.supplier];
    const items = PRODUCTS.filter((p) => p.supplier === o.supplier && p.unit !== undefined).slice(0, 3);
    if (!supplierId || items.length === 0) continue;
    const at = new Date(c.now.getTime() - o.ageHours * 3_600_000);
    const lines = items.map((p) => ({ productId: c.products[p.key] as string, quantity: p.unit === 'pcs' ? 60 : 25, unitCost: p.cost }));
    const total = Math.round(lines.reduce((s, l) => s + l.quantity * l.unitCost, 0) * 100) / 100;
    const row = await trx
      .insertInto('purchase_orders')
      .values({
        number: sql<string>`'ЗК-' || lpad(nextval('purchase_order_seq')::text, 6, '0')`,
        supplier_id: supplierId,
        location_id: c.locations[o.location] as string,
        status: o.status,
        expected_on: addDays(c.today, 2),
        comment: null,
        total,
        created_by: managerId ?? null,
        created_at: at,
        updated_at: at,
        sent_at: at,
        sent_by: managerId ?? null,
        closed_at: o.status === 'declined' || o.status === 'refused' ? at : null,
        delivery_on: o.deliveryOn === undefined ? null : addDays(c.today, o.deliveryOn),
        supplier_note: o.note ?? null,
        buyer_note: o.buyerNote ?? null,
      })
      .returning(['id', 'number'])
      .executeTakeFirstOrThrow();
    await trx.insertInto('purchase_order_lines').values(lines.map((l) => ({ order_id: row.id, product_id: l.productId, quantity: l.quantity, unit_cost: l.unitCost }))).execute();
    const events: { side: 'buyer' | 'supplier'; status: string; text: string; actor: string; at: Date }[] = [{ side: 'buyer', status: 'sent', text: 'Заказ отправлен поставщику', actor: 'Белова Ирина Викторовна', at }];
    const later = (h: number) => new Date(at.getTime() + h * 3_600_000);
    if (o.status !== 'sent') events.push({ side: 'supplier', status: o.status === 'declined' ? 'declined' : 'confirmed', text: o.status === 'declined' ? `Поставщик отказал в поставке: ${o.note}` : `Поставщик подтвердил заказ: ${o.note}`, actor: 'Кабинет поставщика', at: later(3) });
    if (o.status === 'shipped' || o.status === 'refused') events.push({ side: 'supplier', status: 'shipped', text: 'Поставщик отгрузил заказ', actor: 'Кабинет поставщика', at: later(12) });
    if (o.status === 'refused') events.push({ side: 'buyer', status: 'refused', text: `Отказ от поставки: ${o.buyerNote}`, actor: 'Белова Ирина Викторовна', at: later(20) });
    await trx.insertInto('purchase_order_events').values(events.map((e) => ({ order_id: row.id, side: e.side, status: e.status, text: e.text, actor: e.actor, created_at: e.at }))).execute();
    void ORDER_STATUS_LABELS;
  }
}

async function guestOrders(trx: Trx, c: Ctx): Promise<void> {
  const waiterId = c.userIds.get('waiter@zapas.local');
  const kitchen = c.locations.kit;
  if (!waiterId || !kitchen) return;
  const samples = [
    { table: '5', minutes: 12, lines: [['Борщ с говядиной', 2], ['Куриное филе с гречкой', 1]] as [string, number][], comment: 'Без зелени в одном борще' },
    { table: '9', minutes: 4, lines: [['Каша овсяная на молоке', 1]] as [string, number][], comment: null },
  ];
  for (const s of samples) {
    const at = new Date(c.now.getTime() - s.minutes * 60_000);
    const order = await trx
      .insertInto('guest_orders')
      .values({ number: sql<string>`'ЗК-' || lpad(nextval('guest_order_seq')::text, 6, '0')`, location_id: kitchen, table_label: s.table, waiter_id: waiterId, comment: s.comment, created_at: at, updated_at: at })
      .returning(['id', 'number'])
      .executeTakeFirstOrThrow();
    const dishes = await trx.selectFrom('dishes').select(['id', 'name', 'price']).where('id', 'in', s.lines.map(([n]) => c.dishes[n] as string)).execute();
    await trx
      .insertInto('guest_order_lines')
      .values(s.lines.map(([name, qty]) => ({ order_id: order.id, dish_id: c.dishes[name] as string, quantity: qty, price: dishes.find((d) => d.id === c.dishes[name])?.price ?? 0 })))
      .execute();
    await trx.insertInto('guest_order_events').values({ order_id: order.id, kind: 'created', text: `Заказ принят, стол ${s.table}`, actor: 'Соколова Мария Андреевна', created_at: at }).execute();
  }
}

/** Вторая организация: показывает, что данные организаций не смешиваются. Поставщик у неё с тем же ИНН, что и у первой. */
async function secondOrganization(trx: Trx, c: Ctx): Promise<void> {
  const org = await trx.insertInto('organizations').values({ name: SECOND_ORG.name }).returning('id').executeTakeFirstOrThrow();
  const admin = await trx
    .insertInto('users')
    .values({ org_id: org.id, email: SECOND_ORG.adminEmail, full_name: SECOND_ORG.adminName, password_hash: c.passwordHash, role: 'admin', locked_until: null, last_login_at: null, password_changed_at: c.now, created_at: c.now, updated_at: c.now })
    .returning('id')
    .executeTakeFirstOrThrow();
  const loc = await trx
    .insertInto('locations')
    .values({ org_id: org.id, code: 'COF-ZER', name: 'Кофейня «Зерно»', kind: 'cafe', address: 'Ростов-на-Дону, ул. Пушкинская, 40', created_at: c.now })
    .returning('id')
    .executeTakeFirstOrThrow();
  const cat = await trx.insertInto('categories').values({ org_id: org.id, name: 'Для кофейни' }).returning('id').executeTakeFirstOrThrow();
  const donskoy = SUPPLIERS[0];
  const supplier = await trx
    .insertInto('suppliers')
    .values({ org_id: org.id, name: donskoy?.name ?? 'Молочный комбинат «Донской»', inn: donskoy?.inn ?? completeInn('616301234'), phone: donskoy?.phone ?? null, email: donskoy?.email ?? null, lead_time_days: 1, min_order_sum: 1000 })
    .returning('id')
    .executeTakeFirstOrThrow();
  const specs = [
    { sku: 'ZR-MILK', name: 'Молоко 3,2% для кофе', unit: 'l' as const, cost: 62, price: 110, shelf: 7, qty: 40 },
    { sku: 'ZR-BEAN', name: 'Кофе в зёрнах', unit: 'kg' as const, cost: 1450, price: 2400, shelf: 120, qty: 6 },
    { sku: 'ZR-CROI', name: 'Круассан замороженный', unit: 'pcs' as const, cost: 38, price: 120, shelf: 60, qty: 80 },
  ];
  const product: Record<string, string> = {};
  for (const s of specs) {
    const p = await trx
      .insertInto('products')
      .values({ org_id: org.id, sku: s.sku, barcode: null, name: s.name, category_id: cat.id, unit: s.unit, min_stock: s.unit === 'pcs' ? 20 : 3, shelf_life_days: s.shelf, price: s.price, cost: s.cost, sellable: false, default_supplier_id: supplier.id, pack_size: 1, created_at: c.now, updated_at: c.now })
      .returning('id')
      .executeTakeFirstOrThrow();
    product[s.sku] = p.id;
    const doc = await trx
      .insertInto('documents')
      .values({ kind: 'receipt', number: sql<string>`'ПР-' || lpad(nextval('document_number_seq')::text, 6, '0')`, location_id: loc.id, created_by: admin.id, actor_name: SECOND_ORG.adminName, comment: null, created_at: c.now })
      .returning('id')
      .executeTakeFirstOrThrow();
    const batch = await trx
      .insertInto('batches')
      .values({ product_id: p.id, location_id: loc.id, supplier_id: supplier.id, origin_document_id: doc.id, document_no: 'ДЕМО', received_on: c.today, expires_on: addDays(c.today, s.shelf > 30 ? 40 : s.shelf), initial_qty: s.qty, remaining_qty: s.qty, unit_cost: s.cost, created_by: admin.id, created_at: c.now })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx.insertInto('stock_movements').values({ document_id: doc.id, batch_id: batch.id, product_id: p.id, location_id: loc.id, type: 'receipt', quantity: s.qty, unit_cost: s.cost, unit_price: null, reason: null, dish_id: null, comment: null, created_by: admin.id, created_at: c.now }).execute();
  }
  const dish = await trx.insertInto('dishes').values({ org_id: org.id, name: 'Капучино', price: 230, code: 'cappuccino', created_at: c.now, updated_at: c.now }).returning('id').executeTakeFirstOrThrow();
  await trx.insertInto('dish_items').values([{ dish_id: dish.id, product_id: product['ZR-MILK'] as string, quantity: 0.2 }, { dish_id: dish.id, product_id: product['ZR-BEAN'] as string, quantity: 0.018 }]).execute();

  // заказ тому же молочному комбинату: в его кабинете появится второй покупатель
  const at = new Date(c.now.getTime() - 5 * 3_600_000);
  const order = await trx
    .insertInto('purchase_orders')
    .values({ number: sql<string>`'ЗК-' || lpad(nextval('purchase_order_seq')::text, 6, '0')`, supplier_id: supplier.id, location_id: loc.id, status: 'sent', expected_on: addDays(c.today, 2), comment: null, total: 1860, created_by: admin.id, created_at: at, updated_at: at, sent_at: at, sent_by: admin.id })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx.insertInto('purchase_order_lines').values({ order_id: order.id, product_id: product['ZR-MILK'] as string, quantity: 30, unit_cost: 62 }).execute();
  await trx.insertInto('purchase_order_events').values({ order_id: order.id, side: 'buyer', status: 'sent', text: 'Заказ отправлен поставщику', actor: SECOND_ORG.adminName, created_at: at }).execute();
}

export async function seedPlatformDemo(trx: Trx, c: Ctx): Promise<void> {
  const manager = c.userIds.get('manager@zapas.local');
  await liveOrders(trx, c, manager);
  await guestOrders(trx, c);
  await secondOrganization(trx, c);
  void DEFAULT_ORG_ID;
}
