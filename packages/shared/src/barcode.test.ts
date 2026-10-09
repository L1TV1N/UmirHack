import { describe, expect, it } from 'vitest';
import { canonicalBarcode, gs1Date, gtinCheckDigit, isValidGtin, parseScan } from './barcode';

const gtin14 = (body13: string) => `${body13}${gtinCheckDigit(body13)}`;
const GS = '\u001d';

describe('контрольная цифра', () => {
  it('считает по правилу GS1 для EAN-13, EAN-8, UPC-A и GTIN-14', () => {
    expect(isValidGtin('4006381333931')).toBe(true);
    expect(isValidGtin('5901234123457')).toBe(true);
    expect(isValidGtin('96385074')).toBe(true);
    expect(isValidGtin('036000291452')).toBe(true);
    expect(isValidGtin('04006381333931')).toBe(true);
  });

  it('отвергает ошибку в одной цифре, неверную длину и не цифры', () => {
    expect(isValidGtin('4006381333932')).toBe(false);
    expect(isValidGtin('400638133393')).toBe(false);
    expect(isValidGtin('40063813339 1')).toBe(false);
    expect(isValidGtin('')).toBe(false);
  });
});

describe('ключ поиска', () => {
  it('EAN-13, UPC-A и GTIN-14 одного товара дают один ключ', () => {
    expect(canonicalBarcode('4006381333931')).toBe('04006381333931');
    expect(canonicalBarcode('04006381333931')).toBe('04006381333931');
    expect(canonicalBarcode('036000291452')).toBe('00036000291452');
    expect(canonicalBarcode('0036000291452')).toBe('00036000291452');
  });

  it('короткие, длинные и нецифровые значения ключа не дают', () => {
    expect(canonicalBarcode('1234567')).toBeNull();
    expect(canonicalBarcode('123456789012345')).toBeNull();
    expect(canonicalBarcode('abc')).toBeNull();
  });
});

describe('обычные штрихкоды', () => {
  it('верный EAN-13 это gtin', () => {
    const r = parseScan('4006381333931');
    expect(r).toMatchObject({ kind: 'gtin', gtin: '04006381333931', key: '04006381333931', expiresOn: null, marked: false });
  });

  it('внутренний код с неверной контрольной цифрой остаётся кодом, но ищется по ключу', () => {
    const r = parseScan('4607000010001');
    expect(r.kind).toBe('code');
    expect(r.gtin).toBeNull();
    expect(r.key).toBe('04607000010001');
  });

  it('пробелы вокруг и префикс сканера отбрасываются', () => {
    expect(parseScan('  ]E04006381333931 \n').key).toBe('04006381333931');
  });

  it('произвольный текст и пустая строка это просто код без ключа', () => {
    expect(parseScan('https://example.ru/qr')).toMatchObject({ kind: 'code', key: null });
    expect(parseScan('')).toMatchObject({ kind: 'code', key: null });
    expect(parseScan('   ')).toMatchObject({ kind: 'code', key: null });
  });
});

describe('коды GS1', () => {
  const gtin = gtin14('0460700001111');

  it('читает GTIN, срок годности и партию с разделителями', () => {
    const r = parseScan(`01${gtin}17261231${'10'}LOT-7${GS}21SN12345`);
    expect(r).toMatchObject({ kind: 'gs1', gtin, key: gtin, expiresOn: '2026-12-31', batch: 'LOT-7', serial: 'SN12345', marked: true });
  });

  it('марка «Честного знака» без срока: GTIN, серийный номер и криптохвост', () => {
    const r = parseScan(`01${gtin}21abcDEF12345678${GS}91EE11${GS}92dGVzdHRlc3R0ZXN0dGVzdHRlc3R0ZXN0dGVzdHRlc3Q=`);
    expect(r.kind).toBe('gs1');
    expect(r.gtin).toBe(gtin);
    expect(r.serial).toBe('abcDEF12345678');
    expect(r.expiresOn).toBeNull();
    expect(r.marked).toBe(true);
  });

  it('код, начатый разделителем FNC1 (так отдаёт ZXing), читается', () => {
    const r = parseScan(`${GS}01${gtin}17261231${GS}21SN1`);
    expect(r).toMatchObject({ kind: 'gs1', gtin, expiresOn: '2026-12-31', serial: 'SN1' });
  });

  it('префикс символики ]d2 снимается', () => {
    expect(parseScan(`]d201${gtin}17270630`).expiresOn).toBe('2027-06-30');
  });

  it('человекочитаемая запись со скобками', () => {
    const r = parseScan(`(01)${gtin}(17)270115(10)A-1`);
    expect(r).toMatchObject({ kind: 'gs1', gtin, expiresOn: '2027-01-15', batch: 'A-1', marked: false });
  });

  it('только GTIN без остальных полей', () => {
    const r = parseScan(`01${gtin}`);
    expect(r).toMatchObject({ kind: 'gs1', gtin, expiresOn: null, batch: null, marked: false });
  });

  it('без разделителей поля фиксированной длины всё равно читаются', () => {
    expect(parseScan(`01${gtin}17261231`).expiresOn).toBe('2026-12-31');
  });

  it('если срока (17) нет, берёт «годен до» (15)', () => {
    expect(parseScan(`01${gtin}15280228`).expiresOn).toBe('2028-02-28');
  });

  it('GTIN из нецифр или обрезанный не принимается', () => {
    expect(parseScan('01ABCDEFGHIJKLMN21x').kind).toBe('code');
    expect(parseScan('(01)123(17)261231').kind).toBe('code');
  });

  it('вес в поле 3103 не мешает чтению соседних полей', () => {
    const r = parseScan(`01${gtin}3103001250${'17'}261231`);
    expect(r.gtin).toBe(gtin);
    expect(r.expiresOn).toBe('2026-12-31');
  });
});

describe('даты GS1', () => {
  it('день 00 означает последний день месяца', () => {
    expect(gs1Date('260200')).toBe('2026-02-28');
    expect(gs1Date('280200')).toBe('2028-02-29');
    expect(gs1Date('261200')).toBe('2026-12-31');
  });

  it('несуществующие даты отвергаются', () => {
    expect(gs1Date('261301')).toBeNull();
    expect(gs1Date('260230')).toBeNull();
    expect(gs1Date('26123')).toBeNull();
    expect(gs1Date('abcdef')).toBeNull();
  });
});
