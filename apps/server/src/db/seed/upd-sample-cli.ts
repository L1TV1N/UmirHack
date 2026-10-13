import { addDays, todayIn } from '@zapas/shared';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PRODUCTS, SUPPLIERS } from './data';
import { demoBarcode } from './run';
import { buildUpdXml, encodeCp1251, type SampleLine } from './upd-sample';

/**
 * Образец УПД для проверки приёмки по накладной: docs/samples/upd-donskoy.xml в кодировке windows-1251, как из 1С.
 * Строки написаны так, как их пишет поставщик, чтобы показать все способы сопоставления: по штрихкоду, по названию,
 * с пересчётом единиц и без продукта. Запуск: npm run sample-upd -w @zapas/server.
 */
function main(): void {
  const today = todayIn('Europe/Moscow', new Date());
  const supplier = SUPPLIERS[0];
  if (!supplier) throw new Error('Нет демо-поставщика');
  const barcode = (key: string) => {
    const i = PRODUCTS.findIndex((p) => p.key === key);
    if (i < 0) throw new Error(`Нет продукта ${key}`);
    return demoBarcode(i);
  };
  const milkGs1 = `010${barcode('milk')}${'17'}${addDays(today, 7).replace(/-/g, '').slice(2)}10D${today.replace(/-/g, '').slice(4)}\u001d21SN${Date.now().toString().slice(-8)}`;

  const lines: SampleLine[] = [
    // по штрихкоду, с кодом маркировки и номером ВСД: срок годности берётся из кода
    { name: 'Молоко «Донское» пастеризованное 0,93 л', code: 'MLK-93', unitCode: '112', unitName: 'л', quantity: '60', price: '61.50', gtin: barcode('milk'), kiz: [milkGs1], vsd: randomUUID() },
    // по названию, срок и номер ВСД в дополнительных сведениях строки
    { name: 'Кефир «Донской» 2,5% 0,9 л', code: 'KEF-09', unitCode: '112', unitName: 'л', quantity: '40', price: '57.80', vsd: randomUUID(), expires: addDays(today, 10).split('-').reverse().join('.') },
    // граммы в накладной, килограммы у нас: пересчитывается
    { name: 'Сметана 20% ёмкость 400 г', code: 'SM-400', unitCode: '163', unitName: 'г', quantity: '12000', price: '0.21', expires: addDays(today, 14).split('-').reverse().join('.') },
    { name: 'Творог 5% развесной', code: 'TV-5', unitCode: '166', unitName: 'кг', quantity: '15', price: '289.00', expires: addDays(today, 10).split('-').reverse().join('.') },
    { name: 'Сыр Российский 50% брусок', code: 'CH-50', unitCode: '166', unitName: 'кг', quantity: '8,5', price: '518,00', expires: addDays(today, 60).split('-').reverse().join('.') },
    // в нашей номенклатуре такого нет: продукт выбирается вручную
    { name: 'Мороженое пломбир 450 г', code: 'ICE-450', unitCode: '796', unitName: 'шт', quantity: '24', price: '96.00' },
  ];

  const xml = buildUpdXml({
    number: `ДН-${today.replace(/-/g, '').slice(2)}`,
    date: today.split('-').reverse().join('.'),
    supplier: { name: `ООО «${supplier.name}»`, inn: supplier.inn },
    encoding: 'windows-1251',
    lines,
  });
  const out = resolve(process.cwd(), '../../docs/samples/upd-donskoy.xml');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, encodeCp1251(xml));
  // копия для вкладки «Тестирование → Накладные»: оттуда её можно скачать и загрузить в приход
  const forTesting = resolve(process.cwd(), '../web/public/test-invoices/06-upd-donskoy.xml');
  mkdirSync(dirname(forTesting), { recursive: true });
  writeFileSync(forTesting, encodeCp1251(xml));
  console.log(`Образец УПД: ${out}`);
}

main();
