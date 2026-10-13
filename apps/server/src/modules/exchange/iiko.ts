import type { StopFeedEntryDto } from '@zapas/shared';
import type { CanonicalDoc } from './onec';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

function ddmmyyyy(d: Date, tz: string): string {
  const [y, m, day] = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d).split('-');
  return `${day}.${m}.${y}`;
}

/**
 * Приходная накладная для загрузки в iiko (формат импорта приходных накладных iikoOffice/iikoRMS).
 * Продукты узнаются по артикулу. Склад и поставщик в iiko имеют идентификаторы, которых «Запас» знать не может,
 * поэтому их передаёт тот, кто выгружает.
 */
export function incomingInvoiceXml(doc: CanonicalDoc, o: { store?: string | undefined; supplier?: string | undefined; tz: string }): string {
  const rows = new Map<string, { sku: string; quantity: number; amount: number }>();
  for (const l of doc.lines) {
    const r = rows.get(l.productId) ?? { sku: l.sku, quantity: 0, amount: 0 };
    r.quantity += l.quantity;
    r.amount += l.quantity * l.unitCost;
    rows.set(l.productId, r);
  }
  const items = [...rows.values()].map(
    (r, i) =>
      `    <item>\n      <num>${i + 1}</num>\n      <productArticle>${esc(r.sku)}</productArticle>\n      <amount>${Math.round(r.quantity * 1000) / 1000}</amount>\n      <price>${money(r.quantity > 0 ? r.amount / r.quantity : 0)}</price>\n      <sum>${money(r.amount)}</sum>\n    </item>`,
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<document>',
    `  <documentNumber>${esc(doc.number)}</documentNumber>`,
    `  <dateIncoming>${ddmmyyyy(doc.createdAt, o.tz)}</dateIncoming>`,
    '  <useDefaultDocumentTime>true</useDefaultDocumentTime>',
    '  <status>NEW</status>',
    ...(o.store ? [`  <defaultStore>${esc(o.store)}</defaultStore>`] : []),
    ...(o.supplier ? [`  <supplier>${esc(o.supplier)}</supplier>`] : []),
    `  <comment>${esc(`Запас ${doc.number}${doc.comment ? `: ${doc.comment}` : ''}`)}</comment>`,
    '  <items>',
    ...items,
    '  </items>',
    '</document>',
    '',
  ].join('\n');
}

/** Стоп-лист в виде, близком к ответу iikoCloud: позиция с нулевым остатком по каждой группе терминалов (здесь это точка). */
export function iikoStopList(generatedAt: string, locationId: string, entries: StopFeedEntryDto[]) {
  return {
    correlationId: locationId,
    generatedAt,
    terminalGroupStopLists: [
      {
        organizationId: locationId,
        items: [
          {
            terminalGroupId: locationId,
            items: entries.map((e) => ({ productId: e.id, sku: e.code, barcode: e.barcode, name: e.name, balance: 0, dateAdd: e.since, kind: e.type === 'dish' ? 'dish' : 'product', reason: e.reason })),
          },
        ],
      },
    ],
  };
}
