import type { ExchangePresetDto, OneCDocMapping, OneCPreset, OneCProfile } from '@zapas/shared';
import { ONEC_PRESET_LABELS } from '@zapas/shared';

const header = (extra: Partial<OneCDocMapping['header']> = {}): OneCDocMapping['header'] => ({
  date: 'Date',
  organization: 'Организация_Key',
  warehouse: 'Склад_Key',
  comment: 'Комментарий',
  ...extra,
});

const doc = (entity: string, o: Partial<OneCDocMapping> & { header?: OneCDocMapping['header'] } = {}): OneCDocMapping => ({
  entity,
  table: 'Товары',
  header: header(),
  constants: {},
  line: { product: 'Номенклатура_Key', quantity: 'Количество', price: 'Цена', sum: 'Сумма' },
  ...o,
});

const writeoffLine = { product: 'Номенклатура_Key', quantity: 'Количество' };

/**
 * Стартовые значения для типовых конфигураций. Имена объектов в разных релизах отличаются, поэтому перед работой
 * их нужно сверить кнопкой «Проверить подключение»: она читает описание интерфейса (`$metadata`) и показывает, чего не хватает.
 */
export const ONEC_PRESET_PROFILES: Record<OneCPreset, OneCProfile> = {
  bp3: {
    preset: 'bp3',
    odataPath: '/odata/standard.odata',
    catalogs: {
      product: { entity: 'Catalog_Номенклатура', codeField: 'Артикул', nameField: 'Description' },
      supplier: { entity: 'Catalog_Контрагенты', codeField: 'ИНН', nameField: 'Description' },
      location: { entity: 'Catalog_Склады', codeField: 'Code', nameField: 'Description' },
    },
    documents: {
      receipt: doc('Document_ПоступлениеТоваровУслуг', { header: header({ counterparty: 'Контрагент_Key' }) }),
      writeoff: doc('Document_СписаниеТоваров', { line: writeoffLine }),
      transfer: doc('Document_ПеремещениеТоваров', { header: header({ warehouse: 'СкладОтправитель_Key', warehouseTo: 'СкладПолучатель_Key' }), line: writeoffLine }),
    },
    post: true,
  },
  retail3: {
    preset: 'retail3',
    odataPath: '/odata/standard.odata',
    catalogs: {
      product: { entity: 'Catalog_Номенклатура', codeField: 'Артикул', nameField: 'Description' },
      supplier: { entity: 'Catalog_Контрагенты', codeField: 'ИНН', nameField: 'Description' },
      location: { entity: 'Catalog_Склады', codeField: 'Code', nameField: 'Description' },
    },
    documents: {
      receipt: doc('Document_ПоступлениеТоваров', { header: header({ counterparty: 'Контрагент_Key' }) }),
      writeoff: doc('Document_СписаниеТоваров', { line: writeoffLine }),
      transfer: doc('Document_ПеремещениеТоваров', { header: header({ warehouse: 'СкладОтправитель_Key', warehouseTo: 'СкладПолучатель_Key' }), line: writeoffLine }),
      surplus: doc('Document_ОприходованиеТоваров', { line: writeoffLine }),
    },
    post: true,
  },
  ut11: {
    preset: 'ut11',
    odataPath: '/odata/standard.odata',
    catalogs: {
      product: { entity: 'Catalog_Номенклатура', codeField: 'Артикул', nameField: 'Description' },
      supplier: { entity: 'Catalog_Контрагенты', codeField: 'ИНН', nameField: 'Description' },
      location: { entity: 'Catalog_Склады', codeField: 'Code', nameField: 'Description' },
    },
    documents: {
      receipt: doc('Document_ПриобретениеТоваровУслуг', { header: header({ counterparty: 'Контрагент_Key' }) }),
      writeoff: doc('Document_СписаниеНедостачТоваров', { line: writeoffLine }),
      transfer: doc('Document_ПеремещениеТоваров', { header: header({ warehouse: 'СкладОтправитель_Key', warehouseTo: 'СкладПолучатель_Key' }), line: writeoffLine }),
      surplus: doc('Document_ОприходованиеИзлишковТоваров', { line: writeoffLine }),
    },
    post: true,
  },
  unf: {
    preset: 'unf',
    odataPath: '/odata/standard.odata',
    catalogs: {
      product: { entity: 'Catalog_Номенклатура', codeField: 'Артикул', nameField: 'Description' },
      supplier: { entity: 'Catalog_Контрагенты', codeField: 'ИНН', nameField: 'Description' },
      location: { entity: 'Catalog_СтруктурныеЕдиницы', codeField: 'Code', nameField: 'Description' },
    },
    documents: {
      receipt: doc('Document_ПриходнаяНакладная', { header: header({ warehouse: 'СтруктурнаяЕдиница_Key', counterparty: 'Контрагент_Key' }) }),
      writeoff: doc('Document_СписаниеЗапасов', { header: header({ warehouse: 'СтруктурнаяЕдиница_Key' }), table: 'Запасы', line: writeoffLine }),
      transfer: doc('Document_ПеремещениеЗапасов', { header: header({ warehouse: 'СтруктурнаяЕдиница_Key', warehouseTo: 'СтруктурнаяЕдиницаПолучатель_Key' }), table: 'Запасы', line: writeoffLine }),
    },
    post: true,
  },
  custom: {
    preset: 'custom',
    odataPath: '/odata/standard.odata',
    catalogs: { product: { entity: 'Catalog_Номенклатура', codeField: 'Артикул', nameField: 'Description' } },
    documents: {},
    post: true,
  },
};

export function listOneCPresets(): ExchangePresetDto[] {
  return (Object.keys(ONEC_PRESET_PROFILES) as OneCPreset[]).map((preset) => ({ preset, label: ONEC_PRESET_LABELS[preset], profile: ONEC_PRESET_PROFILES[preset] }));
}
