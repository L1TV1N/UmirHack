import { ORDER_STATUS_LABELS, type OrderStatus, type PortalOrderLine, type PortalOrderPush } from '@zapas/shared';
import type { Db } from './db';
import { stageOf, type AccountDto, type BuyerDto, type DashboardDto, type OrderDetailDto, type OrderRowDto, type Stage } from './types';

interface AccountRow {
  id: number;
  inn: string;
  company: string;
  contact_name: string;
  email: string;
  phone: string | null;
  password_hash: string;
  created_at: string;
  last_login_at: string | null;
  failed_attempts: number;
  locked_until: string | null;
}

interface OrderRow {
  id: number;
  external_id: string;
  number: string;
  status: string;
  status_label: string;
  supplier_inn: string;
  supplier_name: string;
  buyer_org: string;
  buyer_location: string;
  buyer_address: string | null;
  expected_on: string | null;
  comment: string | null;
  total: number;
  lines: string;
  buyer_note: string | null;
  supplier_note: string | null;
  delivery_on: string | null;
  received_at: string;
  updated_at: string;
  viewed_at: string | null;
}

const one = <T>(v: unknown): T | undefined => v as T | undefined;
const all = <T>(v: unknown): T[] => v as T[];

export function accountByEmail(db: Db, email: string): AccountRow | undefined {
  return one<AccountRow>(db.prepare('SELECT * FROM accounts WHERE email = ?').get(email));
}
export function accountById(db: Db, id: number): AccountRow | undefined {
  return one<AccountRow>(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id));
}
export function accountByInn(db: Db, inn: string): AccountRow | undefined {
  return one<AccountRow>(db.prepare('SELECT * FROM accounts WHERE inn = ?').get(inn));
}

export function buyersCount(db: Db, inn: string): number {
  const row = one<{ n: number }>(db.prepare('SELECT COUNT(DISTINCT buyer_org) AS n FROM orders WHERE supplier_inn = ?').get(inn));
  return row?.n ?? 0;
}

export function toAccountDto(db: Db, a: AccountRow): AccountDto {
  return { id: a.id, inn: a.inn, company: a.company, contactName: a.contact_name, email: a.email, phone: a.phone, createdAt: a.created_at, buyers: buyersCount(db, a.inn) };
}

export function insertAccount(
  db: Db,
  a: { inn: string; company: string; contactName: string; email: string; phone: string | null; passwordHash: string },
  now: Date,
): AccountRow {
  const res = db
    .prepare('INSERT INTO accounts (inn, company, contact_name, email, phone, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(a.inn, a.company, a.contactName, a.email, a.phone, a.passwordHash, now.toISOString());
  return accountById(db, Number(res.lastInsertRowid)) as AccountRow;
}

export function touchLogin(db: Db, id: number, now: Date): void {
  db.prepare('UPDATE accounts SET last_login_at = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?').run(now.toISOString(), id);
}

export function registerFailure(db: Db, id: number, now: Date): void {
  const row = one<{ failed_attempts: number }>(db.prepare('UPDATE accounts SET failed_attempts = failed_attempts + 1 WHERE id = ? RETURNING failed_attempts').get(id));
  if ((row?.failed_attempts ?? 0) >= 5) {
    const minutes = Math.min(2 ** ((row?.failed_attempts ?? 5) - 5), 15);
    db.prepare('UPDATE accounts SET locked_until = ? WHERE id = ?').run(new Date(now.getTime() + minutes * 60_000).toISOString(), id);
  }
}

export function updateProfile(db: Db, id: number, p: { company: string; contactName: string; phone: string | null }): void {
  db.prepare('UPDATE accounts SET company = ?, contact_name = ?, phone = ? WHERE id = ?').run(p.company, p.contactName, p.phone, id);
}

export function setPasswordHash(db: Db, id: number, hash: string): void {
  db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(hash, id);
}

const linesOf = (row: OrderRow): PortalOrderLine[] => JSON.parse(row.lines) as PortalOrderLine[];

function toRow(row: OrderRow): OrderRowDto {
  const status = row.status;
  return {
    id: row.id,
    number: row.number,
    status,
    statusLabel: row.status_label,
    stage: stageOf(status),
    buyerOrg: row.buyer_org,
    buyerLocation: row.buyer_location,
    expectedOn: row.expected_on,
    deliveryOn: row.delivery_on,
    total: row.total,
    lines: linesOf(row).length,
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
    isNew: row.viewed_at === null,
  };
}

export function listOrders(db: Db, inn: string, stage: Stage | 'all'): OrderRowDto[] {
  const rows = all<OrderRow>(db.prepare('SELECT * FROM orders WHERE supplier_inn = ? ORDER BY received_at DESC, id DESC LIMIT 500').all(inn)).map(toRow);
  return stage === 'all' ? rows : rows.filter((r) => r.stage === stage);
}

export function orderRow(db: Db, inn: string, id: number): OrderRow | undefined {
  return one<OrderRow>(db.prepare('SELECT * FROM orders WHERE id = ? AND supplier_inn = ?').get(id, inn));
}

export function orderDetail(db: Db, row: OrderRow): OrderDetailDto {
  const events = all<{ id: number; at: string; actor: string; text: string }>(db.prepare('SELECT id, at, actor, text FROM events WHERE order_id = ? ORDER BY id').all(row.id));
  const actions: OrderDetailDto['actions'] = row.status === 'sent' ? ['confirm', 'ship', 'decline'] : row.status === 'confirmed' ? ['ship', 'decline'] : [];
  return {
    ...toRow(row),
    buyerAddress: row.buyer_address,
    comment: row.comment,
    buyerNote: row.buyer_note,
    supplierNote: row.supplier_note,
    items: linesOf(row),
    events,
    actions,
  };
}

export function markViewed(db: Db, id: number, now: Date): void {
  db.prepare('UPDATE orders SET viewed_at = COALESCE(viewed_at, ?) WHERE id = ?').run(now.toISOString(), id);
}

export function addEvent(db: Db, orderId: number, actor: string, text: string, now: Date): void {
  db.prepare('INSERT INTO events (order_id, at, actor, text) VALUES (?, ?, ?, ?)').run(orderId, now.toISOString(), actor, text);
}

/** Заказ от покупателя: новый создаётся, известный обновляется. Возвращает, изменился ли статус. */
export function upsertOrder(db: Db, p: PortalOrderPush, now: Date): { id: number; created: boolean; statusChanged: boolean } {
  const existing = one<OrderRow>(db.prepare('SELECT * FROM orders WHERE external_id = ?').get(p.externalId));
  const label = p.statusLabel || ORDER_STATUS_LABELS[p.status as OrderStatus] || p.status;
  if (!existing) {
    const res = db
      .prepare(
        `INSERT INTO orders (external_id, number, status, status_label, supplier_inn, supplier_name, buyer_org, buyer_location, buyer_address,
           expected_on, comment, total, lines, buyer_note, received_at, updated_at, viewed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.externalId, p.number, p.status, label, p.supplierInn, p.supplierName, p.buyer.organization, p.buyer.location, p.buyer.address, p.expectedOn, p.comment, p.total, JSON.stringify(p.lines), p.buyerNote, now.toISOString(), now.toISOString(), p.status === 'sent' ? null : now.toISOString());
    const id = Number(res.lastInsertRowid);
    addEvent(db, id, p.buyer.organization, `Новый заказ ${p.number} на ${p.lines.length} поз.`, now);
    return { id, created: true, statusChanged: true };
  }
  const statusChanged = existing.status !== p.status;
  db.prepare(
    `UPDATE orders SET number = ?, status = ?, status_label = ?, supplier_name = ?, buyer_org = ?, buyer_location = ?, buyer_address = ?,
       expected_on = ?, comment = ?, total = ?, lines = ?, buyer_note = ?, updated_at = ? WHERE id = ?`,
  ).run(p.number, p.status, label, p.supplierName, p.buyer.organization, p.buyer.location, p.buyer.address, p.expectedOn, p.comment, p.total, JSON.stringify(p.lines), p.buyerNote, now.toISOString(), existing.id);
  if (statusChanged) addEvent(db, existing.id, p.buyer.organization, `Статус у покупателя: ${label.toLowerCase()}${p.buyerNote ? `. ${p.buyerNote}` : ''}`, now);
  else if (p.buyerNote && p.buyerNote !== existing.buyer_note) addEvent(db, existing.id, p.buyer.organization, `Замечание покупателя: ${p.buyerNote}`, now);
  return { id: existing.id, created: false, statusChanged };
}

export function applySupplierAction(db: Db, id: number, change: { status: string; label: string; note: string | null; deliveryOn: string | null }, actor: string, text: string, now: Date): void {
  db.prepare('UPDATE orders SET status = ?, status_label = ?, supplier_note = ?, delivery_on = COALESCE(?, delivery_on), updated_at = ? WHERE id = ?').run(change.status, change.label, change.note, change.deliveryOn, now.toISOString(), id);
  addEvent(db, id, actor, text, now);
}

export function dashboard(db: Db, inn: string, now: Date): DashboardDto {
  const rows = listOrders(db, inn, 'all');
  const counts: Record<Stage, number> = { new: 0, work: 0, shipped: 0, closed: 0 };
  for (const r of rows) counts[r.stage] += 1;
  const month = now.toISOString().slice(0, 7);
  return {
    counts,
    awaitingSum: round(rows.filter((r) => r.stage === 'new' || r.stage === 'work').reduce((s, r) => s + r.total, 0)),
    monthSum: round(rows.filter((r) => r.receivedAt.startsWith(month) && r.status !== 'declined' && r.status !== 'cancelled' && r.status !== 'refused').reduce((s, r) => s + r.total, 0)),
    buyers: buyersCount(db, inn),
    recent: rows.slice(0, 6),
  };
}

export function buyers(db: Db, inn: string): BuyerDto[] {
  const rows = all<OrderRow>(db.prepare('SELECT * FROM orders WHERE supplier_inn = ? ORDER BY received_at DESC').all(inn));
  const byOrg = new Map<string, BuyerDto>();
  for (const r of rows) {
    const org = byOrg.get(r.buyer_org) ?? { organization: r.buyer_org, locations: [], orders: 0, sum: 0 };
    org.orders += 1;
    org.sum = round(org.sum + r.total);
    const loc = org.locations.find((l) => l.name === r.buyer_location);
    if (loc) {
      loc.orders += 1;
      loc.sum = round(loc.sum + r.total);
    } else {
      org.locations.push({ name: r.buyer_location, address: r.buyer_address, orders: 1, sum: round(r.total), lastAt: r.received_at });
    }
    byOrg.set(r.buyer_org, org);
  }
  return [...byOrg.values()].sort((a, b) => b.sum - a.sum);
}

const round = (v: number) => Math.round(v * 100) / 100;
