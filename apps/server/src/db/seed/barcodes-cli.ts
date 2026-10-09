import { addDays, todayIn } from '@zapas/shared';
import bwipjs from 'bwip-js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PRODUCTS } from './data';
import { demoBarcode } from './run';

/**
 * Лист штрихкодов демо-продуктов для проверки сканера: открыть на втором экране или распечатать.
 * Рядом коды «Честного знака» (GS1 DataMatrix) со сроком годности внутри: при приходе срок подставляется сам.
 * Запуск: npm run barcodes -w @zapas/server. Результат: docs/demo-barcodes.html.
 */
const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

const svg = (opts: Record<string, unknown>) => bwipjs.toSVG({ scale: 3, height: 14, ...opts });

const gtin14 = (barcode13: string) => `0${barcode13}`;
const yymmdd = (iso: string) => iso.replace(/-/g, '').slice(2);

interface Marked {
  key: string;
  days: number | null;
  lot: string;
  serial: string;
  note: string;
}

const MARKED: Marked[] = [
  { key: 'milk', days: 5, lot: 'L1026', serial: 'SN0000101', note: 'молоко со сроком в коде' },
  { key: 'kefir', days: 8, lot: 'L1027', serial: 'SN0000202', note: 'кефир со сроком в коде' },
  { key: 'curd', days: 1, lot: 'L1028', serial: 'SN0000303', note: 'творог, срок завтра' },
  { key: 'bread', days: 2, lot: 'L1029', serial: 'SN0000404', note: 'хлеб, срок через 2 дня' },
  { key: 'eggs', days: 20, lot: 'L1030', serial: 'SN0000505', note: 'яйцо со сроком в коде' },
  { key: 'sour', days: null, lot: '', serial: 'abcDEF12345678', note: 'марка без срока: срок подставится из карточки продукта' },
];

function main(): void {
  const today = todayIn('Europe/Moscow', new Date());
  const cards = PRODUCTS.slice(0, 24).map((p, i) => {
    const code = demoBarcode(i);
    return `<figure><div class="bc">${svg({ bcid: 'ean13', text: code, includetext: true, textxalign: 'center' })}</div><figcaption><b>${escape(p.name)}</b><span>${escape(p.sku)} · ${code}</span></figcaption></figure>`;
  });

  const marked = MARKED.map((m) => {
    const index = PRODUCTS.findIndex((p) => p.key === m.key);
    const p = PRODUCTS[index];
    if (!p) throw new Error(`Нет продукта ${m.key}`);
    const gtin = gtin14(demoBarcode(index));
    const fields = [`(01)${gtin}`];
    if (m.days !== null) fields.push(`(17)${yymmdd(addDays(today, m.days))}`);
    if (m.lot) fields.push(`(10)${m.lot}`);
    fields.push(`(21)${m.serial}`);
    if (m.days === null) fields.push('(91)EE11', '(92)dGVzdHRlc3R0ZXN0dGVzdHRlc3R0ZXN0dGVzdHRlc3Q=');
    const text = fields.join('');
    return `<figure><div class="dm">${svg({ bcid: 'gs1datamatrix', text, scale: 4 })}</div><figcaption><b>${escape(p.name)}</b><span>${escape(m.note)}</span><code>${escape(text.replace(/\(92\).*/, '(92)…'))}</code></figcaption></figure>`;
  });

  const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Штрихкоды демо-продуктов</title>
<style>
  body{font:14px/1.4 system-ui,sans-serif;margin:24px;color:#111827}
  h1{font-size:22px;margin:0 0 4px} h2{font-size:17px;margin:28px 0 10px} p{margin:0 0 8px;color:#4b5563;max-width:70ch}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}
  figure{margin:0;padding:12px;border:1px solid #d1d5db;border-radius:8px;break-inside:avoid;background:#fff}
  .bc svg{width:100%;height:auto} .dm svg{width:120px;height:auto;display:block;margin:0 auto 6px}
  figcaption{display:flex;flex-direction:column;gap:2px;text-align:center} figcaption span{color:#4b5563;font-size:12.5px}
  code{font-size:11px;color:#6b7280;word-break:break-all}
  @media print{body{margin:10mm} h2{break-after:avoid}}
</style></head><body>
<h1>Штрихкоды демо-продуктов</h1>
<p>Лист для проверки сканера: откройте его на втором экране или распечатайте и наведите камеру телефона. Сформирован ${today}, сроки в кодах «Честного знака» отсчитываются от этой даты.</p>
<h2>Штрихкоды продуктов (EAN-13)</h2>
<div class="grid">${cards.join('')}</div>
<h2>Коды «Честного знака» (GS1 DataMatrix)</h2>
<p>В коде зашиты GTIN, а у большинства ещё срок годности, партия и серийный номер. При сканировании в приходе срок подставляется из кода.</p>
<div class="grid">${marked.join('')}</div>
</body></html>`;

  const out = resolve(process.cwd(), '../../docs/demo-barcodes.html');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log(`Лист штрихкодов: ${out}`);
}

main();
