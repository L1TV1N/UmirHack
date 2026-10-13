import type { PosNormalizedLine, PosRules } from '@zapas/shared';
import { XMLParser } from 'fast-xml-parser';
import { badRequest } from '../../lib/errors';

export interface NormalizedReceipt {
  externalId: string;
  kind: 'sale' | 'return';
  lines: PosNormalizedLine[];
}

const fail = (message: string): never => {
  throw badRequest(message, undefined, 'pos_unreadable');
};

/** Значение по пути через точку: `body.positions`, `items[0].name`. */
function pick(source: unknown, path: string): unknown {
  let cur: unknown = source;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    const m = /^([^[\]]+)(?:\[(\d+)\])?$/.exec(part);
    if (!m) return undefined;
    cur = (cur as Record<string, unknown>)[m[1] as string];
    if (m[2] !== undefined) cur = Array.isArray(cur) ? cur[Number(m[2])] : undefined;
  }
  return cur;
}

const text = (v: unknown): string | null => {
  if (v === null || v === undefined || typeof v === 'object') return null;
  const s = String(v).trim();
  return s ? s : null;
};

const first = (source: unknown, paths: string[] | undefined): string | null => {
  for (const p of paths ?? []) {
    const v = text(pick(source, p));
    if (v) return v;
  }
  return null;
};

function number(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

function parseCsv(textBody: string, delimiter: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = textBody.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i] as string;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  const [head, ...body] = rows;
  if (!head) return [];
  const names = head.map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(names.map((n, i) => [n, (r[i] ?? '').trim()])));
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, parseAttributeValue: false, trimValues: true, processEntities: true });

function lineOf(rules: PosRules, src: unknown, csv: boolean): PosNormalizedLine {
  const get = (paths: string[] | undefined) => (csv ? first(src, paths?.map((p) => p.toLowerCase())) : first(src, paths));
  const qty = number(get(rules.quantity));
  if (qty === null || qty === 0) fail('В строке чека не нашлось количества. Проверьте, в каком поле оно лежит');
  return { code: get(rules.code), barcode: get(rules.barcode), name: get(rules.name), quantity: Math.abs(qty as number), price: number(get(rules.price)) };
}

function kindOf(rules: PosRules, src: unknown, csv: boolean): 'sale' | 'return' {
  const raw = (csv ? first(src, rules.type?.map((p) => p.toLowerCase())) : first(src, rules.type)) ?? '';
  const needle = raw.toLowerCase();
  return rules.returnValues.some((v) => v.toLowerCase() === needle) ? 'return' : 'sale';
}

/** Превращает присланное кассой тело в список чеков по правилам подключения. Ошибка объясняет, что именно не нашли. */
export function normalizeReceipts(rules: PosRules, body: unknown): NormalizedReceipt[] {
  const out: NormalizedReceipt[] = [];

  if (rules.format === 'csv') {
    if (typeof body !== 'string') return fail('Для этой кассы ожидается файл CSV (text/csv)');
    const rows = parseCsv(body, rules.delimiter);
    if (rows.length === 0) return fail('В файле нет строк');
    const groups = new Map<string, Record<string, string>[]>();
    for (const r of rows) {
      const id = first(r, rules.id.map((p) => p.toLowerCase()));
      if (!id) return fail(`В строке нет номера чека (колонка «${rules.id[0]}»)`);
      groups.set(id, [...(groups.get(id) ?? []), r]);
    }
    for (const [id, list] of groups) out.push({ externalId: id, kind: kindOf(rules, list[0], true), lines: list.map((r) => lineOf(rules, r, true)) });
    return out;
  }

  let data: unknown = body;
  if (typeof body === 'string') {
    try {
      data = rules.format === 'xml' ? xml.parse(body) : JSON.parse(body);
    } catch {
      return fail(rules.format === 'xml' ? 'Не удалось прочитать XML' : 'Не удалось прочитать JSON');
    }
  }
  const list = rules.receipts ? asArray(pick(data, rules.receipts)) : asArray(data);
  if (list.length === 0) return fail(rules.receipts ? `Список чеков не найден по пути «${rules.receipts}»` : 'В теле запроса нет чека');
  for (const r of list) {
    const id = first(r, rules.id);
    if (!id) return fail(`Не нашли номер чека (пути: ${rules.id.join(', ')})`);
    const lines = rules.lines ? asArray(pick(r, rules.lines)) : [];
    if (lines.length === 0) return fail(`В чеке ${id} нет строк (путь «${rules.lines ?? ''}»)`);
    out.push({ externalId: id, kind: kindOf(rules, r, false), lines: lines.map((l) => lineOf(rules, l, false)) });
  }
  return out;
}
