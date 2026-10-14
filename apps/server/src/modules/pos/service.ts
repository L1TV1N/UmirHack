import type { PosInboxDto, PosNormalizedLine, PosPreviewDto, PosRules, PosUnmatchedDto } from '@zapas/shared';
import { posRules } from '@zapas/shared';
import { sql } from 'kysely';
import type { Actor, Deps, Principal } from '../../lib/context';
import { sha256Hex } from '../../lib/crypto';
import { AppError } from '../../lib/errors';
import { sell } from '../stock/operations';
import { presetRules } from './presets';
import type { NormalizedReceipt } from './rules';

type Match = { entity: 'product' | 'dish'; id: string; name: string } | { entity: 'ignore' } | null;

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/** Как показать позицию в списке «неопознанных»: код, иначе штрихкод, иначе название. */
export const refOf = (l: PosNormalizedLine): string => l.code ?? l.barcode ?? l.name ?? '';

export function rulesOfKey(row: { vendor: string; rules: unknown }): PosRules {
  const parsed = row.rules ? posRules.safeParse(row.rules) : null;
  return parsed?.success ? parsed.data : presetRules(row.vendor as 'generic');
}

/** Для каждой строки ищем продукт или блюдо: сначала по таблице сопоставлений, потом по коду блюда, артикулу и штрихкоду. */
export async function resolveLines(deps: Deps, keyId: string, lines: PosNormalizedLine[]): Promise<Match[]> {
  const refs = new Set<string>();
  for (const l of lines) for (const r of [l.code, l.barcode, l.name]) if (r) refs.add(norm(r));
  const list = [...refs];
  if (list.length === 0) return lines.map(() => null);
  const codes = [...new Set(lines.flatMap((l) => [l.code, l.barcode]).filter((x): x is string => Boolean(x)).map(norm))];
  const names = [...new Set(lines.filter((l) => !l.code && !l.barcode && l.name).map((l) => norm(l.name)))];

  const org = await deps.db
    .selectFrom('api_keys as k')
    .innerJoin('locations as l', 'l.id', 'k.location_id')
    .select('l.org_id')
    .where('k.id', '=', keyId)
    .executeTakeFirstOrThrow();
  const map = await deps.db.selectFrom('pos_code_map').select(['ref', 'entity', 'entity_id']).where('key_id', '=', keyId).where('ref', 'in', list).execute();
  const dishes = codes.length ? await deps.db.selectFrom('dishes').select(['id', 'name', 'code']).where('org_id', '=', org.org_id).where(sql<string>`lower(code)`, 'in', codes).where('is_active', '=', true).execute() : [];
  const products = codes.length
    ? await deps.db.selectFrom('products').select(['id', 'name', 'sku', 'barcode']).where('org_id', '=', org.org_id).where((eb) => eb.or([eb(sql<string>`lower(sku)`, 'in', codes), eb('barcode', 'in', codes)])).where('is_active', '=', true).execute()
    : [];
  const byName = names.length
    ? {
        dishes: await deps.db.selectFrom('dishes').select(['id', 'name']).where('org_id', '=', org.org_id).where(sql<string>`lower(name)`, 'in', names).where('is_active', '=', true).execute(),
        products: await deps.db.selectFrom('products').select(['id', 'name']).where('org_id', '=', org.org_id).where(sql<string>`lower(name)`, 'in', names).where('is_active', '=', true).where('sellable', '=', true).execute(),
      }
    : { dishes: [], products: [] };

  const names2 = new Map<string, string>();
  const needNames = map.filter((m) => m.entity_id).map((m) => m.entity_id as string);
  if (needNames.length) {
    for (const r of await deps.db.selectFrom('products').select(['id', 'name']).where('id', 'in', needNames).execute()) names2.set(r.id, r.name);
    for (const r of await deps.db.selectFrom('dishes').select(['id', 'name']).where('id', 'in', needNames).execute()) names2.set(r.id, r.name);
  }

  return lines.map((l): Match => {
    const ids = [l.code, l.barcode, l.name].filter((x): x is string => Boolean(x)).map(norm);
    for (const id of ids) {
      const m = map.find((x) => x.ref === id);
      if (m) return m.entity === 'ignore' ? { entity: 'ignore' } : { entity: m.entity, id: m.entity_id as string, name: names2.get(m.entity_id as string) ?? '' };
    }
    for (const c of [l.code, l.barcode].filter((x): x is string => Boolean(x)).map(norm)) {
      const d = dishes.find((x) => norm(x.code) === c);
      if (d) return { entity: 'dish', id: d.id, name: d.name };
      const p = products.find((x) => norm(x.sku) === c || x.barcode === c);
      if (p) return { entity: 'product', id: p.id, name: p.name };
    }
    if (!l.code && !l.barcode && l.name) {
      const n = norm(l.name);
      const d = byName.dishes.find((x) => norm(x.name) === n);
      if (d) return { entity: 'dish', id: d.id, name: d.name };
      const p = byName.products.find((x) => norm(x.name) === n);
      if (p) return { entity: 'product', id: p.id, name: p.name };
    }
    return null;
  });
}

export async function previewReceipts(deps: Deps, keyId: string, receipts: NormalizedReceipt[]): Promise<PosPreviewDto> {
  const out: PosPreviewDto['receipts'] = [];
  for (const r of receipts) {
    const matches = await resolveLines(deps, keyId, r.lines);
    out.push({ externalId: r.externalId, kind: r.kind, lines: r.lines.map((l, i) => ({ ...l, match: matches[i] ?? null })) });
  }
  return { receipts: out };
}

export interface IngestResult {
  externalId: string;
  kind: 'sale' | 'return';
  status: 'done' | 'pending_match' | 'rejected' | 'return_logged';
  duplicate: boolean;
  documentNumber: string | null;
  unmatched: string[];
  error: string | null;
}

const saleKey = (keyId: string, externalId: string) => `pos-${sha256Hex(`${keyId}:${externalId}`).slice(0, 40)}`;

/** Принимает один чек от кассы: продажа списывает остатки, возврат только записывается, неизвестные позиции ждут сопоставления. */
export async function ingestReceipt(deps: Deps, principal: Extract<Principal, { kind: 'apikey' }>, meta: Actor['meta'], receipt: NormalizedReceipt): Promise<IngestResult> {
  const keyId = principal.id;
  const locationId = principal.locationIds[0] as string;
  const now = deps.clock();
  const existing = await deps.db.selectFrom('pos_inbox as i').leftJoin('documents as d', 'd.id', 'i.document_id').select(['i.id', 'i.status', 'i.kind', 'i.unmatched', 'i.error', 'd.number']).where('i.key_id', '=', keyId).where('i.external_id', '=', receipt.externalId).executeTakeFirst();
  if (existing && existing.status !== 'pending_match') {
    return { externalId: receipt.externalId, kind: existing.kind, status: existing.status, duplicate: true, documentNumber: existing.number, unmatched: existing.unmatched, error: existing.error };
  }

  const finish = async (status: IngestResult['status'], extra: { unmatched?: string[]; error?: string | null; documentId?: string | null; documentNumber?: string | null }): Promise<IngestResult> => {
    const values = { status, unmatched: extra.unmatched ?? [], error: extra.error ?? null, document_id: extra.documentId ?? null, processed_at: status === 'pending_match' ? null : now, lines: JSON.stringify(receipt.lines) };
    if (existing) await deps.db.updateTable('pos_inbox').set(values).where('id', '=', existing.id).execute();
    else {
      await deps.db
        .insertInto('pos_inbox')
        .values({ key_id: keyId, location_id: locationId, external_id: receipt.externalId, kind: receipt.kind, received_at: now, ...values })
        .onConflict((oc) => oc.columns(['key_id', 'external_id']).doNothing())
        .execute();
    }
    return { externalId: receipt.externalId, kind: receipt.kind, status, duplicate: false, documentNumber: extra.documentNumber ?? null, unmatched: extra.unmatched ?? [], error: extra.error ?? null };
  };

  if (receipt.kind === 'return') return finish('return_logged', {});

  const matches = await resolveLines(deps, keyId, receipt.lines);
  const unmatched = receipt.lines.filter((_, i) => matches[i] === null).map(refOf);
  if (unmatched.length > 0) return finish('pending_match', { unmatched: [...new Set(unmatched)] });

  // одинаковые позиции сворачиваем: касса часто присылает одно блюдо несколькими строками
  const totals = new Map<string, { line: { productId: string; quantity: number } | { dishId: string; quantity: number } }>();
  receipt.lines.forEach((l, i) => {
    const m = matches[i];
    if (!m || m.entity === 'ignore') return;
    const k = `${m.entity}:${m.id}`;
    const prev = totals.get(k);
    if (prev) prev.line.quantity = Math.round((prev.line.quantity + l.quantity) * 1000) / 1000;
    else totals.set(k, { line: m.entity === 'dish' ? { dishId: m.id, quantity: l.quantity } : { productId: m.id, quantity: l.quantity } });
  });
  const lines = [...totals.values()].map((t) => t.line);
  if (lines.length === 0) return finish('done', {});

  try {
    const doc = await sell(deps, { principal, meta }, { locationId, lines }, saleKey(keyId, receipt.externalId));
    const number = (await deps.db.selectFrom('documents').select('number').where('id', '=', doc.documentId).executeTakeFirst())?.number ?? doc.number;
    return finish('done', { documentId: doc.documentId, documentNumber: number });
  } catch (err) {
    if (err instanceof AppError && err.status < 500) return finish('rejected', { error: err.message });
    throw err;
  }
}

/** После сопоставления кода доигрываем ждавшие чеки этого подключения. */
export async function replayPending(deps: Deps, keyId: string, meta: Actor['meta']): Promise<number> {
  const key = await deps.db
    .selectFrom('api_keys as k')
    .innerJoin('locations as l', 'l.id', 'k.location_id')
    .select(['k.id', 'k.name', 'k.location_id', 'k.revoked_at', 'l.org_id'])
    .where('k.id', '=', keyId)
    .executeTakeFirst();
  if (!key || key.revoked_at) return 0;
  const principal = { kind: 'apikey' as const, id: key.id, name: key.name, orgId: key.org_id, locationIds: [key.location_id] };
  const rows = await deps.db.selectFrom('pos_inbox').select(['external_id', 'kind', 'lines']).where('key_id', '=', keyId).where('status', '=', 'pending_match').orderBy('received_at').limit(200).execute();
  let done = 0;
  for (const r of rows) {
    const result = await ingestReceipt(deps, principal, meta, { externalId: r.external_id, kind: r.kind, lines: r.lines as PosNormalizedLine[] });
    if (result.status !== 'pending_match') done += 1;
  }
  return done;
}

/** Отказанный чек можно прогнать снова, например после прихода товара. */
export async function retryRejected(deps: Deps, inboxId: string, meta: Actor['meta']): Promise<IngestResult | null> {
  const row = await deps.db.selectFrom('pos_inbox as i').innerJoin('api_keys as k', 'k.id', 'i.key_id').innerJoin('locations as l', 'l.id', 'k.location_id').select(['i.id', 'i.external_id', 'i.kind', 'i.lines', 'k.id as kid', 'k.name', 'k.location_id', 'k.revoked_at', 'l.org_id']).where('i.id', '=', inboxId).where('i.status', '=', 'rejected').executeTakeFirst();
  if (!row || row.revoked_at) return null;
  await deps.db.updateTable('pos_inbox').set({ status: 'pending_match', error: null }).where('id', '=', row.id).execute();
  return ingestReceipt(deps, { kind: 'apikey', id: row.kid, name: row.name, orgId: row.org_id, locationIds: [row.location_id] }, meta, { externalId: row.external_id, kind: row.kind, lines: row.lines as PosNormalizedLine[] });
}

export async function listInbox(deps: Deps, f: { keyId?: string; status?: string; limit: number }): Promise<PosInboxDto[]> {
  let q = deps.db
    .selectFrom('pos_inbox as i')
    .innerJoin('api_keys as k', 'k.id', 'i.key_id')
    .leftJoin('documents as d', 'd.id', 'i.document_id')
    .select(['i.id', 'i.key_id', 'k.name as key_name', 'i.external_id', 'i.kind', 'i.status', 'i.lines', 'i.unmatched', 'i.error', 'd.number', 'i.received_at']);
  if (f.keyId) q = q.where('i.key_id', '=', f.keyId);
  if (f.status) q = q.where('i.status', '=', f.status as 'done');
  const rows = await q.orderBy('i.received_at', 'desc').limit(f.limit).execute();
  return rows.map((r) => ({ id: r.id, keyId: r.key_id, connectionName: r.key_name, externalId: r.external_id, kind: r.kind, status: r.status, lines: r.lines as PosNormalizedLine[], unmatched: r.unmatched, error: r.error, documentNumber: r.number, receivedAt: r.received_at.toISOString() }));
}

/** Позиции, которые касса прислала, а в «Запасе» их нет: по каждой видно, сколько чеков ждёт. */
export async function listUnmatched(deps: Deps): Promise<PosUnmatchedDto[]> {
  const rows = await deps.db
    .selectFrom('pos_inbox as i')
    .innerJoin('api_keys as k', 'k.id', 'i.key_id')
    .select(['i.key_id', 'k.name as key_name', 'i.lines', 'i.unmatched'])
    .where('i.status', '=', 'pending_match')
    .orderBy('i.received_at', 'desc')
    .limit(500)
    .execute();
  const agg = new Map<string, PosUnmatchedDto>();
  for (const r of rows) {
    for (const ref of r.unmatched) {
      const k = `${r.key_id}:${norm(ref)}`;
      const lines = (r.lines as PosNormalizedLine[]).filter((l) => norm(refOf(l)) === norm(ref));
      const cur = agg.get(k) ?? { ref, keyId: r.key_id, connectionName: r.key_name, name: lines[0]?.name ?? null, receipts: 0, quantity: 0 };
      cur.receipts += 1;
      cur.quantity = Math.round((cur.quantity + lines.reduce((s, l) => s + l.quantity, 0)) * 1000) / 1000;
      agg.set(k, cur);
    }
  }
  return [...agg.values()].sort((a, b) => b.receipts - a.receipts);
}
