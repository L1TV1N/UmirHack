import { daysWord, formatQty, type OrderSuggestionDto, type OrderSuggestionLineDto } from '@zapas/shared';
import { LOW_CONFIDENCE } from '../../domain/risk';
import { stockKey } from '../../domain/stoplist';
import type { Deps } from '../../lib/context';
import { getSnapshot } from '../analytics/snapshot';

/** Запас прочности сверх срока поставки: заказываем, пока остатка хватает хотя бы на поставку и ещё сутки. */
const BUFFER_DAYS = 1;

const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;
const roundMoney = (v: number) => Math.round(v * 100) / 100;

/**
 * Что и сколько заказать по каждому поставщику и точке. Считается из остатка без просрочки, скорости продаж,
 * минимального остатка и того, что уже заказано и ещё не принято, чтобы не заказывать дважды.
 * Продукты без поставщика по умолчанию не предлагаются: заказывать их не у кого.
 */
export async function suggestOrders(deps: Deps, locationIds: string[] | null, filter: { supplierId?: string } = {}): Promise<OrderSuggestionDto[]> {
  const { db } = deps;
  const snap = await getSnapshot(deps, locationIds);
  const productRows = await db
    .selectFrom('products')
    .select(['id', 'default_supplier_id', 'pack_size'])
    .where('default_supplier_id', 'is not', null)
    .where('is_active', '=', true)
    .$if(filter.supplierId !== undefined, (qb) => qb.where('default_supplier_id', '=', filter.supplierId as string))
    .execute();
  if (productRows.length === 0) return [];
  const setup = new Map(productRows.map((p) => [p.id, { supplierId: p.default_supplier_id as string, pack: Number(p.pack_size) }]));

  const suppliers = new Map(
    (await db.selectFrom('suppliers').select(['id', 'name', 'email', 'lead_time_days', 'min_order_sum']).where('is_active', '=', true).execute()).map((s) => [s.id, s]),
  );

  const incomingRows = await db
    .selectFrom('purchase_order_lines as l')
    .innerJoin('purchase_orders as o', 'o.id', 'l.order_id')
    .select(['l.product_id', 'o.location_id', (eb) => eb.fn.sum<string>(eb('l.quantity', '-', eb.ref('l.received_qty'))).as('qty')])
    .where('o.status', 'in', ['sent', 'partial'])
    .groupBy(['l.product_id', 'o.location_id'])
    .execute();
  const incoming = new Map(incomingRows.map((r) => [stockKey(r.product_id, r.location_id), Math.max(0, Number(r.qty))]));

  const drafts = new Map(
    (await db.selectFrom('purchase_orders').select(['id', 'supplier_id', 'location_id']).where('status', '=', 'draft').execute()).map((d) => [`${d.supplier_id}|${d.location_id}`, d.id]),
  );

  const groups = new Map<string, OrderSuggestionDto>();
  for (const key of snap.tracked) {
    const [productId, locationId] = key.split('|');
    if (!productId || !locationId) continue;
    const cfg = setup.get(productId);
    const product = snap.products.get(productId);
    const location = snap.locations.get(locationId);
    if (!cfg || !product || !product.isActive || !location || !location.isActive) continue;
    const supplier = suppliers.get(cfg.supplierId);
    if (!supplier) continue;

    const available = (snap.stock.get(key)?.availableMilli ?? 0) / 1000;
    const onTheWay = incoming.get(key) ?? 0;
    const v = snap.velocities.get(key);
    const trusted = v !== undefined && v.confidence >= LOW_CONFIDENCE && v.perDay > 0;
    const perDay = trusted ? v.perDay : 0;
    const position = available + onTheWay;
    const lead = supplier.lead_time_days;

    const belowMin = product.minStock > 0 && position <= product.minStock;
    const runsOut = trusted && position <= perDay * (lead + BUFFER_DAYS);
    if (!belowMin && !runsOut) continue;

    const target = Math.max(trusted ? perDay * (lead + snap.settings.reorderCoverDays) : 0, product.minStock * 2);
    const need = target - position;
    if (need <= 0) continue;
    const pack = cfg.pack > 0 ? cfg.pack : 1;
    const quantity = round(Math.ceil(round(need / pack, 6)) * pack, 3);
    const daysCover = trusted ? round(position / perDay, 1) : null;

    const reason = runsOut
      ? `Хватит ${daysCover !== null && daysCover < 1 ? 'меньше чем на сутки' : `на ${daysWord(Math.floor(daysCover ?? 0))}`}, поставка занимает ${daysWord(lead)}`
      : `Остаток ${formatQty(round(available, 3), product.unit)} не больше минимального ${formatQty(product.minStock, product.unit)}`;

    const line: OrderSuggestionLineDto = {
      productId,
      productName: product.name,
      sku: product.sku,
      unit: product.unit,
      quantity,
      unitCost: product.cost,
      sum: roundMoney(quantity * product.cost),
      available: round(available, 3),
      incoming: round(onTheWay, 3),
      perDay: round(perDay, 3),
      daysCover,
      packSize: pack,
      reason: reason.replace(/[  ]/g, ' '),
    };
    const gkey = `${supplier.id}|${locationId}`;
    let group = groups.get(gkey);
    if (!group) {
      group = {
        supplierId: supplier.id,
        supplierName: supplier.name,
        supplierEmail: supplier.email,
        leadTimeDays: lead,
        minOrderSum: Number(supplier.min_order_sum),
        locationId,
        locationName: location.name,
        lines: [],
        total: 0,
        belowMinimum: false,
        draftId: drafts.get(gkey) ?? null,
      };
      groups.set(gkey, group);
    }
    group.lines.push(line);
  }

  const out = [...groups.values()];
  for (const g of out) {
    g.lines.sort((a, b) => (a.daysCover ?? 99) - (b.daysCover ?? 99) || a.productName.localeCompare(b.productName, 'ru'));
    g.total = roundMoney(g.lines.reduce((s, l) => s + l.sum, 0));
    g.belowMinimum = g.total < g.minOrderSum;
  }
  out.sort((a, b) => a.locationName.localeCompare(b.locationName, 'ru') || a.supplierName.localeCompare(b.supplierName, 'ru'));
  return out;
}
