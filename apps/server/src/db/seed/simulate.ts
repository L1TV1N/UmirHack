import { addDays, daysBetween } from '@zapas/shared';
import { DISHES, kitchenDemandPerDay, PRODUCTS, RETAIL_DEMAND, SHORTAGE_HISTORY, SUPPLIER_PROFILES, SUPPLIERS, VIA_WAREHOUSE, type ProductSpec } from './data';
import { demoWeather, weatherMultiplier } from './weather';

export interface DocRow {
  id: string;
  kind: 'receipt' | 'sale' | 'writeoff' | 'transfer';
  number: string;
  locationId: string;
  toLocationId: string | null;
  actor: string;
  comment: string | null;
  createdAt: Date;
  /** Заказ поставщику, по которому принят приход. */
  orderId?: string | null;
}

export interface BatchRow {
  id: string;
  productId: string;
  locationId: string;
  supplierId: string;
  docId: string;
  documentNo: string | null;
  receivedOn: string;
  expiresOn: string;
  initial: number;
  remaining: number;
  unitCost: number;
  createdAt: Date;
}

export interface MoveRow {
  docId: string;
  batchId: string;
  productId: string;
  locationId: string;
  type: 'receipt' | 'sale' | 'writeoff' | 'transfer_in' | 'transfer_out';
  quantity: number;
  unitCost: number;
  unitPrice: number | null;
  reason: 'expired' | 'spoiled' | 'damaged' | 'shortage' | 'other' | null;
  dishId: string | null;
  createdAt: Date;
}

export interface SimIds {
  locations: Record<string, string>;
  products: Record<string, string>;
  suppliers: string[];
  dishes: Record<string, string>;
}

export interface SimShortage {
  productId: string;
  locationId: string;
  startedAt: Date;
  endedAt: Date | null;
  dishesBlocked: number;
}

export interface SimRefusal {
  locationId: string;
  createdAt: Date;
  total: number;
  missing: string[];
}

export interface SimOrder {
  id: string;
  number: string;
  supplierId: string;
  locationId: string;
  expectedOn: string;
  sentAt: Date;
  closedAt: Date;
  total: number;
  lines: { productId: string; quantity: number; unitCost: number; received: number }[];
}

export interface SimPromotion {
  batchId: string;
  percent: number;
  endsOn: string;
  createdAt: Date;
  cancelledAt: Date | null;
}

export interface SimOutput {
  documents: DocRow[];
  batches: BatchRow[];
  movements: MoveRow[];
  orders: SimOrder[];
  promotions: SimPromotion[];
  shortages: SimShortage[];
  refusals: SimRefusal[];
  lastNumber: number;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// по дням недели, 0 = воскресенье
const WEEKDAY = [1.1, 0.88, 0.92, 1.0, 1.05, 1.22, 1.38];
const PREFIX = { receipt: 'ПР', sale: 'ПД', writeoff: 'СП', transfer: 'ПМ' } as const;

// Кассы выгружают продажи сменами в течение дня, а не одним документом в полночь
interface Shift {
  key: string;
  hour: number;
  share: number;
}
const RETAIL_SHIFTS: Shift[] = [
  { key: 'm', hour: 12, share: 0.3 },
  { key: 'd', hour: 16, share: 0.3 },
  { key: 'e', hour: 21, share: 0.4 },
];
const KITCHEN_SHIFTS: Shift[] = [
  { key: 'l', hour: 15, share: 0.45 },
  { key: 'e', hour: 22, share: 0.55 },
];

const milli = (v: number): number => Math.round(v * 1000);

interface SimBatch extends BatchRow {
  remainingMilli: number;
}

/**
 * Симуляция торговли за период. Всё считается в тысячных долях, чтобы остатки партий
 * сходились с журналом движений до последнего знака. Сценарии «на сегодня» вносятся в конце.
 */
export function simulate(opts: { today: string; days: number; ids: SimIds; nowHour?: number; seed?: number }): SimOutput {
  const rng = mulberry32(opts.seed ?? 20261009);
  const { ids, today } = opts;
  const nowHour = opts.nowHour ?? 24;
  const productSpec = new Map<string, ProductSpec>(PRODUCTS.map((x) => [x.key, x]));

  const documents: DocRow[] = [];
  const batches: SimBatch[] = [];
  const movements: MoveRow[] = [];
  let number = 0;
  const docCache = new Map<string, DocRow>();

  // документы сегодняшнего дня не должны оказаться в будущем, если демо-данные загружают рано утром
  const at = (date: string, hour: number, minute = 0) => {
    const h = date === today ? Math.min(hour, Math.max(nowHour - 1, 0)) : hour;
    return new Date(`${date}T${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+03:00`);
  };

  function doc(kind: DocRow['kind'], locKey: string, date: string, extra: string, hour: number, comment: string | null, toLoc?: string): DocRow {
    const cacheKey = `${kind}|${locKey}|${date}|${extra}`;
    const cached = docCache.get(cacheKey);
    if (cached) return cached;
    number += 1;
    const row: DocRow = {
      id: crypto.randomUUID(),
      kind,
      number: `${PREFIX[kind]}-${String(number).padStart(6, '0')}`,
      locationId: ids.locations[locKey] as string,
      toLocationId: toLoc ? (ids.locations[toLoc] as string) : null,
      actor: kind === 'sale' ? `Касса ${locKey === 'kit' ? 'кухни' : 'магазина'}` : 'Козлов Андрей Николаевич',
      comment,
      createdAt: at(date, hour, Math.floor(rng() * 40)),
    };
    docCache.set(cacheKey, row);
    documents.push(row);
    return row;
  }

  const pairKey = (product: string, loc: string) => `${product}|${loc}`;
  const stock = new Map<string, SimBatch[]>();

  function liveBatches(product: string, loc: string): SimBatch[] {
    return stock.get(pairKey(product, loc)) ?? [];
  }

  function receive(product: string, loc: string, date: string, qty: number, shelfLeft: number, hour = 7): SimBatch {
    const spec = productSpec.get(product) as ProductSpec;
    const d = doc('receipt', loc, date, spec.supplier.toString(), hour, null);
    const wobble = 1 + (rng() - 0.5) * 0.06;
    const unitCost = Math.round(spec.cost * wobble * 100) / 100;
    const m = milli(qty);
    const batch: SimBatch = {
      id: crypto.randomUUID(),
      productId: ids.products[product] as string,
      locationId: ids.locations[loc] as string,
      supplierId: ids.suppliers[spec.supplier] as string,
      docId: d.id,
      documentNo: `${['МК', 'АЗ', 'МА', 'СУ', 'ХЗ', 'РД'][spec.supplier] ?? 'ПС'}-${100 + Math.floor(rng() * 899)}`,
      receivedOn: date,
      expiresOn: addDays(date, shelfLeft),
      initial: qty,
      remaining: 0,
      remainingMilli: m,
      unitCost,
      createdAt: d.createdAt,
    };
    batches.push(batch);
    const list = stock.get(pairKey(product, loc)) ?? [];
    list.push(batch);
    stock.set(pairKey(product, loc), list);
    movements.push({
      docId: d.id,
      batchId: batch.id,
      productId: batch.productId,
      locationId: batch.locationId,
      type: 'receipt',
      quantity: m / 1000,
      unitCost,
      unitPrice: null,
      reason: null,
      dishId: null,
      createdAt: d.createdAt,
    });
    return batch;
  }

  const fefo = (list: SimBatch[], date: string) =>
    list.filter((b) => b.remainingMilli > 0 && b.expiresOn >= date).sort((a, b) => (a.expiresOn < b.expiresOn ? -1 : a.expiresOn > b.expiresOn ? 1 : a.receivedOn < b.receivedOn ? -1 : 1));

  const availableMilli = (product: string, loc: string, date: string) =>
    fefo(liveBatches(product, loc), date).reduce((s, b) => s + b.remainingMilli, 0);

  // Скоропорт в последние дни срока магазины уценивают: за три дня 30%, в последние сутки 50%. Как в рекомендациях системы
  const markdownTiers = new Map<string, Map<number, Date>>();
  const markdownOrder = new Map<string, number>();
  function markdownPercent(batch: SimBatch, date: string, spec: ProductSpec, meta: { price?: number | null; dishId?: string | null }): number {
    if (meta.price !== undefined || meta.dishId) return 0;
    const left = daysBetween(date, batch.expiresOn);
    if (spec.shelf > 14 || left > 3 || left < 0) return 0;
    // уценивают не всё подряд, а отдельные партии: каждую пятую из подходящих
    if (!markdownOrder.has(batch.id)) markdownOrder.set(batch.id, markdownOrder.size);
    if ((markdownOrder.get(batch.id) as number) % 5 !== 0) return 0;
    const percent = left <= 1 ? 50 : 30;
    const tiers = markdownTiers.get(batch.id) ?? new Map<number, Date>();
    if (!tiers.has(percent)) tiers.set(percent, at(date, 8, 5));
    markdownTiers.set(batch.id, tiers);
    return percent;
  }

  /** Расход по FEFO. Возвращает фактически списанное в тысячных. */
  function consume(
    product: string,
    loc: string,
    date: string,
    wantMilli: number,
    kind: 'sale' | 'writeoff' | 'transfer',
    meta: { docDay: string; hour: number; shift?: string; price?: number | null; reason?: MoveRow['reason']; dishId?: string | null; revenueShare?: number; toLoc?: string; includeExpired?: boolean },
  ): { taken: number; batches: { batch: SimBatch; milli: number }[] } {
    const spec = productSpec.get(product) as ProductSpec;
    const pool = meta.includeExpired
      ? liveBatches(product, loc).filter((b) => b.remainingMilli > 0).sort((a, b) => (a.expiresOn < b.expiresOn ? -1 : 1))
      : fefo(liveBatches(product, loc), date);
    let left = wantMilli;
    const taken: { batch: SimBatch; milli: number }[] = [];
    for (const b of pool) {
      if (left <= 0) break;
      const take = Math.min(b.remainingMilli, left);
      b.remainingMilli -= take;
      left -= take;
      taken.push({ batch: b, milli: take });
    }
    const total = wantMilli - left;
    if (total === 0) return { taken: 0, batches: [] };

    const d = doc(kind, loc, meta.docDay, kind === 'writeoff' ? (meta.reason ?? 'other') : kind === 'transfer' ? (meta.toLoc ?? '') : (meta.shift ?? ''), meta.hour, kind === 'writeoff' && meta.reason === 'expired' ? 'Списание просроченного' : null, meta.toLoc);
    for (const t of taken) {
      movements.push({
        docId: d.id,
        batchId: t.batch.id,
        productId: t.batch.productId,
        locationId: t.batch.locationId,
        type: kind === 'transfer' ? 'transfer_out' : kind,
        quantity: -t.milli / 1000,
        unitCost: t.batch.unitCost,
        unitPrice: kind === 'sale' ? Math.round((meta.price ?? spec.price) * (1 - markdownPercent(t.batch, meta.docDay, spec, meta) / 100) * 100) / 100 : null,
        reason: kind === 'writeoff' ? (meta.reason ?? 'other') : null,
        dishId: meta.dishId ?? null,
        createdAt: d.createdAt,
      });
    }
    return { taken: total, batches: taken };
  }

  const pairs: { product: string; loc: string; perDay: number; direct: boolean }[] = [];
  for (const [loc, demand] of Object.entries(RETAIL_DEMAND)) {
    for (const [product, perDay] of Object.entries(demand)) pairs.push({ product, loc, perDay, direct: true });
  }
  const kitchenDemand = kitchenDemandPerDay();
  for (const [product, perDay] of kitchenDemand) pairs.push({ product, loc: 'kit', perDay, direct: !VIA_WAREHOUSE.has(product) });
  for (const product of VIA_WAREHOUSE) pairs.push({ product, loc: 'wh', perDay: (kitchenDemand.get(product) ?? 0) * 1.1, direct: true });

  const supply = (spec: ProductSpec, perDay: number, loc: string, date: string) => {
    // точка заказа: если на ближайшие два дня не хватит, везём запас на 4–6 дней, но не больше срока годности
    const coverDays = Math.min(Math.max(2, Math.floor(spec.shelf * 0.6)), 5 + Math.floor(rng() * 2));
    const avail = availableMilli(spec.key, loc, date) / 1000;
    if (avail >= perDay * 2.2) return;
    const qty = Math.max(perDay * coverDays * (0.9 + rng() * 0.4) - avail, perDay);
    const rounded = spec.unit === 'pcs' ? Math.round(qty) : Math.round(qty * 10) / 10;
    if (rounded <= 0) return;
    const age = spec.shelf <= 10 ? Math.floor(rng() * 2) : Math.floor(rng() * 3);
    receive(spec.key, loc, date, rounded, Math.max(spec.shelf - age, 1), 7);
  };

  for (let i = -opts.days; i <= 0; i += 1) {
    const date = addDays(today, i);
    const weekday = WEEKDAY[new Date(`${date}T12:00:00Z`).getUTCDay()] as number;

    // 1. просрочка: большую часть списывают в тот же день, часть остаётся на следующий
    for (const [k, list] of stock) {
      const [product, loc] = k.split('|') as [string, string];
      for (const b of list) {
        if (b.remainingMilli > 0 && b.expiresOn < date && rng() < 0.85) {
          consume(product, loc, date, b.remainingMilli, 'writeoff', { docDay: date, hour: 9, reason: 'expired', includeExpired: true });
        }
      }
    }

    // 2. склад пополняется, затем переброска сухих продуктов на кухню раз в три дня
    for (const pr of pairs) {
      if (pr.direct) supply(productSpec.get(pr.product) as ProductSpec, pr.perDay, pr.loc, date);
    }
    if (i % 3 === 0) {
      for (const product of VIA_WAREHOUSE) {
        const need = (kitchenDemand.get(product) ?? 0) * 3.2;
        const have = availableMilli(product, 'kit', date) / 1000;
        const want = Math.max(need - have, 0);
        if (want <= 0) continue;
        const r = consume(product, 'wh', date, milli(Math.round(want * 10) / 10), 'transfer', { docDay: date, hour: 8, toLoc: 'kit' });
        for (const t of r.batches) {
          const nb: SimBatch = {
            id: crypto.randomUUID(),
            productId: t.batch.productId,
            locationId: ids.locations.kit as string,
            supplierId: t.batch.supplierId,
            docId: doc('transfer', 'wh', date, 'kit', 8, null, 'kit').id,
            documentNo: t.batch.documentNo,
            receivedOn: date,
            expiresOn: t.batch.expiresOn,
            initial: t.milli / 1000,
            remaining: 0,
            remainingMilli: t.milli,
            unitCost: t.batch.unitCost,
            createdAt: at(date, 8, 30),
          };
          batches.push(nb);
          const list = stock.get(pairKey(product, 'kit')) ?? [];
          list.push(nb);
          stock.set(pairKey(product, 'kit'), list);
          movements.push({
            docId: nb.docId,
            batchId: nb.id,
            productId: nb.productId,
            locationId: nb.locationId,
            type: 'transfer_in',
            quantity: t.milli / 1000,
            unitCost: nb.unitCost,
            unitPrice: null,
            reason: null,
            dishId: null,
            createdAt: nb.createdAt,
          });
        }
      }
    }

    // 3. розничные продажи по сменам. Сегодня выгружены только те смены, что уже закончились
    const passed = (shift: Shift) => i < 0 || shift.hour < nowHour;
    for (const pr of pairs) {
      if (pr.loc === 'kit' || pr.loc === 'wh') continue;
      const spec = productSpec.get(pr.product) as ProductSpec;
      const noise = 0.82 + rng() * 0.36;
      const day = pr.perDay * weekday * noise * weatherMultiplier(pr.product, pr.loc, demoWeather(date));
      for (const shift of RETAIL_SHIFTS) {
        if (!passed(shift)) continue;
        const part = day * shift.share * (0.9 + rng() * 0.2);
        const demand = spec.unit === 'pcs' ? Math.round(part) : Math.round(part * 10) / 10;
        if (demand <= 0) continue;
        consume(pr.product, pr.loc, date, milli(demand), 'sale', { docDay: date, hour: shift.hour, shift: shift.key });
      }
    }

    // 4. блюда на кухне: продаём столько порций, на сколько хватает ингредиентов
    for (const dish of DISHES) {
      const total = dish.perDay * weekday * (0.8 + rng() * 0.4);
      for (const shift of KITCHEN_SHIFTS) {
        if (!passed(shift)) continue;
        const portions = Math.round(total * shift.share);
        let feasible = portions;
        for (const [product, qty] of dish.items) {
          feasible = Math.min(feasible, Math.floor(availableMilli(product, 'kit', date) / milli(qty)));
        }
        if (feasible <= 0) continue;
        const taken: { batch: SimBatch; milli: number }[] = [];
        for (const [product, qty] of dish.items) {
          const r = consume(product, 'kit', date, milli(qty) * feasible, 'sale', { docDay: date, hour: shift.hour, shift: shift.key, dishId: ids.dishes[dish.name] ?? null, price: 0 });
          taken.push(...r.batches);
        }
        // выручку блюда делим пропорционально себестоимости, как это делает сервер
        const lines = movements.slice(-taken.length);
        const costs = lines.map((l) => -l.quantity * l.unitCost);
        const sum = costs.reduce((acc, c) => acc + c, 0);
        const revenue = dish.price * feasible;
        lines.forEach((l, k) => {
          l.unitPrice = Math.round(((revenue * ((costs[k] as number) / sum)) / -l.quantity) * 100) / 100;
        });
      }
    }

    // 5. редкая порча
    for (const pr of pairs) {
      if (pr.loc === 'wh' || rng() > 0.025) continue;
      const have = availableMilli(pr.product, pr.loc, date);
      if (have <= 0) continue;
      const reason = rng() < 0.6 ? 'spoiled' : 'damaged';
      const share = have * (0.03 + rng() * 0.05);
      // штучный товар портится целыми штуками
      const lost = (productSpec.get(pr.product) as ProductSpec).unit === 'pcs' ? Math.max(1000, Math.floor(share / 1000) * 1000) : Math.max(milli(0.2), Math.floor(share));
      consume(pr.product, pr.loc, date, lost, 'writeoff', { docDay: date, hour: 15, reason });
    }
  }

  // Сценарии на сегодня: то, что покажет демо
  const dayAgo = (n: number) => addDays(today, -n);
  const stage = (product: string, loc: string, qty: number, daysLeft: number, receivedAgo: number) => {
    receive(product, loc, dayAgo(receivedAgo), qty, daysBetween(dayAgo(receivedAgo), addDays(today, daysLeft)), 8);
  };
  const drain = (product: string, loc: string, keep: number, reason: MoveRow['reason'], hour = 8) => {
    const have = availableMilli(product, loc, today);
    const surplus = have - milli(keep);
    if (surplus > 0) consume(product, loc, today, surplus, 'writeoff', { docDay: today, hour, reason, includeExpired: false });
  };

  // короткие сроки на живом потоке продаж: сработают скидки и перемещения
  stage('yogurt', 'shopC', 22, 2, 3);
  stage('sour', 'shopN', 8, 1, 6);
  stage('curd', 'shopC', 12, 3, 4);
  // хлеб, не раскупленный за день: срок кончается сегодня
  stage('bread', 'shopN', 36, 0, 3);
  // молока на «Северном» много, а в «Центре» его почти нет: подсказка про перемещение
  stage('milk', 'shopN', 70, 3, 2);
  // скоропорт на кухне: подсказка про блюда дня
  stage('milk', 'kit', 30, 2, 3);
  // скоропорт на кухне с близким сроком: из него складываются горячие предложения
  stage('beef', 'kit', 6, 1, 3);
  stage('sour', 'kit', 3, 2, 4);
  stage('tomato', 'kit', 7, 2, 3);
  stage('cucumber', 'kit', 6, 3, 4);
  stage('chicken', 'kit', 9, 2, 3);
  stage('curd', 'kit', 5, 3, 5);
  // забытая просрочка, которую ещё не списали
  stage('kefir', 'shopN', 9, -1, 11);
  stage('cream', 'kit', 3.5, -2, 15);
  stage('salmon', 'kit', 2.2, -1, 5);
  // закончились и на подходе
  drain('cheese', 'kit', 0, 'spoiled');
  drain('cream', 'kit', 0, 'spoiled', 9);
  drain('eggs', 'kit', 3, 'damaged');
  drain('milk', 'shopC', 8, 'spoiled');
  drain('chicken', 'shopN', 0, 'spoiled');
  drain('greens', 'kit', 0.08, 'spoiled');
  drain('butter', 'kit', 0.4, 'damaged');

  // История заказов поставщикам: каждый приход это исполненный заказ. У поставщиков разный характер: кто-то недовозит,
  // кто-то опаздывает. Отдельный генератор, чтобы история заказов не сдвигала случайные числа торговли
  const orderRng = mulberry32((opts.seed ?? 20261009) + 7);
  const byDoc = new Map<string, SimBatch[]>();
  for (const b of batches) byDoc.set(b.docId, [...(byDoc.get(b.docId) ?? []), b]);
  const orders: SimOrder[] = [];
  for (const d of documents) {
    if (d.kind !== 'receipt') continue;
    const list = byDoc.get(d.id);
    const supplierId = list?.[0]?.supplierId;
    if (!list || !supplierId) continue;
    const index = Math.max(ids.suppliers.indexOf(supplierId), 0);
    const profile = SUPPLIER_PROFILES[index] ?? { shortShare: 0.05, lateShare: 0.1 };
    const lead = SUPPLIERS[index]?.leadTimeDays ?? 1;
    const receivedDay = new Date(d.createdAt.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
    const delay = orderRng() < profile.lateShare ? 1 + Math.floor(orderRng() * 2) : 0;
    const expectedOn = addDays(receivedDay, -delay);
    const byProduct = new Map<string, { received: number; cost: number }>();
    for (const b of list) {
      const prev = byProduct.get(b.productId);
      byProduct.set(b.productId, { received: (prev?.received ?? 0) + b.initial, cost: prev?.cost ?? b.unitCost });
    }
    const lines = [...byProduct].map(([productId, v]) => {
      const spec = PRODUCTS.find((p) => ids.products[p.key] === productId);
      const factor = orderRng() < profile.shortShare ? 0.55 + 0.35 * orderRng() : 1;
      const wanted = v.received / factor;
      const quantity = spec?.unit === 'pcs' ? Math.ceil(wanted) : Math.max(Math.round(wanted * 1000) / 1000, v.received);
      return { productId, quantity, unitCost: v.cost, received: v.received };
    });
    orders.push({
      id: crypto.randomUUID(),
      number: `ЗК-${String(orders.length + 1).padStart(6, '0')}`,
      supplierId,
      locationId: d.locationId,
      expectedOn,
      sentAt: new Date(`${addDays(expectedOn, -lead)}T09:00:00+03:00`),
      closedAt: d.createdAt,
      total: Math.round(lines.reduce((sum, l) => sum + l.quantity * l.unitCost, 0) * 100) / 100,
      lines,
    });
    d.orderId = orders.at(-1)?.id ?? null;
  }

  const promotions: SimPromotion[] = [];
  const batchById = new Map(batches.map((b) => [b.id, b]));
  for (const [batchId, tiers] of markdownTiers) {
    const sorted = [...tiers].sort((a, b) => a[0] - b[0]);
    sorted.forEach(([percent, createdAt], i) => {
      promotions.push({ batchId, percent, endsOn: (batchById.get(batchId) as SimBatch).expiresOn, createdAt, cancelledAt: sorted[i + 1]?.[1] ?? null });
    });
  }

  // Журнал нехваток для статистики дефицита: прошлые эпизоды по сценарию и то, что закончилось прямо сейчас
  const kitchenId = ids.locations.kit as string;
  const shortages: SimShortage[] = [];
  const refusals: SimRefusal[] = [];
  const dishesWith = (product: string) => DISHES.filter((d) => d.items.some(([key]) => key === product));
  for (const s of SHORTAGE_HISTORY) {
    const using = dishesWith(s.product);
    if (using.length === 0) continue;
    const started = at(addDays(today, -s.daysAgo), s.hour, 15);
    shortages.push({ productId: ids.products[s.product] as string, locationId: kitchenId, startedAt: started, endedAt: new Date(started.getTime() + s.hours * 3_600_000), dishesBlocked: using.length });
    for (let k = 0; k < s.refusals; k += 1) {
      const dish = using[k % using.length] as (typeof DISHES)[number];
      refusals.push({
        locationId: kitchenId,
        createdAt: new Date(started.getTime() + ((k + 1) * s.hours * 3_600_000) / (s.refusals + 1)),
        total: dish.price * ((k % 3) + 1),
        missing: [ids.products[s.product] as string],
      });
    }
  }
  for (const product of ['cheese', 'cream']) {
    shortages.push({ productId: ids.products[product] as string, locationId: kitchenId, startedAt: at(today, 8, 30), endedAt: null, dishesBlocked: dishesWith(product).length });
  }

  for (const b of batches) b.remaining = b.remainingMilli / 1000;
  return { documents, batches, movements, orders, promotions, shortages, refusals, lastNumber: number };
}
