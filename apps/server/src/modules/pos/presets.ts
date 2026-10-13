import type { PosPresetDto, PosRules, PosVendor } from '@zapas/shared';
import { POS_VENDOR_LABELS } from '@zapas/shared';

const base = { returnValues: ['PAYBACK', 'SELL_RETURN', 'RETURN', 'REFUND', 'возврат'], delimiter: ';' as const };

export const POS_PRESETS: Record<PosVendor, { hint: string; rules: PosRules; sample: string; sampleType: string }> = {
  evotor: {
    hint: 'В личном кабинете Эвотор подключите приложение или вебхук документов и укажите адрес «Запаса» и ключ. Приходят чеки продажи (SELL) и возврата (PAYBACK).',
    rules: { ...base, format: 'json', id: ['id', 'number'], type: ['type'], lines: 'body.positions', code: ['code', 'product_code'], barcode: ['barcode'], name: ['name'], quantity: ['quantity'], price: ['price'] },
    sampleType: 'application/json',
    sample: JSON.stringify({ id: 'a1b2c3d4-0001', type: 'SELL', number: 1001, body: { positions: [{ name: 'Борщ с говядиной', code: 'BORSCH', quantity: 2, price: 290 }, { name: 'Кефир 2,5%', barcode: '4607000011119', quantity: 1, price: 95 }] } }, null, 2),
  },
  frontol: {
    hint: 'Фронтол выгружает продажи файлом с разделителем «;». Настройте выгрузку чеков в папку и отправляйте файл на адрес «Запаса» или загрузите его на этой странице. Названия колонок можно поменять в правилах.',
    rules: { ...base, format: 'csv', id: ['Номер чека'], type: ['Тип'], code: ['Код товара'], barcode: ['Штрихкод'], name: ['Наименование'], quantity: ['Количество'], price: ['Цена'] },
    sampleType: 'text/csv',
    sample: 'Номер чека;Тип;Код товара;Штрихкод;Наименование;Количество;Цена\n5001;Продажа;BORSCH;;Борщ с говядиной;2;290\n5001;Продажа;;4607000011119;Кефир 2,5%;1;95\n5002;Возврат;BORSCH;;Борщ с говядиной;1;290\n',
  },
  atol: {
    hint: 'Для касс АТОЛ настройте обмен с учётной системой на отправку чеков в XML на адрес «Запаса». Пример ниже можно подогнать правилами под ваш формат.',
    rules: { ...base, format: 'xml', receipts: 'receipts.receipt', id: ['@_id', 'number'], type: ['type'], lines: 'items.item', code: ['code'], barcode: ['barcode'], name: ['name'], quantity: ['quantity'], price: ['price'] },
    sampleType: 'application/xml',
    sample: '<receipts><receipt id="7001"><type>sell</type><items><item><code>BORSCH</code><name>Борщ с говядиной</name><quantity>2</quantity><price>290</price></item><item><barcode>4607000011119</barcode><name>Кефир 2,5%</name><quantity>1</quantity><price>95</price></item></items></receipt></receipts>',
  },
  iiko: {
    hint: 'iiko присылает заказы через iikoCloud API (события заказов). Нужен сервис-посредник или плагин, который отправит чек на адрес «Запаса». Позиции узнаются по коду блюда или артикулу номенклатуры iiko.',
    rules: { ...base, format: 'json', id: ['id', 'order.id'], type: ['type', 'order.type'], lines: 'order.items', code: ['product.code', 'product.number'], name: ['product.name'], quantity: ['amount'], price: ['price'] },
    sampleType: 'application/json',
    sample: JSON.stringify({ id: 'ord-3001', order: { id: 'ord-3001', items: [{ product: { code: 'BORSCH', name: 'Борщ с говядиной' }, amount: 2, price: 290 }, { product: { code: 'OMELET', name: 'Омлет с сыром' }, amount: 1, price: 240 }] } }, null, 2),
  },
  sigma: {
    hint: 'Sigma отправляет чеки в JSON. Укажите адрес «Запаса» и ключ, а если поля называются иначе, поправьте правила.',
    rules: { ...base, format: 'json', id: ['check.number', 'number'], type: ['check.operation'], lines: 'check.positions', code: ['code'], barcode: ['barcode'], name: ['name'], quantity: ['qty', 'quantity'], price: ['price'] },
    sampleType: 'application/json',
    sample: JSON.stringify({ check: { number: 'S-401', operation: 'sale', positions: [{ code: 'BORSCH', name: 'Борщ с говядиной', qty: 2, price: 290 }] } }, null, 2),
  },
  generic: {
    hint: 'Любая касса, которая умеет отправить JSON, XML или CSV. Укажите, в каких полях лежат номер чека, код или штрихкод, количество и цена.',
    rules: { ...base, format: 'json', id: ['externalId', 'id'], lines: 'lines', code: ['code', 'sku'], barcode: ['barcode'], name: ['name'], quantity: ['quantity'], price: ['price'] },
    sampleType: 'application/json',
    sample: JSON.stringify({ externalId: 'CHK-0001', lines: [{ code: 'BORSCH', quantity: 2, price: 290 }] }, null, 2),
  },
};

export function listPosPresets(): PosPresetDto[] {
  return (Object.keys(POS_PRESETS) as PosVendor[]).map((vendor) => ({ vendor, label: POS_VENDOR_LABELS[vendor], ...POS_PRESETS[vendor] }));
}

export function presetRules(vendor: PosVendor): PosRules {
  return POS_PRESETS[vendor].rules;
}
