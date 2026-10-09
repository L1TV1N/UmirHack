import { describe, expect, it } from 'vitest';
import { buildUpdXml, encodeCp1251 } from '../../src/db/seed/upd-sample';
import { itemKey, normalizeName, similarity } from '../../src/modules/invoices/match';
import { InvoiceFormatError, toIsoDate, toNumber, unitFrom } from '../../src/modules/invoices/raw';
import { decodeXml, parseUpd } from '../../src/modules/invoices/upd';

const supplier = { name: 'ООО «Молочный комбинат «Донской»', inn: '6163012345' };
const utf = (xml: string) => Buffer.from(xml, 'utf8');
const base = { number: 'ДН-4711', date: '09.10.2026', supplier, encoding: 'UTF-8' as const };

describe('разбор УПД', () => {
  it('читает поставщика, номер, дату и строки товаров', () => {
    const inv = parseUpd(
      utf(
        buildUpdXml({
          ...base,
          lines: [
            { name: 'Молоко «Донское» 3,2% 0,93 л', code: 'MLK-93', unitCode: '796', quantity: '120', price: '62.50' },
            { name: 'Сыр Российский 50%', code: 'CH-50', unitCode: '166', quantity: '12,5', price: '520,00' },
          ],
        }),
      ),
    );
    expect(inv.number).toBe('ДН-4711');
    expect(inv.date).toBe('2026-10-09');
    expect(inv.supplier).toEqual({ name: 'ООО «Молочный комбинат «Донской»', inn: '6163012345' });
    expect(inv.lines).toHaveLength(2);
    expect(inv.lines[0]).toMatchObject({ name: 'Молоко «Донское» 3,2% 0,93 л', code: 'MLK-93', unit: 'pcs', quantity: 120, price: 62.5 });
    expect(inv.lines[1]).toMatchObject({ unit: 'kg', quantity: 12.5, price: 520 });
  });

  it('файл в windows-1251, как его отдаёт 1С, читается без кракозябр', () => {
    const xml = buildUpdXml({ ...base, encoding: 'windows-1251', lines: [{ name: 'Хлеб «Бородинский» нарезной, № 1', quantity: '30', price: '48' }] });
    const inv = parseUpd(encodeCp1251(xml));
    expect(inv.lines[0]?.name).toBe('Хлеб «Бородинский» нарезной, № 1');
    expect(inv.supplier?.name).toBe('ООО «Молочный комбинат «Донской»');
  });

  it('поставщик индивидуальный предприниматель', () => {
    const inv = parseUpd(utf(buildUpdXml({ ...base, supplier: { ipInn: '500100732259', surname: 'Иванов', name: 'Пётр', patronymic: 'Сергеевич' }, lines: [{ name: 'Яйцо С1', quantity: '300', price: '9.2' }] })));
    expect(inv.supplier).toEqual({ name: 'ИП Иванов П.С.', inn: '500100732259' });
  });

  it('срок годности, GTIN и партия из дополнительных сведений строки', () => {
    const inv = parseUpd(
      utf(
        buildUpdXml({
          ...base,
          lines: [{ name: 'Кефир 2,5%', quantity: '40', price: '58', expires: '19.10.2026', gtin: '4607000010075', extraInfo: [{ id: 'Номер партии', value: 'П-77' }] }],
        }),
      ),
    );
    expect(inv.lines[0]).toMatchObject({ expiresOn: '2026-10-19', gtin: '4607000010075', batch: 'П-77' });
  });

  it('код маркировки даёт GTIN и срок годности из самого кода', () => {
    const kiz = '010460700001000617261125' + '10LOT9' + '\u001d21SN777';
    const inv = parseUpd(utf(buildUpdXml({ ...base, lines: [{ name: 'Молоко', quantity: '10', price: '60', kiz: [kiz] }] })));
    expect(inv.lines[0]).toMatchObject({ gtin: '04607000010006', expiresOn: '2026-11-25', batch: 'LOT9' });
  });

  it('GTIN бывает в коде товара поставщика', () => {
    const inv = parseUpd(utf(buildUpdXml({ ...base, lines: [{ name: 'Сок яблочный', code: '4607000010624', quantity: '6', price: '88' }] })));
    expect(inv.lines[0]?.gtin).toBe('4607000010624');
  });

  it('цена считается по сумме без НДС, если её нет в строке', () => {
    const inv = parseUpd(utf(buildUpdXml({ ...base, lines: [{ name: 'Масло сливочное', unitCode: '166', quantity: '4', sumWithoutVat: '2560.00' }] })));
    expect(inv.lines[0]?.price).toBe(640);
  });

  it('единицы: по коду ОКЕИ и по названию', () => {
    expect(unitFrom('166', null)).toBe('kg');
    expect(unitFrom('163', null)).toBe('g');
    expect(unitFrom('112', null)).toBe('l');
    expect(unitFrom('111', null)).toBe('ml');
    expect(unitFrom('168', null)).toBe('t');
    expect(unitFrom('778', null)).toBe('pcs');
    expect(unitFrom(null, 'Кг')).toBe('kg');
    expect(unitFrom(null, 'упак.')).toBe('pcs');
    expect(unitFrom('999', 'неведомо')).toBeNull();
    expect(unitFrom(null, null)).toBeNull();
  });

  it('единственная строка товара (не список) тоже читается', () => {
    expect(parseUpd(utf(buildUpdXml({ ...base, lines: [{ name: 'Хлеб', quantity: '1', price: '30' }] }))).lines).toHaveLength(1);
  });

  it('строки без названия или количества пропускаются с предупреждением, остальные остаются', () => {
    const xml = buildUpdXml({ ...base, lines: [{ name: 'Хлеб', quantity: '5', price: '30' }, { name: 'Нулевая', quantity: '0', price: '10' }, { name: 'Минусовая', quantity: '-3', price: '10' }] });
    const inv = parseUpd(utf(xml));
    expect(inv.lines.map((l) => l.name)).toEqual(['Хлеб']);
    expect(inv.warnings).toHaveLength(2);
  });

  it('не принимает файлы с DOCTYPE и ENTITY: через них раздувают память и читают файлы сервера', () => {
    const evil = '<?xml version="1.0"?><!DOCTYPE Файл [<!ENTITY x SYSTEM "file:///etc/passwd">]><Файл><Документ/></Файл>';
    expect(() => parseUpd(utf(evil))).toThrow(InvoiceFormatError);
    const bomb = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;">]><Файл>&b;</Файл>';
    expect(() => decodeXml(utf(bomb))).toThrow(InvoiceFormatError);
  });

  it('понятно отказывает на чужих и пустых файлах', () => {
    expect(() => parseUpd(utf('это не xml'))).toThrow(InvoiceFormatError);
    expect(() => parseUpd(utf('<?xml version="1.0"?><Другое/>'))).toThrow(/не универсальный передаточный документ/);
    expect(() => parseUpd(utf('<?xml version="1.0"?><Файл><Документ><ТаблСчФакт/></Документ></Файл>'))).toThrow(/нет строк товаров/);
    expect(() => parseUpd(utf(buildUpdXml({ ...base, lines: [{ name: 'Ноль', quantity: '0' }] })))).toThrow(/Ни в одной строке/);
    expect(() => parseUpd(Buffer.alloc(0))).toThrow(InvoiceFormatError);
  });

  it('число и дата в разных записях', () => {
    expect(toNumber('1 250,50')).toBe(1250.5);
    expect(toNumber('12.5')).toBe(12.5);
    expect(toNumber('')).toBeNull();
    expect(toNumber('abc')).toBeNull();
    expect(toIsoDate('09.10.2026')).toBe('2026-10-09');
    expect(toIsoDate('2026-10-09')).toBe('2026-10-09');
    expect(toIsoDate('31.02.2026')).toBeNull();
    expect(toIsoDate('вчера')).toBeNull();
  });
});

describe('сходство названий', () => {
  it('нормализация убирает кавычки, регистр и ё', () => {
    expect(normalizeName('Молоко «Простоквашино» 3,2%  ')).toBe('молоко простоквашино 3,2%');
    expect(normalizeName('СЁМГА')).toBe('семга');
  });

  it('название из накладной находит продукт со своим словарём', () => {
    expect(similarity('Молоко «Донское» 3,2% пастеризованное 0,93 л', 'Молоко 3,2% пастеризованное')).toBeGreaterThanOrEqual(0.82);
    expect(similarity('Яйцо куриное С1 столовое', 'Яйцо куриное С1')).toBeGreaterThanOrEqual(0.82);
  });

  it('разные продукты не путаются', () => {
    expect(similarity('Сыр Российский 50%', 'Молоко 3,2% пастеризованное')).toBeLessThan(0.5);
    expect(similarity('Картофель мытый', 'Капуста белокочанная')).toBeLessThan(0.5);
    expect(similarity('', 'Молоко')).toBe(0);
  });

  it('ключ соответствия: код поставщика важнее названия', () => {
    expect(itemKey('Молоко 3,2%', 'MLK-93')).toBe('code:MLK-93');
    expect(itemKey('Молоко «Донское» 3,2%', null)).toBe('name:молоко донское 3,2%');
  });
});

describe('название поставщика', () => {
  it('сравнивается без организационно-правовой формы и кавычек', async () => {
    const { normalizeSupplierName } = await import('../../src/modules/invoices/match');
    expect(normalizeSupplierName('ООО «Молочный комбинат «Донской»')).toBe(normalizeSupplierName('Молочный комбинат Донской'));
    expect(normalizeSupplierName('Общество с ограниченной ответственностью "Агрофирма Зерновая"')).toBe('агрофирма зерновая');
    expect(normalizeSupplierName('ИП Иванов П.С.')).toBe('иванов п.с.');
    expect(normalizeSupplierName('Хлебозавод №4')).toBe('хлебозавод 4');
  });
});
