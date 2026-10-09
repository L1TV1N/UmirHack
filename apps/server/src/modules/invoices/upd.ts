import { normalizeVsd, parseScan } from '@zapas/shared';
import { XMLParser } from 'fast-xml-parser';
import { InvoiceFormatError, toIsoDate, toNumber, unitFrom, type RawInvoice, type RawInvoiceLine } from './raw';

/**
 * Универсальный передаточный документ (формат ФНС, версии 5.01–5.03): счёт-фактура и накладная в одном XML.
 * Из него берём поставщика, номер и дату, а по строкам товара название, код, количество, цену, единицу и, если
 * поставщик их указал, срок годности, штрихкод и коды маркировки.
 */
const ARRAY_TAGS = new Set(['СведТов', 'ИнфПолФХЖ2', 'КИЗ', 'НомСредИдентТов', 'ДопСведТов']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  // внешних и пользовательских сущностей в УПД не бывает, их мы вообще не принимаем (см. decodeXml)
  processEntities: true,
  maxNestedTags: 40,
  isArray: (name) => ARRAY_TAGS.has(name),
});

type Node = Record<string, unknown>;

const asNode = (v: unknown): Node | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Node) : null);
const attr = (n: Node | null, name: string): string | null => {
  const v = n?.[`@_${name}`];
  return typeof v === 'string' && v !== '' ? v : null;
};
const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);
const dig = (n: unknown, ...path: string[]): Node | null => {
  let cur: unknown = n;
  for (const key of path) cur = first(asNode(cur)?.[key]);
  return asNode(cur);
};

/** Байты файла в текст. 1С отдаёт УПД в windows-1251, обмен через операторов ЭДО в UTF-8. */
export function decodeXml(bytes: Buffer): string {
  const head = bytes.subarray(0, 200).toString('latin1');
  const label = /encoding\s*=\s*["']([^"']+)["']/i.exec(head)?.[1]?.toLowerCase() ?? 'utf-8';
  const encoding = /1251|cp1251/.test(label) ? 'windows-1251' : 'utf-8';
  const text = new TextDecoder(encoding).decode(bytes).replace(/^﻿/, '');
  // сущности и внешние подгрузки в УПД не нужны, а через них раздувают память и читают файлы сервера
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[.{0,20}SYSTEM/i.test(text)) {
    throw new InvoiceFormatError('Файл содержит объявления DOCTYPE или ENTITY: такой XML не принимается');
  }
  return text;
}

const IDENT_EXPIRY = /срок|годн|expir|best.?before/i;
const IDENT_GTIN = /gtin|штрих|ean|barcode/i;
const IDENT_VSD = /вс[дd]|меркур|ветеринар|mercury|vet/i;

function readLine(node: Node): RawInvoiceLine | null {
  const name = attr(node, 'НаимТов');
  const quantity = toNumber(attr(node, 'КолТов'));
  if (!name || quantity === null || quantity <= 0) return null;

  const extra = dig(node, 'ДопСведТов');
  const code = attr(extra, 'КодТов');
  const unit = unitFrom(attr(node, 'ОКЕИ_Тов'), attr(extra, 'НаимЕдИзм'));

  let price = toNumber(attr(node, 'ЦенаТов'));
  if (price === null) {
    const sum = toNumber(attr(node, 'СтТовБезНДС'));
    if (sum !== null) price = Math.round((sum / quantity) * 100) / 100;
  }

  let expiresOn: string | null = null;
  let gtin: string | null = null;
  let batch: string | null = null;
  let vsd: string | null = null;

  const infos = (Array.isArray(node['ИнфПолФХЖ2']) ? node['ИнфПолФХЖ2'] : []) as Node[];
  for (const info of infos) {
    const key = attr(info, 'Идентиф') ?? '';
    const value = attr(info, 'Значен');
    if (!value) continue;
    if (!expiresOn && IDENT_EXPIRY.test(key)) expiresOn = toIsoDate(value);
    else if (!gtin && IDENT_GTIN.test(key) && /^\d{8,14}$/.test(value)) gtin = value;
    else if (!vsd && IDENT_VSD.test(key) && normalizeVsd(value)) vsd = normalizeVsd(value);
    else if (!batch && /парти|серия|lot|batch/i.test(key)) batch = value.slice(0, 40);
  }

  // коды маркировки: GTIN, а у некоторых партий и срок годности лежат в самом коде
  const marks = ([] as unknown[]).concat(...(Array.isArray(extra?.['НомСредИдентТов']) ? (extra['НомСредИдентТов'] as Node[]).map((n) => n['КИЗ']) : []));
  const codes: string[] = [];
  for (const mark of marks) {
    const text = String(mark ?? '');
    const scan = parseScan(text);
    if (scan.kind !== 'gs1') continue;
    if (codes.length === 0) {
      gtin ??= scan.gtin;
      expiresOn ??= scan.expiresOn;
      batch ??= scan.batch;
    }
    if (scan.serial && text.length >= 20 && text.length <= 400) codes.push(text);
  }
  if (!gtin && code && /^\d{8,14}$/.test(code)) gtin = code;

  return { name, code, gtin, unit, quantity, price, expiresOn, batch, vsd, marks: codes };
}

export function parseUpd(bytes: Buffer): RawInvoice {
  const text = decodeXml(bytes);
  let root: Node | null;
  try {
    root = asNode(parser.parse(text));
  } catch {
    throw new InvoiceFormatError('Файл не читается как XML');
  }
  const file = asNode(root?.['Файл']);
  const doc = dig(file, 'Документ');
  if (!file || !doc) throw new InvoiceFormatError('Это не универсальный передаточный документ: нет раздела «Документ»');

  const head = dig(doc, 'СвСчФакт');
  const table = dig(doc, 'ТаблСчФакт');
  const items = (Array.isArray(table?.['СведТов']) ? table['СведТов'] : []) as Node[];
  if (items.length === 0) throw new InvoiceFormatError('В документе нет строк товаров');

  const warnings: string[] = [];
  const lines: RawInvoiceLine[] = [];
  items.forEach((item, i) => {
    const line = readLine(item);
    if (line) lines.push(line);
    else warnings.push(`Строка ${attr(item, 'НомСтр') ?? i + 1} пропущена: нет названия или количества`);
  });
  if (lines.length === 0) throw new InvoiceFormatError('Ни в одной строке нет названия и количества');

  // поставщик: организация или предприниматель
  const seller = dig(head, 'СвПрод', 'ИдСв');
  const org = dig(seller, 'СвЮЛУч');
  const ip = dig(seller, 'СвИП');
  let supplier: RawInvoice['supplier'] = null;
  if (org) supplier = { name: attr(org, 'НаимОрг') ?? 'Поставщик', inn: attr(org, 'ИННЮЛ') };
  else if (ip) {
    const fio = dig(ip, 'ФИО');
    const initials = [attr(fio, 'Имя'), attr(fio, 'Отчество')].map((s) => (s ? `${s[0]}.` : '')).join('');
    supplier = { name: `ИП ${attr(fio, 'Фамилия') ?? ''} ${initials}`.trim(), inn: attr(ip, 'ИННФЛ') };
  }

  const totals = dig(table, 'ВсегоОпл');
  return {
    number: attr(head, 'НомерСчФ'),
    date: toIsoDate(attr(head, 'ДатаСчФ')),
    supplier,
    total: toNumber(attr(totals, 'СтТовУчНалВсего')),
    lines,
    warnings,
  };
}
